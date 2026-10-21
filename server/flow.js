// Tự động hoá Google Flow bằng Playwright.
// Chrome được mở bằng 1 hồ sơ (profile) riêng trong data/flow-chrome; bạn tự đăng nhập Google trong cửa sổ đó.
// Playwright chỉ kết nối vào cửa sổ Chrome này để thao tác trên trang Flow.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { DATA_DIR } from './db.js';

export const FLOW_URL = 'https://flow.google.com/';
// Flow từng nằm ở labs.google/fx/tools/flow, nay chuyển sang flow.google.com
const isFlowUrl = (u) => /^https:\/\/(flow\.google\.com|labs\.google\/fx\/([a-z-]+\/)?tools\/flow)/.test(u);
const PORT = 9333;
const PROFILE_DIR = path.join(DATA_DIR, 'flow-chrome');

const CHROME_PATHS = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

const chromePath = () => CHROME_PATHS.find((p) => fs.existsSync(p));

async function isRunning() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

// Mở cửa sổ Chrome riêng cho Flow (nếu chưa mở)
export async function launchChrome() {
  if (await isRunning()) return { alreadyRunning: true };
  const exe = chromePath();
  if (!exe) throw new Error('Không tìm thấy Chrome/Edge trên máy');
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const p = spawn(
    exe,
    [`--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE_DIR}`, '--no-first-run', '--no-default-browser-check', FLOW_URL],
    { detached: true, stdio: 'ignore' },
  );
  p.unref();
  for (let i = 0; i < 30 && !(await isRunning()); i++) await sleep(500);
  if (!(await isRunning())) throw new Error('Mở Chrome không thành công');
  return { alreadyRunning: false };
}

let browser = null;
export async function connect() {
  if (browser?.isConnected()) return browser;
  if (!(await isRunning())) throw new Error('Chưa mở Chrome cho Flow — vào Cài đặt, bấm "Mở Chrome & đăng nhập".');
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  browser.on('disconnected', () => (browser = null));
  return browser;
}

// Lấy (hoặc mở) tab Flow
export async function flowPage() {
  const b = await connect();
  const ctx = b.contexts()[0];
  let page = ctx.pages().find((p) => isFlowUrl(p.url()));
  if (!page) {
    page = await ctx.newPage();
    await page.goto(FLOW_URL, { waitUntil: 'domcontentloaded' });
  }
  return page;
}

export async function status() {
  if (!(await isRunning())) return { running: false, connected: false };
  try {
    const b = await connect();
    const pages = b.contexts()[0]?.pages() || [];
    const flow = pages.find((p) => isFlowUrl(p.url()));
    // Chưa đăng nhập thì Flow hiện trang giới thiệu /about
    const onLogin = pages.some((p) => p.url().includes('accounts.google.com')) || !!flow?.url().includes('/about');
    return { running: true, connected: true, flowOpen: !!flow, url: flow?.url() || pages[0]?.url() || null, needsLogin: onLogin };
  } catch (e) {
    return { running: true, connected: false, error: e.message };
  }
}

/**
 * Tạo 1 video trên Flow: tải video + ảnh tham chiếu lên, dán prompt, bấm tạo, chờ và tải kết quả về outputFile.
 */
export const generateVideo = (opts) => generate({ ...opts, kind: 'video' });
// Sinh ảnh (Nano Banana) từ ảnh tham chiếu + prompt, vd. tạo bối cảnh mới từ khung hình video gốc
export const generateImage = (opts) => generate({ ...opts, kind: 'image' });

