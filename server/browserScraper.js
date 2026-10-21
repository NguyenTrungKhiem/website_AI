// Lấy dữ liệu sản phẩm bằng trình duyệt thật (cửa sổ Chrome đang dùng cho Flow).
// Shopee/Lazada/TikTok Shop vẽ trang bằng JavaScript và chặn bot, nên tải HTML "chay" lúc được lúc không;
// mở bằng Chrome thật thì trang tự gọi API nội bộ của sàn -> ta đọc luôn JSON đó (đủ bộ ảnh gốc, tên, giá).
import { connect } from './flow.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CDN = /susercontent\.com|lazcdn\.com|slatic\.net|alicdn\.com|tiktokcdn|ibyteimg\.com|byteimg\.com/i;

// Ảnh Shopee: bỏ hậu tố thu nhỏ (_tn, @resize_w82_nl.webp…) để lấy bản gốc
export function normalizeImageUrl(u) {
  if (!u) return null;
  let s = String(u).trim();
  if (s.startsWith('//')) s = 'https:' + s;
  if (!/^https?:\/\//i.test(s)) return null;
  if (/susercontent\.com/i.test(s)) s = s.replace(/@[^/?#]*$/, '').replace(/_tn$/, '');
  if (/lazcdn\.com|slatic\.net|alicdn\.com/i.test(s)) s = s.replace(/_\d+x\d+(q\d+)?(\.\w+)?(_\.webp)?$/, '').replace(/\.webp$/, '');
  return s;
}

const shopeeImg = (hash) => (/^https?:/.test(hash) ? normalizeImageUrl(hash) : `https://down-vn.img.susercontent.com/file/${hash}`);

// Mọi dạng link Shopee có shopId/itemId -> 1 dạng chuẩn mà Shopee luôn mở được (slug tuỳ ý)
export function canonicalShopeeUrl(u) {
  try {
    const url = new URL(u);
    const host = url.hostname.toLowerCase();
    if (!/(shopee\.|shope\.ee|shp\.ee)/.test(host)) return null;
    const p = decodeURIComponent(url.pathname);
    const m = p.match(/-i\.(\d+)\.(\d+)/)
           || p.match(/\/product\/(\d+)\/(\d+)/)
           || p.match(/\/[^/]+\/(\d{4,})\/(\d{6,})(?:\/|$)/)
           || p.match(/\/opaanlp\/(\d+)\/(\d+)/);
    const shop = m?.[1] || url.searchParams.get('shopid');
    const item = m?.[2] || url.searchParams.get('itemid');
    const baseHost = /(shope\.ee|shp\.ee|s\.shopee\.vn)/.test(host) ? 'shopee.vn' : host;
    return shop && item ? `https://${baseHost}/product-i.${shop}.${item}` : null;
  } catch {
    return null;
  }
}

const isShopeeProductPage = (u) => /(shopee\.[a-z.]+|shope\.ee|shp\.ee)\/.*(-i\.\d+\.\d+|\/product\/\d+\/\d+|\/opaanlp\/\d+\/\d+|\/universal-link\/)/i.test(u);

/**
 * Mở url trong tab mới của Chrome (Flow), gom: JSON API sản phẩm của sàn, thẻ meta, ảnh trong DOM.
 * Trả về null nếu Chrome chưa mở. Không ném lỗi vì trang chặn — trả về những gì lấy được.
 */
export async function fetchProductWithBrowser(url, { timeoutMs = 25_000 } = {}) {
  let browser;
  try {
    browser = await connect();
  } catch {
    return null; // chưa mở Chrome cho Flow
  }
  const ctx = browser.contexts()[0];
  // Tab của lần trước bị chặn (để người dùng giải captcha) -> đóng khi bắt đầu lần mới
  if (pendingTab) { await pendingTab.close().catch(() => {}); pendingTab = null; }
  const page = await ctx.newPage();
  const found = { shopeeData: null, lazadaItem: null, tiktokItem: null, apiHits: [] };

  page.on('response', async (res) => {
    const u = res.url();
    try {
      if (/shopee\.[a-z.]+\/api\/v4\/(pdp\/get_pc|item\/get|pdp\/get_rw)/.test(u)) {
        const j = await res.json();
        // get_pc: data = { item: {title, image, tier_variations…}, product_images: {images: [hash…]}, product_price: {price: {single_value…}} }
        // item/get (cũ): data = item = { name, images: [hash…], price… }
        const d = j?.data || j;
        if (d?.product_images || d?.item || d?.images?.length) { found.shopeeData = d; found.apiHits.push(u); }
      } else if (/lazada\.[a-z.]+\/.*(pdp|getDetail|product).*\.json|mtop\.lazada/.test(u)) {
        const j = await res.json();
        const item = j?.data?.root?.fields?.skuGalleries || j?.data?.item;
        if (item) { found.lazadaItem = j.data; found.apiHits.push(u); }
      } else if (/tiktok\.com\/api\/(shop|product)|oec-api|\/api\/v1\/product\/detail/.test(u)) {
        const j = await res.json();
        if (j?.data) { found.tiktokItem = j.data; found.apiHits.push(u); }
      }
    } catch {}
  });

  try {
    const target = canonicalShopeeUrl(url) || url;
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => {});
    // Chờ API sản phẩm (ưu tiên, có đủ bộ ảnh gốc + giá); không có API thì chờ ảnh CDN trong DOM
    const start = Date.now();
    const deadline = start + timeoutMs;
    while (Date.now() < deadline) {
      if (found.shopeeData || found.lazadaItem || found.tiktokItem) break;
      const n = await page.locator('img[src*="susercontent"], img[src*="lazcdn"], img[src*="slatic"], img[src*="tiktokcdn"], img[src*="ibyteimg"]').count().catch(() => 0);
      // Đã có ảnh trong DOM nhưng vẫn cho API thêm thời gian (tối đa 8s kể từ lúc mở trang)
      if (n >= 3 && Date.now() - start > 8000) break;
      await sleep(500);
    }
    await sleep(800); // cho listener kịp đọc xong JSON
    const finalUrl = page.url();
    const dom = await page.evaluate(() => {
      const meta = (p) => document.querySelector(`meta[property="${p}"], meta[name="${p}"]`)?.getAttribute('content') || '';
      // Chỉ lấy ảnh đủ lớn và không phải avatar / đánh giá / logo shop / icon
      const junk = /avatar|rating|shop|logo|icon|badge|flag|banner|voucher/i;
      const imgs = [...document.querySelectorAll('img')]
        .filter((im) => {
          const w = im.naturalWidth || im.width || 0;
          const h = im.naturalHeight || im.height || 0;
          return w >= 60 && h >= 60 && !junk.test((im.className || '') + ' ' + (im.alt || '')) && !junk.test(im.closest('[class*="avatar"],[class*="rating"],[class*="shop"]')?.className || '');
        })
        .map((im) => im.currentSrc || im.src);
      const jsonLd = [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent);
      return { title: document.title, ogTitle: meta('og:title'), ogImage: meta('og:image'), ogDesc: meta('og:description'), imgs, jsonLd, bodyText: document.body?.innerText?.slice(0, 300) || '' };
    }).catch(() => ({ title: '', ogTitle: '', ogImage: '', ogDesc: '', imgs: [], jsonLd: [], bodyText: '' }));

    const blocked = /robot or human|captcha|xác minh|verify/i.test(dom.title) || /\/verify|captcha/i.test(finalUrl);
    // Shopee chuyển về trang chủ / tìm kiếm (link hỏng, sản phẩm đã gỡ…) -> không lấy ảnh linh tinh từ trang đó
    const notProduct = /shopee\./i.test(finalUrl) && !found.shopeeData && !isShopeeProductPage(finalUrl);
    if (notProduct) dom.imgs = [], dom.ogImage = '', dom.jsonLd = [];
    if (blocked && !found.shopeeData) {
      // Giữ tab mở và đưa ra trước để người dùng tự qua bước xác minh của sàn
      pendingTab = page;
      await page.bringToFront().catch(() => {});
    }
    return { finalUrl, blocked, notProduct, ...found, dom };
  } finally {
    if (pendingTab !== page) await page.close().catch(() => {});
  }
}
let pendingTab = null;

// Chuẩn hoá kết quả trình duyệt thành { title, description, price, images[] }
export function parseBrowserResult(r) {
  const images = [];
  const seen = new Set();
  const add = (u, name = null) => {
    const s = normalizeImageUrl(u);
    if (!s || seen.has(s) || !CDN.test(s)) return;
    // bỏ icon/logo/ảnh nhỏ của giao diện
    if (/\/(icon|logo|flag|badge|sprite)|\.svg($|\?)|\/assets\//i.test(s)) return;
    seen.add(s);
    images.push({ id: s, url: s, name, isFallback: false });
  };
  let title = '';
  let description = '';
  let price = null;

  const d = r.shopeeData;
  const it = d?.item || (d?.images?.length ? d : null);
  if (d) {
    title = it?.title || it?.name || '';
    description = it?.description || d?.product_attributes?.description || '';
    // Giá Shopee nhân 100000
    const pp = d.product_price?.price;
    const raw = pp ? (pp.single_value > 0 ? pp.single_value : pp.range_min > 0 ? pp.range_min : null) : (it?.price ?? it?.price_min ?? null);
    if (raw != null && raw > 0) price = Math.round(Number(raw) / 100000);
    // Bộ ảnh chính của sản phẩm
    for (const h of d.product_images?.images || it?.images || []) add(shopeeImg(h));
    if (it?.image) add(shopeeImg(it.image));
    // Ảnh theo phân loại (màu…) nếu có
    for (const tier of it?.tier_variations || []) {
      (tier.images || []).forEach((h, i) => h && add(shopeeImg(h), `${tier.name || 'Phân loại'}: ${tier.options?.[i] || i + 1}`));
    }
    for (const m of it?.models || d?.product_variations?.models || []) if (m.image) add(shopeeImg(m.image), m.name);
  }

  // JSON-LD / og:image / ảnh trong DOM (áp dụng cho mọi sàn)
  for (const txt of r.dom?.jsonLd || []) {
    try {
      const parsed = JSON.parse(txt);
      const items = Array.isArray(parsed) ? parsed : parsed['@graph'] || [parsed];
      for (const item of items) {
        if (!/product/i.test(item?.['@type'] || '')) continue;
        if (!title && item.name) title = item.name;
        if (!description && item.description) description = item.description;
        const ims = Array.isArray(item.image) ? item.image : [item.image];
        for (const im of ims) add(typeof im === 'string' ? im : im?.url || im?.contentUrl);
        const offers = Array.isArray(item.offers) ? item.offers[0] : item.offers;
        if (price == null && offers?.price != null) price = parseFloat(offers.price);
      }
    } catch {}
  }
  if (!title) title = r.dom?.ogTitle || '';
  if (!description) description = r.dom?.ogDesc || '';
  if (r.dom?.ogImage) add(r.dom.ogImage);
  for (const u of r.dom?.imgs || []) add(u);

  return { title, description, price, images, source: d ? 'api' : images.length ? 'dom' : 'none' };
}
