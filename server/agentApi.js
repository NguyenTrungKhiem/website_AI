// Engine "extension": nối hàng đợi job với extension "AutoAffiliate Trợ lý" (thư mục extension/) chạy trong Chrome thường.
// Hợp đồng API của extension (background.js): Bearer token `aa_…`; POST /api/agent/claim {kinds} -> {job, pendingCount};
// POST /api/agent/jobs/:id {status, message, result, error} -> {cancelled}; POST /api/agent/jobs/:id/file?name&type (body thô)
// -> {assetId}; GET /api/agent/assets/... (ảnh/video nguyên liệu, có token); GET /api/agent/ping -> {name}.
// Mỗi lần tạo (ảnh Nano Banana / video Omni) thành 1 việc kind flow_studio_image | flow_studio_video, do
// extension/content/flow-studio.js làm trên Flow: chuẩn bị nguyên liệu + prompt + model, người dùng bấm nút tạo, tải kết quả về.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, save, DIRS, newId } from './db.js';

const tasks = new Map(); // id -> task
let lastSeen = 0;
const CLAIM_TIMEOUT = 20 * 60_000; // chờ extension nhận việc
const RUN_TIMEOUT = 45 * 60_000; // từ lúc nhận tới khi có kết quả (gồm cả chờ người dùng bấm tạo)

const hashFile = (f) => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex').slice(0, 16);
const withEn = (url) => (/[?&]hl=/.test(url) ? url : url + (url.includes('?') ? '&' : '?') + 'hl=en');

// Token cho extension (Cài đặt → chép vào trang Options của extension). Tạo lần đầu khi cần.
export function token() {
  if (!/^aa_[A-Za-z0-9_-]{20,80}$/.test(db.settings.agentToken || '')) {
    db.settings.agentToken = 'aa_' + crypto.randomBytes(24).toString('base64url');
    save();
  }
  return db.settings.agentToken;
}
export function regenerateToken() {
  db.settings.agentToken = '';
  return token();
}
export const auth = (req, res, next) => {
  const t = (req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!t || t !== token()) return res.status(401).json({ error: 'Token không đúng — chép lại token từ Cài đặt của Video Studio vào extension' });
  lastSeen = Date.now();
  next();
};

/**
 * Giống chữ ký flow.generateImage/generateVideo: trả về { id, text, title } khi extension nộp kết quả.
 * input: { settings, aspectRatio, prompt, video, images, flowRefs, outputFile, label, log, onResult }
 */
export function generate({ settings, aspectRatio, prompt, video, images = [], flowRefs = {}, outputFile, label = '', log = () => {}, onResult = () => {} }, kind) {
  const id = newId();
  // Nguyên liệu theo đúng thứ tự gửi lên Flow. Tên file = vs-<mã băm> như flow.js để Flow nhận ra file đã có;
  // ảnh Flow tạo (có flowTitle) thì extension tìm theo tên trên Flow, không tải lên lại.
  const toUpload = (file) => {
    const ext = path.extname(file).toLowerCase();
    const name = `vs-${hashFile(file)}${ext}`;
    const dest = path.join(DIRS.tmp, name);
    try {
      if (!fs.existsSync(dest)) fs.copyFileSync(file, dest);
    } catch {}
    return { name, path: path.resolve(dest) };
  };

  const items = [...images, video].filter(Boolean).map((file, i) => {
    const up = toUpload(file);
    return {
      i,
      name: up.name,
      title: flowRefs[file] || null,
      isVideo: file === video,
      url: `/api/agent/assets/${id}/${i}`,
      path: up.path,
    };
  });
  const task = {
    id,
    kind: `flow_studio_${kind}`,
    payload: {
      kind,
      label,
      prompt,
      aspect: (aspectRatio || settings.aspectRatio) === '16:9' ? '16:9' : '9:16',
      resolution: settings.flowResolution === '360p' ? '360p' : '720p',
      autoAgree: !!settings.flowAutoAgree,
      projectUrl: settings.flowProjectUrl ? withEn(settings.flowProjectUrl) : null,
      items: items.map(({ i, name, title, isVideo, url, path: itemPath }) => ({ i, name, title, isVideo, url, path: itemPath })),
    },
    files: items,
    uploads: [], // file kết quả extension đã gửi: { assetId, path, name, mime }
    outputFile,
    status: 'pending',
    createdAt: Date.now(),
    claimedAt: null,
    message: 'Chờ extension nhận việc (Chrome có extension "AutoAffiliate Trợ lý" đã cấu hình token)',
    log,
    onResult,
  };
  log(task.message);
  tasks.set(id, task);
  return new Promise((resolve, reject) => {
    task.resolve = resolve;
    task.reject = reject;
    task.timer = setInterval(() => {
      const now = Date.now();
      if (task.status === 'pending' && now - task.createdAt > CLAIM_TIMEOUT) finish(task, new Error('Quá 20 phút không có extension nào nhận việc — kiểm tra extension đã cấu hình địa chỉ web + token (Cài đặt) và Chrome đang mở, rồi bấm Thử lại.'));
      else if (task.status === 'claimed' && now - task.claimedAt > RUN_TIMEOUT) finish(task, new Error('Quá 45 phút chưa có kết quả từ extension — bấm Thử lại.'));
    }, 5000);
  });
}