// flowRefs: { đường dẫn ảnh: tên trên Flow } cho ảnh do Flow tạo -> thêm thẳng từ thư viện dự án, không tải lên lại
async function generate({ settings, prompt, video, images = [], flowRefs = {}, outputFile, log = () => {}, onResult = () => {}, dryRun = false, kind = 'video' }) {
  const page = await flowPage();
  await page.bringToFront();
  if (page.url().includes('/about') || page.url().includes('accounts.google.com')) {
    throw new Error('Chưa đăng nhập Flow — mở cửa sổ Chrome của Flow và đăng nhập trước.');
  }
  await openProject(page, settings);

  // Mỗi nguyên liệu: file tải lên (tên = mã băm nội dung -> cùng 1 ảnh/video thì luôn cùng tên trên Flow,
  // nhờ đó lần sau nhận ra file đã có trong thư viện và không tải lên lại), hoặc ảnh do Flow tạo (title)
  // dùng thẳng từ thư viện dự án. Thứ tự trong ô prompt: ảnh model -> ảnh sản phẩm (hoặc ảnh bối cảnh) -> video gốc
  const toUpload = (f) => {
    const dest = path.join(DATA_DIR, 'tmp', `vs-${hashFile(f)}${path.extname(f).toLowerCase()}`);
    fs.copyFileSync(f, dest);
    return dest;
  };
  const items = [...images, video].filter(Boolean).map((f) => (flowRefs[f] ? { src: f, title: flowKey(flowRefs[f]) } : { src: f, file: toUpload(f) }));
  const keyOf = (it) => it.title || path.parse(it.file).name;
  let names = items.map(keyOf);
  const tag = names.join('+');

  try {
    const clear = page.getByRole('button', { name: 'Clear prompt' });
    if (await clear.isVisible().catch(() => false)) await clear.click();

    // Ảnh Flow tạo mà không còn trong dự án (đã xoá / dự án khác) -> tải lên như file thường
    for (const it of items) {
      if (it.title && !(await hasAsset(page, it.title))) {
        log(`Không thấy "${it.title}" trên Flow, tải ảnh lên`);
        it.file = toUpload(it.src);
        it.title = null;
      }
    }
    names = items.map(keyOf);
    const files = items.filter((it) => it.file).map((it) => it.file);
    const missing = [];
    for (const f of files) {
      if (!(await hasAsset(page, path.parse(f).name))) missing.push(f);
    }
    if (missing.length) {
      log(missing.length === files.length
        ? `Tải ${files.length} file lên Flow`
        : `Tải ${missing.length}/${files.length} file lên Flow (còn lại đã có sẵn)`);
      await uploadFiles(page, missing, settings);
    } else {
      log(files.length ? 'File đã có sẵn trên Flow, không tải lại' : 'Dùng lại ảnh có sẵn trên Flow, không tải lên');
    }
    for (const it of items) {
      log(`Thêm vào prompt: ${it.title ? `${it.title} (ảnh Flow tạo)` : path.basename(it.file)}`);
      await addIngredient(page, keyOf(it));
    }

    log(kind === 'image' ? 'Chọn Ảnh · Nano Banana' : 'Chọn Video · Omni 1.1 Flash');
    const credits = await configure(page, settings, kind);

    const box = page.getByRole('textbox', { name: 'What do you want to create?' });
    await box.click();
    await box.fill(flowPrompt(prompt, images.length));

    const before = await snapshotTiles(page);
    const start = page.getByRole('button', { name: 'Start generation' });
    // Flow cần một lúc sau khi gõ prompt mới bật nút tạo
    for (let i = 0; i < 30 && !(await start.isEnabled()); i++) await sleep(500);
    if (!(await start.isEnabled())) throw new Error('Flow không cho bấm tạo (nút "Start generation" bị khoá)');
    if (dryRun) return { dryRun: true, credits }; // kiểm tra các bước mà không tốn credit
    log(`Bấm tạo (${credits})`);
    await start.click();

    const tile = await waitForResult(page, before, log, names, kind);
    // Tên Flow đặt cho kết quả -> ảnh này về sau dùng lại được làm nguyên liệu (không tải lên lại)
    const title = (await tile.getAttribute('aria-label').catch(() => '')) || '';
    log(kind === 'image' ? 'Tải ảnh về' : 'Tải video về');
    await downloadTile(page, tile, outputFile, kind, (src) => onResult(src, { title }));
    return { id: tag, outputFile, text: `Google Flow · ${credits}`, title };
  } finally {
    for (const it of items) if (it.file) fs.rm(it.file, { force: true }, () => {});
  }
}

