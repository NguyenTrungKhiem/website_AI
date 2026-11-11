# Video Studio

Web chạy trên máy cá nhân để: cắt video gốc → motion control bằng Omni Flash trên Google Flow (tự động bằng Playwright) → thay bối cảnh → đăng lên TikTok / Instagram / Threads / Facebook / YouTube.

## Chạy

```bash
npm install
npm run build
npm start
```

Mở http://localhost:3001. Khi sửa code, dùng `npm run dev` (giao diện ở http://localhost:5173, tự reload).

Không cần cài ffmpeg riêng — đã có sẵn qua npm (`ffmpeg-static`). Dữ liệu (video, ảnh, cài đặt, token) nằm trong thư mục `data/`.

## Quy trình tự động (AI Dancing)

Menu **AI Dancing** chạy trọn gói cho 1 video gốc đã cắt: cắt khung hình 0.1s → sinh **bối cảnh mới** (ảnh) → **thay người + sản phẩm** cho từng đoạn → **thay bối cảnh** vào video đã tạo → **ghép** lại + chèn âm thanh gốc. Mỗi bước có prompt mẫu riêng, sửa được ngay trên trang (lưu trong Cài đặt), và được "đóng băng" vào từng lần chạy.

- Sau bước **Thay nhân vật + sản phẩm**, lần chạy dừng lại (⏸ Chờ bạn kiểm tra) để bạn xem video từng đoạn; ưng rồi bấm **▶ Tiếp tục: thay bối cảnh** (bước này mới tốn credit). Bỏ tick tuỳ chọn "Dừng lại để kiểm tra…" nếu muốn chạy thẳng. Video motion đổi (thử lại / thay file) thì kiểm tra lại.
- Ảnh bối cảnh do Flow tạo được dùng lại ngay trong dự án Flow khi thay bối cảnh (nhận theo tên ảnh trên Flow), không tải ảnh lên lại; nếu ảnh không còn trên Flow thì tự tải lên như thường.
- Lần chạy dừng khi có video lỗi: bấm **Tiếp tục** trên lần chạy để tạo lại các video lỗi và chạy tiếp (muốn sửa prompt trước thì dùng **Sửa prompt** trên video đó). Server khởi động lại cũng tiếp tục được.
- Mỗi lần chạy hiện tiến trình từng bước, khung hình gốc, bối cảnh mới, video hoàn chỉnh và nút **Đăng video**.
- Mục **Từng đoạn** trong lần chạy: mỗi đoạn có thẻ video motion và thẻ video đã thay nền — xem video, **Thử lại** / **Sửa prompt**, chọn lần tạo tốt nhất, xoá lần tạo. Đổi kết quả ở cột motion → web tự thay nền lại cho đoạn đó và ghép lại; đổi ở cột thay nền → chỉ ghép lại.
- Cùng mục đó có nút **📥 Thay bằng video từ máy**: nhập video từ máy để thay video motion của đoạn đó (chọn nhiều file thì các file sau thay các đoạn kế tiếp). Web tự thay bối cảnh lại cho đoạn đó và ghép lại.
- Lấy ảnh sản phẩm từ link Shopee/Lazada/TikTok Shop: web mở link trong **cửa sổ Chrome của Flow** (`server/browserScraper.js`) và đọc thẳng JSON sản phẩm của sàn (Shopee: `/api/v4/pdp/get_pc`) → đủ bộ ảnh gốc, ảnh theo phân loại, tên, giá. Tải HTML "chay" chỉ là dự phòng vì Shopee trả về trang rỗng/chặn bot. Cần Chrome của Flow đang mở; sàn đòi captcha thì qua bước đó trong cửa sổ Chrome rồi bấm lại.
- Ảnh model / sản phẩm: rê chuột vào ảnh bấm **🔍** để xem to. Popup có ô prompt tiếng Anh + nút **✨ Tạo ảnh sạch bằng Flow** (Nano Banana, 0 credit): tạo lại ảnh sản phẩm sắc nét, bỏ người/vật thể, chỉ giữ sản phẩm; ảnh mới được lưu vào thư viện (đánh dấu ✨) và tự chọn làm ảnh dùng cho video. Prompt mặc định ở `server/prompts.js`, sửa và "Lưu làm mặc định" ngay trong popup.
- **Phóng to**: bấm vào bất kỳ video nào trong app thì video mở to giữa màn hình và tự phát (Esc hoặc bấm ra ngoài để đóng, có link tải); bấm vào ảnh thì xem to. Ngoại lệ: trình cắt video và cửa sổ So sánh (bấm = phát/dừng), các ô chọn ảnh/video (bấm = chọn; dùng nút 🔍 / ▶ trên ô để xem to). Component `MediaLightbox` trong `web/src/components.jsx`, gắn ở `App.jsx`.
- Trang **Ghép video** và **Đăng video**: rê chuột vào ô video có nút **⬇** (tải về), **▶** (xem to) và **×** (xoá video, bấm 2 lần). Video đã từng tải xuống được đánh dấu **⬇ Đã tải** (viền tím trên ô video, nhãn tím trên thẻ video đã ghép; lưu `downloadedAt` trong db).
- Trang **Ghép video** có ô **📥 Thêm video từ máy**; với video nhập, chọn "khớp đoạn gốc" để chèn đúng khúc âm thanh.
- Bối cảnh mới được lưu vào thư viện ảnh (loại "bối cảnh") để dùng lại. Trên Flow, bước sinh ảnh dùng Nano Banana và hiện không tốn credit; 2 bước video tốn credit như thường (≈20 credit/đoạn ở 720p, ≈10 ở 360p).

