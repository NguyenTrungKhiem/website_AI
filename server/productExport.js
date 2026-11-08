// Mã sản phẩm trên ảnh kết quả & xuất Excel cho DiamondShop — quy trình chỉ làm ảnh "Ảnh model mặc đồ" (mode 'input'):
// mỗi ảnh trang phục trong ô "Ảnh trang phục (chọn nhiều)" là 1 sản phẩm = 1 dòng Excel.
// - productInputsOf(workflowId): quy trình nào có bảng "Mã & sản phẩm" (inputs có kind 'product' + multiple). Các quy trình
//   video (Thay trang phục, Video bán hàng thời trang…) KHÔNG đi qua đây — mã của chúng in vào video qua prompt (productCodes.js).
// - productItemsOf(run): danh sách mục sản phẩm của lần chạy (key = id ảnh trang phục) + job render ảnh model mặc bộ đó.
// - buildProductRows(run): mỗi mục -> 1 dòng (mã, tên, giá, mô tả, ảnh, link Shopee…), lấy từ run.products (người dùng đã sửa)
//   -> asset.product (metadata lúc bóc link; ảnh làm sạch bằng Flow / sao chép kế thừa từ ảnh gốc qua fromAssetId) -> asset.name.
// - Mã dùng CHUNG sổ mã với video thời trang (productCodes.js): dạng LOAI_SO (VAY_01…), lưu ở asset.productCode của ảnh trang
//   phục, ảnh sinh từ ảnh đó dùng lại mã. suggestProductCode(title) = số kế tiếp của tiền tố đoán theo tên.
// - saveRunProducts(run, products): lưu run.products + PNG khung mã (vẽ ở trình duyệt), cấp/đổi mã trên ảnh trang phục
//   (assignCode), ghi ngược metadata để ảnh tự mang đủ tên / giá / link.
// - codedImagesOf(run) / ensureCodedImages(run): in khung mã lên từng ảnh kết quả thành file riêng (ảnh gốc giữ nguyên) và biết
//   khi nào phải in lại (anh-model.js stage 'badge' + sync).
// - buildWorkbook(rows): workbook exceljs đúng hợp đồng cột với DiamondShop (PRODUCT_COLUMNS — không tự đổi tên / thứ tự cột;
//   đổi phải sửa cả web-site-aff/src/lib/productImport.ts).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ExcelJS from 'exceljs';
import { db, save, DIRS, mediaUrl } from './db.js';
import { WORKFLOWS } from './workflows/index.js';
import { imageThumb, probe, overlayBadge } from './ffmpeg.js';
import { plainDescription } from './productScraper.js';
import { normalizeCode, isValidCode, prefixFor, nextCode, codeOfAsset, assignCode } from './productCodes.js';

// ---------- Hợp đồng file Excel (DiamondShop đọc đúng các cột này, đúng thứ tự) ----------
export const SHEET_NAME = 'San pham';
export const IMAGE_COLUMNS = 6;
export const PRODUCT_COLUMNS = [
  'Mã sản phẩm',
  'Tên sản phẩm',
  'Giá (đ)',
  'Mô tả',
  ...Array.from({ length: IMAGE_COLUMNS }, (_, i) => `Ảnh ${i + 1}`),
  'Link Shopee',
  'Danh mục',
  'Hoa hồng Shopee (đ)',
  'Ghi chú',
  'Xem trước',
];
const COLUMN_WIDTHS = [14, 44, 12, 56, ...Array(IMAGE_COLUMNS).fill(34), 48, 16, 20, 34, 13];
const PREVIEW_COL = PRODUCT_COLUMNS.indexOf('Xem trước'); // 0-based
const ROW_HEIGHT_PT = 80; // ~107px: đủ chỗ cho thumbnail 72x96px

// Vị trí mặc định của khung mã: tâm khung ở giữa theo chiều ngang, 12% chiều cao tính từ trên (phía trên đầu nhân vật)
export const DEFAULT_BADGE = { x: 0.5, y: 0.12, scale: 1 };