// Tên hiển thị của ảnh trên Flow bị cắt bớt với "…" -> tìm theo phần đầu
const flowKey = (title) => String(title).replace(/…\s*$/, '').trim();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Dùng chung 1 dự án Flow cho mọi video (tạo mới lần đầu, lưu lại URL)
async function openProject(page, settings) {
  if (settings.flowProjectUrl) {
    if (!page.url().startsWith(settings.flowProjectUrl)) {
      await page.goto(settings.flowProjectUrl, { waitUntil: 'domcontentloaded' });
    }
  } else {
    if (!page.url().includes('/project/')) {
      await page.goto(FLOW_URL, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'New project' }).click();
      await page.waitForURL(/\/project\//, { timeout: 30_000 });
    }
    settings.flowProjectUrl = page.url().split('?')[0];
  }
  // Trang dự án đôi khi kẹt "Loading…" (nhất là ngay sau khi mở Chrome) -> tải lại rồi chờ tiếp
  const box = page.getByRole('textbox', { name: 'What do you want to create?' });
  for (let i = 0; ; i++) {
    try {
      await box.waitFor({ timeout: 20_000 });
      break;
    } catch (e) {
      if (i >= 2) throw new Error('Trang dự án Flow không tải được (kẹt "Loading…") — thử tải lại trang trong cửa sổ Chrome của Flow.');
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    }
  }
}

const assetList = (page) => page.getByRole('listbox', { name: 'Asset list' });

// Mã băm ngắn của nội dung file
const hashFile = (f) => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex').slice(0, 16);

async function openAssetPanel(page) {
  // Dự án trống không có "Asset list" -> nhận biết bảng đã mở bằng ô tìm kiếm
  if (await page.getByRole('textbox', { name: 'Search assets' }).isVisible().catch(() => false)) return;
  await dismissOverlays(page); // menu khác còn mở thì lớp phủ chặn cú bấm
  await page.getByRole('button', { name: 'Add ingredients to the prompt box' }).click();
  await page.getByRole('button', { name: 'Upload media' }).waitFor({ timeout: 15_000 });
}

// Tìm file theo tên trong thư viện của dự án (dùng ô tìm kiếm để không bỏ sót khi thư viện dài)
async function searchAssets(page, name) {
  await openAssetPanel(page);
  const search = page.getByRole('textbox', { name: 'Search assets' });
  await search.fill(name);
  await sleep(800);
  return assetList(page).getByRole('option', { name: new RegExp('^' + escapeRe(name)) });
}

async function hasAsset(page, name) {
  const found = (await (await searchAssets(page, name)).count()) > 0;
  await page.getByRole('textbox', { name: 'Search assets' }).fill('');
  await sleep(300);
  return found;
}

async function uploadFiles(page, files, settings) {
  await openAssetPanel(page);
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 15_000 }),
    page.getByRole('button', { name: 'Upload media' }).click(),
  ]);
  await chooser.setFiles(files);
  // Hộp thoại điều khoản "Rights to use…" có thể hiện cho từng file.
  // Chỉ tự đồng ý khi người dùng đã bật ô "Tự bấm I agree" trong Cài đặt.
  const dialog = page.getByRole('dialog', { name: /Rights to use/ });
  for (let quiet = 0; quiet < 4; ) {
    await sleep(1000);
    if (!(await dialog.isVisible().catch(() => false))) { quiet++; continue; }
    quiet = 0;
    if (!settings.flowAutoAgree) {
      throw new Error('Flow đang hỏi "Rights to use this video" — tự bấm đồng ý trong cửa sổ Chrome của Flow, hoặc bật "Tự bấm I agree" trong Cài đặt, rồi bấm Thử lại.');
    }
    await dialog.getByRole('button', { name: 'I agree', exact: true }).click();
  }
  for (const f of files) {
    await assetList(page).getByRole('option', { name: new RegExp('^' + path.parse(f).name + '\\b') }).waitFor({ timeout: 180_000 });
  }
}

