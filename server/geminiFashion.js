import fs from 'node:fs';
import path from 'node:path';
import { fetch } from 'undici';

export const DEFAULT_FASHION_SCENE1_TEMPLATE = `Setup (10s): Full 10s Korean KOC clip (Part 1), static camera, Vietnamese female voice with lip-sync, small 20pt white serif title "TODAY'S OUTFIT" at top-center fifth. Strictly lock 100% facial features, head-to-body ratio, and physique to @Image1.
Scene: Consistent background using @Image3.
0.0-1.2s: The exact @Image1 model in initial clothes holds the unaltered @Image2 silver-blue satin slip dress at her chest and shakes it once. Voice: "Lên dáng đầm lụa xanh nha!"
1.2-3.0s: Hard cut outfit change: the exact @Image1 model wears the 1:1 @Image2 slip dress (clean transition with zero garment redesign, preserving exact neckline, straps, and satin sheen), smiling and stroking the fabric. Voice: "Lụa ánh bạc bóng rủ, siêu tôn da."
3.0-4.8s: Tucks hair behind ear, touches the exact thin straps and cowl neckline of @Image2. Voice: "Hai dây cổ đổ khoe xương quai xanh."
4.8-6.5s: Faces front, places both hands on the cinched waist and smooths down lightly, maintaining @Image1 exact waist-to-hip ratio. Voice: "Chiết eo ôm dáng, tôn dáng cực kỳ!"
6.5-8.5s: Stops speaking (mouth closed), pivots 180 degrees to show the exact 1:1 @Image4 back design, glides both hands down over the silhouette of the dress, and tilts her @Image1 face slightly over her shoulder with a closed-lip smile. Voice: [Silent]
8.5-10.0s: Remains silent, pivots 180 degrees back to face front, standing stably to display the exact @Image2 dress and @Image1 face. Voice: [Silent]
Technical Rule: 1:1 face and body proportion lock to @Image1 and 1:1 garment fidelity to @Image2 and @Image4 with zero AI morphing. Hard cut at 1.2s, Vietnamese lip-sync from 0.0-6.5s, silent from 6.5-10.0s, sharp front-facing frame at 10.0s.`;

export const DEFAULT_FASHION_SCENE2_TEMPLATE = `Setup (6s): Seamless continuation from the exact starting front-facing frame, static camera, Vietnamese female voice with lip-sync. Strictly lock 100% color grading, white balance, exposure, contrast, facial identity, body proportions, and dress structure from frame 0.0s.
0.0-1.8s: Starting from the initial front-facing pose, the model runs her hands down the exact silver-blue satin skirt and side slit while speaking. Voice: "Tà suông xẻ gấu bước đi siêu thanh thoát."
1.8-4.5s: Faces front, makes a peace sign near her eyes, and kicks one leg to the side while maintaining exact facial features, skin tone, and dress color. Voice: "Đi tiệc hay dạo phố đều xinh. Vào bio nhập mã, mua ủng hộ em nha, em cảm ơn!"
4.5-6.0s: Stops speaking (mouth closed), smiles brightly, waves goodbye with both hands, and blows a kiss at the camera. Voice: [Silent]
Technical Rule: Zero camera movement, zero face morphing, and zero garment alteration. Strictly preserve 1:1 color palette, saturation, shadows, highlights, skin tone, and exact silver-blue RGB hue from the attached starting frame with zero color drift, auto-exposure, or contrast shift across all 6.0s. Accurate Vietnamese lip-sync from 0.0-4.5s, silent action from 4.5-6.0s.`;

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
  s = s.replace(/(holds\s+the)\s+(?!@Image2)(.*?chest)/i, '$1 @Image2 $2');

  // 6. Khôi phục @Image2 nếu Gemini bị mất ở mốc 1.2-3.0s ("wears the ... on bare shoulders" hoặc "wears the ... garment")
  s = s.replace(/(wears\s+the)\s+(?!@Image2)(.*?on\s+bare\s+shoulders|.*?garment|.*?dress|.*?outfit)/i, '$1 @Image2 $2');

  // 7. Khôi phục @Image2 nếu Gemini bị mất ở mốc 8.5-10.0s ("display the full ... garment")
  s = s.replace(/(display\s+the\s+full)\s+(?!@Image2)/i, '$1 @Image2 ');

  // 8. Đảm bảo phần Scene luôn có @Image3 (TH2) hoặc @Image6 (TH1)
  const expectedBgTag = isCase1 ? '@Image6' : '@Image3';
  if (!s.includes(expectedBgTag)) {
    s = s.replace(/(Scene:\s*Consistent\s*background\s*using)\s*([^.\n]*)/i, `$1 ${expectedBgTag}.`);
  }

  // 9. Dọn sạch khoảng trắng kép thừa
  s = s.replace(/[ \t]{2,}/g, ' ');

  return s.trim();
}

/**
 * Bước 2: Dùng Mô tả sản phẩm + 2 Prompt gốc mẫu gọi Gemini render 2 Prompt mới phù hợp với sản phẩm
 */
