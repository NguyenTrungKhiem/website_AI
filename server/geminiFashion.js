import fs from 'node:fs';
import path from 'node:path';
import { fetch } from 'undici';

// Prompt gốc mặc định (xem docs/prompt-goc-mau-thoi-trang.md): phần tiếng Anh (Setup, mốc giây, hành động, @Image,
// TODAY'S OUTFIT, Technical Rule) là chuẩn và KHÔNG bao giờ bị sửa; prompt viết chung chung về trang phục ("the @Image2 outfit")
// nên dùng được cho mọi sản phẩm. Khi "Phân tích Sản phẩm & Dựng 2 Prompt", Gemini CHỈ viết lại các câu Voice: "..." tiếng Việt
// cho khớp sản phẩm và hành động của từng mốc; Voice: [Silent] giữ nguyên.
export const DEFAULT_FASHION_SCENE1_TEMPLATE = `Setup (10s): Full 10s Korean KOC clip (Part 1), static camera, Vietnamese female voice with lip-sync, 20pt white serif title "TODAY'S OUTFIT" at top-center fifth. Strictly lock 100% facial features, head-to-body ratio, and physique to @Image1.
Scene: Consistent background using @Image3.
0.0-1.5s: The @Image1 model in initial clothes holds the @Image2 outfit with both hands, sways it side-to-side once, then presses it flat against her torso. Voice: "Lên dáng bộ đồ hôm nay nha!"
1.5-3.0s: Instant match-cut transition as the outfit touches her body: the @Image1 model now wears the 1:1 @Image2 outfit (100% initial clothes removed, strictly preserving the exact unaltered design, colors, and fabric from @Image2), smiling and stroking the fabric. Voice: "Chất vải mềm mượt, lên dáng siêu tôn da."
3.0-4.8s: Tucks hair behind ear and lightly touches the neckline and upper chest details of the @Image2 outfit. Voice: "Phần cổ áo nhìn xinh xỉu luôn á."
4.8-6.5s: Faces front, places both hands at her waist and smooths downward gently along her sides, maintaining @Image1 exact waist-to-hip ratio. Voice: "Form ôm dáng, tôn eo cực kỳ!"
6.5-8.5s: Stops speaking (mouth closed), pivots 180 degrees to show the 1:1 @Image4 back view, glides both hands down over the silhouette of the outfit, and tilts her @Image1 face slightly over her shoulder with a closed-lip smile. Voice: [Silent]
8.5-10.0s: Remains silent, pivots 180 degrees back to face front, standing stably front-and-center to clearly display the full @Image2 outfit and @Image1 face. Voice: [Silent]
Technical Rule: 1:1 face and body lock to @Image1 and 1:1 garment fidelity to @Image2 and @Image4 with zero morphing or structural alteration. Clean match cut at 1.5s, Vietnamese lip-sync from 0.0-6.5s, silent from 6.5-10.0s, sharp front-facing frame at 10.0s.`;

export const DEFAULT_FASHION_SCENE2_TEMPLATE = `Setup (6s): Seamless continuation from the exact starting front-facing frame, static camera, Vietnamese female voice with lip-sync. Strictly lock 100% color grading, white balance, exposure, contrast, facial identity, body proportions, and unaltered outfit design from frame 0.0s.
0.0-1.8s: Starting from the initial front-facing pose, the model runs her hands down the lower part of the outfit while speaking. Voice: "Phần dưới rủ nhẹ, đi lại siêu thoải mái."
1.8-4.5s: Faces front, makes a peace sign near her eyes, and kicks one leg to the side while maintaining exact @Image1 facial features, skin tone, and original outfit colors. Voice: "Đi chơi hay đi làm đều xinh. Vào bio nhập mã mua sản phẩm nha!"
4.5-6.0s: Stops speaking (mouth closed), smiles brightly, waves goodbye with both hands, and blows a kiss at the camera. Voice: [Silent]
Technical Rule: Zero camera movement, zero face morphing, and zero garment alteration. Strictly preserve 1:1 color palette, saturation, shadows, highlights, skin tone, and exact garment RGB hues from the attached starting frame with zero color drift, auto-exposure, or contrast shift across all 6.0s. Accurate Vietnamese lip-sync from 0.0-4.5s, silent action from 4.5-6.0s.`;

