import assert from 'node:assert/strict';
import {
  detectPlatform,
  parseProductIds,
  extractFromHtml,
  extractSlugFallback,
  cleanWithHeuristic,
  formatVND,
  searchFallbackImages,
  fetchProduct,
} from '../server/productScraper.js';

async function runTests() {
  console.log('--- BẮT ĐẦU KIỂM THỬ QUY TRÌNH 6 BƯỚC ---\n');

  // 1. KIỂM THỬ BƯỚC 1: Nhận diện sàn
  console.log('▶ Test 1: Nhận diện sàn (detectPlatform)');
  assert.equal(detectPlatform('https://shopee.vn/product/123/456'), 'shopee');
  assert.equal(detectPlatform('https://s.shopee.vn/xyz123'), 'shopee');
  assert.equal(detectPlatform('https://shope.ee/abc'), 'shopee');
  assert.equal(detectPlatform('https://www.lazada.vn/products/i123-s456.html'), 'lazada');
  assert.equal(detectPlatform('https://lzd.co/xyz'), 'lazada');
  assert.equal(detectPlatform('https://vt.tiktok.com/ZSNxxxx/'), 'tiktok');
  assert.equal(detectPlatform('https://www.tiktok.com/@shop/video/123'), 'tiktok');
  console.log('  ✔ Bước 1: Nhận diện sàn chính xác 100%');

  // 2. KIỂM THỬ BƯỚC 2: Tách mã định danh (Regex Parser)
  console.log('\n▶ Test 2: Tách mã định danh (parseProductIds)');
  const shopeeIds = parseProductIds('https://shopee.vn/Ao-Thun-Nam-i.12345678.98765432', 'shopee');
  assert.deepEqual(shopeeIds, { shopId: '12345678', itemId: '98765432' });

  const shopeeIds2 = parseProductIds('https://shopee.vn/product/88889999/111222333', 'shopee');
  assert.deepEqual(shopeeIds2, { shopId: '88889999', itemId: '111222333' });

  const lazadaIds = parseProductIds('https://www.lazada.vn/products/tai-nghe-i123456-s987654.html', 'lazada');
  assert.deepEqual(lazadaIds, { itemId: '123456', skuId: '987654' });

  const tiktokIds = parseProductIds('https://www.tiktok.com/view/product/1729384756', 'tiktok');
  assert.deepEqual(tiktokIds, { productId: '1729384756' });
  console.log('  ✔ Bước 2: Regex bóc tách Product ID, Shop ID, SKU ID chính xác');

  // 3. KIỂM THỬ BƯỚC 3: Bóc tách HTML 4 tầng ưu tiên
  console.log('\n▶ Test 3: Bóc tách HTML đa tầng (extractFromHtml)');
  // Tầng 1: JSON-LD Schema.org
  const sampleJsonLdHtml = `
    <html>
      <head>
        <script type="application/ld+json">
        {
          "@context": "https://schema.org/",
          "@type": "Product",
          "name": "Tai Nghe Bluetooth Baseus Bowie M2",
          "image": ["https://example.com/img1.jpg", "https://example.com/img2.jpg"],
          "description": "Tai nghe chống ồn chủ động ANC",
          "offers": {
            "@type": "Offer",
            "price": "650000",
            "priceCurrency": "VND"
          }
        }
        </script>
      </head>
      <body></body>
    </html>
  `;
  const ext1 = extractFromHtml(sampleJsonLdHtml, 'other', 'https://example.com');
  assert.equal(ext1.title, 'Tai Nghe Bluetooth Baseus Bowie M2');
  assert.equal(ext1.price, 650000);
  assert.equal(ext1.images.length, 2);
  console.log('  ✔ Bước 3 - Tầng 1: JSON-LD Schema.org parse thành công');

  // Tầng 2: Lazada window.pageData
  const sampleLazadaHtml = `
    <html>
      <head>
        <script>
          window.pageData = {
            "mods": {
              "item": {
                "title": "Bàn Phím Cơ Không Dây K8",
                "images": ["https://laz-img.alicdn.com/img1.jpg"],
                "price": { "salePrice": { "value": "1250000" } }
              }
            }
          };
        </script>
      </head>
      <body></body>
    </html>
  `;
  const ext2 = extractFromHtml(sampleLazadaHtml, 'lazada', 'https://lazada.vn');
  assert.equal(ext2.title, 'Bàn Phím Cơ Không Dây K8');
  assert.equal(ext2.price, 1250000);
  assert.equal(ext2.images[0].url, 'https://laz-img.alicdn.com/img1.jpg');
  console.log('  ✔ Bước 3 - Tầng 2: Lazada window.pageData parse thành công');

  // Tầng 3 & 4: Meta SEO & Shopee CDN Hash
  const sampleShopeeHtml = `
    <html>
      <head>
        <meta property="og:title" content="Chuột Không Dây Gaming G304" />
        <meta property="product:price:amount" content="790000" />
      </head>
      <body>
        <div>vn-11134207-7r98o-lsi5g6d7v89w12</div>
      </body>
    </html>
  `;
  const ext3 = extractFromHtml(sampleShopeeHtml, 'shopee', 'https://shopee.vn');
  assert.equal(ext3.title, 'Chuột Không Dây Gaming G304');
  assert.equal(ext3.price, 790000);
  assert.ok(ext3.images.some((im) => im.url.includes('down-vn.img.susercontent.com/file/vn-11134207-7r98o-lsi5g6d7v89w12')));
  console.log('  ✔ Bước 3 - Tầng 3 & 4: Meta SEO & Shopee CDN Hash bóc tách thành công');

  // 4. KIỂM THỬ BƯỚC 4: Dự phòng Slug URL
  console.log('\n▶ Test 4: Trích xuất từ Slug URL (extractSlugFallback)');
  const slug1 = extractSlugFallback('https://shopee.vn/tai-nghe-bluetooth-baseus-bowie-m2-chinh-hang-i.12345.67890');
  assert.equal(slug1, 'Tai Nghe Bluetooth Baseus Bowie M2 Chinh Hang');

  const slug2 = extractSlugFallback('https://www.lazada.vn/products/sac-nhanh-gan-65w-ugreen-nexode-i9999-s8888.html');
  assert.equal(slug2, 'Sac Nhanh Gan 65w Ugreen Nexode');
  console.log('  ✔ Bước 4: Slug fallback trích xuất tên chính xác');

  // 5. KIỂM THỬ BƯỚC 5: Làm sạch & Chuẩn hoá dữ liệu (Heuristic Cleaner)
  console.log('\n▶ Test 5: Làm sạch & Chuẩn hoá bằng Heuristic (cleanWithHeuristic)');
  const dirtyTitle = '[MÃ GIẢM 50K - CHÍNH HÃNG 100%] Tai Nghe Bluetooth Baseus Bowie M2 (Freeship Xtra - BH 12T - Hot Sale)';
  const dirtyDesc = '• Công nghệ chống ồn ANC -42dB siêu êm\n• Pin trâu 30 giờ liên tục\n• Kết nối Bluetooth 5.2';
  const cleanResult = cleanWithHeuristic(dirtyTitle, dirtyDesc, '650.000đ');

  assert.ok(!cleanResult.cleanTitle.includes('MÃ GIẢM 50K'));
  assert.ok(!cleanResult.cleanTitle.includes('CHÍNH HÃNG'));
  assert.ok(!cleanResult.cleanTitle.includes('Freeship'));
  assert.ok(cleanResult.cleanTitle.includes('Baseus Bowie M2'));
  assert.equal(cleanResult.price, 650000);
  assert.equal(formatVND(cleanResult.price), '650.000 ₫');
  assert.equal(cleanResult.features.length, 3);
  console.log('  ✔ Bước 5: Lọc sạch từ rác, trích xuất tính năng & chuẩn hóa giá VND:', cleanResult.cleanTitle);

  // 6. KIỂM THỬ BƯỚC 6: DuckDuckGo Fallback Image Search
  console.log('\n▶ Test 6: Tìm ảnh dự phòng qua DuckDuckGo (searchFallbackImages)');
  const imagesFound = await searchFallbackImages('Baseus Bowie M2', 4);
  console.log(`  Tìm thấy ${imagesFound.length} ảnh qua DuckDuckGo:`);
  for (const im of imagesFound.slice(0, 2)) {
    console.log(`   - ${im.url.slice(0, 75)}...`);
  }
  assert.ok(imagesFound.length > 0, 'DuckDuckGo phải trả về ít nhất 1 ảnh');
  assert.ok(imagesFound[0].isFallback === true);
  console.log('  ✔ Bước 6: DuckDuckGo Search Fallback hoạt động xuất sắc');

  // 7. KIỂM THỬ TÍCH HỢP ĐIỀU PHỐI (fetchProduct)
  console.log('\n▶ Test 7: Kiểm thử hàm điều phối fetchProduct với Slug & Fallback Image');
  const dummyUrl = 'https://shopee.vn/tai-nghe-baseus-bowie-m2-chinh-hang-i.11111.22222';
  const fullResult = await fetchProduct(dummyUrl);
  assert.equal(fullResult.platform, 'shopee');
  assert.equal(fullResult.platformLabel, 'Shopee');
  assert.ok(fullResult.title.length > 0);
  assert.ok(fullResult.images.length > 0);
  assert.equal(fullResult.images[0].suggested, true);
  console.log('  ✔ Kết quả điều phối tích hợp:');
  console.log(`     - Sàn: ${fullResult.platformLabel}`);
  console.log(`     - Tiêu đề sạch: ${fullResult.title}`);
  console.log(`     - Số lượng ảnh: ${fullResult.images.length}`);
  console.log(`     - Nguồn ảnh: ${fullResult.usedFallbackImage ? 'Fallback (DuckDuckGo)' : 'Sàn gốc'}`);

  console.log('\n🎉 TẤT CẢ 7 BÀI TEST ĐÃ VƯỢT QUA 100%!');
}

runTests().catch((err) => {
  console.error('\n❌ TEST THẤT BẠI:', err);
  process.exit(1);
});