export const shopeeProductUrl = (shopId, itemId) =>
  shopId && itemId && /^\d+$/.test(String(shopId)) && /^\d+$/.test(String(itemId)) ? `https://shopee.vn/product/${shopId}/${itemId}` : null;

const str = (v, max = 300) => (v == null ? '' : String(v).trim().slice(0, max));
// Số nguyên không âm; chuỗi "259.000" / "259,000đ" -> 259000 (dấu chấm/phẩy là ngăn hàng nghìn)
const int = (v) => {
  if (v === '' || v == null) return null;
  const n = typeof v === 'number' ? Math.round(v) : Number(String(v).replace(/\D/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const num = (v, dflt) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Number(v) : dflt);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r3 = (v, d) => Math.round((Number.isFinite(Number(v)) ? Number(v) : d) * 1000) / 1000;
const isHttps = (u) => typeof u === 'string' && /^https:\/\/[^\s]+$/i.test(u);
const uniq = (arr) => [...new Set(arr)];
const exists = (f) => !!f && fs.existsSync(f);
const rm = (f) => { if (exists(f)) fs.rmSync(f, { force: true }); };

// ---------- Mã sản phẩm (sổ mã chung productCodes.js) ----------
// Mã người dùng gõ / mã đã lưu -> dạng chuẩn LOAI_SO hoặc null nếu không hợp lệ (mã kiểu cũ "AO-1" cũng coi như chưa có)
export const sanitizeCode = (v) => {
  if (v == null || !String(v).trim()) return null;
  const c = normalizeCode(v);
  return isValidCode(c) ? c : null;
};
// VAY_03 -> VAY_04 (giữ số chữ số)
const bumpCode = (c) => c.replace(/(\d+)$/, (m) => String(Number(m) + 1).padStart(m.length, '0'));

/**
 * Gợi ý mã kế tiếp cho tên sản phẩm: tiền tố theo tên (váy/đầm -> VAY, áo -> AO… như video thời trang) + số lớn nhất đã dùng
 * trong sổ mã + 1; bỏ qua các mã trong `taken` (mã các dòng khác đang đặt trên giao diện, chưa lưu). KHÔNG ghi gì vào sổ —
 * mã chỉ được cấp cho ảnh khi lưu (saveRunProducts -> assignCode).
 */
export function suggestProductCode(title, { taken = new Set() } = {}) {
  let c = nextCode(prefixFor(title));
  while (taken.has(c)) c = bumpCode(c);
  return c;
}

// ---------- Nguồn sản phẩm của quy trình ----------
/**
 * Quy trình có bảng "Mã & sản phẩm" khi có ô ảnh sản phẩm chọn nhiều (inputs kind 'product', multiple): mỗi ảnh trang phục
 * là 1 sản phẩm (Ảnh model mặc đồ). Trả về { mode: 'input', primary } hoặc null (quy trình video / không có ô như vậy).
 */
export function productInputsOf(workflowId) {
  const wf = WORKFLOWS[workflowId];
  if (!wf) return null;
  const multi = (wf.inputs || []).find((i) => i.kind === 'product' && i.multiple);
  return multi ? { mode: 'input', primary: multi, extras: [] } : null;
}

export const runHasProducts = (run) => !!productInputsOf(run.workflow);

// Tên asset khi nhập từ link có dạng "Tên sản phẩm – ảnh 2" / "Tên.jpg" / "Tên (Flow) #2" -> lấy phần tên
const cleanAssetName = (name) =>
  String(name || '')
    .replace(/\s+[–-]\s+(ảnh|anh)\b.*$/i, '')
    .replace(/\.(jpe?g|png|webp|gif)$/i, '')
    .replace(/\s*\((Flow|Mặt sau Flow)\)(\s*#\d+)?$/, '')
    .trim();

// Chuỗi ảnh gốc: ảnh -> ảnh nó được làm sạch / sao chép / cắt từ (fromAssetId) -> … (tối đa 8 cấp, chặn vòng lặp)
function assetChain(asset) {
  const chain = [];
  const seen = new Set();
  let a = asset;
  while (a && !seen.has(a.id) && chain.length < 8) {
    chain.push(a);
    seen.add(a.id);
    a = a.fromAssetId ? db.assets.find((x) => x.id === a.fromAssetId) : null;
  }
  return chain;
}
const compact = (o) => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && !v.length)));

/**
 * Metadata sản phẩm của 1 ảnh: của chính nó, thiếu gì thì lấy từ ảnh gốc (ảnh làm sạch bằng Flow "làm mới ảnh", ảnh sao chép
 * giữ product của nguồn) — nên ảnh trang phục đã làm mới vẫn có tên / giá / link Shopee lúc bóc tách. null = không có.
 */
export function productMetaOf(asset) {
  let meta = null;
  for (const a of assetChain(asset)) if (a?.product) meta = { ...a.product, ...compact(meta) };
  return meta;
}
// URL ảnh gốc (CDN Shopee) mà ảnh này (hoặc ảnh nguồn của nó) được tải về từ đó
export function sourceUrlOf(asset) {
  return assetChain(asset).find((a) => isHttps(a.source))?.source || null;
}

/**
 * Các mục sản phẩm của lần chạy, theo thứ tự chọn: { key, index, position, label, assetId, outputJob, frameThumb }.
 * key = id ảnh trang phục (cùng 1 ảnh chọn 2 lần = 1 mục); outputJob = job render ảnh model mặc bộ đó
 * (khoá `render:<vị trí>:<assetId>` của anh-model.js) nếu đã xong.
 */
export function productItemsOf(run) {
  const pi = productInputsOf(run.workflow);
  if (!pi) return [];
  const jobsMap = run.stages?._jobs || {};
  const jobOf = (k) => db.jobs.find((j) => j.id === jobsMap[k]);
  const ids = Array.isArray(run.inputs?.[pi.primary.key]) ? run.inputs[pi.primary.key] : [];
  const items = [];
  const seen = new Set();
  ids.forEach((assetId, pos) => {
    if (!assetId || seen.has(assetId)) return;
    seen.add(assetId);
    const asset = db.assets.find((a) => a.id === assetId) || null;
    const job = jobOf(`render:${pos}:${assetId}`);
    const outputJob = job?.status === 'done' && job.outputPath ? job : null;
    items.push({
      key: assetId,
      index: items.length + 1,
      position: pos,
      label: cleanAssetName(asset?.name) || `Bộ ${pos + 1}`,
      assetId,
      outputJob,
      frameThumb: outputJob?.thumbPath || outputJob?.outputPath || null,
    });
  });
  return items;
}

// File ảnh local để nhúng thumbnail vào Excel (không tải lại từ mạng): asset có source = ảnh chính, hoặc ảnh trang phục
function localImageFor(mainImage, assets) {
  const bySource = mainImage && db.assets.find((a) => a.source === mainImage && exists(a.path));
  if (bySource) return bySource.path;
  const first = assets.find((a) => exists(a?.path));
  return first ? first.path : null;
}

/**
 * Dòng sản phẩm cho từng mục của lần chạy. `override` = { [key]: {...} } dữ liệu đang sửa trên giao diện (chưa lưu)
 * để xuất Excel thử mà không cần lưu / in lại. key = id ảnh trang phục.
 */
export function buildProductRows(run, { override = null } = {}) {
  const pi = productInputsOf(run.workflow);
  if (!pi) return [];
  const wfName = WORKFLOWS[run.workflow]?.name || run.workflow;
  const modelAsset = run.inputs?.model ? db.assets.find((a) => a.id === run.inputs.model) : null;
  const modelName = cleanAssetName(modelAsset?.name) || 'model';
  const coded = Object.fromEntries(codedImagesOf(run).map((c) => [c.key, c]));
  const taken = new Set();

  return productItemsOf(run).map((item) => {
    const asset = db.assets.find((a) => a.id === item.assetId) || null;
    const meta = asset ? productMetaOf(asset) : null;
    const savedRaw = run.products?.[item.key] || {};
    const s = { ...savedRaw, ...(override?.[item.key] || {}) };

    const name = str(s.name, 200) || meta?.title || cleanAssetName(asset?.name) || `Sản phẩm ${item.index}`;
    const urls = uniq([s.mainImage, asset && sourceUrlOf(asset), ...(meta?.images || [])].filter(isHttps));
    const mainImage = isHttps(s.mainImage) && urls.includes(s.mainImage) ? s.mainImage : urls[0] || null;
    const images = [mainImage, ...urls.filter((u) => u !== mainImage)].filter(Boolean).slice(0, IMAGE_COLUMNS);

    // Mã: đã lưu cho lần chạy này -> mã của ảnh trang phục trong sổ mã (kế thừa theo chuỗi ảnh gốc) -> mã ghi trong metadata
    // -> gợi ý theo tên (không trùng các dòng khác)
    const assetCode = asset ? codeOfAsset(asset.id) : null;
    const savedCode = sanitizeCode(s.code) || assetCode || sanitizeCode(meta?.code);
    const suggestedCode = suggestProductCode(name, { taken });
    const code = savedCode || suggestedCode;
    taken.add(code);

    const link = shopeeProductUrl(meta?.shopId, meta?.itemId);
    const badgeSaved = savedRaw.badge || {};
    const badge = {
      x: clamp(num(s.badge?.x, num(badgeSaved.x, DEFAULT_BADGE.x)), 0, 1),
      y: clamp(num(s.badge?.y, num(badgeSaved.y, DEFAULT_BADGE.y)), 0, 1),
      scale: clamp(num(s.badge?.scale, num(badgeSaved.scale, DEFAULT_BADGE.scale)), 0.3, 3),
      file: exists(badgeSaved.file) ? badgeSaved.file : null,
      hash: badgeSaved.hash || null,
      frameWidth: badgeSaved.frameWidth || null,
    };
    const out = item.outputJob;
    const cd = coded[item.key];
    const codedPath = cd?.current?.path || null;
    // Thumbnail "Xem trước" trong Excel: ảnh kết quả đã in mã -> ảnh kết quả -> ảnh trang phục (file local, không tải lại)
    const thumbPath = exists(codedPath) ? codedPath : exists(out?.outputPath) ? out.outputPath : localImageFor(mainImage, [asset]);

    return {
      key: item.key,
      index: item.index,
      clipName: item.label,
      code,
      codeSaved: !!savedCode,
      suggestedCode,
      name,
      price: int(s.price) ?? meta?.price ?? null,
      description: plainDescription(s.description ?? meta?.description ?? ''),
      images,
      mainImage,
      shopeeUrl: link || meta?.url || null,
      linkOk: !!link,
      platform: meta?.platform || null,
      shopId: meta?.shopId || null,
      itemId: meta?.itemId || null,
      category: str(s.category, 100),
      note: `${wfName} – ${modelName} – Bộ ${item.index}`,
      badge,
      hasMeta: !!meta,
      assetId: asset?.id || null,
      assetName: asset?.name || null,
      thumbUrl: asset ? mediaUrl(asset.path) : null, // ảnh trang phục
      thumbPath,
      // Ảnh model đã render cho bộ này và bản đã in mã (nếu có)
      outputUrl: out ? mediaUrl(out.thumbPath) || mediaUrl(out.outputPath) : null,
      codedUrl: exists(codedPath) ? mediaUrl(codedPath) : null,
      codedStale: !!cd?.stale,
      frameUrl: mediaUrl(item.frameThumb) || null,
    };
  });
}

// Kích thước ảnh kết quả để trình duyệt vẽ PNG khung mã đúng độ phân giải: dò ảnh render đầu tiên đã xong;
// chưa có thì 720×1280 (ảnh của quy trình luôn dọc 9:16)
export async function frameSizeOf(run) {
  for (const item of productItemsOf(run)) {
    const f = item.outputJob?.outputPath;
    if (!exists(f)) continue;
    try {
      const p = await probe(f);
      if (p.width && p.height) return { width: p.width, height: p.height, probed: true };
    } catch {}
  }
  return { width: 720, height: 1280, probed: false };
}

// ---------- In mã lên ảnh kết quả ----------
/**
 * Với mỗi ảnh trang phục: có mã + PNG khung mã + ảnh model đã render -> cần 1 ảnh "có mã" data/outputs/coded-<runId>-<key>.png
 * (ảnh render gốc giữ nguyên). sig = mã + vị trí + PNG + file render; khác bản đã in (run.products[key].coded) -> stale.
 * Mục không còn cần (bỏ mã / ảnh render đổi) mà vẫn còn file cũ cũng là stale (để dọn).
 */
export function codedImagesOf(run) {
  if (!productInputsOf(run.workflow)) return [];
  return productItemsOf(run).map((item) => {
    const p = run.products?.[item.key];
    const b = p?.badge;
    const src = item.outputJob?.outputPath || null;
    const wanted = !!(p?.code && exists(b?.file) && exists(src));
    const sig = wanted ? JSON.stringify({ c: p.code, x: r3(b.x, 0.5), y: r3(b.y, 0.12), h: b.hash || path.basename(b.file), src }) : null;
    const cur = p?.coded || null;
    const have = !!(cur?.path && exists(cur.path));
    return {
      key: item.key,
      code: p?.code || null,
      src,
      badge: b || null,
      wanted,
      sig,
      dest: path.join(DIRS.outputs, `coded-${run.id}-${item.key}.png`),
      current: have ? cur : null,
      stale: wanted ? !(have && cur.sig === sig) : have,
    };
  });
}
export const codedImagesStale = (run) => codedImagesOf(run).some((c) => c.stale);

// In / in lại / dọn ảnh có mã cho các mục stale. Trả về true nếu có gì đổi. (ffmpeg overlay, vài trăm ms mỗi ảnh)
export async function ensureCodedImages(run) {
  let changed = false;
  for (const c of codedImagesOf(run)) {
    if (!c.stale) continue;
    const entry = run.products?.[c.key];
    if (!c.wanted) {
      if (entry?.coded?.path) rm(entry.coded.path);
      if (entry) entry.coded = null;
      changed = true;
      continue;
    }
    const { width } = await probe(c.src).catch(() => ({ width: 0 }));
    await overlayBadge({ src: c.src, badge: c.badge.file, dest: c.dest, x: c.badge.x, y: c.badge.y, frameWidth: c.badge.frameWidth, width });
    entry.coded = { path: c.dest, sig: c.sig, at: Date.now() };
    changed = true;
  }
  if (changed) save();
  return changed;
}

// ---------- Lưu ----------
const PNG_PREFIX = 'data:image/png;base64,';
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const MAX_PNG_BYTES = 4 * 1024 * 1024;

/**
 * Lưu mã / tên / giá / mô tả / ảnh chính / khung mã cho từng mục. products = { [key]: { code, name, price, description,
 * mainImage, category, badge: { x, y, scale, png?, frameWidth? } } } (key = id ảnh trang phục).
 * PNG (data URL) được lưu ra data/assets/badge-<runId>-<key>.png. Mã được cấp cho ảnh trang phục trong sổ mã chung
 * (assignCode: mã đã thuộc ảnh khác thì từ chối). Trả về các dòng sau khi lưu.
 * Việc in lại mã lên ảnh do runner quyết định (codedImagesStale trong anh-model.sync).
 */
export function saveRunProducts(run, products) {
  if (!products || typeof products !== 'object' || Array.isArray(products)) throw new Error('Thiếu dữ liệu sản phẩm');
  if (!productInputsOf(run.workflow)) throw new Error('Quy trình này không có bảng Mã & sản phẩm');
  // Bước 1: kiểm tra & dựng toàn bộ dữ liệu mới trước, chưa ghi gì — một mục lỗi (mã trùng / PNG hỏng) thì không mục nào bị ghi dở
  const seen = new Set();
  const pending = [];
  for (const item of productItemsOf(run)) {
    const key = item.key;
    const p = products[key];
    if (!p || typeof p !== 'object') continue;
    const prev = run.products?.[key] || {};
    const raw = p.code == null ? '' : String(p.code).trim();
    const code = raw ? normalizeCode(raw) : null;
    if (raw && !isValidCode(code)) throw new Error(`Mã "${raw.slice(0, 40)}" không hợp lệ: cần dạng LOAI_SO, vd. VAY_01`);
    if (code && seen.has(code)) throw new Error(`Mã ${code} đang được đặt cho 2 ảnh — mỗi ảnh trang phục một mã`);
    if (code) seen.add(code);
    if (code && item.assetId && codeOfAsset(item.assetId) !== code) {
      const owner = db.assets.find((a) => a.productCode === code && a.id !== item.assetId);
      if (owner) throw new Error(`Mã ${code} đã thuộc ảnh "${owner.name}"`);
    }

    const entry = {
      code: code || null,
      name: str(p.name, 200) || prev.name || null,
      price: p.price === undefined ? prev.price ?? null : int(p.price),
      // không gửi -> giữ bản trước (null = chưa sửa, dòng vẫn lấy mô tả gốc từ asset.product); gửi "" = cố ý để trống
      description: p.description === undefined ? prev.description ?? null : plainDescription(p.description),
      mainImage: isHttps(p.mainImage) ? p.mainImage : prev.mainImage || null,
      category: p.category === undefined ? prev.category || '' : str(p.category, 100),
      badge: { ...DEFAULT_BADGE, ...(prev.badge || {}) },
      coded: prev.coded || null, // ảnh có mã đã in; sig lệch thì in lại
      updatedAt: Date.now(),
    };
    const b = p.badge && typeof p.badge === 'object' ? p.badge : {};
    entry.badge.x = clamp(num(b.x, entry.badge.x), 0, 1);
    entry.badge.y = clamp(num(b.y, entry.badge.y), 0, 1);
    entry.badge.scale = clamp(num(b.scale, entry.badge.scale), 0.3, 3);
    let png = null;
    if (typeof b.png === 'string' && b.png.length) {
      if (!b.png.startsWith(PNG_PREFIX)) throw new Error('Khung mã phải là ảnh PNG (data URL)');
      const buf = Buffer.from(b.png.slice(PNG_PREFIX.length), 'base64');
      if (!buf.length || buf.length > MAX_PNG_BYTES || !buf.subarray(0, 4).equals(PNG_MAGIC)) throw new Error('Ảnh khung mã không hợp lệ hoặc quá lớn');
      png = { buf, file: path.join(DIRS.assets, `badge-${run.id}-${key}.png`), frameWidth: int(b.frameWidth) || null, frameHeight: int(b.frameHeight) || null };
    }
    pending.push({ item, key, code, entry, png });
  }

  // Bước 2: ghi
  run.products ||= {};
  for (const { item, key, code, entry, png } of pending) {
    if (png) {
      fs.writeFileSync(png.file, png.buf);
      entry.badge.file = png.file;
      entry.badge.hash = crypto.createHash('sha1').update(png.buf).digest('hex').slice(0, 10);
      entry.badge.frameWidth = png.frameWidth;
      entry.badge.frameHeight = png.frameHeight;
    }
    run.products[key] = entry;

    const asset = db.assets.find((a) => a.id === item.assetId);
    if (asset && code) {
      // Cấp / đổi mã trên ảnh trang phục trong sổ mã chung (ảnh sinh từ ảnh này dùng lại mã); mã đang kế thừa từ ảnh gốc thì giữ
      if (codeOfAsset(asset.id) !== code) assignCode(asset.id, code);
      // Ghi ngược metadata kế thừa từ ảnh gốc để chính ảnh này tự mang đủ tên / giá / link cho lần chạy sau
      asset.product = { ...(productMetaOf(asset) || {}), code };
    }
  }
  save();
  return buildProductRows(run);
}

// ---------- Excel ----------
// Thumbnail nhúng: đọc file local; file to hoặc không phải png/jpg (webp…) thì thu nhỏ bằng ffmpeg ra data/tmp
async function thumbImage(file) {
  if (!exists(file)) return null;
  const ext = path.extname(file).toLowerCase();
  const direct = ext === '.png' ? 'png' : ext === '.jpg' || ext === '.jpeg' ? 'jpeg' : ext === '.gif' ? 'gif' : null;
  try {
    if (direct && fs.statSync(file).size <= 250 * 1024) return { buffer: fs.readFileSync(file), extension: direct };
    const hash = crypto.createHash('md5').update(file + fs.statSync(file).mtimeMs).digest('hex').slice(0, 12);
    const dest = path.join(DIRS.tmp, `xlsx-thumb-${hash}.jpg`);
    if (!exists(dest)) await imageThumb(file, dest);
    return { buffer: fs.readFileSync(dest), extension: 'jpeg' };
  } catch {
    return direct ? { buffer: fs.readFileSync(file), extension: direct } : null;
  }
}

/**
 * Dựng workbook đúng hợp đồng. rows = kết quả buildProductRows (hoặc dữ liệu cùng dạng trong test).
 * thumbnails = false -> không nhúng ảnh (nhanh, dùng trong test).
 */
export async function buildWorkbook(rows, { thumbnails = true } = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'web-video';
  wb.created = new Date();
  const ws = wb.addWorksheet(SHEET_NAME, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = PRODUCT_COLUMNS.map((header, i) => ({ header, key: `c${i}`, width: COLUMN_WIDTHS[i] }));

  const head = ws.getRow(1);
  head.font = { bold: true };
  head.alignment = { vertical: 'middle', wrapText: true };
  head.height = 24;
  head.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8ECF4' } };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF9AA3B5' } } };
  });

  for (const r of rows) {
    const images = Array.from({ length: IMAGE_COLUMNS }, (_, i) => r.images?.[i] || '');
    const price = Number.isFinite(Number(r.price)) && r.price !== null && r.price !== '' ? Math.round(Number(r.price)) : null;
    const row = ws.addRow([
      r.code || '',
      r.name || '',
      price,
      r.description || '',
      ...images,
      r.shopeeUrl || '',
      r.category || '',
      null, // Hoa hồng Shopee (đ): web-video không có, DiamondShop điền
      r.note || '',
      '',
    ]);
    row.height = ROW_HEIGHT_PT;
    row.alignment = { vertical: 'top', wrapText: true };
    const priceCell = row.getCell(3);
    priceCell.numFmt = '#,##0';
    priceCell.alignment = { vertical: 'top', horizontal: 'right' };
    const linkCell = row.getCell(IMAGE_COLUMNS + 5);
    if (r.shopeeUrl) {
      linkCell.value = { text: r.shopeeUrl, hyperlink: r.shopeeUrl };
      linkCell.font = { color: { argb: 'FF1F5BD6' }, underline: true };
    }
    for (let i = 0; i < IMAGE_COLUMNS; i++) {
      const c = row.getCell(5 + i);
      if (images[i]) {
        c.value = { text: images[i], hyperlink: images[i] };
        c.font = { color: { argb: 'FF1F5BD6' }, underline: true, size: 9 };
      }
    }
    if (thumbnails && r.thumbPath) {
      const img = await thumbImage(r.thumbPath);
      if (img) {
        const id = wb.addImage({ buffer: img.buffer, extension: img.extension });
        ws.addImage(id, { tl: { col: PREVIEW_COL + 0.1, row: row.number - 1 + 0.05 }, ext: { width: 72, height: 96 }, editAs: 'oneCell' });
      }
    }
  }
  return wb;
}

export function exportFilename(run, at = new Date()) {
  const ymd = `${at.getFullYear()}${String(at.getMonth() + 1).padStart(2, '0')}${String(at.getDate()).padStart(2, '0')}`;
  return `san-pham-${ymd}-${run.id}.xlsx`;
}
