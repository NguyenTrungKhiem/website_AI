# AutoAffiliate Trợ lý (tiện ích Chrome)

## Dùng với Video Studio (thư mục cha)

Video Studio (`server/agentApi.js`) giao việc theo đúng hợp đồng của tiện ích này với hai loại việc riêng:
`flow_studio_image` (ảnh Nano Banana: bối cảnh, bảng mặt 360°, keyframe, ảnh sản phẩm sạch) và `flow_studio_video`
(video Omni, nguyên liệu = ảnh + video gốc), do `content/flow-studio.js` làm trên Google Flow **giao diện tiếng Anh**
(tab mở với `?hl=en` tới dự án dùng chung). Các loại việc cũ (`google_flow_video`, Suno, Gemini…) giữ nguyên.

1. Cài tiện ích (xem bên dưới), bấm biểu tượng → **Cài đặt**: địa chỉ web `http://localhost:3001`, token chép từ
   **Cài đặt → Google Flow tự động** của Video Studio (engine *Google Flow qua extension*) → **Lưu và kiểm tra**.
2. Chạy quy trình trong Video Studio như thường. Mỗi lần tạo, tiện ích mở tab Flow, chuẩn bị nguyên liệu + prompt + model
   rồi báo **cần bạn xử lý**: bạn bấm nút → (Start generation) trên tab Flow đó. Flow chỉ nhận cú bấm thật ở nút này;
   tiện ích không giả cú bấm người dùng. Tiện ích theo dõi ô kết quả, tải file về web, đóng tab.
3. "Rights to use this video" khi tải file lên: tự bấm nếu bật *Tự bấm I agree* trong Cài đặt của web, không thì tiện ích nhắc.

Thay đổi so với bản gốc: `background.js` (thêm 2 kind, mở đúng link dự án từ payload), `manifest.json` (nạp
`content/flow-studio.js`), `content/flow-main.js` (bắt cả Blob ảnh khi bấm Tải xuống).

---

Chạy ngay trong Chrome của bạn, dùng tài khoản Suno, Gemini và Google Flow bạn đã đăng nhập sẵn, không mở cửa sổ Chrome thứ hai.
Tiện ích chỉ gọi ra web AutoAffiliate của bạn (không mở cổng), nhận việc, làm trong một tab, rồi tự động gửi file nhạc, ảnh bìa, hoặc video thành phẩm về web.

## Tính năng tự động:
1. **Suno (`suno.com`):** Nhận prompt lời và thể loại, điền vào Suno, chờ tạo nhạc xong, tự tải file audio chất lượng cao về Kho nhạc.
2. **Gemini (`gemini.google.com`):** Tự động tạo ảnh bìa (dọc 9:16 hoặc ngang 16:9) và tạo video clip theo prompt các cảnh MV.
3. **Google Flow (`flow.google.com` / `labs.google`):** Tự động chuyển prompt các cảnh MV sang Google Flow, kích hoạt tạo video Veo/Flow, chờ sinh xong và tự tải video về gán vào bài hát.

## Cài đặt
1. Mở `chrome://extensions`, bật **Chế độ dành cho nhà phát triển** (góc trên phải).
2. Bấm **Tải tiện ích đã giải nén** và chọn thư mục `extension` này (nếu đã cài trước đó, bấm nút Tải lại/Reload 🔄 của tiện ích).
3. Bấm biểu tượng tiện ích, chọn **Cài đặt**: điền địa chỉ web (ví dụ `http://localhost:3000`) và token tạo ở trang **Trình hỗ trợ** trên web, rồi bấm **Lưu và kiểm tra**. Chrome sẽ hỏi quyền truy cập địa chỉ web đó, hãy cho phép.

## Cách hoạt động
- Cứ 30 giây tiện ích hỏi web có việc mới không. Có việc thì mở một tab tương ứng (Suno, Gemini, hoặc Google Flow) và thao tác trong đó.
- Cần bạn đăng nhập hoặc giải captcha: web hiện "cần bạn xử lý", bạn làm ngay trong tab đó, tiện ích tự chạy tiếp. Tiện ích không vượt captcha và không đọc mật khẩu.
- Xong việc, video/ảnh/nhạc tự động tải về web và tab tự đóng. Giữa hai việc nghỉ 20 giây.