## Mã sản phẩm in trên video thời trang

Module **🛍️ Video bán hàng thời trang** in mã sản phẩm lên đầu video thay cho chữ `"TODAY'S OUTFIT"` trong prompt gốc (`server/productCodes.js`):

- Mỗi **ảnh trang phục mặt trước** có đúng 1 mã dạng `LOAI_SO` (không dấu, in hoa): chọn ảnh → app lấy mã đã cấp cho ảnh đó, ảnh mới thì cấp số tiếp theo (`VAY_01`, `VAY_02`…; tiền tố đoán theo tên ảnh: váy/đầm → `VAY`, áo dài → `AODAI`, áo → `AO`, quần → `QUAN`, set → `SET`, không rõ → `SP`). Ảnh làm sạch / cắt / mặt sau sinh từ ảnh đó dùng lại mã của ảnh gốc. Sửa mã tay ngay trong ô (lưu lên ảnh; mã đã thuộc ảnh khác thì bị từ chối).
- 2 người làm trên 2 máy: **📤 Xuất mã (.txt)** (các mã cách nhau dấu phẩy) → đưa cho người kia **📥 Nhập mã (.txt)**; mã đã nhập được coi là đã dùng nên số mới cấp sẽ nhảy qua, không trùng. Nên nhập mã của nhau trước mỗi đợt làm.
- Quy trình **Ảnh model mặc đồ** dùng chung sổ mã này (bảng **🏷️ Mã & sản phẩm** trên thẻ lần chạy: mã in lên ảnh kết quả + Excel cho DiamondShop — xem mục quy trình đó), nên một trang phục chỉ có một mã dù lên video hay lên ảnh.
- **Chữ trên video** (cả *Video bán hàng thời trang* và *… không voice*, `server/caption.js`): chọn 1 trong 3 ngay ở khối mã sản phẩm —
  **🏷️ Mã sản phẩm** (mặc định, như trên) · **✏️ Chữ tuỳ ý** (tự nhập, tối đa 40 ký tự, bỏ dấu nháy kép; không voice: mỗi bộ 1 ô, bộ để trống dùng chữ của bộ trên) · **🚫 Không chữ** (bỏ câu in chữ khỏi prompt và dặn "không có chữ nào trên màn hình"; không cấp mã mới).
  Prompt bạn sửa được giữ nguyên, chỉ đổi lúc gửi Flow; mốc giây và câu Voice không đổi. TH1 (đầy đủ outfit) ở chế độ Không chữ vẫn giữ các ô nhỏ "Mã sản phẩm" bật lên cạnh ảnh sản phẩm — sửa trong prompt TH1 nếu muốn bỏ.

## Quy trình Thay trang phục

Menu **👗 Thay trang phục** (`server/workflows/thay-trang-phuc.js`): dùng khi video gốc có nhiều cảnh, mỗi cảnh một bộ đồ. Các bước giống AI Dancing (bối cảnh mới → thay mặt + trang phục → kiểm tra → thay nền → ghép), khác ở chỗ:

- **Mỗi đoạn chọn trang phục riêng**: mặt trước (bắt buộc) và mặt sau (tuỳ chọn, cho lúc nhân vật quay lưng). Nút "↓ áp cho đoạn sau" chép trang phục xuống các đoạn kế tiếp. Ảnh model dùng chung.
- **Khoá khuôn mặt** (tuỳ chọn, mặc định bật): đoạn 1 render trước; web cắt 1 khung mặt đã render của đoạn 1 và đưa thêm vào các đoạn sau như ảnh tham chiếu thứ 2, để mọi đoạn bám theo đúng khuôn mặt đã render. Thứ tự ảnh gửi Flow: model → (mặt khoá) → trang phục trước → (mặt sau) → video. Thử lại đoạn 1 sau khi các đoạn sau đã tạo thì mặt khoá được cắt lại nhưng các đoạn sau không tự tạo lại (tránh tốn credit) — Thử lại tay nếu cần.
- Prompt bước 2 có chỗ điền tự động `{inputs}`, `{identity_rule}`, `{outfit_rule}` theo số ảnh của từng đoạn.

## Quy trình Hát nhép

Menu **🎤 Hát nhép** (`server/workflows/hat-nhep.js`): cấu trúc giống Thay trang phục (trang phục riêng từng đoạn, khoá khuôn mặt theo đoạn 1, bối cảnh mới, ghép với âm thanh gốc khớp từng đoạn). Khác ở prompt: **khẩu hình là ưu tiên cao nhất** — hình miệng, độ mở, răng/lưỡi, nhịp từng âm tiết, biểu cảm, cử động đầu phải giữ y nguyên theo từng khung của video gốc; chỉ thay nhận dạng khuôn mặt, trang phục và nền. Bước kiểm tra sau khi thay mặt: dùng ⇄ So sánh để xem miệng có khớp video gốc không trước khi tốn credit thay nền.

## Quy trình Fashion V2V

Menu **🎬 Fashion V2V** (`server/workflows/fashion-v2v.js`): không tạo bối cảnh tự động. Bạn chọn **Ảnh 2** khuôn mặt, **Ảnh 3** sản phẩm / trang phục, **Ảnh 4** bối cảnh có sẵn (tải lên ở ô bối cảnh). Web tự tạo **Ảnh 1** = bảng vóc dáng toàn thân 16:9 (trước / nghiêng / sau) của nhân vật mặc sản phẩm bằng Nano Banana (0 credit, prompt "High-fashion turnaround"), dừng lại cho bạn duyệt (Thử lại / Sửa prompt được), rồi mỗi đoạn tạo **1 lần** video trên Flow với nguyên liệu đúng thứ tự Ảnh 1 → 2 → 3 → 4 → video gốc và prompt "Cinematic fashion V2V & environment swap" (cả hai prompt sửa được ở "Prompt mẫu của quy trình"). Xong thì ghép các đoạn + chèn âm thanh gốc như các quy trình khác. Ảnh vóc dáng tạo lại thì các đoạn tự tạo video lại.

## Quy trình Ảnh model mặc đồ (chỉ ảnh, 0 credit)

Menu **📸 Ảnh model mặc đồ** (`server/workflows/anh-model.js`, quy trình `noVideo`): 1 ảnh model toàn thân + **nhiều** ảnh trang phục (chọn nhiều trong thư viện, có số thứ tự) + 1 ảnh bối cảnh. Bước 1 làm sạch bối cảnh (bỏ người, giữ nguyên khung cảnh; tắt được nếu ảnh đã sạch), bước 2 render mỗi trang phục thành 1 ảnh model mặc bộ đó trong bối cảnh (ảnh 1 = model, 2 = trang phục, 3 = bối cảnh; Nano Banana). Ảnh kết quả hiện ở thẻ lần chạy (Thử lại / chọn lần tạo / tải về) và tự lưu vào thư viện loại `lookbook` (mang theo metadata sản phẩm của trang phục); nút **Lưu làm ảnh model** (hoặc bật tuỳ chọn "Lưu luôn thành ảnh model") sao chép sang thư viện ảnh model để dùng cho AI Dancing / Thay trang phục.

### Mã sản phẩm & Excel cho DiamondShop (mỗi ảnh trang phục = 1 sản phẩm)

Khách xem ảnh / video trên TikTok gõ **mã sản phẩm** vào web DiamondShop để mở đúng sản phẩm và mua qua link affiliate. Luồng trong module này (`server/productExport.js`, chỉ áp cho quy trình có ô ảnh sản phẩm chọn nhiều — các quy trình video không đổi):

