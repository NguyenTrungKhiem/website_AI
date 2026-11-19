// Quy trình "Video bán hàng thời trang không voice": 1 ảnh model + 1–4 trang phục (mỗi bộ có ảnh MẶT TRƯỚC + MẶT SAU,
// theo thứ tự mặc) + 1 ảnh bối cảnh -> 2 phân cảnh 10s trên Flow (Omni, Ingredients, 9:16), KHÔNG voice, KHÔNG lip-sync.
// Mỗi trang phục có 1 mã sản phẩm (asset.productCode của ảnh mặt trước, cấp tự động nếu chưa có — ../productCodes.js) in làm
// caption; sang trang phục khác thì đổi mã. Ảnh mặt sau: chọn trong thư viện hoặc tạo từ mặt trước bằng Flow (0 credit,
// POST /api/assets/:id/render-back -> asset isBackView, fromAssetId = mặt trước); không chỉ định thì lấy ảnh mặt sau mới nhất của bộ đó.
//
// "Chuyển động" = kịch bản tay chân theo mốc giây (MOTIONS). Chuyển động 1 dựng theo video mẫu 43,3K.mp4 (3 trang phục).
// Mỗi chuyển động gồm: part1 (mở đầu cầm móc + trang phục 1, 10s) và các khối cho Part 2: `segments` (luân phiên cho trang
// phục 2, 3, 4; gốc 6s / 4s), `same` (chỉ có 1 trang phục: Part 2 tiếp tục trang phục 1, gốc 10s). Server chia 10s của Part 2
// cho các trang phục còn lại và co giãn mốc giây của khối theo thời lượng được chia. Prompt cố ý ngắn gọn: Flow từ chối
// prompt quá dài, nên mỗi mốc chỉ ghi đúng động tác tay / chân / đầu, không lặp lại ràng buộc.
// Thêm chuyển động mới = thêm 1 mục vào MOTIONS (và prompts tương ứng).
// Đây là tab NỮ của nhóm "không voice" (Chuyển động 1–5; Chuyển động 5 = đồ bộ áo + quần / váy). Tab NAM là quy trình riêng: ./video-thoi-trang-khong-voice-nam.js
// (nhiều outfit, ảnh xem trước full outfit, số phân cảnh động). Chuyển động 5 (nam) cũ chỉ còn giữ cho các LẦN CHẠY CŨ (legacy).
//
// Chỗ điền: {MODEL} = @Image1 · {OUTFIT} = tag ảnh mặt trước của bộ đang viết · {BACK} = tag ảnh mặt sau của bộ đó ·
// {OUTFITS} = các ảnh mặt trước trên móc ("@Image2, @Image4 and @Image5") · {BG} = bối cảnh · {START} = khung hình cuối Part 1
// (chỉ Part 2) · {PART} = "Part 1 of 2" / "Part 2 of 2". Thứ tự ảnh mỗi phân cảnh: Part 1 = model, trước 1, sau 1, mặt trước
// các bộ còn lại (để cầm trên móc), bối cảnh. Part 2 = model, (trước, sau) từng bộ còn lại, bối cảnh, khung hình cuối Part 1.
import fs from 'node:fs';
import path from 'node:path';
import { extractLastFrame, removeCaptionBand, colorMatchVideo } from '../ffmpeg.js';
import { DIRS, db, save } from '../db.js';
import { codeOfAsset, assignCode } from '../productCodes.js';
import { captionModeOf, cleanCaptionText, NO_TEXT_RULE } from '../caption.js';
import { FASHION_MODELS } from './video-thoi-trang.js';

const MAX_OUTFITS = 4;
const PART_SEC = 10;

// Khoá bối cảnh: mọi cú nhảy cắt giữ đúng căn phòng / ánh sáng của {BG}, chỉ đổi dáng và cỡ khung hình (Chuyển động 4 từng tự đổi
// sang phòng khác ở 1 mốc rồi quay lại).
// Khoá vóc dáng: model video hay tự "làm gọn" người mẫu (thu nhỏ vòng 1, vòng 3) -> nói thẳng phải giữ số đo và đường cong
// của {MODEL} ở mọi khung hình, trang phục ôm theo đúng cơ thể đó.
const SETUP = `{PART} of a silent {DUR} Korean try-on clip: static camera, no voice, no lip-sync, mouth closed. Caption: small white serif product code at the top-center. Face and head-to-body ratio locked 1:1 to {MODEL}. Keep her real body exactly as in {MODEL} in every frame: same bust, waist, hip and thigh size and curves; never slim, flatten or shrink the bust or hips; each garment keeps its own cut and fit on this body (loose stays loose). Background: {BG}, the same room and light in every shot; jump cuts change only her pose and framing, never the location. Left/right are the model's own.`;

// Khoá trang phục: ảnh model chỉ là tham chiếu khuôn mặt / tóc / vóc dáng. Model video hay để sót đồ cũ của KOL/KOC (cổ áo,
// tay áo, quần… lộ dưới hoặc ngoài trang phục mới, nhất là ở cú quay lưng và cận cảnh) -> nói thẳng sau match cut không còn
// mảnh nào của đồ cũ. Là 1 dòng riêng, KHÔNG sửa các mốc động tác. Cố ý không viết "wears only" để không làm mất khăn / túi / giày.
// Trước match cut các mốc vẫn ghi "plain base clothes" (đồ trơn đơn giản), không phải bộ đồ trong ảnh model.
// {CUT} = mốc match cut đầu tiên · {WEAR} = trang phục theo từng khoảng thời gian của Part 2.
// Giữ thật ngắn (≈220 ký tự): Flow từ chối prompt quá dài.
const WARDROBE = `Wardrobe: use {MODEL} for face, hair and body only, never its clothes. From {CUT}s to the end she wears {OUTFIT} (back {BACK}); no part of her earlier clothes shows under, over or beside it, back views and close-ups included.`;
const WARDROBE_PART2 = `Wardrobe: use {MODEL} for face, hair and body only, never its clothes. She wears {WEAR}; no part of the clothes in {MODEL} or of an earlier outfit shows under, over or beside it, back views and close-ups included.`;

// ---- Chuyển động 1 (theo video mẫu 43,3K: cầm móc -> khăn/túi -> quay lưng -> cận chi tiết -> kết dáng) ----
const M1_PART1 = `0.0-2.0s: Medium-wide shot. {MODEL} in plain base clothes, feet shoulder-width apart, holds the hangers of {OUTFITS} together at chest height with both hands and swings the dresses left-right twice, eyes on them, soft smile.
2.0-2.7s: Both hands lift to eye level; the left hand takes the hangers up above her head, the right hand drops to chest level.
2.7-3.5s: The left hand pushes the dresses toward the camera until the {OUTFIT} fabric fills the frame.
3.5-4.5s: Match cut, medium shot: she now wears {OUTFIT} exactly (back as {BACK}); both arms at shoulder height holding the two ends of its shawl or accent piece in a U before her chest, head tilted right, smiling, feet together.
4.5-5.3s: Jump cut: shawl draped over her shoulders; right arm relaxed holding one end, left arm out and down holding a small clutch bag at hip level, head tilted left.
5.3-6.3s: Left forearm lifts the bag to shoulder height, palm to camera; right hand touches the skirt; chin up, smile.
6.3-7.0s: Jump cut, full body: right hand on right hip, left arm down with the bag, left foot crossed in front, weight on the back leg, heels.
7.0-7.7s: Jump cut, back to camera showing {BACK}: head turned down toward her left shoulder, both arms lower slowly to her sides, bag in the left hand.
7.7-8.7s: Jump cut, medium front: shawl around the neck like a scarf, left hand holds the bag at the thigh, right hand on the right thigh, head tilted right.
8.7-9.6s: Jump cut, full body: legs crossed, both hands hold the bag together at the lower belly, still.
9.6-10.0s: Jump cut, medium front: right hand lifts the right skirt hem slightly, left hand holds the bag; sharp frame at 10.0s.`;

// Khối trang phục kế tiếp (gốc 6s): nâng túi -> toàn thân dang tay -> quay lưng -> cận chi tiết -> dang tay -> hai tay cầm túi
const M1_SEG_OUTFIT = `0.0-0.7s: Match cut, medium shot: she now wears {OUTFIT} exactly (back as {BACK}); left hand holds a small clutch bag at her left thigh, right arm relaxed, feet together, soft smile.
0.7-1.7s: Left forearm lifts the bag to shoulder height, handle hooked on open fingers; head tilts left, smile widens.
1.7-2.3s: Jump cut, full body: right arm out to the side at hip height palm down, left arm down with the bag, right foot crossed in front, weight back, heels.
2.3-3.3s: Jump cut, back to camera showing {BACK}: both arms lower slowly to her sides, hands on her thighs, head straight then slightly down to the right.
3.3-4.3s: Jump cut, close-up of the {OUTFIT} bodice and neckline from collarbone to waist, hands out of frame, still.
4.3-5.0s: Jump cut, full body front: arms slightly open with palms forward, bag in the left hand, feet together, chin down, smiling.
5.0-6.0s: Jump cut, medium front: both hands hold the bag together at the lower belly, head tilted left; sharp frame.`;

// Khối biến thể (gốc 4s): nâng vạt váy -> quay lưng -> tay bên má -> toàn thân chống hông
const M1_SEG_OUTFIT_ALT = `0.0-0.7s: Match cut, medium shot: she now wears {OUTFIT} exactly (back as {BACK}); left hand holds a small clutch bag at her left hip, right hand pinches the right skirt hem out to the side, eyes down-left at the skirt.
0.7-1.3s: She looks up at the camera smiling and sways the lifted hem once; left hand unchanged.
1.3-2.3s: Jump cut, back to camera showing {BACK}: head over her left shoulder looking down, both arms lower slowly and hold still, bag in the left hand.
2.3-3.0s: Jump cut, medium front: right hand raised beside her right cheek with fingers loosely curled, left hand holds the bag at the thigh, head tilted right, playful smile.
3.0-4.0s: Jump cut, full body front: right hand on right hip, left hand flat on the skirt near the left hip, right leg crossed in front, heels; still, gentle smile; sharp final frame.`;

// Chỉ có 1 trang phục (gốc 10s): Part 2 tiếp tục trang phục 1, không match cut
const M1_SEG_SAME = `0.0-2.0s: Same {OUTFIT} outfit, medium front: left forearm lifts the clutch bag to shoulder height, handle hooked on open fingers; right arm relaxed; head tilts left, smile widens.
2.0-4.0s: Jump cut, full body: right hand on right hip, left arm down with the bag, left foot crossed in front, weight back, heels; smiling.
4.0-6.0s: Jump cut, back to camera showing {BACK}: head over her left shoulder looking down, both arms lower slowly to her sides, bag in the left hand.
6.0-8.0s: Jump cut, close-up of the {OUTFIT} bodice and neckline from collarbone to waist, hands out of frame, still.
8.0-10.0s: Jump cut, medium front: both hands hold the bag together at the lower belly, head tilted left; sharp final frame at 10.0s.`;

