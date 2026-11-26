// Tự động hoá Google Flow bằng Playwright.
// Chrome được mở bằng 1 hồ sơ (profile) riêng trong data/flow-chrome; bạn tự đăng nhập Google trong cửa sổ đó.
// Playwright chỉ kết nối vào cửa sổ Chrome này để thao tác trên trang Flow.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { DATA_DIR, db } from './db.js';

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

export const chromePath = () => CHROME_PATHS.find((p) => fs.existsSync(p));

async function isRunning() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

const escapeXml = (s) =>
  String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Tìm PID tiến trình gốc Chrome/Edge đang mở hồ sơ Flow (--remote-debugging-port=9333)
function getFlowChromePid() {
  if (process.platform !== 'win32') return null;
  try {
    const cmd = "$p = Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' OR Name='msedge.exe'\" | Where-Object { $_.CommandLine -match '--remote-debugging-port=9333' -and $_.CommandLine -notmatch '--type=' } | Select-Object -First 1; if ($p) { $p.ProcessId }";
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim();
    const pid = Number(out);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

// Chạy lệnh trên desktop tương tác (WinSta0\Default) qua Task Scheduler InteractiveToken, đợi kết quả rồi tự dọn sạch.
async function runInteractiveTask(command, argLine, { taskName = 'WebVideoFlowTask', waitFile = null, timeoutMs = 4000 } = {}) {
  if (process.platform !== 'win32') return false;
  const uniqTask = `${taskName}_${process.pid}`;
  const xmlPath = path.join(os.tmpdir(), `wv-flow-${taskName}-${process.pid}-${Date.now()}.xml`);
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
      <Command>${escapeXml(command)}</Command>
      <Arguments>${escapeXml(argLine)}</Arguments>
    </Exec>
  </Actions>
</Task>`;
  try {
    fs.writeFileSync(xmlPath, Buffer.from(`\uFEFF${xml}`, 'utf16le'));
    execFileSync('schtasks', ['/create', '/tn', uniqTask, '/xml', xmlPath, '/f'], { stdio: 'ignore', windowsHide: true });
    execFileSync('schtasks', ['/run', '/tn', uniqTask], { stdio: 'ignore', windowsHide: true });
    if (waitFile) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline && !fs.existsSync(waitFile)) await sleep(100);
      if (fs.existsSync(waitFile)) await sleep(80);
    } else {
      await sleep(500);
    }
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(xmlPath, { force: true });
    try { execFileSync('schtasks', ['/delete', '/tn', uniqTask, '/f'], { stdio: 'ignore', windowsHide: true }); } catch {}
  }
}

// Trên Windows, chạy qua Task Scheduler (InteractiveToken) để cửa sổ Chrome hiện rõ ràng trên Desktop tương tác
async function launchVisibleViaTaskScheduler(exe, args) {
  const argLine = args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '')}"` : a)).join(' ');
  return runInteractiveTask(exe, argLine, { taskName: 'WebVideoFlowChrome' });
}

// Đóng êm Chrome Flow qua CDP (lưu sạch cookie/session vào data/flow-chrome) để mở lại đúng trên màn hình chính.
export async function closeFlowBrowser() {
  const b = browser;
  browser = null;
  try {
    const conn = b?.isConnected?.()
      ? b
      : (await isRunning())
        ? await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`).catch(() => null)
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
  for (let i = 0; i < 50 && (await isRunning()); i++) await sleep(100);
}

// Mở cửa sổ Chrome riêng cho Flow (nếu đã mở thì đưa lên màn hình chính)
export async function launchChrome({ url = '' } = {}) {
  if (await isRunning()) {
    await showFlowWindow({ launchIfStopped: false }).catch(() => {});
    return { alreadyRunning: true };
  }
  const exe = chromePath();
  if (!exe) throw new Error('Không tìm thấy Chrome/Edge trên máy');
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const targetUrl = url ? withEn(url) : withEn(FLOW_URL);
  const launchArgs = [`--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE_DIR}`, '--no-first-run', '--no-default-browser-check', '--lang=en-US', targetUrl];

  // Trên Windows, kích hoạt qua Task Scheduler để cửa sổ Chrome hiện rõ ràng trên Desktop tương tác (WinSta0\Default)
  if (process.platform === 'win32') {
    if (!url) {
      try {
        execFileSync('schtasks', ['/run', '/tn', 'FlowChrome'], { stdio: 'ignore', windowsHide: true });
        for (let i = 0; i < 15; i++) {
          await sleep(500);
          if (await isRunning()) return { alreadyRunning: false };
        }
      } catch {}
    }
    if (await launchVisibleViaTaskScheduler(exe, launchArgs)) {
      for (let i = 0; i < 20; i++) {
        await sleep(400);
        if (await isRunning()) return { alreadyRunning: false };
      }
    }
  }

  const p = spawn(exe, launchArgs, { detached: true, stdio: 'ignore' });
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
    await page.goto(withEn(FLOW_URL), { waitUntil: 'domcontentloaded' });
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
// imageQuality: '2K' | '4K' -> tải bản Flow phóng to (menu Download) thay vì ảnh gốc 1K
export const generateImage = (opts) => generate({ ...opts, kind: 'image' });

export const PRIMARY_WINDOW_BOUNDS = { left: 100, top: 60, width: 1320, height: 880 };
export function shouldRecenterBounds(bounds) {
  if (!bounds || typeof bounds.left !== 'number') return false;
  return bounds.left < 0 || bounds.left >= 1800 || (typeof bounds.top === 'number' && bounds.top < -50);
}
export const shouldRelaunchOnDesktop = (actResult) => actResult === 'not_on_default_desktop';

// Kích hoạt cửa sổ Chrome có PID cho trước ngay trên desktop tương tác (WinSta0\Default), không nháy CMD.
async function activateWindowOnInteractiveDesktop(pid) {
  if (process.platform !== 'win32' || !pid) return 'error';
  const stamp = `${process.pid}-${Date.now()}`;
  const psPath = path.join(os.tmpdir(), `wv-flow-act-${stamp}.ps1`);
  const vbsPath = path.join(os.tmpdir(), `wv-flow-act-${stamp}.vbs`);
  const outPath = path.join(os.tmpdir(), `wv-flow-act-${stamp}.txt`);
  const escPs = (s) => String(s).replace(/'/g, "''");
  const psScript = `
$res = 'ERROR'
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class WinAct {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  public static IntPtr FindTop(uint target) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint p;
      GetWindowThreadProcessId(h, out p);
      if (p == target && GetWindow(h, 4) == IntPtr.Zero && (IsWindowVisible(h) || IsIconic(h))) {
        found = h;
        return false;
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@
  $hwnd = [WinAct]::FindTop(${Number(pid)})
  if ($hwnd -eq [IntPtr]::Zero) {
    $res = 'NOT_ON_DEFAULT_DESKTOP'
  } else {
    if ([WinAct]::IsIconic($hwnd)) { [WinAct]::ShowWindow($hwnd, 9) | Out-Null }
    [WinAct]::SwitchToThisWindow($hwnd, $true)
    [WinAct]::BringWindowToTop($hwnd) | Out-Null
    [WinAct]::SetForegroundWindow($hwnd) | Out-Null
    $res = "ACTIVATED:$hwnd"
  }
} catch {
  $res = 'ERROR'
}
Set-Content -Path '${escPs(outPath)}' -Value $res -Encoding ASCII
`;
  const vbsScript = `CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File ""${psPath.replace(/"/g, '""')}""", 0, True\r\n`;
  try {
    fs.writeFileSync(psPath, psScript, 'utf8');
    fs.writeFileSync(vbsPath, vbsScript, 'utf8');
    await runInteractiveTask('wscript.exe', `//B //Nologo "${vbsPath}"`, { taskName: 'WebVideoFlowActivate', waitFile: outPath, timeoutMs: 5000 });
    if (!fs.existsSync(outPath)) return 'error';
    const raw = fs.readFileSync(outPath, 'utf8').trim();
    if (raw.startsWith('ACTIVATED:')) return 'activated';
    if (raw === 'NOT_ON_DEFAULT_DESKTOP') return 'not_on_default_desktop';
    return 'error';
  } catch {
    return 'error';
  } finally {
    fs.rmSync(psPath, { force: true });
    fs.rmSync(vbsPath, { force: true });
    fs.rmSync(outPath, { force: true });
  }
}

// Đưa cửa sổ Chrome của Flow lên màn hình (hủy thu nhỏ / đẩy lên trước cửa sổ khác) qua CDP, giữ nguyên vị trí màn hình.
export async function raiseWindowViaCdp(ctx, page) {
  let cur = null;
  if (ctx && page && typeof ctx.newCDPSession === 'function') {
    let cdp = null;
    try {
      cdp = await ctx.newCDPSession(page);
      const { windowId, bounds } = await cdp.send('Browser.getWindowForTarget');
      cur = bounds?.windowState || 'normal';
      if (cur === 'minimized') {
        await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
      } else if (cur === 'normal' || cur === 'maximized') {
        await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
        await sleep(80);
        await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: cur } });
      }
    } catch {
    } finally {
      await cdp?.detach?.().catch(() => {});
    }
  }
  if (typeof page?.bringToFront === 'function') await page.bringToFront().catch(() => {});
  return { ok: true, previousState: cur };
}