- **Lấy ảnh trang phục qua link Shopee** ở ô *Ảnh trang phục* → chọn ảnh → (tuỳ chọn) **✨ Làm sạch bằng Flow** → Dùng. Tên, giá, mô tả gốc (≤ 600 ký tự), URL ảnh gốc, `shopId`/`itemId` lấy được lúc bóc link được lưu vào `asset.product` khi tải ảnh về thư viện và **đi theo ảnh suốt luồng**: ảnh làm sạch / mặt sau / cắt / sao chép kế thừa `product` của ảnh gốc theo chuỗi `fromAssetId`, ảnh kết quả `lookbook` cũng mang theo. Ảnh tải từ máy (không bóc link) thì chỉ có tên ảnh, link trống → DiamondShop sẽ báo lỗi dòng đó.
- Render xong, bấm **🏷️ Mã & sản phẩm** trên thẻ lần chạy: bảng mỗi ảnh trang phục một dòng (ảnh trang phục → ảnh model đã render), tên / giá / mô tả / link Shopee / ảnh chính điền sẵn (sửa tay được). **Mã** dùng chung **sổ mã** với video thời trang (`server/productCodes.js`, dạng `VAY_01`): ảnh đã có mã thì hiện mã đó (kể cả mã của ảnh gốc khi đây là ảnh làm sạch), chưa có thì gợi ý số kế tiếp theo tên (**Gợi ý lại** để đổi); lưu thì cấp mã cho ảnh trang phục (`asset.productCode`, mã đã thuộc ảnh khác bị từ chối) và ghi ngược metadata để lần chạy sau dùng lại. Khung mã xem trước ngay trên ảnh kết quả: kéo thả đổi vị trí, thanh chỉnh cỡ, **Áp vị trí cho mọi ảnh**; mặc định tâm khung ở giữa, 12% chiều cao từ trên (phía trên đầu nhân vật).
- **💾 Lưu & in mã lên ảnh** → bước **In mã lên ảnh** của lần chạy chạy ffmpeg đè khung mã (PNG vẽ ở trình duyệt bằng Canvas: bo góc nhẹ, nền đen mờ 55%, chữ trắng đậm, đúng độ phân giải ảnh) lên từng ảnh kết quả thành file riêng `data/outputs/coded-<run>-<ảnh>.png` — ảnh render gốc giữ nguyên. Ở mục *Ảnh kết quả* mỗi ảnh có nhãn mã và link **🏷️ Tải ảnh có mã**. Đổi mã / vị trí, Thử lại render ra ảnh mới, hay bỏ mã → web tự in lại / dọn (bước hiện ⏳ rồi ✓, nhãn "⚠ chưa in mã mới" trong lúc chờ). Có thể đặt mã / tải Excel ngay cả khi chưa render xong.
- **📊 Tải Excel**: `san-pham-<yyyymmdd>-<runId>.xlsx`, sheet `San pham`, dòng 1 là tiêu đề, mỗi dòng một sản phẩm — Admin DiamondShop (Tab 5 → Nhập từ Excel) nhập thẳng file này. Dữ liệu đang sửa chưa lưu vẫn xuất được. **Không đổi tên / thứ tự cột** (hợp đồng với `web-site-aff/src/lib/productImport.ts`):

  | Cột | Nội dung |
  |---|---|
  | `Mã sản phẩm` | mã in trên ảnh (`VAY_01`…) |
  | `Tên sản phẩm` | tên đã làm sạch |
  | `Giá (đ)` | số nguyên VND |
  | `Mô tả` | text thuần ≤ 600 ký tự |
  | `Ảnh 1` … `Ảnh 6` | URL https ảnh gốc Shopee (`*.susercontent.com`); `Ảnh 1` = ảnh chính. DiamondShop chỉ nhận ảnh CDN Shopee, không nhận ảnh render local |
  | `Link Shopee` | `https://shopee.vn/product/<shopId>/<itemId>` |
  | `Danh mục` | tuỳ chọn |
  | `Hoa hồng Shopee (đ)` | **để trống** — web-video không có, DiamondShop điền |
  | `Ghi chú` | `Ảnh model mặc đồ – <tên ảnh model> – Bộ n` |
  | `Xem trước` | thumbnail ảnh model có mã (chỉ để nhìn, đọc từ file local) |

- API: `GET /api/runs/:id/products` → `{ mode: 'input', rows, frame }`; `PUT /api/runs/:id/products` `{ products: { [assetId]: { code, name, price, description, mainImage, category, badge: { x, y, scale, png } } } }`; `POST /api/runs/:id/products.xlsx`; `GET /api/products/suggest-code?title=&taken=`; `POST /api/product/import` nhận thêm `product` (kết quả bóc tách) để lưu `asset.product`. Test: `node scripts/test-product-export.mjs` (8 bài, thuần) và `node scripts/test-anh-model-products.mjs` (đầu-cuối trên server thật với engine giả: bóc link → làm sạch → chạy Ảnh model mặc đồ → lưu mã → in mã lên ảnh → Excel → DiamondShop đọc bằng `parseProductRows` nếu repo `../web-site-aff` nằm cạnh).

