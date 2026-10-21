import fs from 'node:fs';
import path from 'node:path';
import { fetch } from 'undici';
import { db, save, DIRS, newId, mediaUrl } from './db.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const ACCEPT_HEADER = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8';
const ACCEPT_LANG = 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7';

const SHOPEE_IMG_HOST = 'down-vn.img.susercontent.com';
const shopeeImageUrl = (hash) => {
  if (!hash) return null;
  let h = String(hash).trim().replace(/@[^/?#]*$/, '').replace(/_tn$/, '');
  if (/^https?:\/\//i.test(h)) return h;
  return `https://${SHOPEE_IMG_HOST}/file/${h}`;
};

/**
 * ============================================================================
 * BƯỚC 1: Nhận diện sàn & Theo vết chuyển hướng (Follow Redirects)
 * ============================================================================
 */
export function detectPlatform(urlStr) {
  try {
    const u = new URL(urlStr.startsWith('http') ? urlStr : `https://${urlStr}`);
    const host = u.hostname.toLowerCase();
    if (/(^|\.)(shopee\.vn|shope\.ee|shp\.ee|s\.shopee\.vn|shopee\.com)/.test(host)) return 'shopee';
    if (/(^|\.)(lazada\.vn|lzd\.co|lazada\.com|s\.lazada\.vn)/.test(host)) return 'lazada';
    if (/(^|\.)(tiktok\.com|tiktokshop\.com|tiktokv\.com|vt\.tiktok\.com)/.test(host)) return 'tiktok';
  } catch {}
  return 'unknown';
}

export function getPlatformLabel(platform) {
  switch (platform) {
    case 'shopee': return 'Shopee';
    case 'lazada': return 'Lazada';
    case 'tiktok': return 'TikTok Shop';
    default: return 'Thương mại điện tử';
  }
}

/**
 * Chuẩn hóa URL Shopee từ bất kỳ định dạng nào (affiliate landing page opaanlp, link ngắn, v.v.)
 * về dạng chuẩn product-i.<shopId>.<itemId> mà Shopee luôn mở được đầy đủ dữ liệu SSR.
 */
export function normalizeShopeeUrl(urlStr) {
  try {
    const u = new URL(urlStr.startsWith('http') ? urlStr : `https://${urlStr}`);
    const host = u.hostname.toLowerCase();
    if (!/(shopee\.|shope\.ee|shp\.ee)/.test(host)) return urlStr;
    const p = decodeURIComponent(u.pathname);
    const m = p.match(/\/opaanlp\/(\d+)\/(\d+)/)
           || p.match(/-i\.(\d+)\.(\d+)/)
           || p.match(/\/product\/(\d+)\/(\d+)/)
           || p.match(/\/[^/]+\/(\d{4,})\/(\d{6,})(?:\/|$)/);
    const shop = m?.[1] || u.searchParams.get('shopid');
    const item = m?.[2] || u.searchParams.get('itemid');
    if (shop && item) {
      return `https://shopee.vn/product-i.${shop}.${item}`;
    }
  } catch {}
  return urlStr;
}

export async function resolveRedirects(rawUrl, maxRedirects = 8) {
  let u = (rawUrl || '').trim();
  if (!u) throw new Error('Chưa nhập đường link sản phẩm');
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;

  for (let i = 0; i < maxRedirects; i++) {
    // Nếu URL chứa tham số next=... (thường thấy ở redirect xác minh của Shopee/Lazada)
    try {
      const parsedUrl = new URL(u);
      const nextParam = parsedUrl.searchParams.get('next') || parsedUrl.searchParams.get('target');
      if (nextParam && /^https?:\/\//i.test(nextParam)) {
        u = nextParam;
      }
    } catch {}

    const platform = detectPlatform(u);
    // Thử tách ID; nếu đã ra ID đầy đủ và không phải link rút gọn hay link affiliate trung gian thì có thể dừng sớm
    const ids = parseProductIds(u, platform);
    const isShortLink = /(shope\.ee|shp\.ee|s\.shopee\.vn|lzd\.co|s\.lazada\.vn|vt\.tiktok\.com)/i.test(u);
    const isAffiliateLanding = /\/opaanlp\/\d+\/\d+/i.test(u);
    if (ids && !isShortLink && !isAffiliateLanding) {
      return { finalUrl: normalizeShopeeUrl(u), platform };
    }

    try {
      // Dùng Desktop UA cho redirect để các sàn (đặc biệt Shopee Affiliate) trả mã HTTP 301/302 chuẩn thay vì trang HTML 200 mời tải app.
      const res = await fetch(u, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'user-agent': UA,
          'accept': ACCEPT_HEADER,
          'accept-language': ACCEPT_LANG,
        },
      });

      const loc = res.headers.get('location');
      if (!loc) {
        break;
      }
      u = new URL(loc, u).href;
    } catch (err) {
      // Nếu lỗi fetch do network, trả về URL hiện tại
      break;
    }
  }

  const finalUrl = normalizeShopeeUrl(u);
  return { finalUrl, platform: detectPlatform(finalUrl) };
}

/**
 * ============================================================================
 * BƯỚC 2: Tách mã định danh (Product ID, Shop ID) từ URL (Regex Parser)
 * ============================================================================
 */
export function parseProductIds(urlStr, platform) {
  try {
    const u = new URL(urlStr);
    const pathname = decodeURIComponent(u.pathname);
    const search = u.searchParams;

    if (platform === 'shopee') {
      // Mẫu /opaanlp/<shopId>/<itemId> (Shopee Affiliate Landing Page)
      const m0 = pathname.match(/\/opaanlp\/(\d+)\/(\d+)/);
      if (m0) return { shopId: m0[1], itemId: m0[2] };

      // Mẫu -i.<shopId>.<itemId>
      const m1 = pathname.match(/-i\.(\d+)\.(\d+)/);
      if (m1) return { shopId: m1[1], itemId: m1[2] };

      // Mẫu /product/<shopId>/<itemId>
      const m2 = pathname.match(/\/product\/(\d+)\/(\d+)/);
      if (m2) return { shopId: m2[1], itemId: m2[2] };

      // Mẫu /slug/<shopId>/<itemId>
      const m3 = pathname.match(/\/[A-Za-z0-9_-]+\/(\d{4,})\/(\d{6,})(?:\/|$)/);
      if (m3) return { shopId: m3[1], itemId: m3[2] };

      // Query param
      if (search.get('shopid') && search.get('itemid')) {
        return { shopId: search.get('shopid'), itemId: search.get('itemid') };
      }
    }

    if (platform === 'lazada') {
      // Mẫu -i<itemId>-s<skuId>.html hoặc -i<itemId>.html
      const m = pathname.match(/-i(\d+)(?:-s(\d+))?\.html/);
      if (m) return { itemId: m[1], skuId: m[2] || null };

      // Mẫu /products/name-i<itemId>.html
      const m2 = pathname.match(/\/products\/.*?-i(\d+)/);
      if (m2) return { itemId: m2[1], skuId: null };
    }

    if (platform === 'tiktok') {
      // Mẫu /product/<productId> hoặc /view/product/<productId>
      const m = pathname.match(/(?:\/product\/|\/view\/product\/)(\d+)/);
      if (m) return { productId: m[1] };

      // Query param
      if (search.get('product_id')) return { productId: search.get('product_id') };
    }
  } catch {}
  return null;
}

/**
 * ============================================================================
 * BƯỚC 3: Bóc tách dữ liệu đa tầng từ HTML (JSON-LD, Meta, CDN)
 * ============================================================================
 */
export function extractFromHtml(html, platform, urlStr) {
  let title = '';
  let description = '';
  let price = null;
  let currency = 'VND';
  const images = [];
  const seenImgs = new Set();

  const addImg = (url, name = null) => {
    if (!url || typeof url !== 'string') return;
    let clean = url.trim();
    if (clean.startsWith('//')) clean = 'https:' + clean;
    if (!/^https?:\/\//i.test(clean)) return;
    // Bỏ các logo tĩnh, banner hệ thống và ảnh placeholder của sàn
    if (/(homepagefe|shopee-mobilemall-live|shopee_logo|default_logo|\/assets\/)/i.test(clean)) return;
    // Bỏ các hậu tố thu nhỏ của Shopee (@resize_..., _tn) để lấy ảnh gốc độ nét cao
    clean = clean.replace(/@[^/?#]*$/, '').replace(/_tn$/, '');
    if (seenImgs.has(clean)) return;
    seenImgs.add(clean);
    images.push({ id: clean, url: clean, name, isFallback: false });
  };

  if (!html || typeof html !== 'string') {
    return { title, description, price, currency, images };
  }

  // --- TẦNG 1: Dữ liệu có cấu trúc Schema.org / JSON-LD ---
  const jsonLdMatches = html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const match of jsonLdMatches) {
    try {
      const parsed = JSON.parse(match[1]);
      const items = Array.isArray(parsed) ? parsed : parsed['@graph'] ? parsed['@graph'] : [parsed];
      for (const item of items) {
        if (!item) continue;
        const type = (item['@type'] || '').toLowerCase();
        if (type === 'product' || type.includes('product')) {
          if (!title && item.name) title = item.name;
          if (!description && item.description) description = item.description;

          // Ảnh từ JSON-LD
          if (Array.isArray(item.image)) {
            for (const im of item.image) addImg(typeof im === 'string' ? im : im?.url || im?.contentUrl);
          } else if (typeof item.image === 'string') {
            addImg(item.image);
          } else if (item.image?.url) {
            addImg(item.image.url);
          }

          // Giá từ offers
          const offers = Array.isArray(item.offers) ? item.offers[0] : item.offers;
          if (offers) {
            const rawP = offers.price ?? offers.lowPrice ?? offers.highPrice;
            if (rawP != null) price = parseFloat(rawP);
            if (offers.priceCurrency) currency = offers.priceCurrency;
          }
        }
      }
    } catch {}
  }

  // --- TẦNG 2: Dữ liệu nhúng của sàn (In-page JavaScript State) ---
  // Shopee mfe-initial-data state: <script type="text/mfe-initial-data"...>
  const mfeMatch = html.match(/<script[^>]*type=["']text\/mfe-initial-data["'][^>]*>([\s\S]*?)<\/script>/i);
  if (mfeMatch) {
    try {
      const data = JSON.parse(mfeMatch[1]);
      const s = data.initialState;
      const itemsMap = s?.item?.items;
      if (itemsMap) {
        for (const k of Object.keys(itemsMap)) {
          const it = itemsMap[k];
          if (it) {
            if (!title && (it.name || it.title)) title = decodeHtmlEntities(it.name || it.title);
            if (!description && (it.description || it.desc)) description = decodeHtmlEntities(it.description || it.desc);
            if (price == null) {
              const rawP = it.price ?? it.price_min ?? it.price_before_discount;
              if (rawP != null && rawP > 0) price = rawP > 10000000 ? Math.round(rawP / 100000) : rawP;
            }
            if (it.image) addImg(shopeeImageUrl(it.image));
            if (Array.isArray(it.images)) {
              for (const h of it.images) addImg(shopeeImageUrl(h));
            }
            if (Array.isArray(it.tier_variations)) {
              for (const tv of it.tier_variations) {
                if (Array.isArray(tv.images)) {
                  for (let i = 0; i < tv.images.length; i++) {
                    const h = tv.images[i];
                    if (h) addImg(shopeeImageUrl(h), `${tv.name || 'Phân loại'}: ${tv.options?.[i] || i + 1}`);
                  }
                }
              }
            }
          }
        }
      }
    } catch {}
  }

  // Lazada: window.pageData = {...}
  const lazadaPageData = html.match(/(?:window\.)?pageData\s*=\s*({[\s\S]*?});\s*<\/script>/);
  if (lazadaPageData) {
    try {
      const pd = JSON.parse(lazadaPageData[1]);
      const mod = pd?.mods || pd;
      const item = mod?.item || pd?.item;
      if (item) {
        if (!title && item.title) title = item.title;
        if (Array.isArray(item.images)) {
          for (const im of item.images) addImg(im);
        }
        if (price == null && item.price?.salePrice?.value) {
          price = parseFloat(item.price.salePrice.value);
        }
      }
    } catch {}
  }

  // Shopee / TikTok preloaded state
  const preloadedMatch = html.match(/(?:window\.__PRELOADED_STATE__|window\.__INITIAL_DATA__)\s*=\s*({[\s\S]*?});\s*<\/script>/);
  if (preloadedMatch) {
    try {
      const state = JSON.parse(preloadedMatch[1]);
      const p = state?.product || state?.item || state?.productDetail;
      if (p) {
        if (!title && (p.title || p.name)) title = p.title || p.name;
        if (!description && (p.description || p.desc)) description = p.description || p.desc;
        if (price == null && (p.price || p.salePrice || p.minPrice)) {
          price = parseFloat(p.price || p.salePrice || p.minPrice);
        }
      }
    } catch {}
  }

  // --- TẦNG 3: Thẻ Meta SEO (OpenGraph & Twitter Card) ---
  const getMeta = (propNames) => {
    for (const prop of propNames) {
      const rx1 = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']*)["']`, 'i');
      const rx2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${prop}["']`, 'i');
      const m = html.match(rx1) || html.match(rx2);
      if (m && m[1]) return decodeHtmlEntities(m[1].trim());
    }
    return null;
  };

  if (!title) {
    title = getMeta(['og:title', 'twitter:title']) || '';
    if (!title) {
      const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      if (titleTag && titleTag[1]) title = decodeHtmlEntities(titleTag[1].trim());
    }
  }

  if (!description) {
    description = getMeta(['og:description', 'twitter:description', 'description']) || '';
  }

  const metaImg = getMeta(['og:image', 'twitter:image', 'og:image:secure_url']);
  if (metaImg) addImg(metaImg);

  if (price == null) {
    const metaPrice = getMeta(['product:price:amount', 'og:price:amount', 'price']);
    if (metaPrice) price = parseFloat(metaPrice.replace(/[^\d.]/g, ''));
  }

  // --- TẦNG 4: Trích xuất ảnh gốc từ CDN sàn (Shopee) ---
  if (platform === 'shopee' || html.includes('susercontent.com')) {
    // 1. Quét trực tiếp URL susercontent.com/file/{hash}
    const fullUrls = html.matchAll(/https?:\/\/[a-z0-9_.-]*susercontent\.com\/(?:file\/)?([a-zA-Z0-9_-]{16,})/gi);
    for (const m of fullUrls) {
      if (m[1] && m[1] !== 'api') addImg(shopeeImageUrl(m[1]));
    }
    // 2. Quét hash định dạng vn-11134xxx-... hoặc sg-11134xxx-...
    const shopeeHashes = html.matchAll(/(?:vn|sg|my|th|ph|id|br|cn)-11134[0-9]{3}-[a-z0-9]+-[a-z0-9]+/g);
    for (const h of shopeeHashes) {
      addImg(shopeeImageUrl(h[0]));
    }
    // 3. Quét 32-char hex image hashes thường đi kèm cdn Shopee
    const hexHashes = html.matchAll(/["']([a-f0-9]{32})["']/g);
    let hexCount = 0;
    for (const h of hexHashes) {
      if (hexCount > 15) break;
      const testUrl = shopeeImageUrl(h[1]);
      if (!seenImgs.has(testUrl)) {
        addImg(testUrl);
        hexCount++;
      }
    }
  }

  return { title, description, price, currency, images };
}

function decodeHtmlEntities(str) {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, '/');
}

/**
 * ============================================================================
 * BƯỚC 4: Cơ chế dự phòng trích xuất từ Slug URL (Khi sàn chặn bot / SPA)
 * ============================================================================
 */
export function extractSlugFallback(urlStr) {
  try {
    const u = new URL(urlStr);
    let p = decodeURIComponent(u.pathname);

    // Bỏ các hậu tố ID quen thuộc
    p = p.replace(/-i\.\d+\.\d+.*$/, '')
         .replace(/-i\d+(?:-s\d+)?\.html.*$/, '')
         .replace(/\/product\/\d+.*$/, '')
         .replace(/\/view\/product\/\d+.*$/, '')
         .replace(/^\/+|\/+$/g, '');

    const segments = p.split('/').filter(Boolean);
    let slug = segments[segments.length - 1] || segments[0] || '';
    slug = slug.replace(/^products?\//i, '');
    slug = slug.replace(/[-_]+/g, ' ').trim();

    // Bỏ qua nếu slug vô nghĩa hoặc quá ngắn
    if (slug.length >= 4 && !['view', 'product', 'items', 'item'].includes(slug.toLowerCase())) {
      // Viết hoa từng từ
      return slug.split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
    }
  } catch {}
  return '';
}

/**
 * ============================================================================
 * BƯỚC 5: Làm sạch & Chuẩn hoá dữ liệu bằng AI (Gemini)
 * ============================================================================
 */
export async function cleanAndNormalizeData({ rawTitle, rawDesc, rawPrice, platform, settings }) {
  const geminiApiKey = settings?.geminiApiKey || process.env.GEMINI_API_KEY || '';
  let geminiModel = settings?.geminiModel || 'gemini-3.8-flash';
  if (['gemini-1.5-flash', 'gemini-2.0-flash', 'gemini-2.5-flash'].includes(geminiModel)) {
    geminiModel = 'gemini-3.8-flash';
  }

  if (geminiApiKey) {
    try {
      const aiResult = await callGeminiClean({
        rawTitle,
        rawDesc,
        rawPrice,
        platform,
        apiKey: geminiApiKey,
        model: geminiModel,
      });
      if (aiResult?.cleanTitle) {
        return {
          ...aiResult,
          usedGemini: true,
        };
      }
    } catch (err) {
      console.warn('[Gemini AI] Lỗi chuẩn hóa dữ liệu, kích hoạt bộ lọc Heuristic Fallback:', err.message);
    }
  }

  // Fallback Heuristic Regex khi không có key hoặc API lỗi
  return {
    ...cleanWithHeuristic(rawTitle, rawDesc, rawPrice),
    usedGemini: false,
  };
}

async function callGeminiClean({ rawTitle, rawDesc, rawPrice, platform, apiKey, model }) {
  const prompt = `Bạn là chuyên gia phân tích dữ liệu sản phẩm thương mại điện tử (${platform || 'sàn TMĐT'}) phục vụ sản xuất video quảng cáo AI ngắn.
Nhiệm vụ của bạn là làm sạch tiêu đề thô và trích xuất thông tin trọng tâm:
1. "cleanTitle": Loại bỏ hoàn toàn các từ rác quảng cáo, khuyến mại, mã giảm (vd: "Chính hãng 100%", "[Mã giảm 50k]", "Freeship Xtra", "BH 12T", "Sale khủng", "Giá rẻ vô địch", "Full box", icon/emoji, ký hiệu thừa...). Chỉ giữ lại: [Tên thương hiệu] + [Tên model/dòng sản phẩm] thực tế. Tối đa không quá 80 ký tự.
2. "brand": Tên thương hiệu nhận diện được (nếu không rõ ghi null).
3. "model": Mã hoặc tên model sản phẩm (nếu có).
4. "features": Mảng đúng 2 đến 3 câu ngắn tóm tắt tính năng/công dụng/chất liệu nổi bật nhất (mỗi ý dưới 20 từ) để dùng làm kịch bản video AI.
5. "price": Giá tiền chuẩn hóa sang số nguyên (VND). Ví dụ 159000. Nếu không xác định được giá ghi null.

Dữ liệu đầu vào:
- Tiêu đề thô: ${rawTitle || 'Không có'}
- Mô tả thô: ${(rawDesc || '').slice(0, 500)}
- Giá thô: ${rawPrice || 'Không có'}

Trả về định dạng JSON thuần theo cấu trúc:
{
  "cleanTitle": "string",
  "brand": "string hoặc null",
  "model": "string hoặc null",
  "features": ["tính năng 1", "tính năng 2", "tính năng 3"],
  "price": 150000
}`;

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json' },
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Gemini API lỗi (${res.status}): ${errText}`);
  }

  const json = await res.json();
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini không trả về kết quả');
  const parsed = JSON.parse(text);

  return {
    cleanTitle: (parsed.cleanTitle || rawTitle || '').trim().slice(0, 80),
    brand: parsed.brand || null,
    model: parsed.model || null,
    features: Array.isArray(parsed.features) ? parsed.features.slice(0, 3) : [],
    price: typeof parsed.price === 'number' ? Math.round(parsed.price) : normalizePrice(rawPrice),
  };
}

export function cleanWithHeuristic(rawTitle, rawDesc, rawPrice) {
  let title = (rawTitle || '').trim();

  // Bỏ ngoặc vuông [ ... ], ngoặc tròn ( ... )
  title = title.replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' ');

  // Bỏ các từ khóa quảng cáo phổ biến
  const spamKeywords = [
    /chính hãng(\s*100%)?/gi,
    /freeship(\s*xtra|\s*plus)?/gi,
    /hoàn tiền(\s*100%|\s*max)?/gi,
    /giảm\s*\d+\s*(k|%)/gi,
    /mã\s*giảm\s*giá/gi,
    /bh\s*\d+\s*(tháng|t|năm)/gi,
    /bảo hành\s*\d+\s*(tháng|năm)/gi,
    /voucher\s*[\w\d]+/gi,
    /hot\s*sale/gi,
    /flash\s*sale/gi,
    /siêu\s*sale/gi,
    /xả\s*kho/gi,
    /giá\s*sỉ/gi,
    /hàng\s*mới\s*về/gi,
    /cao\s*cấp/gi,
    /tặng\s*kèm\s*[\w\s]+/gi,
    /được\s*kiểm\s*hàng/gi,
  ];

  for (const rx of spamKeywords) {
    title = title.replace(rx, ' ');
  }

  // Dọn dẹp khoảng trắng và ký tự đặc biệt thừa
  title = title.replace(/[|•·\-_~]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (title.length > 80) {
    // Cắt ngắn ở ranh giới từ
    const truncated = title.slice(0, 80);
    const lastSpace = truncated.lastIndexOf(' ');
    title = (lastSpace > 40 ? truncated.slice(0, lastSpace) : truncated) + '…';
  }

  // Trích xuất tính năng từ mô tả nếu có
  const features = [];
  if (rawDesc) {
    const lines = rawDesc
      .split(/\n|•|-|\*/)
      .map((l) => l.trim())
      .filter((l) => l.length >= 10 && l.length <= 80 && !/(mua|bảo hành|liên hệ|hotline|zalo|ship)/i.test(l));
    features.push(...lines.slice(0, 3));
  }

  return {
    cleanTitle: title || rawTitle || '',
    brand: null,
    model: null,
    features: features.length ? features : ['Thiết kế hiện đại, tiện dụng', 'Chất lượng hoàn thiện cao'],
    price: normalizePrice(rawPrice),
  };
}

function normalizePrice(p) {
  if (p == null) return null;
  if (typeof p === 'number') return Math.round(p);
  const clean = String(p).replace(/[^\d]/g, '');
  const num = parseInt(clean, 10);
  return isNaN(num) ? null : num;
}

export function formatVND(num) {
  if (num == null) return '';
  return new Intl.NumberFormat('vi-VN').format(num) + ' ₫';
}

/**
 * ============================================================================
 * BƯỚC 6: Bổ sung ảnh chất lượng cao (Search Image Fallback)
 * ============================================================================
 */
export async function searchFallbackImages(query, limit = 6) {
  const q = (query || '').trim();
  if (!q) return [];

  try {
    // Lấy vqd token từ DuckDuckGo
    const searchUrl = `https://duckduckgo.com/?q=${encodeURIComponent(q)}&iax=images&ia=images`;
    const tokenRes = await fetch(searchUrl, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html',
        'Accept-Language': ACCEPT_LANG,
      },
    });

    const html = await tokenRes.text();
    const vqdMatch = html.match(/vqd=([0-9-]+)/) || html.match(/vqd=([\w-]+)/);
    if (!vqdMatch) return [];

    const vqd = vqdMatch[1];
    const imgUrl = `https://duckduckgo.com/i.js?l=wt-wt&o=json&q=${encodeURIComponent(q)}&vqd=${vqd}&f=,,,&p=1`;
    const res = await fetch(imgUrl, {
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Referer': 'https://duckduckgo.com/',
        'x-requested-with': 'XMLHttpRequest',
      },
    });

    if (!res.ok) return [];
    const data = await res.json();
    const results = data.results || [];

    const out = [];
    const seen = new Set();
    for (const r of results) {
      if (out.length >= limit) break;
      const u = r.image;
      if (!u || seen.has(u)) continue;
      seen.add(u);
      out.push({
        id: u,
        url: u,
        name: r.title || q,
        width: r.width,
        height: r.height,
        isFallback: true,
        source: 'DuckDuckGo Image Search',
      });
    }
    return out;
  } catch (err) {
    console.warn('[Image Fallback] Lỗi tìm ảnh DuckDuckGo:', err.message);
    return [];
  }
}

/**
 * ============================================================================
 * HÀM ĐIỀU PHỐI CHÍNH: fetchProduct(url)
 * ============================================================================
 */
export async function fetchProduct(inputUrl) {
  if (!inputUrl?.trim()) throw new Error('Chưa dán đường link sản phẩm');
  const rawInput = inputUrl.trim().match(/^https?:\/\//i) ? inputUrl.trim() : 'https://' + inputUrl.trim();

  // Bước 1: Nhận diện sàn & Theo vết chuyển hướng (tự động phân giải link rút gọn, affiliate và đưa về URL chuẩn)
  const resolved = await resolveRedirects(rawInput);
  const finalUrl = normalizeShopeeUrl(resolved.finalUrl);
  const platform = resolved.platform !== 'unknown' ? resolved.platform : detectPlatform(finalUrl);

  // Bước 2: Tách mã định danh
  const ids = parseProductIds(finalUrl, platform);

  // Bước 3: Tải trực tiếp HTML SSR ngầm (tải thuần túy qua HTTP, không mở bất kỳ tab trình duyệt nào)
  let rawHtml = '';
  // Shopee chỉ kích hoạt Server-Side Rendering (SSR) khi client là Mobile.
  // Nếu dùng Desktop UA, Shopee trả về SPA rỗng không có ảnh hay dữ liệu sản phẩm.
  const reqUa = platform === 'shopee' ? MOBILE_UA : UA;
  try {
    const res = await fetch(finalUrl, {
      headers: {
        'user-agent': reqUa,
        'accept': ACCEPT_HEADER,
        'accept-language': ACCEPT_LANG,
        'referer': `https://${new URL(finalUrl).hostname}/`,
      },
    });
    if (res.ok) rawHtml = await res.text();
  } catch {}

  // Dự phòng lần 2: Nếu là Shopee mà vẫn chưa có hash ảnh hay dữ liệu, thử lại với Mobile UA rõ ràng
  if (platform === 'shopee' && (!rawHtml || !rawHtml.includes('susercontent.com'))) {
    try {
      const res2 = await fetch(finalUrl, {
        headers: {
          'user-agent': MOBILE_UA,
          'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
        },
      });
      if (res2.ok) rawHtml = await res2.text();
    } catch {}
  }

  const extracted = extractFromHtml(rawHtml, platform, finalUrl);

  // Bước 4: Cơ chế dự phòng từ Slug nếu tiêu đề bị thiếu hoặc chặn bot
  let rawTitle = extracted.title;
  const isGenericTitle = !rawTitle || /^(shopee|lazada|tiktok|robot or human|đăng nhập|xác minh)/i.test(rawTitle.trim());
  if (isGenericTitle) {
    const slugTitle = extractSlugFallback(finalUrl);
    if (slugTitle) rawTitle = slugTitle;
  }

  // Bước 5: Làm sạch & Chuẩn hoá dữ liệu bằng AI (Gemini)
  const cleaned = await cleanAndNormalizeData({
    rawTitle,
    rawDesc: extracted.description,
    rawPrice: extracted.price,
    platform,
    settings: db.settings,
  });

  // Bước 6: Bổ sung ảnh chất lượng cao nếu sàn chặn ảnh
  let images = extracted.images;
  let usedFallbackImage = false;

  // Chỉ tìm ảnh ngoài khi thật sự có tên sản phẩm (không phải trang chủ/trang chặn) — tránh trả ảnh sai sản phẩm
  const titleLooksReal = rawTitle && !isGenericTitle && !/hot deals|best prices|mua sắm online/i.test(rawTitle);
  if (images.length === 0 && titleLooksReal) {
    const fallbackImgs = await searchFallbackImages(cleaned.cleanTitle || rawTitle, 6);
    if (fallbackImgs.length > 0) {
      images = fallbackImgs;
      usedFallbackImage = true;
    }
  }

  // Đánh dấu suggested cho 3 ảnh đầu
  images = images.map((im, i) => ({
    ...im,
    suggested: i < 3,
  }));

  return {
    platform,
    platformLabel: getPlatformLabel(platform),
    url: finalUrl,
    rawId: ids,
    title: cleaned.cleanTitle || rawTitle || 'Sản phẩm',
    rawTitle: rawTitle || '',
    brand: cleaned.brand,
    model: cleaned.model,
    features: cleaned.features || [],
    price: cleaned.price,
    priceFormatted: formatVND(cleaned.price),
    images,
    usedFallbackImage,
    usedGemini: cleaned.usedGemini,
    usedBrowser: false,
    imageSource: extracted.images.length ? 'html' : 'none',
    note: images.length === 0 ? 'Không lấy được ảnh nào từ link này.' : '',
  };
}

/**
 * ============================================================================
 * Tải các ảnh đã chọn về Thư viện Assets (data/assets)
 * ============================================================================
 */
// staging = ảnh "nháp" (bóc tách để làm sạch / xem thử): không hiện trong thư viện cho tới khi người dùng bấm Dùng
export async function importImages(kind = 'product', images = [], { staging = false } = {}) {
  if (!images.length) throw new Error('Chưa chọn ảnh nào để thêm vào thư viện');
  const out = [];

  for (const im of images) {
    const urlStr = im.url;
    if (!urlStr) continue;

    let res;
    try {
      res = await fetch(urlStr, {
        headers: {
          'user-agent': UA,
          'accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        },
      });
    } catch (e) {
      console.warn('[Import Image] Lỗi tải ảnh:', urlStr, e.message);
      continue;
    }

    if (!res.ok) {
      console.warn(`[Import Image] HTTP ${res.status} khi tải ảnh: ${urlStr}`);
      continue;
    }

    const contentType = res.headers.get('content-type') || '';
    let ext = '.jpg';
    if (contentType.includes('png')) ext = '.png';
    else if (contentType.includes('webp')) ext = '.webp';
    else if (contentType.includes('gif')) ext = '.gif';

    const id = newId();
    const dest = path.join(DIRS.assets, `${id}${ext}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(dest, buffer);

    const asset = {
      id,
      kind,
      name: (im.name || 'Sản phẩm').slice(0, 100),
      path: dest,
      createdAt: Date.now(),
      source: urlStr,
      staging: !!staging,
    };

    db.assets.unshift(asset);
    out.push({ ...asset, url: mediaUrl(dest) });
  }

  save();
  return out;
}
