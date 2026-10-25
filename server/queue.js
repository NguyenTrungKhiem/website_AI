// Hàng đợi job tạo video/ảnh: chạy lần lượt từng job (Flow chỉ có 1 cửa sổ trình duyệt).
// Loại job: motion (thay người + sản phẩm), background (thay bối cảnh video), image (sinh ảnh, vd. bối cảnh mới).
import fs from 'node:fs';
import path from 'node:path';
import { db, save, DIRS, newId } from './db.js';
import { buildMotionPrompt, buildBackgroundPrompt, fillTemplate } from './prompts.js';
import * as flow from './flow.js';
import { thumbnail, imageThumb } from './ffmpeg.js';

const running = new Set();
// Được gọi mỗi khi 1 job xong/lỗi (quy trình tự động dùng để chuyển bước)
export const settledHooks = [];

const assetOf = (id) => (id ? db.assets.find((a) => a.id === id) : null);
const assetPath = (id) => assetOf(id)?.path || null;
// Ảnh do Flow tạo (có flowTitle) -> { đường dẫn file: tên trên Flow } để flow.js dùng lại, không tải lên lại
const flowRefsOf = (...ids) => Object.fromEntries(ids.map(assetOf).filter((a) => a?.flowTitle).map((a) => [a.path, a.flowTitle]));

export function createJob({
  type, batchId, videoPath, videoLabel, prompt = '', rawPrompt, assets = {}, parentJobId, sourceRange,
  template, imagePaths, runId, stage, meta,
}) {
  const job = {
    id: newId(),
    type,
    batchId: batchId || null,
    runId: runId || null, // thuộc quy trình tự động nào (AI Dancing…)
    stage: stage || null,
    parentJobId: parentJobId || null,
    sourceRange: sourceRange || null, // { sourceId, start, end } — vị trí trong video gốc, dùng để khớp âm thanh khi ghép
    videoPath: videoPath || null,
    videoLabel,
    assets, // motion: { model, product } | background: { background }
    imagePaths: imagePaths || null, // image: các ảnh tham chiếu (đường dẫn file)
    template: template ?? null, // prompt mẫu riêng (quy trình); null = dùng prompt mẫu trong Cài đặt
    meta: meta || null, // thông tin thêm, vd. { cleanOf: assetId, kind } cho job tạo ảnh sản phẩm sạch
    prompt,
    rawPrompt: !!rawPrompt,
    status: 'queued',
    error: null,
    attempts: [],
    outputPath: null,
    thumbPath: null,
    createdAt: Date.now(),
  };
  db.jobs.unshift(job);
  save();
  pump();
  return job;
}

/**
 * Video nhập từ máy (không qua AI): tạo job đã "xong" để dùng như mọi video đã tạo
 * (ghép, thay bối cảnh, đăng). sourceRange = đoạn gốc tương ứng (để khớp âm thanh khi ghép), có thể null.
 */
export async function createImportJob({ file, name, sourceRange, runId, stage, videoLabel }) {
  const id = newId();
  const outputPath = path.join(DIRS.outputs, `import-${id}${path.extname(file).toLowerCase() || '.mp4'}`);
  fs.renameSync(file, outputPath);
  const thumbPath = outputPath.replace(/\.[^.]+$/, '.jpg');
  await thumbnail(outputPath, thumbPath).catch(() => {});
  const job = {
    id,
    type: 'import',
    batchId: null,
    runId: runId || null,
    stage: stage || null,
    parentJobId: null,
    sourceRange: sourceRange || null,
    videoPath: null,
    videoLabel: videoLabel || name,
    importedName: name,
    assets: {},
    imagePaths: null,
    template: null,
    prompt: '',
    rawPrompt: false,
    status: 'done',
    error: null,
    attempts: [{ n: 1, status: 'done', engine: 'import', outputPath, thumbPath, startedAt: Date.now(), finishedAt: Date.now(), note: `Nhập từ máy: ${name}` }],
    outputPath,
    thumbPath,
    createdAt: Date.now(),
  };
  db.jobs.unshift(job);
  save();
  return job;
}

export function retryJob(job, { prompt } = {}) {
  if (job.status === 'running' || job.status === 'queued') return job;
  if (job.type === 'import') throw new Error('Video nhập từ máy không tạo lại được — nhập file khác nếu cần.');
  if (typeof prompt === 'string') job.prompt = prompt;
  job.status = 'queued';
  job.error = null;
  save();
  pump();
  return job;
}

export function engineName() {
  return db.settings.engine === 'mock' ? 'mock' : 'flow';
}

export function pump() {
  // Flow chỉ có 1 cửa sổ trình duyệt -> chạy lần lượt từng video
  for (const job of db.jobs.slice().reverse()) {
    if (running.size >= 1) break;
    if (job.status === 'queued' && !running.has(job.id)) run(job);
  }
}