### Video bán hàng thời trang không voice

Menu **🤫 Video bán hàng thời trang không voice** (`server/workflows/video-thoi-trang-khong-voice.js`): 1 ảnh model (@Image1) + **1–4 trang phục** chọn theo thứ tự mặc, mỗi bộ có ảnh **mặt trước + mặt sau** (đoạn quay lưng dùng ảnh mặt sau) + 1 ảnh bối cảnh → 2 phân cảnh 10s trên Flow (Omni · Ingredients · 9:16), không voice, không lip-sync, rồi ghép lại.

- **Mặt sau**: dưới phần chọn ảnh, mỗi bộ có ô chọn ảnh mặt sau và nút **✨ Tạo mặt sau** (Flow, 0 credit, cùng cách với quy trình có voice); không chọn thì quy trình tự lấy ảnh mặt sau mới nhất đã tạo từ ảnh mặt trước đó, chưa có thì không chạy được.
- Thứ tự ảnh gửi Flow: Part 1 = model, trước 1, sau 1, mặt trước các bộ còn lại (cầm trên móc), bối cảnh; Part 2 = model, (trước, sau) từng bộ còn lại, bối cảnh, khung hình cuối Part 1. Tag `@ImageN` trong prompt được server điền theo đúng thứ tự này.
- **Mã sản phẩm** làm caption trên video: mỗi ảnh trang phục có 1 mã (ô sửa ngay dưới phần chọn ảnh; ảnh chưa có mã được cấp tự động khi chạy, xem `server/productCodes.js`). Part 1 hiện mã của trang phục 1; Part 2 đổi mã đúng tại mỗi lần đổi trang phục. Đổi sang **Chữ tuỳ ý** hoặc **Không chữ** bằng 3 nút ở đầu khối (xem mục "Chữ trên video" ở trên).
- Ảnh mặt sau chọn tay ở ô "Mặt sau" được giữ khi chạy (trước đây server bỏ qua và luôn lấy ảnh mặt sau mới nhất tạo từ ảnh mặt trước).
- Prompt cố ý gọn (≈2.200–2.600 ký tự mỗi phân cảnh, ngang prompt TH1 của quy trình có voice) vì Flow từ chối prompt quá dài; mỗi mốc chỉ ghi động tác tay / chân / đầu.
- **Chuyển động** (tuỳ chọn dạng chọn): kịch bản tay chân theo mốc giây. *Chuyển động 1* dựng theo video mẫu (cầm móc → match cut → khăn/túi → quay lưng → cận chi tiết → kết dáng). Mỗi chuyển động gồm prompt Part 1 cố định và các **khối** cho trang phục kế tiếp (gốc 6s / 4s) + khối "chỉ 1 trang phục" (10s); server tự chia 10s của Part 2 cho các trang phục còn lại (2 trang phục còn lại: 6s + 4s như video mẫu, 1: trọn 10s, 3: 3,3s mỗi bộ) và co giãn mốc giây của khối. Thêm chuyển động mới = thêm một mục vào `MOTIONS` trong file quy trình.
- *Chuyển động 2* (theo video mẫu váy dài, **chỉ 1 trang phục** mặt trước + mặt sau, **1 phân cảnh duy nhất**): giơ móc váy → match cut từ sau lưng, bước ra xa → trước mặt hai tay cầm túi → chạm dây vai → bước tới → lưng → trước (tay đặt hông) → nghiêng người ngoái nhìn → lưng, vén tóc khoe dây lưng. Tuỳ chọn **Thời lượng** quyết định bản prompt: **15s** (đúng nhịp video mẫu, 11 mốc) hoặc **10s** (cùng trình tự, nhịp rút gọn, 9 mốc); không cắt khung hình cuối, không Part 2, bước ghép chỉ xoá logo. Chọn quá 1 trang phục thì báo lỗi.
- *Chuyển động 3* (theo video mẫu "váy đầm đi tiệc vibe tiểu thư" 16s → lấy 15s đầu, **ĐÚNG 2 trang phục** mỗi bộ mặt trước + mặt sau, **1 phân cảnh 15s**, mỗi bộ 1 túi xách nhỏ do AI chọn cho hợp): ôm 2 váy trên tay → match cut 1.2s bộ 1: bước tới, đứng, tay chạm cằm, cận ngực–eo, hất tóc + dang tay, bước tới, hai tay cầm túi → match cut 9.0s bộ 2: bước tới, hai tay cầm túi trước bụng, chống hông, cận ngực–eo, bước tới, xoay lưng ngoái nhìn (kết ở mặt sau bộ 2). 14 mốc, cả prompt ≈ 2.950 ký tự. Ảnh gửi Flow: model, (trước, sau) bộ 1, (trước, sau) bộ 2, bối cảnh. Caption đổi mã đúng ở 9.0s. Giao diện chỉ cho chọn 2 ảnh, ô Thời lượng chỉ còn 15s; chọn 1 hoặc 3–4 bộ thì nút Chạy bị khoá và server cũng từ chối.
- *Chuyển động 4* (theo video mẫu "đầm váy phong cách quyến rũ" 13,5s → 15s, **ĐÚNG 1 trang phục** mặt trước + mặt sau, **1 phân cảnh 15s**, 1 ví cầm tay nhỏ do AI chọn): **không có đoạn mặc đồ thường** — ngay khung hình đầu người mẫu đã mặc sản phẩm (không match cut; dòng Wardrobe dùng bản `wardrobe0`). 15 mốc: lưng 3/4 ngoái nhìn → hai tay chạm xương quai xanh → bước tới → tựa tường → bước tới lắc hông → xoắn tóc nháy mắt → nghiêng người tay sau gáy → 3/4 lưng ngoái nhìn → lưng, tay luồn tóc → cận, tay chống eo → bước tới vén váy → bước ra xa (lưng) → bước tới → lưng ngoái nhìn như mở đầu → **hai tay bye bye + hôn gió** (đoạn kết thêm vào vì video mẫu chưa đủ 15s). Cả prompt ≈ 3.020 ký tự. Ảnh gửi Flow: model, trước, sau, bối cảnh. Giao diện chỉ cho chọn 1 ảnh, ô Thời lượng chỉ còn 15s.
- **Giữ vóc dáng**: phần mở đầu chung (`setup`) yêu cầu giữ đúng số đo và đường cong ngực, eo, hông, đùi của ảnh model ở mọi khung hình, không được làm gọn hay thu nhỏ; trang phục ôm theo cơ thể đó.
- **Khoá trang phục** (`wardrobe` cho Part 1 / video 1 phân cảnh, `wardrobe2` cho Part 2): 1 dòng "Wardrobe" riêng, ngắn (≈220 ký tự) — ảnh model chỉ là tham chiếu khuôn mặt / tóc / vóc dáng, không lấy quần áo; từ mốc match cut tới hết video không còn mảnh nào của đồ cũ lộ dưới / ngoài / cạnh trang phục mới, kể cả cú quay lưng và cận cảnh. Các mốc động tác không đổi.
- **Từng phân cảnh** trong lần chạy: mỗi phân cảnh 1 thẻ video. **Thử lại** thêm lần tạo 1, 2, 3… vào cùng thẻ; bấm số để chốt bản tốt nhất. Đổi bản Phân cảnh 2 → chỉ ghép lại; đổi bản Phân cảnh 1 → cắt lại khung hình cuối, tạo lại Phân cảnh 2 đúng 1 lần rồi ghép lại. Lần chạy cũ (khung hình cuối chưa xoá mã) được làm sạch ở nền, không tự tạo video.
- Mọi khối sửa được trong "Prompt mẫu của quy trình": dòng dạng `a.a-b.bs: …`, chỗ điền `{MODEL}`, `{OUTFIT}`, `{OUTFITS}`, `{CODE}`, `{BG}`, `{START}`, `{PART}`.
- Part 2 nhận thêm khung hình cuối của Part 1 làm nguyên liệu cuối (`{START}`) để mở đúng khung đó; khung này được **xoá dải chữ phía trên** (ffmpeg delogo, `removeCaptionBand`) vì nó in sẵn mã của trang phục 1 và Flow sẽ chép mã đó sang Part 2; prompt Part 2 cũng nói rõ chữ trong ảnh thuộc Part 1, caption từ khung đầu là mã của trang phục kế tiếp. Part 1 đổi kết quả thì Part 2 và ghép tự làm lại.