let lastShowAt = 0;
let showingPromise = null;
/** Đưa cửa sổ Chrome Flow lên màn hình chính WinSta0\Default (khi Flow báo lỗi hoặc người dùng chủ động bấm mở). */
export async function showFlowWindow({ reason = '', launchIfStopped = true } = {}) {
  if (process.env.FLOW_NO_SHOW === '1') return { ok: false, skipped: true };
  if (showingPromise) return showingPromise;
  if (reason && Date.now() - lastShowAt < 3000) return { ok: true, debounced: true };
  if (reason) {
    lastShowAt = Date.now();
    console.warn(`[Flow] Lỗi — tự mở cửa sổ Chrome của Flow để bạn xem/điều chỉnh: ${String(reason).slice(0, 180)}`);
  }
  showingPromise = (async () => {
    if (!(await isRunning())) {
      if (!launchIfStopped) return { ok: false, running: false };
      await launchChrome({ url: db.settings?.flowProjectUrl || FLOW_URL });
      if (process.platform === 'win32') {
        const pid = getFlowChromePid();
        if (pid) await activateWindowOnInteractiveDesktop(pid).catch(() => {});
      }
      return { ok: true, launched: true };
    }
    const b = await connect();
    const ctx = b.contexts()[0];
    if (!ctx) return { ok: false, error: 'Không kết nối được Chrome của Flow' };
    let page = ctx.pages().find((p) => isFlowUrl(p.url())) || ctx.pages()[0];
    const currentUrl = (page && isFlowUrl(page.url()) ? page.url() : '') || (db.settings?.flowProjectUrl ? withEn(db.settings.flowProjectUrl) : withEn(FLOW_URL));
    if (page) await page.bringToFront().catch(() => {});

    if (process.platform === 'win32') {
      const pid = getFlowChromePid();
      const act = pid ? await activateWindowOnInteractiveDesktop(pid) : 'error';
      if (act === 'activated') {
        try {
          if (page && typeof ctx.newCDPSession === 'function') {
            const cdp = await ctx.newCDPSession(page);
            try {
              const { windowId, bounds } = await cdp.send('Browser.getWindowForTarget');
              if (bounds?.windowState === 'minimized') {
                await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
                await activateWindowOnInteractiveDesktop(pid).catch(() => {});
              }
            } finally {
              await cdp.detach().catch(() => {});
            }
          }
        } catch {}
        return { ok: true, activated: true, url: page?.url() || currentUrl };
      }

      if (shouldRelaunchOnDesktop(act)) {
        console.warn('[Flow] Chrome của Flow đang chạy trên desktop ẩn — đóng êm và mở lại trên màn hình chính để bạn xem/điều chỉnh.');
        await closeFlowBrowser();
        await launchChrome({ url: currentUrl });
        const nb = await connect();
        const nctx = nb.contexts()[0];
        let npage = nctx?.pages()?.find((p) => isFlowUrl(p.url())) || nctx?.pages()?.[0];
        if (!npage) npage = await flowPage();
        await npage.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
        if (nctx && typeof nctx.newCDPSession === 'function') {
          let cdp = null;
          try {
            cdp = await nctx.newCDPSession(npage);
            const { windowId, bounds } = await cdp.send('Browser.getWindowForTarget');
            if (shouldRecenterBounds(bounds)) {
              if (bounds?.windowState && bounds.windowState !== 'normal') {
                await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
              }
              await cdp.send('Browser.setWindowBounds', { windowId, bounds: PRIMARY_WINDOW_BOUNDS });
            }
          } catch {
          } finally {
            await cdp?.detach?.().catch(() => {});
          }
        }
        await npage.bringToFront().catch(() => {});
        const newPid = getFlowChromePid();
        if (newPid) await activateWindowOnInteractiveDesktop(newPid).catch(() => {});
        return { ok: true, relaunchedOnDesktop: true, url: npage?.url() || currentUrl };
      }
    }

    if (!page) page = await flowPage();
    await raiseWindowViaCdp(ctx, page);
    return { ok: true, url: page?.url() || currentUrl };
  })().finally(() => {
    showingPromise = null;
  });
  return showingPromise;
}

// Chạy thao tác Flow; bình thường chạy ngầm như cũ, chỉ tự bật cửa sổ Chrome Flow khi phát sinh lỗi thật (trừ dryRun / người dùng huỷ).
export async function runFlowWithErrorShow(fn, { isCancelled, dryRun = false, show = showFlowWindow } = {}) {
  try {
    return await fn();
  } catch (err) {
    if (!dryRun && !isCancelled?.()) {
      await Promise.resolve(show({ reason: err?.message || String(err) })).catch(() => {});
    }
    throw err;
  }
}

// Chỉ có 1 trang Flow dùng chung: lần tạo (generate) và "cấu hình sẵn" (preset, do giao diện gọi khi mở module / đổi lựa
// chọn) không được thao tác cùng lúc — preset mở rồi đóng bảng cài đặt (phím Escape) ngay dưới tay job đang chọn model,
// job mất nút "Select model family" và lỗi sau 30s. Đang tạo -> preset bỏ qua; preset đang chạy -> lần tạo chờ nó xong.
let flowBusy = 0; // số lần tạo đang thao tác trên trang Flow
let presetRunning = null; // lần cấu hình sẵn đang chạy (Promise) hoặc null
async function generate(opts) {
  flowBusy++;
  try {
    if (presetRunning) await presetRunning.catch(() => {});
    return await runFlowWithErrorShow(() => generateOnPage(opts), {
      isCancelled: opts?.isCancelled,
      dryRun: !!opts?.dryRun,
    });
  } finally {
    flowBusy--;
  }
}

// Ô prompt của Flow là trình soạn thảo ProseMirror; thẻ mention là <span class="mention-chip" contenteditable="false">tên ảnh</span>
const PROMPT_BOX = 'What do you want to create?';
const CHIP_SEL = 'span.mention-chip';
const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// Đọc ô prompt: chữ thường (mỗi chip thay bằng ký hiệu \u0001) + danh sách tên chip theo thứ tự
async function readPromptBox(page) {
  const box = page.getByRole('textbox', { name: PROMPT_BOX });
  return box.evaluate((el, sel) => {
    const clone = el.cloneNode(true);
    const chips = [...clone.querySelectorAll(sel)].map((c) => (c.textContent || '').trim());
    for (const c of clone.querySelectorAll(sel)) c.replaceWith('\u0001');
    return { text: clone.textContent || '', chips };
  }, CHIP_SEL).catch(() => ({ text: '', chips: [] }));
}

// Gõ "@" mở popup chọn ảnh và bấm đúng ảnh `key`; thử lại tối đa 3 lần, dọn dấu "@" thừa nếu popup không mở.
// Trả về true khi ô prompt có thêm đúng 1 chip; ném lỗi nếu không gắn được (không chèn chữ "@ImageN" thường
// vì Flow không hiểu, video sẽ sai và tốn credit).
async function insertMentionChip(page, key, part, log) {
  const popover = page.locator('flow-add-menu-popover-content');
  const chipCount = async () => (await readPromptBox(page)).chips.length;
  const removeStrayAt = async () => {
    const { text } = await readPromptBox(page);
    if (/@\s*$/.test(text)) await page.keyboard.press('Backspace');
  };
  for (let attempt = 1; attempt <= 3; attempt++) {
    const before = await chipCount();
    await sleep(150); // để ProseMirror xử lý xong chữ vừa chèn, nếu không popup @ thỉnh thoảng không mở
    await page.keyboard.type('@');
    const open = await popover.isVisible({ timeout: 3000 }).catch(() => false);
    if (!open) {
      log(`Popup @ không mở (lần ${attempt}) cho ${part}, thử lại`);
      await removeStrayAt();
      await sleep(800);
      continue;
    }
    const search = popover.locator('input.search-input');
    if (await search.isVisible({ timeout: 1500 }).catch(() => false)) {
      await search.fill(key);
      await sleep(600);
    }
    // Ưu tiên ô ảnh có đúng tên; nếu popup không lọc theo tên thì lấy ô đầu tiên
    let itemBtn = popover.locator('button.asset-item', { hasText: key }).first();
    if (!(await itemBtn.isVisible({ timeout: 5000 }).catch(() => false))) itemBtn = popover.locator('button.asset-item').first();
    if (await itemBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await itemBtn.click();
      await sleep(500);
      const addBtn = popover.getByRole('button', { name: 'Add to prompt' });
      if (await addBtn.isVisible().catch(() => false)) {
        await addBtn.click();
        await sleep(300);
      }
      if (await popover.isVisible().catch(() => false)) {
        await page.keyboard.press('Escape');
        await sleep(200);
      }
      if ((await chipCount()) === before + 1) return true;
      log(`Bấm ảnh "${key}" nhưng chip chưa vào ô prompt (lần ${attempt}), thử lại`);
    } else {
      log(`Không thấy ảnh "${key}" trong popup @ (lần ${attempt}), thử lại`);
      await page.keyboard.press('Escape');
      await sleep(200);
    }
    await removeStrayAt();
    await sleep(600);
  }
  throw new Error(`Không gắn được thẻ ${part} ("${key}") vào ô prompt Flow`);
}