// Trường hợp 3: Áo dài (2 phân cảnh 10s + 10s, cùng cơ chế với TH2: Cảnh 1 Thành phần -> khung cuối -> Cảnh 2 Khung hình bắt đầu).
export const DEFAULT_FASHION_AODAI_SCENE1_TEMPLATE = `Setup (10s): Full 10s Korean KOC clip (Part 1), static camera, Vietnamese female voice with lip-sync, 20pt white serif title "TODAY'S OUTFIT" at top-center fifth. Strictly lock 100% facial features, head-to-body ratio, and physique to @Image1.
Scene: Consistent background using @Image3.
0.0-1.5s: The @Image1 model in initial clothes holds a hanger with the @Image2 outfit in her right hand, sways it once, then presses it flat against her torso. Voice: "Lên dáng áo dài lụa đỏ nha!"
1.5-3.8s: Instant match-cut transition as the outfit touches her body: the @Image1 model now wears the 1:1 @Image2 outfit (100% initial clothes removed, strictly preserving the exact unaltered design from @Image2), smiling and raising one hand to lightly touch her neckline and upper right chest area. Voice: "Lụa đỏ đô bóng mượt, cổ viền trắng đính nút hoa siêu xinh."
3.8-5.8s: Faces front, places both hands at her waist and smooths downward gently along her sides, maintaining @Image1 waist-to-hip ratio. Voice: "Áo chiết eo ôm sát, tôn dáng truyền thống cực kỳ!"
5.8-8.8s: Uses one hand to lightly sweep the front outer layer of the @Image2 outfit to one side to reveal the lower part of the outfit underneath, and gently touches the fabric. Voice: "Quần lụa trắng kem ống rộng, cạp cao che khuyết điểm đỉnh luôn."
8.8-10.0s: Mouth closed, lowers her hand to let the outfit fall back naturally into place, standing stably facing front with a gentle smile. Voice: [Silent]
Technical Rule: 1:1 face and body lock to @Image1 and 1:1 garment fidelity to @Image2 with zero morphing or structural alteration. Clean match cut at 1.5s, Vietnamese lip-sync from 0.0-8.8s, silent from 8.8-10.0s, sharp front-facing frame at 10.0s.`;

export const DEFAULT_FASHION_AODAI_SCENE2_TEMPLATE = `Setup (10s): Seamless continuation from the exact starting front-facing frame, static camera, Vietnamese female voice with lip-sync. Strictly lock 100% color grading, white balance, exposure, contrast, facial identity, body proportions, and unaltered outfit design from frame 0.0s.
0.0-3.2s: Starting from the front-facing pose, the model remains silent (mouth closed), pivots 180 degrees to show the 1:1 @Image4 back view, tilts her @Image1 head slightly looking downward with a closed-lip smile, and uses one hand to gently pull the back outer layer of the outfit to one side to reveal the lower part of the outfit and hip/glute silhouette. Voice: [Silent]
3.2-4.4s: Remains silent, releases her hand to let the outfit fall smoothly back into place, and pivots 180 degrees back to face front stably. Voice: [Silent]
4.4-7.8s: Faces front, smiles brightly and gestures naturally with her hands while speaking, maintaining exact @Image1 facial features and original outfit appearance. Voice: "Bộ áo dài này đi chơi du xuân là hết ý. Cảm ơn mọi người đã xem, vào bio nhập mã mua sản phẩm nha!"
7.8-10.0s: Stops speaking (mouth closed), acts playful and lively, blows a kiss with her right hand, then raises both hands to wave goodbye. Voice: [Silent]
Technical Rule: Zero camera movement, zero face morphing, and zero garment alteration. Strictly preserve 1:1 color palette, saturation, shadows, highlights, skin tone, and exact garment RGB hues from the starting frame and @Image4 across all 10.0s. Silent from 0.0-4.4s, Vietnamese lip-sync from 4.4-7.8s, silent from 7.8-10.0s.`;

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

function fileToPart(filePath) {
  const mimeType = getMimeType(filePath);
  const data = fs.readFileSync(filePath).toString('base64');
  return {
    inlineData: {
      mimeType,
      data,
    },
  };
}

/**
 * Gọi Google Generative Language API với cơ chế tự động chuyển đổi sang model ổn định
 * (gemini-2.5-flash / gemini-3.1-flash-lite) nếu model chính gặp lỗi mạng, quá tải hoặc timeout.
 */