Thêm quy trình mới (vd. Thay quần áo): tạo `server/workflows/<ten>.js` cùng cấu trúc với `dancing.js` (inputs, prompts, options, stages) và đăng ký trong `server/workflows/index.js`. Giao diện tự sinh trang riêng, không ảnh hưởng tới Dancing. Các bước dùng chung (Cắt, Ghép, Đăng) giữ nguyên. Các job lẻ (motion / background / image) vẫn có API (`/api/jobs/...`) nhưng không còn trang riêng.

Thử quy trình không tốn tiền: đặt `"engine": "mock"` trong `data/db.json` (engine giả chép đầu vào thành đầu ra sau 2 giây).

## Luồng làm việc

1. **Cắt video** — timeline kiểu CapCut, timecode `phút:giây:khung` (vd. `00:07:07` = 7 giây + 7 khung). Kéo playhead rồi bấm **Cắt** / `Ctrl+B`; cắt chính xác tới từng khung hình. Mỗi đoạn tối đa 10s vì Omni Flash chỉ nhận video đầu vào ≤10s (đoạn quá dài tô đỏ). Điểm cắt được nhớ lại theo từng video gốc.

   | Phím | Tác dụng |
   |---|---|
   | `Ctrl+B` | Cắt tại playhead |
   | `Space` | Phát / dừng |
   | `←` / `→` | Lùi / tới 1 khung |
   | `Shift+←` / `Shift+→` | Lùi / tới 1 giây |
   | `↑` / `↓` | Nhảy tới điểm cắt trước / sau |
   | `Delete` | Bỏ qua / lấy lại đoạn đang chọn |
   | `Ctrl+Z` | Hoàn tác |
   | `Ctrl` + lăn chuột | Zoom timeline |

   Bấm vào ô timecode để gõ thời gian cần tới.