const ingredientCount = (page) => page.getByRole('button', { name: 'Ingredient', exact: true }).count();

async function addIngredient(page, name) {
  const n = await ingredientCount(page);
  // Tìm theo tên rồi chọn bản đầu tiên (thư viện có thể còn bản trùng từ trước)
  await (await searchAssets(page, name)).first().click();
  const add = page.getByRole('button', { name: 'Add to prompt' });
  await add.click({ timeout: 5000 }).catch(() => {});
  for (let i = 0; i < 30 && (await ingredientCount(page)) <= n; i++) await sleep(500);
  const search = page.getByRole('textbox', { name: 'Search assets' });
  if (await search.isVisible().catch(() => false)) await search.fill('');
  if ((await ingredientCount(page)) <= n) throw new Error(`Không thêm được ${name} vào prompt`);
}

// Video: Video / Ingredients / tỉ lệ / Omni 1.1 Flash / độ phân giải / x1.
// Ảnh: Image / tỉ lệ / Nano Banana / x1. Trả về số credit sẽ tốn.
async function configure(page, settings, kind = 'video') {
  await page.getByRole('button', { name: 'Settings trigger' }).click();
  const radio = (name) => page.getByRole('radio', { name, exact: true });
  const family = page.getByRole('button', { name: 'Select model family' });
  const pickFamily = async (re) => {
    if (re.test(await family.innerText())) return;
    await family.click();
    await page.getByRole('menuitem', { name: re }).first().click();
  };
  if (kind === 'image') {
    await radio('Image').click();
    await sleep(400);
    await radio(settings.aspectRatio === '16:9' ? '16:9' : '9:16').click();
    await pickFamily(/Nano Banana/i);
  } else {
    await radio('Video').click();
    await sleep(400);
    await radio('Ingredients').click();
    await radio(settings.aspectRatio === '16:9' ? '16:9' : '9:16').click();
    await pickFamily(/Omni/);
    await page.getByRole('radio', { name: settings.flowResolution === '360p' ? /^360p/ : /^720p/ }).click();
  }
  await radio('x1').click();
  await sleep(500);
  const credits = await page.getByRole('link', { name: /credits/ }).innerText().catch(() => '? credits');
  await page.keyboard.press('Escape');
  return credits;
}

// Prompt cũ có thể còn <IMAGE_REF_n> -> Flow hiểu theo thứ tự ảnh đã thêm
function flowPrompt(prompt, imageCount) {
  return prompt.replace(/<IMAGE_REF_(\d+)>/g, (_, i) => (imageCount > 1 ? `reference image ${Number(i) + 1}` : 'the reference image'));
}

// Các ô media đang có trong dự án: { i, key, text, hasVideo, old }
const TILE = 'main [role="group"]';
const tiles = (page) =>
  page.locator(TILE).evaluateAll((els) =>
    els.map((e, i) => {
      const label = e.getAttribute('aria-label') ||
        (e.getAttribute('aria-labelledby') && document.getElementById(e.getAttribute('aria-labelledby'))?.textContent) || '';
      const v = e.querySelector('video');
      const im = e.querySelector('img');
      return {
        i,
        key: label.trim(),
        text: e.innerText.trim(),
        hasVideo: !!v || /video/i.test(im?.alt || ''),
        src: v?.getAttribute('src') || '',
        isrc: im?.getAttribute('src') || '',
      };
    }),
  );
const FAILED_RE = /couldn.t generate|failed to generate|something went wrong|try again later|violat/i;
const isFailed = (t) => FAILED_RE.test(t.text);
const isGenerating = (t) => /\d+\s*%/.test(t.text);
// Mã file media: phần cuối đường dẫn, bỏ chữ ký ?Expires=… (đổi theo thời gian).
// Cùng 1 video Flow lúc hiện <video> (/video/<id>) lúc hiện ảnh thu nhỏ (/image/<id>).
const mediaId = (src) => (src || '').split('?')[0].split('/').pop();
const tileMedia = (t) => mediaId(t.src || t.isrc);
// Ô đã có kết quả ổn định (có media, không lỗi, không đang chạy)
const isSettled = (t) => !!tileMedia(t) && !isFailed(t) && !isGenerating(t);

