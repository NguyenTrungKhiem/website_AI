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

Menu **AI Dancing** chạy trọn gói cho 1 video gốc đã cắt: cắt khung hình 0.1s → sinh **bối cảnh mới** (ảnh) → **khoá nhận diện** (bảng mặt 360° của model → keyframe cho từng đoạn, bạn duyệt) → **thay người + sản phẩm** cho từng đoạn (animate keyframe theo video gốc) → **thay bối cảnh** vào video đã tạo → **ghép** lại + chèn âm thanh gốc. Mỗi bước có prompt mẫu riêng, sửa được ngay trên trang (lưu trong Cài đặt), và được "đóng băng" vào từng lần chạy.

- **Khoá nhận diện** (tuỳ chọn, bật sẵn) — để mặt trong video giống model hơn, không giao thẳng ảnh model cho model video:
  1. **Bảng mặt 360°** (identity sheet): ảnh 16:9 gồm 24 góc mặt (0°→345°) của cùng một người, tạo từ ảnh model bằng Nano Banana (0 credit), chỉ tạo 1 lần cho mỗi ảnh model. Bấm **🔍** trên ảnh model → mục **Bảng mặt 360°** → **✨ Tạo bảng mặt 360°** (sửa prompt được ngay đó); chưa có thì quy trình tự tạo khi chạy. Bảng được lưu làm ảnh nháp gắn với ảnh model (không hiện trong thư viện, ảnh model có dấu **360°**), có tên trên Flow nên dùng lại không cần tải lên lại; tạo nhiều bảng thì quy trình dùng bảng mới nhất.
  2. **Keyframe từng đoạn**: khung hình đầu (0.1s) của đoạn + bảng mặt 360° (+ ảnh sản phẩm) → ảnh 9:16 người đã đúng mặt, giữ pose / outfit / bối cảnh của khung hình (0 credit). Prompt bảo model chọn ô góc mặt gần nhất và cấm "làm đẹp" (mắt to hơn, V-line, cằm dài…). Lần chạy **dừng lại** (⏸) để bạn duyệt keyframe ở cột **Keyframe** của bảng Từng đoạn: **Thử lại** / **Sửa prompt** / chọn lần tạo; ưng rồi bấm **▶ Tiếp tục: thay nhân vật theo keyframe** (từ đây mới tốn credit). Bỏ tick "Dừng lại để duyệt keyframe…" nếu muốn chạy thẳng.
  3. **Thay nhân vật** nhận nguyên liệu theo thứ tự keyframe → ảnh sản phẩm → video gốc, prompt "animate đúng ảnh này theo chuyển động của video gốc, giữ nguyên mặt / outfit / bối cảnh". Keyframe đổi sau khi đã duyệt → video motion của đoạn đó bị bỏ để tạo lại và web dừng duyệt keyframe lần nữa.
  Tắt tuỳ chọn "Khoá nhận diện" thì chạy như cũ: ảnh model → sản phẩm → video gốc với prompt "4b".
