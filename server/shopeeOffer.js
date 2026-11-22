// Đọc giá + HOA HỒNG sản phẩm từ JSON của API nội bộ affiliate.shopee.vn/api/v3/offer/product?item_id=… (hàm thuần, có test:
// scripts/test-shopee-offer.mjs). Port từ DiamondShop `web-site-aff/src/lib/shopeeOffer.ts` — giữ cùng luật để 2 web ra cùng số.
//
// CẤU TRÚC THẬT (phản hồi 10/11/2026) — CHỈ đọc đúng các đường dẫn của SẢN PHẨM CHÍNH:
//   data.item_id, data.product_link
//   data.commission: "₫20.895"                                ← hoa hồng ước tính Shopee tính sẵn
//   data.commission_rate.{default_commission "₫20.895", seller_commission_rate "8%", is_capped, commission_cap "₫40.000"} (chuỗi, dự phòng)
//   data.commission_rate_detail.default_commission_rate: 10500 ← TỔNG kênh Mạng xã hội 10,5% (thang ×1.000 mỗi 1%)
//   data.commission_rate_detail.seller_commission_rate: 8000   ← Hoa hồng XTRA do shop trả 8%
//   data.commission_rate_detail.shopee_commission_rate: 2500   ← Hoa hồng từ Shopee 2,5%
//   data.commission_rate_detail.commission_cap: "4000000000"   ← trần 40.000đ (tiền ×100.000)
//   data.batch_item_for_item_card_full: { itemid, shopid, name, image, images[], price, price_min, price_max (×100.000), … }
//   data.similar_product_offers.list[]  ← ~20 SẢN PHẨM KHÁC — KHÔNG được đọc (từng làm lẫn số liệu)
// Hoa hồng dùng = số `commission` Shopee báo (trần 40k chỉ áp phần Shopee khi không có XTRA / is_capped); thiếu thì giá × tỷ lệ.
// confidence 'ok' chỉ khi đọc chắc được số hợp lý (≤ giá, ≤ 5 triệu) → không chắc thì không điền số (không đoán bừa).

export const SHOPEE_IMAGE_CDN = 'https://down-vn.img.susercontent.com/file/';
export const MAX_OFFER_IMAGES = 6;
/** Tiền dạng số trong JSON Shopee nhân 100.000 (180.450đ → 18045000000) */
const SHOPEE_MONEY_SCALE = 100_000;
/** Không có hoa hồng một sản phẩm nào tới mức này — chặn hiểu sai đơn vị khi JSON không có giá / trần */
const MAX_SANE_COMMISSION_VND = 5_000_000;
const BPS_DENOMINATOR = 10_000;

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const text = (v, max = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const int = (v) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
};

/** giá × bps (1% = 100 bps), làm tròn xuống — như DiamondShop (bps.ts applyBpsToVnd) */
export function applyBpsToVnd(baseVnd, bps) {
  const base = Number.isFinite(baseVnd) ? Math.max(0, Math.floor(baseVnd)) : 0;
  const rate = Number.isFinite(bps) ? Math.max(0, Math.floor(bps)) : 0;
  return Math.floor((base * rate) / BPS_DENOMINATOR);
}

