// Kiểm thử đầu-cuối "Ảnh model mặc đồ → Mã & sản phẩm → Excel cho DiamondShop" trên server thật với engine giả (mock),
// dữ liệu riêng trong thư mục tạm (không đụng data/ thật), không cần mạng / Flow:
//   nhập ảnh trang phục kèm metadata Shopee (như sau khi bóc link) → "làm mới ảnh" (làm sạch bằng Flow, engine giả) vẫn giữ
//   metadata → chạy quy trình → bảng sản phẩm có sẵn tên / giá / link → lưu mã (sổ mã chung VAY_01…) → bước "In mã lên ảnh"
//   (ffmpeg) → đổi vị trí in lại, bỏ mã thì dọn → Excel đúng hợp đồng → DiamondShop đọc được (parseProductRows, nếu repo nằm cạnh).
// Chạy: node scripts/test-anh-model-products.mjs
//   DIAMONDSHOP_DIR=<thư mục repo DiamondShop> (mặc định ../web-site-aff) · TEST_PORT=<cổng> (mặc định 3188)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import ffmpegPath from 'ffmpeg-static';
import ExcelJS from 'exceljs';
import { probe } from '../server/ffmpeg.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.TEST_PORT || 3188);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wv-anh-model-'));
const DIAMONDSHOP_DIR = process.env.DIAMONDSHOP_DIR || path.resolve(ROOT, '..', 'web-site-aff');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (bin, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true, ...opts });
    let out = '';
    let err = '';
    p.stdout?.on('data', (d) => (out += d));
    p.stderr?.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err.split('\n').slice(-6).join('\n') || `exit ${code}`))));
  });
const makePng = (file, size, color, rgba = false) =>
  run(ffmpegPath, ['-y', '-f', 'lavfi', '-i', `color=c=${color}:s=${size}`, ...(rgba ? ['-vf', 'format=rgba'] : []), '-frames:v', '1', file]);

async function api(method, url, body) {
  const isForm = body instanceof FormData;
  const res = await fetch(BASE + url, {
    method,
    headers: body && !isForm ? { 'content-type': 'application/json' } : undefined,
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
  if (!res.ok) throw new Error(`${method} ${url} -> HTTP ${res.status} ${data?.error || ''}`);
  return data;
}
const state = () => api('GET', '/api/state');
const runOf = async (id) => (await state()).runs.find((r) => r.id === id);
async function waitFor(fn, { timeout = 90_000, every = 500, what = 'điều kiện' } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`Hết ${timeout / 1000}s chờ ${what}`);
    await sleep(every);
  }
}
// Lần chạy xong (ném lỗi nếu lần chạy dừng vì lỗi); extra(r) = điều kiện thêm
const waitRun = (id, what, extra = () => true) =>
  waitFor(async () => {
    const r = await runOf(id);
    if (r.status === 'failed') throw new Error(`Lần chạy lỗi ở bước ${r.stage}: ${r.error}`);
    return r.status === 'done' && extra(r) ? r : null;
  }, { what });