// ---- Chuyển động 2 (theo video mẫu 40,5K: 1 trang phục dáng dài — giơ móc -> match cut từ sau lưng, bước ra xa ->
//      trước mặt cầm túi -> chạm dây vai -> bước tới -> quay lưng | Part 2: lưng -> trước -> nghiêng ngoái nhìn -> lưng) ----
// Chỉ dùng cho 1 trang phục (mặt trước + mặt sau) và CHỈ 1 PHÂN CẢNH (model video đã hỗ trợ tới 15s): không cắt khung
// hình cuối, không Part 2. Hai bản prompt cùng một chuyển động: 15s = đúng nhịp video mẫu; 10s = cùng trình tự, rút gọn nhịp.
const M2_15S = `0.0-1.0s: Medium-full shot. {MODEL} in plain base clothes stands left of center; her left arm is raised high holding one hanger with the long {OUTFIT} dress hanging beside her, right arm relaxed, soft smile at camera.
1.0-2.3s: Her right hand sweeps across to smooth the dress at waist height, then she pulls the dress in front of her body and steps toward the camera until its fabric fills the frame.
2.3-3.0s: Match cut, close shot from behind: she now wears {OUTFIT} exactly (back as {BACK}), back to camera, long hair down her back, arms relaxed at her sides.
3.0-4.6s: She walks slowly away from the camera with a natural hip sway, arms loose, until her full body and the trailing hem are in frame, then stops with her back to camera.
4.6-6.0s: Jump cut, full body front: both hands hold a small round handbag by its handle in front of her waist, feet together, shoulders swaying gently, smiling.
6.0-7.6s: Jump cut, medium shot: left hand raised to touch the strap at her left collarbone with curled fingers, right hand holds the bag at her right thigh, weight on one leg with the hip out, head tilted.
7.6-9.6s: Jump cut, far full-body shot: she walks three slow steps toward the camera, both hands holding the bag in front, hem flowing, then stops.
9.6-11.2s: Jump cut, full body, back to camera showing {BACK}: bag in her right hand at her side, left arm relaxed; she shifts her weight slowly from one leg to the other, head turned slightly right.
11.2-12.6s: Jump cut, front, medium-full: right hand holds the bag beside her right thigh, left hand rests on the front of her left hip, weight on the right leg, gentle smile.
12.6-14.0s: She turns into a side profile facing the right of frame and looks back over her right shoulder at the camera, bag raised to waist level in front of her, showing the full side silhouette.
14.0-15.0s: She turns fully away: back to camera showing {BACK}, hair swept forward over one shoulder to reveal the back straps, bag in her right hand, still; sharp final frame.`;

const M2_10S = `0.0-0.8s: Medium-full shot. {MODEL} in plain base clothes stands left of center; her left arm is raised high holding one hanger with the long {OUTFIT} dress hanging beside her, right arm relaxed, soft smile at camera.
0.8-1.8s: Her right hand smooths the dress at waist height, then she pulls it in front of her body and steps toward the camera until its fabric fills the frame.
1.8-3.2s: Match cut, close shot from behind: she now wears {OUTFIT} exactly (back as {BACK}), back to camera, long hair down her back; she walks slowly away with a natural hip sway until her full body and the trailing hem are in frame.
3.2-4.4s: Jump cut, full body front: both hands hold a small round handbag by its handle in front of her waist, feet together, shoulders swaying gently, smiling.
4.4-5.6s: Jump cut, medium shot: left hand touches the strap at her left collarbone with curled fingers, right hand holds the bag at her right thigh, weight on one leg with the hip out, head tilted.
5.6-7.0s: Jump cut, far full-body shot: she walks two slow steps toward the camera, both hands holding the bag in front, hem flowing, then stops.
7.0-8.0s: Jump cut, full body, back to camera showing {BACK}: bag in her right hand at her side, she shifts her weight from one leg to the other.
8.0-9.0s: She turns into a side profile facing the right of frame and looks back over her right shoulder at the camera, bag raised to waist level, showing the side silhouette.
9.0-10.0s: She turns fully away: back to camera showing {BACK}, hair swept forward over one shoulder to reveal the back straps, still; sharp final frame.`;

// ---- Chuyển động 3 (theo video mẫu 36,7K "váy đầm đi tiệc vibe tiểu thư", 16s -> lấy 15s đầu, bỏ dáng kết ở giây cuối) ----
// ĐÚNG 2 trang phục (mỗi bộ mặt trước + mặt sau), 1 PHÂN CẢNH 15s, mỗi bộ 1 túi xách nhỏ hợp với bộ đó (AI tự chọn):
// ôm 2 váy trên tay -> match cut 1.2s bộ 1: bước tới, đứng, tay chạm cằm, cận ngực-eo, hất tóc + dang tay, bước tới, hai tay
// cầm túi -> match cut 9.0s bộ 2: bước tới, hai tay cầm túi trước bụng, chống hông, cận ngực-eo, bước tới, xoay lưng ngoái nhìn.
// {OUTFIT}/{BACK} = mặt trước/sau bộ 1 · {OUTFIT2}/{BACK2} = mặt trước/sau bộ 2. Trái/phải là của người mẫu.
// Câu chữ cố ý gọn (cả prompt ≈ 3000 ký tự): Flow từ chối prompt quá dài.
const M3_15S = `Mood: elegant party-dress look, graceful ladylike moves.
0.0-1.2s: Medium-full shot. {MODEL} in plain base clothes holds {OUTFIT} and {OUTFIT2} draped over her right forearm in front of her hips, left hand smoothing them; looks down at them, then up at the camera, soft smile.
1.2-2.7s: Match cut: she now wears {OUTFIT} exactly (back as {BACK}) and walks slowly toward the camera to a medium shot, a small matching handbag in her right hand at her side.
2.7-3.7s: Jump cut, full body: stands still, bag low in her right hand, feet together, heels, gentle sway.
3.7-4.7s: Jump cut, full body: right hand holds the bag at her waist, left fingers under her chin, head tilted, smiling.
4.7-5.7s: Jump cut, close-up chin to thighs: left hand touches her collar, bag in her right hand, showing the {OUTFIT} neckline and waist.
5.7-7.0s: Jump cut, full body: left hand flips her hair back, then the left arm opens to the side, palm up; bag at her waist.
7.0-8.0s: Jump cut: walks toward the camera again, bag at her right side.
8.0-9.0s: Jump cut, full body front: both hands hold the bag before her thighs, feet together, smiling.
9.0-10.2s: Match cut: she now wears {OUTFIT2} exactly (back as {BACK2}) with a different small handbag in her right hand, walking toward the camera.
10.2-11.2s: Jump cut, medium shot: both hands hold the bag against her lower belly, shoulders slightly forward, eyes on the camera.
11.2-12.2s: Jump cut, full body: left hand on her left hip, bag low in her right hand, hip out, head tilted.
12.2-13.2s: Jump cut, close-up chin to thighs: bag tucked under her left arm, showing the {OUTFIT2} bodice and waist.
13.2-14.4s: Jump cut: walks toward the camera, bag in her right hand, hem flowing.
14.4-15.0s: Jump cut, full body turned away showing {BACK2}: looks back over her left shoulder at the camera, both hands holding the bag in front; sharp final frame.`;

// ---- Chuyển động 4 (theo video mẫu 30,5K "đầm váy phong cách quyến rũ", 13,5s -> 15s: thêm đoạn kết hai tay bye bye + hôn gió) ----
// ĐÚNG 1 trang phục (mặt trước + mặt sau), 1 PHÂN CẢNH 15s, KHÔNG có đoạn mở đầu mặc đồ thường: ngay khung hình đầu tiên
// người mẫu đã mặc trang phục sản phẩm (không match cut) -> dùng dòng Wardrobe riêng `wardrobe0`. Một ví cầm tay nhỏ do AI chọn.
// lưng ngoái nhìn -> hai tay chạm xương quai xanh -> bước tới -> đứng dồn trọng tâm 1 bên hông -> bước tới lắc hông -> xoắn tóc nháy mắt ->
// nghiêng người tay sau gáy -> 3/4 lưng ngoái nhìn -> lưng, tay luồn tóc -> cận, tay chống eo -> bước tới vén váy ->
// bước ra xa (lưng) -> bước tới -> lưng ngoái nhìn như mở đầu -> hai tay bye bye + hôn gió. Trái/phải là của người mẫu.
// Câu chữ cố ý gọn (cả prompt ≈ 3000 ký tự): Flow từ chối prompt quá dài.
// KHÔNG nhắc đồ vật / chỗ cụ thể của bối cảnh (tường, gương, cửa, ghế…): ảnh bối cảnh không có thì AI tự dựng phòng khác cho
// đúng mốc đó rồi quay lại phòng cũ (video thật: 2,2–3,0s "leans back against the wall" -> nhảy sang phòng có cột trắng).
const M4_15S = `Mood: alluring, confident evening-dress look; slow, elegant moves.
0.0-0.7s: Close three-quarter shot from behind: she already wears {OUTFIT}, showing {BACK}, right hand on her hip, head turned over her left shoulder, eyes closed then opening to the camera, smile.
0.7-1.4s: Jump cut, close front, chest up: both hands on her collarbones, fingertips at the neckline, chin down, soft smile.
1.4-2.2s: Jump cut, medium-full: walks toward the camera, small clutch low in her right hand, left hand gathering the skirt at her thigh.
2.2-3.0s: Jump cut, full body: stands with her weight on one hip, left leg stepped forward, clutch at her left hip, right hand sliding from thigh to waist.
3.0-4.7s: Jump cut: walks slowly toward the camera with a hip sway to a medium shot, clutch low in her right hand, smiling.
4.7-5.5s: Jump cut, close front: right hand twirls a lock of hair by her cheek, a wink, bright smile.
5.5-6.2s: Jump cut, full body side-on: one leg forward, one hand behind her neck, clutch low in the other, gaze down.
6.2-7.0s: Jump cut, medium three-quarter back showing {BACK}: looks back over her shoulder, eyes closed then opening to the camera.
7.0-8.0s: Jump cut, full body, back to camera showing {BACK}: left hand raised into her hair, clutch low in her right hand.
8.0-9.5s: Jump cut, close front: right hand on her waist, leans toward the camera, head tilted, eyes closed then open, playful smile.
9.5-10.5s: Jump cut, medium-full: walks toward the camera, right hand drawing the skirt aside at the thigh, then both hands hold the clutch in front.
10.5-11.7s: Jump cut, medium, back to camera showing {BACK}: walks away with a hip sway, clutch in her left hand.
11.7-12.5s: Jump cut, medium front: walks toward the camera, clutch in her right hand, smiling.
12.5-13.4s: Jump cut, close three-quarter back as in the opening: right hand on her hip, looks back over her left shoulder at the camera.
13.4-15.0s: Jump cut, medium front, clutch under her left arm: waves bye-bye with both hands, then blows a kiss with her right hand; sharp final frame.`;