// Gõ prompt và kích hoạt popup @ để gắn thẻ mention-chip chính thức của Google Flow.
// Sau khi gõ xong đối chiếu lại nội dung ô prompt với prompt gốc (chữ + số chip + tên chip); lệch thì xoá và gõ lại
// (tối đa 2 lần) — không bao giờ bấm tạo với prompt bị thiếu chip hay mất chữ.
async function fillPromptWithMentions(page, prompt, items, log) {
  // Chuẩn hoá các thẻ mention để Flow nhận diện chính xác 100%
  const normalized = (prompt || '')
    .replace(/\bth?@+Image(\d+)/gi, 'the @Image$1')
    .replace(/@+Image(\d+)/gi, '@Image$1')
    .replace(/([^\s\n])@Image(\d+)/g, '$1 @Image$2')
    .replace(/@Image(\d+)([a-zA-Z])/g, '@Image$1 $2')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

  const parts = normalized.split(/(@Image\d+)/g);
  const keyFor = (part) => {
    const m = part.match(/^@Image(\d+)$/);
    if (!m) return null;
    const target = items[parseInt(m[1], 10) - 1];
    return target ? path.parse(target.file || target.src).name : null;
  };
  // Thẻ không ứng với ảnh nào (vd. @Image5 mà chỉ có 4 ảnh) -> giữ chữ thường.
  // Flow tự thêm dấu cách sau chip, xuống dòng (<br>) không có trong textContent -> so sánh bỏ hết khoảng trắng
  const norm = (s) => String(s || '').replace(/\s+/g, '');
  const expectedText = norm(parts.map((p) => (keyFor(p) ? '\u0001' : p)).join(''));
  const expectedKeys = parts.map(keyFor).filter(Boolean);
  // ProseMirror của Flow: insertText một đoạn CÓ xuống dòng thì ký tự cuối bị đẩy ra cuối tài liệu và con trỏ lệch
  // ("Th[chip] model" ... "toege" ở cuối), còn insertText("\n") riêng thì bị bỏ qua -> xuống dòng bằng Shift+Enter,
  // mỗi dòng chèn phần chữ rồi gõ khoảng trắng cuối bằng phím để con trỏ chắc chắn nằm sau nó (dấu "@" gõ tiếp
  // phải đứng sau dấu cách thì Flow mới mở popup chọn ảnh).
  const insertText = async (text) => {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) await page.keyboard.press('Shift+Enter');
      const m = lines[i].match(/^([\s\S]*?)([ \t]*)$/);
      if (m[1]) await page.keyboard.insertText(m[1]);
      if (m[2]) await page.keyboard.type(m[2]);
    }
  };

  let lastDiff = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    await dismissOverlays(page);
    const clear = page.getByRole('button', { name: 'Clear prompt' });
    if (await clear.isVisible().catch(() => false)) await clear.click();
    await sleep(400);

    const box = page.getByRole('textbox', { name: PROMPT_BOX });
    await box.click();
    await sleep(300);

    let afterChip = false;
    for (const part of parts) {
      const key = keyFor(part);
      if (key) {
        log(`Gắn mention: ${part} → "${key}"`);
        await insertMentionChip(page, key, part, log);
        afterChip = true;
      } else if (part) {
        // Flow đã tự thêm 1 dấu cách sau chip -> bỏ dấu cách đầu của đoạn chữ kế tiếp
        await insertText(afterChip ? part.replace(/^ /, '') : part);
        afterChip = false;
      }
    }
    await sleep(500);

    const got = await readPromptBox(page);
    const gotText = norm(got.text);
    const chipOk = got.chips.length === expectedKeys.length
      && got.chips.every((c, i) => c.toLowerCase().startsWith(expectedKeys[i].toLowerCase()));
    if (gotText === expectedText && chipOk) {
      log(`Đã gõ prompt vào Flow, ${got.chips.length} thẻ @Image khớp ảnh`);
      return;
    }
    if (!chipOk) lastDiff = `chip: có ${got.chips.length}/${expectedKeys.length} (${got.chips.join(', ')})`;
    else {
      let i = 0;
      while (i < gotText.length && i < expectedText.length && gotText[i] === expectedText[i]) i++;
      lastDiff = `chữ lệch từ vị trí ${i}: "...${expectedText.slice(Math.max(0, i - 15), i + 25)}" nhưng Flow có "...${gotText.slice(Math.max(0, i - 15), i + 25)}"`;
    }
    log(`Prompt trên Flow không khớp prompt gốc (lần ${attempt}): ${lastDiff.replace(/\u0001/g, '[chip]')}`);
  }
  throw new Error(`Prompt gõ vào Flow bị lệch sau 2 lần thử (${lastDiff.replace(/\u0001/g, '[chip]')}) — không bấm tạo để khỏi tốn credit`);
}

async function generateOnPage({ settings, prompt, video, images = [], outputFile, log = () => {}, onResult = () => {}, dryRun = false, kind = 'video', isCancelled, imageQuality = null }) {
  const page = await flowPage();
  await page.bringToFront();
  if (page.url().includes('/about') || page.url().includes('accounts.google.com')) {
    throw new Error('Chưa đăng nhập Flow — mở cửa sổ Chrome của Flow và đăng nhập trước.');
  }
  await openProject(page, settings);
  if (kind === 'video' && !dryRun) {
    // Công tắc "Trả về video không có âm thanh" theo Cài đặt; lỗi ở đây chỉ ghi cảnh báo, không làm hỏng job
    const audio = await applyAudioPref(page, settings).catch((e) => `chưa chỉnh được (${e.message})`);
    if (audio) log(`Âm thanh video: ${audio}`);
  }

  // Mỗi nguyên liệu là 1 file tải lên (tên = mã băm nội dung -> cùng 1 ảnh/video thì luôn cùng tên trên Flow,
  // nhờ đó lần sau nhận ra file đã có trong thư viện và không tải lên lại).
  // Thứ tự trong ô prompt: ảnh model -> ảnh sản phẩm (hoặc ảnh bối cảnh) -> video gốc
  const toUpload = (f) => {
    let ext = path.extname(f).toLowerCase();
    if (['.jfif', '.jif', '.jpe'].includes(ext)) ext = '.jpg';
    const dest = path.join(DATA_DIR, 'tmp', `vs-${hashFile(f)}${ext}`);
    fs.copyFileSync(f, dest);
    return dest;
  };
  // KHÔNG dùng lại ảnh do Flow tạo theo tên của nó trên Flow (trước đây: flowRefs / flowTitle): tên do Flow tự đặt theo nội
  // dung nên không định danh được ảnh — nhiều ảnh trùng tên, và tên lưu trong thư viện web có thể đang thuộc về một ảnh KHÁC
  // trên Flow (ảnh gốc đã xoá / ở dự án khác): áo khoác navy từng bị thay bằng hoodie xám cùng tên "Recreate clean product photo",
  // 2 ảnh outfit cùng tên thì video mất hẳn 1 outfit. Mọi ảnh đều gắn theo tên file = mã băm nội dung.
  const items = [...images, video].filter(Boolean).map((f) => ({ src: f, file: toUpload(f) }));
  const keyOf = (it) => path.parse(it.file).name;
  const names = items.map(keyOf);
  const tag = names.join('+');

  try {
    const clear = page.getByRole('button', { name: 'Clear prompt' });
    if (await clear.isVisible().catch(() => false)) await clear.click();

    // Ô prompt còn ở chế độ Frames từ lần trước thì không có nút mở thư viện -> về Ingredients trước
    await ensureIngredientsButton(page);

    const files = [...new Set(items.map((it) => it.file))];
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
      log('File đã có sẵn trên Flow, không tải lại');
    }
    const isFrames = settings.flowVideoMode === 'frames' || settings.isFramesMode;
    const hasMentions = /@Image\d+/.test(prompt);

    if (!hasMentions) {
      for (const it of items) {
        log(`Thêm vào prompt: ${path.basename(it.file)}`);
        await addIngredient(page, keyOf(it), isFrames);
      }
    }

    const videoModelName = settings.flowVideoModel || 'Omni 1.1 Flash';
    const durLabel = settings.flowDuration ? ` · ${settings.flowDuration}` : '';
    log(kind === 'image' ? 'Chọn Ảnh · Nano Banana' : `Chọn Video · ${videoModelName}${durLabel}`);
    const credits = await configure(page, settings, kind, { hasVideo: !!video });

    if (hasMentions) {
      log('Chèn prompt và liên kết thẻ mention @Image vào ảnh');
      await fillPromptWithMentions(page, prompt, items, log);
    } else {
      const box = page.getByRole('textbox', { name: 'What do you want to create?' });
      await box.click();
      await box.fill(flowPrompt(prompt, images.length));
    }

    const before = await snapshotTiles(page);
    const start = page.getByRole('button', { name: 'Start generation' });
    // Flow cần một lúc sau khi gõ prompt mới bật nút tạo
    for (let i = 0; i < 30 && !(await start.isEnabled()); i++) await sleep(500);
    if (!(await start.isEnabled())) throw new Error('Flow không cho bấm tạo (nút "Start generation" bị khoá)');
    if (dryRun) return { dryRun: true, credits }; // kiểm tra các bước mà không tốn credit
    log(`Bấm tạo (${credits})`);
    await start.click();

    const tile = await waitForResult(page, before, log, names, kind, isCancelled);
    // Tên Flow đặt cho kết quả -> ảnh này về sau dùng lại được làm nguyên liệu (không tải lên lại)
    const title = (await tile.getAttribute('aria-label').catch(() => '')) || '';
    const videoQuality = kind === 'image' ? null : videoDownloadOf(settings);
    log(kind === 'image' ? (imageQuality ? `Tải ảnh ${imageQuality} về (Flow phóng to, mất ~15-30s)` : 'Tải ảnh về') : `Tải video ${videoQuality} về`);
    const got = await downloadTile(page, tile, outputFile, kind, (src) => onResult(src, { title }), { imageQuality, videoQuality, log });
    // Ghi lên thẻ video bản đã tải: "tải 1080p Upscaled · 5 credits", hoặc 720p khi không lấy được bản phóng to
    const dlNote = kind === 'image' ? '' : ` · tải ${typeof got === 'string' ? got : videoQuality === '720p' ? '720p' : `720p (không lấy được ${videoQuality})`}`;
    return { id: tag, outputFile, text: `Google Flow · ${credits}${dlNote}`, title };
  } finally {
    for (const it of items) if (it.file) fs.rm(it.file, { force: true }, () => {});
  }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Mọi bộ chọn trong file này theo giao diện tiếng Anh của Flow -> luôn mở Flow với ?hl=en