// Ghép prompt cuối cùng + danh sách ảnh (thứ tự cố định: model -> sản phẩm | bối cảnh)
// + flowRefs: ảnh nào do Flow tạo thì kèm tên trên Flow để dùng lại ngay trong dự án
function prepare(job) {
  const images = [];
  if (job.type === 'motion') {
    let flowRefs;
    if (job.imagePaths?.length) {
      // Quy trình đưa sẵn danh sách ảnh đúng thứ tự (vd. Thay trang phục: model, khung mặt khoá, trang phục trước/sau)
      for (const f of job.imagePaths) if (fs.existsSync(f)) images.push(f);
      flowRefs = Object.fromEntries(db.assets.filter((a) => a.flowTitle && images.includes(a.path)).map((a) => [a.path, a.flowTitle]));
    } else {
      const model = assetPath(job.assets.model);
      const product = assetPath(job.assets.product);
      if (model) images.push(model);
      if (product) images.push(product);
      flowRefs = flowRefsOf(job.assets.model, job.assets.product);
    }
    const prompt = buildMotionPrompt({
      userPrompt: job.prompt, raw: job.rawPrompt,
      template: job.template || db.settings.motionTemplate,
    });
    return { images, prompt, flowRefs };
  }
  if (job.type === 'background') {
    const bg = assetPath(job.assets.background);
    if (bg) images.push(bg);
    const prompt = buildBackgroundPrompt({
      userPrompt: job.prompt, raw: job.rawPrompt,
      template: job.template || db.settings.backgroundTemplate,
    });
    return { images, prompt, flowRefs: flowRefsOf(job.assets.background) };
  }
  // image
  for (const f of job.imagePaths || []) if (fs.existsSync(f)) images.push(f);
  const prompt = job.rawPrompt || !job.template ? job.prompt : fillTemplate(job.template, job.prompt);
  const flowRefs = Object.fromEntries(db.assets.filter((a) => a.flowTitle && images.includes(a.path)).map((a) => [a.path, a.flowTitle]));
  return { images, prompt, flowRefs };
}

async function run(job) {
  running.add(job.id);
  job.status = 'running';
  const engine = engineName();
  const { images, prompt: finalPrompt, flowRefs } = prepare(job);
  const attempt = {
    n: Math.max(0, ...job.attempts.map((a) => a.n)) + 1, // không dùng length vì có thể đã xoá bớt lần tạo
    prompt: job.prompt,
    finalPrompt,
    engine,
    status: 'running',
    startedAt: Date.now(),
  };
  job.attempts.push(attempt);
  save();

  const isImage = job.type === 'image';
  const outputFile = path.join(DIRS.outputs, `${job.type}-${job.id}-v${attempt.n}.${isImage ? 'png' : 'mp4'}`);
  // Tiến trình từng bước (Flow) hiển thị trên thẻ video
  const log = (msg) => { attempt.progress = msg; save(); };
  // Flow: nhớ đường dẫn file kết quả ngay khi thấy, để nếu tải về lỗi thì lần Thử lại chỉ tải lại chứ không tạo mới
  // flowTitle = tên kết quả trên Flow: ảnh tạo ra có thể dùng lại làm nguyên liệu mà không tải lên lại
  const onResult = (src, info = {}) => { attempt.flowSrc = src; if (info.title) attempt.flowTitle = info.title; save(); };
  const input = { settings: db.settings, prompt: finalPrompt, video: job.videoPath, images, flowRefs, outputFile, log, onResult };
  try {
    let result;
    const prev = job.attempts.filter((a) => a !== attempt).at(-1);
    if (engine === 'mock') result = await mockGenerate(input, isImage);
    else if (prev?.flowSrc && !prev.outputPath && job.prompt === prev.prompt) {
      // Lần trước Flow đã tạo xong nhưng tải về lỗi -> lấy lại kết quả đó (không tốn credit)
      log('Lấy lại video đã tạo trên Flow ở lần trước (không tạo mới)');
      try {
        await flow.fetchToFile(prev.flowSrc, outputFile);
        attempt.flowSrc = prev.flowSrc;
        result = { id: 'flow-recovered', text: 'Google Flow · lấy lại kết quả lần ' + prev.n };
      } catch (e) {
        log('Không lấy lại được (' + e.message + ') -> tạo mới');
        result = isImage ? await flow.generateImage(input) : await flow.generateVideo(input);
      }
    } else result = isImage ? await flow.generateImage(input) : await flow.generateVideo(input);

    const thumb = outputFile.replace(/\.(mp4|png)$/, '.jpg');
    await (isImage ? imageThumb(outputFile, thumb) : thumbnail(outputFile, thumb)).catch(() => {});
    Object.assign(attempt, { status: 'done', outputPath: outputFile, thumbPath: thumb, interactionId: result.id, note: result.text });
    job.outputPath = outputFile;
    job.thumbPath = thumb;
    job.status = 'done';
  } catch (e) {
    Object.assign(attempt, { status: 'failed', error: e.message });
    job.status = 'failed';
    job.error = e.message;
  } finally {
    attempt.finishedAt = Date.now();
    running.delete(job.id);
    save();
    pump();
    for (const h of settledHooks) Promise.resolve().then(() => h(job)).catch((err) => console.error(err));
  }
}

// Engine giả để thử quy trình không tốn tiền: chép đầu vào ra đầu ra sau 2 giây (bật bằng settings.engine = "mock")
async function mockGenerate({ video, images, outputFile, log }, isImage) {
  log('Engine giả: đang chờ 2s');
  await new Promise((r) => setTimeout(r, 2000));
  const src = isImage ? images[0] : video;
  if (!src) throw new Error('Engine giả: thiếu đầu vào');
  fs.copyFileSync(src, outputFile);
  return { id: 'mock', text: 'mock' };
}

// Khi khởi động lại server: job đang chạy dở coi như lỗi để người dùng bấm thử lại.
export function recoverJobs() {
  for (const job of db.jobs) {
    if (job.status === 'running') {
      job.status = 'failed';
      job.error = 'Server bị dừng khi đang xử lý — bấm Thử lại.';
      const last = job.attempts.at(-1);
      if (last?.status === 'running') Object.assign(last, { status: 'failed', error: job.error });
    }
  }
  save();
  pump();
}