async function upload(kind, file) {
  const fd = new FormData();
  fd.append('kind', kind);
  fd.append('file', new Blob([fs.readFileSync(file)], { type: 'image/png' }), path.basename(file));
  return api('POST', '/api/assets', fd);
}
const localPath = (mediaUrl) => path.join(DATA_DIR, ...mediaUrl.replace(/^\/media\//, '').split('/'));

let server = null;
let stopping = false;
let serverLog = '';
async function startServer() {
  server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: { ...process.env, DATA_DIR, PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  server.stdout.on('data', (d) => (serverLog += d));
  server.stderr.on('data', (d) => (serverLog += d));
  server.on('exit', (code) => { if (!stopping) console.error('Server thoát sớm, mã', code, '\n', serverLog); });
  await waitFor(async () => { try { await state(); return true; } catch { return false; } }, { timeout: 30_000, every: 300, what: 'server khởi động' });
}
function stopServer() {
  stopping = true;
  if (server && !server.killed) server.kill();
}

// DiamondShop đọc ma trận ô bằng parseProductRows (chạy bằng tsx của repo đó). null = không có repo bên cạnh -> bỏ qua.
async function parseWithDiamondShop(matrix) {
  const tsx = path.join(DIAMONDSHOP_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const lib = path.join(DIAMONDSHOP_DIR, 'src', 'lib', 'productImport.ts');
  if (!fs.existsSync(tsx) || !fs.existsSync(lib)) return null;
  const matrixFile = path.join(DATA_DIR, 'tmp', 'matrix.json');
  fs.writeFileSync(matrixFile, JSON.stringify(matrix));
  const helper = path.join(DATA_DIR, 'tmp', 'diamondshop-parse.mts');
  fs.writeFileSync(
    helper,
    `import fs from 'node:fs';\nimport { parseProductRows } from ${JSON.stringify(pathToFileURL(lib).href)};\n` +
      `const m = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));\nconsole.log('@@' + JSON.stringify(parseProductRows(m, { existingCodes: [] })));\n`,
  );
  const out = await run(process.execPath, [tsx, helper, matrixFile], { cwd: DIAMONDSHOP_DIR });
  const line = out.split('\n').map((l) => l.trim()).find((l) => l.startsWith('@@'));
  return JSON.parse(line.slice(2));
}

async function main() {
  console.log('--- KIỂM THỬ ĐẦU-CUỐI: ẢNH MODEL MẶC ĐỒ → MÃ & SẢN PHẨM → EXCEL DIAMONDSHOP ---');
  console.log(`Dữ liệu tạm: ${DATA_DIR} · server ${BASE}\n`);

  console.log('▶ 1. Khởi động server với engine giả + ảnh mẫu');
  await startServer();
  await api('PUT', '/api/settings', { engine: 'mock' });
  const fx = path.join(DATA_DIR, 'tmp');
  await makePng(path.join(fx, 'model.png'), '720x1280', 'gray');
  await makePng(path.join(fx, 'bg.png'), '720x1280', 'blue');
  await makePng(path.join(fx, 'outfit-src.png'), '600x800', 'red');
  await makePng(path.join(fx, 'outfit2.png'), '600x800', 'green');
  await makePng(path.join(fx, 'badge.png'), '240x72', 'black@0.55', true);
  const model = await upload('model', path.join(fx, 'model.png'));
  const bg = await upload('background', path.join(fx, 'bg.png'));
  const outfit2 = await upload('product', path.join(fx, 'outfit2.png')); // ảnh tải từ máy: không có metadata
  console.log('  ✔ server chạy, engine giả, 3 ảnh đã tải lên');

  console.log('\n▶ 2. Nhập ảnh trang phục từ link Shopee (giả lập kết quả bóc tách) kèm tên / giá / link');
  const found = {
    title: 'Đầm hoa nhí dáng xoè', rawTitle: '[HOT] Đầm hoa nhí dáng xoè', description: '<p>Chất <b>voan</b> mát</p><br>Form xoè nhẹ',
    features: ['Voan'], price: '259.000', url: 'https://shopee.vn/product-i.1908715934.41434228389', platform: 'shopee',
    shopId: '1908715934', itemId: '41434228389',
    images: ['https://down-vn.img.susercontent.com/file/test-a', 'https://down-vn.img.susercontent.com/file/test-b'],
  };
  // ảnh gốc được tải từ URL http của chính server (thay cho CDN Shopee); đây là bước ExtractPopup.ensureAsset (ảnh nháp)
  const [src] = await api('POST', '/api/product/import', {
    kind: 'product', staging: true, product: found,
    images: [{ url: `${BASE}/media/tmp/outfit-src.png`, name: 'Đầm hoa nhí dáng xoè – ảnh 1' }],
  });
  assert.equal(src.staging, true);
  assert.equal(src.product.title, 'Đầm hoa nhí dáng xoè');
  assert.equal(src.product.price, 259000);
  assert.equal(src.product.itemId, '41434228389');
  console.log('  ✔ asset.product có tên, giá 259.000đ, shopId/itemId');

  console.log('\n▶ 3. Làm mới ảnh (✨ Làm sạch bằng Flow, engine giả): ảnh mới phải giữ metadata rồi bấm Dùng');
  await api('POST', `/api/assets/${src.id}/clean`, { prompt: 'Clean product photo, keep only the garment' });
  const cleaned = await waitFor(async () => (await state()).assets.find((a) => a.fromAssetId === src.id), { what: 'ảnh làm sạch' });
  assert.equal(cleaned.staging, true, 'kết quả làm sạch là ảnh nháp cho tới khi bấm Dùng');
  assert.equal(cleaned.product?.title, 'Đầm hoa nhí dáng xoè', 'ảnh làm sạch kế thừa asset.product');
  assert.equal(cleaned.product?.price, 259000);
  assert.equal(cleaned.product?.shopId, '1908715934');
  await api('POST', `/api/assets/${cleaned.id}/use`);
  console.log('  ✔ ảnh làm sạch mang theo tên / giá / shopId / itemId');

  console.log('\n▶ 4. Chạy Ảnh model mặc đồ: 2 trang phục (1 từ Shopee đã làm mới, 1 tải từ máy)');
  const run0 = await api('POST', '/api/runs', {
    workflowId: 'anh-model',
    inputs: { model: model.id, outfits: [cleaned.id, outfit2.id], background: bg.id },
    options: { cleanBackground: false, saveAsModel: false },
  });
  assert.equal(run0.hasProductInputs, true);
  assert.equal(run0.productMode, 'input');
  assert.equal(run0.productItemCount, 2);
  assert.ok(run0.stageList.some((s) => s.id === 'badge'), 'có bước "In mã lên ảnh"');
  const run1 = await waitRun(run0.id, 'render xong');
  assert.equal(run1.outputs.length, 2);
  assert.ok(run1.outputs.every((o) => o.status === 'done' && o.outputUrl));
  assert.equal(run1.stageList.find((s) => s.id === 'badge').status, 'skipped', 'chưa có mã -> bước in mã bỏ qua');
  assert.deepEqual(run1.outputs.map((o) => o.outfitId), [cleaned.id, outfit2.id]);
  const lookbook = (await state()).assets.find((a) => a.id === run1.outputs[0].assetId);
  assert.equal(lookbook.kind, 'lookbook');
  assert.equal(lookbook.outfitId, cleaned.id);
  assert.equal(lookbook.product?.title, 'Đầm hoa nhí dáng xoè', 'ảnh kết quả mang theo metadata của trang phục');
  console.log('  ✔ 2 ảnh kết quả, ảnh lookbook kế thừa metadata, bước In mã bỏ qua khi chưa có mã');

  console.log('\n▶ 5. Bảng Mã & sản phẩm: tên / giá / link Shopee có sẵn, mã gợi ý theo sổ mã chung');
  const pr = await api('GET', `/api/runs/${run0.id}/products`);
  assert.equal(pr.mode, 'input');
  assert.equal(pr.rows.length, 2);
  assert.deepEqual({ w: pr.frame.width, h: pr.frame.height, probed: pr.frame.probed }, { w: 720, h: 1280, probed: true }, 'khung = kích thước ảnh render');
  const [r0, r1] = pr.rows;
  assert.equal(r0.key, cleaned.id);
  assert.equal(r0.name, 'Đầm hoa nhí dáng xoè');
  assert.equal(r0.price, 259000);
  assert.equal(r0.description, 'Chất voan mát\nForm xoè nhẹ');
  assert.equal(r0.shopeeUrl, 'https://shopee.vn/product/1908715934/41434228389');
  assert.equal(r0.linkOk, true);
  assert.deepEqual(r0.images, found.images, 'ảnh Excel = URL CDN Shopee lúc bóc tách');
  assert.equal(r0.hasMeta, true);
  assert.equal(r0.code, 'VAY_01', 'gợi ý theo tên "Đầm…" -> VAY_01 (sổ mã trống)');
  assert.equal(r0.codeSaved, false);
  assert.ok(r0.outputUrl && r0.frameUrl, 'có ảnh render để xem trước khung mã');
  assert.equal(r0.codedUrl, null);
  assert.equal(r0.note, 'Ảnh model mặc đồ – model – Bộ 1');
  assert.equal(r1.key, outfit2.id);
  assert.equal(r1.name, 'outfit2');
  assert.equal(r1.hasMeta, false);
  assert.equal(r1.price, null);
  assert.equal(r1.shopeeUrl, null);
  assert.deepEqual(r1.images, []);
  assert.equal(r1.code, 'SP_01');
  const sug = await api('GET', `/api/products/suggest-code?title=${encodeURIComponent('Đầm dạ hội')}&taken=VAY_01`);
  assert.equal(sug.code, 'VAY_02', 'gợi ý bỏ qua mã đang đặt trên giao diện');
  console.log('  ✔ dòng 1 đủ tên / giá / link / 2 ảnh CDN, mã VAY_01; dòng 2 (ảnh từ máy) báo thiếu dữ liệu');

  console.log('\n▶ 6. Lưu mã → bước "In mã lên ảnh" in khung mã lên từng ảnh kết quả (ảnh gốc giữ nguyên)');
  const badgePng = 'data:image/png;base64,' + fs.readFileSync(path.join(fx, 'badge.png')).toString('base64');
  const badge = (x, y) => ({ x, y, scale: 1, png: badgePng, frameWidth: 720, frameHeight: 1280 });
  await assert.rejects(
    api('PUT', `/api/runs/${run0.id}/products`, { products: { [cleaned.id]: { code: 'AO-1', badge: badge(0.5, 0.12) } } }),
    /LOAI_SO/,
    'mã kiểu cũ "AO-1" bị từ chối, phải dạng VAY_01',
  );
  const saved = await api('PUT', `/api/runs/${run0.id}/products`, {
    products: {
      [cleaned.id]: { code: 'VAY_01', badge: badge(0.5, 0.12) },
      [outfit2.id]: { code: 'AO_01', name: 'Áo thun trơn', price: 99000, badge: badge(0.5, 0.12) },
    },
  });
  assert.equal(saved.remerge, true, 'mã mới -> phải in mã lên ảnh');
  assert.equal(saved.rows[1].name, 'Áo thun trơn');
  const run2 = await waitRun(run0.id, 'in mã lên ảnh', (r) => r.outputs.every((o) => o.codedUrl && !o.codedStale));
  assert.equal(run2.stageList.find((s) => s.id === 'badge').status, 'done');
  assert.deepEqual(run2.outputs.map((o) => o.code), ['VAY_01', 'AO_01']);
  assert.equal(run2.productCount, 2);
  const coded0 = localPath(run2.outputs[0].codedUrl);
  const orig0 = localPath(run2.outputs[0].outputUrl);
  assert.ok(fs.existsSync(coded0) && fs.existsSync(orig0));
  assert.notEqual(coded0, orig0, 'ảnh có mã là file riêng');
  const pc = await probe(coded0);
  assert.deepEqual({ w: pc.width, h: pc.height }, { w: 720, h: 1280 }, 'ảnh có mã cùng kích thước ảnh render');
  assert.ok(!fs.readFileSync(coded0).equals(fs.readFileSync(orig0)), 'ảnh có mã khác ảnh gốc (đã đè khung)');
  const st = await state();
  const outfitNow = st.assets.find((a) => a.id === cleaned.id);
  assert.equal(outfitNow.productCode, 'VAY_01', 'mã được cấp cho ảnh trang phục trong sổ mã chung');
  assert.equal(outfitNow.product.code, 'VAY_01', 'ghi ngược mã vào metadata ảnh trang phục');
  assert.equal(outfitNow.product.title, 'Đầm hoa nhí dáng xoè', 'ghi ngược không làm mất metadata');
  const codes = await api('GET', '/api/codes');
  assert.deepEqual(codes.codes.map((c) => c.code).sort(), ['AO_01', 'VAY_01'], 'sổ mã (xuất .txt cho máy khác) có cả 2 mã');
  const pr2 = await api('GET', `/api/runs/${run0.id}/products`);
  assert.equal(pr2.rows[0].codedUrl, run2.outputs[0].codedUrl);
  assert.equal(pr2.rows[0].codedStale, false);
  assert.equal(pr2.rows[0].codeSaved, true);
  console.log('  ✔ 2 ảnh có mã (720×1280, file riêng), bước In mã ✓, mã vào sổ chung + ghi ngược vào ảnh trang phục');

  console.log('\n▶ 7. Đổi vị trí khung → in lại; bỏ mã của ảnh 2 → xoá ảnh có mã của nó');
  const before0 = fs.readFileSync(coded0);
  await api('PUT', `/api/runs/${run0.id}/products`, { products: { [cleaned.id]: { code: 'VAY_01', badge: { x: 0.5, y: 0.85 } } } });
  await waitFor(async () => {
    const r = await runOf(run0.id);
    return r.status === 'done' && !r.outputs[0].codedStale && !fs.readFileSync(coded0).equals(before0);
  }, { what: 'in lại sau khi đổi vị trí' });
  const coded1 = localPath(run2.outputs[1].codedUrl);
  assert.ok(fs.existsSync(coded1));
  await api('PUT', `/api/runs/${run0.id}/products`, { products: { [outfit2.id]: { code: '' } } });
  const run3 = await waitRun(run0.id, 'dọn ảnh có mã', (r) => !r.outputs[1].codedUrl && !r.outputs[1].codedStale);
  assert.equal(run3.outputs[1].code, null);
  assert.ok(!fs.existsSync(coded1), 'file ảnh có mã của ảnh 2 đã xoá');
  assert.ok(run3.outputs[0].codedUrl, 'ảnh 1 vẫn có mã');
  assert.equal(run3.productCount, 1);
  console.log('  ✔ in lại khi đổi vị trí, dọn khi bỏ mã, lần chạy quay về Hoàn thành');

  console.log('\n▶ 8. Excel đúng hợp đồng DiamondShop (dữ liệu đang sửa cũng xuất được)');
  const buf = await api('POST', `/api/runs/${run0.id}/products.xlsx`, { products: { [outfit2.id]: { code: 'AO_07' } } });
  assert.ok(Buffer.isBuffer(buf) && buf.length > 2000);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.getWorksheet('San pham');
  assert.ok(ws, 'sheet "San pham"');
  const cellText = (c) => (c.value && typeof c.value === 'object' && 'text' in c.value ? c.value.text : c.value);
  const headers = ws.getRow(1).values.slice(1);
  assert.deepEqual(headers, [
    'Mã sản phẩm', 'Tên sản phẩm', 'Giá (đ)', 'Mô tả', 'Ảnh 1', 'Ảnh 2', 'Ảnh 3', 'Ảnh 4', 'Ảnh 5', 'Ảnh 6',
    'Link Shopee', 'Danh mục', 'Hoa hồng Shopee (đ)', 'Ghi chú', 'Xem trước',
  ]);
  assert.equal(ws.rowCount, 3, '1 tiêu đề + 2 sản phẩm');
  const x2 = ws.getRow(2);
  assert.equal(x2.getCell(1).value, 'VAY_01');
  assert.equal(x2.getCell(2).value, 'Đầm hoa nhí dáng xoè');
  assert.equal(x2.getCell(3).value, 259000);
  assert.equal(x2.getCell(4).value, 'Chất voan mát\nForm xoè nhẹ');
  assert.equal(cellText(x2.getCell(5)), found.images[0]);
  assert.equal(cellText(x2.getCell(6)), found.images[1]);
  assert.equal(x2.getCell(7).value ?? '', '');
  assert.equal(cellText(x2.getCell(11)), 'https://shopee.vn/product/1908715934/41434228389');
  assert.equal(x2.getCell(13).value ?? null, null, 'hoa hồng để trống');
  assert.equal(x2.getCell(14).value, 'Ảnh model mặc đồ – model – Bộ 1');
  const x3 = ws.getRow(3);
  assert.equal(x3.getCell(1).value, 'AO_07', 'mã đang sửa (chưa lưu) vẫn xuất');
  assert.equal(x3.getCell(2).value, 'Áo thun trơn');
  assert.equal(x3.getCell(3).value, 99000);
  assert.equal(ws.getImages().length, 2, 'thumbnail "Xem trước" = ảnh có mã / ảnh render của từng bộ');
  console.log('  ✔ 15 cột đúng thứ tự, giá là số, link chuẩn, hoa hồng trống, 2 thumbnail ảnh model');

  console.log('\n▶ 9. DiamondShop đọc file (Admin Tab 5 "Nhập từ Excel" → parseProductRows)');
  const matrix = [];
  ws.eachRow((row) => {
    const cells = [];
    for (let c = 1; c <= 14; c++) {
      const v = cellText(row.getCell(c));
      cells.push(v == null ? '' : String(v));
    }
    matrix.push(cells);
  });
  const parsed = await parseWithDiamondShop(matrix);
  if (!parsed) {
    console.log(`  (bỏ qua: không thấy repo DiamondShop ở ${DIAMONDSHOP_DIR} — đặt DIAMONDSHOP_DIR để kiểm)`);
  } else {
    assert.equal(parsed.errors.length, 0, 'không lỗi cấp file: ' + parsed.errors.join('; '));
    assert.equal(parsed.rows.length, 2);
    const d0 = parsed.rows[0];
    assert.equal(d0.status, 'new', 'dòng Shopee nhập được: ' + d0.errors.join('; '));
    assert.equal(d0.draft.code, 'VAY_01', 'mã dạng LOAI_SO hợp lệ với DiamondShop');
    assert.equal(d0.draft.name, 'Đầm hoa nhí dáng xoè');
    assert.equal(d0.draft.price, 259000);
    assert.equal(d0.draft.shopeeUrl, 'https://shopee.vn/product/1908715934/41434228389');
    assert.equal(d0.draft.shopId, '1908715934');
    assert.equal(d0.draft.itemId, '41434228389');
    assert.deepEqual(d0.draft.images, found.images);
    assert.equal(d0.draft.commission, null, 'hoa hồng trống -> Admin điền sau');
    const d1 = parsed.rows[1];
    assert.equal(d1.status, 'error', 'ảnh tải từ máy không có link Shopee -> DiamondShop báo lỗi dòng đó');
    assert.ok(d1.errors.some((e) => /link/i.test(e)), d1.errors.join('; '));
    console.log(`  ✔ DiamondShop: dòng Shopee = new (đủ mã/tên/giá/link/ảnh, hoa hồng trống); dòng từ máy = error "${d1.errors[0]}"`);
  }

  stopServer();
  await sleep(500);
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  console.log('\n🎉 KIỂM THỬ ĐẦU-CUỐI ẢNH MODEL MẶC ĐỒ ĐÃ VƯỢT QUA!');
}

main().catch((err) => {
  console.error('\n❌ TEST THẤT BẠI:', err);
  if (serverLog) console.error('\n--- log server ---\n' + serverLog.slice(-3000));
  stopServer();
  process.exit(1);
});
