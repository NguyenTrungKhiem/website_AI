// Tự động hoá Gemini Web (https://gemini.google.com/app) bằng Playwright chạy ngầm.
// Dùng Chrome profile riêng (data/gemini-chrome) qua CDP port 9334 (KHÔNG dùng --enable-automation nên Google cho đăng nhập).
// Bình thường chạy bằng `--headless=new` (ẩn hoàn toàn, không hiện tab/cửa sổ); CHỈ bật cửa sổ Chrome thật lên màn hình khi:
//   1. Người dùng bấm "Mở Chrome Gemini" để đăng nhập Google lần đầu (hoặc đóng cửa sổ sau khi đăng nhập), hoặc
//   2. Phát sinh lỗi (chưa đăng nhập Google, CAPTCHA, không thấy model Neon / mức tư duy, timeout…) để người dùng xử lý.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { DATA_DIR } from './db.js';
import { chromePath } from './flow.js';

export const DEFAULT_GEMINI_WEB_URL = 'https://gemini.google.com/app';
const GOOGLE_LOGIN_URL = `https://accounts.google.com/ServiceLogin?continue=${encodeURIComponent(DEFAULT_GEMINI_WEB_URL)}`;
const GEMINI_PORT = 9334;
const PROFILE_DIR = path.join(DATA_DIR, 'gemini-chrome');

const LOGIN_RE = /accounts\.google\.com|\/(signin|servicelogin|ServiceLogin)/i;
const CAPTCHA_RE = /captcha|unusual traffic|verify it'?s you|xác minh danh tính/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ownBrowser = null;
let ownPage = null;
let ownMode = null; // null | 'headless' | 'visible'
let queue = Promise.resolve();

async function portVersion() {
  try {
    const res = await fetch(`http://127.0.0.1:${GEMINI_PORT}/json/version`, { signal: AbortSignal.timeout(1200) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function isGeminiPortRunning() {
  return !!(await portVersion());
}

/** Trạng thái hiện tại của Chrome Gemini Web để hiện trên giao diện (hàm đồng bộ). */
export function geminiWebStatus() {
  let pageUrl = null;
  try {
    if (ownPage && !ownPage.isClosed()) pageUrl = ownPage.url();
  } catch {}
  return {
    browserOpen: !!(ownBrowser?.isConnected?.()),
    visible: ownMode === 'visible',
    profileExists: fs.existsSync(PROFILE_DIR),
    url: pageUrl,
  };
}

/** Điều khiển thu nhỏ ('minimized') hoặc bung cửa sổ lên màn hình ('normal') qua CDP. */
export async function setWindowState(ctx, page, windowState) {
  if (!ctx || !page || typeof ctx.newCDPSession !== 'function') return false;
  let cdp = null;
  try {
    cdp = await ctx.newCDPSession(page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState } });
    if (windowState === 'normal') await page.bringToFront?.().catch(() => {});
    return true;
  } catch {
    return false;
  } finally {
    await cdp?.detach?.().catch(() => {});
  }
}

/** Đóng hoàn toàn Chrome Gemini Web (và chờ giải phóng lock hồ sơ data/gemini-chrome). */
export async function closeGeminiBrowser() {
  const b = ownBrowser;
  ownBrowser = null;
  ownPage = null;
  ownMode = null;
  try {
    const conn = b?.isConnected?.()
      ? b
      : (await isGeminiPortRunning())
        ? await chromium.connectOverCDP(`http://127.0.0.1:${GEMINI_PORT}`).catch(() => null)
        : null;
    const ctx = conn?.contexts?.()?.[0];
    const p = ctx?.pages?.()?.[0];
    if (ctx && p) {
      const cdp = await ctx.newCDPSession(p).catch(() => null);
      if (cdp) {
        await cdp.send('Browser.close').catch(() => {});
        await cdp.detach().catch(() => {});
      }
    }
    await conn?.close?.().catch(() => {});
  } catch {}
  for (let i = 0; i < 40 && (await isGeminiPortRunning()); i++) await sleep(100);
}

const escapeXml = (s) =>
  String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Trên Windows, khi server được bật từ tiến trình nền (desktop ẩn), chạy qua Task Scheduler (InteractiveToken)
// đảm bảo cửa sổ Chrome hiện rõ ràng trên màn hình Desktop thật (WinSta0\Default) để người dùng đăng nhập được.
function launchVisibleViaTaskScheduler(exe, args) {
  if (process.platform !== 'win32') return false;
  const taskName = 'WebVideoGeminiChrome';
  const xmlPath = path.join(os.tmpdir(), `wv-gemini-task-${process.pid}.xml`);
  const argLine = args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '')}"` : a)).join(' ');
  const xml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowStartOnDemand>true</AllowStartOnDemand>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeXml(exe)}</Command>
      <Arguments>${escapeXml(argLine)}</Arguments>
    </Exec>
  </Actions>
