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
// - buildWorkbook(rows): workbook exceljs 5 cột (PRODUCT_COLUMNS): Mã sản phẩm · Giá (đ) · Mô tả · Ảnh (ĐÚNG 1 ảnh = ảnh model
//   đã render, bản có mã nếu đã in, nhúng vào ô + tên file) · Hoa hồng Shopee (đ) (asset.product.commission, lấy khi bóc link
//   qua affiliate.shopee.vn hoặc nhập tay). Từ 22/11/2026 KHÔNG còn Tên / Link Shopee / Ảnh 1–6 (CDN Shopee) / Danh mục / Ghi chú:
//   DiamondShop (web-site-aff/src/lib/productImport.ts) hiện vẫn đòi "Tên sản phẩm" + "Link Shopee" và chỉ nhận ảnh CDN Shopee
//   → phải cập nhật bộ nhập bên đó trước khi nhập file này.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ExcelJS from 'exceljs';
import { MODEL_OUTFIT_SLOTS, SLOT_ORDER } from './workflows/anh-model-schema.js';
import { db, save, DIRS, mediaUrl } from './db.js';
import { imageThumb, probe, overlayBadges } from './ffmpeg.js';
import { plainDescription } from './productScraper.js';
import { normalizeCode, isValidCode, prefixFor, nextCode, codeOfAsset, assignCode } from './productCodes.js';
import { WORKFLOWS } from './workflows/index.js';

// ---------- File Excel: 6 cột, đúng thứ tự ----------
export const SHEET_NAME = 'San pham';
export const PRODUCT_COLUMNS = ['Mã sản phẩm', 'Giá (đ)', 'Mô tả', 'Ảnh', 'Hoa hồng Shopee (đ)', 'Link Shopee Aff'];
const COLUMN_WIDTHS = [14, 14, 60, 30, 20, 42];
const IMAGE_COL = PRODUCT_COLUMNS.indexOf('Ảnh'); // 0-based
const AFF_COL = PRODUCT_COLUMNS.indexOf('Link Shopee Aff'); // 0-based
const isHttp = (u) => typeof u === 'string' && /^https?:\/\/[^\s]+$/i.test(u.trim());
// Ảnh render dọc 9:16 nhúng trong ô "Ảnh": 108×192px; dòng cao 150pt (= 200px) để chứa
const IMAGE_EXT = { width: 108, height: 192 };
const ROW_HEIGHT_PT = 150;
// URL ảnh ghi trong ô khi không biết host (test); server truyền baseUrl theo request
export const DEFAULT_BASE_URL = 'http://localhost:3001';