// ---- Chuyển động 5 – ĐỒ BỘ (theo video mẫu 571K "Thảo Nhi Shop", 16,9s -> 15s) ----
// Kiểu "mặc đồ bộ trước máy quay": ĐÚNG 2 ảnh trang phục của CÙNG 1 BỘ — ảnh 1 = ÁO ({OUTFIT}/{BACK}), ảnh 2 = QUẦN hoặc VÁY
// ({OUTFIT2}/{BACK2}); 2 phân cảnh 7s + 8s (xem setParts bên dưới), 1 mã sản phẩm (của ảnh áo) cho cả video. Túi và giày do AI tự chọn cho hợp bộ đồ.
// Video mẫu: mặc sẵn áo + quần ngắn → thắt dây eo áo → cầm quần lên, xỏ chân mặc vào → nghiêng người chỉnh cạp → co gối buộc nơ
//   gấu quần → đứng toàn thân cười → nghiêng người, cầm túi 2 tay → chống hông khoe 3/4 lưng → cận ngực–hông, túi ở khuỷu tay →
//   quay lưng bước ra xa ngoái nhìn → quay lại bước tới → cận, 2 tay chống hông, túi treo cổ tay, cười.
// CHUYỂN ĐỘNG CHUNG cho mọi bộ: KHÔNG dùng động tác gắn với thiết kế riêng của bộ mẫu (thắt dây rút eo áo, buộc nơ gấu quần) ->
//   thay bằng dáng quyến rũ chung (vuốt tóc, tay lướt dọc thân áo, lắc vai / hông chậm, liếc qua vai, tay trượt từ đùi lên eo).
//   Món dưới là QUẦN hay VÁY thì tư thế sau khi mặc khác nhau -> 2 bản prompt, chọn theo options.bottomType.
// MẶC VÀO BẰNG ĐỘNG TÁC THẬT, LIỀN MẠCH (không cắt cảnh): 2 tay cầm cạp quần / váy mở ra trước mặt, cúi nhẹ → nhấc chân phải xỏ vào
//   ống / lòng váy, rồi chân trái → 2 tay kéo lên dọc chân, chồng lên quần short, tới eo. Bản trước dùng "bước 1 chân vào" rồi MATCH
//   CUT sang đã mặc xong -> video thật ra cảnh BIẾN HÌNH (quần tự hiện lên người) thay vì xỏ từng chân -> giờ tả từng pha theo thứ
//   tự, nói rõ "1 cú quay liên tục, không cắt" và dòng quy tắc cấm biến hình (motion.dressing).
// AN TOÀN NỘI DUNG (Flow dễ từ chối cảnh "thay đồ"): video mẫu mặc quần bảo hộ màu da trông như không mặc gì -> ở đây mở đầu mặc
//   ÁO + QUẦN SHORT GYM NỮ ÔM DÁNG ({SHORTS} = màu người dùng nhập, mặc định đỏ; tả là "fitted … biker shorts", đồ thể thao kín,
//   dài giữa đùi) và prompt nói rõ "luôn mặc đủ đồ ở mọi khung hình", quần / váy của bộ được mặc CHỒNG LÊN quần short (chỉ thêm đồ,
//   không cởi gì). Tránh các chữ: undress, strip, bare, tight, sexy, underwear, lingerie, changing clothes.
// GIÀY / TÚI: lúc đang mặc quần / váy nhân vật CHÂN TRẦN, không túi (video thử từng mang guốc rồi mới xỏ quần) -> mốc mở đầu và
//   cú xỏ chân ghi "barefoot", mặc xong (M5SET_CUT) mới "now in simple shoes" và cầm túi; dòng Wardrobe nhắc lại.
// Lần thử 2: có co từng gối nhưng quần vẫn được cầm ngang HÔNG, buông che trước chân -> giờ "cúi người, cạp sát ỐNG CHÂN, quần gom
//   trên sàn", nhắc "vẫn cúi / cạp vẫn thấp" ở 2 mốc xỏ chân, quy tắc "cạp ở thấp tới khi xỏ xong 2 chân"; giày nhắc ngay đầu mốc 7,2s
//   (lần thử 2 giày tới 9,5s mới có).
// Lần thử 3: xỏ từng chân đã đúng nhưng ~0,5s đầu mốc 1,8s quần hiện sẵn ở hông rồi mới kéo xuống ống chân (AI cần trạng thái mở
//   đầu) -> mốc 1,8s mở bằng "quần gấp trên sàn, cúi nhặt lên theo cạp". Áo / quần bị đổi form (áo suông tay loe -> áo ôm ngắn, cạp
//   chun -> cạp phẳng) -> dòng Wardrobe khoá chất liệu, độ bóng, form, độ dài, kiểu tay, cạp, cúc; phần mở đầu chung bỏ câu "fitted
//   to this body" (bị hiểu là may ôm theo người) thay bằng "giữ đúng form của trang phục".
// Lần thử 4: hết lỗi quần ở sẵn hông, áo đúng form lúc đầu, nhưng (1) câu "quần gấp trên sàn, cúi nhặt lên" làm AI vẽ 2 CHIẾC QUẦN
//   (1 chiếc vẫn nằm trên sàn), (2) sau khi mặc xong quần thành ôm cạp cao, áo gọn lại — mô hình phải vừa diễn cảnh mặc đồ dài vừa
//   giữ đúng 2 món đồ trong 15s, prompt sát giới hạn 3.360 ký tự.
// => TÁCH 2 PHÂN CẢNH (tổng 15s): Part 1 = 7s chỉ có đoạn mặc (prompt ngắn, tả kỹ), Part 2 = 8s chỉ có đoạn khoe dáng, mở bằng KHUNG
//   HÌNH CUỐI của Part 1 và nhận lại ảnh áo + quần để khoá form lại từ đầu (setParts; luồng 2 phân cảnh có sẵn: part1 → last_frame
//   → part2 → ghép).
//   Đoạn mở đầu rút còn 0,6s (người dùng: "0–0,5s đứng khoe xong là bắt đầu mặc"). Quần ĐÃ CẦM SẴN TRONG TAY từ khung hình đầu
//   (không cắt cảnh, không để trên sàn) -> chỉ có 1 chiếc quần, AI không phải tự dựng trạng thái mở đầu cho cú mặc.
//   Khớp 2 phân cảnh: Part 1 kết bằng dáng đứng thẳng nhìn máy quay, chân trần (đúng trạng thái Part 2 mở ra); Part 2 mở "đúng
//   khung hình cuối Part 1: cùng khuôn mặt, tóc, ánh sáng, độ sáng, cân bằng trắng, tông màu, giữ nguyên tới hết" và cú nhảy cắt
//   đầu tiên của Part 2 (0,8s, lúc mang giày + cầm túi) che chỗ nối; khuôn mặt khoá lại theo ảnh model ở cả 2 phần.
// Lần thử 2 phân cảnh đầu: ánh sáng / màu ở chỗ nối khớp (chênh < 0,5%), nhưng Part 2 KHÔNG mở đúng dáng khung hình cuối (nhảy dáng),
//   áo Part 1 bó hơn ảnh gốc (AI bám theo áo thun ôm trong ảnh model), giày tới ~4,5s Part 2 mới có -> Part 2 mở như 1 cú cắt cảnh
//   mới (khung hình cuối chỉ là mẫu khuôn mặt / ánh sáng / màu), đã mang giày + cầm túi từ khung hình đầu; Wardrobe Part 1 thêm "form
//   áo chỉ lấy từ ảnh áo, không theo áo bó trong ảnh model"; mốc 0,6s nhắc "không cầm ngang hông trước khi xỏ xong 2 chân".
// M5SET_CUT = giây (trong Part 1) quần / váy đã kéo lên tới eo (từ đó quần short không còn lộ).
const M5SET_CUT = 5.4;
export const M5SET_PART_DURATIONS = ['7s', '8s'];
// Part 1 (7s): đoạn mặc, 1 cảnh liền. Váy không có ống: xỏ chân vào lòng váy. Theo yêu cầu người dùng: CHÂN TRÁI nhấc cao (gối
//   ngang hông) xỏ vào ống trái → bàn chân trượt xuống, ló ra ở gấu, đặt phẳng xuống sàn → CHÂN PHẢI tương tự → mới kéo lên eo; mỗi pha 1
//   mốc riêng, cạp giữ ở ngang gối tới khi xỏ xong 2 chân (lần thử trước: cầm ngang hông ~1s, 2 cú nhấc chân không rõ).
// Lần thử cảnh 1 với "hạ cạp xuống ngang gối": AI VẪN cầm quần ngang HÔNG, ống quần buông che trước chân (lần thứ 3 bỏ qua câu hạ
//   thấp -> thói quen cứng của mô hình) -> giờ THUẬN theo: cầm cạp mở rộng trước hông, ống quần rỗng buông tới sàn trước chân, rồi
//   nhấc GỐI CAO QUA CẠP và thả bàn chân xuống trong ống quần (chân trái rồi chân phải), mới kéo lên eo.
// Lần thử "gối cao qua cạp": chân thứ nhất xỏ rõ, nhưng chân thứ 2 không xỏ (AI nhấc lại chính chân đã ở trong). Người dùng chỉ rõ:
//   cầm quần ngang hông thì dù nhấc chân cao cũng không mặc được -> phải CÚI NGƯỜI, HẠ CẠP XUỐNG DƯỚI GỐI rồi mới xỏ từng chân, xỏ
//   xong cả 2 chân mới kéo lên hông, buông cạp, rồi 2 tay kéo vạt áo xuống ra ngoài (tránh áo bị nhét / phồng trong quần). Mỗi động
//   tác 1 mốc; trong 2 mốc xỏ chân nhắc lại "vẫn cúi, 2 tay vẫn dưới gối"; chân gọi theo vị trí trên khung hình, chân thứ 2 ghi rõ
//   "chân KIA, vẫn ở ngoài". Áo kết thúc thả ngoài quần (Wardrobe 2 phân cảnh).
const m5setPart1 = (k) => {
  const pants = k === 'pants';
  // Chân gọi theo VỊ TRÍ TRÊN KHUNG HÌNH (video thử: AI hiểu "left" là bên trái khung hình, xỏ nhầm chân / nhấc 1 chân 2 lần)
  const into = pants ? 'the trouser leg on that side, pushing it down until the foot comes out at the hem' : 'the skirt, inside the waistband';
  return [
    'Mood: graceful and unhurried; she is fully dressed in every frame.',
    `0.0-0.6s: Full body front, feet visible: she wears {OUTFIT} with the {SHORTS} gym shorts, barefoot, the folded {OUTFIT2} in one hand at her side; a quick smile.`,
    `0.6-1.2s: Same shot, continuous: she shakes {OUTFIT2} open and holds its waistband open with both hands in front of her hips, ${pants ? 'the trouser legs' : 'the skirt'} hanging down.`,
    `1.2-2.0s: Same shot, continuous: she bends deeply forward, knees bent, and lowers the open waistband all the way down to mid-shin, hands just above her ankles, ${pants ? 'the trouser legs' : 'the hem'} gathered on the floor in front of her feet, head down watching.`,
    `2.0-3.2s: Same shot, continuous, still bent with the waistband at mid-shin: she draws the knee on the left side of the frame up high toward her chest, lifts that foot above the waistband, then steps it into ${into} and sets it on the floor.`,
    `3.2-4.4s: Same shot, continuous, waistband still at mid-shin: she draws the OTHER knee, on the right side of the frame, up high toward her chest, lifts that foot (still outside) above the waistband, then steps it into ${into} and sets it down; both legs are now in.`,
    `4.4-5.4s: Same shot, continuous: only now she straightens up, both hands pulling {OUTFIT2} up her legs over the shorts to her waist${pants ? '' : ', the hem falling into place'}; the shorts are fully covered.`,
    `5.4-6.2s: Same shot: she lets go of the waistband, then both hands take the hem of {OUTFIT} at her sides and pull it down and out so it hangs loose over the waistband, untucked.`,
    `6.2-7.0s: Same shot: she stands upright facing the camera, arms relaxed, soft smile.`,
  ].join('\n');
};
// Part 2 (8s): khoe dáng, mở bằng khung hình cuối Part 1
const m5setPart2 = (k) => [
  'Mood: graceful and alluring; slow elegant poses.',
  k === 'pants'
    ? '0.0-1.8s: Full body front, simple shoes that suit the set on her feet, a small handbag in one hand: other hand on her hip, a light sway, bright smile.'
    : '0.0-1.8s: Full body front, simple shoes that suit the set on her feet, a small handbag in one hand: a light swish of the hem, bright smile.',
  '1.8-3.6s: Jump cut, full body: she turns slowly to show {BACK} and {BACK2}, hand on hip, looking back over her shoulder.',
  '3.6-5.0s: Jump cut: she turns back to front, a soft hip sway, chin tilted.',
  '5.0-6.5s: Jump cut, close-up chin to hips: bag on her forearm, showing the top.',
  '6.5-8.0s: Jump cut, medium close: hands on hips, bag on her wrist, big smile.',
].join('\n');
const M5SET_P1_PANTS = m5setPart1('pants');
const M5SET_P1_SKIRT = m5setPart1('skirt');
const M5SET_P2_PANTS = m5setPart2('pants');
const M5SET_P2_SKIRT = m5setPart2('skirt');