</Task>`;
  try {
    fs.writeFileSync(xmlPath, Buffer.from(`\uFEFF${xml}`, 'utf16le'));
    execFileSync('schtasks', ['/create', '/tn', taskName, '/xml', xmlPath, '/f'], { stdio: 'ignore', windowsHide: true });
    execFileSync('schtasks', ['/run', '/tn', taskName], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(xmlPath, { force: true });
    try { execFileSync('schtasks', ['/delete', '/tn', taskName, '/f'], { stdio: 'ignore', windowsHide: true }); } catch {}
  }
}

async function launchGeminiChrome({ visible = false, url = DEFAULT_GEMINI_WEB_URL } = {}) {
  const exe = chromePath();
  if (!exe) throw new Error('Không tìm thấy Google Chrome hoặc Microsoft Edge trên máy.');
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const target = (url || '').trim() || DEFAULT_GEMINI_WEB_URL;
  const args = [
    `--remote-debugging-port=${GEMINI_PORT}`,
    `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--lang=vi-VN',
    '--window-size=1280,860',
  ];
  if (visible) {
    args.push(target);
  } else {
    args.push('--headless=new', 'about:blank');
  }
  const launchedViaTask = visible && launchVisibleViaTaskScheduler(exe, args);
  if (!launchedViaTask) {
    const p = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: !visible });
    p.unref();
  }
  for (let i = 0; i < 30 && !(await isGeminiPortRunning()); i++) await sleep(500);
  if (!(await isGeminiPortRunning())) throw new Error('Không khởi động được Chrome Gemini.');
  ownMode = visible ? 'visible' : 'headless';
}