// (dự án mở bằng link khác có thể hiện tiếng Việt: "Bạn muốn tạo gì?" thay vì "What do you want to create?")
const withEn = (url) => (/[?&]hl=/.test(url) ? url : url + (url.includes('?') ? '&' : '?') + 'hl=en');
const pageLang = (page) => page.evaluate(() => document.documentElement.lang || '').catch(() => '');

// Dùng chung 1 dự án Flow cho mọi video (tạo mới lần đầu, lưu lại URL)
async function openProject(page, settings) {
  if (settings.flowProjectUrl) {
    if (!page.url().startsWith(settings.flowProjectUrl) || !/^en/.test(await pageLang(page))) {
      await page.goto(withEn(settings.flowProjectUrl), { waitUntil: 'domcontentloaded' });
    }
  } else {
    if (!page.url().includes('/project/')) {
      await page.goto(withEn(FLOW_URL), { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'New project' }).click();
      await page.waitForURL(/\/project\//, { timeout: 30_000 });
    }
    settings.flowProjectUrl = page.url().split('?')[0];
  }
  // Trang dự án đôi khi kẹt "Loading…" (nhất là ngay sau khi mở Chrome) -> tải lại rồi chờ tiếp;
  // trang không phải tiếng Anh -> mở lại với ?hl=en
  const box = page.getByRole('textbox', { name: 'What do you want to create?' });
  for (let i = 0; ; i++) {
    try {
      await box.waitFor({ timeout: 20_000 });
      break;
    } catch (e) {
      const lang = await pageLang(page);
      if (i >= 2) {
        throw new Error(lang && !/^en/.test(lang)
          ? `Trang Flow đang hiện ngôn ngữ "${lang}" nên web không nhận ra giao diện — mở lại link dự án kèm ?hl=en trong cửa sổ Chrome của Flow rồi thử lại.`
          : 'Trang dự án Flow không tải được (kẹt "Loading…") — thử tải lại trang trong cửa sổ Chrome của Flow.');
      }
      if (lang && !/^en/.test(lang)) await page.goto(withEn(page.url()), { waitUntil: 'domcontentloaded' }).catch(() => {});
      else await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    }
  }
}

// Ô prompt đang ở chế độ Frames (còn lại từ lần tạo "Khung hình bắt đầu" trước: nút Start/End thay cho nút nguyên liệu)
// -> không có nút "Add ingredients to the prompt box" để mở thư viện tải file. Chuyển về Video · Ingredients trước;
// configure() sẽ đặt lại đúng chế độ (Frames nếu cần) sau khi file đã có trên Flow.
async function ensureIngredientsButton(page) {
  const btn = page.getByRole('button', { name: 'Add ingredients to the prompt box' });
  if (await btn.isVisible().catch(() => false)) return;
  if (await page.getByRole('textbox', { name: 'Search assets' }).isVisible().catch(() => false)) return;
  await dismissOverlays(page);
  const agent = page.locator('button.agent-mode-chip-checked');
  if (await agent.count()) {
    await agent.click();
    await sleep(800);
  }
  if (await btn.isVisible().catch(() => false)) return;
  await page.getByRole('button', { name: 'Settings trigger' }).click();
  await page.getByRole('radio', { name: 'Video', exact: true }).click().catch(() => {});
  await sleep(300);
  const ing = page.getByRole('radio', { name: /^(ingredients|thành phần)$/i });
  if (await ing.isVisible().catch(() => false)) await ing.click().catch(() => {});
  await sleep(300);
  await page.keyboard.press('Escape');
  await sleep(400);
  if (!(await btn.isVisible({ timeout: 10_000 }).catch(() => false))) {
    throw new Error('Không thấy nút thêm nguyên liệu trong ô prompt Flow (ô prompt không ở chế độ Ingredients)');
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

// Chrome của Flow đăng nhập nhiều tài khoản Google: trang dự án ở /u/N/ nhưng lời gọi tải video
// (flow.google.com/upload/v1/flow/upload/...) không mang /u/N/ nên Google xử lý theo tài khoản mặc định u/0
// -> 403 "User does not have access to project". Gắn thêm tài khoản đúng (header X-Goog-AuthUser + ?authuser=N)
// vào các lời gọi đó. Chỉ có tác dụng khi dự án mở ở /u/N/ với N ≥ 1; một tài khoản thì không đổi gì.
const routedPages = new WeakSet();
const authUserOf = (url) => url.match(/flow\.google\.com\/u\/(\d+)\//)?.[1] || null;

async function ensureAuthUserRoute(page, settings) {
  if (routedPages.has(page)) return;
  routedPages.add(page);
  await page.route(/flow\.google\.com\/upload\//, (route) => {
    const req = route.request();
    const n = authUserOf(page.url()) || authUserOf(settings.flowProjectUrl || '');
    if (!n || n === '0') return route.continue();
    const url = new URL(req.url());
    if (!url.searchParams.has('authuser')) url.searchParams.set('authuser', n);
    return route.continue({ url: url.href, headers: { ...req.headers(), 'x-goog-authuser': n } });
  });
}

async function uploadFiles(page, files, settings) {
  await openAssetPanel(page);
  await ensureAuthUserRoute(page, settings);
  // Bắt lỗi từ máy chủ upload của Flow (vd. 403 khi trình duyệt đăng nhập nhiều tài khoản Google:
  // video upload không mang /u/N/ nên bị gửi theo tài khoản mặc định u/0)
  const uploadErrors = [];
  const onResponse = async (res) => {
    if (!/\/upload\/v\d+\/flow\/upload\//.test(res.url()) || res.status() < 400) return;
    let body = '';
    try { body = (await res.text()).slice(0, 200); } catch {}
    uploadErrors.push({ status: res.status(), body });
  };
  page.on('response', onResponse);
  try {
    await doUpload(page, files, settings, uploadErrors);
  } finally {
    page.off('response', onResponse);
  }
}

function uploadErrorMessage(err, page) {
  if (err.status === 403 && /does not have access to project/i.test(err.body)) {
    const multi = /\/u\/[1-9]\d*\//.test(page.url());
    return 'Flow từ chối tải video lên (403: tài khoản không có quyền với dự án).' +
      (multi
        ? ' Cửa sổ Chrome của Flow đang đăng nhập nhiều tài khoản Google và dự án thuộc tài khoản phụ (/u/1/…), nhưng Flow gửi video theo tài khoản mặc định. Cách sửa: trong cửa sổ Chrome của Flow, đăng xuất tài khoản cũ (chỉ giữ tài khoản dùng cho Flow), rồi xoá ô "Dự án Flow dùng chung" trong Cài đặt để web tạo dự án mới, bấm Thử lại.'
        : ' Kiểm tra dự án trong Cài đặt có thuộc đúng tài khoản đang đăng nhập không (xoá ô "Dự án Flow dùng chung" để tạo dự án mới).');
  }
  return `Flow báo lỗi khi tải file lên (HTTP ${err.status}): ${err.body || 'không rõ'}`;
}

async function doUpload(page, files, settings, uploadErrors) {
  // Ô "upload failed" của lần trước có thể còn trong dự án -> chỉ tính ô lỗi MỚI xuất hiện
  const failedTileOf = (name) => page.locator(`main [role="group"][aria-label^="${name}"]`).filter({ hasText: /upload failed/i });
  const failedBefore = {};
  for (const f of files) failedBefore[path.parse(f).name] = await failedTileOf(path.parse(f).name).count().catch(() => 0);
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
  // Chờ từng file xuất hiện trong thư viện; dừng ngay nếu máy chủ upload báo lỗi hoặc ô file hiện "upload failed"
  for (const f of files) {
    const name = path.parse(f).name;
    // Khi đang tải, option có tên "Uploading vs-…" nên không khớp ^name; tải xong mới thành "vs-… Video/Image"
    const option = assetList(page).getByRole('option', { name: new RegExp('^' + name + '\\b') });
    const failedTile = failedTileOf(name);
    const deadline = Date.now() + 180_000;
    for (;;) {
      if (uploadErrors.length) throw new Error(uploadErrorMessage(uploadErrors[0], page));
      if (await option.count().catch(() => 0)) break;
      if ((await failedTile.count().catch(() => 0)) > failedBefore[name]) {
        throw new Error(`Flow báo "Video upload failed" cho ${path.basename(f)}. Nếu cửa sổ Chrome của Flow đang đăng nhập nhiều tài khoản Google, hãy đăng xuất tài khoản cũ rồi thử lại.`);
      }
      if (Date.now() > deadline) throw new Error(`Quá 3 phút chưa tải xong ${path.basename(f)} lên Flow`);
      await sleep(1000);
    }
  }
}

const ingredientCount = (page) => page.getByRole('button', { name: 'Ingredient', exact: true }).count();

async function addIngredient(page, name, isFrames = false) {
  const n = await ingredientCount(page);
  // Tìm theo tên rồi chọn bản đầu tiên (thư viện có thể còn bản trùng từ trước)
  const asset = (await searchAssets(page, name)).first();
  if (await asset.count().catch(() => 0)) {
    await asset.click();
    const add = page.getByRole('button', { name: /add to prompt|use as start frame|add as start frame|thêm vào prompt|thêm làm khung hình/i });
    if (await add.isVisible({ timeout: 2000 }).catch(() => false)) {
      await add.click().catch(() => {});
    }
  }
  if (!isFrames) {
    for (let i = 0; i < 30 && (await ingredientCount(page)) <= n; i++) await sleep(500);
  } else {
    await sleep(800);
  }
  const search = page.getByRole('textbox', { name: 'Search assets' });
  if (await search.isVisible().catch(() => false)) await search.fill('');
  if (!isFrames && (await ingredientCount(page)) <= n) throw new Error(`Không thêm được ${name} vào prompt`);
}

// Video: Video / Ingredients (hoặc Frames) / tỉ lệ / model (Omni 1.1 / 1.2 Flash, Veo 3.1…) / độ phân giải / x1.
// Ảnh: Image / tỉ lệ / Nano Banana / x1. Trả về số credit sẽ tốn.
async function configure(page, settings, kind = 'video', { hasVideo = false } = {}) {
  // Chế độ "Agent" của Flow (dự án mới mặc định bật) ẩn nút cài đặt model -> tắt đi
  const agent = page.locator('button.agent-mode-chip-checked');
  if (await agent.count()) {
    await agent.click();
    await sleep(800);
  }
  await dismissOverlays(page);
  const trigger = page.getByRole('button', { name: 'Settings trigger' });
  const radio = (name) => page.getByRole('radio', { name, exact: true });
  const family = page.getByRole('button', { name: 'Select model family' });
  // Bảng cài đặt "đang mở" = thấy nút chọn model. Bảng có thể bị đóng giữa chừng (Flow vẽ lại, phím Escape, thao tác khác
  // trên cùng trang) -> mở lại, thay vì chờ 30s rồi báo lỗi khó hiểu "waiting for … Select model family".
  const panelOpen = (ms) => family.waitFor({ state: 'visible', timeout: ms }).then(() => true, () => false);
  const ensurePanel = async () => {
    if (await panelOpen(3000)) return;
    for (let i = 0; i < 3; i++) {
      await dismissOverlays(page);
      await trigger.click({ timeout: 10_000 });
      if (await panelOpen(4000)) return;
    }
    throw new Error('Không mở được bảng cài đặt model của Flow (không thấy nút chọn model) — xem cửa sổ Chrome của Flow: tắt chế độ Agent / đóng hộp thoại đang mở rồi Thử lại.');
  };
  await trigger.click({ timeout: 15_000 });
  if (!(await panelOpen(5000))) await ensurePanel();
  // Bấm 1 nút trong bảng: bảng bị đóng giữa chừng thì mở lại rồi bấm lại (tối đa 3 lần, mỗi lần chờ ngắn)
  const tap = async (loc) => {
    for (let i = 0; ; i++) {
      await ensurePanel();
      try {
        return await loc.click({ timeout: 5000 });
      } catch (e) {
        if (i >= 2) throw e;
      }
    }
  };
  const pickFamily = async (re) => {
    for (let i = 0; ; i++) {
      await ensurePanel();
      if (re.test(await family.innerText({ timeout: 5000 }).catch(() => ''))) return;
      try {
        await family.click({ timeout: 5000 });
        await page.getByRole('menuitem', { name: re }).first().click({ timeout: 5000 });
        return;
      } catch (e) {
        if (i >= 2) throw e;
        await page.keyboard.press('Escape').catch(() => {});
      }
    }
  };
  // Omni có nhiều phiên bản (1.1 Flash, 1.2 Flash…) -> chọn đúng số phiên bản, chấp nhận cả "Omni 1.2 Flash" và
  // "Omni Flash 1.2". Không thấy thì báo lỗi kèm danh sách model Flow đang có (thay vì lặng lẽ chọn bản khác).
  // So đúng số phiên bản trong tên (1.2 không khớp nhầm 1.12 hay 11.2)
  const isOmni = (t, version) => /omni/i.test(t) && (String(t).match(/\d+(?:\.\d+)+/g) || []).includes(version);
  const familyText = async () => (await family.innerText({ timeout: 5000 }).catch(() => '')).replace(/arrow_drop_down/g, '').replace(/\s+/g, ' ').trim();
  const pickOmni = async (version) => {
    const isWanted = (t) => isOmni(t, version);
    for (let i = 0; ; i++) {
      await ensurePanel();
      if (isWanted(await familyText())) return;
      try {
        await family.click({ timeout: 5000 });
        const items = page.getByRole('menuitem');
        await items.first().waitFor({ timeout: 5000 }); // menu không mở (bảng vừa bị đóng) -> thử lại
        const texts = await items.allInnerTexts();
        const idx = texts.findIndex(isWanted);
        if (idx < 0) {
          await page.keyboard.press('Escape');
          const list = texts.map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean).join(', ');
          throw Object.assign(new Error(`Flow không có model Omni ${version} Flash (đang có: ${list || 'không đọc được menu'}) — đổi "Mô hình video trên Flow" trong Cài đặt.`), { final: true });
        }
        await items.nth(idx).click({ timeout: 5000 });
        return;
      } catch (e) {
        if (e.final || i >= 2) throw e;
        await page.keyboard.press('Escape').catch(() => {});
      }
    }
  };
  if (kind === 'image') {
    await tap(radio('Image'));
    await sleep(400);
    await tap(radio(settings.aspectRatio === '16:9' ? '16:9' : '9:16'));
    await pickFamily(/Nano Banana/i);
  } else {
    await tap(radio('Video'));
    await sleep(400);
    const isFrames = settings.flowVideoMode === 'frames' || settings.isFramesMode;
    const modeRadio = page.getByRole('radio', { name: isFrames ? /^(frames|khung hình)$/i : /^(ingredients|thành phần)$/i });
    await ensurePanel();
    if (await modeRadio.isVisible().catch(() => false)) {
      await tap(modeRadio).catch(() => {});
    } else {
      await radio(isFrames ? 'Frames' : 'Ingredients').click({ timeout: 5000 }).catch(() => {});
    }
    await sleep(300);
    await tap(radio(settings.aspectRatio === '16:9' ? '16:9' : '9:16'));
    const model = settings.flowVideoModel || 'Omni 1.1 Flash';
    if (/veo 3\.1.*quality/i.test(model)) {
      await pickFamily(/Veo 3\.1.*Quality/i);
    } else if (/veo 3\.1.*fast/i.test(model)) {
      await pickFamily(/Veo 3\.1.*Fast/i);
    } else if (/veo 3\.1.*lite/i.test(model)) {
      await pickFamily(/Veo 3\.1.*Lite/i);
    }
    const omniVersion = /omni/i.test(model) || !/veo/i.test(model) ? model.match(/\d+\.\d+/)?.[0] || '1.1' : null; // 'Omni 1.2 Flash' -> 1.2
    if (omniVersion) await pickOmni(omniVersion);
    const resRadio = page.getByRole('radio', { name: settings.flowResolution === '360p' ? /^360p/ : /^720p/ });
    await ensurePanel();
    if (await resRadio.isVisible().catch(() => false)) {
      await tap(resRadio).catch(() => {});
    }
    // Thời lượng: nút radio có tên truy cập bắt đầu bằng "10s" / "10 s" / "10 sec" / "10 seconds" / "10 giây"
    // (tên có thể kèm chữ phía sau, vd. số credit). Nút chỉ hiện sau khi chọn model -> chờ một nhịp.
    // Video-to-video (có video gốc) thì Flow tạo dài bằng video gốc, không có nút này -> bỏ qua.
    const duration = settings.flowDuration || '10s';
    const wantSec = parseFloat(duration);
    const durRadio = page.getByRole('radio', { name: new RegExp(`^\\s*${wantSec}(\\.0+)?\\s*(s|secs?|seconds?|giây)\\b`, 'i') }).first();
    const summaryDur = async () => {
      const t = await trigger.innerText({ timeout: 5000 }).catch(() => '');
      const m = t.match(/(\d+(?:\.\d+)?)\s*s\b/i);
      return m ? parseFloat(m[1]) : null;
    };
    const clickDur = async () => {
      await durRadio.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
      if (!(await durRadio.isVisible().catch(() => false))) return false;
      if ((await durRadio.getAttribute('aria-checked').catch(() => null)) !== 'true') await tap(durRadio).catch(() => {});
      await sleep(400);
      return true;
    };
    // Omni 1.2 Flash: thời lượng là THANH TRƯỢT "Length" (3–15s, mỗi nấc 1 giây) thay cho các nút radio (Omni 1.1 vẫn là
    // radio 4/6/8/10s; Veo 3.1 Lite không có). Chỉnh bằng phím mũi tên, sau mỗi nấc đọc lại dòng tóm tắt của Flow
    // ("Video · 720p · 15s") cho tới khi đúng số giây; kẹt 3 nấc liên tiếp (hết thang) thì thôi.
    const lenSlider = page.getByRole('slider', { name: /^\s*(length|duration|thời lượng|độ dài)\s*$/i }).first();
    const slideDur = async () => {
      let stuck = 0;
      for (let i = 0; i < 40; i++) {
        const cur = await summaryDur();
        if (cur === wantSec) return true;
        if (cur === null) return false;
        await ensurePanel(); // bảng bị đóng thì mở lại, không thì phím mũi tên rơi ra ngoài trang
        await lenSlider.focus({ timeout: 5000 }).catch(() => {});
        await page.keyboard.press(cur < wantSec ? 'ArrowRight' : 'ArrowLeft');
        await sleep(200);
        if ((await summaryDur()) === cur) { if (++stuck >= 3) return false; } else stuck = 0;
      }
      return (await summaryDur()) === wantSec;
    };
    // Sau khi đổi model Flow vẽ lại bảng -> chờ 1 trong 2 kiểu điều khiển hiện ra rồi dùng kiểu đó
    const setDur = async () => {
      await ensurePanel();
      for (let i = 0; i < 12; i++) {
        if (await lenSlider.count().catch(() => 0)) return slideDur();
        if (await durRadio.isVisible().catch(() => false)) return clickDur();
        await sleep(250);
      }
      return false;
    };
    let hadDur = await setDur();
    if (!hasVideo && hadDur && (await summaryDur()) !== wantSec) hadDur = await setDur(); // chỉnh lại 1 lần nếu Flow chưa nhận
    // Chọn độ phân giải / thời lượng có thể làm Flow tự đổi về model mặc định (vd. Omni 1.1) -> đọc lại model
    // thật sự đang chọn, sai thì chọn lại; vẫn sai thì dừng (không bấm tạo bằng model khác, tránh tốn credit)
    if (omniVersion) {
      await sleep(300);
      if (!isOmni(await familyText(), omniVersion)) {
        await pickOmni(omniVersion);
        await sleep(300);
        await setDur();
        const now = await familyText();
        if (!isOmni(now, omniVersion)) throw new Error(`Flow không giữ được model Omni ${omniVersion} Flash (đang là "${now}") — có thể bản này chưa hỗ trợ ${duration}/${settings.flowResolution || '720p'}.`);
      }
    }
    // Text/image-to-video: thời lượng phải đúng như đã chọn, sai thì dừng trước khi bấm tạo (khỏi tốn credit cho video ngắn hơn)
    if (!hasVideo) {
      const got = await summaryDur();
      if (got !== null && got !== wantSec) {
        await page.keyboard.press('Escape').catch(() => {});
        throw new Error(`Flow đang để thời lượng ${got}s thay vì ${duration}${hadDur ? '' : ' (không chỉnh được sang ' + duration + ' — model này có thể không hỗ trợ thời lượng đó)'} — chọn thời lượng khác hoặc model khác rồi Thử lại.`);
      }
    }
  }
  await tap(radio('x1'));
  await sleep(500);
  await ensurePanel();
  // "Generating will use 60 credits": lấy đúng link số credit (trang còn link "Add AI credits" ở băng thông báo)
  const credits = (await page.getByRole('link', { name: /^\s*[\d.,]+\s*credits?\s*$/i }).first().innerText({ timeout: 3000 }).catch(() => '? credits')).trim();
  const chosen = await familyText(); // model Flow thật sự đang chọn -> ghi vào thẻ video để kiểm tra
  await page.keyboard.press('Escape');
  const parts = [credits, chosen];
  if (kind !== 'image') {
    // Dòng tóm tắt của Flow (vd. "Video · 720p · 10s crop_9_16 x1") -> thời lượng Flow thật sự đang để
    const summary = await page.getByRole('button', { name: 'Settings trigger' }).innerText().catch(() => '');
    const flowDur = summary.match(/(\d+(?:\.\d+)?)\s*s\b/i)?.[1];
    const want = settings.flowDuration || '10s';
    if (flowDur) parts.push(parseFloat(flowDur) === parseFloat(want) ? `${flowDur}s` : `${flowDur}s (Cài đặt: ${want})`);
  }
  return parts.filter(Boolean).join(' · ');
}

// Cấu hình trước Flow (ví dụ khi người dùng mở trang module video thời trang)
export async function preset({ model = 'Omni 1.1 Flash', duration = '10s', resolution = '720p', aspectRatio = '9:16' } = {}) {
  if (!(await isRunning())) return { ok: false, reason: 'Chrome not running' };
  // Đang có lần tạo thao tác trên trang Flow -> không đụng vào bảng cài đặt (xem flowBusy ở trên)
  if (flowBusy) return { ok: false, reason: 'busy' };
  if (presetRunning) return presetRunning;
  presetRunning = (async () => {
    try {
      const page = await flowPage();
      await openProject(page, db.settings);
      const settings = {
        ...db.settings,
        flowVideoModel: model,
        flowDuration: duration,
        flowResolution: resolution || db.settings.flowResolution,
        aspectRatio: aspectRatio || db.settings.aspectRatio,
      };
      const credits = await configure(page, settings, 'video');
      return { ok: true, credits };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  })().finally(() => { presetRunning = null; });
  return presetRunning;
}

// Bật/tắt công tắc "Return videos without audio" / "Trả về video không có âm thanh" trong bảng cài đặt dự án
// (nút bánh răng ⚙️ góc trên phải của Flow) theo settings.flowVideoAudio: 'mute' = bật, 'sound' = tắt, khác = để nguyên.
// Trả về mô tả kết quả (để ghi lên thẻ video) hoặc null khi để nguyên.
const AUDIO_SWITCH = 'without audio|no audio|without sound|không có âm thanh|không âm thanh';
async function applyAudioPref(page, settings) {
  const pref = settings.flowVideoAudio;
  if (pref !== 'mute' && pref !== 'sound') return null;
  const want = pref === 'mute';
  const label = want ? 'không có âm thanh' : 'có âm thanh';
  // Đánh dấu công tắc bằng data-vs-audio để bấm đúng nó; trả về trạng thái hiện tại (true = đang bật) hoặc null nếu không thấy
  const findSwitch = () =>
    page.evaluate((src) => {
      const re = new RegExp(src, 'i');
      const txt = (e) => (e?.innerText || e?.textContent || '').replace(/\s+/g, ' ').trim();
      for (const e of document.querySelectorAll('[data-vs-audio]')) e.removeAttribute('data-vs-audio');
      const SEL = '[role="switch"], input[type="checkbox"], button[aria-checked], button[aria-pressed]';
      const cands = [...document.querySelectorAll(SEL)];
      for (const e of cands) {
        const by = e.getAttribute('aria-labelledby');
        let name = e.getAttribute('aria-label') || (by && txt(document.getElementById(by))) || '';
        // không có tên riêng -> lấy chữ của hàng chứa công tắc (đi lên tối đa 4 cấp), dừng khi khung đó
        // chứa cả công tắc khác (không lấy nhầm chữ của hàng bên cạnh)
        for (let p = e.parentElement, i = 0; !re.test(name) && p && i < 4; p = p.parentElement, i++) {
          if (p.querySelectorAll(SEL).length > 1) break;
          const t = txt(p);
          if (t.length < 160) name = t;
        }
        if (!re.test(name)) continue;
        e.setAttribute('data-vs-audio', '1');
        return e.getAttribute('aria-checked') === 'true' || e.getAttribute('aria-pressed') === 'true' || e.checked === true;
      }
      return null;
    }, AUDIO_SWITCH);

  let state = await findSwitch();
  let opened = false;
  if (state === null) {
    await dismissOverlays(page);
    // Nút bánh răng: aria-label Settings / Cài đặt (không phải "Settings trigger" ở ô prompt) hoặc icon "settings"
    const gearIdx = await page.locator('button').evaluateAll((els) =>
      els.findIndex((e) => {
        const a = (e.getAttribute('aria-label') || '').trim();
        const t = (e.innerText || '').trim();
        return !/trigger/i.test(a) && (/^(settings|project settings|view settings|cài đặt)$/i.test(a) || /^settings$/i.test(t));
      }),
    );
    if (gearIdx < 0) throw new Error('không thấy nút cài đặt ⚙️ của Flow');
    await page.locator('button').nth(gearIdx).click();
    opened = true;
    for (let i = 0; i < 10 && state === null; i++) {
      await sleep(300);
      state = await findSwitch();
    }
  }
  try {
    if (state === null) throw new Error('không thấy công tắc "Trả về video không có âm thanh"');
    if (state !== want) {
      await page.locator('[data-vs-audio="1"]').click();
      await sleep(500);
      state = await findSwitch();
      if (state !== want) throw new Error('Flow không nhận thao tác bật/tắt');
      return `${label} (đã ${want ? 'bật' : 'tắt'} công tắc trên Flow)`;
    }
    return `${label} (Flow đã đúng sẵn)`;
  } finally {
    if (opened) {
      await page.keyboard.press('Escape').catch(() => {});
      await sleep(300);
    }
  }
}

// Prompt cũ có thể còn <IMAGE_REF_n> -> Flow hiểu theo thứ tự ảnh đã thêm
function flowPrompt(prompt, imageCount) {
  return prompt.replace(/<IMAGE_REF_(\d+)>/g, (_, i) => (imageCount > 1 ? `reference image ${Number(i) + 1}` : 'the reference image'));
}

// Các ô media đang có trong dự án: { i, key, text, icons, hasVideo, src, isrc }
const TILE = 'main [role="group"]';
const tiles = (page) =>
  page.locator(TILE).evaluateAll((els) =>
    els.map((e, i) => {
      const label = e.getAttribute('aria-label') ||
        (e.getAttribute('aria-labelledby') && document.getElementById(e.getAttribute('aria-labelledby'))?.textContent) || '';
      const v = e.querySelector('video');
      const im = e.querySelector('img');
      const icons = Array.from(e.querySelectorAll('mat-icon')).map((m) => m.textContent?.trim() || '').join(' ');
      return {
        i,
        key: label.trim(),
        text: e.innerText.trim(),
        icons,
        hasVideo: !!v || /video/i.test(im?.alt || ''),
        src: v?.getAttribute('src') || '',
        isrc: im?.getAttribute('src') || '',
      };
    }),
  );
// Câu báo lỗi cho người dùng từ chữ trên ô / thông báo lỗi của Flow. Chữ thô có dạng "warning\nFailed\n<lý do>…\nYou will be
// refunded…\nrefresh\nundo…" (tên icon lẫn vào): bỏ tên icon, giữ nguyên câu LÝ DO của Flow (trước đây chỉ lấy 2 dòng đầu nên
// chỉ còn "warning Failed", không biết vì sao lỗi), thêm gợi ý cho lỗi hay gặp.
const ICON_WORD = /^(warning|error|error_outline|info|refresh|undo|delete_forever|image|videocam|movie|more_vert|close)$/i;
export function flowFailure(raw) {
  const lines = String(raw || '').split('\n').map((l) => l.trim()).filter((l) => l && !ICON_WORD.test(l));
  const text = lines.join(' ');
  const reason = text.replace(/^Failed\s*/i, '').split(/\s*(?:You will be refunded|It may take several minutes|Track status)/i)[0].trim().slice(0, 300);
  let msg = 'Flow báo lỗi: ' + (reason || lines[0] || 'Failed');
  if (/prominent people/i.test(text)) {
    msg += ' — Bộ lọc "người nổi tiếng" của Flow: Flow cho rằng người trong ảnh tham chiếu (ảnh KOL / ảnh outfit) giống một người nổi tiếng (thường do khuôn mặt trong ảnh, không phải do các mốc động tác). Thử lại 1 lần; nếu vẫn lỗi thì đổi ảnh KOL khác.';
  }
  if (/unusual activity/i.test(text)) {
    msg += ' — Google Flow báo hoạt động bất thường (đã tự mở cửa sổ Chrome của Flow lên để bạn xem, tải lại trang hoặc điều chỉnh trực tiếp).';
  }
  if (/will be refunded/i.test(text)) msg += ' (Flow sẽ hoàn lại credit cho lần lỗi này)';
  return msg;
}

export const FLOW_PAGE_ERROR_RE = /couldn.t generate|failed|something went wrong|try again|violat|policy|error|limit|quota|exceeded|refund|not supported|unable to|unusual activity|not been charged|captcha|verify it'?s you/i;
const FAILED_RE = /couldn.t generate|failed|something went wrong|try again|violat|policy|error|unable to generate|not allowed|unusual activity|not been charged|captcha|verify it'?s you/i;
const isFailed = (t) => FAILED_RE.test(t.text) || FAILED_RE.test(t.key) || (t.icons && /error|warning/i.test(t.icons));
const isGenerating = (t) => /\d+\s*%/.test(t.text);
// Mã file media: phần cuối đường dẫn, bỏ chữ ký ?Expires=… (đổi theo thời gian).
// Cùng 1 video Flow lúc hiện <video> (/video/<id>) lúc hiện ảnh thu nhỏ (/image/<id>).
const mediaId = (src) => (src || '').split('?')[0].split('/').pop();
const tileMedia = (t) => mediaId(t.src || t.isrc);
// Ô đã có kết quả ổn định (có media, không lỗi, không đang chạy)
const isSettled = (t) => !!tileMedia(t) && !isFailed(t) && !isGenerating(t);

// Phát hiện thông báo lỗi, snackbar, toast, dialog hoặc cảnh báo chính sách trên giao diện Flow
async function detectFlowPageError(page) {
  try {
    return await page.evaluate((errSrc) => {
      const errRe = new RegExp(errSrc, 'i');
      const selectors = [
        '.mat-mdc-snack-bar-label',
        '[role="alert"]',
        'mat-snack-bar-container',
        '.cdk-overlay-pane [role="dialog"]',
        'flow-dialog',
        '.error-message',
        '.error-banner',
        'mat-error',
        '.toast',
      ];
      for (const sel of selectors) {
        for (const el of document.querySelectorAll(sel)) {
          // Ô kết quả bị lỗi của một lần tạo CŨ vẫn nằm trong dự án (flow-error-tile có class .error-message): không phải
          // lỗi của lần tạo này. Lỗi của đúng ô đang chờ do waitForResult xét riêng (isFailed).
          if (el.closest('flow-tile-container, flow-error-tile')) continue;
          const text = (el.innerText || el.textContent || '').trim();
          // Menu tài khoản Google (bấm vào ảnh đại diện) cũng là 1 dialog trong cdk-overlay: có chữ "Terms of Service", "License"… dễ
          // khớp nhầm từ khoá lỗi -> bỏ qua (video thử Chuyển động 5 từng bị báo lỗi giả vì menu này đang mở).
          if (/switch account|sign out|manage subscription|google flow credits/i.test(text)) continue;
          if (text && errRe.test(text)) {
            return text;
          }
        }
      }
      return null;
    }, FLOW_PAGE_ERROR_RE.source);
  } catch {
    return null;
  }
}

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
async function waitForResult(page, before, log, names, kind = 'video', isCancelled) {
  const startedAt = Date.now();
  const deadline = startedAt + 20 * 60_000;
  let reported = '';
  let lastSrc = '';
  let waitedNote = false;
  while (Date.now() < deadline) {
    if (isCancelled?.()) throw new Error('Job đã huỷ theo yêu cầu.');

    await sleep(5000);

    if (isCancelled?.()) throw new Error('Job đã huỷ theo yêu cầu.');

    // 1. Kiểm tra ngay lập tức xem Flow có bật thông báo lỗi / toast / alert / dialog không
    const pageErr = await detectFlowPageError(page);
    if (pageErr) {
      throw new Error(flowFailure(pageErr));
    }

    await scrollTilesTop(page);
    const all = await tiles(page);
    const region = tilesAboveAnchor(all, before);
    if (!region) {
      if (Date.now() - startedAt > 90_000) {
        throw new Error('Trang Flow không hiển thị kết quả sau 90 giây (không tìm thấy mốc danh sách).');
      }
      continue; // mốc chưa hiện ra -> chờ
    }
    const fresh = region.slice(0, Math.max(0, region.length - before.above));
    const t = fresh.find((x) => !isUploadTile(x, names));
    if (!t) {
      // Sau 30s: nếu nút Start generation đã quay lại bật và prompt box trống -> Flow đã bỏ qua/lỗi ngầm
      if (Date.now() - startedAt > 30_000) {
        const startBtn = page.getByRole('button', { name: 'Start generation' });
        if (await startBtn.isEnabled().catch(() => false)) {
          throw new Error('Flow không bắt đầu tạo video (nút tạo đã quay về ban đầu, có thể prompt bị từ chối).');
        }
      }
      // Sau 90s: nếu vẫn không có ô mới nào xuất hiện
      if (Date.now() - startedAt > 90_000) {
        throw new Error('Flow không tạo ô video mới sau 90 giây (có thể Flow đã gặp lỗi hoặc từ chối prompt).');
      }
      if (!waitedNote && Date.now() - startedAt > 30_000) {
        waitedNote = true;
        log('Đang chờ Flow khởi tạo ô video mới…');
      }
      continue;
    }
    if (isFailed(t)) {
      throw new Error(flowFailure(t.text || t.key));
    }
    const pct = t.text.match(/\d+\s*%/)?.[0];
    if (pct) {
      if (pct !== reported) log(`Đang tạo… ${(reported = pct)}`);
      continue;
    }
    if (Date.now() - startedAt < 25_000) continue;
    // Video: cần <video src>; ảnh: cần <img src> và không phải ô video
    let media = kind === 'image' ? (t.src ? '' : t.isrc) : t.src;
    if (kind !== 'image' && !/^https?:/.test(media || '') && /^https?:/.test(t.isrc || '')) {
      // Video xong nhưng Flow chỉ hiện ảnh thu nhỏ, <video> chỉ được nạp khi rê chuột vào ô
      // -> tự rê chuột vào ô kết quả thay cho người dùng
      media = (await tileMediaSrc(page, page.locator(TILE).nth(t.i), 'video')) || '';
    }
    if (!/^https?:/.test(media || '')) continue;
    if (mediaId(media) !== mediaId(lastSrc)) { lastSrc = media; continue; } // đợi src ổn định qua 2 lần kiểm tra
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

// Chất lượng tải video về: '1080p' (mặc định) = mục "1080p Upscaled" trong menu Download của Flow — Flow phóng to rồi
// mới tải nên chờ lâu hơn và TỐN CREDIT (menu ghi rõ, vd. "1080p Upscaled · 5 credits"); '720p' = bản gốc, không tốn thêm.
export const VIDEO_DOWNLOADS = ['1080p', '720p'];
export const videoDownloadOf = (settings = db.settings) => (VIDEO_DOWNLOADS.includes(settings?.flowVideoDownload) ? settings.flowVideoDownload : '1080p');

async function downloadTile(page, tile, outputFile, kind = 'video', onResult = () => {}, { imageQuality = null, videoQuality = null, log = () => {} } = {}) {
  // Cách 1: lấy thẳng file từ thẻ <video>/<img>
  const src = await tileMediaSrc(page, tile, kind);
  if (src) onResult(src); // ghi nhớ để lần Thử lại sau có thể lấy lại mà không tạo mới
  // Video: bản phóng to 1080p qua menu Download (Flow xử lý xong mới trả file — chờ tới 15 phút). Lỗi / Flow không có mục
  // đó thì rơi về bản gốc 720p như thường, không làm hỏng job.
  if (kind !== 'image' && videoQuality && videoQuality !== '720p') {
    try {
      let picked = videoQuality;
      await downloadViaMenu(page, tile, outputFile, new RegExp('^' + videoQuality, 'i'), 900_000, {
        onPick: (label) => { picked = label; log(`Tải video ${videoQuality} về: Flow đang phóng to (${label}) — chờ lâu hơn bản 720p`); },
      });
      return picked; // nhãn mục đã tải, vd. "1080p Upscaled · 5 credits"
    } catch (e) {
      console.error(`Tải video ${videoQuality} từ Flow lỗi, dùng bản gốc 720p:`, e.message);
      log(`Không tải được bản ${videoQuality} (${e.message.split('\n')[0].slice(0, 90)}), dùng bản gốc 720p`);
      await dismissOverlays(page);
    }
  }
  // Ảnh: menu Download của Flow có "1K Original size" / "2K Upscaled" / "4K Upscaled" -> lấy bản phóng to nếu được yêu cầu
  // (Flow upscale rồi mới tải, ~15-30s; file trả về là JPG). Lỗi thì rơi về ảnh gốc 1K như thường.
  if (kind === 'image' && imageQuality) {
    try {
      await downloadViaMenu(page, tile, outputFile, new RegExp('^' + imageQuality, 'i'), 180_000);
      return;
    } catch (e) {
      console.error(`Tải ảnh ${imageQuality} từ Flow lỗi, dùng ảnh gốc:`, e.message);
      log(`Không tải được bản ${imageQuality} (${e.message.slice(0, 80)}), dùng ảnh gốc 1K`);
      await dismissOverlays(page);
    }
  }
  // Ô ảnh CŨ trong lưới (dự án vừa tải lại) chỉ còn ảnh thu nhỏ: src kết thúc bằng "=s512-rw" (286×512 webp) -> không lấy
  // thẳng src mà tải bản gốc qua menu Download ("1K Original size"). Ô vừa tạo xong thì src là ảnh gốc 1K, lấy thẳng được.
  const isThumb = kind === 'image' && /=s\d+(-[a-z0-9]+)*(\?|$)/i.test(src || '');
  if (src && !isThumb) {
    try {
      await fetchToFile(src, outputFile);
      return;
    } catch (e) {
      console.error('Tải thẳng từ Flow lỗi, chuyển sang menu Download:', e.message);
    }
  }
  // Cách 2: menu "More options" -> Download (ảnh: "1K Original size", video: bản gốc)
  try {
    await downloadViaMenu(page, tile, outputFile, /720p|Original|1080p/i, 120_000);
  } catch (e) {
    if (!isThumb) throw e;
    // Menu cũng lỗi -> đành lấy ảnh thu nhỏ còn hơn không có gì
    console.error('Tải ảnh gốc qua menu Download lỗi, dùng ảnh thu nhỏ:', e.message);
    log('Không tải được ảnh gốc từ Flow, dùng ảnh thu nhỏ');
    await dismissOverlays(page);
    await fetchToFile(src, outputFile);
  }
}

// Flow báo lỗi ngay khi không phóng to / không tải được ("Upscaling failed!") nhưng không bao giờ trả file -> không chờ hết giờ.
// Trả về câu báo lỗi (và bấm Dismiss để thông báo không bị đọc nhầm thành lỗi của lần tạo sau), hoặc null.
async function downloadFailureNotice(page) {
  const text = await page.evaluate(() => {
    const els = document.querySelectorAll('.mat-mdc-snack-bar-label, mat-snack-bar-container, [role="alert"], [role="status"], .cdk-overlay-pane');
    for (const el of els) {
      if (el.closest('flow-tile-container')) continue;
      const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
      if (/upscal\w* failed|download failed|couldn.t (upscale|download)|failed to (upscale|download)/i.test(t)) return t;
    }
    return null;
  }).catch(() => null);
  if (!text) return null;
  await page.getByRole('button', { name: 'Dismiss' }).first().click({ timeout: 2000 }).catch(() => {});
  return text.replace(/^(error|warning)\s+/i, '').replace(/\s*Dismiss$/i, '');
}

// Menu "More options" -> Download (-> mục chất lượng nếu có) của 1 ô kết quả, lưu file tải về vào outputFile
// qualityRe bắt đầu bằng "^" = bắt buộc có đúng mục đó (không có thì báo lỗi để nơi gọi rơi về bản gốc);
// onPick(nhãn mục đã bấm, vd. "1080p Upscaled · 5 credits") để ghi tiến trình.
export async function downloadViaMenu(page, tile, outputFile, qualityRe, timeout, { onPick = () => {} } = {}) {
  // Nút "More options" chỉ hiện khi rê chuột vào ô, mà rê chuột không ăn nếu tab Flow không ở phía trước
  // (lúc tải thường là vài phút sau khi bấm tạo, người dùng có thể đã chuyển tab)
  await page.bringToFront().catch(() => {});
  await dismissOverlays(page);
  // Thông báo lỗi tải của lần trước còn treo trên màn hình -> đóng đi để không tính nhầm cho lần tải này
  if (await downloadFailureNotice(page)) await sleep(600);
  await tile.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  await tile.hover({ timeout: 5000 }).catch(() => {});
  await tile.getByRole('button', { name: 'More options' }).click({ timeout: 10_000 });
  const required = qualityRe.source.startsWith('^');
  const waitDownload = page.waitForEvent('download', { timeout });
  waitDownload.catch(() => {}); // lỗi được ném lại ở dưới; tránh "unhandled rejection" khi bước chọn mục lỗi trước
  await page.getByRole('menuitem', { name: /Download/i }).first().click({ timeout: 10_000 });
  // Tên mục có biểu tượng đứng trước ("1080p Upscaled · 5 credits") -> so theo chữ hiển thị của từng mục
  const items = page.getByRole('menuitem');
  let picked = null;
  for (let i = 0; i < 10 && picked === null; i++) {
    const texts = (await items.allInnerTexts().catch(() => [])).map((t) => t.replace(/\s+/g, ' ').trim());
    const idx = texts.findIndex((t) => qualityRe.test(t));
    if (idx >= 0) picked = { idx, label: texts[idx] };
    else await sleep(300);
  }
  if (picked) {
    onPick(picked.label);
    await items.nth(picked.idx).click({ timeout: 10_000 });
  } else if (required) {
    await dismissOverlays(page);
    throw new Error(`Flow không có mục tải "${qualityRe.source.slice(1)}" cho kết quả này`);
  }
  // Chờ file tải về; song song để ý thông báo lỗi của Flow để dừng ngay thay vì chờ hết `timeout`
  let settled = false;
  const failure = (async () => {
    while (!settled) {
      await sleep(1500);
      const notice = settled ? null : await downloadFailureNotice(page);
      if (notice) throw new Error(`Flow báo: ${notice}`);
    }
    return null;
  })();
  failure.catch(() => {});
  try {
    const dl = await Promise.race([waitDownload, failure]);
    await dl.saveAs(outputFile);
  } finally {
    settled = true;
  }
}

/**
 * Tải kết quả MỚI NHẤT đã hoàn thành trên Flow (video hoặc ảnh) — dùng khi hệ thống tự động gặp lỗi lúc tải về,
 * hoặc người dùng tự tạo bằng tay trong cửa sổ Chrome. kind 'image': lấy ô ảnh (không phải video, không phải file tải lên);
 * imageQuality ('2K' | '4K'): tải bản phóng to qua menu Download như job ảnh thường.
 */
export async function downloadLatestFromFlow(outputFile, kind = 'video', onResult = () => {}, { imageQuality = null, videoQuality = videoDownloadOf(), log = () => {} } = {}) {
  return runFlowWithErrorShow(async () => {
    const page = await flowPage();
    await page.bringToFront();
    // Cửa sổ Flow đang ở trang chủ (vd. vừa mở lại Chrome) thì chưa có lưới kết quả -> mở dự án dùng chung trước.
    // Đang ở một dự án bất kỳ (kể cả dự án người dùng tự mở để tạo bằng tay) thì giữ nguyên.
    if (!page.url().includes('/project/') && db.settings?.flowProjectUrl) {
      await openProject(page, db.settings);
      await sleep(1500);
    }
    await scrollTilesTop(page);
    await sleep(600);

    const all = await tiles(page);
    const isVideoTile = (t) => t.hasVideo || !!t.src || /play_circle|video/i.test(t.icons || '') || /play_circle|video/i.test(t.text || '');
    const candidate = all.find((t) =>
      !isUploadTile(t, []) &&
      !isFailed(t) &&
      !isGenerating(t) &&
      (kind === 'image' ? !isVideoTile(t) && /^https?:/.test(t.isrc || '') : isVideoTile(t))
    );

    if (!candidate) {
      throw new Error(kind === 'image'
        ? 'Không tìm thấy ảnh nào đã hoàn thành trên Flow. Hãy đảm bảo ảnh đã render xong trong cửa sổ Chrome (ô mới nhất ở đầu lưới).'
        : 'Không tìm thấy video nào đã hoàn thành trên Flow. Hãy đảm bảo bạn đã render xong video trong cửa sổ Chrome.');
    }

    const tile = page.locator(TILE).nth(candidate.i);
    const title = (await tile.getAttribute('aria-label').catch(() => '')) || candidate.key || '';
    await downloadTile(page, tile, outputFile, kind, onResult, { imageQuality, videoQuality: kind === 'image' ? null : videoQuality, log });
    return { outputFile, title, tileMedia: tileMedia(candidate) };
  });
}

// Giữ tên cũ cho các chỗ đang gọi
export const downloadLatestVideoFromFlow = (outputFile, onResult) => downloadLatestFromFlow(outputFile, 'video', onResult);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