// Màu quần short gym lúc mở đầu (options.shortsColor, người dùng gõ tiếng Việt hoặc tiếng Anh): đổi tên màu tiếng Việt thường gặp
// sang tiếng Anh, còn lại giữ nguyên chữ đã làm sạch (chỉ chữ cái / khoảng trắng, tối đa 30 ký tự); để trống = đỏ.
const VI_COLORS = [
  ['xanh la', 'green'], ['xanh duong', 'blue'], ['xanh navy', 'navy blue'], ['xanh den', 'navy blue'], ['xanh reu', 'olive green'],
  ['xanh ngoc', 'teal'], ['xanh', 'blue'], ['do do', 'burgundy'], ['do', 'red'], ['den', 'black'], ['trang', 'white'], ['hong', 'pink'],
  ['xam', 'grey'], ['ghi', 'grey'], ['be', 'beige'], ['kem', 'cream'], ['nau', 'brown'], ['tim', 'purple'], ['vang', 'yellow'], ['cam', 'orange'],
];
export function shortsColorOf(v) {
  const raw = String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 30);
  if (!raw) return 'red';
  let out = raw;
  for (const [vi, en] of VI_COLORS) {
    const re = new RegExp(`\\b${vi}\\b`);
    if (re.test(out)) { out = out.replace(re, en); break; }
  }
  return out.replace(/\b(mau|quan|short|shorts|gym)\b/g, ' ').replace(/\s+/g, ' ').trim() || 'red';
}

// Dòng Wardrobe cho chuyển động ĐỒ BỘ (Chuyển động 5), Part 1: {OUTFIT}/{BACK} = áo, {OUTFIT2}/{BACK2} = quần hoặc váy của cùng bộ,
// {SHORTS} = màu quần short gym, {CUT} = giây đã kéo quần / váy lên eo. Nói rõ quần short là đồ thể thao kín đáo, chỉ có 1 chiếc quần
// (cầm sẵn từ khung hình đầu) và khoá chất liệu / form / chi tiết của cả 2 món.
const WARDROBE_SET = `Wardrobe: use {MODEL} for face, hair and body only, never its clothes. {OUTFIT} (back {BACK}) is the top and {OUTFIT2} (back {BACK2}) is the bottom of one matching set, each copied exactly in every frame: same fabric and sheen, colour, fit and silhouette, length, sleeve shape, waistband, buttons and trims; never restyled or made tighter; the top's shape comes only from {OUTFIT}, never from the fitted shirt in {MODEL}, and it ends worn loose outside the bottom, never tucked in. She wears the top with plain {SHORTS} fitted women's gym shorts (opaque athletic biker shorts, mid-thigh), barefoot, no bag. There is only one {OUTFIT2}: she holds it from the first frame and pulls it on over the shorts; from {CUT}s it covers them. No clothes from {MODEL} ever show.`;
// Part 2: mặc đủ bộ, form chép từ ẢNH SẢN PHẨM (không theo khung hình cuối {START}, phòng khi Part 1 lệch form); giày + túi từ khung hình đầu
const WARDROBE_SET2 = `Wardrobe: use {MODEL} for face, hair and body only, never its clothes. She wears {OUTFIT} (back {BACK}) with {OUTFIT2} (back {BACK2}), both copied exactly from these photos, not from {START}: same fabric and sheen, colour, fit and silhouette, length, sleeve shape, waistband, buttons and trims; never restyled or made tighter; the top hangs loose outside the bottom, never tucked in; no gym shorts show. From the first frame she wears simple shoes that suit the set and holds a small handbag.`;

// Dòng Wardrobe cho chuyển động KHÔNG có đoạn mặc đồ thường (Chuyển động 4): mặc sản phẩm ngay từ khung hình đầu tiên
const WARDROBE_WORN =`Wardrobe: use {MODEL} for face, hair and body only, never its clothes. From the very first frame to the end she wears {OUTFIT} exactly (back {BACK}); no part of the clothes in {MODEL} shows under, over or beside it, back views and close-ups included.`;

// ---- Chuyển động 5 – NAM (theo video mẫu e4553e40: lookbook đường phố 10s, nhiều cảnh nhảy cắt ở các góc khác nhau) ----
// ĐÚNG 1 trang phục (mặt trước + mặt sau), 1 PHÂN CẢNH, mặc sẵn từ khung hình đầu (không match cut). Nhân vật NAM nên dùng
// phần mở đầu / khoá trang phục / dòng quy tắc bản nam (setup_male, wardrobe_male, rule_male: "he", khoá vóc dáng nam).
// Video mẫu có mũ lưỡi trai + ba lô đen -> dòng khoá trang phục nam dặn giữ 2 phụ kiện này giống nhau ở mọi cảnh.
// Video mẫu đổi chỗ liên tục (đường, mép đường, lan can, cột, gốc cây): prompt viết chung chung "các chỗ khác nhau của
// cùng bối cảnh {BG}" (lối đi, gờ thấp / bậc để ngồi, cột / tường để tựa) để hợp với mọi ảnh bối cảnh.
// Mốc giây: bản 10s đúng nhịp video mẫu; bản 15s cùng trình tự, mỗi mốc dài gấp 1.5.
export const M5_BEATS = [
  [0.0, 2.0, 'Medium-full shot on the path: he walks slowly toward the camera with a relaxed swagger, right hand tipping his cap brim then sliding into his pocket, shoulders swaying, playful smile.'],
  [2.0, 2.6, 'Jump cut, full body: mid-step he crosses one leg in front, right hand on top of his cap, grinning at the camera.'],
  [2.6, 3.2, 'Jump cut, medium: both hands pull the cap down by its sides, head bowed, then he peeks up.'],
  [3.2, 3.7, 'Jump cut, low angle: sits on a low ledge, knees up, backpack beside him, right hand flashes a peace sign, left palm open toward the camera.'],
  [3.7, 4.2, 'Jump cut, full body walking: left hand on his cap, one leg kicked forward.'],
  [4.2, 4.7, 'Jump cut, medium: sits sideways on a railing or ledge, big smile, right hand on the backpack strap at his chest.'],
  [4.7, 5.5, 'Jump cut, full body: leans one shoulder on a post, hands loose at his chest, nodding at the camera.'],
  [5.5, 6.0, 'Jump cut, close: crouches low, forearms on his knees, hands clasped, eyes on the camera.'],
  [6.0, 6.5, 'Jump cut, wide: stands still in the middle of the path, cap held in his right hand, the other hand on the backpack strap.'],
  [6.5, 7.2, 'Jump cut, low: sits on the ledge, legs stretched forward, right hand raised near his chin in a cool hand sign.'],
  [7.2, 7.7, 'Jump cut, wide front: stands centered, feet apart, one hand gesturing loosely.'],
  [7.7, 8.2, 'Jump cut, medium: sits on the railing, head lowered, hands resting on his knees.'],
  [8.2, 9.2, 'Jump cut, wide front: stands under the trees, both hands gesturing naturally, relaxed smile.'],
  [9.2, 10.0, 'Jump cut, low: sits on the ledge, head down, hands on his knees, a shy smile toward the ground; sharp final frame.'],
];
const m5Text = (k) => ['Mood: easy-going Korean streetwear lookbook, playful and cool.']
  .concat(M5_BEATS.map(([a, b, t]) => `${(a * k).toFixed(1)}-${(b * k).toFixed(1)}s: ${t}`))
  .join('\n');
const M5_10S = m5Text(1);
const M5_15S = m5Text(1.5);

// Bản NAM của phần mở đầu / khoá trang phục (mặc sẵn) / dòng quy tắc: "he", khoá vóc dáng nam, phụ kiện mũ + ba lô
export const SETUP_MALE = `{PART} of a silent {DUR} Korean menswear lookbook clip: static camera, no voice, no lip-sync, mouth closed. Caption: small white serif product code at the top-center. Face, hairstyle and head-to-body ratio locked 1:1 to {MODEL}. Keep his real body exactly as in {MODEL} in every frame: same height, shoulder width, chest, waist and leg proportions; never slim, bulk up or reshape him; the outfit is fitted to this body. Background: {BG}; each jump cut is a different spot of this same place (the path, a low ledge to sit on, a post or wall to lean on, under trees) with the same light. Left/right are the model's own.`;
const WARDROBE_MALE = `Wardrobe: use {MODEL} for face, hair and body only, never its clothes. From the very first frame to the end he wears {OUTFIT} exactly (back {BACK}); no part of the clothes in {MODEL} shows under, over or beside it, back and side views included. Accessories in every shot: a casual cap (the one in {OUTFIT} if it has one, otherwise a plain cap) and a black backpack, both identical throughout.`;
export const RULE_MALE = `Jump cuts are instant cuts; the camera never moves within a shot. The cap and backpack stay consistent and never hide the outfit. Natural hands, relaxed natural motion, no text except the caption.`;

const COMMON_RULE = `Jump cuts are instant cuts; the camera never moves. One small bag per outfit, kept consistent, never hiding the garment. Natural hands, smooth motion, no text except the caption.`;