async function callGeminiWithFallback({ apiKey, primaryModel, contents, generationConfig, timeoutMs = 15000 }) {
  const modelsToTry = [
    primaryModel,
    'gemini-2.5-flash',
    'gemini-3.1-flash-lite',
    'gemini-3.5-flash',
  ].filter(Boolean);

  const uniqueModels = [...new Set(modelsToTry)];
  let lastError = null;

  for (const model of uniqueModels) {
    try {
      console.log(`[Gemini API] Đang gửi yêu cầu tới model: ${model}...`);
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents, generationConfig }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        console.warn(`[Gemini API] Model ${model} trả về lỗi HTTP ${res.status}: ${errText.slice(0, 120)}`);
        lastError = new Error(`Gemini (${model}) lỗi HTTP ${res.status}: ${errText.slice(0, 120)}`);
        continue;
      }

      const json = await res.json();
      const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        lastError = new Error(`Gemini (${model}) không trả về nội dung`);
        continue;
      }

      console.log(`[Gemini API] Model ${model} phản hồi thành công!`);
      return JSON.parse(text);
    } catch (err) {
      console.warn(`[Gemini API] Model ${model} gặp lỗi: ${err.message}. Đang thử model dự phòng...`);
      lastError = err;
    }
  }

  throw new Error(`Không thể kết nối Gemini API (${lastError?.message || 'fetch failed'}). Vui lòng kiểm tra lại API Key hoặc mạng.`);
}

/**
 * Bước 1: Phân tích 2 ảnh (mặt trước & mặt sau) bằng Gemini Vision Multimodal
 */
export async function analyzeFashionGarment({ frontPath, backPath, apiKey, model = 'gemini-2.5-flash' }) {
  if (!apiKey) throw new Error('Chưa cấu hình Gemini API Key');
  if (!frontPath || !fs.existsSync(frontPath)) throw new Error('Không tìm thấy file ảnh mặt trước');
  if (!backPath || !fs.existsSync(backPath)) throw new Error('Không tìm thấy file ảnh mặt sau');

  const promptText = `Bạn là một chuyên gia thời trang cao cấp và giám đốc sáng tạo nội dung video thời trang TikTok/Reels.
Dưới đây là 2 bức ảnh của cùng một sản phẩm trang phục:
- Ảnh 1: Mặt trước của trang phục
- Ảnh 2: Mặt sau của trang phục

Nhiệm vụ: Phân tích thật chi tiết và chuẩn xác về bộ trang phục này để làm dữ liệu sản xuất kịch bản video:
1. "category": Phân loại chính xác (ví dụ: Đầm hai dây cổ đổ, Đầm bodycon, Set áo blazer chân váy, Áo sơ mi kiểu, Set dạ tweed...).
2. "color": Tên màu sắc và hiệu ứng ánh sáng (ví dụ: xanh bạc pastel ánh satin, đen tuyền, trắng kem...).
3. "fabric": Chất liệu nhìn thấy (ví dụ: lụa satin bóng rủ, dạ tweed, voan tơ, cotton lạnh, nhung tăm...).
4. "frontDetails": Mảng 3 đến 5 điểm nhấn thiết kế nổi bật nhất ở MẶT TRƯỚC (ví dụ: cổ đổ cowl neckline, hai dây mảnh, nếp gấp eo, xẻ tà tà dưới, cúc áo...).
5. "backDetails": Mảng 2 đến 4 điểm nhấn thiết kế nổi bật nhất ở MẶT SAU (ví dụ: hở lưng chữ U, đan dây sau, đường chiết eo ôm trọn vòng ba, khóa kéo chìm...).
6. "summary": Một đoạn văn ngắn gọn (2-3 câu bằng tiếng Việt) tóm tắt tổng quan vẻ đẹp, phong cách và điểm đắt giá nhất của sản phẩm để nhân vật KOC đọc hoặc giới thiệu.

Trả về định dạng JSON thuần theo mẫu:
{
  "category": "string",
  "color": "string",
  "fabric": "string",
  "frontDetails": ["chi tiết 1", "chi tiết 2", "chi tiết 3"],
  "backDetails": ["chi tiết 1", "chi tiết 2"],
  "summary": "string"
}`;

  return await callGeminiWithFallback({
    apiKey,
    primaryModel: model || 'gemini-2.5-flash',
    contents: [
      {
        role: 'user',
        parts: [
          fileToPart(frontPath),
          fileToPart(backPath),
          { text: promptText },
        ],
      },
    ],
    generationConfig: { responseMimeType: 'application/json' },
    timeoutMs: 10000,
  });
}