function finish(task, err, result) {
  if (task.status === 'done' || task.status === 'failed') return;
  clearInterval(task.timer);
  task.status = err ? 'failed' : 'done';
  tasks.delete(task.id);
  for (const u of task.uploads) if (fs.existsSync(u.path)) fs.rm(u.path, { force: true }, () => {});
  if (err) task.reject(err);
  else task.resolve(result);
}

export function status() {
  const list = [...tasks.values()];
  const current = list.find((t) => t.status === 'claimed') || null;
  return {
    connected: Date.now() - lastSeen < 45_000,
    lastSeen: lastSeen || null,
    pending: list.filter((t) => t.status === 'pending').length,
    current: current && { id: current.id, kind: current.kind, label: current.payload.label, message: current.message },
  };
}

// POST /api/agent/claim {kinds, syncOnly, version}
export function claim({ kinds = [], syncOnly = false, version } = {}) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve('extension/manifest.json'), 'utf8'));
    if (version && pkg?.version && version !== pkg.version) {
      return { reload: true, targetVersion: pkg.version, job: null, pendingCount: 0 };
    }
  } catch {}
  const pending = [...tasks.values()].filter((t) => t.status === 'pending' && kinds.includes(t.kind));
  const activeTaskIds = [...tasks.keys()];
  if (syncOnly) return { job: null, pendingCount: pending.length, activeTaskIds };
  // Extension đã nhận mà hỏi lại (vd. service worker khởi động lại) -> không giao lại việc đang chạy
  const task = pending[0];
  if (!task) return { job: null, pendingCount: 0 };
  task.status = 'claimed';
  task.claimedAt = Date.now();
  task.message = 'Extension đã nhận việc';
  task.log(task.message);
  return { job: { id: task.id, kind: task.kind, payload: task.payload }, pendingCount: pending.length - 1 };
}

// POST /api/agent/jobs/:id {status, message, result, error}
export function report(id, { status: st, message, result, error } = {}) {
  const task = tasks.get(id);
  if (!task) return { cancelled: true };
  const pendingCount = [...tasks.values()].filter((t) => t.status === 'pending').length;
  if (st === 'done') {
    const up = (result?.assetId && task.uploads.find((u) => u.assetId === result.assetId)) || task.uploads.at(-1);
    if (!up || !fs.existsSync(up.path)) { finish(task, new Error('Extension báo xong nhưng chưa gửi file kết quả')); return { cancelled: false, pendingCount }; }
    const size = fs.statSync(up.path).size;
    if (size < 1000) { finish(task, new Error(`File kết quả quá nhỏ (${size} byte)`)); return { cancelled: false, pendingCount }; }
    fs.renameSync(up.path, task.outputFile);
    task.uploads = task.uploads.filter((u) => u !== up);
    if (result?.src || result?.title) task.onResult(result.src || null, { title: result.title || null });
    finish(task, null, { id: 'extension', outputFile: task.outputFile, text: `Google Flow · extension${result?.credits ? ' · ' + result.credits : ''}`, title: result?.title || null });
    return { cancelled: false, pendingCount };
  }
  if (st === 'failed') { finish(task, new Error(error || 'Extension báo lỗi không rõ')); return { cancelled: false, pendingCount }; }
  if (message) { task.message = (st === 'needs_user' ? '⏸ ' : '') + message; task.log(task.message); }
  if (task.status === 'pending') { task.status = 'claimed'; task.claimedAt = Date.now(); }
  return { cancelled: false, pendingCount };
}

// POST /api/agent/jobs/:id/file?name&type (body thô) -> {assetId}
export function storeFile(id, { name, mime, buffer }) {
  const task = tasks.get(id);
  if (!task) throw new Error('Việc này không còn chờ kết quả');
  const assetId = newId();
  const ext = path.extname(name || '') || (/^video\//.test(mime || '') ? '.mp4' : /^image\//.test(mime || '') ? '.png' : '');
  const file = path.join(DIRS.tmp, `agent-${assetId}${ext}`);
  fs.writeFileSync(file, buffer);
  task.uploads.push({ assetId, path: file, name, mime });
  task.log(`Nhận file kết quả (${Math.round(buffer.length / 1024)} KB)`);
  return { assetId };
}

export const assetPath = (id, i) => tasks.get(id)?.files[Number(i)]?.path || null;