export const MOTIONS = {
  motion1: {
    name: 'Chuyển động 1 – cầm móc → khăn/túi → quay lưng → cận chi tiết → kết dáng (theo video mẫu)',
    prompts: {
      m1_part1: { label: 'Chuyển động 1 · Part 1 (0–10s): mở đầu cầm móc + trang phục 1 ({OUTFIT}/{BACK} = mặt trước/sau bộ 1)', text: M1_PART1 },
      m1_seg_outfit: { label: 'Chuyển động 1 · Khối trang phục kế tiếp (gốc 6s, tự co giãn theo thời lượng được chia)', text: M1_SEG_OUTFIT },
      m1_seg_outfit_alt: { label: 'Chuyển động 1 · Khối biến thể cho trang phục kế tiếp (gốc 4s)', text: M1_SEG_OUTFIT_ALT },
      m1_seg_same: { label: 'Chuyển động 1 · Khi chỉ có 1 trang phục: Part 2 tiếp tục trang phục 1 (gốc 10s)', text: M1_SEG_SAME },
    },
    part1: 'm1_part1',
    cutAt: 3.5, // mốc match cut đầu tiên trong Part 1
    segments: ['m1_seg_outfit', 'm1_seg_outfit_alt'], // luân phiên cho trang phục 2, 3, 4…
    same: 'm1_seg_same',
  },
  motion2: {
    name: 'Chuyển động 2 – 1 trang phục, 1 phân cảnh (15s hoặc 10s): giơ móc → bước ra xa (lưng) → cầm túi → chạm dây vai → bước tới → lưng → nghiêng ngoái nhìn → lưng',
    prompts: {
      m2_15s: { label: 'Chuyển động 2 · bản 15s (1 phân cảnh, đúng nhịp video mẫu; {OUTFIT}/{BACK} = mặt trước/sau)', text: M2_15S },
      m2_10s: { label: 'Chuyển động 2 · bản 10s (1 phân cảnh, cùng trình tự động tác, nhịp rút gọn)', text: M2_10S },
    },
    single: true, // 1 phân cảnh duy nhất: không cắt khung hình cuối, không Part 2
    durations: { '15s': { prompt: 'm2_15s', cutAt: 2.3 }, '10s': { prompt: 'm2_10s', cutAt: 1.8 } },
    maxOutfits: 1,
  },
  motion3: {
    name: 'Chuyển động 3 – ĐÚNG 2 trang phục, 1 phân cảnh 15s (đầm đi tiệc vibe tiểu thư, có túi xách): ôm 2 váy → bộ 1: bước tới, chạm cằm, cận, hất tóc → bộ 2: cầm túi, chống hông, cận, xoay lưng ngoái nhìn',
    prompts: {
      m3_15s: { label: 'Chuyển động 3 · 15s (1 phân cảnh, 2 trang phục: {OUTFIT}/{BACK} = mặt trước/sau bộ 1, {OUTFIT2}/{BACK2} = bộ 2; đổi đồ ở 1.2s và 9.0s)', text: M3_15S },
    },
    single: true,
    // cuts[i] = mốc match cut bắt đầu mặc bộ thứ i+1 (caption / dòng Wardrobe đổi theo đúng các mốc này)
    durations: { '15s': { prompt: 'm3_15s', cutAt: 1.2, cuts: [1.2, 9.0] } },
    minOutfits: 2,
    maxOutfits: 2,
  },
  motion4: {
    name: 'Chuyển động 4 – ĐÚNG 1 trang phục, 1 phân cảnh 15s (đầm váy phong cách quyến rũ, mặc sẵn từ giây đầu, có ví cầm tay): lưng ngoái nhìn → chạm cổ → bước tới → tựa tường → xoắn tóc nháy mắt → quay lưng → bước ra xa → bye bye + hôn gió',
    prompts: {
      m4_15s: { label: 'Chuyển động 4 · 15s (1 phân cảnh, 1 trang phục mặc sẵn từ khung hình đầu: {OUTFIT}/{BACK} = mặt trước/sau; kết bằng hai tay bye bye + hôn gió)', text: M4_15S },
    },
    single: true,
    // cuts rỗng = không có match cut đổi đồ: người mẫu mặc sản phẩm ngay từ 0.0s (dòng Wardrobe dùng bản `wardrobe0`)
    durations: { '15s': { prompt: 'm4_15s', cuts: [] } },
    minOutfits: 1,
    maxOutfits: 1,
  },
  // Khoá 'motion5set' (không dùng 'motion5': đó là Chuyển động 5 nam cũ, chỉ còn cho lần chạy cũ)
  motion5set: {
    name: 'Chuyển động 5 – ĐỒ BỘ: ĐÚNG 2 ảnh của cùng 1 bộ (ảnh 1 = ÁO, ảnh 2 = QUẦN hoặc VÁY), 2 phân cảnh 7s + 8s = 15s, túi + giày AI tự chọn: (P1) mặc áo + quần short gym nữ, cầm sẵn quần / váy → cúi cầm cạp thấp ngang ống chân → xỏ chân phải → xỏ chân trái → kéo lên eo → (P2) mang giày cầm túi, tay chống hông → xoay sau khoe mặt sau → xoay lại → cận → 2 tay chống hông',
    prompts: {
      m5set_p1_pants: { label: 'Chuyển động 5 (đồ bộ) · Phân cảnh 1 (7s) bản QUẦN: mặc quần ({OUTFIT}/{BACK} = áo, {OUTFIT2}/{BACK2} = quần, {SHORTS} = màu quần short gym)', text: M5SET_P1_PANTS },
      m5set_p1_skirt: { label: 'Chuyển động 5 (đồ bộ) · Phân cảnh 1 (7s) bản VÁY: mặc váy', text: M5SET_P1_SKIRT },
      m5set_p2_pants: { label: 'Chuyển động 5 (đồ bộ) · Phân cảnh 2 (8s) bản QUẦN: khoe dáng, mở bằng khung hình cuối phân cảnh 1', text: M5SET_P2_PANTS },
      m5set_p2_skirt: { label: 'Chuyển động 5 (đồ bộ) · Phân cảnh 2 (8s) bản VÁY: khoe dáng', text: M5SET_P2_SKIRT },
    },
    // set: 2 ảnh là 2 MÓN của cùng 1 bộ mặc cùng lúc (không phải 2 bộ mặc lần lượt): 1 chữ / mã cho cả video (của ảnh áo)
    set: true,
    // setParts: 2 phân cảnh riêng của đồ bộ (buildSetParts) — durations[i] = thời lượng Flow của phân cảnh i+1; p1 / p2 = khoá prompt
    // theo options.bottomType; cut = giây đã mặc xong trong Part 1
    setParts: { durations: M5SET_PART_DURATIONS, p1: { pants: 'm5set_p1_pants', skirt: 'm5set_p1_skirt' }, p2: { pants: 'm5set_p2_pants', skirt: 'm5set_p2_skirt' }, cut: M5SET_CUT },
    outfitLabels: ['Áo', 'Quần / váy'],
    // Ô "Thời lượng" chỉ hiện "15s" (tổng 2 phân cảnh)
    durations: { '15s': {} },
    minOutfits: 2,
    maxOutfits: 2,
  },
  motion5: {
    name: 'Chuyển động 5 – NAM, ĐÚNG 1 trang phục, 1 phân cảnh 10s hoặc 15s (lookbook đường phố, mặc sẵn từ giây đầu, mũ + ba lô): bước tới chỉnh mũ → kéo mũ cúi đầu → ngồi gờ giơ chữ V → ngồi lan can → tựa cột → ngồi xổm → đứng giữa đường → ngồi gờ cúi đầu cười',
    prompts: {
      m5_10s: { label: 'Chuyển động 5 (nam) · 10s (đúng nhịp video mẫu; mặc sẵn từ khung hình đầu: {OUTFIT}/{BACK} = mặt trước/sau)', text: M5_10S },
      m5_15s: { label: 'Chuyển động 5 (nam) · 15s (cùng trình tự, mỗi mốc dài gấp 1.5)', text: M5_15S },
    },
    single: true,
    male: true, // dùng setup_male / wardrobe_male / rule_male
    // Chỉ giữ cho lần chạy cũ: không còn trong ô chọn / prompt mẫu của tab Nữ (tab Nam dùng quy trình riêng)
    legacy: true,
    durations: { '15s': { prompt: 'm5_15s', cuts: [] }, '10s': { prompt: 'm5_10s', cuts: [] } },
    minOutfits: 1,
    maxOutfits: 1,
  },
};
export const SINGLE_DURATIONS = ['15s', '10s'];
const isSingle = (run) => !!(MOTIONS[run.options.motion] || MOTIONS[DEFAULT_MOTION]).single;
// Thời lượng của chuyển động 1 phân cảnh: lựa chọn của người dùng nếu chuyển động đó có bản ấy, không thì bản đầu tiên nó có
const singleDuration = (run) => {
  const own = Object.keys(motionOf(run).durations || {});
  return own.includes(run.options.duration) ? run.options.duration : own[0] || SINGLE_DURATIONS[0];
};
const DEFAULT_MOTION = 'motion1';
const motionOf = (run) => MOTIONS[run.options.motion] || MOTIONS[DEFAULT_MOTION];
// Số trang phục chuyển động yêu cầu: "đúng 2", "1", hoặc "1–4"
const outfitCountError = (motion, n) => {
  const min = motion.minOutfits || 1;
  const max = motion.maxOutfits || MAX_OUTFITS;
  if (n >= min && n <= max) return null;
  const need = min === max ? `đúng ${min}` : `${min}–${max}`;
  return `"${motion.name.split(' – ')[0]}" cần ${need} trang phục (đang chọn ${n}) — ${n > max ? 'bỏ bớt' : 'chọn thêm'} trang phục hoặc đổi sang chuyển động khác`;
};

export const fmtT = (t) => (Math.round(t * 10) / 10).toFixed(1);
export const fill = (text, vars) => text.replace(/\{(MODEL|OUTFITS|OUTFIT2|OUTFIT|BACK2|BACK|CODE|BG|START|PART|DUR|CUT|WEAR|SHORTS)\}/g, (m, k) => (vars[k] != null ? vars[k] : m));

// Chữ trên video (../caption.js): 'code' = mã sản phẩm (mặc định) · 'text' = chữ tuỳ ý · 'none' = không chữ.
// Prompt mẫu viết cho chế độ mã -> đổi đúng câu về chữ trong phần mở đầu / dòng quy tắc, không đụng mốc động tác.
const CAPTION_SENTENCE = /Caption:[^.]*\./;
export function setupFor(setup, mode) {
  if (mode === 'code') return setup;
  const sentence = mode === 'text' ? 'Caption: small white serif text at the top-center.' : NO_TEXT_RULE;
  return CAPTION_SENTENCE.test(setup) ? setup.replace(CAPTION_SENTENCE, sentence) : `${setup} ${sentence}`;
}
export const ruleFor = (rule, mode) => (mode === 'none' ? rule.replace(/,?\s*no text except the caption/i, ', no on-screen text at all') : rule);
const captionLine = (o, mode) => (mode === 'none' ? null : `Caption: "${o.caption}" for the whole clip.`);

/**
 * Prompt cho chuyển động 1 phân cảnh (motion.single): cả video trong 1 lần tạo, thời lượng '15s' | '10s' chọn bản prompt
 * tương ứng (cùng chuyển động, khác nhịp). outfits = [{ caption, p1: { front, back } }] — 1 bộ (Chuyển động 2) hoặc nhiều bộ
 * mặc lần lượt trong cùng 1 video (Chuyển động 3: bộ thứ i bắt đầu ở mốc match cut d.cuts[i], caption đổi theo đúng mốc đó).
 */
export function buildSinglePrompt({ motion, prompt, outfit, outfits = outfit ? [outfit] : [], tags, duration, captionMode = 'code', variant = null, shorts = null }) {
  const d = motion.durations[duration] || Object.values(motion.durations)[0];
  const total = parseFloat(duration);
  const cuts = d.cuts || [d.cutAt];
  const [first, second] = outfits;
  // Chuyển động cho nhân vật nam: phần mở đầu / quy tắc bản nam
  const setup = setupFor((motion.male ? prompt('setup_male') || SETUP_MALE : prompt('setup') || SETUP).trim(), captionMode);
  const rule = ruleFor((motion.male ? prompt('rule_male') || RULE_MALE : prompt('rule') ?? COMMON_RULE).trim(), captionMode);
  const vars = {
    MODEL: '@Image1', BG: tags.p1.bg, OUTFITS: listTags(outfits.map((o) => o.p1.front)),
    OUTFIT: first.p1.front, BACK: first.p1.back, OUTFIT2: second?.p1.front, BACK2: second?.p1.back,
    CODE: first.caption || '', PART: 'One continuous take', DUR: duration, CUT: fmtT(cuts[0] ?? 0),
    SHORTS: shortsColorOf(shorts), // màu quần short gym (đồ bộ)
  };
  // Bản prompt theo biến thể (đồ bộ: quần / váy)
  const beatsKey = (variant && d.variants?.[variant]) || d.prompt;
  const worn = cuts.length === 0; // mặc sản phẩm ngay từ khung hình đầu, không có match cut đổi đồ
  // Đồ bộ (motion.set): 2 ảnh là áo + quần / váy mặc cùng lúc -> 1 chữ cho cả video, dòng Wardrobe riêng (không phải 2 bộ lần lượt)
  const isSet = !!motion.set;
  const multi = outfits.length > 1 && !isSet;
  const endOf = (i) => (i + 1 < outfits.length ? cuts[i + 1] : total);
  // Nhiều bộ: caption đổi đúng ở mỗi match cut (bộ 1 hiện từ 0.0s, kể cả đoạn mở đầu); dòng Wardrobe ghi bộ nào mặc lúc nào
  const caption = captionMode === 'none' ? null : multi
    ? 'Caption: ' + outfits.map((o, i) => `${fmtT(i === 0 ? 0 : cuts[i])}-${fmtT(endOf(i))}s "${o.caption}"`).join('; ') + ' (switches exactly on the match cut).'
    : captionLine(first, captionMode);
  const wardrobe = isSet
    ? fill((prompt('wardrobe_set') || WARDROBE_SET).trim(), vars)
    : multi
    ? fill((prompt('wardrobe2') || WARDROBE_PART2).trim(), { ...vars, WEAR: outfits.map((o, i) => `${o.p1.front} (back ${o.p1.back}) at ${fmtT(cuts[i])}-${fmtT(endOf(i))}s`).join(', then ') })
    : worn
      ? fill((motion.male ? prompt('wardrobe_male') || WARDROBE_MALE : prompt('wardrobe0') || WARDROBE_WORN).trim(), vars)
      : fill((prompt('wardrobe') || WARDROBE).trim(), vars);
  const cutNote = worn
    ? ''
    : motion.dressing
      ? ` The ${variant === 'skirt' ? 'skirt' : 'trousers'} go on only by her real hand and leg moves, one foot at a time; the waistband stays low until both feet are in: no morph or sudden appearance.`
      : ` Clean match cut${cuts.length > 1 ? 's' : ''} at ${cuts.map((c) => `${fmtT(c)}s`).join(' and ')}.`;
  return [
    fill(setup, vars),
    caption,
    wardrobe,
    fill(prompt(beatsKey) || motion.prompts[beatsKey]?.text || '', vars),
    `${rule}${cutNote} Sharp final frame at ${fmtT(total)}s.`.trim(),
  ].filter(Boolean).join('\n');
}
/**
 * Prompt 2 phân cảnh của chuyển động ĐỒ BỘ (motion.setParts, Chuyển động 5). outfits = [áo, quần / váy] với tag ảnh theo từng phân
 * cảnh (p1, p2 — xem prepare) · tags = { p1: { bg }, p2: { bg, start } } · variant = 'pants' | 'skirt' · shorts = màu quần short gym.
 * Part 1: mặc quần / váy (1 cảnh liền), kết bằng dáng đứng thẳng nhìn máy quay. Part 2: mở ĐÚNG khung hình cuối Part 1, giữ nguyên
 * khuôn mặt / ánh sáng / màu, nhận lại ảnh 2 món để khoá form, rồi khoe dáng. Cả video 1 chữ / mã (của ảnh áo).
 */
