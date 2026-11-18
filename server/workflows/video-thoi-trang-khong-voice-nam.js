// Quy trình "Video thời trang không voice – NAM" (tab Nam của nhóm "không voice", tab Nữ: ./video-thoi-trang-khong-voice.js).
//
// Đầu vào: ảnh KOL/KOC (bắt buộc) + ảnh bối cảnh (bắt buộc) + 1..N OUTFIT. Mỗi outfit có 7 ô món (SLOTS: áo, quần, áo khoác,
// giày, túi, bộ đồ áo + quần chung 1 ảnh, mũ), mỗi ô có ảnh MẶT TRƯỚC và MẶT SAU, KHÔNG ô nào bắt buộc. Món nào không có ảnh thì AI tự phối theo phong cách.
//
// Các bước:
//   look         – mỗi outfit 1 ảnh XEM TRƯỚC mặt trước: KOL/KOC mặc đủ bộ (món đã nhập + món AI phối), nền studio (Flow ảnh, 0 credit)
//   look_back    – ảnh xem trước MẶT SAU của đúng bộ đó (từ ảnh mặt trước + ảnh mặt sau các món)
//   review       – DỪNG chờ người dùng duyệt ảnh xem trước (Thử lại / Sửa prompt / chọn lần tạo ngay trên thẻ ảnh)
//   motion_prompt– "Xử lý prompt chuyển động": Gemini xem ảnh đã duyệt, sửa câu chữ về phụ kiện trong các mốc động tác cho khớp
//                  món nhân vật thật sự đội / đeo / cầm (không có key / lỗi -> bản trung tính)
//   scene1..3    – video từng phân cảnh trên Flow; từ phân cảnh 2 mở bằng khung hình cuối của phân cảnh trước (frame1, frame2)
//   merge        – ghép các phân cảnh, xoá logo
// Video dùng chính 2 ảnh xem trước đã duyệt làm tham chiếu trang phục ({OUTFIT} = look mặt trước, {BACK} = look mặt sau), nên
// khớp đúng bộ đã duyệt kể cả món AI tự phối; mỗi phân cảnh tối đa MAX_PER_SCENE outfit (giới hạn số ảnh nguyên liệu của Flow).
//
// QUY TẮC CHO MỌI CHUYỂN ĐỘNG (kể cả chuyển động thêm sau này): chuyển động chỉ khai báo kịch bản tay chân; nhân vật trong video
// LUÔN mặc đúng ảnh outfit đã tạo / đã duyệt (bước video chỉ có 1 đường code chung `sceneStage`: ảnh = KOL/KOC + ảnh outfit mặt
// trước, mặt sau của từng outfit + bối cảnh). Không chuyển động nào tự phối đồ riêng.
// TÚI là tuỳ chọn THEO CHUYỂN ĐỘNG (`bag: true | false | 'optional'`, bắt buộc khai báo):
//   bag: true       -> outfit luôn có túi (túi người dùng nhập, không nhập thì AI tự phối) rồi mới làm video có túi;
//   bag: false      -> ô Túi không dùng, ảnh outfit và video không có túi;
//   bag: 'optional' -> TÚI THEO TỪNG OUTFIT: outfit có ảnh túi thì đeo đúng túi đó, outfit không có ảnh túi thì KHÔNG túi (AI
//                      không tự thêm). Mỗi outfit quy về true / false (bagForLook) nên ảnh outfit tạo sẵn vẫn dùng lại được.
// Đổi giữa chuyển động có túi / không túi làm chữ ký outfit (lookSig) đổi -> ảnh outfit tạo sẵn bị coi là cũ, phải tạo lại.
//
// CHUYỂN ĐỘNG KHAI BÁO ĐỘNG (MALE_MOTIONS) — thêm chuyển động mới = thêm 1 mục, không sửa code:
//   layouts[thời lượng tổng] = danh sách PHÂN CẢNH (1, 2 hoặc 3); mỗi phân cảnh = { prompt: khoá prompt chứa các mốc
//   "a.a-b.bs: …" (thời gian cục bộ của phân cảnh, tự co giãn theo `duration`), duration: thời lượng Flow ('10s' | '15s' …) }.
//   Dòng không có mốc giây trong prompt (vd. "Mood: …") được giữ nguyên ở đầu khối động tác.
// Chia outfit: gom mọi mốc của mọi phân cảnh theo thời gian toàn video; N outfit đổi đồ ở mốc nhảy cắt gần T·i/N nhất
// (planScenes). Mỗi phân cảnh chỉ nhận ảnh của các outfit xuất hiện trong nó.
//
// Chỗ điền trong prompt video: {MODEL} = @Image1 · {OUTFIT}/{BACK} = ảnh look mặt trước / sau · {WEAR} = look theo từng khoảng
// giây · {BG} = bối cảnh · {START} = khung hình cuối phân cảnh trước · {PART} = "Part 1 of 2"… · {DUR} = thời lượng phân cảnh.
import fs from 'node:fs';
import path from 'node:path';
import { extractLastFrame, removeCaptionBand } from '../ffmpeg.js';
import { DIRS, db } from '../db.js';
import { codeOfAsset, assignCode } from '../productCodes.js';
import { captionModeOf, cleanCaptionText } from '../caption.js';
import { callGeminiWithFallback } from '../geminiFashion.js';
import { FASHION_MODELS } from './video-thoi-trang.js';
import { fill, fmtT, setupFor, ruleFor } from './video-thoi-trang-khong-voice.js';

// Mặc định: model + 3 × (look trước, look sau) + bối cảnh + khung hình bắt đầu = 9 ảnh. Chuyển động không quay lưng (không cần
// ảnh mặt sau) được khai báo nhiều hơn qua `maxPerScene` (vd. Nam 2: model + 8 look trước + bối cảnh = 10 ảnh).
export const MAX_PER_SCENE = 3;
const MAX_SCENES = 3;

// Các ô món của 1 outfit. fill: AI tự bù món này khi không có ảnh (áo khoác chỉ có khi người dùng nhập).
export const SLOTS = [
  { key: 'top', label: 'Áo', en: 'top', fill: true },
  { key: 'bottom', label: 'Quần', en: 'trousers', fill: true },
  { key: 'jacket', label: 'Áo khoác', en: 'outer jacket', fill: false },
  { key: 'shoes', label: 'Giày', en: 'shoes', fill: true },
  { key: 'bag', label: 'Túi', en: 'bag', fill: true },
  // 2 ô thêm sau (nối CUỐI để thứ tự ảnh và chữ ký outfit cũ không đổi, xem lookSig):
  //  set = 1 ảnh có cả áo và quần (thay cho 2 ô Áo + Quần: AI không tự phối áo / quần nữa) · hat = mũ (AI không tự thêm)
  { key: 'set', label: 'Bộ đồ (áo + quần 1 ảnh)', en: 'top-and-trousers set', fill: false, covers: ['top', 'bottom'], extra: true },
  { key: 'hat', label: 'Mũ', en: 'cap', fill: false, extra: true },
];
const DEFAULT_STYLE = 'a modern Korean menswear street style that suits the given pieces and this man';

// ---- Ảnh xem trước (Flow ảnh, 0 credit) ----
// {INPUTS} = "image 1 = …; image 2 = …" · {GIVEN} = ghi chú về món đã nhập · {MISSING} = món AI phải tự phối · {STYLE} = phong cách
const LOOK_PROMPT = `Photorealistic full-body menswear lookbook photo, vertical 9:16. Inputs, in order: {INPUTS}.
Output ONE single photo of this man (not a collage, not several views, no other people) standing and facing the camera, wearing one complete outfit.
IDENTITY AND BODY, the most important rule: his face, hairstyle and skin tone match image 1 exactly; keep his real body exactly as in image 1: height, shoulder width, chest, waist and leg proportions and head-to-body ratio. Do not slim, bulk up or idealize him. Use image 1 for his face, hair and body only, never its clothes.
GIVEN PIECES: {GIVEN}
MISSING PIECES: {MISSING}
STYLE: {STYLE}.
POSE: relaxed, confident standing pose, weight on one leg, arms natural (a hand may rest in a pocket) without hiding any given piece.
SCENE: plain light-grey seamless studio background, soft even lighting, a soft contact shadow under the shoes.
FRAMING: whole body from the top of the head to the soles of the shoes, centred, a little space above and below; eye-level camera, sharp focus.
No text, watermarks, captions, props or extra people. Natural hands and fingers.`;

// {INPUTS} như trên (image 1 = ảnh look mặt trước đã tạo) · {BACKS} = ghi chú về ảnh mặt sau của các món
const LOOK_BACK_PROMPT = `Photorealistic full-body menswear photo, vertical 9:16. Inputs, in order: {INPUTS}.
Show the SAME man in the SAME complete outfit as image 1, photographed from directly behind (back view): same garments, shoes and accessories, same colours, fabrics and fit, same body proportions and hairstyle, same plain light-grey studio background and lighting.
He stands naturally with his back to the camera, head facing away, arms relaxed at his sides so the back of every garment is clearly visible.
BACK DETAILS: {BACKS}
FRAMING: whole body from the top of the head to the soles of the shoes, centred; eye-level camera, sharp focus.
One single photo, not a collage; no text, watermarks, props or extra people.`;

// ---- Prompt video ----
// Phần mở đầu mỗi phân cảnh: khoá mặt / vóc dáng theo {MODEL}, một chỗ đứng duy nhất trong {BG}. Máy quay và nhịp điệu do
// từng chuyển động tự khai báo ở các dòng không có mốc giây ("Mood: …", "Camera: …").
// Prompt video viết gọn (Flow gõ từng thẻ @Image, prompt dài dễ lỗi và loãng ý): mỗi ý chỉ nói 1 lần.
// Khoá nhân vật: nói rõ từng nét mặt và "sau mỗi lần đổi outfit vẫn là đúng người đó" — video đổi đồ hay làm mặt / tóc trôi dần.
const SETUP_NAM = `{PART} of a silent {DUR} Korean menswear outfit clip: no voice, mouth closed. Caption: small white serif product code at the top-center. He is exactly the man in {MODEL}: face shape, eyes, nose, lips, jawline, skin tone, hairstyle and head-to-body ratio locked 1:1 in every frame and after every outfit change; keep his real body (height, shoulders, chest, waist, legs), never slimmed, bulked up or reshaped. Background: {BG}, one single spot for the whole clip; keep its light.`;
// Khoá trang phục theo ảnh look (ảnh chụp studio: chỉ lấy trang phục, không lấy nền xám)
const WARDROBE_LOOK = `Wardrobe: {MODEL} gives face, hair and body only, never clothes. The whole clip he wears the complete look in {OUTFIT} (back {BACK}) exactly as pictured, nothing added, removed or swapped; ignore the grey studio background of these photos.`;
const WARDROBE_LOOKS = `Wardrobe: {MODEL} gives face, hair and body only, never clothes. He wears {WEAR}. Each is a complete look copied exactly as pictured, nothing added, removed or mixed between looks; ignore the grey studio background of these photos.`;
// {BAG} = câu về túi theo chuyển động (BAG_RULE): có túi -> giữ đúng túi trong ảnh outfit; không túi -> không mang túi.
// Câu về chữ trên video do buildScenePrompt thêm theo chế độ chữ (không chữ thì phần mở đầu đã cấm mọi chữ).
const RULE_LOOK = `The camera never moves within a shot. {BAG} Natural hands, relaxed motion.`;
const BAG_RULE = {
  true: 'He keeps the bag from the look photos with him throughout, exactly as pictured.',
  false: 'He carries no bag at any time.',
};
// Phân cảnh có outfit có túi và outfit không túi (bag: 'optional'): nêu đích danh look nào có túi
const bagRuleMixed = (refs) => `Only in ${refs} he carries the bag shown in that look photo, exactly as pictured; in every other look he carries no bag.`;
// Túi của 1 outfit theo kiểu túi của chuyển động. look = outfit đã làm sạch (items theo khoá ô món)
export const bagForLook = (motionBag, look) =>
  motionBag === 'optional' ? !!(look?.items?.bag?.front || look?.items?.bag?.back) : motionBag !== false;

