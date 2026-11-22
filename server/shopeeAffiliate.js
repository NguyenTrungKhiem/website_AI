// HOA HỒNG SHOPEE của 1 sản phẩm — API nội bộ affiliate.shopee.vn/api/v3/offer/product?item_id=… (trang "Chi tiết hoa hồng").
//
// Đã thử thật (22/11/2026, cookie chủ web):
//   - chỉ cookie, gọi từ server (undici)            → HTTP 403 {"is_login":true,"error":90309999}: cookie đúng, THIẾU CHỮ KÝ
//   - cookie + header x-sap-sec… của đúng request đó → 200; cùng chữ ký cho item khác → 90309999 ⇒ chữ ký gắn với TỪNG request,
//     do SDK chống bot (SAP/SZ) của trang sinh → không nhập tay / không tái tạo ở server được (đúng web-site-aff CLAUDE.md §5.13)
//   - Chrome HEADLESS + cookie                      → bị đẩy sang shopee.vn/verify/traffic/error (XHR chạy nhầm origin → 404 error_not_found)
//   - Chrome RIÊNG có giao diện nhưng THU NHỎ + cookie (profile mới) → dashboard đăng nhập, offer/product 200 cho mọi item thử
// ⇒ Cách dùng: server tự chạy 1 Chrome riêng (playwright-core launchPersistentContext, profile data/shopee-chrome, cửa sổ thu nhỏ
//   dưới taskbar, KHÔNG đụng Chrome của Flow, không tab nào hiện ra), nạp cookie chủ web dán trong Cài đặt, mở affiliate.shopee.vn
//   và gọi API bằng XMLHttpRequest trong trang (page.evaluate = main world → SDK của trang ký như bấm tay).
//
// Luồng fetchShopeeOffer(itemId):
//   1. Chưa có cookie trong Cài đặt → báo ngay (không mở gì). Có cookie → mở / dùng lại Chrome riêng (giữ sống giữa các lần gọi).
//   2. Cookie đổi so với lần nạp trước (hash lưu ở settings.shopeeAffiliateCookieLoadedHash) hoặc trang bị đẩy ra đăng nhập → addCookies
//      (domain .shopee.vn) rồi tải lại affiliate.shopee.vn. Vẫn ở trang đăng nhập → needLogin (cookie hết hạn → dán lại).
//      Bị đẩy sang verify/traffic / captcha → blocked, nghỉ 10 phút.
//   3. XHR trong trang: header Affiliate-Program-Type: 1 + csrf-token (GET /api/v3/config/website → data.csrf_token, nhớ 10 phút
//      trong window.__wvCsrf). Giãn cách ≥ 2,5 s; Shopee từ chối (403 / 90309999 / captcha) → nghỉ 10 phút; đệm theo itemId 30 phút,
//      lỗi đọc → không hỏi lại 10 phút. Không ném lỗi: thiếu hoa hồng thì bóc link vẫn chạy, chỉ báo lý do.
// Test: tiêm `context` giả ({ addCookies, pages, newPage }, page { url, goto, waitForLoadState, evaluate, isClosed }) và
// SHOPEE_AFFILIATE_TAB=0 để không mở Chrome thật.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { db, DATA_DIR, updateSettings } from './db.js';
import { chromePath } from './flow.js';
import { parseShopeeOffer, pickOffer } from './shopeeOffer.js';