// Danh sách ô của Flow là virtual scroll: chỉ ô đang hiện mới có trong DOM, và Flow vẽ lại ô
// bất cứ lúc nào (mọi dấu gắn lên DOM đều mất). Luôn kéo về đầu để thấy các ô mới nhất.
const scrollTilesTop = (page) =>
  page.evaluate(() => {
    window.scrollTo(0, 0);
    for (const el of document.querySelectorAll('cdk-virtual-scroll-viewport, main')) el.scrollTop = 0;
  }).catch(() => {});

/**
 * Ảnh chụp trước khi bấm tạo. Flow xếp ô mới nhất lên trên cùng, nên ô của lần tạo này sẽ
 * xuất hiện ở đầu danh sách. Mốc = ô ổn định đầu tiên (nhận lại theo mã file media, không đổi
 * khi Flow vẽ lại); `above` = số ô đang nằm trên mốc (file vừa tải lên, ô lỗi cũ, ô của lần tạo
 * trước vẫn còn chạy dở…). Số ô trên mốc tăng lên bao nhiêu thì bấy nhiêu ô trên cùng là ô mới.
 * Ghi thêm vài mốc dự phòng (các ô ổn định kế tiếp) phòng khi Flow đổi đường dẫn media của mốc đầu.
 */
async function snapshotTiles(page) {
  await scrollTilesTop(page);
  const all = await tiles(page);
  const settled = all.map((t, i) => ({ t, i })).filter(({ t }) => isSettled(t)).slice(0, 3);
  const first = settled[0]?.i ?? all.length;
  return { anchors: settled.map(({ t, i }) => ({ id: tileMedia(t), offset: i - first })), above: first };
}

// Các ô nằm trên mốc; null = không thấy mốc nào (trang đang vẽ lại)
function tilesAboveAnchor(all, before) {
  if (!before.anchors.length) return all;
  for (const { id, offset } of before.anchors) {
    const a = all.findIndex((t) => tileMedia(t) === id);
    if (a >= 0) return all.slice(0, Math.max(0, a - offset));
  }
  return null;
}

// File do web tải lên luôn tên "vs-…" -> không bao giờ là kết quả
const isUploadTile = (t, names) => t.key.startsWith('vs-') || names.some((nm) => t.key.startsWith(nm));

/**
 * Chờ ô kết quả của lần tạo này: ô mới nhất trong số các ô xuất hiện trên mốc sau khi bấm tạo
 * (xem snapshotTiles). Chỉ theo dõi đúng ô đó: ô khác lỗi hay xong cũng mặc kệ, nên kết quả của
 * lần tạo trước (vd. lần bị báo lỗi nhầm nhưng Flow vẫn chạy tiếp) không bị lấy nhầm.
 * Nhận kết quả khi ô hết % và có <video src> giữ nguyên qua 2 lần kiểm tra, sớm nhất 25s sau khi bấm tạo.
 */
