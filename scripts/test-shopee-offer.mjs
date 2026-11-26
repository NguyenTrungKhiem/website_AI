// Kiểm thử bộ đọc hoa hồng Shopee (server/shopeeOffer.js — port từ DiamondShop web-site-aff/src/lib/shopeeOffer.ts, cùng các ca
// test với phản hồi THẬT) + gắn hoa hồng vào kết quả bóc link (fetchCommission / normalizeProductMeta) + checkRaw của
// shopeeAffiliate.js. Thuần, không mạng, không Chrome. Chạy: node scripts/test-shopee-offer.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wv-shopee-offer-'));
process.env.DATA_DIR = DATA_DIR;

const { parseRateBps, parseShopeeMoney, parseShopeeOffer, pickOffer, shopeeImageUrl, describeRates, applyBpsToVnd } = await import('../server/shopeeOffer.js');
const { checkRaw, fetchShopeeOffer, LOGIN_MSG, normalizeCookie, parseCookieHeader, cookiesForChrome, testAffiliateCookie, clearOfferCache, affiliateStatus } = await import('../server/shopeeAffiliate.js');
const { db, updateSettings } = await import('../server/db.js');
const { fetchCommission, normalizeProductMeta } = await import('../server/productScraper.js');

// Rút gọn từ phản hồi THẬT (10/11/2026, item 40084804461 — Má hồng Ofélia, 199.000đ). Giữ similar_product_offers với giá rẻ hơn /
// % cao hơn để chắc chắn bộ đọc KHÔNG lấy nhầm sản phẩm khác.
const REAL = {
  code: 0,
  msg: 'success',
  data: {
    item_id: '40084804461',
    product_link: 'https://shopee.vn/product/18299177/40084804461',
    commission: '₫20.895',
    commission_rate: {
      max_commission_rate: '10,5%', seller_commission_rate: '8%', default_commission_rate: '10,5%', shopee_commission_rate: '2,5%',
      default_commission: '₫20.895', shopee_commission: '₫4.975', seller_commission: '₫15.920', commission_cap: '₫40.000', is_capped: false,
    },
    commission_rate_detail: {
      commission_cap: '4000000000', default_commission_rate: 10500, seller_commission_rate: 8000, shopee_commission_rate: 2500,
      channel_cap: { exist_user: { social_media_cap: '4000000000' } },
    },
    batch_item_for_item_card_full: {
      itemid: '40084804461', shopid: '18299177',
      name: 'Má hồng dạng kem nhiều màu tươi mới Ofélia mẫu lolli liquid blush dung tích 4.6g bộ quà tặng',
      image: 'vn-11134207-81ztc-mtm1xvpzytc81d',
      images: ['vn-11134207-81ztc-mtm1xvpzytc81d', 'vn-11134207-81ztc-mt6egjohaxa893', 'vn-11134207-81ztc-mt6eg2yqgjd1f4', 'vn-11134207-81ztc-mt6fh432obuqaa', 'vn-11134207-81ztc-mt6fh432mxaa7a', 'vn-11134207-81ztc-mt6fh42w04qy28', 'vn-11134207-81ztc-mt6g17dcbw8xdf'],
      sold: 6000, sold_text: '6k+', historical_sold: 6000, historical_sold_text: '6k+', cmt_count: 1010,
      price: '19900000000', price_min: '19900000000', price_max: '20900000000',
      item_rating: { rating_count: [1010, 0, 0, 0, 25, 985], rating_star: 4.975247524752476 },
    },
    default_rate_indirect_ams_checkout_commission: { default_commission_rate: 6500, shopee_commission_rate: 2500, seller_commission_rate: 4000 },
    similar_product_offers: {
      list: [
        { item_id: '43535279912', seller_commission_rate: '2%', default_commission_rate: '4,5%', batch_item_for_item_card_full: { itemid: '43535279912', name: 'Má Hồng Kem', price: '13900000000', price_min: '13900000000' } },
        { item_id: '10859341175', seller_commission_rate: '10%', default_commission_rate: '12,5%', batch_item_for_item_card_full: { itemid: '10859341175', name: 'Má Hồng Kem OFÉLIA', price: '20900000000' } },
      ],
      has_more: true,
    },
  },
};