export const AFFILIATE_ORIGIN = 'https://affiliate.shopee.vn';
const PROFILE_DIR = path.join(DATA_DIR, 'shopee-chrome');
const MIN_INTERVAL_MS = 2500;
const BLOCK_PAUSE_MS = 10 * 60 * 1000;
const CACHE_TTL_MS = 30 * 60 * 1000;
const FAIL_TTL_MS = 10 * 60 * 1000;
const BLOCK_CODE = '90309999';
export const LOGIN_MSG = 'Cookie affiliate.shopee.vn hết hạn hoặc chưa có — mở affiliate.shopee.vn trong Chrome đã đăng nhập, chép lại giá trị Cookie (F12 → Network) dán vào Cài đặt → Hoa hồng Shopee rồi bóc tách lại.';
export const NO_COOKIE_MSG = 'Chưa có cookie affiliate.shopee.vn trong Cài đặt → Hoa hồng Shopee — dán cookie vào đó (web tự gọi Shopee bằng Chrome riêng thu nhỏ, không mở tab) hoặc nhập hoa hồng tay.';
export const NO_CHROME_MSG = NO_COOKIE_MSG; // tương thích import cũ
export const NO_LAUNCH_MSG = 'Không mở được Chrome / Edge trên máy để gọi Shopee (cần cài Google Chrome hoặc Microsoft Edge).';
const TRAFFIC_MSG = 'Shopee đang chặn lưu lượng của trình duyệt này (verify/traffic) — web nghỉ 10 phút rồi tự thử lại; đừng bóc link dồn dập.';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clock = (t) => new Date(t).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });

const cache = new Map(); // itemId -> { at, result }
let blockedUntil = 0;
let lastCallAt = 0;
let queue = Promise.resolve(); // gọi tuần tự (1 trang, giãn cách)
let loadedCookieHash = ''; // hash chuỗi cookie đã nạp vào Chrome riêng (RAM; bản bền ở settings)
let ownCtx = null; // context Chrome riêng đang mở
let ownPage = null;

export const isAffiliateUrl = (u) => /^https:\/\/affiliate\.shopee\.vn(\/|$)/i.test(String(u || ''));
const isLoginUrl = (u) => /\/(login|signin|sign-in|register)(\/|\?|$)|accounts\.shopee|\/seller\/login/i.test(String(u || ''));
const isTrafficUrl = (u) => /\/verify\/(traffic|captcha)|captcha|anti_bot/i.test(String(u || ''));

/** Trạng thái để hiện trên giao diện / chẩn đoán */
export function affiliateStatus() {
  return { blockedUntil: blockedUntil > Date.now() ? blockedUntil : 0, cached: cache.size, hasCookie: !!normalizeCookie(db.settings?.shopeeAffiliateCookie), cookieLoaded: !!loadedHash(), browserOpen: !!ownCtx };
}
export function clearOfferCache() {
  cache.clear();
  blockedUntil = 0;
  loadedCookieHash = '';
  if (db.settings?.shopeeAffiliateCookieLoadedHash) updateSettings({ shopeeAffiliateCookieLoadedHash: '' });
}
/** Đóng Chrome riêng (khi tắt server) */
export async function closeAffiliateBrowser() {
  const c = ownCtx;
  ownCtx = null;
  ownPage = null;
  if (c) await c.close().catch(() => {});
}

// ── Cookie chủ web dán ───────────────────────────────────────────────────────

/**
 * Chuỗi cookie người dùng dán (giá trị header "Cookie" trong DevTools, có thể kèm "Cookie:" / xuống dòng / dấu ; cuối)
 * → 1 dòng "a=b; c=d". Rỗng / không có dấu "=" → ''.
 */
export function normalizeCookie(raw) {
  let s = String(raw || '').replace(/^\s*cookie\s*:\s*/i, '').replace(/[\r\n]+/g, ' ').trim();
  s = s.split(';').map((p) => p.trim()).filter((p) => p.includes('=')).join('; ');
  return s.length > 20 ? s : '';
}

/** "a=b; c=d%3D" → [{ name: 'a', value: 'b' }, …] (giá trị giữ nguyên, kể cả "=" / "%" bên trong; trùng tên lấy cái sau) */
export function parseCookieHeader(raw) {
  const out = new Map();
  for (const part of normalizeCookie(raw).split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (/^[\w.-]+$/.test(name)) out.set(name, value);
  }
  return [...out].map(([name, value]) => ({ name, value }));
}

/** Cookie cho Playwright context.addCookies: domain .shopee.vn (gửi tới affiliate.shopee.vn và shopee.vn), path /, https */
export const cookiesForChrome = (raw) => parseCookieHeader(raw).map((c) => ({ ...c, domain: '.shopee.vn', path: '/', secure: true, sameSite: 'Lax' }));