/** Số thuần (tỷ lệ): số hoặc chuỗi "8", "2.5", "2,5", "8%" */
function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const s = v.trim().replace(/\s/g, '');
    if (!/^-?\d+([.,]\d+)?%?$/.test(s)) return null;
    const n = Number(s.replace('%', '').replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Tỷ lệ → bps. "8%" / "10,5%" → 800 / 1050 · 0.08 → 800 · 8 → 800 (phần trăm) · 8000 → 800 (thang Shopee: 1% = 1.000,
 * 100.000 = 100%, như commission_rate_detail thật: 8000 = 8%, 10500 = 10,5%). Ngoài các dạng trên → null (không đoán).
 */
export function parseRateBps(v) {
  if (typeof v === 'string' && v.trim().endsWith('%')) {
    const n = toNumber(v);
    return n != null && n >= 0 && n <= 100 ? Math.round(n * 100) : null;
  }
  const n = toNumber(v);
  if (n == null || n < 0) return null;
  if (n === 0) return 0;
  if (n < 1) return Math.round(n * 10_000);
  if (n <= 100) return Math.round(n * 100);
  if (n <= 100_000 && Number.isInteger(n)) return Math.round(n / 10);
  return null;
}

/**
 * Tiền → VND. Chuỗi kiểu Việt "₫20.895" / "20.895đ" / "1.234.567" (dấu chấm phân cách nghìn) → 20895;
 * số (hoặc chuỗi chỉ có chữ số) ≥ 100 triệu coi là đã nhân 100.000 (giá / trần trong JSON Shopee: "19900000000" → 199.000đ).
 */
export function parseShopeeMoney(v) {
  const scaled = (n) => Math.floor(n >= 100_000_000 ? n / SHOPEE_MONEY_SCALE : n);
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? scaled(v) : null;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  const hasCurrency = /[₫đĐ]|vnd/i.test(s);
  const core = s.replace(/vnd/gi, '').replace(/[₫đĐ\s]/g, '');
  if (/^\d{1,3}(\.\d{3})+$/.test(core)) return Number(core.replace(/\./g, ''));
  if (/^\d{1,3}(,\d{3})+$/.test(core)) return Number(core.replace(/,/g, ''));
  if (!/^\d+(\.\d+)?$/.test(core)) return null;
  const n = Number(core);
  if (!(n > 0)) return null;
  return hasCurrency ? Math.floor(n) : scaled(n);
}

/** Mã ảnh Shopee (vn-11134207-…) hoặc URL https → URL CDN; sai → null */
export function shopeeImageUrl(v) {
  const s = text(v, 300);
  if (!s) return null;
  if (/^https:\/\//i.test(s)) return s;
  return /^[a-z0-9][a-z0-9_-]{5,120}$/i.test(s) ? `${SHOPEE_IMAGE_CDN}${s}` : null;
}

/**
 * Chỉ giữ các trường cần dùng của offer/product (tên, ảnh, giá, hoa hồng) — bỏ ~20 sản phẩm tương tự, nhãn, video, phân loại…
 * (JSON gốc hàng trăm KB). Giữ NGUYÊN đường dẫn để parseShopeeOffer đọc được. (= dsPickOffer của Extension DiamondShop)
 */
export function pickOffer(json) {
  const d = obj(obj(json)?.data) || obj(json) || {};
  const c = obj(d.batch_item_for_item_card_full) || {};
  const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o && o[k] !== undefined).map((k) => [k, o[k]]));
  const rating = obj(c.item_rating);
  return {
    data: {
      ...pick(d, ['item_id', 'product_link', 'commission']),
      commission_rate: pick(obj(d.commission_rate), ['seller_commission_rate', 'shopee_commission_rate', 'default_commission_rate', 'default_commission', 'commission_cap', 'is_capped']),
      commission_rate_detail: pick(obj(d.commission_rate_detail), ['seller_commission_rate', 'shopee_commission_rate', 'default_commission_rate', 'commission_cap', 'is_capped']),
      batch_item_for_item_card_full: {
        ...pick(c, ['itemid', 'shopid', 'name', 'image', 'price', 'price_min', 'price_max', 'sold', 'sold_text', 'historical_sold', 'historical_sold_text', 'cmt_count']),
        images: Array.isArray(c.images) ? c.images.slice(0, MAX_OFFER_IMAGES) : [],
        item_rating: rating ? { rating_star: rating.rating_star, rating_count: Array.isArray(rating.rating_count) ? rating.rating_count.slice(0, 1) : [] } : null,
      },
    },
  };
}

/**
 * JSON offer/product (nguyên hoặc đã pickOffer) → { itemId, shopId, name, imageUrl, images, priceVnd, priceMaxVnd, sellerRateBps,
 * shopeeRateBps, totalRateBps, capVnd, commissionVnd, source ('amount' | 'rates' | null), confidence ('ok' | 'unknown'), notes[] }
 */
