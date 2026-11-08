// Kiểm thử "Mã sản phẩm trên ảnh kết quả & Excel cho DiamondShop" (quy trình Ảnh model mặc đồ) — không chạy ffmpeg thật,
// không đụng data/ thật. Chạy: node scripts/test-product-export.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Dữ liệu riêng cho test (db.js đọc DATA_DIR lúc import) -> phải đặt trước khi import server
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wv-product-export-'));
process.env.DATA_DIR = DATA_DIR;

const ExcelJS = (await import('exceljs')).default;
const { db } = await import('../server/db.js');
const {
  PRODUCT_COLUMNS,
  SHEET_NAME,
  DEFAULT_BADGE,
  buildProductRows,
  buildWorkbook,
  sanitizeCode,
  suggestProductCode,
  shopeeProductUrl,
  saveRunProducts,
  exportFilename,
  productInputsOf,
  productItemsOf,
  productMetaOf,
  sourceUrlOf,
  codedImagesOf,
  codedImagesStale,
} = await import('../server/productExport.js');
const { buildOverlayBadgeArgs } = await import('../server/ffmpeg.js');
const { normalizeProductMeta, plainDescription } = await import('../server/productScraper.js');
const { prefixFor, nextCode, assignCode, codeOfAsset } = await import('../server/productCodes.js');

const CONTRACT = [
  'Mã sản phẩm', 'Tên sản phẩm', 'Giá (đ)', 'Mô tả',
  'Ảnh 1', 'Ảnh 2', 'Ảnh 3', 'Ảnh 4', 'Ảnh 5', 'Ảnh 6',
  'Link Shopee', 'Danh mục', 'Hoa hồng Shopee (đ)', 'Ghi chú', 'Xem trước',
];
const png1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const assetOf = (id) => db.assets.find((a) => a.id === id);

