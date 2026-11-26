// Kiểm thử tự động toàn bộ nâng cấp Ảnh model mặc đồ (Nữ / Nam, đồ bộ, khoá chéo, nhập thiếu không áo khoác,
// nhiều mã sản phẩm / 1 ảnh, FFmpeg overlayBadges thật, Excel DiamondShop, ZIP 5 slide & Zernio Photo Carousel).
// CHẠY AN TOÀN VỚI DATA_DIR TẠM — KHÔNG chạm data/db.json thật hay phiên Chrome đang mở.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';

const execFileAsync = promisify(execFile);
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-video-anh-model-test-'));
process.env.DATA_DIR = tempDir;

const { db, DIRS } = await import('../server/db.js');
const {
  validateOutfitItems,
  prepareModelInputs,
  buildDynamicRenderPrompt,
} = await import('../server/workflows/anh-model-shared.js');
const { WORKFLOWS } = await import('../server/workflows/index.js');
const { overlayBadges, probe } = await import('../server/ffmpeg.js');
const {
  defaultBadgeLayoutForOutfit,
  productItemsOf,
  buildProductRows,
  saveRunProducts,
  codedImagesOf,
  ensureCodedImages,
  buildWorkbook,
  PRODUCT_COLUMNS,
} = await import('../server/productExport.js');
const { createRun, viewRun, cancelRun, deleteRun } = await import('../server/workflows/runner.js');
const { createZipBuffer } = await import('../server/zipPack.js');
const { ensureTikTokJpeg, buildPhotoCarouselPayload } = await import('../server/zernio.js');

const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TINY_PNG_DATA_URL = `data:image/png;base64,${TINY_PNG_B64}`;

async function makeTestPng(dest, { width = 720, height = 1280, color = '#335577' } = {}) {
  await execFileAsync(ffmpegPath, [
    '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=${width}x${height}:r=1`, '-frames:v', '1', dest,
  ]);
}

function seedAsset(id, kind, name, extra = {}) {
  const file = path.join(DIRS.assets, `${id}.png`);
  fs.writeFileSync(file, Buffer.from(TINY_PNG_B64, 'base64'));
  const asset = { id, kind, name, path: file, createdAt: Date.now(), ...extra };
  db.assets.push(asset);
  return asset;
}

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS: ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.error(`FAIL: ${name}\n`, err);
  }
}