export function parseShopeeOffer(json, itemIdHint = null) {
  const notes = [];
  const root = obj(json) || {};
  const d = obj(root.data) || root;
  const card = obj(d.batch_item_for_item_card_full) || {};
  const crd = obj(d.commission_rate_detail) || {};
  const cr = obj(d.commission_rate) || {};
  // Tỷ lệ: ưu tiên số trong commission_rate_detail (10500), dự phòng chuỗi trong commission_rate ("10,5%")
  const rate = (k) => parseRateBps(crd[k]) ?? parseRateBps(cr[k]);

  const sellerRateBps = rate('seller_commission_rate');
  const shopeeRateBps = rate('shopee_commission_rate');
  const totalField = rate('default_commission_rate');
  const parts = sellerRateBps != null || shopeeRateBps != null ? (sellerRateBps ?? 0) + (shopeeRateBps ?? 0) : null;
  const totalRateBps = parts != null && totalField != null ? Math.max(parts, totalField) : (parts ?? totalField);
  if (parts != null && totalField != null && parts !== totalField) notes.push(`Tổng tỷ lệ (${totalField / 100}%) khác XTRA + Shopee (${parts / 100}%) — dùng số lớn hơn.`);
  const capVnd = parseShopeeMoney(crd.commission_cap) ?? parseShopeeMoney(cr.commission_cap);

  const priceVnd = parseShopeeMoney(card.price_min) ?? parseShopeeMoney(card.price);
  const priceMax = parseShopeeMoney(card.price_max);
  const imageCodes = [card.image, ...(Array.isArray(card.images) ? card.images : [])];
  const images = [...new Set(imageCodes.map(shopeeImageUrl).filter(Boolean))].slice(0, MAX_OFFER_IMAGES);

  // Hoa hồng Shopee báo sẵn: cr.default_commission (số chính thức trên UI, đã áp trần sàn + cộng XTRA) rồi tới d.commission
  // (đôi khi là số thô chưa áp trần với sản phẩm đắt tiền không có XTRA — vd. Tủ lạnh LG "₫562.250").
  // Trần capVnd (40.000đ) CHỈ áp cho phần hoa hồng Shopee (sàn): không có XTRA → toàn bộ ≤ trần; có XTRA → XTRA không trần,
  // is_capped → tổng ≤ giá × XTRA + trần.
  const maxAllowable = Math.min(priceVnd ?? Infinity, MAX_SANE_COMMISSION_VND);
  const defaultComm = parseShopeeMoney(cr.default_commission);
  const commRaw = parseShopeeMoney(d.commission);
  let amountCandidate = defaultComm ?? commRaw;
  const isCapped = cr.is_capped === true || crd.is_capped === true;
  if (amountCandidate != null && capVnd != null && capVnd > 0) {
    if (sellerRateBps == null || sellerRateBps === 0) amountCandidate = Math.min(amountCandidate, capVnd);
    else if (isCapped && priceVnd != null && sellerRateBps > 0) amountCandidate = Math.min(amountCandidate, applyBpsToVnd(priceVnd, sellerRateBps) + capVnd);
  }
  const amount = amountCandidate != null && amountCandidate > 0 && amountCandidate <= maxAllowable ? amountCandidate : null;
  if (amountCandidate != null && amount == null) notes.push(`Bỏ số hoa hồng ${amountCandidate}đ vì vượt giá bán (${priceVnd}đ) hoặc ngưỡng tối đa.`);

  // Tính từ tỷ lệ nếu thiếu amount: phần XTRA (không trần) + phần Shopee (có trần)
  let fromRates = null;
  if (priceVnd != null) {
    if (sellerRateBps != null || shopeeRateBps != null) {
      const sellerPart = sellerRateBps > 0 ? applyBpsToVnd(priceVnd, sellerRateBps) : 0;
      const shopeeRaw = shopeeRateBps > 0 ? applyBpsToVnd(priceVnd, shopeeRateBps) : 0;
      fromRates = sellerPart + (capVnd > 0 ? Math.min(shopeeRaw, capVnd) : shopeeRaw);
    } else if (totalRateBps != null && totalRateBps > 0 && totalRateBps <= 10_000) {
      const rawCalc = applyBpsToVnd(priceVnd, totalRateBps);
      fromRates = isCapped && capVnd > 0 ? Math.min(rawCalc, capVnd) : rawCalc;
    }
  }

  let commissionVnd = null;
  let source = null;
  if (amount != null) {
    commissionVnd = amount;
    source = 'amount';
    if (fromRates != null && Math.abs(amount - fromRates) > Math.max(50, fromRates * 0.05)) notes.push(`Hoa hồng Shopee báo (${amount}đ) lệch với giá × tỷ lệ (${fromRates}đ) — dùng số Shopee báo.`);
  } else if (fromRates != null && fromRates > 0 && fromRates <= maxAllowable) {
    commissionVnd = fromRates;
    source = 'rates';
  }
  if (commissionVnd == null) notes.push(totalRateBps == null ? 'Không đọc được hoa hồng hay tỷ lệ hoa hồng.' : 'Có tỷ lệ nhưng không có giá để tính hoa hồng.');
  if (priceVnd == null) notes.push('Không đọc được giá.');

  return {
    itemId: text(card.itemid != null ? String(card.itemid) : null) ?? text(d.item_id != null ? String(d.item_id) : null) ?? itemIdHint,
    shopId: text(card.shopid != null ? String(card.shopid) : null),
    name: text(card.name),
    imageUrl: images[0] ?? null,
    images,
    priceVnd,
    priceMaxVnd: priceMax != null && priceVnd != null && priceMax > priceVnd ? priceMax : null,
    soldText: text(card.historical_sold_text, 20) ?? text(card.sold_text, 20),
    sellerRateBps,
    shopeeRateBps,
    totalRateBps,
    capVnd,
    commissionVnd,
    source,
    confidence: commissionVnd != null && commissionVnd > 0 && commissionVnd <= maxAllowable ? 'ok' : 'unknown',
    notes,
  };
}

/** "XTRA 8% + Shopee 2,5% = 10,5%" để hiện trên giao diện; thiếu tỷ lệ → '' */
export function describeRates(o) {
  if (!o) return '';
  const pct = (bps) => `${(bps / 100).toLocaleString('vi-VN', { maximumFractionDigits: 2 })}%`;
  const parts = [];
  if (o.sellerRateBps != null) parts.push(`XTRA ${pct(o.sellerRateBps)}`);
  if (o.shopeeRateBps != null) parts.push(`Shopee ${pct(o.shopeeRateBps)}`);
  if (o.totalRateBps == null) return parts.join(' + ');
  return parts.length > 1 ? `${parts.join(' + ')} = ${pct(o.totalRateBps)}` : pct(o.totalRateBps);
}
