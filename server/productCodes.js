// Mã sản phẩm in lên video thời trang (thay chữ "TODAY'S OUTFIT"): dạng LOAI_SO, không dấu, in hoa (vd. VAY_01, AODAI_03).
// - Mỗi ảnh sản phẩm mặt trước có đúng 1 mã (ghi ở asset.productCode); ảnh làm sạch / cắt / sao chép / mặt sau sinh từ
//   ảnh đó (chuỗi fromAssetId) dùng lại mã của ảnh gốc. Ảnh mới -> cấp mã mới = số lớn nhất của tiền tố + 1.
// - db.codes là sổ mã đã dùng (cấp tự động, sửa tay, hoặc nhập từ file .txt của máy khác) để số mới không trùng.
import { db, save } from './db.js';

// LOAI_SO; cho phép nhiều đoạn (AO_SO_MI_09): tiền tố = phần trước dấu _ cuối, số = đoạn cuối
const CODE_RE = /^[A-Z0-9]+(?:_[A-Z0-9-]+)+$/;

// Bỏ dấu tiếng Việt, in hoa, chỉ giữ A-Z 0-9 _ -
export function normalizeCode(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toUpperCase()
    .replace(/[\s.]+/g, '_')
    .replace(/[^A-Z0-9_-]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}
export const isValidCode = (c) => CODE_RE.test(c || '');

// Tiền tố theo tên sản phẩm (tên ảnh trong thư viện / tiêu đề bóc tách)
export function prefixFor(name) {
  const n = String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();
  if (/\bao dai\b/.test(n)) return 'AODAI';
  if (/\bchan vay\b/.test(n)) return 'CHANVAY';
  if (/\bjumpsuit\b/.test(n)) return 'JUMPSUIT';
  if (/\b(vay|dam)\b/.test(n)) return 'VAY';
  if (/\b(set|bo)\b/.test(n)) return 'SET';
  if (/\bao\b/.test(n)) return 'AO';
  if (/\bquan\b/.test(n)) return 'QUAN';
  return 'SP';
}

const allCodes = () => {
  const s = new Set(db.codes.map((c) => c.code));
  for (const a of db.assets) if (a.productCode) s.add(a.productCode);
  return s;
};

// Số tiếp theo của 1 tiền tố: lớn nhất hiện có + 1, tối thiểu 2 chữ số
export function nextCode(prefix) {
  let max = 0;
  for (const c of allCodes()) {
    const m = c.match(/^(.+)_(\d+)$/);
    if (m && m[1] === prefix) max = Math.max(max, Number(m[2]));
  }
  return `${prefix}_${String(max + 1).padStart(2, '0')}`;
}

// Mã của ảnh: của chính nó, hoặc của ảnh gốc theo chuỗi fromAssetId (ảnh sạch / cắt / sao chép / mặt sau)
export function codeOfAsset(assetId) {
  const seen = new Set();
  let a = db.assets.find((x) => x.id === assetId);
  while (a && !seen.has(a.id)) {
    if (a.productCode) return a.productCode;
    seen.add(a.id);
    a = a.fromAssetId ? db.assets.find((x) => x.id === a.fromAssetId) : null;
  }
  return null;
}

const ownerOf = (code) => db.assets.find((a) => a.productCode === code);

// Cấp mã cho ảnh (dùng lại mã trong chuỗi nếu có), hoặc đổi sang mã người dùng gõ
export function assignCode(assetId, code) {
  const a = db.assets.find((x) => x.id === assetId);
  if (!a) throw new Error('Không tìm thấy ảnh');
  const wanted = code != null && String(code).trim() ? normalizeCode(code) : null;
  if (wanted) {
    if (!isValidCode(wanted)) throw new Error(`Mã "${wanted}" không hợp lệ: cần dạng LOAI_SO, vd. VAY_01`);
    const other = ownerOf(wanted);
    if (other && other.id !== a.id) throw new Error(`Mã ${wanted} đã thuộc ảnh "${other.name}"`);
    const old = a.productCode;
    a.productCode = wanted;
    const rec = old && db.codes.find((c) => c.code === old && c.assetId === a.id);
    if (rec) { rec.code = wanted; rec.source = 'manual'; rec.updatedAt = Date.now(); }
    else if (!db.codes.some((c) => c.code === wanted)) db.codes.push({ code: wanted, assetId: a.id, source: 'manual', createdAt: Date.now() });
    else { const r = db.codes.find((c) => c.code === wanted); if (!r.assetId) r.assetId = a.id; }
    save();
    return a;
  }
  const inherited = codeOfAsset(a.id);
  if (inherited) {
    if (a.productCode !== inherited) { a.productCode = inherited; save(); }
    return a;
  }
  const fresh = nextCode(prefixFor(a.name));
  a.productCode = fresh;
  db.codes.push({ code: fresh, assetId: a.id, source: 'auto', createdAt: Date.now() });
  save();
  return a;
}

// Mọi mã đã dùng, cách nhau dấu "," (để xuất file .txt cho máy khác nhập)
export function exportText() {
  return [...allCodes()].sort(compareCodes).join(',');
}
function compareCodes(x, y) {
  const mx = x.match(/^(.*)_(\d+)$/), my = y.match(/^(.*)_(\d+)$/);
  if (mx && my && mx[1] === my[1]) return Number(mx[2]) - Number(my[2]);
  return x.localeCompare(y);
}

// Nhập mã từ file .txt (cách nhau "," / xuống dòng / khoảng trắng); mã đã có thì bỏ qua
export function importText(text) {
  const have = allCodes();
  let added = 0, skipped = 0, invalid = [];
  for (const raw of String(text || '').split(/[,\n\r;\t ]+/)) {
    if (!raw.trim()) continue;
    const c = normalizeCode(raw);
    if (!isValidCode(c)) { invalid.push(raw.trim()); continue; }
    if (have.has(c)) { skipped++; continue; }
    have.add(c);
    db.codes.push({ code: c, assetId: null, source: 'import', createdAt: Date.now() });
    added++;
  }
  if (added) save();
  return { added, skipped, invalid, total: have.size };
}

export const listCodes = () => ({
  codes: db.codes.map((c) => ({ ...c, assetName: c.assetId ? db.assets.find((a) => a.id === c.assetId)?.name || null : null })),
  text: exportText(),
});