try {
  // Seed assets dùng chung cho các test
  const modelF = seedAsset('m_f', 'model', 'Model Nữ');
  const modelM = seedAsset('m_m', 'model', 'Model Nam');
  const bg1 = seedAsset('bg1', 'background', 'Phố cafe');
  const bg2 = seedAsset('bg2', 'background', 'Studio nắng');
  const dress1 = seedAsset('d1', 'product', 'Váy hoa nhí', { product: { title: 'Váy hoa nhí', price: 299000, commission: 30000, shopId: '1', itemId: '101' } });
  const top1 = seedAsset('t1', 'product', 'Áo sơ mi trắng', {
    product: { title: 'Áo sơ mi trắng', price: 199000, commission: 20000, shopId: '1', itemId: '102', affiliateUrl: 'https://s.shopee.vn/aoSoMiAff' },
  });
  const bottom1 = seedAsset('b1', 'product', 'Quần jeans ống rộng', { product: { title: 'Quần jeans ống rộng', price: 329000, commission: 32000, shopId: '1', itemId: '103' } });
  const set1 = seedAsset('s1', 'product', 'Đồ bộ lụa nữ');
  const jacket1 = seedAsset('j1', 'product', 'Áo khoác blazer');
  const bag1 = seedAsset('bag1', 'product', 'Túi xách mini');

  const has = (id) => db.assets.some((a) => a.id === id);

  // Test 1: Khoá chéo Nữ / Nam & nhập thiếu món
  await test('1. Mutual exclusion & partial-item rules (Female & Male)', async () => {
    // Nữ hợp lệ: đầm đơn, áo+váy, áo+quần, đồ bộ, thiếu món (chỉ áo / chỉ khoác / chỉ túi), 4 món đủ
    assert.deepEqual(validateOutfitItems('female', { dress: dress1.id }, has), { dress: dress1.id });
    assert.deepEqual(validateOutfitItems('female', { top: top1.id, dress: dress1.id }, has), { top: top1.id, dress: dress1.id });
    assert.deepEqual(validateOutfitItems('female', { top: top1.id, bottom: bottom1.id }, has), { top: top1.id, bottom: bottom1.id });
    assert.deepEqual(validateOutfitItems('female', { set: set1.id }, has), { set: set1.id });
    assert.deepEqual(validateOutfitItems('female', { jacket: jacket1.id }, has), { jacket: jacket1.id });
    assert.deepEqual(
      validateOutfitItems('female', { top: top1.id, dress: dress1.id, jacket: jacket1.id, bag: bag1.id }, has),
      { top: top1.id, dress: dress1.id, jacket: jacket1.id, bag: bag1.id },
    );

    // Nữ bị chặn
    assert.throws(() => validateOutfitItems('female', { dress: dress1.id, bottom: bottom1.id }, has), /Váy và Quần/);
    assert.throws(() => validateOutfitItems('female', { set: set1.id, top: top1.id }, has), /Đồ bộ/);
    assert.throws(() => validateOutfitItems('female', { set: set1.id, dress: dress1.id }, has), /Đồ bộ/);
    assert.throws(() => validateOutfitItems('female', {}, has), /ít nhất 1/);

    // Nam hợp lệ: chỉ áo, chỉ quần, chỉ áo khoác, áo+quần, đồ bộ, đồ bộ+áo khoác, áo+quần+áo khoác
    assert.deepEqual(validateOutfitItems('male', { top: top1.id }, has), { top: top1.id });
    assert.deepEqual(validateOutfitItems('male', { bottom: bottom1.id }, has), { bottom: bottom1.id });
    assert.deepEqual(validateOutfitItems('male', { jacket: jacket1.id }, has), { jacket: jacket1.id });
    assert.deepEqual(validateOutfitItems('male', { set: set1.id, jacket: jacket1.id }, has), { set: set1.id, jacket: jacket1.id });

    // Nam bị chặn
    assert.throws(() => validateOutfitItems('male', { set: set1.id, top: top1.id }, has), /Đồ bộ/);
    assert.throws(() => validateOutfitItems('male', { set: set1.id, bottom: bottom1.id }, has), /Đồ bộ/);
    assert.throws(() => validateOutfitItems('male', {}, has), /ít nhất 1/);

    // Multi-background + legacy compat trong prepareModelInputs
    const prepMulti = prepareModelInputs('female', {
      backgrounds: [bg1.id, bg2.id],
      modelOutfits: [{ id: 'b1', items: { top: top1.id, bottom: bottom1.id } }],
    }, has);
    assert.deepEqual(prepMulti.backgrounds, [bg1.id, bg2.id]);
    assert.equal(prepMulti.background, bg1.id);
    assert.equal(prepMulti.modelOutfits.length, 1);

    const prepLegacy = prepareModelInputs('female', {
      background: bg1.id,
      outfits: [dress1.id, set1.id],
    }, has);
    assert.deepEqual(prepLegacy.backgrounds, [bg1.id]);
    assert.equal(prepLegacy.modelOutfits.length, 2);
    assert.equal(prepLegacy.modelOutfits[0].items.dress, dress1.id);
    assert.equal(prepLegacy.modelOutfits[0].legacy, true);
  });

  // Test 2: Prompt động cho từng trường hợp (không áo khoác -> cấm; có áo khoác -> giữ đúng; giày & túi AI tự phối)
  await test('2. Dynamic prompt builder handles missing items, outerwear ban, footwear & bag rules', async () => {
    // Nam chỉ nhập Áo (bỏ trống Quần & Áo khoác)
    const pMaleTopOnly = buildDynamicRenderPrompt({ gender: 'male', items: { top: top1.id } });
    assert.match(pMaleTopOnly, /MISSING TROUSERS/i);
    assert.match(pMaleTopOnly, /NO OUTERWEAR \/ NO JACKET/i);
    assert.match(pMaleTopOnly, /FOOTWEAR \(AI-STYLED\)/i);
    assert.match(pMaleTopOnly, /Do NOT add any handbag/i);

    // Nam chỉ nhập Áo khoác -> AI phối đủ áo trong + quần + giày
    const pMaleJacketOnly = buildDynamicRenderPrompt({ gender: 'male', items: { jacket: jacket1.id } });
    assert.match(pMaleJacketOnly, /ONLY OUTER JACKET PROVIDED/i);
    assert.match(pMaleJacketOnly, /OUTERWARE|OUTERWEAR RULE: Keep the exact jacket/i);
    assert.doesNotMatch(pMaleJacketOnly, /NO OUTERWEAR \/ NO JACKET/);

    // Nữ nhập Áo + Váy (bỏ trống Túi & Khoác, bật autoBag) + giữ body/mặt từ model nữ nhưng cao ráo & góc máy ngang eo/hông lookbook
    const pFemTopSkirt = buildDynamicRenderPrompt({ gender: 'female', items: { top: top1.id, dress: dress1.id }, autoBag: true });
    assert.match(pFemTopSkirt, /image 2 = .*image 3 = .*image 4 = the background scene/i);
    assert.match(pFemTopSkirt, /NO OUTERWEAR \/ NO JACKET/i);
    assert.match(pFemTopSkirt, /HANDBAG \(AI-STYLED\)/i);
    assert.match(pFemTopSkirt, /FOOTWEAR \(AI-STYLED\)/i);
    assert.match(pFemTopSkirt, /exact natural body shape/i);
    assert.match(pFemTopSkirt, /face must match image 1 exactly/i);
    assert.match(pFemTopSkirt, /slightly taller.*1\.68/i);
    assert.match(pFemTopSkirt, /waist-to-hip height/i);
    assert.match(pFemTopSkirt, /3–5% bottom margin/i);
    assert.doesNotMatch(pMaleTopOnly, /waist-to-hip height/i);

    // Nữ nhập 4 món đủ (Áo + Quần + Áo khoác + Túi)
    const pFem4 = buildDynamicRenderPrompt({
      gender: 'female',
      items: { top: top1.id, bottom: bottom1.id, jacket: jacket1.id, bag: bag1.id },
      autoBag: true,
    });
    assert.match(pFem4, /4 provided items/i);
    assert.match(pFem4, /image 5 = HANDBAG/i);
    assert.match(pFem4, /image 6 = the background scene/i);
    assert.doesNotMatch(pFem4, /NO OUTERWEAR \/ NO JACKET/);
    assert.match(pFem4, /Use ONLY the exact handbag from image 5/i);
  });

  // Test 3: Default Multi-Badge Layout & Real FFmpeg overlayBadges()
  await test('3. Multi-badge smart layout + real FFmpeg overlayBadges render', async () => {
    const l1 = defaultBadgeLayoutForOutfit(['dress']);
    assert.equal(l1.dress.x, 0.5);

    const l2 = defaultBadgeLayoutForOutfit(['top', 'bottom']);
    assert.equal(l2.top.x, 0.25);
    assert.equal(l2.bottom.x, 0.75);
    assert.equal(l2.top.y, l2.bottom.y);

    const l4 = defaultBadgeLayoutForOutfit(['top', 'dress', 'jacket', 'bag']);
    assert.equal(l4.top.x, 0.25);
    assert.equal(l4.dress.x, 0.75);
    assert.equal(l4.jacket.x, 0.25);
    assert.equal(l4.jacket.y, 0.16);
    assert.equal(l4.bag.x, 0.75);
    assert.equal(l4.bag.y, 0.16);

    const baseImg = path.join(DIRS.outputs, 'test-base.png');
    const bTop = path.join(DIRS.assets, 'b-top.png');
    const bBot = path.join(DIRS.assets, 'b-bot.png');
    const bJk = path.join(DIRS.assets, 'b-jk.png');
    const destImg = path.join(DIRS.outputs, 'test-coded-multi.png');

    await makeTestPng(baseImg, { width: 720, height: 1280, color: '#2b4c7e' });
    await makeTestPng(bTop, { width: 160, height: 48, color: '#111111' });
    await makeTestPng(bBot, { width: 160, height: 48, color: '#222222' });
    await makeTestPng(bJk, { width: 160, height: 48, color: '#333333' });

    await overlayBadges({
      src: baseImg,
      width: 720,
      dest: destImg,
      badges: [
        { file: bTop, x: l4.top.x, y: l4.top.y, frameWidth: 720 },
        { file: bBot, x: l4.dress.x, y: l4.dress.y, frameWidth: 720 },
        { file: bJk, x: l4.jacket.x, y: l4.jacket.y, frameWidth: 720 },
      ],
    });
    assert.equal(fs.existsSync(destImg), true);
    const info = await probe(destImg);
    assert.equal(info.width, 720);
    assert.equal(info.height, 1280);
  });

  // Test 4: productExport (Multi-item + Mix & Match shared SKU + Legacy compat + 5-col DiamondShop Excel)
  await test('4. Multi-item productExport, Mix & Match shared codes, legacy compat, Excel', async () => {
    const wfF = WORKFLOWS['anh-model'];
    const wfM = WORKFLOWS['anh-model-nam'];
    assert.equal(wfF.tab.group, 'anh-model');
    assert.equal(wfF.tab.label, 'Nữ');
    assert.equal(wfM.tab.group, 'anh-model');
    assert.equal(wfM.tab.label, 'Nam');

    const imgOut1 = path.join(DIRS.outputs, 'mock-out-1.png');
    const imgOut2 = path.join(DIRS.outputs, 'mock-out-2.png');
    await makeTestPng(imgOut1, { width: 720, height: 1280, color: '#553366' });
    await makeTestPng(imgOut2, { width: 720, height: 1280, color: '#336655' });

    // 4a. Run mới nhiều món + Mix & Match (top1 dùng chung cho Bộ 1 & Bộ 2)
    const job1 = { id: 'j_o1', status: 'done', outputPath: imgOut1, thumbPath: imgOut1, attempts: [{ n: 1, outputPath: imgOut1 }] };
    const job2 = { id: 'j_o2', status: 'done', outputPath: imgOut2, thumbPath: imgOut2, attempts: [{ n: 1, outputPath: imgOut2 }] };
    db.jobs.push(job1, job2);

    const runMulti = {
      id: 'run_multi',
      workflow: 'anh-model',
      inputs: {
        model: modelF.id,
        backgrounds: [bg1.id],
        modelOutfits: [
          { id: 'o1', items: { top: top1.id, bottom: bottom1.id, jacket: jacket1.id } },
          { id: 'o2', items: { top: top1.id, dress: dress1.id } },
        ],
      },
      stages: { _jobs: { 'render:0:o1': job1.id, 'render:1:o2': job2.id } },
      products: {},
    };
    db.runs.push(runMulti);

    const items = productItemsOf(runMulti);
    assert.equal(items.length, 5); // Bộ 1: 3 món + Bộ 2: 2 món
    assert.equal(items[0].key, 'o1__top');
    assert.equal(items[0].defaultBadge.x, 0.25);
    assert.equal(items[1].defaultBadge.x, 0.75);

    // Lưu mã (có dùng chung AO_01 cho top1 ở cả Bộ 1 và Bộ 2 -> phải hợp lệ!)
    const savedRows = saveRunProducts(runMulti, {
      o1__top: { code: 'AO_01', badge: { x: 0.25, y: 0.09, scale: 0.72, png: TINY_PNG_DATA_URL, frameWidth: 720 } },
      o1__bottom: { code: 'QN_01', badge: { x: 0.75, y: 0.09, scale: 0.72, png: TINY_PNG_DATA_URL, frameWidth: 720 } },
      o1__jacket: { code: 'AK_01', badge: { x: 0.25, y: 0.16, scale: 0.72, png: TINY_PNG_DATA_URL, frameWidth: 720 } },
      o2__top: { code: 'AO_01', badge: { x: 0.25, y: 0.09, scale: 0.72, png: TINY_PNG_DATA_URL, frameWidth: 720 } },
      o2__dress: { code: 'VAY_01', badge: { x: 0.75, y: 0.09, scale: 0.72, png: TINY_PNG_DATA_URL, frameWidth: 720 } },
    }, { badgePrefs: { style: 'boutique_female', showSlotPrefix: true } });

    assert.equal(savedRows.length, 5);
    assert.equal(runMulti.badgePrefs.style, 'boutique_female');

    // Chặn mã trùng giữa 2 SẢN PHẨM KHÁC NHAU
    assert.throws(() => saveRunProducts(runMulti, {
      o1__top: { code: 'AO_01' },
      o1__bottom: { code: 'AO_01' },
    }), /2 sản phẩm khác nhau/);

    // In 3 mã lên ảnh Bộ 1 & 2 mã lên ảnh Bộ 2 bằng FFmpeg thật
    const codedBefore = codedImagesOf(runMulti);
    assert.equal(codedBefore.length, 2);
    assert.equal(codedBefore[0].badges.length, 3);
    assert.equal(codedBefore[1].badges.length, 2);
    assert.equal(codedBefore.every((c) => c.stale), true);

    await ensureCodedImages(runMulti);
    assert.equal(codedImagesOf(runMulti).every((c) => !c.stale && fs.existsSync(c.current.path)), true);

    // Xuất Excel 6 cột: AO_01 trùng assetId ở Mix & Match chỉ xuất 1 dòng SKU -> còn 4 dòng duy nhất!
    const finalRows = buildProductRows(runMulti);
    const wb = await buildWorkbook(finalRows, { thumbnails: false });
    const ws = wb.getWorksheet('San pham');
    assert.deepEqual(ws.getRow(1).values.slice(1), PRODUCT_COLUMNS);
    assert.equal(ws.columnCount, 6);
    assert.equal(ws.rowCount, 5); // 1 header + 4 unique SKUs (AO_01, QN_01, AK_01, VAY_01)
    assert.equal(ws.getRow(2).getCell(6).value?.hyperlink, 'https://s.shopee.vn/aoSoMiAff');

    // 4b. Legacy run (`inputs.outfits` + `inputs.background`) vẫn chạy trọn vẹn
    const legAsset = seedAsset('leg1', 'product', 'Đầm cũ', { product: { title: 'Đầm cũ', price: 250000 } });
    const jobLeg = { id: 'j_leg', status: 'done', outputPath: imgOut1, thumbPath: imgOut1, attempts: [{ n: 1, outputPath: imgOut1 }] };
    db.jobs.push(jobLeg);
    const runLeg = {
      id: 'run_leg',
      workflow: 'anh-model',
      inputs: { model: modelF.id, background: bg1.id, outfits: [legAsset.id] },
      stages: { _jobs: { [`render:0:${legAsset.id}`]: jobLeg.id } },
      products: {},
    };
    db.runs.push(runLeg);
    const legItems = productItemsOf(runLeg);
    assert.equal(legItems.length, 1);
    assert.equal(legItems[0].key, legAsset.id);
    saveRunProducts(runLeg, {
      [legAsset.id]: { code: 'VAY_99', badge: { x: 0.5, y: 0.12, scale: 1, png: TINY_PNG_DATA_URL, frameWidth: 720 } },
    });
    await ensureCodedImages(runLeg);
    assert.equal(codedImagesOf(runLeg)[0].stale, false);
  });

  // Test 5: JPEG conversion + TikTok 5-slide ZIP + Zernio Photo Carousel payload
  await test('5. TikTok 5-slide JPEG conversion, ZIP packer, and Zernio Photo Carousel payload', async () => {
    const pngPath = path.join(DIRS.outputs, 'test-slide.png');
    await makeTestPng(pngPath, { width: 360, height: 640, color: '#664455' });
    const jpgPath = await ensureTikTokJpeg(pngPath);
    assert.equal(path.extname(jpgPath), '.jpg');
    const jpgHdr = fs.readFileSync(jpgPath).subarray(0, 3);
    assert.equal(jpgHdr[0], 0xff);
    assert.equal(jpgHdr[1], 0xd8);
    assert.equal(jpgHdr[2], 0xff);

    const jpgBuf = fs.readFileSync(jpgPath);
    const zipEntries = [
      { name: 'Bai-01/01-AO_01_QN_01.jpg', data: jpgBuf },
      { name: 'Bai-01/02-VAY_02.jpg', data: jpgBuf },
      { name: 'Bai-01/03-BO_03.jpg', data: jpgBuf },
      { name: 'Bai-01/04-AO_04.jpg', data: jpgBuf },
      { name: 'Bai-01/05-VAY_05.jpg', data: jpgBuf },
      { name: 'Bai-02/01-AO_06.jpg', data: jpgBuf },
      { name: 'Bai-02/02-VAY_07.jpg', data: jpgBuf },
    ];
    const zipBuf = createZipBuffer(zipEntries);
    assert.equal(zipBuf.subarray(0, 4).toString('binary'), 'PK\x03\x04');
    assert.ok(zipBuf.includes(Buffer.from('Bai-01/05-VAY_05.jpg')));
    assert.ok(zipBuf.includes(Buffer.from('Bai-02/02-VAY_07.jpg')));

    const payload = buildPhotoCarouselPayload({
      content: '5 outfit hot #thoitrang',
      mediaUrls: ['https://cdn.example.com/1.jpg', 'https://cdn.example.com/2.jpg', 'https://cdn.example.com/3.jpg', 'https://cdn.example.com/4.jpg', 'https://cdn.example.com/5.jpg'],
      filenames: ['01.jpg', '02.jpg', '03.jpg', '04.jpg', '05.jpg'],
      platforms: [{ platform: 'tiktok', accountId: 'acc_tt_1' }],
      publishNow: true,
      tiktokSettings: { draft: true, autoAddMusic: true },
    });
    assert.equal(payload.mediaItems.length, 5);
    assert.equal(payload.mediaItems[0].type, 'image');
    assert.equal(payload.platforms[0].platformSpecificData.media_type, 'photo');
    assert.equal(payload.platforms[0].platformSpecificData.draft, true);
    assert.equal(payload.platforms[0].platformSpecificData.auto_add_music, true);
  });

  // Test 6: Runner createRun + viewRun cho tab Nam mới & legacy Nữ (`inputs.outfits` + `inputs.background`)
  await test('6. Runner createRun & viewRun for anh-model-nam and legacy anh-model inputs', async () => {
    db.settings.engine = 'mock';
    const runMale = createRun({
      workflowId: 'anh-model-nam',
      inputs: {
        model: modelM.id,
        backgrounds: [bg1.id, bg2.id],
        modelOutfits: [
          { id: 'm1', items: { top: top1.id, bottom: bottom1.id } },
          { id: 'm2', items: { set: set1.id, jacket: jacket1.id } },
        ],
      },
      options: { cleanBackground: true, stylePreset: 'korean_street' },
    });
    const vm = viewRun(runMale);
    assert.equal(vm.workflow, 'anh-model-nam');
    assert.equal(vm.hasProductInputs, true);
    assert.equal(vm.productItemCount, 4);
    assert.equal(vm.backgrounds.length, 2);

    const runLegacyCreate = createRun({
      workflowId: 'anh-model',
      inputs: {
        model: modelF.id,
        background: bg1.id,
        outfits: [dress1.id],
      },
      options: { cleanBackground: false },
    });
    const vl = viewRun(runLegacyCreate);
    assert.equal(vl.workflow, 'anh-model');
    assert.equal(vl.hasProductInputs, true);
    assert.equal(vl.productItemCount, 1);

    // Dọn dẹp run + job mock trước khi thoát
    cancelRun(runMale);
    cancelRun(runLegacyCreate);
    deleteRun(runMale);
    deleteRun(runLegacyCreate);
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\nSummary: ${results.length - failed.length}/${results.length} passed.`);
  await new Promise((r) => setTimeout(r, 350));
  fs.rmSync(tempDir, { recursive: true, force: true });
  process.exit(failed.length ? 1 : 0);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