- Sau bước **Thay nhân vật + sản phẩm**, lần chạy dừng lại (⏸ Chờ bạn kiểm tra) để bạn xem video từng đoạn; ưng rồi bấm **▶ Tiếp tục: thay bối cảnh** (bước này mới tốn credit). Bỏ tick tuỳ chọn "Dừng lại để kiểm tra…" nếu muốn chạy thẳng. Video motion đổi (thử lại / thay file) thì kiểm tra lại.
- Ảnh bối cảnh do Flow tạo được dùng lại ngay trong dự án Flow khi thay bối cảnh (nhận theo tên ảnh trên Flow), không tải ảnh lên lại; nếu ảnh không còn trên Flow thì tự tải lên như thường.
- Lần chạy dừng khi có video lỗi: bấm **Tiếp tục** trên lần chạy để tạo lại các video lỗi và chạy tiếp (muốn sửa prompt trước thì dùng **Sửa prompt** trên video đó). Server khởi động lại cũng tiếp tục được.
- Mỗi lần chạy hiện tiến trình từng bước, khung hình gốc, bối cảnh mới, video hoàn chỉnh và nút **Đăng video**.
- Mục **Từng đoạn** trong lần chạy: mỗi đoạn có khung hình đầu, thẻ keyframe (khi bật khoá nhận diện), thẻ video motion và thẻ video đã thay nền — xem kết quả, **Thử lại** / **Sửa prompt**, chọn lần tạo tốt nhất, xoá lần tạo. Đổi keyframe → tạo lại video motion của đoạn đó (dừng duyệt lại); đổi kết quả ở cột motion → web tự thay nền lại cho đoạn đó và ghép lại; đổi ở cột thay nền → chỉ ghép lại.
- Cùng mục đó có nút **📥 Thay bằng video từ máy**: nhập video từ máy để thay video motion của đoạn đó (chọn nhiều file thì các file sau thay các đoạn kế tiếp). Web tự thay bối cảnh lại cho đoạn đó và ghép lại.
- Flow có thể chặn phiên Chrome do web điều khiển ("Failed – We noticed some unusual activity", bộ lọc chống lạm dụng của Google, không phụ thuộc cookie/hồ sơ; cùng tài khoản trong Chrome thường vẫn tạo được). Web nhận ra ô lỗi này và dừng lần chạy ngay. Khi đó dùng ô **🖐 Tạo tay trên Flow** dưới thẻ video motion của từng đoạn (tự mở khi đoạn bị chặn): tải đúng nguyên liệu web đã chuẩn bị theo thứ tự (keyframe hoặc ảnh model → ảnh sản phẩm → đoạn gốc), **📋 Chép prompt** đã ghép, tạo trong Chrome thường rồi **📥 Nhập video kết quả** tại chỗ; thay nền và ghép vẫn tự chạy tiếp. Web không có (và không làm) cách nào che giấu việc tự động hoá khỏi Google.
- Lấy ảnh sản phẩm từ link Shopee/Lazada/TikTok Shop: web mở link trong **cửa sổ Chrome của Flow** (`server/browserScraper.js`) và đọc thẳng JSON sản phẩm của sàn (Shopee: `/api/v4/pdp/get_pc`) → đủ bộ ảnh gốc, ảnh theo phân loại, tên, giá. Tải HTML "chay" chỉ là dự phòng vì Shopee trả về trang rỗng/chặn bot. Cần Chrome của Flow đang mở; sàn đòi captcha thì qua bước đó trong cửa sổ Chrome rồi bấm lại.
- Ảnh model / sản phẩm: rê chuột vào ảnh bấm **🔍** để xem to. Popup có ô prompt tiếng Anh + nút **✨ Tạo ảnh sạch bằng Flow** (Nano Banana, 0 credit): tạo lại ảnh sản phẩm sắc nét, bỏ người/vật thể, chỉ giữ sản phẩm; ảnh mới được lưu vào thư viện (đánh dấu ✨) và tự chọn làm ảnh dùng cho video. Prompt mặc định ở `server/prompts.js`, sửa và "Lưu làm mặc định" ngay trong popup.
- Trang **Ghép video** có ô **📥 Thêm video từ máy**; với video nhập, chọn "khớp đoạn gốc" để chèn đúng khúc âm thanh.
- Bối cảnh mới được lưu vào thư viện ảnh (loại "bối cảnh") để dùng lại. Trên Flow, bước sinh ảnh dùng Nano Banana và hiện không tốn credit; 2 bước video tốn credit như thường (≈20 credit/đoạn ở 720p, ≈10 ở 360p).

Thêm quy trình mới (vd. Thay quần áo): tạo `server/workflows/<ten>.js` cùng cấu trúc với `dancing.js` (inputs, prompts, options, stages) và đăng ký trong `server/workflows/index.js`. Giao diện tự sinh trang riêng, không ảnh hưởng tới Dancing. Các bước dùng chung (Cắt, Ghép, Đăng) giữ nguyên. Các job lẻ (motion / background / image) vẫn có API (`/api/jobs/...`) nhưng không còn trang riêng.

Thử quy trình không tốn tiền: đặt `"engine": "mock"` trong `data/db.json` (engine giả chép đầu vào thành đầu ra sau 2 giây). Muốn thử trên bản sao dữ liệu mà không đụng dữ liệu thật: chạy server với biến môi trường `DATA_DIR=<thư mục khác>` (và `PORT=3002` nếu cổng 3001 đang dùng).

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