export async function generateFashionScenePrompts({
  productData,
  basePromptScene1 = DEFAULT_FASHION_SCENE1_TEMPLATE,
  basePromptScene2 = DEFAULT_FASHION_SCENE2_TEMPLATE,
  apiKey,
  model = 'gemini-2.5-flash',
}) {
  if (!apiKey) throw new Error('Chưa cấu hình Gemini API Key');

  const promptText = `Bạn là chuyên gia Prompt Engineering cho mô hình Google Flow (Omni 1.1 Flash Video AI) chuyên sản xuất video KOC thời trang bán hàng ngắn.

Dưới đây là thông tin chi tiết về sản phẩm trang phục thực tế vừa được phân tích:
${JSON.stringify(productData, null, 2)}

Và đây là 2 PROMPT GỐC DẠNG MẪU:
--- PROMPT GỐC PHÂN CẢNH 1 (10 GIÂY - MẶT TRƯỚC - THÀNH PHẦN) ---
${basePromptScene1}

--- PROMPT GỐC PHÂN CẢNH 2 (6 GIÂY - MẶT SAU - KHUNG HÌNH BẮT ĐẦU) ---
${basePromptScene2}

ĐẶC BIỆT CHÚ Ý VỀ CÁC THẺ MENTION ẢNH (@Image) TRÊN GOOGLE FLOW:
Google Flow cần nhận diện chính xác các thẻ @Image để gắp đúng ảnh người mẫu, bối cảnh và trang phục vào video:
- @Image1: Ảnh người mẫu KOC/KOL
- @Image2: Ảnh trang phục mặt trước
- @Image3: Ảnh bối cảnh phòng/studio
- @Image4: Ảnh trang phục mặt sau

QUY TẮC CÚ PHÁP BẮT BUỘC (TUYỆT ĐỐI KHÔNG ĐƯỢC LÀM SAI):
1. CHỈ DÙNG ĐÚNG 1 DẤU @ (Viết là "@Image1", "@Image2", "@Image3", "@Image4"). TUYỆT ĐỐI KHÔNG VIẾT 2 DẤU "@@" (như @@Image1, @@Image3 là SAI).
2. LUÔN CÓ 1 KHOẢNG CÁCH (dấu cách) trước và sau thẻ @Image. Ví dụ viết: "using @Image3.", "The @Image1 model", "the @Image2 garment", "show the @Image4 back view". Không được viết dính liền chữ (cấm viết "using@Image3", "the@@Image1", "t@@Image4", "full@@Image2").
3. BẮT BUỘC PHẢI GIỮ LẠI THẺ "@Image2" KHI THAY TÊN TRANG PHỤC:
   - Ở mốc 0.0-1.2s: Viết "holds the @Image2 [tên trang phục + màu sắc + chất liệu] at her chest and shakes it once."
   - Ở mốc 1.2-3.0s: Viết "the @Image1 model exclusively wears the @Image2 [tên trang phục] on bare shoulders"
   - Ở mốc 8.5-10.0s: Viết "standing stably front-and-center to clearly display the full @Image2 [tên trang phục]."
   TUYỆT ĐỐI KHÔNG ĐƯỢC BỎ SÓT "@Image2", KHÔNG ĐƯỢC VIẾT THIẾU THÀNH "holds the     garment" hay "wears the garment".
4. Ở mốc 6.5-8.5s: BẮT BUỘC PHẢI CÓ "show the @Image4 back view" (không được viết thành "t@@Image4").
5. BẮT BUỘC GIỮ NGUYÊN: Setup (10s), các mốc giây chuẩn, text "TODAY'S OUTFIT" (size 20pt) và toàn bộ phần Technical Rule ở cuối của Phân cảnh 1.
6. Ở PHÂN CẢNH 2 (promptScene2): BẮT BUỘC KHÓA CHẶT MÀU SẮC VÀ ÁNH SÁNG 1:1. Giữ nguyên câu Setup ("Strictly lock 100% color grading, white balance, exposure, contrast, facial identity, body proportions, and dress structure from frame 0.0s.") và toàn bộ Technical Rule ("Strictly preserve 1:1 color palette, saturation, shadows, highlights, skin tone, and exact RGB hue from the attached starting frame with zero color drift, auto-exposure, or contrast shift across all 6.0s.") để màu sắc và phơi sáng giữa 2 cảnh hoàn toàn đồng nhất.

NHIỆM VỤ:
Tái cấu trúc và tạo ra 2 PROMPT MỚI bám sát các chi tiết thực tế của sản phẩm đã phân tích (chất vải, form dáng, chi tiết mặt trước/sau) và lời thoại Voice tiếng Việt tương ứng:

Trả về định dạng JSON thuần theo cấu trúc:
{
  "promptScene1": "Nội dung prompt tiếng Anh hoàn chỉnh cho Phân cảnh 1 (10s)",
  "promptScene2": "Nội dung prompt tiếng Anh hoàn chỉnh cho Phân cảnh 2 (6s)"
}`;

  const res = await callGeminiWithFallback({
    apiKey,
    primaryModel: model || 'gemini-2.5-flash',
    contents: [{ role: 'user', parts: [{ text: promptText }] }],
    generationConfig: { responseMimeType: 'application/json' },
    timeoutMs: 12000,
  });

  return {
    promptScene1: sanitizeFlowPromptMentions(res.promptScene1, false),
    promptScene2: sanitizeFlowPromptMentions(res.promptScene2, false),
  };
}