// Luật cho Gemini ở bước "Xử lý prompt chuyển động". {N} = số outfit · {BEATS} = danh sách mốc đánh số kèm outfit đang mặc
const ADAPT_PROMPT = `You are a fashion-video director. I give you {N} photo(s): each shows the same man wearing one complete outfit (Outfit 1 … Outfit {N}, in order). Below is the numbered shot list ("beats") of a silent menswear lookbook video; each beat is tagged with the outfit he wears in it.

The shot list is generic: a beat may mention a garment or accessory (for example a jacket worn open, a cap, a bag) that he does NOT have in that beat's outfit photo. Rewrite ONLY those parts, replacing the action with a natural equivalent that uses what he really wears or carries there (hoodie pocket, shirt hem, collar, sleeves, trouser pockets, hair, glasses…). If he does have the item, keep the wording.
Hand moves must also suit the outfit: if a beat's hand action does not fit (a collar on a collarless tee or hoodie, a cuff on short sleeves, front pockets his trousers do not show), swap it for one that shows off that outfit (jacket zip or lapel, hoodie strings, shirt placket, sleeve, hem, cap brim, chain…).

Rules:
- Keep every beat's framing, body pose, direction, place and mood; change as few words as possible.
- Same number of beats, same order, one beat = one line of plain English, at most 8 words longer than the original.
- If he carries a bag, name its real type (backpack, crossbody bag, tote bag…) and where it is; if he has no bag, never mention one.
- Never mention colours, brands, image numbers or timings.

Return pure JSON: {"accessories": ["Outfit 1: headwear / bag / other accessories he really has", …], "beats": ["beat 1 text", "beat 2 text", …]}

BEATS:
{BEATS}`;

// Bản trung tính khi không dùng được Gemini: câu chữ nhắc tới món có thể không có trong outfit (áo khoác mở, mũ, ba lô) đổi
// thành động tác chung, outfit nào cũng làm được (thứ tự: cụm cụ thể trước, cụm chung sau)
const NEUTRAL = [
  [/both hands hold his jacket open at chest height, showing the top underneath/i, 'Both hands tug the front of his top straight at chest height'],
  [/,? ?then he lets go and the jacket falls closed/i, ', then he lets go'],
  [/the whole back of the jacket/gi, 'the whole back of his top'],
  [/\bbackpack\b/gi, 'bag'],
  // Chuyển động Nam 2 (mở đầu kéo lệch mũ): outfit không có mũ
  [/,? his cap on,?/gi, ','],
  [/one hand tugs the brim of his cap to one side/gi, 'one hand sweeps his hair to one side'],
  [/\bhis cap\b/gi, 'his hair'],
];
export const neutralize = (text) => NEUTRAL.reduce((t, [re, to]) => t.replace(re, to), text);

// ---- Chuyển động ----
// Chuyển động Nam 2 — kịch bản "chạy qua 2 cửa". 1 phân cảnh, máy quay cố định, bối cảnh có 2 cánh cửa (trái và phải).
// THỜI LƯỢNG TỰ TÍNH THEO SỐ OUTFIT (dynamic): video = mở đầu 3,5s + ~1,5s mỗi outfit sau, làm tròn lên giây (Omni 1.2: 3–15s,
// mỗi nấc 1s) -> mỗi outfit đúng 1 lượt, AI không phải tự lấp giây thừa (lượt dài hơn động tác làm video trật nhịp).
//   3 outfit = 7s · 5 outfit = 10s · 8 outfit = 14s (tối đa: 9 outfit sẽ > 15s). 1,5s/outfit: đủ để mắt tìm và đọc mã sản phẩm ở mép
//   khung (mã hiện ngay từ lúc khung còn trống), vẫn giữ nhịp nhanh; dài hơn thì AI tự thêm động tác thừa.
//   outfit 1 (0–3,5s, mở đầu): mặc sẵn từ khung hình đầu (vd. mũ + bộ áo quần), chạy ra từ cửa trái → dừng ~2s giữa khung, chân và
//     thân vẫn hướng về cửa phải, chỉ quay mặt vào máy quay, 1 tay kéo vành mũ lệch sang 1 bên, nháy mắt, cười → chạy vào cửa phải;
//   từ 3,5s: mỗi outfit 1 lượt, bước vào khung hình TRỐNG (nhô lên từ mép dưới như bước lên nửa bậc / từ mép trái / mép phải), bước
//     giả ~1 bước rồi cắt sang outfit sau; mỗi lượt 1 dáng thân trên / hướng mặt khác nhau (NAM2_POSES), mặt cool boy không cười
//     → đổi đồ xảy ra lúc nhân vật ở ngoài khung nên trông mượt.
// Prompt mẫu `nam2` ghi mốc theo nhịp danh nghĩa (lượt 1,5s); lúc chạy chỉ giữ đúng N-1 lượt đầu và chia lại đều cho thời lượng thật
// (dynamicPrompt). Mã sản phẩm (caption): kiểu chữ cá tính, cỡ vừa-lớn, sát mép trái / phải, phía đối diện bên nhân vật bước vào
// (captionSides). Không quay lưng -> không ảnh mặt sau; không mốc nào nhắc túi (túi do dòng quy tắc nêu theo từng look).
const NAM2_INTRO = [
  [0.0, 0.8, 'He runs in from the left door, his cap on, slowing toward the centre.'],
  [0.8, 2.8, 'He stops mid-run in the centre: feet and body still pointed at the right door, only his head turns to the camera; one hand tugs the brim of his cap to one side, he winks and gives a cheeky closed-mouth smile.'],
  [2.8, 3.5, 'He looks ahead and runs off through the right door, leaving the frame empty.'],
];
// Lượt outfit: cách bước vào + bước giả 1 bước nói CHUNG 1 lần ở dòng "Walk-ins:"; mỗi mốc chỉ ghi mép bước vào và 1 dáng thân trên /
// ánh mắt KHÁC NHAU (mặt cool boy, không cười). Động tác tay viết chung chung (cổ áo, cổ tay áo, túi quần, tóc, vạt áo) — bước
// "Xử lý prompt chuyển động" (Gemini) đổi cho hợp trang phục thật của từng outfit. Viết ngắn: 8 outfit vẫn phải vừa ~3.300 ký tự.
// Tránh chữ "back" (vd. "hair back", "over his shoulder") để AI không tự quay lưng khoe mặt sau.
const NAM2_POSES = [
  'Jump cut, from the bottom edge, rising as if up half a stair: head turned to his left, eyes off left, a hand sweeping his hair up.',
  'Jump cut, from the left edge: chin down, a cool stare up into the lens, a hand fixing his collar.',
  'Jump cut, from the right edge: head tilted, gaze off to his right, a hand at his other cuff.',
  'Jump cut, from the bottom edge: eyes down, a hand behind his neck, then a slow look up into the lens.',
  'Jump cut, from the left edge: body angled, a sideways glance into the lens, thumbs in his front pockets.',
  'Jump cut, from the right edge: chin up, eyes half-closed on the lens, a hand tugging the hem of his top.',
  'Jump cut, from the bottom edge: head tipped to one side, eyes on the lens, both hands in his pockets.',
];
// Chuyển động Nam 3 — cùng khung "2 cửa" với Nam 2 (thời lượng tự tính, 7 dáng NAM2_POSES, mã 2 bên), chỉ khác đoạn mở đầu:
// outfit 1 chạy ra từ cửa trái → TRƯỢT CHÂN TÉ kiểu hài (2 chân trượt ra trước, ngồi phịch xuống sàn, không đau) → lồm cồm đứng dậy
// phủi quần → khựng lại nhìn thẳng máy quay, XẤU HỔ E THẸN (cười ngượng, má ửng, liếc đi rồi lén nhìn lại, tay che miệng) →
// chạy vào cửa phải bằng dáng chạy ẺO LẢ hài (bước ngắn nhón gót, khuỷu tay khép, cổ tay vẩy, hông lắc nhẹ).
// Viết theo từng pha vật lý rõ ràng (chân nào trượt, ngã kiểu gì, tiếp đất ra sao) vì video AI hay làm cú ngã mơ hồ / biến hình;
// nhấn "comic, unhurt" để không thành cảnh tai nạn. Tránh chữ "back" (ngã ngửa = "flat on his back") -> ngã NGỒI ("on his bottom").
// Mở đầu dài 4,5s -> 8 outfit = 15s; giới hạn 7 outfit (14s) để prompt không quá dài (mở đầu nhiều chữ hơn Nam 2).
const NAM3_INTRO = [
  [0.0, 0.7, 'He runs in fast from the left door, eager.'],
  [0.7, 1.5, 'Comic slip: his front foot skids on the shiny floor, legs shoot forward, arms windmill, he drops onto his bottom with a bounce, unhurt.'],
  [1.5, 2.3, 'He scrambles up clumsily, patting dust off his trousers.'],
  [2.3, 3.5, 'He freezes facing the camera: bashful embarrassed grin, flushed cheeks, eyes dart away then peek at the lens, fingertips over his mouth.'],
  [3.5, 4.5, 'He flees to the right door in a dainty, prissy run: tiny quick tiptoe steps, elbows in, wrists flapping, hips swaying, leaving the frame empty.'],
];

