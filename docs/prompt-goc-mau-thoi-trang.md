# Prompt gốc cho "Video bán hàng thời trang" (TH2 / TH3)

Cơ chế từ 11/2026: khi bấm **Phân tích Sản phẩm & Dựng 2 Prompt**, Gemini **không sửa phần tiếng Anh** của prompt gốc.
Nó chỉ nhận danh sách các câu `Voice: "..."` (kèm mốc giây + hành động của mốc đó) và viết lại lời thoại tiếng Việt
cho khớp sản phẩm vừa phân tích và hành động của nhân vật. Server ghép các câu mới vào đúng vị trí trong prompt gốc.

- `Voice: "..."` → được viết lại (đúng số câu, đúng thứ tự mốc).
- `Voice: [Silent]` → giữ nguyên.
- Mọi thứ khác (Setup, mốc giây, hành động, `@Image1..4`, "TODAY'S OUTFIT", Technical Rule) → giữ nguyên từng ký tự.
- Riêng chữ `"TODAY'S OUTFIT"` là **chỗ điền**: khi gửi Flow, app thay bằng **mã sản phẩm** của ảnh mặt trước (ô "🏷️ Mã sản phẩm in trên video", vd. `VAY_01`). Không sửa chữ này trong prompt gốc; muốn đổi mã thì sửa ở ô mã (lưu lên ảnh).

## Cách viết prompt gốc để dùng được cho mọi sản phẩm
- Phần tiếng Anh mô tả trang phục **chung chung**: `the @Image2 outfit`, `the lower part of the outfit`,
  `the neckline and upper chest details`… Không ghi tên/màu/chất liệu cụ thể (vd. đừng viết "silver-blue satin slip dress"),
  vì phần này sẽ không được sửa → sản phẩm nào cũng dùng đúng.
- Mọi thứ thuộc về sản phẩm (màu, chất liệu, chi tiết, lời khen) chỉ nằm trong **lời thoại** → Gemini thay mỗi lần phân tích.
- Mỗi mốc có lời phải viết `Voice: "..."` trên cùng dòng với mốc giây (`0.0-1.5s: ... Voice: "..."`) để server
  biết thời lượng và hành động của câu đó. Lời thoại cũ trong prompt gốc chỉ là ví dụ giọng điệu.
- Web luôn dựng từ PROMPT GỐC đã lưu, không từ ô đang soạn → sửa mẫu xong nhớ bấm **💾 Lưu lại prompt gốc**.

## Prompt gốc mặc định
Xem 4 hằng `DEFAULT_FASHION_*` trong `server/geminiFashion.js`:
- TH2 Cảnh 1 (10s, match-cut 1.5s, xoay khoe lưng 6.5-8.5s) + Cảnh 2 (6s).
- TH3 Áo dài Cảnh 1 (10s, vén tà khoe quần 5.8-8.8s) + Cảnh 2 (10s, xoay khoe lưng 0.0-3.2s).

Muốn dùng lại bản mặc định sau khi đã lưu prompt riêng: bấm **Khôi phục mặc định hệ thống** ở phân cảnh đó
(prompt riêng được lưu thành phiên bản, rollback được).