function main() {
  console.log('--- KIỂM THỬ HOA HỒNG SHOPEE (shopeeOffer.js / shopeeAffiliate.js / fetchCommission) ---\n');

  console.log('▶ Test 1: parseRateBps / parseShopeeMoney / shopeeImageUrl / applyBpsToVnd');
  assert.equal(parseRateBps('8%'), 800);
  assert.equal(parseRateBps('10,5%'), 1050);
  assert.equal(parseRateBps(8000), 800, 'thang Shopee ×1.000 mỗi 1%');
  assert.equal(parseRateBps(10500), 1050);
  assert.equal(parseRateBps(0.08), 800);
  assert.equal(parseRateBps(8), 800);
  assert.equal(parseRateBps(0), 0);
  assert.equal(parseRateBps('abc'), null);
  assert.equal(parseRateBps(-1), null);
  assert.equal(parseShopeeMoney('₫20.895'), 20895);
  assert.equal(parseShopeeMoney('20.895đ'), 20895);
  assert.equal(parseShopeeMoney('4000000000'), 40000, 'tiền dạng số ×100.000');
  assert.equal(parseShopeeMoney('19900000000'), 199000);
  assert.equal(parseShopeeMoney(18045000000), 180450);
  assert.equal(parseShopeeMoney('1,234,567'), 1234567);
  assert.equal(parseShopeeMoney(''), null);
  assert.equal(parseShopeeMoney('0'), null);
  assert.equal(shopeeImageUrl('vn-11134207-81ztc-mtm1xvpzytc81d'), 'https://down-vn.img.susercontent.com/file/vn-11134207-81ztc-mtm1xvpzytc81d');
  assert.equal(shopeeImageUrl('http://x'), null, 'không https -> bỏ');
  assert.equal(applyBpsToVnd(199000, 1050), 20895);
  assert.equal(applyBpsToVnd(180450, 1050), 18947, 'làm tròn xuống');
  console.log('  ✔ tỷ lệ bps, tiền VN / ×100.000, ảnh CDN, giá × bps');

  console.log('\n▶ Test 2: parseShopeeOffer — cấu trúc thật Ofélia: 199.000đ, XTRA 8% + Shopee 2,5%, hoa hồng 20.895đ, bỏ qua sản phẩm tương tự');
  const o = parseShopeeOffer(REAL);
  assert.equal(o.itemId, '40084804461');
  assert.equal(o.shopId, '18299177');
  assert.equal(o.name, REAL.data.batch_item_for_item_card_full.name);
  assert.equal(o.imageUrl, 'https://down-vn.img.susercontent.com/file/vn-11134207-81ztc-mtm1xvpzytc81d');
  assert.equal(o.images.length, 6, 'ảnh chính + 5 ảnh phụ, bỏ trùng');
  assert.equal(o.priceVnd, 199000);
  assert.equal(o.priceMaxVnd, 209000);
  assert.equal(o.sellerRateBps, 800);
  assert.equal(o.shopeeRateBps, 250);
  assert.equal(o.totalRateBps, 1050);
  assert.equal(o.capVnd, 40000);
  assert.equal(o.commissionVnd, 20895);
  assert.equal(o.source, 'amount');
  assert.equal(o.confidence, 'ok');
  assert.deepEqual(o.notes, [], 'giá × 10,5% = 20.895 khớp số Shopee báo');
  assert.equal(describeRates(o), 'XTRA 8% + Shopee 2,5% = 10,5%');
  // Rút gọn (pickOffer) đọc ra cùng kết quả
  const picked = pickOffer(REAL);
  assert.ok(!('similar_product_offers' in picked.data), 'pickOffer bỏ sản phẩm tương tự');
  assert.ok(JSON.stringify(picked).length < 1500, 'rút gọn < 1,5 KB');
  assert.deepEqual(parseShopeeOffer(picked), o);
  console.log('  ✔ đọc đúng sản phẩm chính, pickOffer giữ nguyên kết quả');

  console.log('\n▶ Test 3: thiếu data.commission → giá × tỷ lệ (chặn trần phần Shopee); trần 40k; XTRA không trần (Torriden); LG is_capped');
  const { commission: _c, commission_rate: _r, ...noAmount } = REAL.data;
  void _c; void _r;
  assert.deepEqual(
    (({ commissionVnd, source, confidence }) => ({ commissionVnd, source, confidence }))(parseShopeeOffer({ data: noAmount })),
    { commissionVnd: 20895, source: 'rates', confidence: 'ok' },
  );
  const loa = { ...noAmount, batch_item_for_item_card_full: { ...noAmount.batch_item_for_item_card_full, price: '18045000000', price_min: '18045000000', price_max: '18045000000' } };
  assert.equal(parseShopeeOffer({ data: loa }).commissionVnd, 18947, 'Loa 180.450đ × 10,5%');
  const expensive = { ...noAmount, batch_item_for_item_card_full: { price_min: '99900000000' } };
  assert.equal(parseShopeeOffer({ data: expensive }).commissionVnd, 104895, '999.000đ: XTRA 8% = 79.920 không trần + Shopee 2,5% = 24.975');
  const onlyShopeeOverCap = {
    ...noAmount,
    commission_rate_detail: { seller_commission_rate: 0, shopee_commission_rate: 2500, default_commission_rate: 2500, commission_cap: '4000000000' },
    batch_item_for_item_card_full: { price_min: '200000000000' },
  };
  assert.equal(parseShopeeOffer({ data: onlyShopeeOverCap }).commissionVnd, 40000, '2.000.000đ × 2,5% = 50.000 > trần 40.000');
  const torriden = {
    item_id: '25141584424', commission: '₫64.488',
    commission_rate: { seller_commission_rate: '15%', default_commission_rate: '17,5%', shopee_commission_rate: '2,5%', default_commission: '₫64.488', commission_cap: '₫40.000', is_capped: false },
    commission_rate_detail: { commission_cap: '4000000000', default_commission_rate: 17500, seller_commission_rate: 15000, shopee_commission_rate: 2500 },
    batch_item_for_item_card_full: { itemid: '25141584424', name: '[Torriden] Kem chống nắng', price: '36850000000', price_min: '36850000000' },
  };
  const pt = parseShopeeOffer({ data: torriden });
  assert.deepEqual([pt.commissionVnd, pt.source, pt.confidence], [64488, 'amount', 'ok'], 'XTRA không bị ép xuống trần 40k');
  const lg = {
    item_id: '53619757859', commission: '₫562.250',
    commission_rate: { seller_commission_rate: '0%', shopee_commission_rate: '2,5%', default_commission_rate: '2,5%', default_commission: '₫40.000', commission_cap: '₫40.000', is_capped: true },
    commission_rate_detail: { seller_commission_rate: 0, shopee_commission_rate: 2500, default_commission_rate: 2500, commission_cap: '4000000000' },
    batch_item_for_item_card_full: { itemid: '53619757859', price: '2249000000000', price_min: '2249000000000' },
  };
  assert.deepEqual([parseShopeeOffer({ data: lg }).commissionVnd, parseShopeeOffer({ data: lg }).confidence], [40000, 'ok'], 'Tủ lạnh LG: không XTRA -> trần 40.000đ');
  const empty = parseShopeeOffer({ data: {} }, '123');
  assert.deepEqual([empty.itemId, empty.commissionVnd, empty.confidence], ['123', null, 'unknown']);
  assert.ok(empty.notes.length >= 1);
  assert.equal(parseShopeeOffer(null).confidence, 'unknown');
  console.log('  ✔ đúng các ca của DiamondShop; không dữ liệu -> unknown, không đoán');

  console.log('\n▶ Test 4: checkRaw — phản hồi thô của tab affiliate.shopee.vn');
  assert.equal(checkRaw({ status: 200, text: JSON.stringify(REAL), url: 'https://affiliate.shopee.vn/api/v3/offer/product?item_id=1' }).ok, true);
  assert.deepEqual(checkRaw({ status: 401, text: '', url: '' }).reason, 'needLogin');
  assert.equal(checkRaw({ status: 200, text: '<html>login</html>', url: 'https://affiliate.shopee.vn/login?next=' }).reason, 'needLogin');
  assert.equal(checkRaw({ status: 200, text: JSON.stringify(REAL), url: 'https://affiliate.shopee.vn/api/x', loginPage: 'https://affiliate.shopee.vn/login' }).reason, 'needLogin', 'tab đang ở trang đăng nhập');
  assert.equal(checkRaw({ status: 403, text: '{"error":90309999}', url: '' }).reason, 'blocked', 'mã chống bot');
  assert.equal(checkRaw({ status: 200, text: '{"code":90309999,"msg":"x"}', url: '' }).reason, 'blocked');
  assert.equal(checkRaw({ status: 200, text: '', url: 'https://shopee.vn/verify/traffic/error' }).reason, 'blocked', 'captcha');
  assert.equal(checkRaw({ status: 200, text: '{"code":1,"msg":"please login"}', url: '' }).reason, 'needLogin');
  assert.equal(checkRaw({ status: 200, text: '{"code":5,"msg":"item not found"}', url: '' }).reason, 'error');
  assert.equal(checkRaw({ status: 0, text: '', url: '', error: 'Lỗi mạng' }).message, 'Lỗi mạng');
  assert.equal(checkRaw({ status: 200, text: 'not json', url: '' }).reason, 'error');
  assert.equal(checkRaw(null).ok, false);
  console.log('  ✔ phân loại needLogin / blocked / error / ok');

  console.log('\n▶ Test 5: fetchCommission + normalizeProductMeta — hoa hồng đi vào kết quả bóc link rồi vào asset.product');
  return (async () => {
    const okOffer = async (id) => ({ ok: true, offer: parseShopeeOffer(REAL, id), raw: pickOffer(REAL) });
    const c = await fetchCommission('shopee', '40084804461', { offer: okOffer });
    assert.deepEqual(
      { commission: c.commission, rate: c.commissionRateBps, text: c.commissionRateText, cap: c.commissionCapVnd, src: c.commissionSource, note: c.commissionNote, price: c.offerPrice },
      { commission: 20895, rate: 1050, text: 'XTRA 8% + Shopee 2,5% = 10,5%', cap: 40000, src: 'shopee', note: '', price: 199000 },
    );
    const noChrome = await fetchCommission('shopee', '1', { offer: async () => ({ ok: false, reason: 'noChrome', message: 'Mở Chrome' }) });
    assert.deepEqual([noChrome.commission, noChrome.commissionSource, noChrome.commissionNote], [null, null, 'Mở Chrome']);
    const needLogin = await fetchCommission('shopee', '1', { offer: async () => ({ ok: false, reason: 'needLogin', message: LOGIN_MSG }) });
    assert.equal(needLogin.commissionNote, LOGIN_MSG);
    const unknown = await fetchCommission('shopee', '1', { offer: async () => ({ ok: true, offer: parseShopeeOffer({ data: {} }, '1') }) });
    assert.equal(unknown.commission, null);
    assert.match(unknown.commissionNote, /không báo hoa hồng/);
    const thrown = await fetchCommission('shopee', '1', { offer: async () => { throw new Error('bùm'); } });
    assert.equal(thrown.commissionNote, 'bùm', 'hàm lấy hoa hồng ném lỗi -> không làm hỏng bóc link');
    assert.equal((await fetchCommission('shopee', null, { offer: okOffer })).commission, null, 'không itemId');
    assert.equal((await fetchCommission('lazada', '1', { offer: okOffer })).commission, null, 'chỉ Shopee');
    assert.equal((await fetchCommission('shopee', '1', { offer: false })).commissionNote, '', 'offer:false = không gọi');
    // fetchShopeeOffer thật: itemId sai -> lỗi ngay, không cần Chrome
    assert.equal((await fetchShopeeOffer('abc', { tab: false })).reason, 'error');
    console.log('  ✔ fetchCommission trả hoa hồng / lý do thiếu; normalizeProductMeta giữ commission + commissionRateBps');

    console.log('\n▶ Test 6: cookie trong Cài đặt → nạp vào Chrome Flow (giả) → gọi trong tab; Thử cookie; hết hạn; Shopee chặn');
    assert.equal(normalizeCookie('Cookie: SPC_EC=abc123; SPC_U=456;\n SPC_F=xyzxyzxyz; '), 'SPC_EC=abc123; SPC_U=456; SPC_F=xyzxyzxyz', 'bỏ "Cookie:", xuống dòng, dấu ; thừa');
    assert.equal(normalizeCookie('abc'), '', 'không phải cookie');
    assert.equal(normalizeCookie(''), '');
    assert.deepEqual(parseCookieHeader('a=1; b=x=y; c=%3D%7C; bad; d=2; d=3'), [{ name: 'a', value: '1' }, { name: 'b', value: 'x=y' }, { name: 'c', value: '%3D%7C' }, { name: 'd', value: '3' }], 'giữ nguyên giá trị có = / %, trùng tên lấy cái sau');
    assert.deepEqual(cookiesForChrome('SPC_EC=abc123456789; SPC_U=4567890')[0], { name: 'SPC_EC', value: 'abc123456789', domain: '.shopee.vn', path: '/', secure: true, sameSite: 'Lax' });
    const COOKIE = 'SPC_EC=abc123456789; SPC_U=4567890; SPC_F=xyzxyzxyzxyz';
    // Context Chrome riêng giả: addCookies ghi lại, trang mở bằng newPage; 'login' = chưa đăng nhập (chuyển sang shopee.vn/buyer/login),
    // 'traffic' = Shopee đẩy sang verify/traffic/error, 'blocked' = Shopee trả 90309999, 'notfound' = 404 error_not_found,
    // mặc định = trả JSON mẫu thật
    const makeContext = (behaviour = 'ok') => {
      const st = { cookies: [], gotos: [], paths: [], pages: [] };
      const page = {
        _url: 'about:blank',
        url() { return this._url; },
        isClosed() { return false; },
        async goto(u) {
          st.gotos.push(u);
          this._url = behaviour === 'login' ? 'https://shopee.vn/buyer/login?next=https%3A%2F%2Faffiliate.shopee.vn%2F' : behaviour === 'traffic' ? 'https://shopee.vn/verify/traffic/error?home_url=x' : 'https://affiliate.shopee.vn/dashboard';
        },
        async waitForLoadState() {},
        async evaluate(fn, arg) {
          st.paths.push(arg);
          if (behaviour === 'blocked') return { status: 403, text: '{"is_login":true,"error":90309999}', url: 'https://affiliate.shopee.vn/api/v3/offer/product', loginPage: this._url };
          if (behaviour === 'notfound') return { status: 404, text: '{"error":"error_not_found"}', url: 'https://affiliate.shopee.vn/api/v3/offer/product', loginPage: this._url };
          return { status: 200, text: JSON.stringify(REAL), url: 'https://affiliate.shopee.vn/api/v3/offer/product', csrfHeader: '', loginPage: this._url };
        },
      };
      const ctx = { pages: () => st.pages, async addCookies(c) { st.cookies.push(c); }, async newPage() { st.pages.push(page); return page; } };
      return { ctx, st };
    };
    // Thử cookie: nạp cookie (domain .shopee.vn), mở affiliate.shopee.vn trong Chrome riêng, gọi offer/product trong trang -> 20.895đ
    let fake = makeContext();
    const t = await testAffiliateCookie(COOKIE, { context: fake.ctx });
    assert.equal(t.ok, true, t.message);
    assert.equal(t.commissionVnd, 20895);
    assert.match(t.message, /Cookie dùng được.*20\.895đ/);
    assert.equal(fake.st.cookies.length, 1, 'nạp cookie 1 lần');
    assert.deepEqual(fake.st.cookies[0].map((c) => c.name), ['SPC_EC', 'SPC_U', 'SPC_F']);
    assert.ok(fake.st.cookies[0].every((c) => c.domain === '.shopee.vn'));
    assert.deepEqual(fake.st.gotos, ['https://affiliate.shopee.vn/'], 'mở đúng 1 trang affiliate');
    assert.equal(fake.st.pages.length, 1);
    assert.match(fake.st.paths[0], /^\/api\/v3\/offer\/product\?item_id=27801446579&trace=/, 'XHR trong trang tới offer/product (item mẫu) + trace');
    // Bóc link với cookie đã lưu trong Cài đặt: cùng chuỗi -> không nạp lại, dùng lại trang đã mở
    updateSettings({ shopeeAffiliateCookie: COOKIE });
    const viaSettings = await fetchShopeeOffer('27801446579', { context: fake.ctx, force: true });
    assert.equal(viaSettings.ok, true, viaSettings.message);
    assert.equal(viaSettings.offer.commissionVnd, 20895);
    assert.equal(fake.st.cookies.length, 1, 'cookie không đổi -> không addCookies lần nữa');
    assert.equal(fake.st.pages.length, 1, 'dùng lại trang, không mở thêm');
    assert.equal(fake.st.paths.length, 2);
    // Đổi cookie trong Cài đặt -> nạp lại + tải lại trang
    updateSettings({ shopeeAffiliateCookie: COOKIE + '; SPC_SI=moi-moi-moi' });
    await fetchShopeeOffer('27801446580', { context: fake.ctx, force: true });
    assert.equal(fake.st.cookies.length, 2, 'cookie đổi -> nạp lại');
    assert.equal(fake.st.gotos.length, 2, 'tải lại trang sau khi nạp cookie mới');
    // Sản phẩm không có ưu đãi Affiliate: 404 error_not_found khi vẫn ở affiliate.shopee.vn -> notFound (không phải lỗi, không nghỉ)
    fake = makeContext('notfound');
    const nf = await testAffiliateCookie(COOKIE, { context: fake.ctx });
    assert.equal(nf.reason, 'notFound');
    assert.match(nf.message, /không có ưu đãi/);
    const nf2 = await fetchShopeeOffer('27801446581', { context: fake.ctx, force: true });
    assert.equal(nf2.reason, 'notFound');
    assert.match(nf2.message, /không có ưu đãi/);
    // Cookie hết hạn: trang chuyển sang shopee.vn/buyer/login -> needLogin, thông báo dán cookie mới
    fake = makeContext('login');
    const expired = await testAffiliateCookie('SPC_EC=het-han-roi-roi; SPC_U=1', { context: fake.ctx });
    assert.equal(expired.ok, false);
    assert.equal(expired.reason, 'needLogin');
    assert.match(expired.message, /cookie/i);
    assert.equal(fake.st.paths.length, 0, 'đang ở trang đăng nhập thì không gọi API');
    // Không cookie -> hướng dẫn dán cookie, không mở Chrome
    updateSettings({ shopeeAffiliateCookie: '' });
    const noCk = await fetchShopeeOffer('40084804461', { tab: false, force: true });
    assert.equal(noCk.reason, 'noChrome');
    assert.match(noCk.message, /cookie/i, 'thông báo hướng dẫn dán cookie vào Cài đặt');
    fake = makeContext();
    const noCk2 = await fetchShopeeOffer('40084804461', { context: fake.ctx, force: true });
    assert.equal(noCk2.reason, 'noCookie');
    assert.equal(fake.st.gotos.length, 0, 'không cookie -> không mở trang nào');
    assert.equal((await testAffiliateCookie('')).ok, false);
    // Shopee đẩy sang verify/traffic -> blocked, không tự khoá 10 phút, ghi nhận lastBlock.kind = 'traffic'
    fake = makeContext('traffic');
    const tr = await testAffiliateCookie(COOKIE, { context: fake.ctx });
    assert.equal(tr.reason, 'blocked');
    assert.match(tr.message, /verify\/traffic/);
    assert.equal(fake.st.paths.length, 0);
    assert.equal(affiliateStatus().blockedUntil, 0, 'không khoá cooldown ở server');
    assert.equal(affiliateStatus().lastBlock?.kind, 'traffic');
    clearOfferCache();
    // Shopee chặn (90309999) -> blocked, ghi lastBlock, KHÔNG tự khoá lần thử tiếp theo
    fake = makeContext('blocked');
    const tb = await testAffiliateCookie(COOKIE, { context: fake.ctx });
    assert.equal(tb.ok, false);
    assert.equal(tb.reason, 'blocked');
    assert.equal(affiliateStatus().blockedUntil, 0);
    assert.ok(affiliateStatus().lastBlock, 'ghi nhận lastBlock khi bị Shopee từ chối');
    const again = await testAffiliateCookie(COOKIE, { context: fake.ctx });
    assert.equal(again.reason, 'blocked');
    assert.ok(!/nghỉ tới/.test(again.message), 'không còn thông báo nghỉ tới HH:MM');
    assert.equal(fake.st.paths.length, 2, 'lần gọi thứ 2 vẫn được phép gọi thẳng tới Shopee');
    // Sau đó gọi thành công -> xoá lastBlock
    fake = makeContext('ok');
    const recovered = await testAffiliateCookie(COOKIE, { context: fake.ctx });
    assert.equal(recovered.ok, true);
    assert.equal(affiliateStatus().lastBlock, null, 'gọi thành công thì xoá lastBlock');
    clearOfferCache();
    // fetchShopeeOffer: không đệm kết quả lỗi / bị chặn, nhưng đệm kết quả thành công
    updateSettings({ shopeeAffiliateCookie: COOKIE });
    const fakeErr = makeContext('blocked');
    await fetchShopeeOffer('40084804490', { context: fakeErr.ctx });
    await fetchShopeeOffer('40084804490', { context: fakeErr.ctx });
    assert.equal(fakeErr.st.paths.length, 2, 'lỗi / bị từ chối không đệm -> gọi lại ngay lần 2');
    const fakeOk = makeContext('ok');
    await fetchShopeeOffer('40084804491', { context: fakeOk.ctx });
    await fetchShopeeOffer('40084804491', { context: fakeOk.ctx });
    assert.equal(fakeOk.st.paths.length, 1, 'thành công -> lần 2 lấy từ cache');
    clearOfferCache();
    // 404 error_not_found khi trang KHÔNG còn ở affiliate.shopee.vn (XHR chạy nhầm origin) -> blocked chứ không phải notFound
    assert.equal(checkRaw({ status: 404, text: '{"error":"error_not_found"}', url: 'https://shopee.vn/api/v3/offer/product', loginPage: 'https://shopee.vn/verify/traffic/error' }).reason, 'blocked');
    console.log('  ✔ cookie -> addCookies(.shopee.vn) 1 lần, 1 trang dùng lại, XHR trong trang; đổi cookie -> nạp lại; notFound; hết hạn -> needLogin; không cản cooldown & ghi lastBlock');

    const meta = normalizeProductMeta({ title: 'Má hồng', price: 199000, platform: 'shopee', itemId: '40084804461', shopId: '18299177', commission: 20895, commissionRateBps: 1050 });
    assert.equal(meta.commission, 20895);
    assert.equal(meta.commissionRateBps, 1050);
    assert.equal(normalizeProductMeta({ title: 'x', commission: '20.895' }).commission, 20895, 'chuỗi tiền VN');
    assert.equal(normalizeProductMeta({ title: 'x', commission: 0 }).commission, null, '0 = chưa có');
    assert.equal(normalizeProductMeta({ title: 'x' }).commission, null);

    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    console.log('\n🎉 TẤT CẢ 6 BÀI TEST HOA HỒNG SHOPEE ĐÃ VƯỢT QUA!');
  })();
}

Promise.resolve()
  .then(main)
  .catch((err) => {
    console.error('\n❌ TEST THẤT BẠI:', err);
    process.exit(1);
  });