// Khung chung các chuyển động "2 cửa": mở đầu riêng (outfit 1) + các lượt NAM2_POSES (mỗi outfit sau 1 lượt ~1,5s)
function doorMotion({ key, name, intro, mood, bagNote, maxOutfits = NAM2_POSES.length + 1, label }) {
  const len = intro.at(-1)[1];
  const dynamic = { prompt: key, intro: len, per: 1.5, max: 15 };
  const text = [
    `Mood: ${mood}, then cool and magnetic: handsome, no smile, intense eyes.`,
    'Camera: locked-off vertical phone shot at chest height, straight on, full body head to feet, {BG} with both doors in view; no zoom, no pan.',
    'Walk-ins: after the opening each look enters the empty frame from the named edge, one slow fake-walking step with its pose, then cut; changes happen out of view. Hands suit his outfit.',
    ...intro.map(([a, b, t]) => `${a.toFixed(1)}-${b.toFixed(1)}s: ${t}`),
    ...NAM2_POSES.slice(0, maxOutfits - 1).map((t, i) => `${(len + 1.5 * i).toFixed(1)}-${(len + 1.5 * (i + 1)).toFixed(1)}s: ${t}`),
  ].join('\n');
  return {
    name,
    bag: 'optional',
    bagNote, // ghi chú hiện trên giao diện (khối Outfit)
    maxOutfits,
    maxPerScene: maxOutfits, // không quay lưng -> không ảnh mặt sau: model + N look trước + bối cảnh
    cutRule: { from: len, jumpOnly: true },
    dynamic,
    // Kiểu chữ của mã sản phẩm / chữ tuỳ ý (thay câu "Caption:" của phần mở đầu); vị trí trái / phải theo từng outfit (captionSides).
    // KHÔNG ghi cỡ chữ bằng số: Flow từng in luôn con số ("20") lên video.
    caption: { style: 'bold hand-lettered streetwear font, white with a thin dark outline, medium-large', sides: true },
    layouts: { auto: [{ prompt: key, duration: 'auto' }] },
    prompts: {
      [key]: { label: `${label} · các mốc theo nhịp mẫu (mở đầu 0–${String(len).replace('.', ',')}s = outfit 1; mỗi mốc "Jump cut" sau đó = 1 outfit). Lúc chạy chỉ giữ số lượt bằng số outfit và tự chia lại cho thời lượng tự tính; câu "Match cut: he now wears …" được thêm tự động`, text },
    },
  };
}

export const MALE_MOTIONS = {
  nam2: doorMotion({
    key: 'nam2',
    label: 'Chuyển động Nam 2 (chạy qua 2 cửa)',
    name: 'Chuyển động Nam 2 (TÚI TUỲ OUTFIT) – "chạy qua 2 cửa": 1 phân cảnh, THỜI LƯỢNG TỰ TÍNH (mở đầu 3,5s + ~1,5s mỗi outfit, 1–8 outfit, tối đa 14s): outfit 1 chạy ra từ cửa trái → dừng ~2s quay mặt vào máy quay, kéo lệch mũ, nháy mắt, cười → chạy vào cửa phải → mỗi outfit sau 1 lượt: nhô lên từ mép dưới / bước vào từ trái / phải, bước giả ~1 bước, mỗi lượt 1 dáng khác (nghiêng mặt nhìn trái / nhìn thẳng sửa cổ áo / nhìn phải chỉnh cổ tay áo / tay sau gáy rồi ngẩng nhìn / liếc máy quay…), mặt cool boy không cười',
    intro: NAM2_INTRO,
    mood: 'cheeky opening',
    bagNote: 'Outfit 1 là đoạn mở đầu (chạy qua 2 cửa, kéo lệch mũ): nên nhập ô Mũ cho outfit 1. Bối cảnh nên có 2 cánh cửa trái / phải.',
  }),
  nam3: doorMotion({
    key: 'nam3',
    label: 'Chuyển động Nam 3 (trượt té rồi chạy ẻo lả)',
    name: 'Chuyển động Nam 3 (TÚI TUỲ OUTFIT) – "trượt té": 1 phân cảnh, THỜI LƯỢNG TỰ TÍNH (mở đầu 4,5s + ~1,5s mỗi outfit, 1–7 outfit, tối đa 14s): outfit 1 chạy ra từ cửa trái → trượt chân té ngồi phịch xuống sàn (hài, không đau) → lồm cồm đứng dậy phủi quần → nhìn máy quay xấu hổ e thẹn → chạy ẻo lả vào cửa phải → mỗi outfit sau 1 lượt như Nam 2 (bước vào từ dưới / trái / phải, mỗi lượt 1 dáng, mặt cool boy không cười)',
    intro: NAM3_INTRO,
    mood: 'slapstick comic opening',
    maxOutfits: 7,
    bagNote: 'Outfit 1 là đoạn mở đầu hài (trượt té → xấu hổ → chạy ẻo lả vào cửa phải). Bối cảnh nên có 2 cánh cửa trái / phải và sàn trơn bóng (cú trượt tự nhiên hơn).',
  }),
};


/** Thời lượng (giây, số nguyên) của chuyển động có thời lượng tự tính, theo số outfit. */
export const dynamicSeconds = (dyn, n) => Math.min(dyn.max, Math.max(3, Math.ceil(dyn.intro + dyn.per * (Math.max(1, n) - 1) - 1e-6)));

/**
 * Prompt mốc của chuyển động có thời lượng tự tính: giữ dòng không mốc + các mốc mở đầu (trước `intro`), chỉ giữ N-1 lượt đầu sau
 * mở đầu và chia đều chúng từ `intro` tới hết video (`sec`). 1 outfit: chỉ còn phần mở đầu (planScenes tự co giãn tới `sec`).
 */
export function dynamicPrompt(dyn, text, n, sec) {
  const { untimed, beats } = parseBeats(text);
  const head = beats.filter((b) => b.a < dyn.intro - 1e-6);
  const tail = beats.filter((b) => b.a >= dyn.intro - 1e-6);
  const turns = Math.max(1, n) - 1;
  if (turns > tail.length) throw new Error(`Chuyển động này có ${tail.length} lượt sau đoạn mở đầu nên nhận tối đa ${tail.length + 1} outfit (đang có ${n})`);
  const step = turns ? (sec - dyn.intro) / turns : 0;
  const t2 = (x) => (Math.round(x * 100) / 100).toString();
  return [
    ...untimed,
    ...head.map((b) => `${t2(b.a)}-${t2(b.b)}s: ${b.text}`),
    ...tail.slice(0, turns).map((b, i) => `${t2(dyn.intro + step * i)}-${t2(dyn.intro + step * (i + 1))}s: ${b.text}`),
  ].join('\n');
}

/**
 * Bố cục phân cảnh thật của 1 lần chạy: chuyển động thường = layouts[thời lượng]; chuyển động thời lượng tự tính = 1 phân cảnh dài
 * dynamicSeconds giây với prompt mốc đã cắt / chia lại (dynamicPrompt). Trả { layout, prompt } cho planScenes.
 */
export function layoutFor(m, dur, n, prompt) {
  if (!m.dynamic) return { layout: m.layouts[dur] || Object.values(m.layouts)[0], prompt };
  const sec = dynamicSeconds(m.dynamic, n);
  return {
    layout: [{ prompt: m.dynamic.prompt, duration: `${sec}s` }],
    prompt: (k) => (k === m.dynamic.prompt ? dynamicPrompt(m.dynamic, prompt(k), n, sec) : prompt(k)),
  };
}


/**
 * Kiểm tra khai báo 1 chuyển động (chạy khi nạp file cho mọi mục của MALE_MOTIONS): thiếu thì báo lỗi ngay lúc khởi động.
 * Bắt buộc: `bag` (true = chuyển động có túi, false = không túi, 'optional' = túi theo từng outfit), 1..MAX_SCENES phân cảnh mỗi
 * layout, prompt của từng phân cảnh có trong `prompts`; chuyển động không túi / túi tuỳ outfit thì mốc động tác không được nhắc
 * tới túi / ba lô (túi tuỳ outfit: dòng quy tắc tự nêu look nào có túi). Tuỳ chọn: `maxPerScene` (số outfit tối đa 1 phân cảnh),
 * `cutRule` ({ from: giây, jumpOnly }: chỉ đổi outfit ở các mốc từ `from` trở đi, chỉ mốc bắt đầu bằng "Jump cut").
 */
export function validateMotion(key, m) {
  const bad = (msg) => { throw new Error(`Chuyển động nam "${key}": ${msg}`); };
  if (!m?.name) bad('thiếu name');
  if (typeof m.bag !== 'boolean' && m.bag !== 'optional') bad("thiếu `bag` (true = có túi, false = không túi, 'optional' = túi theo từng outfit)");
  if (!(m.maxOutfits >= 1)) bad('thiếu maxOutfits');
  const layouts = Object.entries(m.layouts || {});
  if (!layouts.length) bad('thiếu layouts');
  for (const [dur, scenes] of layouts) {
    if (!Array.isArray(scenes) || !scenes.length || scenes.length > MAX_SCENES) bad(`layout "${dur}" phải có 1–${MAX_SCENES} phân cảnh`);
    for (const sc of scenes) {
      const text = m.prompts?.[sc.prompt]?.text;
      if (!text) bad(`layout "${dur}" dùng prompt "${sc.prompt}" nhưng không có trong prompts`);
      if (!sc.duration) bad(`layout "${dur}" thiếu duration của phân cảnh`);
      if (m.bag !== true && /\b(bag|backpack)\b/i.test(text)) bad(`khai báo ${m.bag === false ? 'không túi' : 'túi tuỳ outfit'} nhưng prompt "${sc.prompt}" có nhắc tới túi / ba lô`);
    }
  }
}
for (const [k, m] of Object.entries(MALE_MOTIONS)) validateMotion(k, m);

// Chuyển động mặc định; lần chạy cũ lưu chuyển động đã bỏ (vd. 'nam1') thì dùng chuyển động này
const DEFAULT_MOTION = 'nam2';
const motionOf = (run) => MALE_MOTIONS[run?.options?.motion] || MALE_MOTIONS[DEFAULT_MOTION];
// Kiểu túi của chuyển động: true | false | 'optional' (mỗi outfit quy về true / false bằng bagForLook)
const bagOfMotion = (key) => (MALE_MOTIONS[key] || MALE_MOTIONS[DEFAULT_MOTION]).bag;
const bagOf = (run) => motionOf(run).bag;
const durationOf = (run) => {
  const keys = Object.keys(motionOf(run).layouts);
  return keys.includes(run?.options?.duration) ? run.options.duration : keys[0];
};
const sceneCount = (run) => motionOf(run).layouts[durationOf(run)].length;
// Ô Thời lượng chỉ cho chuyển động thường; chuyển động thời lượng tự tính (dynamic) có 1 layout 'auto' và giao diện ẩn ô này
const ALL_DURATIONS = [...new Set(Object.values(MALE_MOTIONS).filter((m) => !m.dynamic).flatMap((m) => Object.keys(m.layouts)))];

// Tách prompt mốc giây: dòng "a-bs: …" -> beats, dòng khác -> untimed
export function parseBeats(text) {
  const untimed = [];
  const beats = [];
  for (const line of String(text || '').split('\n').map((l) => l.trim()).filter(Boolean)) {
    const m = line.match(/^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)s\s*:\s*(.*)$/);
    if (m) beats.push({ a: Number(m[1]), b: Number(m[2]), text: m[3] });
    else untimed.push(line);
  }
  return { untimed, beats };
}