Ở ô **Ảnh sản phẩm** dán link Shopee (link rút gọn `s.shopee.vn/…` hoặc link sản phẩm) rồi bấm **🛒 Lấy ảnh**: web mở trang sản phẩm trong cửa sổ Chrome của Flow (Shopee chặn request không phải trình duyệt), lấy ảnh từng phân loại + ảnh bộ sưu tập, xếp theo lượt bán từng phân loại nếu Shopee trả về (thường không công khai → theo thứ tự Shopee ưu tiên), chọn sẵn 3 ảnh đầu. Chọn ảnh → **Thêm vào thư viện** → ảnh đầu tiên được gắn làm ảnh sản phẩm. Shopee đòi xác minh/đăng nhập thì làm trong tab Shopee của cửa sổ Chrome đó rồi bấm lại.

## Google Flow qua extension (khuyên dùng)

Flow chặn phiên Chrome bị điều khiển qua cổng gỡ lỗi ("unusual activity"), nên cách chính giờ là extension **AutoAffiliate Trợ lý** (thư mục `extension/`) chạy trong Chrome thường của bạn. Chọn **Cài đặt → Engine: Google Flow qua extension**, chép **token** hiện ở đó vào trang Cài đặt của extension (địa chỉ web `http://localhost:3001`), **Lưu và kiểm tra**.

- Server xếp mỗi lần tạo (ảnh Nano Banana / video Omni) thành 1 việc (`server/agentApi.js`, API `/api/agent/*` theo hợp đồng của extension). Extension hỏi việc mỗi 4 giây, mở **tab Flow mới** ở dự án dùng chung (`?hl=en`, giao diện tiếng Anh), tự: nhận ra nguyên liệu đã có trên Flow (theo tên `vs-<mã băm>` hoặc tên ảnh Flow tạo) hoặc tải lên, thêm vào prompt đúng thứ tự, chọn Ảnh · Nano Banana hoặc Video · Ingredients · Omni · 720p + tỉ lệ, điền prompt (`extension/content/flow-studio.js`).
- Rồi extension báo **cần bạn xử lý**: bạn bấm nút → trên tab Flow đó (Flow chỉ nhận cú bấm thật ở nút này; extension thử bấm một lần, không nhận thì nhờ bạn). Extension theo dõi ô kết quả, tải file về server; quy trình chạy tiếp như thường (dừng duyệt keyframe, kiểm tra video, thay nền, ghép).
- Hộp thoại "Rights to use" khi tải file lên: tự bấm nếu bật "Tự bấm I agree" trong Cài đặt, không thì extension nhắc bạn. Video xong mà không đọc được link thì extension dùng menu Download của ô (720p / Original size) và bắt file trang tạo ra.
- Bấm biểu tượng extension để xem nhật ký, nhận việc ngay, huỷ việc. Hết 20 phút không có extension nhận việc hoặc 45 phút chưa có kết quả → job lỗi, bấm Thử lại.
- Web không có (và không làm) cách nào che giấu việc tự động hoá khỏi Google hay giả cú bấm người dùng ở nút tạo.

## Google Flow tự động bằng Playwright (cách cũ, Google có thể chặn)

Web dùng Playwright để điều khiển 1 cửa sổ Chrome riêng (hồ sơ trong `data/flow-chrome`), cấu hình ở **Cài đặt → Google Flow tự động** (Engine: Playwright):

1. Bấm **Mở Chrome & đăng nhập**, tự đăng nhập Google trong cửa sổ đó (chỉ cần 1 lần).
2. Mỗi video: tải đoạn video + ảnh lên dự án Flow dùng chung → thêm vào prompt → chọn Video · Ingredients · Omni 1.1 Flash · x1 → gõ prompt → bấm tạo → chờ → tải video về.
3. Chạy lần lượt từng video (1 cửa sổ trình duyệt). Có video tham chiếu: 720p ≈ 20 credit, 360p ≈ 10 credit. Video lỗi phía Flow được Flow hoàn credit.

Lưu ý:
- Không được Google hỗ trợ chính thức, có thể vi phạm điều khoản → nguy cơ tài khoản bị hạn chế. Nên dùng tài khoản Google riêng.
- Flow hỏi "Rights to use this video" mỗi lần tải lên. Mặc định web dừng lại chờ bạn tự bấm; chỉ tự bấm "I agree" khi bạn tick ô tương ứng trong Cài đặt.
- Web không giải CAPTCHA/xác minh: nếu Google hỏi, tự làm trong cửa sổ Chrome rồi bấm Thử lại.
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