export function buildSetParts({ motion, prompt, outfits, tags, captionMode = 'code', variant = 'pants', shorts = null }) {
  const sp = motion.setParts;
  const kind = sp.p1[variant] ? variant : 'pants';
  const [top, bottom] = outfits;
  const [d1, d2] = sp.durations;
  const caption = captionMode === 'none' ? null : top.caption;
  const setup = setupFor((prompt('setup') || SETUP).trim(), captionMode);
  const rule = ruleFor((prompt('rule') ?? COMMON_RULE).trim(), captionMode);
  const piece = kind === 'skirt' ? 'skirt goes' : 'trousers go';
  const v1 = {
    MODEL: '@Image1', BG: tags.p1.bg, PART: 'Part 1 of 2', DUR: d1, CUT: fmtT(sp.cut), SHORTS: shortsColorOf(shorts),
    OUTFIT: top.p1.front, BACK: top.p1.back, OUTFIT2: bottom.p1.front, BACK2: bottom.p1.back,
  };
  const start = tags.p2.start;
  const v2 = {
    MODEL: '@Image1', BG: tags.p2.bg, PART: 'Part 2 of 2', DUR: d2, START: start, SHORTS: v1.SHORTS,
    OUTFIT: top.p2.front, BACK: top.p2.back, OUTFIT2: bottom.p2.front, BACK2: bottom.p2.back,
  };
  const capLine = caption ? `Caption: "${caption}" for the whole clip.` : null;
  const part1 = [
    // Part 1 gọi chân theo vị trí trên khung hình và không có cú cắt cảnh: bỏ câu "Left/right are the model's own"
    fill(setup, v1).replace(/\s*Left\/right are the model's own\./, '').replace(/; jump cuts change only her pose and framing, never the location\./, '.'),
    capLine,
    fill((prompt('wardrobe_set') || WARDROBE_SET).trim(), v1),
    fill(prompt(sp.p1[kind]) || motion.prompts[sp.p1[kind]]?.text || '', v1),
    // Part 1 chưa có túi: bỏ câu túi của dòng quy tắc chung
    `${rule.replace(/\s*One small bag[^.]*\./i, '').replace(/Jump cuts are instant cuts;\s*the/i, 'The')} The ${piece} on only by her real hand and leg moves: both feet step in, one then the other, while her hands hold the waistband down at mid-shin and each knee is drawn up high; she pulls it up only after both feet are in: no morph or sudden appearance. Sharp final frame at ${fmtT(parseFloat(d1))}s; it is the first frame of Part 2.`,
  ].filter(Boolean).join('\n');
  // Khớp 2 phân cảnh: mở đúng khung hình cuối Part 1, giữ khuôn mặt / tóc / ánh sáng / độ sáng / cân bằng trắng / tông màu tới hết
  // Không bắt mở đúng dáng của khung hình cuối (video thử: AI vẫn mở dáng khác -> nhảy dáng ở chỗ nối) -> Part 2 mở như 1 cú cắt
  // cảnh mới, khung hình cuối chỉ là mẫu khuôn mặt / tóc / ánh sáng / màu.
  const open = `${start} is the last frame of Part 1: a reference for her face, hair, light, exposure, white balance and colour grade only, matched exactly from the first frame to the end; this part opens as a new shot after a cut, any text in ${start} must not appear${caption ? `, and the caption reads "${caption}" from the first frame` : ''}.`;
  const part2 = [
    fill(setup, v2),
    open,
    capLine,
    fill((prompt('wardrobe_set2') || WARDROBE_SET2).trim(), v2),
    fill(prompt(sp.p2[kind]) || motion.prompts[sp.p2[kind]]?.text || '', v2),
    `${rule} Sharp final frame at ${fmtT(parseFloat(d2))}s.`,
  ].filter(Boolean).join('\n');
  return { part1, part2, durations: sp.durations };
}

const listTags = (tags) => (tags.length <= 1 ? tags[0] || '' : tags.slice(0, -1).join(', ') + ' and ' + tags.at(-1));

// Đổi mốc giây của 1 khối "a-bs: …" (thời gian cục bộ, gốc = mốc cuối lớn nhất) sang [offset, offset+slot] rồi điền chỗ trống
export function rescaleBeats(text, { offset, slot }, vars) {
  const beats = text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const m = l.match(/^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)s\s*:\s*(.*)$/);
    return m ? { a: Number(m[1]), b: Number(m[2]), text: m[3] } : { text: l };
  });
  const timed = beats.filter((b) => b.a != null);
  const base = timed.length ? Math.max(...timed.map((b) => b.b)) : slot;
  const k = base > 0 ? slot / base : 1;
  return beats
    .map((b) => (b.a == null ? fill(b.text, vars) : `${fmtT(offset + b.a * k)}-${fmtT(offset + b.b * k)}s: ${fill(b.text, vars)}`))
    .join('\n');
}

// Chia 10s của Part 2 cho k trang phục còn lại: 0 -> [10] (tiếp tục bộ 1); 1 -> [10]; 2 -> [6, 4] (đúng video mẫu); 3 -> ~3.3s mỗi bộ
export function part2Slots(k) {
  if (k <= 1) return [PART_SEC];
  if (k === 2) return [6, 4];
  const each = Math.round((PART_SEC / k) * 10) / 10;
  const slots = Array.from({ length: k - 1 }, () => each);
  slots.push(Math.round((PART_SEC - each * (k - 1)) * 10) / 10);
  return slots;
}

const captionRule = (ranges) =>
  'Caption: ' + ranges.map(([a, b, code]) => `${fmtT(a)}-${fmtT(b)}s "${code}"`).join('; ') + ' (switches exactly on each match cut).';

/**
 * Dựng prompt 2 phân cảnh. outfits = [{ caption, p1: { front, back }, p2: { front, back } }] với các tag theo thứ tự ảnh của
 * TỪNG phân cảnh (xem imagesFor). prompt(key) = prompt mẫu đã đóng băng của lần chạy. caption = chữ in trên video của bộ đó
 * (mã sản phẩm hoặc chữ tuỳ ý; null khi captionMode 'none').
 */
export function buildPrompts({ motion, prompt, outfits, tags, captionMode = 'code' }) {
  const setup = setupFor((prompt('setup') || SETUP).trim(), captionMode);
  const rule = ruleFor((prompt('rule') ?? COMMON_RULE).trim(), captionMode);
  const first = outfits[0];
  if (motion.maxOutfits && outfits.length > motion.maxOutfits) {
    throw new Error(`"${motion.name.split(' – ')[0]}" chỉ dùng cho ${motion.maxOutfits} trang phục (đang chọn ${outfits.length}) — bỏ bớt trang phục hoặc đổi sang chuyển động khác`);
  }
  const v1 = { MODEL: '@Image1', BG: tags.p1.bg, OUTFITS: listTags(outfits.map((o) => o.p1.front)), OUTFIT: first.p1.front, BACK: first.p1.back, CODE: first.caption || '', DUR: '10s', CUT: fmtT(motion.cutAt ?? 3.5) };
  const part1 = [
    fill(setup, { ...v1, PART: 'Part 1 of 2' }),
    captionLine(first, captionMode),
    fill((prompt('wardrobe') || WARDROBE).trim(), v1),
    fill(prompt(motion.part1), v1),
    `${rule} Clean match cut at ${fmtT(motion.cutAt ?? 3.5)}s; the last frame is the first frame of Part 2.`.trim(),
  ].filter(Boolean).join('\n');

  const rest = outfits.slice(1);
  const slots = part2Slots(rest.length);
  const ranges = [];
  const blocks = [];
  const wear = []; // trang phục theo từng khoảng thời gian (cho dòng Wardrobe của Part 2)
  const v2 = { MODEL: '@Image1', BG: tags.p2.bg, START: tags.p2.start, DUR: '10s' };
  if (!rest.length) {
    ranges.push([0, PART_SEC, first.caption]);
    wear.push(`${first.p2.front} (back ${first.p2.back}) for the whole clip`);
    blocks.push(rescaleBeats(prompt(motion.same), { offset: 0, slot: PART_SEC }, { ...v2, OUTFIT: first.p2.front, BACK: first.p2.back, CODE: first.caption || '' }));
  } else {
    let t = 0;
    rest.forEach((o, i) => {
      ranges.push([t, t + slots[i], o.caption]);
      wear.push(`${o.p2.front} (back ${o.p2.back}) ${rest.length > 1 ? `at ${fmtT(t)}-${fmtT(t + slots[i])}s` : 'for the whole clip'}`);
      blocks.push(rescaleBeats(prompt(motion.segments[i % motion.segments.length]), { offset: t, slot: slots[i] }, { ...v2, OUTFIT: o.p2.front, BACK: o.p2.back, CODE: o.caption || '' }));
      t += slots[i];
    });
  }
  const cuts = ranges.map(([a]) => `${fmtT(a)}s`).join(' and ');
  const start = tags.p2.start;
  const noText = captionMode === 'none';
  const part2 = [
    fill(setup, { ...v2, PART: 'Part 2 of 2' }),
    noText
      ? `Opens exactly on ${start} (last frame of Part 1: same pose, framing, background), then continues. ${start} is a pose reference only: any text in it must not appear.`
      : `Opens exactly on ${start} (last frame of Part 1: same pose, framing, background), then continues. ${start} is a pose reference only: any text in it belongs to Part 1 and must not appear; from the very first frame the caption reads "${ranges[0][2]}".`,
    noText ? null : captionRule(ranges),
    fill((prompt('wardrobe2') || WARDROBE_PART2).trim(), { ...v2, WEAR: wear.join(', then ') }),
    ...blocks,
    `${rule}${rest.length ? ` Clean match cuts at ${cuts}.` : ''} Sharp final frame at 10.0s.`.trim(),
  ].filter(Boolean).join('\n');
  return { part1, part2, ranges };
}