async function main() {
  console.log('--- KIỂM THỬ MÃ SẢN PHẨM & EXCEL DIAMONDSHOP (ẢNH MODEL MẶC ĐỒ) ---\n');

  // 1. Hợp đồng cột
  console.log('▶ Test 1: Hợp đồng cột Excel');
  assert.deepEqual(PRODUCT_COLUMNS, CONTRACT);
  assert.equal(SHEET_NAME, 'San pham');
  console.log('  ✔ Đúng 15 cột, đúng thứ tự, sheet "San pham"');

  // 2. Mã dùng chung sổ mã productCodes.js (LOAI_SO)
  console.log('\n▶ Test 2: Gợi ý mã theo sổ mã chung (suggestProductCode / sanitizeCode)');
  assert.equal(prefixFor('Đầm hoa nhí dáng xoè'), 'VAY', '"Đầm" viết hoa chữ Đ vẫn ra VAY');
  assert.equal(prefixFor('đầm xoè'), 'VAY');
  assert.equal(prefixFor('Áo dài bách hoa'), 'AODAI');
  assert.equal(prefixFor('ao-thun-tu-may.png'), 'AO');
  assert.equal(prefixFor('***'), 'SP');
  assert.equal(suggestProductCode('Đầm hoa'), 'VAY_01');
  const taken = new Set();
  const c1 = suggestProductCode('Đầm hoa', { taken }); taken.add(c1);
  const c2 = suggestProductCode('Đầm xoè', { taken }); taken.add(c2);
  const c3 = suggestProductCode('Đầm dạ hội', { taken }); taken.add(c3);
  assert.deepEqual([c1, c2, c3], ['VAY_01', 'VAY_02', 'VAY_03'], 'cùng tiền tố trong 1 lần chạy phải tăng dần, không trùng');
  db.assets.push({ id: 'x5', kind: 'product', name: 'Váy cũ', path: 'x.png' });
  assignCode('x5', 'VAY_05');
  assert.equal(suggestProductCode('Đầm hoa'), 'VAY_06', 'sổ mã đã có VAY_05 thì gợi ý VAY_06');
  assert.equal(nextCode('VAY'), 'VAY_06');
  assert.equal(sanitizeCode('vay 7'), 'VAY_7', 'mã gõ tay được chuẩn hoá như video thời trang');
  assert.equal(sanitizeCode('AO-1'), null, 'mã kiểu cũ "AO-1" (bản trước) coi như chưa có mã');
  assert.equal(sanitizeCode(''), null);
  console.log('  ✔ Tiền tố theo tên (VAY/AODAI/AO/SP), số kế tiếp theo sổ mã, không trùng trong cùng lần chạy');

  // 3. Link chuẩn & metadata
  console.log('\n▶ Test 3: Link Shopee chuẩn & normalizeProductMeta');
  assert.equal(shopeeProductUrl('1908715934', '41434228389'), 'https://shopee.vn/product/1908715934/41434228389');
  assert.equal(shopeeProductUrl(null, '1'), null);
  assert.equal(shopeeProductUrl('abc', '1'), null);
  const meta = normalizeProductMeta({
    title: 'Đầm hoa nhí', rawTitle: '[HOT] Đầm hoa nhí', description: '<p>Chất <b>voan</b> mát</p><br>Form xoè&nbsp;nhẹ',
    features: ['Voan', ''], price: '259.000', url: 'https://shopee.vn/product-i.1.2', platform: 'shopee',
    rawId: { shopId: '1908715934', itemId: '41434228389' },
    images: [{ url: 'https://down-vn.img.susercontent.com/file/a' }, 'http://khong-https', 'https://down-vn.img.susercontent.com/file/b'],
  });
  assert.equal(meta.shopId, '1908715934');
  assert.equal(meta.itemId, '41434228389');
  assert.equal(meta.price, 259000);
  assert.equal(meta.description, 'Chất voan mát\nForm xoè nhẹ');
  assert.deepEqual(meta.images, ['https://down-vn.img.susercontent.com/file/a', 'https://down-vn.img.susercontent.com/file/b']);
  assert.equal(meta.code, null);
  assert.equal(normalizeProductMeta(null), null);
  assert.equal(plainDescription('x'.repeat(700)).length, 600);
  console.log('  ✔ Link https://shopee.vn/product/<shopId>/<itemId>; mô tả text thuần ≤ 600; chỉ ảnh https');

  // 4. Quy trình nào có bảng Mã & sản phẩm
  console.log('\n▶ Test 4: productInputsOf — chỉ quy trình có ô ảnh sản phẩm chọn nhiều');
  assert.equal(productInputsOf('anh-model').mode, 'input');
  assert.equal(productInputsOf('anh-model').primary.key, 'outfits');
  assert.equal(productInputsOf('thay-trang-phuc'), null, 'quy trình video: mã in qua prompt (productCodes.js), không dùng bảng này');
  assert.equal(productInputsOf('video-thoi-trang'), null);
  assert.equal(productInputsOf('dancing'), null);
  assert.equal(productInputsOf('khong-co'), null);
  console.log('  ✔ Chỉ Ảnh model mặc đồ có bảng; các quy trình video không bị ảnh hưởng');

  // 5. Metadata kế thừa qua chuỗi fromAssetId + buildProductRows
  console.log('\n▶ Test 5: productMetaOf / buildProductRows — mỗi ảnh trang phục 1 dòng, metadata kế thừa từ ảnh gốc');
  const img = path.join(DATA_DIR, 'assets', 'outfit.png');
  fs.writeFileSync(img, Buffer.from(png1x1.split(',')[1], 'base64'));
  // ảnh gốc bóc link (nháp) -> ảnh làm sạch bằng Flow (không có product, chỉ fromAssetId) -> làm sạch lần 2 (có giá riêng)
  const metaVay = { ...meta, title: 'Váy xanh', code: null, price: 199000, shopId: '111', itemId: '222', images: ['https://down-vn.img.susercontent.com/file/vay', 'https://down-vn.img.susercontent.com/file/vay2'] };
  db.assets.push({ id: 'o1', kind: 'product', name: 'Váy xanh – ảnh 1', path: img, source: 'https://down-vn.img.susercontent.com/file/vay', staging: true, product: metaVay });
  db.assets.push({ id: 'o1c', kind: 'product', name: 'Váy xanh – ảnh 1 (Flow)', path: img, fromAssetId: 'o1', fromJobId: 'jx' });
  db.assets.push({ id: 'o1cc', kind: 'product', name: 'Váy xanh – ảnh 1 (Flow) #2', path: img, fromAssetId: 'o1c', product: { price: 189000 } });
  db.assets.push({ id: 'o2', kind: 'product', name: 'ao-thun-tu-may.png', path: img }); // tải từ máy, không metadata
  db.assets.push({ id: 'o3', kind: 'product', name: 'Áo khoác dạ – ảnh 1', path: img, source: 'https://down-vn.img.susercontent.com/file/c', product: { ...meta, title: 'Áo khoác dạ', shopId: null, itemId: null, url: 'https://shopee.vn/x' } });
  db.assets.push({ id: 'm1', kind: 'model', name: 'Model Lan.png', path: img });
  assert.equal(productMetaOf(assetOf('o1c')).title, 'Váy xanh', 'ảnh làm sạch kế thừa metadata của ảnh gốc');
  assert.equal(productMetaOf(assetOf('o1cc')).price, 189000, 'giá riêng của ảnh gần hơn thắng');
  assert.equal(productMetaOf(assetOf('o1cc')).shopId, '111', 'thiếu gì thì lấy từ ảnh gốc');
  assert.equal(sourceUrlOf(assetOf('o1cc')), 'https://down-vn.img.susercontent.com/file/vay', 'URL ảnh gốc lấy theo chuỗi fromAssetId');
  assert.equal(productMetaOf(assetOf('o2')), null);
  const out = path.join(DATA_DIR, 'outputs', 'image-r1.png');
  fs.writeFileSync(out, Buffer.from(png1x1.split(',')[1], 'base64'));
  db.jobs.push({ id: 'jr0', type: 'image', status: 'done', outputPath: out, thumbPath: out, meta: { outfitId: 'o1cc', kind: 'lookbook' }, attempts: [] });
  const run = {
    id: 'run2', workflow: 'anh-model', sourceId: null, clipIds: [],
    inputs: { model: 'm1', outfits: ['o1cc', 'o2', 'o1cc', 'o3'], background: null }, clipInputs: {}, options: {},
    stages: { _jobs: { 'render:0:o1cc': 'jr0' } }, status: 'done',
  };
  db.runs.push(run);
  const items = productItemsOf(run);
  assert.deepEqual(items.map((i) => i.key), ['o1cc', 'o2', 'o3'], 'cùng 1 ảnh chọn 2 lần = 1 mục; key = id ảnh trang phục');
  assert.equal(items[0].outputJob?.id, 'jr0', 'mục có ảnh model đã render');
  assert.equal(items[1].outputJob, null);
  let rows = buildProductRows(run);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].name, 'Váy xanh');
  assert.equal(rows[0].price, 189000);
  assert.equal(rows[0].shopeeUrl, 'https://shopee.vn/product/111/222');
  assert.equal(rows[0].linkOk, true);
  assert.deepEqual(rows[0].images, ['https://down-vn.img.susercontent.com/file/vay', 'https://down-vn.img.susercontent.com/file/vay2']);
  assert.equal(rows[0].hasMeta, true);
  assert.equal(rows[0].thumbPath, out, 'thumbnail Excel = ảnh model đã render');
  assert.ok(rows[0].outputUrl && rows[0].frameUrl, 'ảnh render dùng để xem trước khung mã');
  assert.equal(rows[0].codedUrl, null);
  assert.equal(rows[0].note, 'Ảnh model mặc đồ – Model Lan – Bộ 1');
  assert.equal(rows[0].code, 'VAY_06', 'chưa có mã -> gợi ý theo sổ mã (VAY_05 đã dùng)');
  assert.equal(rows[0].codeSaved, false);
  assert.deepEqual({ x: rows[0].badge.x, y: rows[0].badge.y, scale: rows[0].badge.scale }, DEFAULT_BADGE);
  assert.equal(rows[1].name, 'ao-thun-tu-may', 'ảnh tải từ máy -> tên ảnh');
  assert.equal(rows[1].hasMeta, false);
  assert.equal(rows[1].thumbPath, img, 'chưa render -> thumbnail = ảnh trang phục');
  assert.equal(rows[1].outputUrl, null);
  assert.equal(rows[1].code, 'AO_01');
  assert.equal(rows[1].shopeeUrl, null);
  assert.equal(rows[1].linkOk, false);
  assert.equal(rows[2].code, 'AO_02', 'cùng tiền tố AO trong 1 lần chạy -> số kế tiếp');
  assert.equal(rows[2].linkOk, false, 'thiếu shopId/itemId -> cảnh báo');
  assert.equal(rows[2].shopeeUrl, 'https://shopee.vn/x');
  // Mã kế thừa theo chuỗi ảnh gốc: ảnh gốc o1 đã có mã trong sổ -> dòng của o1cc dùng lại mã đó
  assignCode('o1', 'VAY_09');
  assert.equal(codeOfAsset('o1cc'), 'VAY_09');
  rows = buildProductRows(run);
  assert.equal(rows[0].code, 'VAY_09', 'mã của ảnh gốc (sổ mã) được dùng lại cho ảnh làm sạch');
  assert.equal(rows[0].codeSaved, true);
  assert.deepEqual(codedImagesOf(run).map((c) => c.wanted), [false, false, false], 'chưa lưu mã -> chưa in');
  assert.equal(codedImagesStale(run), false);
  console.log('  ✔ 3 dòng theo ảnh trang phục, metadata + mã kế thừa qua chuỗi fromAssetId, gợi ý không trùng');

  // 6. saveRunProducts: lưu theo id ảnh, cấp mã trong sổ chung, PNG khung mã, ghi ngược metadata, chữ ký in mã
  console.log('\n▶ Test 6: saveRunProducts + sổ mã chung + chữ ký in mã lên ảnh');
  assert.throws(() => saveRunProducts(run, { o1cc: { code: 'VAY_09', name: 'a' }, o2: { code: 'VAY_09', name: 'b' } }), /2 ảnh/);
  assert.throws(() => saveRunProducts(run, { o2: { code: 'khongcoso' } }), /LOAI_SO/, 'thiếu phần số sau "_" -> sai dạng');
  assert.throws(() => saveRunProducts(run, { o2: { code: 'AO-1' } }), /LOAI_SO/, 'mã kiểu cũ "AO-1" bị từ chối');
  assert.throws(() => saveRunProducts(run, { o2: { code: 'VAY_05' } }), /đã thuộc ảnh "Váy cũ"/, 'mã của ảnh khác thì từ chối');
  assert.equal(run.products, undefined, 'có lỗi thì không ghi dở mục nào');
  rows = saveRunProducts(run, {
    o1cc: { code: 'VAY_09', badge: { x: 0.3, y: 0.2, scale: 1, png: png1x1, frameWidth: 720 } },
    o2: { code: 'ao 2', name: 'Áo thun', price: '99.000', description: 'Mô tả mới', badge: { x: 0.5, y: 0.12, scale: 1, png: png1x1, frameWidth: 720 } },
    o3: { code: '', name: 'Áo khoác dạ' }, // không mã -> không in
  });
  assert.equal(rows[0].code, 'VAY_09');
  assert.equal(assetOf('o1cc').productCode, undefined, 'mã đang kế thừa từ ảnh gốc -> không ghi lại lên ảnh con');
  assert.equal(assetOf('o1cc').product.code, 'VAY_09', 'ghi ngược mã vào metadata ảnh trang phục');
  assert.equal(assetOf('o1cc').product.title, 'Váy xanh', 'ghi ngược kèm metadata kế thừa (ảnh tự mang đủ tên / giá / link)');
  assert.equal(assetOf('o1cc').product.price, 189000);
  assert.equal(assetOf('o1').productCode, 'VAY_09', 'ảnh gốc giữ mã');
  assert.equal(rows[1].code, 'AO_2', 'mã gõ tay được chuẩn hoá');
  assert.equal(rows[1].name, 'Áo thun');
  assert.equal(rows[1].price, 99000);
  assert.equal(rows[1].description, 'Mô tả mới');
  assert.equal(assetOf('o2').productCode, 'AO_2', 'cấp mã cho ảnh trang phục trong sổ mã chung (assignCode)');
  assert.ok(db.codes.some((c) => c.code === 'AO_2' && c.assetId === 'o2'), 'sổ mã có AO_2');
  assert.equal(rows[2].code, 'AO_03', 'không mã -> vẫn gợi ý (số kế tiếp sau AO_2 vừa cấp) nhưng không in');
  assert.equal(rows[2].codeSaved, false);
  assert.ok(fs.existsSync(path.join(DATA_DIR, 'assets', 'badge-run2-o1cc.png')), 'PNG khung mã theo id ảnh');
  assert.equal(rows[0].badge.x, 0.3);
  let ci = codedImagesOf(run);
  assert.equal(ci[0].wanted, true);
  assert.equal(ci[0].stale, true, 'có mã + PNG + ảnh render nhưng chưa in -> phải in');
  assert.equal(ci[0].dest, path.join(DATA_DIR, 'outputs', 'coded-run2-o1cc.png'));
  assert.equal(ci[1].wanted, false, 'chưa render -> chưa in được');
  assert.equal(ci[1].stale, false);
  assert.equal(codedImagesStale(run), true);
  // Giả lập đã in (ghi coded với chữ ký hiện tại) -> không stale; đổi vị trí -> in lại; về y hệt -> không in thừa; bỏ mã -> dọn
  run.products.o1cc.coded = { path: out, sig: ci[0].sig, at: 1 };
  assert.equal(codedImagesStale(run), false);
  assert.equal(buildProductRows(run)[0].codedUrl, '/media/outputs/image-r1.png');
  saveRunProducts(run, { o1cc: { code: 'VAY_09', badge: { x: 0.6, y: 0.2 } } });
  ci = codedImagesOf(run);
  assert.equal(ci[0].stale, true, 'đổi vị trí -> chữ ký đổi -> in lại');
  assert.equal(buildProductRows(run)[0].codedStale, true);
  saveRunProducts(run, { o1cc: { code: 'VAY_09', badge: { x: 0.3, y: 0.2 } } });
  assert.equal(codedImagesStale(run), false, 'về lại y hệt -> không in thừa');
  saveRunProducts(run, { o1cc: { code: '' } });
  ci = codedImagesOf(run);
  assert.equal(ci[0].wanted, false);
  assert.equal(ci[0].stale, true, 'bỏ mã mà còn ảnh có mã cũ -> stale để dọn');
  assert.equal(run.products.o2.description, 'Mô tả mới', 'không gửi mô tả thì giữ bản trước');
  saveRunProducts(run, { o2: { code: 'AO_2', description: '' } });
  assert.equal(buildProductRows(run)[1].description, '', 'gửi "" = cố ý để trống');
  assert.match(exportFilename(run, new Date(2026, 10, 7)), /^san-pham-20261107-run2\.xlsx$/);
  console.log('  ✔ Lưu theo id ảnh, mã vào sổ chung, PNG ra data/assets, chữ ký in mã chỉ đổi khi mã/vị trí/PNG/ảnh render đổi');

  // 7. buildOverlayBadgeArgs: đè PNG khung mã lên ảnh kết quả (scale khi PNG vẽ cho khung khác cỡ)
  console.log('\n▶ Test 7: buildOverlayBadgeArgs (in mã lên ảnh)');
  const oa = buildOverlayBadgeArgs({ src: 'in.png', badge: 'b.png', dest: 'out.png', x: 0.3, y: 0.2, frameWidth: 720, width: 1440 });
  assert.deepEqual(oa.slice(0, 5), ['-y', '-i', 'in.png', '-i', 'b.png']);
  assert.equal(oa[oa.indexOf('-filter_complex') + 1], '[1:v]format=rgba,scale=trunc(iw*1440/720/2)*2:-2[b];[0:v][b]overlay=x=W*0.3-overlay_w/2:y=H*0.2-overlay_h/2:format=auto[v]');
  assert.equal(oa.at(-1), 'out.png');
  const ob = buildOverlayBadgeArgs({ src: 'in.png', badge: 'b.png', dest: 'out.png', frameWidth: 720, width: 720 });
  assert.equal(ob[ob.indexOf('-filter_complex') + 1], '[1:v]format=rgba[b];[0:v][b]overlay=x=W*0.5-overlay_w/2:y=H*0.12-overlay_h/2:format=auto[v]', 'cùng cỡ -> không scale, vị trí mặc định');
  console.log('  ✔ Overlay theo tỷ lệ tâm khung, scale PNG khi ảnh khác bề rộng khung đã vẽ');

  // 8. Workbook: dựng -> đọc lại bằng exceljs
  console.log('\n▶ Test 8: buildWorkbook -> đọc lại bằng exceljs');
  const sample = [
    { code: 'VAY_11', name: 'Đầm hoa nhí dáng xoè', price: 259000, description: 'Chất voan mát', images: ['https://down-vn.img.susercontent.com/file/a', 'https://down-vn.img.susercontent.com/file/b'], shopeeUrl: 'https://shopee.vn/product/1908715934/41434228389', category: 'Thời trang nữ', note: 'Ảnh model mặc đồ – Lan – Bộ 1', thumbPath: null },
    { code: 'AO_07', name: 'Áo thun', price: '199000', description: '', images: [], shopeeUrl: null, category: '', note: 'Ảnh model mặc đồ – Lan – Bộ 2', thumbPath: null },
  ];
  const wb = await buildWorkbook(sample, { thumbnails: false });
  const buf = await wb.xlsx.writeBuffer();
  const wb2 = new ExcelJS.Workbook();
  await wb2.xlsx.load(buf);
  const ws = wb2.getWorksheet('San pham');
  assert.ok(ws, 'phải có sheet "San pham"');
  const headers = ws.getRow(1).values.slice(1);
  assert.deepEqual(headers, CONTRACT, 'dòng 1 = tiêu đề đúng hợp đồng');
  assert.equal(ws.getRow(1).getCell(1).font?.bold, true, 'tiêu đề in đậm');
  const r2 = ws.getRow(2);
  assert.equal(r2.getCell(1).value, 'VAY_11');
  assert.equal(r2.getCell(2).value, 'Đầm hoa nhí dáng xoè');
  assert.equal(typeof r2.getCell(3).value, 'number', 'giá là số');
  assert.equal(r2.getCell(3).value, 259000);
  assert.equal(r2.getCell(4).value, 'Chất voan mát');
  const cellText = (c) => (c.value && typeof c.value === 'object' && 'text' in c.value ? c.value.text : c.value);
  assert.equal(cellText(r2.getCell(5)), 'https://down-vn.img.susercontent.com/file/a');
  assert.equal(cellText(r2.getCell(6)), 'https://down-vn.img.susercontent.com/file/b');
  assert.equal(r2.getCell(7).value ?? '', '', 'Ảnh 3 trống');
  assert.match(cellText(r2.getCell(11)), /^https:\/\/shopee\.vn\/product\/\d+\/\d+$/, 'link chuẩn');
  assert.equal(r2.getCell(12).value, 'Thời trang nữ');
  assert.equal(r2.getCell(13).value ?? null, null, 'Hoa hồng Shopee để trống');
  assert.equal(r2.getCell(14).value, 'Ảnh model mặc đồ – Lan – Bộ 1');
  assert.equal(ws.getRow(3).getCell(3).value, 199000, 'giá dạng chuỗi vẫn ra số');
  assert.ok(ws.getRow(2).height >= 60, 'dòng cao để nhúng thumbnail');
  const pngFile = path.join(DATA_DIR, 'assets', 'thumb.png');
  fs.writeFileSync(pngFile, Buffer.from(png1x1.split(',')[1], 'base64'));
  const wb3 = await buildWorkbook([{ ...sample[0], thumbPath: pngFile }]);
  assert.equal(wb3.getWorksheet('San pham').getImages().length, 1, 'thumbnail được nhúng từ file local');
  console.log('  ✔ Tiêu đề đúng hợp đồng, giá là số, link chuẩn, hoa hồng trống, thumbnail nhúng');

  // db.js ghi file sau 100ms (debounce) -> chờ ghi xong rồi mới dọn thư mục tạm
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  console.log('\n🎉 TẤT CẢ 8 BÀI TEST ĐÃ VƯỢT QUA!');
}

main().catch((err) => {
  console.error('\n❌ TEST THẤT BẠI:', err);
  process.exit(1);
});