/**
 * Chuẩn hoá và sửa lỗi các thẻ mention @Image cho Google Flow
 * Đảm bảo: đúng 1 dấu @, luôn có khoảng cách trước/sau, khôi phục các thẻ bị mất.
 */
export function sanitizeFlowPromptMentions(p, isCase1 = false) {
  if (!p) return '';
  let s = p;

  // 1. Sửa lỗi dính chữ t@@Image hoặc th@@Image -> the @Image
  s = s.replace(/\bth?@+Image(\d+)/gi, 'the @Image$1');

  // 2. Sửa lỗi nhiều dấu @: @@Image -> @Image
  s = s.replace(/@+Image(\d+)/gi, '@Image$1');

  // 3. Đảm bảo luôn có khoảng cách trước @Image nếu trước nó không phải là khoảng trắng hoặc đầu dòng
  s = s.replace(/([^\s\n])@Image(\d+)/g, '$1 @Image$2');

  // 4. Đảm bảo luôn có khoảng cách sau @Image nếu sau nó dính chữ cái
  s = s.replace(/@Image(\d+)([a-zA-Z])/g, '@Image$1 $2');

  // 5. Khôi phục @Image2 nếu Gemini bị mất ở mốc 0.0-1.2s ("holds the ... garment" hoặc "holds the ... dress/outfit")
  //    Chỉ chèn khi cả câu chưa có @Image2 (tránh "wears the @Image2 1:1 @Image2 outfit")
  s = s.replace(/(holds\s+the)\s+(?![^.\n]*@Image2)(.*?chest)/i, '$1 @Image2 $2');

  // 6. Khôi phục @Image2 nếu Gemini bị mất ở mốc 1.2-3.0s ("wears the ... on bare shoulders" hoặc "wears the ... garment")
  s = s.replace(/(wears\s+the)\s+(?![^.\n]*@Image2)(.*?on\s+bare\s+shoulders|.*?garment|.*?dress|.*?outfit)/i, '$1 @Image2 $2');

  // 7. Khôi phục @Image2 nếu Gemini bị mất ở mốc 8.5-10.0s ("display the full ... garment")
  s = s.replace(/(display\s+the\s+full)\s+(?![^.\n]*@Image2)/i, '$1 @Image2 ');

  // 8. Đảm bảo phần Scene luôn có @Image3 (TH2) hoặc @Image6 (TH1)
  const expectedBgTag = isCase1 ? '@Image6' : '@Image3';
  if (!s.includes(expectedBgTag)) {
    s = s.replace(/(Scene:\s*Consistent\s*background\s*using)\s*([^.\n]*)/i, `$1 ${expectedBgTag}.`);
  }

  // 9. Dọn sạch khoảng trắng kép thừa
  s = s.replace(/[ \t]{2,}/g, ' ');

  return s.trim();
}

// Một câu thoại có lời: Voice: "..." (Voice: [Silent] không phải slot và được giữ nguyên)
const VOICE_RE = /Voice:\s*"([^"\n]*)"/g;

/**
 * Tách các ô lời thoại Voice: "..." của một prompt phân cảnh, kèm mốc giây + hành động tiếng Anh của mốc đó
 * để Gemini biết nhân vật đang làm gì khi nói câu này.
 */
export function extractVoiceSlots(prompt) {
  const text = String(prompt || '');
  const slots = [];
  for (const m of text.matchAll(VOICE_RE)) {
    const lineStart = text.lastIndexOf('\n', m.index) + 1;
    const line = text.slice(lineStart, m.index);
    const t = line.match(/^\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*s\s*:/i);
    const seconds = t ? Math.max(0, +(parseFloat(t[2]) - parseFloat(t[1])).toFixed(1)) : null;
    slots.push({
      time: t ? `${t[1]}-${t[2]}s` : '',
      seconds,
      action: line.slice(t ? t[0].length : 0).trim(),
      oldVoice: m[1].trim(),
    });
  }
  return slots;
}

