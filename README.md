# Video Studio

Web chạy trên máy cá nhân để: cắt video gốc → motion control bằng Gemini Omni Flash → thay bối cảnh → đăng lên TikTok / Instagram / Threads / Facebook / YouTube.

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

- Lần chạy dừng khi có video lỗi: bấm **Thử lại** trên video đó rồi bấm **Tiếp tục** trên lần chạy. Server khởi động lại cũng tiếp tục được.
- Mỗi lần chạy hiện tiến trình từng bước, khung hình gốc, bối cảnh mới, video hoàn chỉnh và nút **Đăng video**.
- Mục **Từng đoạn** trong lần chạy: mỗi đoạn có thẻ video motion và thẻ video đã thay nền — xem video, **Thử lại** / **Sửa prompt**, chọn lần tạo tốt nhất, xoá lần tạo. Đổi kết quả ở cột motion → web tự thay nền lại cho đoạn đó và ghép lại; đổi ở cột thay nền → chỉ ghép lại.
- Cùng mục đó có nút **📥 Thay bằng video từ máy**: nhập video từ máy để thay video motion của đoạn đó (chọn nhiều file thì các file sau thay các đoạn kế tiếp). Web tự thay bối cảnh lại cho đoạn đó và ghép lại.
- Trang **Ghép video** có ô **📥 Thêm video từ máy**; với video nhập, chọn "khớp đoạn gốc" để chèn đúng khúc âm thanh.
- Bối cảnh mới được lưu vào thư viện ảnh (loại "bối cảnh") để dùng lại. Trên Flow, bước sinh ảnh dùng Nano Banana và hiện không tốn credit; 2 bước video tốn credit như thường (≈20 credit/đoạn ở 720p, ≈10 ở 360p).

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

App tự ghép prompt mẫu (tiếng Anh) với prompt của bạn, với ảnh được tham chiếu bằng `<IMAGE_REF_n>`. Bấm "Xem prompt" trên mỗi job để thấy prompt thực tế đã gửi; tick "Chỉ dùng prompt của tôi" để tự viết toàn bộ. Prompt mẫu nằm trong `server/gemini.js`.

## Gemini

- API key: https://aistudio.google.com/apikey
- Model mặc định `gemini-omni-1.1-flash`, gọi qua `POST /v1beta/interactions` (tài liệu: https://ai.google.dev/gemini-api/docs/omni).
- Omni Flash không có chế độ "motion transfer" riêng; app dùng video gốc làm tham chiếu chuyển động + ảnh tham chiếu + prompt. Nếu kết quả chưa đúng ý, thử đổi **Task** trong Cài đặt sang `edit` hoặc `reference_to_video`.

## Google Flow tự động (dùng credit Flow)

Cài đặt → Cách tạo video → **Google Flow tự động**. Web dùng Playwright để điều khiển 1 cửa sổ Chrome riêng (hồ sơ trong `data/flow-chrome`):

1. Bấm **Mở Chrome & đăng nhập**, tự đăng nhập Google trong cửa sổ đó (chỉ cần 1 lần).
2. Mỗi video: tải đoạn video + ảnh lên dự án Flow dùng chung → thêm vào prompt → chọn Video · Ingredients · Omni 1.1 Flash · x1 → gõ prompt → bấm tạo → chờ → tải video về.
3. Chạy lần lượt từng video (1 cửa sổ trình duyệt). Có video tham chiếu: 720p ≈ 20 credit, 360p ≈ 10 credit. Video lỗi phía Flow được Flow hoàn credit.

Lưu ý:
- Không được Google hỗ trợ chính thức, có thể vi phạm điều khoản → nguy cơ tài khoản bị hạn chế. Nên dùng tài khoản Google riêng.
- Flow hỏi "Rights to use this video" mỗi lần tải lên. Mặc định web dừng lại chờ bạn tự bấm; chỉ tự bấm "I agree" khi bạn tick ô tương ứng trong Cài đặt.
- Web không giải CAPTCHA/xác minh: nếu Google hỏi, tự làm trong cửa sổ Chrome rồi bấm Thử lại.
- Google đổi giao diện Flow thì phần tự động có thể hỏng; bộ chọn nằm trong `server/flow.js`, công cụ khảo sát giao diện: `node scripts/flow-inspect.mjs`.

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