/**
 * Dựng kế hoạch phân cảnh + chia outfit. layout = [{ prompt, duration }] (1..3 phân cảnh), prompt(key) = prompt mẫu đã đóng băng.
 * Trả { scenes: [{ index, duration, sec, untimed, beats, outfits }], beats (mọi mốc theo thứ tự toàn video), total }.
 * Mỗi mốc: { index, scene, a, b (giây cục bộ của phân cảnh), g (giây toàn video), text, outfit (thứ tự outfit đang mặc),
 * cut (true = mốc đổi sang outfit này) }.
 */
export function planScenes({ layout, prompt, outfitCount, maxPerScene = MAX_PER_SCENE, cutRule = null }) {
  if (!Array.isArray(layout) || !layout.length || layout.length > MAX_SCENES) throw new Error(`Chuyển động phải có 1–${MAX_SCENES} phân cảnh`);
  const scenes = [];
  const all = [];
  let offset = 0;
  layout.forEach((sc, si) => {
    const sec = parseFloat(sc.duration);
    const { untimed, beats } = parseBeats(prompt(sc.prompt));
    if (!beats.length) throw new Error(`Prompt "${sc.prompt}" không có mốc giây dạng "0.0-2.0s: …"`);
    const base = Math.max(...beats.map((b) => b.b));
    const k = base > 0 ? sec / base : 1;
    const scaled = beats.map((b) => ({ scene: si, a: b.a * k, b: b.b * k, g: offset + b.a * k, text: b.text, outfit: 0, cut: false }));
    scenes.push({ index: si, duration: sc.duration, sec, untimed, beats: scaled, outfits: [0] });
    all.push(...scaled);
    offset += sec;
  });
  const total = offset;
  const n = Math.max(1, outfitCount || 1);
  if (n > all.length) throw new Error(`Chuyển động này chỉ có ${all.length} mốc nên không chia được cho ${n} outfit`);
  if (cutRule) {
    // Chỉ đổi outfit ở các mốc ứng viên (từ giây `from`, chỉ mốc "Jump cut" nếu jumpOnly): outfit 2 luôn bắt đầu ở mốc ứng viên đầu
    // tiên, các outfit sau đổi ở mốc ứng viên gần mốc chia đều phần còn lại nhất
    const cand = all.map((b, j) => j).filter((j) => j > 0 && all[j].g >= cutRule.from - 1e-6 && (!cutRule.jumpOnly || /^jump cut\b/i.test(all[j].text)));
    if (n - 1 > cand.length) throw new Error(`Chuyển động này chỉ có ${cand.length + 1} chỗ đổi outfit nên nhận tối đa ${cand.length + 1} outfit (đang chọn ${n})`);
    const start = n > 1 ? all[cand[0]].g : 0;
    let from = 0;
    for (let i = 1; i < n; i++) {
      const target = i === 1 ? start : start + ((total - start) * (i - 1)) / (n - 1);
      let best = from;
      for (let c = from; c <= cand.length - (n - i); c++) if (Math.abs(all[cand[c]].g - target) < Math.abs(all[cand[best]].g - target)) best = c;
      all[cand[best]].cut = true;
      from = best + 1;
    }
  } else {
    // Mốc đổi đồ thứ i: mốc nhảy cắt gần T·i/N nhất, sau mốc đổi trước đó và chừa đủ mốc cho các outfit còn lại
    let from = 1;
    for (let i = 1; i < n; i++) {
      const target = (total * i) / n;
      let best = from;
      for (let j = from; j <= all.length - (n - i); j++) if (Math.abs(all[j].g - target) < Math.abs(all[best].g - target)) best = j;
      all[best].cut = true;
      from = best + 1;
    }
  }
  let cur = 0;
  all.forEach((b, j) => {
    if (b.cut) cur++;
    b.outfit = cur;
    b.index = j;
  });
  for (const s of scenes) {
    s.outfits = [...new Set(s.beats.map((b) => b.outfit))];
    if (s.outfits.length > maxPerScene) throw new Error(`Phân cảnh ${s.index + 1} phải mặc ${s.outfits.length} outfit — tối đa ${maxPerScene} outfit mỗi phân cảnh, bỏ bớt outfit hoặc chọn chuyển động nhiều phân cảnh hơn`);
  }
  return { scenes, beats: all, total };
}

// MẶT SAU CHỈ CHO OUTFIT CÓ QUAY LƯNG: outfit nào có mốc lộ lưng (dò theo câu chữ gốc của mốc) mới cần ảnh xem trước mặt sau và
// mới gửi ảnh đó lên Flow; outfit chỉ đứng đối diện máy quay thì không tạo ảnh mặt sau (đỡ thời gian, đỡ ảnh nguyên liệu thừa).
// Vd. Chuyển động Nam 1: chỉ mốc xoay người (outfit 1) lộ lưng -> outfit 2, 3 không cần mặt sau.
export const BACK_BEAT = /\bback (?:fully |turned |is )?to the camera\b|\bfrom behind\b|\bback view\b|\bturns? (?:around|away)\b|\b(?:full|slow) (?:spin|turn)\b|\bspins?\b/i;
export const backOutfits = (plan) => new Set(plan.beats.filter((b) => BACK_BEAT.test(b.text)).map((b) => b.outfit));

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
// "@ImageN (back @ImageM)" — outfit không cần mặt sau (tags.back = null) thì chỉ ghi ảnh mặt trước
const lookRef = (t) => (t.back ? `${t.front} (back ${t.back})` : t.front);

/**
 * Prompt 1 phân cảnh. looks[i] = { caption } · tags = { model, bg, start | null, look: { [outfit]: { front, back } } } theo thứ tự
 * ảnh của phân cảnh đó · texts = câu chữ các mốc đã qua bước "Xử lý prompt chuyển động" (theo index toàn video; thiếu thì dùng gốc).
 */
export function buildScenePrompt({ plan, sceneIndex, texts, looks, tags, captionMode = 'code', prompt, bag = true, captionStyle = null }) {
  const scene = plan.scenes[sceneIndex];
  const n = plan.scenes.length;
  const last = sceneIndex === n - 1;
  const ranges = scene.outfits.map((o) => {
    const bs = scene.beats.filter((b) => b.outfit === o);
    return { o, a: bs[0].a, b: bs.at(-1).b, caption: looks[o]?.caption || null, first: bs[0].text };
  });
  // Không outfit nào của phân cảnh có chữ -> phân cảnh không in chữ
  const mode = captionMode !== 'none' && ranges.some((r) => r.caption) ? captionMode : 'none';
  const vars = { MODEL: tags.model, BG: tags.bg, START: tags.start, PART: n === 1 ? 'One continuous take' : `Part ${sceneIndex + 1} of ${n}`, DUR: scene.duration };
  let setup = fill(setupFor((prompt('setup') || SETUP_NAM).trim(), mode), vars);
  // Chuyển động khai báo kiểu chữ riêng (caption.style): thay câu "Caption:" của phần mở đầu; caption.sides = chữ sát mép trái /
  // phải theo từng outfit (captionSides) thay cho giữa phía trên
  const sides = mode !== 'none' && captionStyle?.sides ? captionSides(ranges) : null;
  if (mode !== 'none' && captionStyle?.style) {
    const what = mode === 'code' ? 'the product code' : 'the caption text';
    const where = sides ? 'at mid-height near the left or right edge as listed below, never over him' : 'at the top-center';
    const sentence = `Caption: ${what} in a ${captionStyle.style}, ${where}.`;
    setup = CAPTION_SENTENCE.test(setup) ? setup.replace(CAPTION_SENTENCE, sentence) : `${setup} ${sentence}`;
  }
  const at = (i) => (sides ? ` (${sides[i]})` : '');
  // Câu về túi theo chuyển động: điền vào {BAG}; mẫu `rule` người dùng đã sửa không có {BAG} (hoặc để trống) thì nối vào cuối
  const rawRule = ruleFor((prompt('rule') ?? RULE_LOOK).trim(), mode);
  // Túi theo từng look (looks[o].hasBag, chuyển động túi tuỳ outfit); thiếu thông tin thì theo `bag` của chuyển động
  const hasBag = (o) => looks[o]?.hasBag ?? (bag === 'optional' ? false : !!bag);
  const withBag = ranges.filter((r) => hasBag(r.o));
  const bagLine = withBag.length === 0
    ? BAG_RULE.false
    : withBag.length === ranges.length
      ? BAG_RULE.true
      : bagRuleMixed(listEn(withBag.map((r) => tags.look[r.o].front)));
  const hasJump = scene.beats.some((b) => /jump cut/i.test(texts?.[b.index] || b.text));
  const rule = [
    rawRule.includes('{BAG}') ? rawRule.replace('{BAG}', bagLine) : [rawRule, bagLine].filter(Boolean).join(' '),
    // phân cảnh có đổi outfit thì câu cutNote đã nói "mỗi lần đổi là 1 cú cắt tức thì"
    hasJump && !scene.beats.some((b) => b.cut) ? 'Jump cuts are instant cuts.' : null,
    mode === 'none' || /no (other )?(on-screen )?text/i.test(rawRule) ? null : 'No text except the caption.',
  ].filter(Boolean).join(' ');
  const quote = (r) => (r.caption ? `"${r.caption}"` : 'no caption');
  const caption = mode === 'none'
    ? null
    : ranges.length === 1
      ? `Caption: "${ranges[0].caption}"${at(0)} for the whole clip.`
      : sides
        // chữ 2 bên (nhiều outfit, lượt ngắn): chỉ liệt kê theo thứ tự, không lặp lại khoảng giây (đã có ở từng mốc match cut)
        // outfit mở đầu không in mã: nói rõ không có chữ tới mốc đổi đồ đầu tiên
        ? (ranges[0].caption ? 'Caption, in order: ' : `Caption: no text at all until ${fmtT(ranges[1].a)}s, then in order: `) +
          ranges.slice(ranges[0].caption ? 0 : 1).map((r) => `${r.caption ? `"${r.caption}"` : 'no text'}${r.caption ? at(ranges.indexOf(r)) : ''}`).join(', ') +
          ', switching exactly on each match cut.'
        : 'Caption: ' + ranges.map((r, i) => `${fmtT(r.a)}-${fmtT(r.b)}s ${quote(r)}${r.caption ? at(i) : ''}`).join('; ') + ' (switches exactly on each match cut).';
  const startLine = !tags.start
    ? null
    : mode === 'none'
      ? `Opens exactly on ${tags.start} (last frame of the previous part: same pose, framing, background), then continues. ${tags.start} is a pose reference only: any text in it must not appear.`
      : `Opens exactly on ${tags.start} (last frame of the previous part: same pose, framing, background), then continues. ${tags.start} is a pose reference only: any text in it belongs to the previous part and must not appear; from the very first frame the caption reads ${quote(ranges[0])}.`;
  const single = tags.look[ranges[0].o];
  const wardrobe = ranges.length === 1
    // Outfit không cần mặt sau: bỏ cụm "(back {BACK})" khỏi mẫu
    ? fill((prompt('wardrobe_look') || WARDROBE_LOOK).trim().replace(single.back ? /$^/ : /\s*\(back(?: view)? \{BACK\}\)/, ''), { ...vars, OUTFIT: single.front, BACK: single.back || '' })
    : fill((prompt('wardrobe_looks') || WARDROBE_LOOKS).trim(), {
        ...vars,
        // Nhiều outfit (> 3): không liệt kê từng khoảng giây (các câu "Match cut: he now wears …" ở từng mốc đã nói) để prompt gọn
        WEAR: ranges.length > 3
          ? `${lookRef(tags.look[ranges[0].o])} first, then ${listEn(ranges.slice(1).map((r) => lookRef(tags.look[r.o])))} in that order, each from its match cut below`
          : ranges.map((r) => `${lookRef(tags.look[r.o])} at ${fmtT(r.a)}-${fmtT(r.b)}s`).join(', then '),
      });
  const lines = scene.beats.map((b) => {
    let t = (texts?.[b.index] || b.text).trim();
    if (b.cut) t = `Match cut: he now wears ${lookRef(tags.look[b.outfit])}. ${cap(t.replace(/^Jump cut,\s*/i, ''))}`;
    return `${fmtT(b.a)}-${fmtT(b.b)}s: ${t}`;
  });
  const cuts = scene.beats.filter((b) => b.cut).map((b) => `${fmtT(b.a)}s`);
  // Khoá số outfit: chỉ đổi đồ ở đúng các mốc match cut, không sinh thêm bộ nào khác. Nói rõ không đổi đồ giữa chừng: video
  // thử thật đã đổi sang outfit 2 ngay cuối cú xoay người (sớm ~2 giây) và đổi kiểu biến dần thay vì cắt gọn.
  const cutNote = cuts.length
    ? ` Clean match cut${cuts.length > 1 ? 's' : ''} ${cuts.length > 4 ? 'only at the Match cut lines' : `at ${cuts.length > 3 ? cuts.join(', ') : cuts.join(' and ')}`}: the only outfit change${cuts.length > 1 ? 's' : ''}, exactly ${ranges.length} looks, no other outfit. Each change is one instant cut, never a gradual morph or a change mid-movement.`
    : ' One outfit for the whole clip: it never changes.';
  const end = ` Sharp final frame at ${fmtT(scene.sec)}s${last ? '' : '; it is the first frame of the next part'}.`;
  return [setup, startLine, caption, wardrobe, ...scene.untimed.map((l) => fill(l, vars)), ...lines, `${rule}${cutNote}${end}`.trim()]
    .filter(Boolean)
    .join('\n');
}