// Vị trí mặc định của khung mã đơn lẻ: tâm khung ở giữa theo chiều ngang, 12% chiều cao tính từ trên (phía trên đầu nhân vật)
export const DEFAULT_BADGE = { x: 0.5, y: 0.12, scale: 1 };
const VALID_BADGE_STYLES = ['boutique_female', 'editorial_serif', 'modern_male', 'classic'];
const safeFilePart = (s) => String(s || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'item';

/**
 * Tuỳ chọn kiểu chữ / hiển thị khung mã của 1 lần chạy. Mặc định Nữ dùng 'boutique_female', Nam dùng 'modern_male'.
 */
export function badgePrefsOf(run) {
  const dflt = run?.workflow === 'anh-model-nam' ? 'modern_male' : 'boutique_female';
  const style = VALID_BADGE_STYLES.includes(run?.badgePrefs?.style) ? run.badgePrefs.style : dflt;
  return {
    style,
    showSlotPrefix: run?.badgePrefs?.showSlotPrefix !== false,
  };
}

/**
 * Chia vị trí mặc định thông minh khi 1 ảnh render có 1..4+ mã sản phẩm:
 * - 1 món: giữa trên (50%, 11%)
 * - >= 2 món: Áo / Đồ bộ ở Trái trên (25%, 9%), Quần / Váy ở Phải trên (75%, 9%),
 *   Áo khoác & Túi ở tầng 2 hoặc góc đối xứng còn trống — không đè mặt, không đè nhau.
 */
export function defaultBadgeLayoutForOutfit(slotsPresent = []) {
  const list = (slotsPresent || []).filter(Boolean);
  if (!list.length) return {};
  if (list.length === 1) return { [list[0]]: { x: 0.5, y: 0.11, scale: 1 } };

  const anchors = {
    TL1: { x: 0.25, y: 0.09, scale: 0.72 },
    TR1: { x: 0.75, y: 0.09, scale: 0.72 },
    TL2: { x: 0.25, y: 0.16, scale: 0.72 },
    TR2: { x: 0.75, y: 0.16, scale: 0.72 },
  };
  const used = new Set();
  const take = (...order) => {
    for (const k of order) {
      if (!used.has(k)) { used.add(k); return { ...anchors[k] }; }
    }
    return { x: 0.5, y: 0.18, scale: 0.72 };
  };

  const out = {};
  if (list.includes('set')) out.set = take('TL1');
  if (list.includes('top')) out.top = take('TL1', 'TR1', 'TL2');
  if (list.includes('dress')) out.dress = take('TR1', 'TL1', 'TR2');
  if (list.includes('bottom')) out.bottom = take('TR1', 'TL1', 'TR2');
  if (list.includes('jacket')) out.jacket = take('TL1', 'TR1', 'TL2', 'TR2');
  if (list.includes('bag')) out.bag = take('TR1', 'TR2', 'TL2', 'TL1');
  for (const s of list) {
    if (!out[s]) out[s] = take('TL1', 'TR1', 'TL2', 'TR2');
  }
  return out;
}

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
 * Quy trình có bảng "Mã & sản phẩm":
 * - Dạng mới (`wf.modelOutfits`): mỗi Bộ có 1..4+ sản phẩm (Áo, Quần, Váy, Đồ bộ, Áo khoác, Túi).
 * - Dạng cũ (`inputs` có `kind: 'product' && multiple`): mỗi ảnh trang phục là 1 sản phẩm.
 */
export function productInputsOf(workflowId) {
  const wf = WORKFLOWS[workflowId];
  if (!wf) return null;
  if (wf.modelOutfits) {
    return {
      mode: 'modelOutfits',
      key: wf.modelOutfits.key,
      gender: wf.modelOutfits.gender,
      slots: wf.modelOutfits.slots || MODEL_OUTFIT_SLOTS[wf.modelOutfits.gender] || [],
    };
  }
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
 * Các mục sản phẩm của lần chạy, theo thứ tự chọn:
 * - Dạng mới (`modelOutfits`): mỗi Bộ tách thành từng món đã nhập (1..4+ món), mỗi món có `key = "<outfitId>__<slot>"`,
 *   `outfitKey = outfitId`, `defaultBadge` chia vị trí thông minh Trái/Phải trên, cùng chung `outputJob`.
 * - Dạng cũ (`inputs.outfits`): mỗi ảnh là 1 Bộ = 1 mục (`key = outfitKey = assetId`).
 */
export function productItemsOf(run) {
  const pi = productInputsOf(run.workflow);
  if (!pi) return [];
  const jobsMap = run.stages?._jobs || {};
  const jobOf = (k) => db.jobs.find((j) => j.id === jobsMap[k]);

  if (pi.mode === 'modelOutfits' && Array.isArray(run.inputs?.modelOutfits) && run.inputs.modelOutfits.length) {
    const slotMetaByKey = Object.fromEntries((pi.slots || []).map((s) => [s.key, s]));
    const items = [];
    run.inputs.modelOutfits.forEach((outfit, pos) => {
      const outfitKey = outfit?.id || `o${pos + 1}`;
      const presentSlots = SLOT_ORDER.filter((s) => outfit?.items?.[s]);
      const layout = defaultBadgeLayoutForOutfit(presentSlots);
      const job = jobOf(`render:${pos}:${outfitKey}`) || (outfit.legacyAssetId ? jobOf(`render:${pos}:${outfit.legacyAssetId}`) : null);
      const outputJob = job?.status === 'done' && job.outputPath ? job : null;
      for (const slot of presentSlots) {
        const assetId = outfit.items[slot];
        const asset = db.assets.find((a) => a.id === assetId) || null;
        const slotMeta = slotMetaByKey[slot] || null;
        const key = `${outfitKey}__${slot}`;
        items.push({
          key,
          outfitKey,
          outfitIndex: pos + 1,
          outfitLabel: `Bộ ${pos + 1}`,
          outfitItemCount: presentSlots.length,
          slot,
          slotLabel: slotMeta?.label || slot,
          slotShort: slotMeta?.shortLabel || slot.toUpperCase(),
          defaultBadge: layout[slot] || DEFAULT_BADGE,
          index: items.length + 1,
          position: pos,
          label: `${slotMeta?.label ? `${slotMeta.label} · ` : ''}${cleanAssetName(asset?.name) || `Bộ ${pos + 1}`}`,
          assetId,
          outputJob,
          frameThumb: outputJob?.thumbPath || outputJob?.outputPath || null,
        });
      }
    });
    return items;
  }

  const primaryKey = pi.primary?.key || 'outfits';
  const ids = Array.isArray(run.inputs?.[primaryKey]) ? run.inputs[primaryKey] : [];
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
      outfitKey: assetId,
      outfitIndex: pos + 1,
      outfitLabel: `Bộ ${pos + 1}`,
      outfitItemCount: 1,
      slot: null,
      slotLabel: null,
      slotShort: null,
      defaultBadge: DEFAULT_BADGE,
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

/**
 * Dòng sản phẩm cho từng mục của lần chạy. `override` = { [key]: {...} } dữ liệu đang sửa trên giao diện (chưa lưu)
 * để xuất Excel thử mà không cần lưu / in lại.
 */
export function buildProductRows(run, { override = null } = {}) {
  const pi = productInputsOf(run.workflow);
  if (!pi) return [];
  const wfName = WORKFLOWS[run.workflow]?.name || run.workflow;
  const modelAsset = run.inputs?.model ? db.assets.find((a) => a.id === run.inputs.model) : null;
  const modelName = cleanAssetName(modelAsset?.name) || 'model';
  const coded = Object.fromEntries(codedImagesOf(run).map((c) => [c.outfitKey, c]));
  const taken = new Set();
  const assetToCode = new Map();

  return productItemsOf(run).map((item) => {
    const asset = db.assets.find((a) => a.id === item.assetId) || null;
    const meta = asset ? productMetaOf(asset) : null;
    const savedRaw = run.products?.[item.key] || {};
    const s = { ...savedRaw, ...(override?.[item.key] || {}) };

    const name = str(s.name, 200) || meta?.title || cleanAssetName(asset?.name) || `Sản phẩm ${item.index}`;
    // Ảnh gốc Shopee (CDN) chỉ để hiện trên giao diện / tham khảo — Excel không còn xuất
    const images = uniq([asset && sourceUrlOf(asset), ...(meta?.images || [])].filter(isHttps)).slice(0, 6);

    // Mã: đã lưu cho dòng -> cùng asset đã chọn ở bộ trên (Mix & Match) -> mã trên ảnh -> metadata -> gợi ý
    const assetCode = asset ? codeOfAsset(asset.id) : null;
    const sharedCode = item.assetId ? assetToCode.get(item.assetId) : null;
    const savedCode = sanitizeCode(s.code) || assetCode || sanitizeCode(meta?.code) || sharedCode;
    const suggestedCode = savedCode || suggestProductCode(name, { taken });
    const code = savedCode || suggestedCode;
    taken.add(code);
    if (item.assetId && code) assetToCode.set(item.assetId, code);

    const link = shopeeProductUrl(meta?.shopId, meta?.itemId);
    const badgeSaved = savedRaw.badge || {};
    const dfltBadge = item.defaultBadge || DEFAULT_BADGE;
    const badge = {
      x: clamp(num(s.badge?.x, num(badgeSaved.x, dfltBadge.x)), 0, 1),
      y: clamp(num(s.badge?.y, num(badgeSaved.y, dfltBadge.y)), 0, 1),
      scale: clamp(num(s.badge?.scale, num(badgeSaved.scale, dfltBadge.scale)), 0.3, 3),
      file: exists(badgeSaved.file) ? badgeSaved.file : null,
      hash: badgeSaved.hash || null,
      frameWidth: badgeSaved.frameWidth || null,
    };
    const out = item.outputJob;
    const cd = coded[item.outfitKey];
    const codedPath = cd?.current?.path || null;
    // Ảnh xuất Excel (cột "Ảnh", đúng 1 ảnh đã render): bản đã in mã -> ảnh kết quả; chưa render -> không có
    const renderPath = exists(codedPath) ? codedPath : exists(out?.outputPath) ? out.outputPath : null;
    // Hoa hồng: người dùng sửa trong bảng (null = chưa sửa) -> metadata lúc bóc link
    const commission = s.commission === undefined || s.commission === null ? meta?.commission ?? null : int(s.commission);
    // Link Shopee Aff: đang sửa / đã lưu -> link Aff gốc gắn lúc bóc tách (kế thừa qua fromAssetId) -> link chuẩn / url gốc
    const affiliateUrl = s.affiliateUrl !== undefined && s.affiliateUrl !== null
      ? str(s.affiliateUrl, 2000)
      : (str(meta?.affiliateUrl, 2000) || link || str(meta?.url, 2000) || '');

    return {
      key: item.key,
      outfitKey: item.outfitKey,
      outfitIndex: item.outfitIndex,
      outfitLabel: item.outfitLabel,
      outfitItemCount: item.outfitItemCount,
      slot: item.slot,
      slotLabel: item.slotLabel,
      slotShort: item.slotShort,
      defaultBadge: dfltBadge,
      index: item.index,
      clipName: item.label,
      code,
      codeSaved: !!savedCode,
      suggestedCode,
      name,
      price: int(s.price) ?? meta?.price ?? null,
      description: plainDescription(s.description ?? meta?.description ?? ''),
      commission,
      commissionRateBps: meta?.commissionRateBps ?? null,
      affiliateUrl: affiliateUrl || null,
      images,
      shopeeUrl: link || meta?.url || null,
      linkOk: !!link,
      platform: meta?.platform || null,
      shopId: meta?.shopId || null,
      itemId: meta?.itemId || null,
      note: `${wfName} – ${modelName} – ${item.outfitLabel}${item.slotLabel ? ` (${item.slotLabel})` : ''}`,
      badge,
      hasMeta: !!meta,
      renderPath,
      renderName: renderPath ? path.basename(renderPath) : null,
      renderUrl: renderPath ? mediaUrl(renderPath) : null,
      renderCoded: !!(renderPath && renderPath === codedPath),
      assetId: asset?.id || null,
      assetName: asset?.name || null,
      thumbUrl: asset ? mediaUrl(asset.path) : null,
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

// ---------- In mã lên ảnh kết quả (hỗ trợ 1 hoặc nhiều mã trên cùng 1 ảnh) ----------
/**
 * Gom các mục sản phẩm theo Bộ (`outfitKey`): mỗi Bộ tạo 1 ảnh "có mã" data/outputs/coded-<runId>-<outfitKey>.png
 * mang đồng thời tất cả khung mã (1..4+ mã) của các món đã đặt mã trong Bộ đó (ảnh render gốc giữ nguyên).
 */
export function codedImagesOf(run) {
  if (!productInputsOf(run.workflow)) return [];
  const groups = new Map();
  for (const item of productItemsOf(run)) {
    const g = groups.get(item.outfitKey) || [];
    g.push(item);
    groups.set(item.outfitKey, g);
  }
  const result = [];
  for (const [outfitKey, groupItems] of groups.entries()) {
    const src = groupItems[0]?.outputJob?.outputPath || null;
    const isLegacySingle = groupItems.length === 1 && !groupItems[0].slot;
    const badges = [];
    const itemKeys = [];
    for (const item of groupItems) {
      itemKeys.push(item.key);
      const p = run.products?.[item.key];
      const b = p?.badge;
      const dflt = item.defaultBadge || DEFAULT_BADGE;
      if (p?.code && exists(b?.file)) {
        badges.push({
          key: item.key,
          code: p.code,
          slot: item.slot,
          file: b.file,
          x: r3(b.x, dflt.x),
          y: r3(b.y, dflt.y),
          hash: b.hash || path.basename(b.file),
          frameWidth: b.frameWidth || null,
        });
      }
    }
    const wanted = !!(badges.length && exists(src));
    // Giữ nguyên định dạng sig cũ khi là run đơn giản 1 ảnh -> không làm các lần chạy cũ bị đánh dấu stale
    const sig = !wanted
      ? null
      : isLegacySingle
        ? JSON.stringify({ c: badges[0].code, x: badges[0].x, y: badges[0].y, h: badges[0].hash, src })
        : JSON.stringify({
            src,
            badges: badges.map((b) => ({ k: b.key, c: b.code, x: b.x, y: b.y, h: b.hash })),
          });
    const cur = run.codedOutputs?.[outfitKey]
      || groupItems.map((it) => run.products?.[it.key]?.coded).find((c) => c?.path)
      || null;
    const have = !!(cur?.path && exists(cur.path));
    result.push({
      key: outfitKey,
      outfitKey,
      itemKeys,
      codes: badges.map((b) => b.code),
      code: badges.map((b) => b.code).join(' · ') || null,
      badges,
      src,
      wanted,
      sig,
      dest: path.join(DIRS.outputs, `coded-${run.id}-${safeFilePart(outfitKey)}.png`),
      current: have ? cur : null,
      stale: wanted ? !(have && cur.sig === sig) : have,
    });
  }
  return result;
}
export const codedImagesStale = (run) => codedImagesOf(run).some((c) => c.stale);

// In / in lại / dọn ảnh có mã cho các Bộ stale. Trả về true nếu có gì đổi. (1 lệnh ffmpeg chồng toàn bộ mã của Bộ)
export async function ensureCodedImages(run) {
  let changed = false;
  run.codedOutputs ||= {};
  for (const c of codedImagesOf(run)) {
    if (!c.stale) continue;
    if (!c.wanted) {
      if (run.codedOutputs[c.outfitKey]?.path) rm(run.codedOutputs[c.outfitKey].path);
      delete run.codedOutputs[c.outfitKey];
      for (const k of c.itemKeys) {
        const entry = run.products?.[k];
        if (entry?.coded?.path) rm(entry.coded.path);
        if (entry) entry.coded = null;
      }
      changed = true;
      continue;
    }
    const { width } = await probe(c.src).catch(() => ({ width: 0 }));
    await overlayBadges({ src: c.src, badges: c.badges, dest: c.dest, width });
    const record = { path: c.dest, sig: c.sig, codes: c.codes, at: Date.now() };
    run.codedOutputs[c.outfitKey] = record;
    for (const k of c.itemKeys) {
      if (run.products?.[k]) run.products[k].coded = record;
    }
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
 * Lưu mã / tên / giá / mô tả / hoa hồng / khung mã cho từng mục + badgePrefs (style font, showSlotPrefix).
 * Cho phép dùng cùng 1 mã khi cùng 1 sản phẩm xuất hiện ở nhiều Bộ phối (Mix & Match), chỉ chặn trùng mã giữa 2 ảnh khác nhau.
 */
export function saveRunProducts(run, products, { badgePrefs = null } = {}) {
  if (!products || typeof products !== 'object' || Array.isArray(products)) throw new Error('Thiếu dữ liệu sản phẩm');
  if (!productInputsOf(run.workflow)) throw new Error('Quy trình này không có bảng Mã & sản phẩm');
  // Bước 1: kiểm tra & dựng toàn bộ dữ liệu mới trước, chưa ghi gì — một mục lỗi (mã trùng / PNG hỏng) thì không mục nào bị ghi dở
  const seenCodeOwner = new Map();
  const pending = [];
  for (const item of productItemsOf(run)) {
    const key = item.key;
    const p = products[key];
    if (!p || typeof p !== 'object') continue;
    const prev = run.products?.[key] || {};
    const raw = p.code == null ? '' : String(p.code).trim();
    const code = raw ? normalizeCode(raw) : null;
    if (raw && !isValidCode(code)) throw new Error(`Mã "${raw.slice(0, 40)}" không hợp lệ: cần dạng LOAI_SO, vd. VAY_01`);
    const assetOwner = item.assetId || key;
    if (code && seenCodeOwner.has(code) && seenCodeOwner.get(code) !== assetOwner) {
      throw new Error(`Mã ${code} đang được đặt cho 2 sản phẩm khác nhau — mỗi sản phẩm một mã`);
    }
    if (code) seenCodeOwner.set(code, assetOwner);
    if (code && item.assetId && codeOfAsset(item.assetId) !== code) {
      const owner = db.assets.find((a) => a.productCode === code && a.id !== item.assetId);
      if (owner) throw new Error(`Mã ${code} đã thuộc ảnh "${owner.name}"`);
    }

    const dflt = item.defaultBadge || DEFAULT_BADGE;
    const entry = {
      code: code || null,
      name: str(p.name, 200) || prev.name || null,
      price: p.price === undefined ? prev.price ?? null : int(p.price),
      description: p.description === undefined ? prev.description ?? null : plainDescription(p.description),
      commission: p.commission === undefined ? prev.commission ?? null : int(p.commission),
      affiliateUrl: p.affiliateUrl === undefined ? prev.affiliateUrl ?? null : (str(p.affiliateUrl, 2000) || ''),
      badge: { ...dflt, ...(prev.badge || {}) },
      coded: prev.coded || null,
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
      png = { buf, file: path.join(DIRS.assets, `badge-${run.id}-${safeFilePart(key)}.png`), frameWidth: int(b.frameWidth) || null, frameHeight: int(b.frameHeight) || null };
    }
    pending.push({ item, key, code, entry, png });
  }

  // Bước 2: ghi
  if (badgePrefs && typeof badgePrefs === 'object') {
    const style = VALID_BADGE_STYLES.includes(badgePrefs.style) ? badgePrefs.style : badgePrefsOf(run).style;
    run.badgePrefs = { style, showSlotPrefix: badgePrefs.showSlotPrefix !== false };
  }
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
      if (codeOfAsset(asset.id) !== code) assignCode(asset.id, code);
      asset.product = { ...(productMetaOf(asset) || {}), code };
    }
    if (asset && entry.commission != null && entry.commission !== productMetaOf(asset)?.commission) {
      asset.product = { ...(productMetaOf(asset) || {}), commission: entry.commission };
    }
    if (asset && entry.affiliateUrl !== null && entry.affiliateUrl !== undefined && entry.affiliateUrl !== (productMetaOf(asset)?.affiliateUrl || '')) {
      asset.product = { ...(productMetaOf(asset) || {}), affiliateUrl: entry.affiliateUrl };
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
 * Dựng workbook 6 cột (`PRODUCT_COLUMNS`). Cột "Ảnh": ảnh render nhúng trong ô (108×192) + link tới URL media;
 * cột "Link Shopee Aff": link Aff đi theo ảnh sản phẩm (clickable hyperlink nếu là URL http/https).
 */
export async function buildWorkbook(rows, { thumbnails = true, baseUrl = DEFAULT_BASE_URL } = {}) {
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

  const money = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.round(Number(v)) : null);
  const base = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const exportedSku = new Set();
  for (const r of rows) {
    // Mix & Match: cùng 1 sản phẩm phối ở nhiều Bộ -> Excel chỉ xuất 1 dòng cho sản phẩm đó
    if (r.code && r.assetId) {
      const skuKey = `${r.code}::${r.assetId}`;
      if (exportedSku.has(skuKey)) continue;
      exportedSku.add(skuKey);
    }
    const renderName = r.renderName || (r.renderPath ? path.basename(r.renderPath) : '');
    const affLink = str(r.affiliateUrl ?? r.shopeeUrl, 2000);
    const row = ws.addRow([r.code || '', money(r.price), r.description || '', renderName, money(r.commission), affLink]);
    row.height = ROW_HEIGHT_PT;
    row.alignment = { vertical: 'top', wrapText: true };
    for (const col of [2, 5]) {
      const c = row.getCell(col);
      c.numFmt = '#,##0';
      c.alignment = { vertical: 'top', horizontal: 'right' };
    }
    const imgCell = row.getCell(IMAGE_COL + 1);
    if (renderName && r.renderUrl) {
      imgCell.value = { text: renderName, hyperlink: `${base}${r.renderUrl}` };
      imgCell.font = { color: { argb: 'FF1F5BD6' }, underline: true, size: 9 };
    }
    // Ảnh nhúng nằm dưới dòng chữ tên file trong cùng ô
    imgCell.alignment = { vertical: 'top', horizontal: 'left', wrapText: true };
    const affCell = row.getCell(AFF_COL + 1);
    if (isHttp(affLink)) {
      affCell.value = { text: affLink, hyperlink: affLink };
      affCell.font = { color: { argb: 'FF1F5BD6' }, underline: true, size: 10 };
    }
    affCell.alignment = { vertical: 'top', horizontal: 'left', wrapText: true };
    if (thumbnails && r.renderPath) {
      const img = await thumbImage(r.renderPath);
      if (img) {
        const id = wb.addImage({ buffer: img.buffer, extension: img.extension });
        ws.addImage(id, { tl: { col: IMAGE_COL + 0.05, row: row.number - 1 + 0.08 }, ext: IMAGE_EXT, editAs: 'oneCell' });
      }
    }
  }
  return wb;
}

export function exportFilename(run, at = new Date()) {
  const ymd = `${at.getFullYear()}${String(at.getMonth() + 1).padStart(2, '0')}${String(at.getDate()).padStart(2, '0')}`;
  return `san-pham-${ymd}-${run.id}.xlsx`;
}