export default {
  id: 'video-thoi-trang-khong-voice',
  name: 'Video bán hàng thời trang không voice',
  icon: '🤫',
  noVideo: true,
  // Nhóm tab trên giao diện: các quy trình cùng `group` gom thành 1 mục menu (tên = title), trong trang có nút tab theo `label`
  tab: { group: 'khong-voice', label: '👩 Nữ', title: 'Video bán hàng thời trang không voice' },
  codedInput: 'outfits', // input có mã sản phẩm theo từng ảnh (giao diện hiện ô sửa mã)
  // Giao diện cho chọn chữ trên video: mã sản phẩm / chữ tuỳ ý / không chữ (options.captionMode, options.captionTexts)
  captionModes: true,
  backInput: 'outfitBacks', // inputs.outfitBacks = { [ảnh mặt trước]: ảnh mặt sau } (giao diện chọn / tạo mặt sau cho từng bộ)
  // Lần chạy chỉ dừng chờ duyệt ở chuyển động đồ bộ 2 phân cảnh (Chuyển động 5): duyệt phân cảnh 1 rồi mới tạo phân cảnh 2
  reviewNote: 'Phân cảnh 1 (đoạn mặc quần / váy) đã xong — xem video ở thẻ "Phân cảnh 1" bên dưới. Chưa đúng thì bấm Thử lại trên thẻ đó (tạo lại phân cảnh 1) hoặc chọn bản khác. Ưng rồi bấm nút bên dưới để tạo phân cảnh 2 (bắt đầu tốn credit phân cảnh 2) và ghép — phân cảnh 2 tự được cân sáng / màu theo phân cảnh 1.',
  resumeLabel: '▶ Cảnh 1 đã ưng: tạo phân cảnh 2 & ghép',
  // Thẻ video của từng phân cảnh hiện ngay trong lần chạy (Thử lại -> thêm lần tạo 1, 2, 3… trên cùng thẻ, chọn bản tốt nhất)
  sceneJobs: [
    { key: 'video:part1', label: 'Phân cảnh 1 (hoặc cả video nếu 1 phân cảnh)', note: 'Đổi bản → cắt lại khung hình cuối, tạo lại Phân cảnh 2 và ghép lại.' },
    { key: 'video:part2', label: 'Phân cảnh 2', note: 'Thử lại / đổi bản → chỉ ghép lại với bản đang chọn.' },
  ],
  description: '1 ảnh model + 1–4 trang phục (mặt trước + mặt sau, theo thứ tự) + 1 ảnh bối cảnh → 2 phân cảnh 10s không voice: mở đầu cầm móc, mặc từng bộ với mã sản phẩm riêng làm caption, quay lưng khoe mặt sau, động tác tay chân theo "chuyển động" chọn sẵn.',
  inputs: [
    { key: 'model', kind: 'model', label: 'Ảnh model (@Image1)', required: true },
    // hideBackViews: thư viện ở ô này không hiện ảnh mặt sau (chúng được chọn ở khối "Từng trang phục" bên dưới)
    { key: 'outfits', kind: 'product', label: `Ảnh trang phục MẶT TRƯỚC (chọn 1–${MAX_OUTFITS} theo thứ tự mặc)`, required: true, multiple: true, max: MAX_OUTFITS, hideBackViews: true },
    { key: 'background', kind: 'background', label: 'Ảnh bối cảnh', required: true },
  ],
  prompts: {
    setup: { label: 'Phần mở đầu chung của mỗi phân cảnh ({PART}, {MODEL}, {BG})', text: SETUP },
    wardrobe: { label: 'Khoá trang phục – Part 1 / video 1 phân cảnh: sau match cut ({CUT}s) không còn đồ cũ của model ({OUTFIT}/{BACK})', text: WARDROBE },
    wardrobe2: { label: 'Khoá trang phục – Part 2 ({WEAR} = trang phục theo từng khoảng thời gian)', text: WARDROBE_PART2 },
    wardrobe0: { label: 'Khoá trang phục – chuyển động mặc sẵn từ khung hình đầu (Chuyển động 4: {OUTFIT}/{BACK})', text: WARDROBE_WORN },
    wardrobe_set: { label: 'Khoá trang phục – ĐỒ BỘ phân cảnh 1 (Chuyển động 5: {OUTFIT}/{BACK} = áo, {OUTFIT2}/{BACK2} = quần / váy, {SHORTS} = màu quần short gym, {CUT} = giây đã mặc xong)', text: WARDROBE_SET },
    wardrobe_set2: { label: 'Khoá trang phục – ĐỒ BỘ phân cảnh 2 (Chuyển động 5: mặc đủ bộ như khung hình cuối phân cảnh 1 {START}, giày + túi từ cú nhảy cắt đầu)', text: WARDROBE_SET2 },
    ...Object.fromEntries(Object.values(MOTIONS).filter((m) => !m.legacy).flatMap((m) => Object.entries(m.prompts))),
    rule: { label: 'Dòng quy tắc ngắn cuối mỗi phân cảnh (để trống nếu không cần)', text: COMMON_RULE },
  },
  options: [
    // minOutfits / maxOutfits: số trang phục chuyển động đó nhận (giao diện giới hạn ô chọn và báo thiếu / thừa);
    // durations: các thời lượng chuyển động 1 phân cảnh có (ô "Thời lượng" chỉ hiện các bản này)
    {
      key: 'motion',
      label: 'Chuyển động (kịch bản tay chân)',
      // outfitLabels: tên từng ảnh trang phục khi chuyển động cần đúng món (đồ bộ: ảnh 1 = áo, ảnh 2 = quần / váy); set = đồ bộ
      options: Object.entries(MOTIONS).filter(([, m]) => !m.legacy).map(([k, m]) => ({ value: k, label: m.name, minOutfits: m.minOutfits || 1, maxOutfits: m.maxOutfits || MAX_OUTFITS, durations: Object.keys(m.durations || {}), set: !!m.set, outfitLabels: m.outfitLabels || null })),
      default: DEFAULT_MOTION,
    },
    { key: 'duration', label: 'Thời lượng (Chuyển động 2: 15s đúng nhịp video mẫu, 10s rút gọn · Chuyển động 3, 4, 5: chỉ 15s)', options: SINGLE_DURATIONS.map((d) => ({ value: d, label: d })), default: SINGLE_DURATIONS[0] },
    // Chỉ dùng cho Chuyển động 5 – đồ bộ (showFor: giao diện chỉ hiện khi tuỳ chọn `motion` là 1 trong các giá trị đó)
    {
      key: 'bottomType',
      label: 'Chuyển động 5 – món dưới của bộ (ảnh 2) là',
      options: [
        { value: 'pants', label: 'Quần (cầm cạp, bước chân vào rồi mặc)' },
        { value: 'skirt', label: 'Váy (ướm lên eo rồi mặc)' },
      ],
      default: 'pants',
      showFor: { motion: ['motion5set'] },
      inline: true, // giao diện đã có nút "Món dưới là: Quần / Váy" ngay trong khối Đồ bộ (web/src/pages/SetPieces.jsx)
    },
    { key: 'shortsColor', type: 'text', label: 'Chuyển động 5 – màu quần short gym nữ lúc mở đầu', default: 'đỏ', placeholder: 'đỏ, đen, hồng, xám, navy…', maxLength: 30, showFor: { motion: ['motion5set'] } },
    { key: 'flowModel', label: 'Mô hình Flow', options: FASHION_MODELS.map((m) => ({ value: m, label: m })), default: FASHION_MODELS[0] },
    { key: 'removeWatermark', label: 'Tự động xoá logo Gemini khi ghép', default: true },
    { key: 'autoPublish', label: 'Tự động chuyển sang Đăng video khi hoàn thành', default: true },
  ],

  stages: [
    {
      id: 'part1',
      label: 'Phân cảnh 1 (hoặc cả video nếu 1 phân cảnh)',
      async run(ctx) {
        const { outfits, tags, images, captionMode } = prepare(ctx);
        const motion = motionOf(ctx.run);
        // Chuyển động 1 phân cảnh: cả video trong 1 lần tạo, thời lượng 15s / 10s chọn bản prompt tương ứng
        const single = !!motion.single;
        // Đồ bộ 2 phân cảnh (Chuyển động 5): Part 1 = đoạn mặc, thời lượng theo setParts.durations[0]
        const setParts = motion.setParts || null;
        const duration = single ? singleDuration(ctx.run) : setParts ? setParts.durations[0] : '10s';
        const template = single
          ? buildSinglePrompt({ motion, prompt: (k) => ctx.prompt(k), outfits, tags, duration, captionMode, variant: ctx.run.options.bottomType, shorts: ctx.run.options.shortsColor })
          : setParts
            ? buildSetParts({ motion, prompt: (k) => ctx.prompt(k), outfits, tags, captionMode, variant: ctx.run.options.bottomType, shorts: ctx.run.options.shortsColor }).part1
            : buildPrompts({ motion, prompt: (k) => ctx.prompt(k), outfits, tags, captionMode }).part1;
        // Đồ bộ: 2 ảnh là 1 bộ, tên video / mã chỉ lấy theo ảnh áo
        const named = motion.set ? outfits.slice(0, 1) : outfits;
        ctx.state.codes = named.map(tagOf);
        ctx.state.captionMode = captionMode;
        ctx.state.part1Prompt = template;
        const job = ctx.ensureJob('video:part1', {
          type: 'video',
          imagePaths: images.p1,
          template,
          videoLabel: `[${named.map(tagOf).join('+')}] Không voice · ${single ? `1 phân cảnh ${duration}` : 'Part 1'}${motion.set ? ' · đồ bộ' : ''} – ${ctx.assetName(ctx.inputs.outfits[0])}`,
          meta: { aspectRatio: '9:16', flowVideoModel: ctx.run.options.flowModel || FASHION_MODELS[0], flowDuration: duration, flowResolution: '720p', codes: named.map((o) => o.code).filter(Boolean), captionMode },
        });
        if (job.status === 'failed') throw ctx.jobError(job);
        if (job.status !== 'done') return 'waiting';
        return 'done';
      },
    },
    {
      id: 'last_frame',
      label: 'Cắt khung hình cuối Part 1',
      when: (run) => !isSingle(run),
      async run(ctx) {
        const j1 = ctx.job('video:part1');
        if (!j1?.outputPath || !fs.existsSync(j1.outputPath)) throw new Error('Chưa có video Part 1 để cắt khung hình cuối');
        if (!ctx.state.path || ctx.state.from !== j1.outputPath || !fs.existsSync(ctx.state.path)) {
          const raw = path.join(DIRS.tmp, `novoice-last-${j1.id}-${Date.now()}.png`);
          await extractLastFrame(j1.outputPath, raw);
          // Khung hình cuối có sẵn dòng mã của trang phục 1 -> xoá dải chữ phía trên, nếu không Flow chép mã cũ sang Part 2
          const clean = raw.replace(/\.png$/, '-clean.png');
          try {
            await removeCaptionBand(raw, clean);
            ctx.state.path = clean;
          } catch (e) {
            console.error('Xoá dải chữ khung hình cuối lỗi, dùng ảnh gốc:', e.message);
            ctx.state.path = raw;
          }
          ctx.state.rawPath = raw;
          ctx.state.cleanTried = true;
          ctx.state.from = j1.outputPath;
        }
        return 'done';
      },
    },
    {
      id: 'part2',
      label: 'Phân cảnh 2 (10–20s)',
      when: (run) => !isSingle(run),
      async run(ctx) {
        const frame = ctx.stages.last_frame?.path;
        if (!frame || !fs.existsSync(frame)) throw new Error('Chưa có khung hình cuối của Part 1');
        const motion = motionOf(ctx.run);
        // Đồ bộ 2 phân cảnh: DỪNG chờ duyệt phân cảnh 1 (đoạn mặc đồ hay sai, phải đúng rồi mới tốn credit cho phân cảnh 2). Duyệt theo
        // ĐÚNG video phân cảnh 1 đang chọn: Thử lại / chọn bản khác của phân cảnh 1 thì phải duyệt lại.
        if (motion.setParts) {
          const cur = ctx.job('video:part1')?.outputPath || null;
          if (ctx.state.approved && ctx.state.approvedFor !== cur) {
            if (ctx.state.pausedFor === cur) ctx.state.approvedFor = cur; // vừa bấm Tiếp tục cho đúng bản này
            ctx.state.approved = false;
          }
          if (ctx.state.approvedFor !== cur) {
            ctx.state.pausedFor = cur;
            return 'paused';
          }
        }
        const { outfits, tags, images, captionMode } = prepare(ctx, frame);
        // Đồ bộ 2 phân cảnh: Part 2 = đoạn khoe dáng (buildSetParts), thời lượng setParts.durations[1]
        const setParts = motion.setParts || null;
        const built = setParts
          ? buildSetParts({ motion, prompt: (k) => ctx.prompt(k), outfits, tags, captionMode, variant: ctx.run.options.bottomType, shorts: ctx.run.options.shortsColor })
          : buildPrompts({ motion, prompt: (k) => ctx.prompt(k), outfits, tags, captionMode });
        ctx.state.part2Prompt = built.part2;
        ctx.state.ranges = built.ranges || null;
        const named = motion.set ? outfits.slice(0, 1) : outfits.slice(1).length ? outfits.slice(1) : outfits;
        const job = ctx.ensureJob('video:part2', {
          type: 'video',
          imagePaths: images.p2,
          template: built.part2,
          videoLabel: `[${named.map(tagOf).join('+')}] Không voice · Part 2${motion.set ? ' · đồ bộ' : ''} – ${ctx.assetName(ctx.inputs.outfits[0])}`,
          meta: { aspectRatio: '9:16', flowVideoModel: ctx.run.options.flowModel || FASHION_MODELS[0], flowDuration: setParts ? setParts.durations[1] : '10s', flowResolution: '720p', startFrame: frame },
        });
        if (job.status === 'failed') throw ctx.jobError(job);
        if (job.status !== 'done') return 'waiting';
        return 'done';
      },
    },
    {
      id: 'merge',
      label: 'Ghép phân cảnh & xoá logo',
      async run(ctx) {
        const single = isSingle(ctx.run);
        const j1 = ctx.job('video:part1');
        const j2 = single ? null : ctx.job('video:part2');
        if (!j1?.outputPath || (!single && !j2?.outputPath)) throw new Error(single ? 'Thiếu video đầu ra' : 'Thiếu video Part 1 hoặc Part 2');
        const codes = ctx.stages.part1?.codes || [];
        // Đồ bộ 2 phân cảnh: CÂN MÀU phân cảnh 2 theo phân cảnh 1 (so nền 2 mép khung hình ở chỗ nối) trước khi ghép. Làm 1 lần cho mỗi
        // cặp video (ghi lại from / ref); lỗi thì ghép bản gốc. Video đã chỉnh chỉ dùng khi ghép, video của job giữ nguyên.
        let fileOverrides = null;
        if (!single && motionOf(ctx.run).setParts) {
          const cm = ctx.state.colorMatch;
          if (!cm || cm.from !== j2.outputPath || cm.ref !== j1.outputPath || (cm.applied && !fs.existsSync(cm.path))) {
            const out = path.join(DIRS.tmp, `colormatch-${j2.id}-${Date.now()}.mp4`);
            try {
              const r = await colorMatchVideo(j1.outputPath, j2.outputPath, out);
              ctx.state.colorMatch = { from: j2.outputPath, ref: j1.outputPath, path: r.applied ? out : null, applied: r.applied, ky: r.ky, du: r.du, dv: r.dv, reason: r.reason || null };
            } catch (e) {
              console.error('Cân màu phân cảnh 2 lỗi, ghép bản gốc:', e.message);
              ctx.state.colorMatch = { from: j2.outputPath, ref: j1.outputPath, path: null, applied: false, reason: String(e.message).slice(0, 200) };
            }
            save();
          }
          if (ctx.state.colorMatch.applied) fileOverrides = { [j2.id]: ctx.state.colorMatch.path };
        }
        return ctx.ensureMerge({
          jobIds: single ? [j1.id] : [j1.id, j2.id],
          name: `[${codes.join('+')}] Video thời trang không voice – ${ctx.assetName(ctx.inputs.outfits[0])}`,
          removeWatermark: ctx.run.options.removeWatermark ?? true,
          keepOriginalAudio: false,
          fileOverrides,
        });
      },
    },
  ],

  // Đồng bộ khi kết quả 1 phân cảnh đổi (Thử lại = thêm 1 lần tạo vào CÙNG job, chọn lần tạo khác, xoá lần tạo):
  //  - Part 1 đổi -> cắt lại khung hình cuối, làm lại Part 2 (job mới vì ảnh đầu vào đổi) và ghép lại. Chỉ xảy ra 1 lần cho
  //    mỗi kết quả Part 1: bước last_frame ghi lại `from` = video Part 1 đã dùng.
  //  - Part 2 đổi (hoặc video duy nhất của chuyển động 1 phân cảnh) -> CHỈ ghép lại với bản đang chọn.
  // Tuyệt đối không đặt lại Part 2 theo điều kiện "đúng mãi" (vd. tên file khung hình): mỗi lần Part 2 xong lại sinh job mới
  // -> lặp vô hạn, tốn credit, và không còn các lần tạo 1, 2, 3 trên cùng 1 thẻ để chọn bản tốt nhất.
  sync(run) {
    const jobsMap = run.stages._jobs || {};
    const jobOf = (k) => (jobsMap[k] ? db.jobs.find((j) => j.id === jobsMap[k]) : null);
    const single = isSingle(run);
    const j1 = jobOf('video:part1');
    let changed = false;
    if (!single) {
      const lf = run.stages.last_frame;
      if (j1?.outputPath && lf?.from && lf.from !== j1.outputPath) {
        for (const id of ['last_frame', 'part2']) {
          const st = run.stages[id];
          if (st && st.status !== 'pending' && st.status !== 'skipped') { st.status = 'pending'; changed = true; }
        }
        const ms = run.stages.merge;
        if (ms && ms.status !== 'skipped' && (ms.status !== 'pending' || ms.mergeId)) { run.stages.merge = { status: 'pending' }; changed = true; }
        if (jobsMap['video:part2']) { delete jobsMap['video:part2']; changed = true; }
        return changed;
      }
      upgradeOldFrame(lf, jobOf('video:part2'));
    }
    const ms = run.stages.merge;
    const merge = ms?.mergeId && db.merges.find((m) => m.id === ms.mergeId);
    if (merge?.inputPaths) {
      const current = single ? [j1?.outputPath] : [j1?.outputPath, jobOf('video:part2')?.outputPath];
      if (current.every(Boolean) && current.some((p, i) => p !== merge.inputPaths[i])) { run.stages.merge = { status: 'pending' }; changed = true; }
    }
    return changed;
  },
};