2–3. **AI Dancing** (xem trên) — thay người + sản phẩm rồi thay bối cảnh cho từng đoạn. Mỗi video có **Thử lại** / **Sửa prompt**, giữ lại mọi lần tạo để chọn bản ưng nhất.
4. **Ghép video** — nối các video đã tạo theo thứ tự, chèn âm thanh:
   - Âm thanh của video gốc được **tự tách và lưu** khi tải lên (`data/audio/`, tải về được ở trang Cắt video). Cũng có thể tải file nhạc khác lên.
   - *Khớp từng đoạn*: mỗi video lấy đúng khúc âm thanh của đoạn gốc tương ứng; video AI dài/ngắn hơn đoạn gốc sẽ được cắt bớt / giữ khung cuối để tiếng luôn khớp hình.
   - *Phát liên tục*: âm thanh chạy liền từ giây chỉ định, cắt theo độ dài video.
   - Video khác kích thước được đưa về cùng kích thước với video đầu tiên (thêm viền nếu khác tỉ lệ).
5. **Đăng video** — chọn video ghép hoặc video lẻ, nền tảng, caption.

App tự ghép prompt mẫu (tiếng Anh) với prompt của bạn; ảnh tham chiếu được Flow hiểu theo thứ tự (ảnh model → ảnh sản phẩm / bối cảnh → video). Bấm "Xem prompt" trên mỗi job để thấy prompt thực tế đã gửi; tick "Chỉ dùng prompt của tôi" để tự viết toàn bộ. Prompt mẫu nằm trong `server/prompts.js`.

## Ảnh sản phẩm từ Shopee

Ở ô **Ảnh sản phẩm** dán link Shopee (link rút gọn `s.shopee.vn/…` hoặc link sản phẩm) rồi bấm **🛒 Bóc tách & Lấy ảnh**: web tải HTML trang sản phẩm (UA mobile để Shopee trả SSR) → có tên, mô tả, bộ ảnh từng phân loại, chọn sẵn 3 ảnh đầu. **Giá:** Shopee giấu giá trong HTML SSR (mọi trường giá đều `null`) và chặn API từ Node, nên khi thiếu giá (hoặc thiếu ảnh) web mở trang trong **cửa sổ Chrome của Flow** (`server/browserScraper.js`, trang tự gọi API nội bộ của sàn) và chỉ bù phần thiếu (`mergeBrowserData`). Chrome chưa mở thì kết quả báo "Chưa có giá" kèm ô **Giá** để nhập tay ngay tại đó (ô này sửa được cả khi đã có giá). Giá, tên, link đi theo ảnh (`asset.product`) vào bảng **Mã & sản phẩm** và cột `Giá (đ)` của Excel DiamondShop — không phải nhập lại. Chọn ảnh → **Thêm vào thư viện** → ảnh đầu tiên được gắn làm ảnh sản phẩm. Shopee đòi xác minh/đăng nhập thì làm trong tab Shopee của cửa sổ Chrome đó rồi bấm lại.