// Câu "Caption: …" trong phần mở đầu (giống ./video-thoi-trang-khong-voice.js: setupFor)
const CAPTION_SENTENCE = /Caption:[^.]*\./;
// Bên đặt chữ cho từng outfit của phân cảnh: phía ĐỐI DIỆN bên nhân vật bước vào (vào từ trái / cửa trái -> chữ bên phải, vào từ
// phải -> chữ bên trái) để chữ không đè người; mốc không rõ hướng (nhô lên từ mép dưới…) thì đổi bên so với outfit trước.
export function captionSides(ranges) {
  let prev = 'left';
  return ranges.map((r) => {
    const t = String(r.first || '');
    const side = /\bleft (?:edge|door)\b|\bdoor on the left\b|\bfrom the left\b/i.test(t)
      ? 'right'
      : /\bright (?:edge|door)\b|\bdoor on the right\b|\bfrom the right\b/i.test(t)
        ? 'left'
        : prev === 'left' ? 'right' : 'left';
    prev = side;
    return side;
  });
}

const put = (text, vars) => text.replace(/\{([A-Z_]+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m));
const listEn = (a) => (a.length <= 1 ? a[0] || '' : a.slice(0, -1).join(', ') + ' and ' + a.at(-1));

/** Prompt ảnh xem trước mặt trước. items = [{ slot, front (đường dẫn | null), back }] các món đã nhập, theo thứ tự ảnh gửi Flow (sau ảnh KOL). */
// bag = chuyển động có túi (items đã bỏ ô Túi khi không túi, xem itemsOf): có túi mà không nhập -> AI phối và bắt buộc phải thấy
// túi; không túi -> cấm mọi loại túi.
export function buildLookPrompt({ template, items, style, bag = true }) {
  const inputs = ['image 1 = the man (identity and body reference only)'];
  items.forEach((it, i) => inputs.push(`image ${i + 2} = the ${it.slot.en}${it.front ? '' : ' (back view only: infer its front)'}`));
  const has = (k) => items.some((it) => it.slot.key === k);
  // ô đã nhập "che" ô khác (Bộ đồ = áo + quần): ô bị che không cần AI phối
  const covered = new Set(items.flatMap((it) => it.slot.covers || []));
  const notes = [
    has('set') ? ' The set photo shows both the top and the trousers: he wears both exactly as pictured, as one outfit.' : '',
    has('jacket') ? ' The outer jacket is worn open over the top so both stay visible.' : '',
    has('hat') ? ' He wears the cap on his head exactly as pictured, face fully visible.' : '',
  ].join('');
  const given = items.length
    ? `reproduce every given piece faithfully: same colour, pattern, print, logo, fabric, cut, length and details, worn naturally and clearly visible.${notes}`
    : 'none.';
  const missing = SLOTS.filter((s) => s.fill && !has(s.key) && !covered.has(s.key) && (bag || s.key !== 'bag')).map((s) => `the ${s.en}`);
  const parts = [];
  if (missing.length) parts.push(`no image is given for ${listEn(missing)}: choose ${missing.length > 1 ? 'these' : 'it'} yourself so the whole outfit looks coordinated and flattering${items.length ? ' with the given pieces' : ''} (exactly one of each, every one clearly visible in the photo).`);
  else parts.push('none: do not add other garments.');
  // Chuyển động không túi -> cấm túi. Có túi mà AI tự phối thì hay bị bỏ sót -> nói rõ phải đeo / cầm túi
  if (!bag) parts.push('No bag of any kind: no backpack, tote, crossbody or belt bag; his hands are free.');
  else if (!has('bag')) parts.push('He must visibly carry the bag (on one shoulder, across his body or in his hand).');
  if (!has('jacket')) parts.push('Do not add an outer jacket or coat.');
  parts.push(`Small accessories (belt, watch, socks${has('hat') ? '' : ', cap'} or glasses) only if they suit the style.`);
  return put(template, {
    INPUTS: inputs.join('; '),
    GIVEN: given,
    MISSING: parts.join(' '),
    STYLE: (style || '').trim() || DEFAULT_STYLE,
  });
}

/** Prompt ảnh xem trước mặt sau. backs = [{ slot }] các món có ảnh mặt sau, theo thứ tự ảnh gửi Flow (sau ảnh look mặt trước). */
export function buildLookBackPrompt({ template, backs, bag = true }) {
  const inputs = ['image 1 = the approved front-view photo of the man in the full outfit'];
  backs.forEach((it, i) => inputs.push(`image ${i + 2} = back view of the ${it.slot.en}`));
  const note = backs.length
    ? `match the back-view images exactly for ${listEn(backs.map((b) => `the ${b.slot.en}`))}; for every other piece continue its front design logically to the back.`
    : 'no back-view images are given: continue each garment\'s front design logically to the back (plain back unless the front implies otherwise).';
  const bagNote = bag ? 'The bag stays exactly where he carries it in image 1.' : 'He carries no bag: do not add one.';
  return put(template, { INPUTS: inputs.join('; '), BACKS: `${note} ${bagNote}` });
}

const mimeOf = (f) => ({ '.png': 'image/png', '.webp': 'image/webp' }[path.extname(f).toLowerCase()] || 'image/jpeg');

/**
 * "Xử lý prompt chuyển động": Gemini xem ảnh look từng outfit và sửa câu chữ về phụ kiện trong các mốc. Trả { texts, accessories }.
 * Ném lỗi khi Gemini trả sai số mốc / nội dung rỗng (bên gọi rơi về bản trung tính).
 */
// bag = true | false cho cả video, hoặc mảng true / false theo từng outfit (chuyển động túi tuỳ outfit)
export async function adaptBeats({ beats, lookPaths, rules, apiKey, model, bag = true }) {
  const list = beats.map((b, i) => `${i + 1}. [Outfit ${b.outfit + 1}] ${b.text}`).join('\n');
  const perLook = Array.isArray(bag) ? bag : null;
  if (perLook && perLook.every((x) => !x)) bag = false;
  if (perLook && perLook.every(Boolean)) bag = true;
  const mixed = Array.isArray(bag);
  const noBag = bag === false
    ? '\n\nIMPORTANT: in this video he carries NO bag. Never mention a bag, backpack or strap in any beat; use his pockets, collar, sleeves or hair instead.'
    : mixed
      ? `\n\nIMPORTANT: only Outfit ${perLook.map((x, i) => (x ? i + 1 : null)).filter(Boolean).join(', ')} include a bag (see their photos). Never mention a bag, backpack or strap in a beat of any other outfit.`
      : '';
  const text = put(rules, { N: String(lookPaths.length), BEATS: list }) + noBag;
  const parts = [{ text }];
  lookPaths.forEach((f, i) => {
    parts.push({ text: `Outfit ${i + 1}:` });
    parts.push({ inlineData: { mimeType: mimeOf(f), data: fs.readFileSync(f).toString('base64') } });
  });
  const out = await callGeminiWithFallback({
    apiKey,
    primaryModel: model,
    contents: [{ role: 'user', parts }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
    timeoutMs: 45_000,
  });
  const texts = Array.isArray(out?.beats) ? out.beats.map((t) => String(t || '').replace(/^\s*\d+\.\s*/, '').replace(/^\[Outfit \d+\]\s*/i, '').replace(/\s+/g, ' ').trim()) : null;
  if (!texts || texts.length !== beats.length) throw new Error(`Gemini trả ${texts ? texts.length : 0} mốc, cần ${beats.length}`);
  if (texts.some((t, i) => !t || t.length > beats[i].text.length + 160 || /@Image|\d\s*-\s*\d+(\.\d+)?s\b/.test(t))) throw new Error('Gemini trả mốc rỗng / quá dài / chứa mốc giây');
  if (bag === false && texts.some((t) => /\b(bag|backpack|strap)\b/i.test(t))) throw new Error('Gemini vẫn nhắc tới túi trong chuyển động không túi');
  if (mixed && texts.some((t, i) => !perLook[beats[i].outfit] && /\b(bag|backpack)\b/i.test(t))) throw new Error('Gemini nhắc tới túi ở outfit không có túi');
  const accessories = Array.isArray(out?.accessories) ? out.accessories.map((a) => String(a).replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, lookPaths.length) : [];
  return { texts, accessories };
}

const tagOf = (l) => l.code || l.caption || 'không chữ';
// Giá trị `main` của outfit KHÔNG in mã (chế độ "Mã sản phẩm"); giao diện: web/src/pages/MaleOutfits.jsx
export const NO_CODE = 'none';

// ---- Outfit: làm sạch đầu vào, chữ ký, job ảnh xem trước (dùng chung cho bước `look` của lần chạy và nút "Tạo ảnh outfit") ----
const assetById = (id) => (typeof id === 'string' ? db.assets.find((a) => a.id === id) || null : null);
const pathOf = (id) => assetById(id)?.path || null;
const cleanStyle = (v) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, 200);

/** Làm sạch 1 outfit gửi từ giao diện: chỉ giữ ảnh còn trong thư viện. */
export function cleanLook(l) {
  return {
    items: Object.fromEntries(
      SLOTS.map((s) => {
        const it = l?.items?.[s.key] || {};
        const front = assetById(it.front) ? it.front : null;
        const back = assetById(it.back) ? it.back : null;
        return [s.key, front || back ? { front, back } : null];
      }).filter(([, v]) => v),
    ),
    style: cleanStyle(l?.style),
    // main = ô món lấy mã in lên video; 'none' = outfit này KHÔNG in mã (vd. outfit mở đầu), các outfit khác vẫn in
    main: l?.main === NO_CODE || SLOTS.some((s) => s.key === l?.main) ? l.main : null,
    text: cleanCaptionText(l?.text), // chữ tuỳ ý in trên video khi mặc outfit này (captionMode 'text')
  };
}

/**
 * Chữ ký của 1 outfit = mọi thứ quyết định ảnh xem trước mặt trước: KOL/KOC, phong cách, ảnh dùng cho từng ô món (mặt trước, không
 * có thì mặt sau). Ảnh tạo bằng nút "Tạo ảnh outfit" mang chữ ký này (asset.lookSig); lần chạy chỉ dùng lại ảnh khi chữ ký còn khớp.
 * Giao diện tính y hệt (web/src/pages/MaleOutfits.jsx: lookSigOf).
 */
// bag = chuyển động có túi. Không túi: ô Túi không tính và chữ ký có đuôi "|nobag" (ảnh outfit có túi không dùng cho chuyển
// động không túi và ngược lại); có túi: giữ định dạng cũ.
// Ô thêm sau (extra: Bộ đồ, Mũ) chỉ nối vào khi có ảnh ("|set=<id>") -> outfit không dùng ô mới giữ đúng chữ ký cũ.
const slotPic = (look, s) => look?.items?.[s.key]?.front || look?.items?.[s.key]?.back || '';
export const lookSig = (modelId, look, bag = true) =>
  [
    modelId || '',
    cleanStyle(look?.style),
    ...SLOTS.filter((s) => !s.extra).map((s) => (!bag && s.key === 'bag' ? '' : slotPic(look, s))),
  ].join('|') +
  SLOTS.filter((s) => s.extra && slotPic(look, s)).map((s) => `|${s.key}=${slotPic(look, s)}`).join('') +
  (bag ? '' : '|nobag');

// Các món đã nhập của 1 outfit (đã làm sạch), kèm đường dẫn file ảnh, theo thứ tự SLOTS; chuyển động không túi thì bỏ ô Túi
const itemsOf = (l, bag = true) =>
  SLOTS.filter((slot) => bag || slot.key !== 'bag')
    .map((slot) => {
      const it = l.items?.[slot.key];
      return { slot, frontId: it?.front || null, backId: it?.back || null, front: pathOf(it?.front), back: pathOf(it?.back) };
    })
    .filter((it) => it.front || it.back);

// Job ảnh xem trước mặt trước: ảnh = [KOL/KOC, ảnh từng món đã nhập]; prompt tự ghép theo món đã nhập / món AI phối / phong cách / túi
const lookJobSpec = ({ modelPath, items, style, template, videoLabel, bag = true, meta = {} }) => ({
  type: 'image',
  imagePaths: [modelPath, ...items.map((it) => it.front || it.back)],
  template: buildLookPrompt({ template, items, style, bag }),
  videoLabel,
  meta: { aspectRatio: '9:16', imageQuality: '2K', kind: 'lookbook', ...meta },
});

/**
 * Nút "Tạo ảnh outfit" trong thẻ outfit (trước khi chạy quy trình): job ảnh KOL/KOC mặc đủ bộ. Trả spec cho createJob;
 * meta.lookPreview = chữ ký outfit (hook ở server/index.js lưu ảnh kết quả vào thư viện kèm lookSig).
 * template = mẫu `look` người dùng đã sửa (nếu có).
 */
export function lookPreviewSpec({ model, look, template, motion }) {
  const m = assetById(model);
  if (!m) throw new Error('Chọn ảnh KOL/KOC trước khi tạo ảnh outfit');
  const clean = cleanLook(look);
  // túi theo chuyển động đang chọn trên giao diện; túi tuỳ outfit -> outfit này có ảnh túi hay không
  const bag = bagForLook(bagOfMotion(motion), clean);
  const items = itemsOf(clean, bag);
  return lookJobSpec({
    modelPath: m.path,
    items,
    style: clean.style,
    template: (template || '').trim() || LOOK_PROMPT,
    videoLabel: `Ảnh outfit (${items.length ? items.map((it) => it.slot.label.toLowerCase()).join(' + ') : 'AI phối cả bộ'}${bag ? '' : ', không túi'}) – ${m.name}`,
    bag,
    meta: { lookPreview: lookSig(model, clean, bag), lookModel: model },
  });
}

// Các outfit của lần chạy: ảnh từng món (đường dẫn file), mã sản phẩm của món chính và chữ in trên video theo options.captionMode
//  'code' = mã của món chính (món `main` hoặc món đầu tiên có ảnh), chưa có thì cấp mới; outfit không có món nào thì không in chữ
//  'text' = chữ của chính outfit đó (looks[i].text); để trống thì dùng chữ của outfit trước · 'none' = không in chữ
function resolveLooks(ctx) {
  const mode = captionModeOf(ctx.run.options);
  const motionBag = bagOf(ctx.run);
  let lastText = '';
  return (ctx.inputs.looks || []).map((l, i) => {
    // chuyển động không túi: ô Túi không dùng (kể cả làm món in mã); túi tuỳ outfit: outfit có ảnh túi mới có túi
    const bag = bagForLook(motionBag, l);
    const items = itemsOf(l, bag);
    // main 'none' = outfit không in mã (chế độ mã): không cấp mã, phân cảnh ghi "no caption" cho khoảng thời gian của outfit này
    const noCode = l.main === NO_CODE;
    const main = noCode ? null : items.find((it) => it.slot.key === l.main) || items[0] || null;
    const mainId = main ? main.frontId || main.backId : null;
    const code = mainId ? codeOfAsset(mainId) || (mode === 'code' ? assignCode(mainId).productCode : null) : null;
    let caption = null;
    if (mode === 'code') caption = code;
    if (mode === 'text') {
      caption = cleanCaptionText(l.text) || lastText;
      if (!caption) throw new Error(`Chưa nhập chữ in trên video cho outfit ${i + 1} — nhập ở ô "Chữ trên video" hoặc đổi sang "Mã sản phẩm" / "Không chữ"`);
      lastText = caption;
    }
    // preview = ảnh outfit người dùng đã tạo sẵn ở thẻ outfit (prepareInputs đã kiểm tra chữ ký); mất khỏi thư viện thì tạo lại
    return { index: i, items, style: l.style || '', code, caption, hasBag: bag, preview: assetById(l.preview) ? l.preview : null };
  });
}

const planOf = (ctx, n) => planScenes({
  ...layoutFor(motionOf(ctx.run), durationOf(ctx.run), n, (k) => ctx.prompt(k)),
  outfitCount: n,
  maxPerScene: motionOf(ctx.run).maxPerScene || MAX_PER_SCENE,
  cutRule: motionOf(ctx.run).cutRule || null,
});

// Lưu ảnh xem trước của từng outfit vào thư viện (loại lookbook, có flowTitle để bước video dùng lại ngay trên Flow);
// thử lại / chọn lần tạo khác ra file mới thì lưu thêm bản mới. state.assets[i] = { id, from: file kết quả đã lưu }
// jobs = mảng theo chỉ số outfit; phần tử null = outfit không có job ở bước này (dùng ảnh tạo sẵn)
function registerLooks(ctx, jobs, nameOf) {
  const assets = (ctx.state.assets ||= {});
  jobs.forEach((job, i) => {
    if (!job || job.status !== 'done' || !job.outputPath || assets[i]?.from === job.outputPath) return;
    const att = job.attempts.find((a) => a.outputPath === job.outputPath);
    const a = ctx.registerAsset('lookbook', job.outputPath, nameOf(i), { flowTitle: att?.flowTitle || null, fromJobId: job.id });
    assets[i] = { id: a.id, from: job.outputPath };
  });
}

// Bước video của phân cảnh k (1..MAX_SCENES); chỉ chạy khi layout của chuyển động có đủ k phân cảnh
const sceneStage = (k) => ({
  id: `scene${k}`,
  label: `Phân cảnh ${k}`,
  hideWhenSkipped: true,
  when: (run) => sceneCount(run) >= k,
  async run(ctx) {
    const looks = resolveLooks(ctx);
    const plan = planOf(ctx, looks.length);
    const scene = plan.scenes[k - 1];
    const model = ctx.assetPath(ctx.inputs.model);
    const bg = ctx.assetPath(ctx.inputs.background);
    if (!model) throw new Error('Ảnh KOL/KOC không còn trong thư viện');
    if (!bg) throw new Error('Ảnh bối cảnh không còn trong thư viện');
    const fronts = ctx.stages.look?.assets || {};
    const backs = ctx.stages.look_back?.assets || {};
    const needBack = backOutfits(plan); // chỉ outfit có mốc quay lưng mới gửi ảnh mặt sau
    const pairs = Object.fromEntries(scene.outfits.map((i) => {
      const f = ctx.assetPath(fronts[i]?.id);
      const b = needBack.has(i) ? ctx.assetPath(backs[i]?.id) : null;
      if (!f || (needBack.has(i) && !b)) throw new Error(`Ảnh xem trước của outfit ${i + 1} không còn trong thư viện — tạo lại ảnh xem trước`);
      return [i, { f, b }];
    }));
    let start = null;
    if (k > 1) {
      start = ctx.stages[`frame${k - 1}`]?.path;
      if (!start || !fs.existsSync(start)) throw new Error(`Chưa có khung hình cuối của phân cảnh ${k - 1}`);
    }
    const images = [model, ...scene.outfits.flatMap((i) => (pairs[i].b ? [pairs[i].f, pairs[i].b] : [pairs[i].f])), bg, ...(start ? [start] : [])];
    const tag = (f) => `@Image${images.indexOf(f) + 1}`;
    const captionMode = captionModeOf(ctx.run.options);
    const template = buildScenePrompt({
      plan,
      sceneIndex: k - 1,
      texts: ctx.stages.motion_prompt?.texts,
      looks,
      tags: { model: '@Image1', bg: tag(bg), start: start ? tag(start) : null, look: Object.fromEntries(scene.outfits.map((i) => [i, { front: tag(pairs[i].f), back: pairs[i].b ? tag(pairs[i].b) : null }])) },
      captionMode,
      prompt: (key) => ctx.prompt(key),
      bag: bagOf(ctx.run),
      captionStyle: motionOf(ctx.run).caption || null,
    });
    ctx.state.prompt = template;
    ctx.state.codes = looks.map(tagOf);
    const worn = scene.outfits.map((i) => looks[i]);
    const job = ctx.ensureJob(`video:scene${k}`, {
      type: 'video',
      imagePaths: images,
      template,
      videoLabel: `[${worn.map(tagOf).join('+')}] Nam không voice · ${plan.scenes.length === 1 ? `1 phân cảnh ${scene.duration}` : `Phân cảnh ${k}/${plan.scenes.length}`} – ${ctx.assetName(ctx.inputs.model)}`,
      meta: {
        aspectRatio: '9:16',
        flowVideoModel: ctx.run.options.flowModel || FASHION_MODELS[0],
        flowDuration: scene.duration,
        flowResolution: '720p',
        codes: worn.map((l) => l.code).filter(Boolean),
        captionMode,
        ...(start ? { startFrame: start } : {}),
      },
    });
    if (job.status === 'failed') throw ctx.jobError(job);
    if (job.status !== 'done') return 'waiting';
    return 'done';
  },
});

// Cắt khung hình cuối của phân cảnh k để mở phân cảnh k+1 (xoá dải chữ phía trên, nếu không Flow chép chữ cũ sang phân cảnh sau)
const frameStage = (k) => ({
  id: `frame${k}`,
  label: `Cắt khung hình cuối phân cảnh ${k}`,
  hideWhenSkipped: true,
  when: (run) => sceneCount(run) > k,
  async run(ctx) {
    const j = ctx.job(`video:scene${k}`);
    if (!j?.outputPath || !fs.existsSync(j.outputPath)) throw new Error(`Chưa có video phân cảnh ${k} để cắt khung hình cuối`);
    if (!ctx.state.path || ctx.state.from !== j.outputPath || !fs.existsSync(ctx.state.path)) {
      const raw = path.join(DIRS.tmp, `nam-last-${j.id}-${Date.now()}.png`);
      await extractLastFrame(j.outputPath, raw);
      const clean = raw.replace(/\.png$/, '-clean.png');
      try {
        await removeCaptionBand(raw, clean);
        ctx.state.path = clean;
      } catch (e) {
        console.error('Xoá dải chữ khung hình cuối lỗi, dùng ảnh gốc:', e.message);
        ctx.state.path = raw;
      }
      ctx.state.rawPath = raw;
      ctx.state.from = j.outputPath;
    }
    return 'done';
  },
});

export default {
  id: 'video-thoi-trang-khong-voice-nam',
  name: 'Video thời trang không voice – Nam',
  icon: '🤫',
  noVideo: true,
  tab: { group: 'khong-voice', label: '👨 Nam', title: 'Video bán hàng thời trang không voice' },
  captionModes: true,
  // Giao diện vẽ khối "Outfit" (mỗi outfit: các ô món, mỗi ô mặt trước + mặt sau) và gửi inputs[key] = [{ items, style, main, text }]
  outfitSets: { key: 'looks', slots: SLOTS.map(({ key, label, fill, covers, extra }) => ({ key, label, fill, covers: covers || null, extra: !!extra })) },
  // Job ảnh xem trước hiện trên thẻ lần chạy (khoá job bắt đầu bằng prefix)
  previewJobs: [
    { prefix: 'look:', label: 'Ảnh xem trước – mặt trước' },
    { prefix: 'look_back:', label: 'Ảnh xem trước – mặt sau' },
  ],
  // Outfit dùng ảnh tạo sẵn ở thẻ outfit (không có job mặt trước trong lần chạy): hiện cùng nhóm với các job "look:"
  previewAssets(run) {
    const saved = run.stages.look?.assets || {};
    return (run.inputs.looks || [])
      .map((l, i) => (saved[i]?.preset ? { key: `look:front:${i}`, label: `Outfit ${i + 1} – ảnh tạo sẵn ở ô nhập`, assetId: saved[i].id } : null))
      .filter(Boolean);
  },
  reviewNote: 'Ảnh xem trước KOL/KOC mặc từng outfit đã tạo xong (0 credit). Chưa ưng thì bấm Thử lại / Sửa prompt hoặc chọn lần tạo khác ngay trên thẻ ảnh (đổi ảnh mặt trước thì ảnh mặt sau tự tạo lại). Video sẽ mặc đúng các ảnh này: chuyển động CÓ TÚI thì kiểm tra nhân vật trong ảnh đã có túi, chuyển động KHÔNG TÚI thì ảnh không được có túi. Ưng rồi bấm Tiếp tục: xử lý prompt chuyển động rồi tạo video (bước này bắt đầu tốn credit).',
  resumeLabel: '▶ Tiếp tục: xử lý prompt chuyển động & tạo video',
  runLabel: '▶ Tạo ảnh xem trước outfit (0 credit)',
  sceneJobs: Array.from({ length: MAX_SCENES }, (_, i) => ({
    key: `video:scene${i + 1}`,
    label: `Phân cảnh ${i + 1}`,
    note: 'Thử lại / đổi bản → làm lại các phân cảnh phía sau (nếu có) và ghép lại.',
  })),
  description: 'Ảnh KOL/KOC + bối cảnh + các outfit (số outfit tối đa theo chuyển động / thời lượng; mỗi outfit: áo, quần, áo khoác, giày, túi, bộ đồ áo + quần chung 1 ảnh, mũ — mặt trước + mặt sau, không ô nào bắt buộc; món thiếu AI tự phối theo phong cách) → ảnh xem trước KOL/KOC mặc từng outfit (0 credit) → bạn duyệt → xử lý prompt chuyển động → video không voice, đổi outfit ở các cú nhảy cắt, mã sản phẩm đổi theo outfit.',
  inputs: [
    { key: 'model', kind: 'model', label: 'Ảnh KOL/KOC nam (@Image1)', required: true },
    { key: 'background', kind: 'background', label: 'Ảnh bối cảnh', required: true },
  ],
  // Kiểm tra / làm sạch danh sách outfit (runner.createRun gọi): chỉ giữ ảnh còn trong thư viện; luôn có ít nhất 1 outfit
  // (outfit không có món nào = AI phối cả bộ theo phong cách)
  prepareInputs(inputs, options = {}) {
    const raw = Array.isArray(inputs?.looks) ? inputs.looks : [];
    const motion = motionOf({ options });
    const looks = raw.map((l) => {
      const look = cleanLook(l);
      const bag = bagForLook(motion.bag, look);
      // Ảnh outfit tạo sẵn (nút "Tạo ảnh outfit"): chỉ dùng khi còn trong thư viện và đúng với KOL/KOC + món + phong cách + kiểu
      // túi của chuyển động hiện tại; không khớp thì bỏ, lần chạy tự tạo ảnh mới
      const pre = assetById(l?.preview);
      if (pre?.lookSig && pre.lookSig === lookSig(inputs?.model, look, bag)) look.preview = pre.id;
      return look;
    });
    if (!looks.length) looks.push({ items: {}, style: '', main: null, text: '' });
    const dur = durationOf({ options });
    const max = motion.maxOutfitsByDuration?.[dur] ?? motion.maxOutfits;
    if (looks.length > max) throw new Error(`"${motion.name.split(' – ')[0]}" ${motion.maxOutfitsByDuration ? `bản ${dur} ` : ''}nhận tối đa ${max} outfit (đang có ${looks.length}) — bỏ bớt outfit${motion.maxOutfitsByDuration ? ', chọn thời lượng dài hơn' : ''} hoặc đổi chuyển động`);
    return { looks };
  },
  prompts: {
    look: { label: 'Ảnh xem trước – MẶT TRƯỚC: KOL/KOC mặc đủ bộ ({INPUTS} = danh sách ảnh, {GIVEN} = món đã nhập, {MISSING} = món AI tự phối, {STYLE} = phong cách)', text: LOOK_PROMPT },
    look_back: { label: 'Ảnh xem trước – MẶT SAU của đúng bộ đó ({INPUTS}, {BACKS} = ghi chú ảnh mặt sau các món)', text: LOOK_BACK_PROMPT },
    adapt: { label: 'Xử lý prompt chuyển động – luật cho Gemini sửa câu chữ phụ kiện theo ảnh xem trước ({N} = số outfit, {BEATS} = các mốc)', text: ADAPT_PROMPT },
    setup: { label: 'Video – phần mở đầu mỗi phân cảnh ({PART}, {DUR}, {MODEL}, {BG})', text: SETUP_NAM },
    wardrobe_look: { label: 'Video – khoá trang phục khi phân cảnh chỉ có 1 outfit ({OUTFIT}/{BACK} = ảnh xem trước mặt trước / sau)', text: WARDROBE_LOOK },
    wardrobe_looks: { label: 'Video – khoá trang phục khi phân cảnh có nhiều outfit ({WEAR} = outfit theo từng khoảng giây)', text: WARDROBE_LOOKS },
    ...Object.fromEntries(Object.values(MALE_MOTIONS).flatMap((m) => Object.entries(m.prompts))),
    rule: { label: 'Video – dòng quy tắc ngắn cuối mỗi phân cảnh (để trống nếu không cần)', text: RULE_LOOK },
  },
  options: [
    {
      key: 'motion',
      label: 'Chuyển động (kịch bản tay chân)',
      // bag: chuyển động có túi (giao diện bật / tắt ô Túi và báo ảnh outfit cũ khi đổi kiểu túi)
      // backOutfits[thời lượng][số outfit] = thứ tự các outfit có mốc quay lưng (giao diện ghi chú outfit nào cần ảnh mặt sau);
      // tính theo prompt mặc định — lần chạy thật tính lại theo prompt đã đóng băng
      options: Object.entries(MALE_MOTIONS).map(([k, m]) => ({
        value: k,
        label: m.name,
        minOutfits: 1,
        maxOutfits: m.maxOutfits,
        maxOutfitsByDuration: m.maxOutfitsByDuration || null,
        durations: m.dynamic ? [] : Object.keys(m.layouts),
        // thời lượng tự tính: giao diện ẩn ô Thời lượng và hiện số giây theo số outfit (dynamicSeconds)
        dynamic: m.dynamic ? { intro: m.dynamic.intro, per: m.dynamic.per, max: m.dynamic.max } : null,
        bag: m.bag,
        bagNote: m.bagNote || null,
        backOutfits: Object.fromEntries(Object.entries(m.layouts).map(([dur, layout]) => [dur, Object.fromEntries(
          Array.from({ length: m.maxOutfits }, (_, i) => {
            try {
              const plan = planScenes({ ...layoutFor(m, dur, i + 1, (key) => m.prompts[key]?.text || ''), outfitCount: i + 1, maxPerScene: m.maxPerScene || MAX_PER_SCENE, cutRule: m.cutRule || null });
              return [i + 1, [...backOutfits(plan)]];
            } catch { return [i + 1, null]; }
          }),
        )])),
      })),
      default: DEFAULT_MOTION,
    },
    { key: 'duration', label: 'Thời lượng video', options: ALL_DURATIONS.map((d) => ({ value: d, label: d })), default: ALL_DURATIONS[0] },
    { key: 'flowModel', label: 'Mô hình Flow', options: FASHION_MODELS.map((m) => ({ value: m, label: m })), default: FASHION_MODELS[0] },
    { key: 'removeWatermark', label: 'Tự động xoá logo Gemini khi ghép', default: true },
    { key: 'autoPublish', label: 'Tự động chuyển sang Đăng video khi hoàn thành', default: true },
  ],
  // options.captionMode ('code' | 'text' | 'none') do khối Outfit trên giao diện gửi kèm (xem ../caption.js)

  stages: [
    {
      id: 'look',
      label: 'Ảnh xem trước (mặt trước)',
      async run(ctx) {
        const model = ctx.assetPath(ctx.inputs.model);
        if (!model) throw new Error('Ảnh KOL/KOC không còn trong thư viện');
        const looks = resolveLooks(ctx);
        planOf(ctx, looks.length); // báo lỗi sớm nếu số outfit không hợp với chuyển động
        const name = ctx.assetName(ctx.inputs.model);
        const assets = (ctx.state.assets ||= {});
        const jobs = looks.map((l, i) => {
          // Outfit đã có ảnh tạo sẵn ở thẻ outfit -> dùng đúng ảnh đó, không tạo job
          if (l.preview) {
            if (assets[i]?.id !== l.preview) assets[i] = { id: l.preview, from: pathOf(l.preview), preset: true };
            return null;
          }
          return ctx.ensureJob(`look:front:${i}`, lookJobSpec({
            modelPath: model,
            items: l.items,
            style: l.style,
            template: ctx.prompt('look'),
            videoLabel: `Outfit ${i + 1}${l.code ? ` [${l.code}]` : ''} – xem trước mặt trước – ${name}`,
            bag: l.hasBag,
            meta: { lookIndex: i },
          }));
        });
        registerLooks(ctx, jobs, (i) => `Outfit ${i + 1}${looks[i].code ? ` [${looks[i].code}]` : ''} – ${name} (xem trước)`);
        return ctx.waitAll(jobs.filter(Boolean));
      },
    },
    {
      id: 'look_back',
      label: 'Ảnh xem trước (mặt sau)',
      async run(ctx) {
        const looks = resolveLooks(ctx);
        const fronts = ctx.stages.look?.assets || {};
        const name = ctx.assetName(ctx.inputs.model);
        // Chỉ outfit có mốc quay lưng trong chuyển động mới cần ảnh mặt sau (vd. Chuyển động Nam 1: chỉ outfit 1)
        const needBack = backOutfits(planOf(ctx, looks.length));
        ctx.state.needBack = [...needBack];
        const jobs = looks.map((l, i) => {
          const front = ctx.assetPath(fronts[i]?.id);
          if (!front) throw new Error(`Ảnh xem trước mặt trước của outfit ${i + 1} không còn trong thư viện`);
          if (!needBack.has(i)) return null;
          const backs = l.items.filter((it) => it.back);
          return ctx.ensureJob(`look_back:back:${i}`, {
            type: 'image',
            imagePaths: [front, ...backs.map((it) => it.back)],
            template: buildLookBackPrompt({ template: ctx.prompt('look_back'), backs, bag: l.hasBag }),
            videoLabel: `Outfit ${i + 1}${l.code ? ` [${l.code}]` : ''} – xem trước mặt sau – ${name}`,
            meta: { aspectRatio: '9:16', imageQuality: '2K', lookIndex: i, kind: 'lookbook' },
          });
        });
        registerLooks(ctx, jobs, (i) => `Outfit ${i + 1}${looks[i].code ? ` [${looks[i].code}]` : ''} – ${name} (xem trước mặt sau)`);
        return ctx.waitAll(jobs.filter(Boolean));
      },
    },
    {
      id: 'review',
      label: 'Duyệt ảnh xem trước',
      async run(ctx) {
        return ctx.state.approved ? 'done' : 'paused';
      },
    },
    {
      id: 'motion_prompt',
      label: 'Xử lý prompt chuyển động',
      async run(ctx) {
        const looks = resolveLooks(ctx);
        const plan = planOf(ctx, looks.length);
        const fronts = ctx.stages.look?.assets || {};
        const paths = looks.map((_, i) => ctx.assetPath(fronts[i]?.id));
        if (paths.some((p) => !p)) throw new Error('Ảnh xem trước không còn trong thư viện — tạo lại ảnh xem trước');
        const sig = [ctx.run.options.motion, durationOf(ctx.run), ...paths, ...plan.beats.map((b) => b.text)].join('|');
        if (ctx.state.sig !== sig || !ctx.state.texts) {
          const apiKey = db.settings.geminiApiKey || process.env.GEMINI_API_KEY || '';
          let texts = null;
          let note;
          if (!apiKey) note = 'Chưa có Gemini API key trong Cài đặt → dùng bản trung tính (động tác nhắc tới món có thể không có trong outfit, vd. mở áo khoác, đổi thành động tác chung).';
          else {
            try {
              const out = await adaptBeats({ beats: plan.beats, lookPaths: paths, rules: ctx.prompt('adapt'), apiKey, model: db.settings.geminiModel || 'gemini-2.5-flash', bag: looks.map((l) => l.hasBag) });
              texts = out.texts;
              const changed = texts.filter((t, i) => t !== plan.beats[i].text).length;
              note = `Gemini đã chỉnh ${changed}/${texts.length} mốc theo phụ kiện trong ảnh xem trước${out.accessories.length ? ` — ${out.accessories.join(' · ')}` : ''}.`;
            } catch (e) {
              note = `Gemini lỗi (${String(e.message).slice(0, 140)}) → dùng bản trung tính (động tác nhắc tới món có thể không có trong outfit đổi thành động tác chung).`;
            }
          }
          ctx.state.texts = texts || plan.beats.map((b) => neutralize(b.text));
          ctx.state.note = note;
          ctx.state.sig = sig;
        }
        return 'done';
      },
    },
    sceneStage(1),
    frameStage(1),
    sceneStage(2),
    frameStage(2),
    sceneStage(3),
    {
      id: 'merge',
      label: 'Ghép phân cảnh & xoá logo',
      async run(ctx) {
        const n = sceneCount(ctx.run);
        const jobs = Array.from({ length: n }, (_, i) => ctx.job(`video:scene${i + 1}`));
        if (jobs.some((j) => !j?.outputPath)) throw new Error('Thiếu video của một phân cảnh');
        const codes = ctx.stages.scene1?.codes || [];
        return ctx.ensureMerge({
          jobIds: jobs.map((j) => j.id),
          name: `[${codes.join('+')}] Video thời trang nam không voice – ${ctx.assetName(ctx.inputs.model)}`,
          removeWatermark: ctx.run.options.removeWatermark ?? true,
          keepOriginalAudio: false,
        });
      },
    },
  ],

  // Đồng bộ khi kết quả 1 bước đổi (Thử lại = thêm lần tạo vào CÙNG job, chọn lần tạo khác, xoá lần tạo). Mỗi bước ghi lại
  // `from` = file kết quả đã dùng, nên mỗi kết quả mới chỉ kích hoạt làm lại ĐÚNG 1 LẦN (không lặp vô hạn, không tốn credit thừa):
  //  - ảnh xem trước mặt trước của outfit i đổi -> lưu ảnh mới, tạo lại ảnh mặt sau i (job mới vì ảnh đầu vào đổi), duyệt lại,
  //    xử lý lại prompt và tạo lại mọi phân cảnh;
  //  - ảnh xem trước mặt sau đổi -> lưu ảnh mới, duyệt lại, tạo lại mọi phân cảnh;
  //  - video phân cảnh K (chưa phải cuối) đổi -> cắt lại khung hình cuối, tạo lại các phân cảnh sau K, ghép lại;
  //  - video phân cảnh cuối đổi -> chỉ ghép lại.
  // Đang dừng chờ duyệt mà ảnh xem trước đổi thì chạy tiếp để tạo lại ảnh phụ thuộc, rồi lại dừng ở bước duyệt.
  sync(run) {
    const jobsMap = (run.stages._jobs ||= {});
    const jobOf = (k) => (jobsMap[k] ? db.jobs.find((j) => j.id === jobsMap[k]) : null);
    const n = sceneCount(run);
    let changed = false;
    const redo = (id, fresh = false) => {
      const st = run.stages[id];
      if (!st || st.status === 'skipped') return;
      if (fresh) {
        if (st.status !== 'pending' || Object.keys(st).length > 1) { run.stages[id] = { status: 'pending' }; changed = true; }
      } else if (st.status !== 'pending') { st.status = 'pending'; changed = true; }
    };
    const drop = (k) => { if (jobsMap[k]) { delete jobsMap[k]; changed = true; } };
    const redoScenes = (fromK) => {
      for (let k = fromK; k <= MAX_SCENES; k++) {
        drop(`video:scene${k}`);
        redo(`scene${k}`);
        if (k < MAX_SCENES) redo(`frame${k}`);
      }
      redo('merge', true);
    };

    const count = (run.inputs.looks || []).length;
    let upstream = false;
    for (let i = 0; i < count; i++) {
      const jf = jobOf(`look:front:${i}`);
      const savedF = run.stages.look?.assets?.[i];
      if (jf?.outputPath && savedF?.from && savedF.from !== jf.outputPath) {
        redo('look');
        drop(`look_back:back:${i}`);
        redo('look_back');
        upstream = true;
      }
      const jb = jobOf(`look_back:back:${i}`);
      const savedB = run.stages.look_back?.assets?.[i];
      if (jb?.outputPath && savedB?.from && savedB.from !== jb.outputPath) {
        redo('look_back');
        upstream = true;
      }
    }
    if (upstream) {
      redo('review', true);
      redo('motion_prompt');
      redoScenes(1);
      if (run.status === 'paused') { run.status = 'running'; changed = true; }
      return changed;
    }

    for (let k = 1; k < n; k++) {
      const fr = run.stages[`frame${k}`];
      const jk = jobOf(`video:scene${k}`);
      if (jk?.outputPath && fr?.from && fr.from !== jk.outputPath) {
        redo(`frame${k}`);
        redoScenes(k + 1);
        return changed;
      }
    }
    const ms = run.stages.merge;
    const merge = ms?.mergeId && db.merges.find((m) => m.id === ms.mergeId);
    if (merge?.inputPaths) {
      const current = Array.from({ length: n }, (_, i) => jobOf(`video:scene${i + 1}`)?.outputPath);
      if (current.every(Boolean) && current.some((p, i) => p !== merge.inputPaths[i])) { run.stages.merge = { status: 'pending' }; changed = true; }
    }
    return changed;
  },
};