async function connectGeminiBrowser({ visible = false, url = DEFAULT_GEMINI_WEB_URL } = {}) {
  const ver = await portVersion();
  const runningHeadless = ver ? /HeadlessChrome/i.test(ver['User-Agent'] || '') : false;
  if (ver && !ownMode) ownMode = runningHeadless ? 'headless' : 'visible';

  if (visible && ver && (ownMode === 'headless' || runningHeadless)) {
    await closeGeminiBrowser();
  }
  if (!(await isGeminiPortRunning())) {
    await launchGeminiChrome({ visible, url });
  }
  if (!ownBrowser?.isConnected?.()) {
    ownBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${GEMINI_PORT}`);
    ownBrowser.on('disconnected', () => {
      ownBrowser = null;
      ownPage = null;
      ownMode = null;
    });
  }
  const ctx = ownBrowser.contexts()[0];
  if (!ctx) throw new Error('Không kết nối được context của Chrome Gemini.');
  return { browser: ownBrowser, ctx };
}

async function geminiPage(ctx) {
  const pages = ctx.pages();
  let page = ownPage && !ownPage.isClosed() && pages.includes(ownPage) ? ownPage : pages.find((p) => !p.isClosed()) || null;
  if (!page) page = await ctx.newPage();
  ownPage = page;
  return page;
}

/** Mở cửa sổ Chrome Gemini hiện rõ lên màn hình để người dùng đăng nhập Google lần đầu. */
export async function showGeminiWindow(url = DEFAULT_GEMINI_WEB_URL) {
  const target = (url || '').trim() || DEFAULT_GEMINI_WEB_URL;
  const { ctx } = await connectGeminiBrowser({ visible: true, url: target });
  const page = await geminiPage(ctx);
  if (!/gemini\.google\.com|aistudio\.google\.com|accounts\.google\.com/i.test(page.url() || '')) {
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
  }
  await setWindowState(ctx, page, 'normal');
  await page.bringToFront?.().catch(() => {});
  return geminiWebStatus();
}

const PROMPT_SELECTORS = [
  'rich-textarea [contenteditable="true"]',
  'div.ql-editor[contenteditable="true"]',
  '[role="textbox"][contenteditable="true"]',
  'textarea[aria-label*="prompt" i]',
  'textarea',
].join(', ');

const SIDEBAR_ANCESTOR_SEL = 'nav, bard-sidenav, side-navigation-content, mat-sidenav, [role="navigation"], .conversation-items-container';

const SWITCHER_SELECTORS = [
  '[data-test-id="bard-mode-menu-button"], bard-mode-switcher button, input-area-v2 button.input-area-switch, .input-area button.input-area-switch',
  'input-area-v2 button[aria-label*="chọn chế độ" i], input-area-v2 button[aria-label*="model" i], input-area-v2 button[aria-label*="mô hình" i]',
  'button[aria-label*="model" i], button[aria-label*="mô hình" i], button[aria-label*="chọn chế độ" i]',
];

async function findVisible(page, selectors, timeout = 3000, { excludeSidebar = false } = {}) {
  const list = Array.isArray(selectors) ? selectors : [selectors];
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const sel of list) {
      const loc = page.locator(sel);
      const count = await loc.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const item = loc.nth(i);
        if (!(await item.isVisible().catch(() => false))) continue;
        if (excludeSidebar) {
          const inSidebar = (await item.evaluate((el, sb) => Boolean(el.closest?.(sb)), SIDEBAR_ANCESTOR_SEL).catch(() => false)) === true;
          if (inSidebar) continue;
        }
        return item;
      }
    }
    await sleep(200);
  }
  return null;
}

async function ensureLoggedIn(page) {
  const url = page.url() || '';
  if (LOGIN_RE.test(url)) {
    throw new Error('Chưa đăng nhập Google trên Chrome Gemini — cửa sổ Chrome vừa được mở lên, hãy đăng nhập tài khoản Google xong bấm chạy lại / Tiếp tục.');
  }
  const editor = await findVisible(page, PROMPT_SELECTORS, 12_000);
  if (editor) return editor;

  const afterUrl = page.url() || '';
  if (LOGIN_RE.test(afterUrl)) {
    throw new Error('Chưa đăng nhập Google trên Chrome Gemini — cửa sổ Chrome vừa được mở lên, hãy đăng nhập tài khoản Google xong bấm chạy lại / Tiếp tục.');
  }
  const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 1200) || '').catch(() => '');
  if (CAPTCHA_RE.test(bodyText)) {
    throw new Error('Google yêu cầu xác minh CAPTCHA trên Chrome Gemini — hãy xác minh trong cửa sổ Chrome vừa mở rồi bấm chạy lại / Tiếp tục.');
  }
  const signInBtn = await findVisible(page, 'a[href*="accounts.google.com"], button:has-text("Sign in"), button:has-text("Đăng nhập")', 1000);
  if (signInBtn) {
    throw new Error('Chưa đăng nhập Google trên Chrome Gemini — cửa sổ Chrome vừa được mở lên, hãy bấm Đăng nhập rồi chạy lại / Tiếp tục.');
  }
  throw new Error('Không thấy ô nhập prompt trên trang Gemini Web — kiểm tra cửa sổ Chrome vừa mở.');
}

function thinkingAliases(level) {
  const s = String(level || '').trim().toLowerCase();
  if (!s) return [];
  if (/trung b[iì]nh|medium/.test(s)) return ['trung bình', 'trung binh', 'medium'];
  if (/th[aấ]p|low/.test(s)) return ['thấp', 'thap', 'low'];
  if (/cao|high/.test(s)) return ['cao', 'high'];
  if (/t[oố]i thi[eể]u|minimal/.test(s)) return ['tối thiểu', 'minimal'];
  return [s];
}

async function pickThinkingControl(page, level) {
  const aliases = thinkingAliases(level);
  if (!aliases.length) return false;
  const sel = '.cdk-overlay-container [role="menuitem"], .cdk-overlay-container [role="menuitemradio"], .cdk-overlay-container [role="option"], .cdk-overlay-container [role="radio"], .cdk-overlay-container [role="tab"], .cdk-overlay-container button, [role="listbox"] [role="option"], [role="menu"] [role="menuitem"]';
  const items = page.locator(sel);
  const count = await items.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const it = items.nth(i);
    if (!(await it.isVisible().catch(() => false))) continue;
    const txt = (await it.innerText().catch(() => '')).replace(/\s+/g, ' ').trim().toLowerCase();
    if (txt && aliases.some((a) => txt.includes(a))) {
      await it.click({ timeout: 3000 });
      await sleep(300);
      return true;
    }
  }
  return false;
}

async function selectModelAndThinking(page, modelName, thinkingLevel, onProgress) {
  const want = String(modelName || '').trim();
  const wantLevel = String(thinkingLevel || '').trim();
  if (!want && !wantLevel) return { selectedModel: '' };

  let btn = await findVisible(page, SWITCHER_SELECTORS, 2500, { excludeSidebar: true });
  if (!btn) {
    // Dự phòng: tìm nút có nhãn chứa tên model phổ biến quanh header/composer
    const candidates = page.locator('button');
    const n = await candidates.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const b = candidates.nth(i);
      if (!(await b.isVisible().catch(() => false))) continue;
      const inSidebar = (await b.evaluate((el, sb) => Boolean(el.closest?.(sb)), SIDEBAR_ANCESTOR_SEL).catch(() => false)) === true;
      if (inSidebar) continue;
      const t = (await b.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      if (/^(gemini\s*)?(2\.|3\.|neon|pro|thinking|flash|fast|nhanh|tư duy)/i.test(t) && t.length < 40) {
        btn = b;
        break;
      }
    }
  }
  if (!btn) {
    onProgress?.('Không thấy nút đổi model trên giao diện Gemini, dùng model mặc định hiện tại.');
    return { selectedModel: '' };
  }

  const currentLabel = (await btn.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  const alreadyMatches = want && currentLabel.toLowerCase().includes(want.toLowerCase());
  let picked = alreadyMatches ? currentLabel : '';

  if (!alreadyMatches || wantLevel) {
    onProgress?.(`Chọn model Gemini: ${want || currentLabel}${wantLevel ? ` (${wantLevel})` : ''}…`);
    await btn.click({ timeout: 5000 });
    await sleep(500);

    const menuSel = '.cdk-overlay-container [role="menuitem"], .cdk-overlay-container [role="menuitemradio"], .cdk-overlay-container [role="option"], [role="menu"] [role="menuitem"], [role="listbox"] [role="option"], .cdk-overlay-container button';
    const items = page.locator(menuSel);
    const count = await items.count().catch(() => 0);
    const visibleItems = [];
    for (let i = 0; i < count; i++) {
      const it = items.nth(i);
      if (!(await it.isVisible().catch(() => false))) continue;
      const txt = (await it.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      if (txt) visibleItems.push({ el: it, text: txt });
    }

    if (want && visibleItems.length > 0 && !alreadyMatches) {
      const wantLow = want.toLowerCase();
      let target = visibleItems.find((x) => x.text.toLowerCase().includes(wantLow));
      if (!target) {
        target = visibleItems.find((x) => /thinking|tư duy|\bpro\b/i.test(x.text));
      }
      if (!target) {
        const available = visibleItems.map((x) => x.text).join(' | ');
        throw new Error(`Không thấy model "${want}" trong menu Gemini Web (đang có: ${available}). Đổi tên model hoặc chọn tay trong cửa sổ Chrome vừa mở.`);
      }
      await target.el.click({ timeout: 4000 });
      picked = target.text;
      await sleep(500);
    }

    if (wantLevel) {
      const levelPicked = await pickThinkingControl(page, wantLevel);
      if (!levelPicked && btn) {
        // Một số giao diện đóng menu sau khi chọn model, thử mở lại menu để chọn cấp độ tư duy nếu có
        const stillClosed = !(await page.locator('.cdk-overlay-container [role="menuitem"], .cdk-overlay-container [role="option"]').first().isVisible().catch(() => false));
        if (stillClosed) {
          await btn.click({ timeout: 3000 }).catch(() => {});
          await sleep(400);
          await pickThinkingControl(page, wantLevel);
          await page.keyboard.press('Escape').catch(() => {});
        }
      }
    } else {
      await page.keyboard.press('Escape').catch(() => {});
    }
  }

  return { selectedModel: picked || currentLabel };
}

async function uploadAudioToGemini(page, filePath, onProgress) {
  if (!filePath) return;
  if (!fs.existsSync(filePath)) throw new Error(`Không tìm thấy file âm thanh để gửi Gemini: ${filePath}`);
  onProgress?.(`Đang tải file nhạc ${path.basename(filePath)} lên Gemini Web…`);

  const uploadBtnSels = [
    '[data-test-id="upload-file-button"], input-area-v2 button[aria-label*="Upload" i], input-area-v2 button[aria-label*="Add file" i], input-area-v2 button[aria-label*="Tải tệp" i], input-area-v2 button[aria-label*="Thêm tệp" i], input-area-v2 button[aria-label*="tải lên" i], .input-area button[aria-label*="Upload" i], .input-area button[aria-label*="tải lên" i]',
    'input-area-v2 button:has(mat-icon[fonticon="plus"]), .input-area button:has(mat-icon[fonticon="plus"])',
    'button[aria-label*="Upload" i], button[aria-label*="Add file" i], button[aria-label*="Open upload" i], button[aria-label*="Tải tệp" i], button[aria-label*="Thêm tệp" i], button[aria-label*="Tải lên" i]',
  ];
  const uploadBtn = await findVisible(page, uploadBtnSels, 4000, { excludeSidebar: true });

  let attached = false;
  if (uploadBtn) {
    const fcPromise = page.waitForEvent('filechooser', { timeout: 3500 }).catch(() => null);
    await uploadBtn.click({ timeout: 4000 });
    const fcImmediate = await fcPromise;
    if (fcImmediate) {
      await fcImmediate.setFiles(filePath);
      attached = true;
    } else {
      await sleep(400);
      const menuSel = '.cdk-overlay-container [role="menuitem"], .cdk-overlay-container button, [role="menu"] [role="menuitem"]';
      const menuItems = page.locator(menuSel);
      const n = await menuItems.count().catch(() => 0);
      for (let i = 0; i < n; i++) {
        const it = menuItems.nth(i);
        if (!(await it.isVisible().catch(() => false))) continue;
        const txt = (await it.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
        if (/upload file|upload from|tải tệp|tải lên từ|máy tính|device/i.test(txt)) {
          const [fc] = await Promise.all([
            page.waitForEvent('filechooser', { timeout: 6000 }).catch(() => null),
            it.click({ timeout: 4000 }),
          ]);
          if (fc) {
            await fc.setFiles(filePath);
            attached = true;
          }
          break;
        }
      }
    }
  }

  if (!attached) {
    const input = page.locator('input[type="file"]').last();
    if ((await input.count().catch(() => 0)) > 0) {
      await input.setInputFiles(filePath);
      attached = true;
    }
  }

  if (!attached) {
    throw new Error('Không tìm thấy nút đính kèm file MP3 trên giao diện Gemini Web.');
  }

  const base = path.parse(filePath).name;
  // Chờ chip file xuất hiện hoặc hết spinner upload (tối đa 25s)
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const ready = await page.evaluate((b) => {
      const hasChip = document.body?.innerText?.includes(b);
      const spinning = !!document.querySelector('[role="progressbar"], mat-progress-spinner, mat-spinner');
      return hasChip && !spinning;
    }, base).catch(() => false);
    if (ready) break;
    await sleep(600);
  }
  await sleep(600);
}

async function fillPromptAndSubmit(page, editor, prompt, onProgress) {
  onProgress?.('Đang gửi prompt yêu cầu phân tích từng giây…');
  await editor.click({ timeout: 4000 });
  await sleep(150);

  // Thử fill trước (nhanh, nguyên khối); nếu Angular editor không nhận thì fallback keyboard.insertText
  await editor.fill(prompt).catch(() => {});
  const curLen = await editor.evaluate((el) => (el.value ?? el.textContent ?? '').trim().length).catch(() => 0);
  if (curLen < Math.min(20, prompt.length)) {
    await editor.click({ timeout: 3000 }).catch(() => {});
    await page.keyboard.insertText(prompt);
  }
  await sleep(300);

  const sendSels = [
    'input-area-v2 button[aria-label="Send message" i], input-area-v2 button[aria-label="Gửi tin nhắn" i], input-area-v2 button[aria-label="Send" i], input-area-v2 button[aria-label="Gửi" i], input-area-v2 button.send-button, .input-area button[aria-label="Send message" i], .input-area button[aria-label="Gửi tin nhắn" i], .input-area button[aria-label="Send" i], .input-area button[aria-label="Gửi" i], .input-area button.send-button',
    'input-area-v2 button:not(.back-to-bottom-fab):has(mat-icon[fonticon="arrow_upward"]), input-area-v2 button:has(mat-icon[fonticon="send"]), .input-area button:not(.back-to-bottom-fab):has(mat-icon[fonticon="arrow_upward"]), .input-area button:has(mat-icon[fonticon="send"]), input-container button.send-button',
    'button[aria-label="Send message" i], button[aria-label="Gửi tin nhắn" i], button[aria-label="Send" i], button[aria-label="Gửi" i], button.send-button',
  ];
  const sendBtn = await findVisible(page, sendSels, 3000, { excludeSidebar: true });
  const ariaDisabled = sendBtn ? await sendBtn.getAttribute?.('aria-disabled').catch(() => null) : null;
  if (sendBtn && ariaDisabled !== 'true' && (await sendBtn.isEnabled().catch(() => false))) {
    await sendBtn.click({ timeout: 4000 });
  } else {
    await editor.click({ timeout: 2000 }).catch(() => {});
    await page.keyboard.press('Enter');
  }
}

const RESPONSE_SEL = 'model-response, [data-response-id], message-content, .model-response-text';
const STOP_SEL = [
  'input-area-v2 button[aria-label*="Stop" i]',
  'input-area-v2 button[aria-label*="Dừng" i]',
  'input-area-v2 button[aria-label*="Ngừng" i]',
  'input-area-v2 button[aria-label*="Hủy" i]',
  'input-area-v2 button:has(mat-icon[fonticon="stop"])',
  'input-area-v2 button:has(mat-icon[fonticon="stop_circle"])',
  '.input-area button[aria-label*="Stop" i]',
  '.input-area button[aria-label*="Dừng" i]',
  '.input-area button[aria-label*="Ngừng" i]',
  '.input-area button:has(mat-icon[fonticon="stop"])',
  '.input-area button:has(mat-icon[fonticon="stop_circle"])',
  'input-container button[aria-label*="Stop" i]',
  'input-container button[aria-label*="Dừng" i]',
  'input-container button:has(mat-icon[fonticon="stop"])',
  'button[aria-label*="Stop generating" i]',
  'button[aria-label*="Stop response" i]',
  'button[aria-label*="Dừng tạo" i]',
  'button[aria-label*="Dừng phản hồi" i]',
  'button[aria-label*="Ngừng phản hồi" i]',
  'button[aria-label*="Ngừng tạo" i]',
  'button.stop-button',
].join(', ');

/** Tách các nhãn tiêu đề mặc định của UI Gemini để kiểm tra phản hồi đã có nội dung thật hay chưa. */
export function stripResponseBoilerplate(text) {
  return String(text || '')
    .replace(/^(Gemini đã nói|Gemini said|Hiển thị quá trình tư duy|Show thinking|Đang suy nghĩ|Thinking\.{0,3}|JSON)\s*$/gim, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function findBalancedJsonObjects(text) {
  const src = String(text || '');
  const out = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let escaped = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(src.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return out;
}

/** Gom các ứng viên JSON theo thứ tự ưu tiên từ cuối về đầu (codeBlocks sạch -> fence -> cân bằng ngoặc -> fallback). */
export function collectJsonCandidates(rawText, codeBlocks = []) {
  const src = String(rawText || '').trim();
  const candidates = [];

  if (src) {
    const firstBrace = src.indexOf('{');
    const lastBrace = src.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      candidates.push(src.slice(firstBrace, lastBrace + 1));
    }
    for (const objStr of findBalancedJsonObjects(src)) {
      candidates.push(objStr);
    }
    const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
    for (const m of src.matchAll(fenceRe)) {
      const inner = m[1]?.trim();
      if (inner) candidates.push(inner);
    }
  }

  for (const block of Array.isArray(codeBlocks) ? codeBlocks : []) {
    const b = String(block || '').trim();
    if (b) candidates.push(b);
  }

  return candidates;
}

/** Kiểm tra phản hồi đã chứa ít nhất 1 JSON object parse được hay chưa. */
export function hasParseableJsonObject(rawText, codeBlocks = []) {
  const candidates = collectJsonCandidates(rawText, codeBlocks);
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(candidates[i]);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return true;
    } catch {
      /* chưa hoàn chỉnh */
    }
  }
  return false;
}

async function waitForGeminiResponse(page, beforeCount, timeoutMs, onProgress, { expectJson = false } = {}) {
  onProgress?.('Gemini Web đang nghe file MP3 và suy luận từng giây…');
  const deadline = Date.now() + timeoutMs;
  let lastText = '';
  let stableRounds = 0;

  while (Date.now() < deadline) {
    await sleep(1200);
    const snap = await page.evaluate(({ respSel, stopSel, sidebarSel, prev }) => {
      const isVis = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const stopBtn = [...document.querySelectorAll(stopSel)].find((b) => !b.closest?.(sidebarSel) && isVis(b));
      const topResps = [...document.querySelectorAll('model-response')];
      const list = topResps.length ? topResps : [...document.querySelectorAll(respSel)];
      if (list.length <= prev && !stopBtn) {
        return { hasNew: false, generating: false, hasActions: false, text: '', codes: [] };
      }
      const last = list.at(-1);
      if (!last) {
        return { hasNew: false, generating: !!stopBtn, hasActions: false, text: '', codes: [] };
      }

      const spinner = [...last.querySelectorAll('[role="progressbar"], mat-progress-spinner, mat-spinner')].some(isVis);
      const actionSel = 'message-actions button, button[aria-label="Sao chép"], button[aria-label="Copy"], button[aria-label="Câu trả lời tốt"], button[aria-label="Good response"], button[aria-label="Khôi phục"], button[aria-label="Redo"]';
      const hasActions = [...last.querySelectorAll(actionSel)].some(isVis);

      const seenCodes = new Set();
      const rawNodes = [...last.querySelectorAll('code-block pre code, pre code, pre')];
      const outsideThought = rawNodes.filter((n) => !n.closest?.('model-thoughts'));
      const pickedNodes = outsideThought.length ? outsideThought : rawNodes;
      const codes = [];
      for (const node of pickedNodes) {
        const c = (node.innerText || node.textContent || '').trim();
        if (c && !seenCodes.has(c)) {
          seenCodes.add(c);
          codes.push(c);
        }
      }

      const text = (last.innerText || last.textContent || '').trim();
      return {
        hasNew: list.length > prev,
        generating: !!stopBtn || spinner,
        hasActions,
        text,
        codes,
      };
    }, { respSel: RESPONSE_SEL, stopSel: STOP_SEL, sidebarSel: SIDEBAR_ANCESTOR_SEL, prev: beforeCount })
      .catch(() => ({ hasNew: false, generating: false, hasActions: false, text: '', codes: [] }));

    if (!snap.hasNew && !snap.generating) continue;
    const candidate = snap.codes.at(-1) || snap.text;
    const hasBody = snap.codes.length > 0 || stripResponseBoilerplate(snap.text).length >= 20;

    if (snap.generating) {
      stableRounds = 0;
      if (candidate) lastText = candidate;
      continue;
    }
    if (!hasBody && !snap.hasActions) {
      stableRounds = 0;
      continue;
    }

    if (candidate && candidate === lastText) {
      stableRounds++;
      const jsonReady = hasParseableJsonObject(snap.text, snap.codes);
      if (expectJson) {
        if (jsonReady && (stableRounds >= 2 || (snap.hasActions && stableRounds >= 1))) {
          return { rawText: snap.text || candidate, codeBlocks: snap.codes };
        }
        if (snap.hasActions && hasBody && stableRounds >= 3) {
          return { rawText: snap.text || candidate, codeBlocks: snap.codes };
        }
      } else {
        const done = jsonReady
          ? stableRounds >= 2
          : (snap.hasActions ? stableRounds >= 2 : (hasBody && stableRounds >= 3));
        if (done) {
          return { rawText: snap.text || candidate, codeBlocks: snap.codes };
        }
      }
    } else {
      lastText = candidate;
      stableRounds = 0;
    }
  }

  throw new Error(`Gemini Web không trả kết quả sau ${Math.round(timeoutMs / 1000)} giây.`);
}

async function executeGeminiWebPrompt(opts) {
  const {
    filePath = null,
    prompt,
    modelName = 'Neon',
    thinkingLevel = 'Trung bình',
    url = DEFAULT_GEMINI_WEB_URL,
    timeoutMs = 180_000,
    onProgress = () => {},
    context = null,
    showOnError = true,
    expectJson = false,
  } = opts || {};

  if (!String(prompt || '').trim()) throw new Error('Thiếu prompt gửi Gemini Web');

  const isMock = !!context;
  const targetUrl = String(url || '').trim() || DEFAULT_GEMINI_WEB_URL;
  const ctx = context || (await connectGeminiBrowser({ visible: false, url: targetUrl })).ctx;
  const page = isMock
    ? (ctx.pages()[0] || (await ctx.newPage()))
    : await geminiPage(ctx);

  try {
    onProgress?.('Đang mở cuộc trò chuyện mới trên Gemini Web (chạy ngầm)…');
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});

    const editor = await ensureLoggedIn(page);
    const { selectedModel } = await selectModelAndThinking(page, modelName, thinkingLevel, onProgress);

    if (filePath) await uploadAudioToGemini(page, filePath, onProgress);

    const mrCount = await page.locator('model-response').count().catch(() => 0);
    const beforeCount = mrCount > 0 ? mrCount : await page.locator(RESPONSE_SEL).count().catch(() => 0);
    await fillPromptAndSubmit(page, editor, prompt, onProgress);

    const { rawText, codeBlocks } = await waitForGeminiResponse(page, beforeCount, timeoutMs, onProgress, { expectJson });
    if (!isMock && ownMode === 'visible') await setWindowState(ctx, page, 'minimized');
    return { rawText, codeBlocks, selectedModel };
  } catch (err) {
    if (showOnError) {
      if (isMock) {
        await setWindowState(ctx, page, 'normal');
      } else {
        const needsLogin = /Chưa đăng nhập Google/i.test(err?.message || '');
        const errTarget = needsLogin ? GOOGLE_LOGIN_URL : targetUrl;
        if (ownMode === 'headless') {
          await closeGeminiBrowser();
          await showGeminiWindow(errTarget).catch(() => {});
        } else {
          if (needsLogin && !LOGIN_RE.test(page.url() || '')) {
            await page.goto(errTarget, { waitUntil: 'domcontentloaded' }).catch(() => {});
          }
          await setWindowState(ctx, page, 'normal');
        }
      }
    }
    throw err;
  }
}

/**
 * Chạy 1 prompt (+ đính kèm file MP3 tuỳ chọn) trên Gemini Web theo hàng đợi tuần tự.
 * Bình thường chạy ngầm hoàn toàn (`--headless=new`); chỉ mở cửa sổ Chrome thật nếu phát sinh lỗi.
 */
export function runGeminiWebPrompt(opts = {}) {
  const job = queue.then(() => executeGeminiWebPrompt(opts));
  queue = job.then(() => {}, () => {});
  return job;
}