// Lần chạy cũ (trước khi có bước xoá dải mã): khung hình cuối còn dòng mã của trang phục 1. Làm sạch đúng 1 lần ở nền rồi đổi
// ảnh đầu vào của job Part 2 sang khung sạch, để lần "Thử lại" sau dùng khung sạch. KHÔNG đặt lại bước nào, KHÔNG tạo job.
function upgradeOldFrame(lf, j2) {
  if (!lf?.path || lf.cleanTried || /-clean\.png$/.test(lf.path) || !fs.existsSync(lf.path)) return;
  lf.cleanTried = true;
  const raw = lf.path;
  const clean = raw.replace(/\.png$/, '-clean.png');
  removeCaptionBand(raw, clean)
    .then(() => {
      if (lf.path !== raw) return; // khung hình đã được cắt lại trong lúc chờ
      lf.rawPath = raw;
      lf.path = clean;
      if (j2?.imagePaths) j2.imagePaths = j2.imagePaths.map((p) => (p === raw ? clean : p));
      if (j2?.meta?.startFrame === raw) j2.meta.startFrame = clean;
      save();
    })
    .catch((e) => console.error('Xoá dải chữ khung hình cuối (lần chạy cũ) lỗi:', e.message));
}

// Ảnh mặt sau của 1 ảnh mặt trước: người dùng chỉ định (inputs.outfitBacks), không thì ảnh mặt sau mới nhất tạo từ ảnh đó
export function backOf(frontId, chosen) {
  if (chosen && db.assets.some((a) => a.id === chosen)) return chosen;
  const gen = db.assets.find((a) => a.fromAssetId === frontId && (a.isBackView || /Mặt sau Flow/.test(a.name || '')));
  return gen?.id || null;
}

// Nhãn ngắn của 1 bộ cho tên video / ghép: mã sản phẩm, không có thì chữ tuỳ ý, không có nữa thì "không chữ"
const tagOf = (o) => o.code || o.caption || 'không chữ';

// Thu nguyên liệu + tag theo đúng thứ tự ảnh của từng phân cảnh (xem đầu file). Chữ trên video (options.captionMode):
//  'code' (mặc định) = mã sản phẩm của ảnh mặt trước (kế thừa theo chuỗi fromAssetId), chưa có thì cấp mới;
//  'text' = options.captionTexts[ảnh mặt trước]; bộ để trống thì dùng chữ của bộ trước đó (nhập 1 lần cho bộ 1 là đủ);
//  'none' = không in chữ (không cấp mã mới, chỉ dùng mã sẵn có để đặt tên video).
function prepare(ctx, startFrame = null) {
  const model = ctx.assetPath(ctx.inputs.model);
  const bg = ctx.assetPath(ctx.inputs.background);
  const ids = (ctx.inputs.outfits || []).slice(0, MAX_OUTFITS);
  if (!model) throw new Error('Ảnh model không còn trong thư viện');
  if (!bg) throw new Error('Ảnh bối cảnh không còn trong thư viện');
  if (!ids.length) throw new Error('Chưa chọn ảnh trang phục');
  const captionMode = captionModeOf(ctx.run.options);
  const texts = ctx.run.options.captionTexts || {};
  let lastText = '';
  const motion = motionOf(ctx.run);
  const outfits = ids.map((id, i) => {
    const front = ctx.assetPath(id);
    if (!front) throw new Error(`Ảnh trang phục thứ ${i + 1} không còn trong thư viện`);
    const backId = backOf(id, ctx.inputs.outfitBacks?.[id]);
    const back = ctx.assetPath(backId);
    if (!back) throw new Error(`Trang phục ${i + 1} (${ctx.assetName(id)}) chưa có ảnh mặt sau — chọn hoặc bấm "Tạo mặt sau" trong trang quy trình rồi chạy lại`);
    // Đồ bộ (motion.set): cả bộ dùng 1 mã (của ảnh áo) -> không cấp mã mới cho ảnh quần / váy
    const code = codeOfAsset(id) || (captionMode === 'code' && !(motion.set && i > 0) ? assignCode(id).productCode : null);
    let caption = null;
    if (captionMode === 'code') caption = code;
    if (captionMode === 'text') {
      caption = cleanCaptionText(texts[id]) || lastText;
      if (!caption) throw new Error(`Chưa nhập chữ in trên video cho trang phục ${i + 1} (${ctx.assetName(id)}) — nhập ở ô "Chữ trên video" hoặc đổi sang "Mã sản phẩm" / "Không chữ"`);
      lastText = caption;
    }
    return { id, backId, front, back, code, caption };
  });
  const countError = outfitCountError(motion, outfits.length);
  if (countError) throw new Error(countError);
  // Part 1: model, trước 1, sau 1, mặt trước các bộ còn lại (cầm trên móc), bối cảnh.
  // Chuyển động 1 phân cảnh (cả video trong 1 lần tạo): model, (trước, sau) của TỪNG bộ, bối cảnh — bộ nào cũng cần mặt sau.
  // Đồ bộ (motion.set): 2 món mặc cùng lúc -> cả 2 phân cảnh đều nhận (trước, sau) của áo và của quần / váy
  const p1 = motion.single || motion.set
    ? [model, ...outfits.flatMap((o) => [o.front, o.back]), bg]
    : [model, outfits[0].front, outfits[0].back, ...outfits.slice(1).map((o) => o.front), bg];
  // Part 2: model, (trước, sau) từng bộ còn lại (hoặc bộ 1 nếu chỉ có 1 bộ; đồ bộ: cả 2 món), bối cảnh, khung hình cuối Part 1
  const rest = motion.set ? outfits : outfits.length > 1 ? outfits.slice(1) : outfits;
  const p2 = [model, ...rest.flatMap((o) => [o.front, o.back]), bg, ...(startFrame ? [startFrame] : [])];
  const tag = (list, file) => `@Image${list.indexOf(file) + 1}`;
  const tagged = outfits.map((o) => ({
    ...o,
    p1: { front: tag(p1, o.front), back: p1.includes(o.back) ? tag(p1, o.back) : tag(p1, o.front) },
    p2: { front: p2.includes(o.front) ? tag(p2, o.front) : null, back: p2.includes(o.back) ? tag(p2, o.back) : null },
  }));
  const tags = { p1: { bg: tag(p1, bg) }, p2: { bg: tag(p2, bg), start: startFrame ? tag(p2, startFrame) : `@Image${p2.length + 1}` } };
  return { outfits: tagged, tags, images: { p1, p2 }, captionMode };
}