## Khi giao diện các trang đổi
Mở trang tương ứng (Suno / Gemini / Google Flow), bấm biểu tượng tiện ích, **Lưu cấu trúc trang hiện tại**: nội dung được chép vào clipboard để gửi người hỗ trợ chỉnh bộ chọn (trong `content/suno.js`, `content/gemini.js`, `content/flow.js`).

Lưu ý: tự động hóa giao diện web có thể trái điều khoản của Suno/Google và có rủi ro bị hạn chế tài khoản.

## Cine Studio (extension 0.8.1)

- Sau khi cập nhật, bấm Reload ở `chrome://extensions` và tải lại các tab Gemini, ChatGPT, Flow đang mở.
- Tạo dự án → hồ sơ và ảnh nhân vật → ý tưởng tập → kịch bản → 3 ảnh mỗi cảnh → đủ 3 ảnh → Google Flow.
- Gemini/ChatGPT nhận ảnh tham chiếu nhân vật cùng prompt ảnh. Nếu chưa xác nhận đủ ảnh đính kèm, tiện ích yêu cầu bạn xử lý thay vì tạo ảnh sai nhận diện.
- Google Flow nhận đủ 3 ảnh của phân cảnh theo thứ tự: khung chính, góc bổ sung, khung kết thúc. Chọn model hỗ trợ 10 giây, thời lượng 10s và đúng khung hình trước khi chạy. Prompt không thay thế thiết lập thời lượng của model.
- Kết quả được gắn về đúng nhân vật/khung ảnh/cảnh. Tạo lại giữ bản cũ tới khi nhận kết quả mới; có thể hủy hoặc tải/dán file thủ công.
- Chỉ ghép tập phim khi đủ các clip 10 giây; giữ âm thanh gốc và thứ tự cảnh. Giao diện hiển thị thời lượng thực của từng clip.
- Kiểm thử mô phỏng extension: `cd extension/test && npm test`. Không thay thế việc thử trên giao diện Google/ChatGPT thật.

- Video Cine Studio gửi cả lời thoại tiếng Việt, nhạc nền và tiếng môi trường. Chọn model Flow có tạo âm thanh. Clip không có track âm thanh được cảnh báo trước khi ghép.
- Ảnh trong hàng đợi dùng link ký có hạn dùng; ảnh local dùng endpoint riêng được xác thực bằng token của tiện ích. Nút tạo video hiển thị tiến độ/lỗi ngay tại chỗ.

### Cine Studio Turbo (0.9.0)
Bật Turbo khi tạo tập mới rồi lưu: máy chủ viết từng cảnh, extension tạo ảnh và video, máy chủ ghép phim có tiếng và xử lý logo góc phải. Có thể đóng tab Cine Studio; Chrome, extension và máy chủ phải tiếp tục hoạt động. Extension tự thử chọn model Omni, 10s và âm thanh; nếu không tìm được thiết lập, nó báo cần xử lý trong Chrome trước khi gửi tạo. Đăng nhập, xác minh, credit và thay đổi giao diện Flow có thể yêu cầu người dùng xử lý. Tiến độ nằm trong database; Dừng/Chạy tiếp giữ lại kết quả đã có. Reload extension và tab Flow sau khi cập nhật phiên bản.

### 0.9.1 — Cài đặt Flow đúng thanh tạo video
Turbo bỏ qua bánh răng “Chế độ xem / Kích thước lưới” góc trên. Extension tìm nút Video / độ phân giải / thời lượng cạnh ô prompt, chọn Omni rồi 10 giây, và kiểm tra trạng thái đã áp dụng thay vì chỉ thấy lựa chọn 10s trong menu. Nếu không tìm được, thông báo chỉ rõ vị trí và thiết lập đang thấy. Không thay đổi tùy chọn âm thanh của thư viện. Tải lại extension và tab Flow sau khi cập nhật.