async function waitForResult(page, before, log, names, kind = 'video') {
  const startedAt = Date.now();
  const deadline = startedAt + 20 * 60_000;
  let reported = '';
  let lastSrc = '';
  let waitedNote = false;
  while (Date.now() < deadline) {
    await sleep(5000);
    await scrollTilesTop(page);
    const all = await tiles(page);
    const region = tilesAboveAnchor(all, before);
    if (!region) continue; // mốc chưa hiện ra -> chờ
    const fresh = region.slice(0, Math.max(0, region.length - before.above));
    const t = fresh.find((x) => !isUploadTile(x, names));
    if (!t) {
      if (!waitedNote && Date.now() - startedAt > 90_000) { waitedNote = true; log('Chưa thấy ô mới trên Flow, vẫn chờ'); }
      continue;
    }
    if (isFailed(t)) {
      const refunded = /will be refunded/i.test(t.text);
      throw new Error('Flow báo lỗi: ' + t.text.split('\n').slice(0, 2).join(' ') + (refunded ? ' (Flow sẽ hoàn lại credit cho lần lỗi này)' : ''));
    }
    const pct = t.text.match(/\d+\s*%/)?.[0];
    if (pct) {
      if (pct !== reported) log(`Đang tạo… ${(reported = pct)}`);
      continue;
    }
    // Video: cần <video src>; ảnh: cần <img src> và không phải ô video
    const media = kind === 'image' ? (t.src ? '' : t.isrc) : (t.hasVideo ? t.src : '');
    if (!/^https?:/.test(media)) continue;
    if (Date.now() - startedAt < 25_000) continue;
    if (media !== lastSrc) { lastSrc = media; continue; } // đợi src ổn định qua 2 lần kiểm tra
    return page.locator(TILE).nth(t.i);
  }
  throw new Error('Quá 20 phút chưa thấy video kết quả trên Flow');
}

// Đóng menu / popover của Flow còn mở (lớp phủ cdk chặn mọi thao tác chuột bên dưới)
async function dismissOverlays(page) {
  const backdrop = page.locator('.cdk-overlay-backdrop-showing');
  for (let i = 0; i < 4 && (await backdrop.count()); i++) {
    await page.keyboard.press('Escape');
    await sleep(400);
  }
  if (await backdrop.count()) await backdrop.first().click({ force: true }).catch(() => {});
}

// Đường dẫn file media (https) của 1 ô kết quả
async function tileMediaSrc(page, tile, kind) {
  const sel = kind === 'image' ? 'img' : 'video';
  const read = () => tile.locator(sel).first().getAttribute('src').catch(() => null);
  let src = await read();
  if (!/^https?:/.test(src || '')) {
    // Flow nạp video khi rê chuột vào ô; hover lỗi (bị lớp phủ chặn…) thì không chết, thử đóng lớp phủ rồi làm lại
    await dismissOverlays(page);
    await tile.hover({ timeout: 5000 }).catch(() => {});
    await sleep(1000);
    src = await read();
  }
  return /^https?:/.test(src || '') ? src : null;
}

// Tải 1 URL media của Flow về file (dùng cookie đăng nhập của cửa sổ Chrome)
export async function fetchToFile(src, outputFile) {
  const page = await flowPage();
  const res = await page.context().request.get(src);
  if (!res.ok()) throw new Error(`Tải file từ Flow lỗi (HTTP ${res.status()})`);
  const body = await res.body();
  if (body.length < 1000) throw new Error('File tải về từ Flow quá nhỏ, có thể đường dẫn đã hết hạn');
  fs.writeFileSync(outputFile, body);
}

async function downloadTile(page, tile, outputFile, kind = 'video', onResult = () => {}) {
  // Cách 1: lấy thẳng file từ thẻ <video>/<img>
  const src = await tileMediaSrc(page, tile, kind);
  if (src) {
    onResult(src); // ghi nhớ để lần Thử lại sau có thể lấy lại mà không tạo mới
    try {
      await fetchToFile(src, outputFile);
      return;
    } catch (e) {
      console.error('Tải thẳng từ Flow lỗi, chuyển sang menu Download:', e.message);
    }
  }
  // Cách 2: menu "More options" -> Download
  await dismissOverlays(page);
  await tile.hover({ timeout: 5000 }).catch(() => {});
  await tile.getByRole('button', { name: 'More options' }).click();
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 120_000 }),
    (async () => {
      await page.getByRole('menuitem', { name: /Download/i }).first().click();
      const quality = page.getByRole('menuitem', { name: /720p|Original|1080p/i }).first();
      if (await quality.isVisible({ timeout: 2000 }).catch(() => false)) await quality.click();
    })(),
  ]);
  await dl.saveAs(outputFile);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