## Google Flow tự động (dùng credit Flow)

Đây là cách tạo video/ảnh duy nhất (không dùng Gemini API). Web dùng Playwright để điều khiển 1 cửa sổ Chrome riêng (hồ sơ trong `data/flow-chrome`), cấu hình ở **Cài đặt → Google Flow tự động**:

1. Bấm **Mở Chrome & đăng nhập**, tự đăng nhập Google trong cửa sổ đó (chỉ cần 1 lần).
2. Mỗi video: tải đoạn video + ảnh lên dự án Flow dùng chung → thêm vào prompt → chọn Video · Ingredients · Omni 1.1 Flash · x1 → gõ prompt → bấm tạo → chờ → tải video về.
3. Chạy lần lượt từng video (1 cửa sổ trình duyệt). Có video tham chiếu: 720p ≈ 20 credit, 360p ≈ 10 credit. Video lỗi phía Flow được Flow hoàn credit.

Lưu ý:
- Không được Google hỗ trợ chính thức, có thể vi phạm điều khoản → nguy cơ tài khoản bị hạn chế. Nên dùng tài khoản Google riêng.
- Flow hỏi "Rights to use this video" mỗi lần tải lên. Mặc định web dừng lại chờ bạn tự bấm; chỉ tự bấm "I agree" khi bạn tick ô tương ứng trong Cài đặt.
- Web không giải CAPTCHA/xác minh: nếu Google hỏi, tự làm trong cửa sổ Chrome rồi bấm Thử lại.
- **Tải video 1080p** (Cài đặt → "Chất lượng tải video về", mặc định `1080p`, áp dụng cho mọi video tải từ Flow: job tạo, "Lấy từ Flow", "Tải video từ Google Flow về"): web bấm menu ⋮ → Download → **"1080p Upscaled"** thay vì lấy thẳng file 720p. Flow phóng to xong mới trả file nên chờ lâu hơn (web chờ tới 15 phút) và **Flow tính thêm credit cho mỗi video** (menu ghi "1080p Upscaled · 5 credits"; thẻ video ghi lại mục đã tải). Lỗi / không có mục đó thì tự lấy bản 720p, job không hỏng. Đổi về `720p` nếu muốn tiết kiệm credit. Bước ghép giữ đúng 1080p (nếu 1 đoạn 1080p, 1 đoạn 720p thì xuất theo đoạn nét hơn).
- Thời lượng video: Omni 1.2 Flash dùng **thanh trượt "Length"** (3–15s, mỗi nấc 1 giây) — web chỉnh bằng phím mũi tên và đọc lại dòng tóm tắt của Flow; Omni 1.1 Flash vẫn là nút 4/6/8/10s (không có 15s → job dừng với thông báo rõ, không tạo video sai thời lượng).
- Bảng cài đặt model của Flow bị đóng giữa chừng thì web tự mở lại và bấm lại. "Cấu hình sẵn Flow" (gọi khi mở trang Video bán hàng thời trang / đổi model, thời lượng) bị bỏ qua khi đang có job tạo trên Flow, để không giẫm lên job.
- Google đổi giao diện Flow thì phần tự động có thể hỏng; bộ chọn nằm trong `server/flow.js` (theo giao diện **tiếng Anh**; web luôn mở Flow với `?hl=en`, nên dán link dự án nào cũng được), công cụ khảo sát giao diện: `node scripts/flow-inspect.mjs`.

## Token mạng xã hội

Mỗi nền tảng yêu cầu bạn tạo app developer của riêng mình:

| Nền tảng | Cần gì | Lưu ý |
|---|---|---|
| TikTok | Access token có scope `video.publish` (TikTok for Developers → Content Posting API) | App chưa qua audit của TikTok chỉ đăng được ở chế độ riêng tư `SELF_ONLY` |
| Instagram | IG User ID + token có `instagram_content_publish` (tài khoản Business/Creator) | Upload trực tiếp, không cần URL public |
| Threads | Threads User ID + token có `threads_content_publish` | Threads tải video qua URL → cần đưa server ra internet (vd. `cloudflared tunnel --url http://localhost:3001`) và điền "URL public" |
| Facebook | Page ID + Page access token có `pages_manage_posts` | |
| YouTube | OAuth Client ID/secret + refresh token có scope `youtube.upload` (lấy qua OAuth Playground) | Video dọc ngắn (≤3 phút) sẽ thành Shorts |

## Giai đoạn sau

- Video hát nhép bằng Omni Flash.
- Tạo nhạc bằng Suno.