/**
 * Thay lần lượt các Voice: "..." trong prompt bằng lời thoại mới; chỉ phần trong ngoặc kép đổi,
 * toàn bộ phần tiếng Anh còn lại giữ nguyên từng ký tự. Ô nào thiếu/rỗng thì giữ câu cũ.
 */
export function applyVoices(prompt, voices = []) {
  let i = 0;
  return String(prompt || '').replace(VOICE_RE, (full) => {
    const v = voices[i++];
    const clean = typeof v === 'string' ? v.replace(/["\n]/g, '').replace(/\s{2,}/g, ' ').trim() : '';
    return clean ? `Voice: "${clean}"` : full;
  });
}

function describeSlots(slots, label) {
  if (!slots.length) return `${label}: (không có câu thoại nào cần viết)`;
  return `${label}:\n` + slots.map((s, i) => {
    const budget = s.seconds ? `${s.seconds} giây → khoảng ${Math.max(3, Math.round(s.seconds * 3))}-${Math.max(4, Math.round(s.seconds * 4))} tiếng (âm tiết), nên dùng gần hết` : 'không rõ thời lượng → 1 câu vừa phải';
    return `  [${i + 1}] Mốc ${s.time || '?'} (${budget})
      Hành động của nhân vật (tiếng Anh, giữ nguyên, chỉ để bạn hiểu ngữ cảnh): ${s.action}
      Lời thoại cũ (chỉ tham khảo giọng điệu, KHÔNG giữ mô tả sản phẩm cũ): "${s.oldVoice}"`;
  }).join('\n');
}

/**
 * Bước 2: Chỉ viết lại LỜI THOẠI (Voice) cho khớp sản phẩm + hành động từng mốc.
 * Prompt tiếng Anh của 2 phân cảnh đã chuẩn nên KHÔNG sửa: Gemini chỉ trả về danh sách câu thoại,
 * server ghép lại vào đúng vị trí Voice: "..." của prompt gốc.
 */
export async function generateFashionScenePrompts({
  productData,
  basePromptScene1 = DEFAULT_FASHION_SCENE1_TEMPLATE,
  basePromptScene2 = DEFAULT_FASHION_SCENE2_TEMPLATE,
  apiKey,
  model = 'gemini-2.5-flash',
}) {
  if (!apiKey) throw new Error('Chưa cấu hình Gemini API Key');

  const slots1 = extractVoiceSlots(basePromptScene1);
  const slots2 = extractVoiceSlots(basePromptScene2);
  if (!slots1.length && !slots2.length) {
    // Không có Voice: "..." nào để viết lại → trả nguyên prompt gốc
    return { promptScene1: basePromptScene1, promptScene2: basePromptScene2, voices: { scene1: [], scene2: [] } };
  }

  const promptText = `Bạn là biên kịch lời thoại cho video KOC bán hàng thời trang ngắn (TikTok/Reels), nhân vật là nữ, nói tiếng Việt tự nhiên như đang tư vấn cho khách: thân thiện, dễ thương nhưng rõ mục đích bán hàng (khiến người xem muốn mặc thử và mua).

SẢN PHẨM THỰC TẾ vừa được phân tích từ ảnh (nguồn duy nhất về tên, màu, chất liệu, chi tiết):
${JSON.stringify(productData, null, 2)}

Kịch bản 2 phân cảnh đã được viết sẵn bằng tiếng Anh và ĐÃ CHUẨN, KHÔNG ĐƯỢC SỬA. Bạn CHỈ viết lại lời thoại tiếng Việt (Voice) cho từng mốc dưới đây, sao cho khớp với hành động của nhân vật ở mốc đó và khớp với sản phẩm thực tế.

${describeSlots(slots1, 'PHÂN CẢNH 1 (mặt trước)')}

${describeSlots(slots2, 'PHÂN CẢNH 2 (tiếp nối, có đoạn khoe mặt sau)')}

QUY TẮC VIẾT LỜI THOẠI:
1. Mỗi câu phải khớp với thứ nhân vật đang làm/chạm/khoe ở mốc đó: đang cầm đồ lên → câu mở đầu giới thiệu sản phẩm, tạo hứng thú; vừa mặc vào / vuốt vải → nói về chất liệu và CẢM GIÁC KHI MẶC; chạm cổ áo/ngực áo → nói về chi tiết đó (cổ, nút, dây, tay áo...) và vì sao nó đẹp/tôn người mặc; vuốt eo/hông → nói về form dáng và cảm giác ôm vừa vặn, tôn dáng; vén/kéo lớp ngoài hay vuốt phần dưới → nói về phần dưới (quần, chân váy, tà, xẻ...) và sự thoải mái khi đi lại; mốc cuối có lời của phân cảnh 2 → gợi ý dịp mặc + GIỮ NGUYÊN lời kêu gọi mua của câu cũ (vd. "Cảm ơn mọi người đã xem, vào bio nhập mã mua sản phẩm nha!"), chỉ đổi phần nói về sản phẩm/dịp mặc.
2. HƯỚNG BÁN HÀNG, nói LỢI ÍCH cho người mặc chứ không đọc thông số: mỗi câu nên có ít nhất 1 lợi ích cảm nhận được khi mặc vào — mát mẻ/thoáng, mềm nhẹ, không nhăn, không bí, ôm vừa vặn, che khuyết điểm, tôn eo/tôn dáng, lên hình đẹp, đi làm/đi chơi đều hợp... Ví dụ cách nói: "Lụa này mặc vào mát lắm, mềm rủ mà vẫn đứng dáng, lên hình sang cực kỳ." / "Quần ống rộng cạp cao nên đi lại thoải mái, chân nhìn dài hơn hẳn nha." Hạn chế câu khô cứng chỉ liệt kê màu + chất liệu + chi tiết.
3. Mô tả sản phẩm phải đúng với phần SẢN PHẨM THỰC TẾ (category, color, fabric, frontDetails, backDetails); lợi ích phải hợp lý với chất liệu đó (lụa/satin/voan → mát, mềm, rủ; dạ/tweed → ấm, đứng dáng; cotton → thoáng, dễ chịu; thun → co giãn, thoải mái). Tuyệt đối không nhắc đặc điểm chỉ có ở lời thoại cũ mà sản phẩm mới không có (vd. "lụa đỏ", "nút hoa", "quần trắng kem", "hai dây cổ đổ"... nếu sản phẩm mới không có).
4. Độ dài: dùng gần hết thời lượng của mốc (đọc khoảng 3-4 tiếng/giây), viết đủ ý, có thể 1-2 vế nối bằng dấu phẩy; không vượt mức tiếng tối đa đã ghi, không liệt kê dài dòng.
5. Giọng điệu như đang nói chuyện với khách: tự nhiên, có "nha", "luôn", "cực kỳ", "mọi người ơi", "em thấy"... nhưng không lặp lại nguyên văn câu cũ.
6. Không dùng dấu ngoặc kép bên trong câu, không xuống dòng, không emoji, không ghi chú tiếng Anh. Mỗi câu chỉ chứa lời nói.
7. Trả về ĐÚNG SỐ LƯỢNG câu: scene1 có ${slots1.length} câu, scene2 có ${slots2.length} câu, theo đúng thứ tự mốc.

Trả về JSON thuần:
{
  "scene1": [${slots1.map((_, i) => `"câu thoại mốc ${i + 1}"`).join(', ')}],
  "scene2": [${slots2.map((_, i) => `"câu thoại mốc ${i + 1}"`).join(', ')}]
}`;

  const res = await callGeminiWithFallback({
    apiKey,
    primaryModel: model || 'gemini-2.5-flash',
    contents: [{ role: 'user', parts: [{ text: promptText }] }],
    generationConfig: { responseMimeType: 'application/json' },
    timeoutMs: 12000,
  });

  const asList = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? [v] : []).map((x) => (typeof x === 'string' ? x : String(x?.voice || x?.text || '')));
  const voices1 = asList(res?.scene1);
  const voices2 = asList(res?.scene2);
  if (voices1.length !== slots1.length || voices2.length !== slots2.length) {
    console.warn(`[Gemini API] Số câu thoại trả về lệch: cảnh 1 ${voices1.length}/${slots1.length}, cảnh 2 ${voices2.length}/${slots2.length} (ô thiếu giữ lời thoại cũ)`);
  }

  return {
    promptScene1: applyVoices(basePromptScene1, voices1),
    promptScene2: applyVoices(basePromptScene2, voices2),
    voices: { scene1: voices1, scene2: voices2 },
  };
}
