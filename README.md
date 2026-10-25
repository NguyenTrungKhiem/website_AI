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
- Trang **Ghép video** có ô **📥 Thêm video từ máy**; với video nhập, chọn "khớp đoạn gốc" để chèn đúng khúc âm thanh.
- Bối cảnh mới được lưu vào thư viện ảnh (loại "bối cảnh") để dùng lại. Trên Flow, bước sinh ảnh dùng Nano Banana và hiện không tốn credit; 2 bước video tốn credit như thường (≈20 credit/đoạn ở 720p, ≈10 ở 360p).

## Quy trình Thay trang phục

Menu **👗 Thay trang phục** (`server/workflows/thay-trang-phuc.js`): dùng khi video gốc có nhiều cảnh, mỗi cảnh một bộ đồ. Các bước giống AI Dancing (bối cảnh mới → thay mặt + trang phục → kiểm tra → thay nền → ghép), khác ở chỗ:

- **Mỗi đoạn chọn trang phục riêng**: mặt trước (bắt buộc) và mặt sau (tuỳ chọn, cho lúc nhân vật quay lưng). Nút "↓ áp cho đoạn sau" chép trang phục xuống các đoạn kế tiếp. Ảnh model dùng chung.
- **Khoá khuôn mặt** (tuỳ chọn, mặc định bật): đoạn 1 render trước; web cắt 1 khung mặt đã render của đoạn 1 và đưa thêm vào các đoạn sau như ảnh tham chiếu thứ 2, để mọi đoạn bám theo đúng khuôn mặt đã render. Thứ tự ảnh gửi Flow: model → (mặt khoá) → trang phục trước → (mặt sau) → video. Thử lại đoạn 1 sau khi các đoạn sau đã tạo thì mặt khoá được cắt lại nhưng các đoạn sau không tự tạo lại (tránh tốn credit) — Thử lại tay nếu cần.
- Prompt bước 2 có chỗ điền tự động `{inputs}`, `{identity_rule}`, `{outfit_rule}` theo số ảnh của từng đoạn.

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

Ở ô **Ảnh sản phẩm** dán link Shopee (link rút gọn `s.shopee.vn/…` hoặc link sản phẩm) rồi bấm **🛒 Lấy ảnh**: web mở trang sản phẩm trong cửa sổ Chrome của Flow (Shopee chặn request không phải trình duyệt), lấy ảnh từng phân loại + ảnh bộ sưu tập, xếp theo lượt bán từng phân loại nếu Shopee trả về (thường không công khai → theo thứ tự Shopee ưu tiên), chọn sẵn 3 ảnh đầu. Chọn ảnh → **Thêm vào thư viện** → ảnh đầu tiên được gắn làm ảnh sản phẩm. Shopee đòi xác minh/đăng nhập thì làm trong tab Shopee của cửa sổ Chrome đó rồi bấm lại.

## Google Flow tự động (dùng credit Flow)

Đây là cách tạo video/ảnh duy nhất (không dùng Gemini API). Web dùng Playwright để điều khiển 1 cửa sổ Chrome riêng (hồ sơ trong `data/flow-chrome`), cấu hình ở **Cài đặt → Google Flow tự động**:

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