const cookieHash = (ck) => (ck ? crypto.createHash('sha1').update(ck).digest('hex').slice(0, 12) : '');
// Hash cookie đã nạp: RAM, dự phòng bản lưu trong Cài đặt (qua khởi động lại server vẫn biết cookie này đã nạp rồi)
const loadedHash = () => loadedCookieHash || String(db.settings?.shopeeAffiliateCookieLoadedHash || '');
function rememberLoaded(h) {
  loadedCookieHash = h;
  if (db.settings && db.settings.shopeeAffiliateCookieLoadedHash !== h) updateSettings({ shopeeAffiliateCookieLoadedHash: h });
}

/**
 * Nạp cookie chủ web vào context Chrome riêng. Chỉ nạp khi cần: chuỗi cookie khác lần nạp trước (dán cookie mới), force (nút Thử),
 * hoặc trang đang bị đẩy ra đăng nhập (phiên trong Chrome hết hạn). Phiên trong profile vẫn tốt thì KHÔNG nạp đè — Shopee tự gia
 * hạn cookie trong Chrome, cookie cũ dán trong Cài đặt có thể đã lạc hậu. Trả true khi vừa nạp.
 */
export async function ensureAffiliateSession(ctx, cookie, { force = false, atLogin = false } = {}) {
  const ck = normalizeCookie(cookie);
  if (!ck) return false;
  const h = cookieHash(ck);
  if (!force && !atLogin && h === loadedHash()) return false;
  await ctx.addCookies(cookiesForChrome(ck));
  rememberLoaded(h);
  return true;
}

// ── Chrome riêng (thu nhỏ) ───────────────────────────────────────────────────

/**
 * Context Chrome riêng cho Shopee: profile data/shopee-chrome, cửa sổ thu nhỏ (--start-minimized), giữ sống giữa các lần gọi;
 * người dùng đóng cửa sổ thì lần sau mở lại. Headless bị Shopee chặn (verify/traffic) nên phải có giao diện. Trả null nếu không có
 * Chrome / Edge trên máy.
 */
async function affiliateContext() {
  if (ownCtx) return ownCtx;
  const exe = chromePath();
  if (!exe) return null;
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    executablePath: exe,
    headless: false,
    locale: 'vi-VN',
    viewport: null,
    args: ['--start-minimized', '--window-size=900,600', '--no-first-run', '--no-default-browser-check'],
  });
  ctx.on('close', () => {
    if (ownCtx === ctx) {
      ownCtx = null;
      ownPage = null;
    }
  });
  ownCtx = ctx;
  return ctx;
}

async function loadAffiliate(page) {
  await page.goto(`${AFFILIATE_ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {});
  // Chờ chuyển hướng (sang trang đăng nhập nếu chưa đăng nhập) và SDK chống bot của trang khởi tạo xong rồi mới gọi API
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await sleep(800);
}

// Trang affiliate.shopee.vn trong Chrome riêng: dùng lại 1 trang; reload = vừa nạp cookie → tải lại
async function affiliatePage(ctx, { reload = false } = {}) {
  const pages = ctx.pages();
  let page = ownPage && !ownPage.isClosed() && pages.includes(ownPage) ? ownPage : pages.find((p) => !p.isClosed()) || null;
  if (!page) page = await ctx.newPage();
  ownPage = page;
  if (reload || !isAffiliateUrl(page.url())) await loadAffiliate(page);
  return page;
}

/**
 * Chạy TRONG trang affiliate.shopee.vn — phải tự chứa, không dùng biến bên ngoài (Playwright tuần tự hoá hàm này).
 * XMLHttpRequest như chính trang để SDK chống bot gắn chữ ký. csrf-token lấy từ GET /api/v3/config/website, nhớ 10 phút
 * trong window.__wvCsrf; 403 / lỗi csrf (không phải mã chống bot) → lấy token mới, thử lại 1 lần.
 */
async function pageRequest(path) {
  const BASE = { accept: 'application/json, text/plain, */*', 'affiliate-program-type': '1' };
  const KEY = '__wvCsrf';
  const send = (p, headers) =>
    new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', p, true);
      xhr.withCredentials = true;
      xhr.timeout = 15000;
      Object.keys(headers).forEach((k) => xhr.setRequestHeader(k, headers[k]));
      xhr.onload = () => resolve({ status: xhr.status, text: String(xhr.responseText || '').slice(0, 400000), url: xhr.responseURL || '', csrfHeader: xhr.getResponseHeader('csrf-token') || '' });
      xhr.onerror = () => resolve({ status: 0, text: '', url: '', error: 'Lỗi mạng khi gọi Shopee từ trang.' });
      xhr.ontimeout = () => resolve({ status: 0, text: '', url: '', error: 'Shopee không phản hồi (quá 15 giây).' });
      xhr.send(null);
    });
  const getToken = async (force) => {
    const c = window[KEY];
    if (!force && c && c.token && Date.now() - c.at < 600000) return c.token;
    const r = await send('/api/v3/config/website', BASE);
    let tok = '';
    try {
      const j = JSON.parse(r.text);
      tok = (j && j.data && j.data.csrf_token) || '';
    } catch (e) {
      /* không phải JSON */
    }
    tok = String(tok || r.csrfHeader || '');
    window[KEY] = { token: tok, at: Date.now() };
    return { token: tok, status: r.status, url: r.url, text: r.text.slice(0, 300) };
  };
  const first = await getToken(false);
  if (typeof first === 'object' && first.status === 401) return { status: 401, text: first.text, url: first.url, csrfFound: false, loginPage: location.href };
  let token = typeof first === 'string' ? first : first.token;
  const headers = (tok) => ({ ...BASE, ...(tok ? { 'csrf-token': tok } : {}) });
  let res = await send(path, headers(token));
  const antiBot = String(res.text).includes('90309999');
  if (!antiBot && (res.status === 403 || /csrf/i.test(String(res.text).slice(0, 600)))) {
    const t = await getToken(true);
    token = typeof t === 'string' ? t : t.token;
    if (token) res = await send(path, headers(token));
  }
  if (res.csrfHeader) window[KEY] = { token: res.csrfHeader, at: Date.now() };
  return { ...res, csrfFound: !!token, loginPage: location.href };
}

/**
 * Phản hồi thô → { ok, json } | { ok:false, reason: 'needLogin' | 'blocked' | 'notFound' | 'error', message }.
 * notFound = Shopee trả 404 error_not_found khi trang vẫn ở affiliate.shopee.vn: sản phẩm không có ưu đãi (shop không tham gia
 * Affiliate / đã gỡ). Trang KHÔNG ở affiliate.shopee.vn (bị đẩy sang verify/traffic) mà 404 → blocked (XHR chạy nhầm origin).
 */
export function checkRaw(raw) {
  if (!raw) return { ok: false, reason: 'error', message: 'Không nhận được phản hồi từ Shopee.' };
  const status = Number(raw.status) || 0;
  if (raw.error) return { ok: false, reason: 'error', message: raw.error };
  const url = String(raw.url || '').toLowerCase();
  const text = String(raw.text || '');
  const onAffiliate = raw.loginPage == null || isAffiliateUrl(raw.loginPage);
  if (isTrafficUrl(url) || isTrafficUrl(raw.loginPage) || text.includes('verify/traffic')) return { ok: false, reason: 'blocked', message: TRAFFIC_MSG };
  if (status === 401 || isLoginUrl(url) || isLoginUrl(raw.loginPage)) return { ok: false, reason: 'needLogin', message: LOGIN_MSG };
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* không phải JSON */
  }
  if (!json) {
    if (status === 403) return { ok: false, reason: 'blocked', message: `Shopee từ chối request (HTTP 403).` };
    if (/<html/i.test(text) && /login|đăng nhập/i.test(text)) return { ok: false, reason: 'needLogin', message: LOGIN_MSG };
    return { ok: false, reason: 'error', message: `Shopee trả HTTP ${status}, không phải JSON (${text.replace(/\s+/g, ' ').slice(0, 80)}).` };
  }
  const errCode = json.code != null && json.code !== '' && Number(json.code) !== 0 ? json.code : json.error ? json.error : null;
  if (status >= 400 || errCode != null) {
    const msg = json.msg || json.message || (errCode != null ? `mã lỗi ${errCode}` : '') || `HTTP ${status}`;
    if (/login|session|unauthori|not log|đăng nhập/i.test(String(msg)) || status === 401) return { ok: false, reason: 'needLogin', message: LOGIN_MSG };
    if (status === 403 || String(errCode) === BLOCK_CODE) return { ok: false, reason: 'blocked', message: `Shopee từ chối request (${msg}).` };
    if (/error_not_found/i.test(String(errCode)) || status === 404) {
      if (!onAffiliate) return { ok: false, reason: 'blocked', message: TRAFFIC_MSG };
      return { ok: false, reason: 'notFound', message: 'Sản phẩm này không có ưu đãi trên Shopee Affiliate (shop không tham gia chương trình hoặc đã gỡ) — không có hoa hồng.' };
    }
    return { ok: false, reason: 'error', message: `Shopee báo lỗi: ${msg}` };
  }
  if (!json.data || typeof json.data !== 'object') return { ok: false, reason: 'error', message: 'Shopee không trả dữ liệu sản phẩm.' };
  return { ok: true, json };
}

function traceParam() {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let s = '';
  for (let i = 0; i < 11; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  const traceId = `0.${s}.107`;
  return encodeURIComponent(JSON.stringify({ trace_id: traceId, list_type: 107, root_trace_id: traceId, root_list_type: 107 }));
}

async function throttle() {
  const wait = MIN_INTERVAL_MS - (Date.now() - lastCallAt);
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
}

/**
 * Gọi offer/product trong Chrome riêng. cookie = chuỗi trong Cài đặt (hoặc chuỗi đang gõ khi bấm Thử); forceCookie = nạp lại
 * dù không đổi; context = context giả (test). Trả { ok:true, offer, raw } | { ok:false, reason, message }.
 */
async function callOffer(itemId, { cookie = '', forceCookie = false, context = null } = {}) {
  if (blockedUntil > Date.now()) return { ok: false, reason: 'blocked', message: `Shopee đang tạm từ chối request — nghỉ tới ${clock(blockedUntil)} rồi mới gọi lại.` };
  const ck = normalizeCookie(cookie);
  if (!ck) return { ok: false, reason: 'noCookie', message: NO_COOKIE_MSG };
  let ctx;
  try {
    ctx = context || (await affiliateContext());
  } catch (e) {
    return { ok: false, reason: 'noChrome', message: `${NO_LAUNCH_MSG} (${e.message})` };
  }
  if (!ctx) return { ok: false, reason: 'noChrome', message: NO_LAUNCH_MSG };
  let page;
  try {
    // Cookie đã nạp trước đó (kể cả trước khi server khởi động lại) và trang vẫn đăng nhập → dùng luôn phiên trong Chrome riêng;
    // chỉ nạp (lại) cookie khi cookie mới / bấm Thử / trang bị đẩy ra đăng nhập
    const fresh = forceCookie || cookieHash(ck) !== loadedHash();
    page = fresh ? null : await affiliatePage(ctx);
    const atLogin = !!page && isLoginUrl(page.url());
    if (fresh || atLogin) {
      await ensureAffiliateSession(ctx, ck, { force: forceCookie, atLogin });
      page = await affiliatePage(ctx, { reload: true });
    }
  } catch (e) {
    return { ok: false, reason: 'error', message: `Không mở được affiliate.shopee.vn trong Chrome riêng (${e.message}).` };
  }
  if (isTrafficUrl(page.url())) {
    blockedUntil = Date.now() + BLOCK_PAUSE_MS;
    return { ok: false, reason: 'blocked', message: TRAFFIC_MSG };
  }
  if (isLoginUrl(page.url())) return { ok: false, reason: 'needLogin', message: LOGIN_MSG };
  await throttle();
  let raw = null;
  try {
    raw = await page.evaluate(pageRequest, `/api/v3/offer/product?item_id=${itemId}&trace=${traceParam()}`);
  } catch (e) {
    return { ok: false, reason: 'error', message: `Không chạy được trong trang affiliate.shopee.vn (${e.message}).` };
  }
  const c = checkRaw(raw);
  if (!c.ok) {
    if (c.reason === 'blocked') blockedUntil = Date.now() + BLOCK_PAUSE_MS;
    return c;
  }
  const picked = pickOffer(c.json);
  return { ok: true, offer: parseShopeeOffer(picked, itemId), raw: picked };
}

/**
 * Hoa hồng của 1 sản phẩm Shopee theo itemId → { ok:true, offer (parseShopeeOffer), raw, cached } hoặc
 * { ok:false, reason: 'noCookie' | 'noChrome' | 'needLogin' | 'blocked' | 'notFound' | 'error', message }. Không ném lỗi.
 * tab=false (test / SHOPEE_AFFILIATE_TAB=0) → không mở Chrome.
 */
export async function fetchShopeeOffer(itemId, { force = false, tab = process.env.SHOPEE_AFFILIATE_TAB !== '0', context = null } = {}) {
  const id = String(itemId || '').trim();
  if (!/^\d{1,20}$/.test(id)) return { ok: false, reason: 'error', message: 'item_id không hợp lệ.' };
  const hit = cache.get(id);
  if (!force && hit && Date.now() - hit.at < (hit.result.ok ? CACHE_TTL_MS : FAIL_TTL_MS)) return { ...hit.result, cached: true };
  if (!tab && !context) return { ok: false, reason: 'noChrome', message: NO_COOKIE_MSG };
  const job = queue.then(() => callOffer(id, { cookie: db.settings?.shopeeAffiliateCookie, context })).catch((e) => ({ ok: false, reason: 'error', message: e.message }));
  queue = job.then(() => {}, () => {});
  const result = await job;
  // Lỗi do Chrome / cookie thì không nhớ (người dùng sửa xong bóc lại là có ngay); notFound nhớ như kết quả
  if (result.ok || result.reason === 'error' || result.reason === 'notFound') cache.set(id, { at: Date.now(), result });
  return result;
}

/**
 * Nút "Thử cookie" trong Cài đặt: nạp cookie đang gõ vào Chrome riêng (mở nếu cần), gọi offer/product cho 1 sản phẩm mẫu
 * → { ok, name, priceVnd, commissionVnd, message }. Không dùng bộ nhớ đệm.
 */
export const SAMPLE_ITEM_ID = '27801446579'; // Bảng phấn tạo khối JUDYDOLL — item chủ web gửi 22/11/2026
export async function testAffiliateCookie(cookie, { itemId = SAMPLE_ITEM_ID, context = null } = {}) {
  const ck = normalizeCookie(cookie);
  if (!ck) return { ok: false, reason: 'error', message: 'Chưa dán cookie (cần chuỗi dạng "SPC_EC=…; SPC_U=…; …").' };
  const id = /^\d{1,20}$/.test(String(itemId || '')) ? String(itemId) : SAMPLE_ITEM_ID;
  const job = queue.then(() => callOffer(id, { cookie: ck, forceCookie: true, context })).catch((e) => ({ ok: false, reason: 'error', message: e.message }));
  queue = job.then(() => {}, () => {});
  const r = await job;
  if (!r.ok && r.reason === 'notFound') return { ok: false, reason: 'notFound', message: `Cookie hợp lệ (Shopee đã trả lời) nhưng sản phẩm ${id} không có ưu đãi Affiliate — thử với item_id của sản phẩm khác.` };
  if (!r.ok) return { ok: false, reason: r.reason, message: r.message };
  const o = r.offer;
  cache.set(id, { at: Date.now(), result: r });
  return { ok: true, name: o.name, priceVnd: o.priceVnd, commissionVnd: o.commissionVnd, confidence: o.confidence, message: `Cookie dùng được: ${o.name || `item ${id}`} — hoa hồng ${o.commissionVnd != null ? o.commissionVnd.toLocaleString('vi-VN') + 'đ' : 'không đọc được'}.` };
}
