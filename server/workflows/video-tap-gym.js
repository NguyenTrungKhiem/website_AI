// Quy trình "Video tập gym": 1 ảnh nhân vật + 1 bộ đồ tập (mặt trước + mặt sau) + 1 ảnh bối cảnh phòng gym
// -> 1 PHÂN CẢNH 15s trên Flow (Omni 1.2 Flash, Ingredients, 9:16), không voice: nhân vật mặc sẵn bộ đồ ngay từ khung hình
// đầu và tập 1 động tác với máy quay cố định.
//
// Prompt gốc (`base`) dựng theo 2 video mẫu người dùng gửi (squat máy quay mặt vào đệm, quay chéo từ phía sau). Prompt có
// cấu trúc dòng cố định:
//   Setup / {CAPTION} / Identity / Wardrobe / Scene  -> KHÔNG đổi theo động tác
//   Exercise / Camera / Form / các mốc "a.a-b.bs: …" -> phần của ĐỘNG TÁC
//   Rules                                            -> KHÔNG đổi theo động tác
// Người dùng nhập tên động tác khác -> writeExercisePrompt() gọi Gemini (API key trong Cài đặt) viết lại ĐÚNG phần của động
// tác (Exercise, Camera, Form, các mốc giây); server ghép vào prompt gốc nên các dòng còn lại giữ nguyên từng chữ.
// Góc quay phụ thuộc nhóm cơ (chân/mông: từ phía sau · ngực: quay ngang · tay: phía trước …) — luật nằm trong prompt `rewrite`
// (sửa được ở "Prompt mẫu của quy trình").
//
// Chỗ điền: {MODEL} = @Image1 (nhân vật) · {OUTFIT} = @Image2 (mặt trước đồ tập) · {BACK} = @Image3 (mặt sau) ·
// {BG} = @Image4 (bối cảnh) · {CAPTION} = dòng chữ trên video theo lựa chọn (mã sản phẩm / chữ tuỳ ý / không chữ).
import fs from 'node:fs';
import { db } from '../db.js';
import { codeOfAsset, assignCode } from '../productCodes.js';
import { captionModeOf, cleanCaptionText, NO_TEXT_RULE } from '../caption.js';
import { callGeminiWithFallback } from '../geminiFashion.js';
import { FASHION_MODELS } from './video-thoi-trang.js';
import { backOf } from './video-thoi-trang-khong-voice.js';

export const GYM_DURATION = '15s';
const TOTAL = parseFloat(GYM_DURATION);
export const DEFAULT_EXERCISE = 'Reverse hack squat (squat máy quay mặt vào đệm – động tác trong video mẫu)';

// Prompt gốc: động tác trong 2 video mẫu (10s, ~3 nhịp, máy quay cố định chéo phía sau bên phải, ngang hông) kéo thành 15s / 4 nhịp
export const GYM_BASE_PROMPT = `Setup: One continuous 15s gym training clip, vertical 9:16, realistic phone footage, natural gym lighting; silent: no voice, no lip-sync, mouth closed, calm focused face.
{CAPTION}
Identity: face, hair and head-to-body ratio locked 1:1 to {MODEL}. Keep her real body exactly as in {MODEL} in every frame: same bust, waist, hip and thigh proportions, natural and athletic, never slimmed or exaggerated.
Wardrobe: use {MODEL} for face, hair and body only, never its clothes. From the very first frame to the end she wears {OUTFIT} exactly (back view {BACK}) with white crew socks and flat training shoes; fabric, colour, seams and fit stay identical in every frame, back views included.
Scene: {BG}; keep its floor, lighting and equipment style, a few people training far behind, out of focus.
Exercise: Reverse hack squat on a plate-loaded machine (glutes, quads, hamstrings). She stands on the machine's foot platform facing its back pad, both shoulders under the two shoulder pads, hands gripping the handles beside the pads.
Camera: locked-off tripod shot from behind at a rear three-quarter angle, about 35 degrees to her right, lens at hip height, full body from head to feet with the whole machine in frame. No zoom, no pan, no cuts.
Form: feet shoulder-width, toes slightly out, whole foot flat; chest on the pad, back straight and neutral, core braced; hips sink back and down between the heels, knees track over the toes and never cave in; she drives up through the heels. Smooth controlled tempo, no bouncing, the machine arm moving in sync with her.
0.0-1.5s: She stands tall under the pads, knees softly bent, inhales and braces.
1.5-4.5s: Rep 1: lowers for 1.5s until her thighs pass parallel, holds the bottom briefly, then pushes up to standing without locking the knees.
4.5-7.5s: Rep 2: same depth and tempo, back angle unchanged.
7.5-10.5s: Rep 3: same; heels stay planted, knees stay out.
10.5-13.5s: Rep 4: a slightly slower push up with visible effort, steady exhale.
13.5-15.0s: She stands tall at the top, exhales and holds still; sharp final frame.
Rules: anatomically correct joints, natural hands and a firm grip, real weight and gravity; equipment stays solid and consistent; no extra limbs; no text or logos except the caption.`;

// Luật cho Gemini khi viết lại phần động tác. {EXERCISE} = tên động tác người dùng nhập, {BASE} = prompt gốc hiện tại.
export const GYM_REWRITE_PROMPT = `Bạn là huấn luyện viên thể hình kiêm đạo diễn hình ảnh. Tôi có một PROMPT GỐC (tiếng Anh) để tạo video 15 giây một nữ tập gym bằng AI. Hãy viết lại ĐÚNG phần mô tả động tác cho động tác mới: "{EXERCISE}".

PROMPT GỐC (chỉ để bạn bám theo văn phong, độ chi tiết và cấu trúc dòng):
"""
{BASE}
"""

BẠN CHỈ VIẾT 4 PHẦN SAU (tiếng Anh, cùng văn phong với prompt gốc), các dòng khác tôi tự giữ nguyên:
1. exercise: tên chuẩn tiếng Anh của động tác + nhóm cơ chính trong ngoặc + 1 câu tả thiết bị và TƯ THẾ BẮT ĐẦU (đứng/ngồi/nằm ở đâu, tay nắm gì, tạ/thanh đòn/dây cáp ở vị trí nào). Tối đa 45 từ.
2. camera: 1 góc máy CỐ ĐỊNH duy nhất cho cả 15s (locked-off tripod shot), ghi rõ hướng quay, lệch bao nhiêu độ, độ cao ống kính, khung hình thấy toàn thân + toàn bộ thiết bị; kết bằng "No zoom, no pan, no cuts." Tối đa 45 từ.
3. form: kỹ thuật ĐÚNG của động tác: vị trí chân/tay, đường đi của tạ hoặc cơ thể, biên độ, tư thế lưng và core, nhịp thở, và lỗi phải tránh (vd. không cong lưng dưới, không khoá khớp, không giật tạ). Tối đa 60 từ.
4. beats: 5 đến 7 mốc thời gian LIỀN NHAU phủ kín từ 0.0 đến 15.0 giây: mốc đầu = vào tư thế + hít thở (1–2s); giữa = các nhịp (rep) với nhịp độ thực tế (thường 3–5 nhịp, mỗi nhịp 2.5–3.5s; động tác giữ tĩnh như plank thì tả việc giữ và nhịp thở); mốc cuối (1–1.5s) = về tư thế kết, đứng yên, kết bằng "sharp final frame". Mỗi mốc tối đa 30 từ, tả rõ từng nhịp hạ/nâng, điểm dừng, và thiết bị chuyển động theo.
   - Mốc đầu phải tả ĐÚNG tư thế bắt đầu thật của động tác này (vd. deadlift: cúi gập hông nắm thanh đòn dưới sàn; bench press: nằm trên ghế, nhấc tạ khỏi giá), không chép "stands tall" của prompt gốc nếu không đúng.
   - Các nhịp phải LIỀN MẠCH về tư thế: cuối nhịp này là đầu nhịp sau; mốc cuối phải tiếp đúng vị trí kết của nhịp cuối (không tự nhiên đổi tư thế, tạ không tự biến mất hay đổi chỗ).
   - Viết động từ và chi tiết riêng của động tác này cho từng nhịp (hạ gì, tới đâu, nâng gì, khớp nào duỗi), không chép nguyên câu của prompt gốc.

LUẬT GÓC QUAY (rất quan trọng, chọn theo NHÓM CƠ CHÍNH của động tác):
- Mông, đùi sau, đùi trước, bắp chân (squat, lunge, hip thrust, glute bridge, kickback, leg press, hack squat, deadlift, Romanian deadlift, good morning, calf raise…): quay từ PHÍA SAU, chéo 30–45 độ (rear three-quarter), ống kính ngang hông.
- Ngực (bench press, incline press, chest fly, cable crossover, pec deck, push-up, dips…): quay NGANG (side profile 90 độ), ống kính ngang thân người.
- Tay trước, tay sau, cẳng tay (biceps curl, hammer curl, preacher curl, triceps pushdown, skull crusher…): quay từ PHÍA TRƯỚC (chính diện hoặc chéo trước 20–30 độ), ống kính ngang ngực.
- Vai (shoulder press, lateral raise, front raise, upright row…): quay từ PHÍA TRƯỚC, ống kính ngang ngực; riêng vai sau (reverse fly, face pull): quay từ PHÍA SAU.
- Lưng, xô (lat pulldown, pull-up, seated row, bent-over row, T-bar row…): quay từ PHÍA SAU (chính lưng hoặc chéo sau 30 độ), ống kính ngang lưng giữa.
- Bụng, core (crunch, plank, leg raise, russian twist, cable crunch…): quay NGANG (side profile), ống kính thấp ngang thân.
- Toàn thân / cardio (burpee, kettlebell swing, jump rope…): chéo trước 45 độ, ống kính ngang hông.
Luôn là 1 cảnh quay liên tục, máy đứng yên, không cắt cảnh, không đổi góc. Góc quay phải cho thấy rõ nhóm cơ chính và đường chuyển động.

YÊU CẦU KHÁC:
- Động tác phải đúng kỹ thuật thể hình thực tế, an toàn, đúng thiết bị. Tên động tác mơ hồ thì chọn biến thể phổ biến nhất và nói rõ trong "note_vi".
- Nhân vật là nữ ("she"), đã mặc sẵn đồ tập; KHÔNG tả quần áo, khuôn mặt, bối cảnh, chữ trên màn hình (các dòng khác đã lo).
- Không dùng ký hiệu @Image hay dấu ngoặc nhọn, không xuống dòng trong một trường, không dùng dấu ngoặc kép bên trong câu.

Trả về JSON thuần:
{
  "exercise": "…",
  "camera": "…",
  "form": "…",
  "beats": [{ "from": 0.0, "to": 1.5, "text": "…" }],
  "muscle_group": "nhóm cơ chính (tiếng Việt)",
  "view": "rear | rear-three-quarter | side | front | front-three-quarter",
  "note_vi": "1 câu tiếng Việt: động tác nào, nhóm cơ nào, vì sao chọn góc quay này"
}`;

const fmtT = (t) => (Math.round(t * 10) / 10).toFixed(1);
const fill = (text, vars) => text.replace(/\{(MODEL|OUTFIT|BACK|BG|CAPTION)\}/g, (m, k) => (vars[k] != null ? vars[k] : m));
const BEAT_LINE = /^\s*\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?s\s*:/;
const oneLine = (v) => String(v ?? '').replace(/\s+/g, ' ').replace(/[{}]/g, '').replace(/@Image\d+/gi, 'the outfit').trim();

/**
 * Ghép phần động tác mới vào prompt gốc: thay các dòng "Exercise:", "Camera:", "Form:" và toàn bộ các mốc "a-bs:", giữ
 * nguyên mọi dòng khác (Setup, {CAPTION}, Identity, Wardrobe, Scene, Rules). Dòng nào prompt gốc không có thì chèn thêm
 * ngay trước các mốc giây. parts = { exercise, camera, form, beats: [{ from, to, text }] }.
 */
export function mergeExerciseIntoPrompt(base, parts) {
  const beats = normalizeBeats(parts.beats);
  const fresh = {
    exercise: `Exercise: ${oneLine(parts.exercise)}`,
    camera: `Camera: ${oneLine(parts.camera)}`,
    form: `Form: ${oneLine(parts.form)}`,
  };
  const beatLines = beats.map((b) => `${fmtT(b.from)}-${fmtT(b.to)}s: ${oneLine(b.text)}`);
  const out = [];
  const used = new Set();
  let beatsPlaced = false;
  const placeBeats = () => {
    if (beatsPlaced) return;
    for (const k of ['exercise', 'camera', 'form']) if (!used.has(k)) { out.push(fresh[k]); used.add(k); }
    out.push(...beatLines);
    beatsPlaced = true;
  };
  for (const line of String(base).split('\n')) {
    const key = /^\s*Exercise\s*:/i.test(line) ? 'exercise' : /^\s*Camera\s*:/i.test(line) ? 'camera' : /^\s*Form\s*:/i.test(line) ? 'form' : null;
    if (key) { if (!used.has(key)) { out.push(fresh[key]); used.add(key); } continue; }
    if (BEAT_LINE.test(line)) { placeBeats(); continue; }
    // Dòng "Rules:" đứng sau các mốc: nếu prompt gốc không có mốc nào thì chèn phần động tác ngay trước Rules
    if (/^\s*Rules\s*:/i.test(line)) placeBeats();
    out.push(line);
  }
  placeBeats();
  return out.join('\n').trim();
}

// Mốc giây từ Gemini: ép liền nhau, bắt đầu 0.0, kết thúc đúng 15.0; thiếu / sai thì báo lỗi để người dùng bấm lại
export function normalizeBeats(raw) {
  const list = (Array.isArray(raw) ? raw : [])
    .map((b) => ({ from: Number(b?.from), to: Number(b?.to), text: oneLine(b?.text) }))
    .filter((b) => Number.isFinite(b.to) && b.text);
  if (list.length < 3 || list.length > 9) throw new Error(`Gemini trả về ${list.length} mốc thời gian (cần 5–7) — bấm viết lại lần nữa`);
  list.sort((a, b) => a.to - b.to);
  const scale = TOTAL / list.at(-1).to; // Gemini kết ở 14.5 hay 16.0 thì co giãn về đúng 15.0
  let prev = 0;
  return list.map((b, i) => {
    const to = i === list.length - 1 ? TOTAL : Math.round(b.to * scale * 10) / 10;
    if (!(to > prev)) throw new Error('Gemini trả về các mốc thời gian không tăng dần — bấm viết lại lần nữa');
    const beat = { from: prev, to, text: b.text };
    prev = to;
    return beat;
  });
}

/**
 * Viết prompt cho động tác mới: gọi Gemini với prompt gốc + luật góc quay, ghép kết quả vào prompt gốc.
 * Trả về { prompt (còn chỗ điền {MODEL}…), exercise, muscleGroup, view, note }.
 */
export async function writeExercisePrompt({ exercise, base = GYM_BASE_PROMPT, rules = GYM_REWRITE_PROMPT, apiKey, model, call = callGeminiWithFallback }) {
  const name = String(exercise || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!name) throw new Error('Chưa nhập tên động tác');
  if (!apiKey) throw new Error('Chưa cấu hình Gemini API Key (Cài đặt → Gemini API key)');
  const promptText = rules.replace(/\{EXERCISE\}/g, name.replace(/"/g, "'")).replace(/\{BASE\}/g, base);
  const res = await call({
    apiKey,
    primaryModel: model || 'gemini-2.5-flash',
    contents: [{ role: 'user', parts: [{ text: promptText }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.4 },
    timeoutMs: 45000,
  });
  for (const k of ['exercise', 'camera', 'form']) {
    if (!oneLine(res?.[k])) throw new Error(`Gemini không trả về phần "${k}" — bấm viết lại lần nữa`);
  }
  const prompt = mergeExerciseIntoPrompt(base, res);
  return {
    prompt,
    exercise: name,
    exerciseEn: oneLine(res.exercise),
    muscleGroup: oneLine(res.muscle_group),
    view: oneLine(res.view),
    note: oneLine(res.note_vi),
  };
}

// Dòng chữ trên video theo lựa chọn (../caption.js)
function captionLine(mode, caption) {
  if (mode === 'none') return NO_TEXT_RULE;
  return `Caption: small white serif text "${caption}" fixed at the top-center for the whole clip; no other text on screen.`;
}
// Chế độ không chữ: câu "… except the caption" trong Rules thành "không có chữ nào"
const rulesFor = (text, mode) => (mode === 'none' ? text.replace(/no text or logos except the caption/i, 'no text or logos anywhere') : text);

/** Dựng prompt gửi Flow từ prompt mẫu (gốc hoặc đã viết lại) + tag ảnh + chữ trên video. */
export function buildGymPrompt({ template, tags, captionMode = 'code', caption = null }) {
  let t = String(template || '').trim() || GYM_BASE_PROMPT;
  if (!/\{CAPTION\}/.test(t)) {
    // Prompt người dùng sửa bỏ mất dòng {CAPTION}: chèn lại ngay sau dòng đầu
    const lines = t.split('\n');
    lines.splice(1, 0, '{CAPTION}');
    t = lines.join('\n');
  }
  return fill(rulesFor(t, captionMode), { MODEL: tags.model, OUTFIT: tags.front, BACK: tags.back, BG: tags.bg, CAPTION: captionLine(captionMode, caption) });
}

const tagOf = (o) => o.code || o.caption || 'không chữ';

// Nguyên liệu: model, mặt trước, mặt sau, bối cảnh (đúng thứ tự @Image1..4) + chữ trên video
function prepare(ctx) {
  const model = ctx.assetPath(ctx.inputs.model);
  const bg = ctx.assetPath(ctx.inputs.background);
  const ids = ctx.inputs.outfits || [];
  if (!model) throw new Error('Ảnh nhân vật không còn trong thư viện');
  if (!bg) throw new Error('Ảnh bối cảnh không còn trong thư viện');
  if (ids.length !== 1) throw new Error(`Video tập gym cần đúng 1 bộ đồ tập (đang chọn ${ids.length})`);
  const id = ids[0];
  const front = ctx.assetPath(id);
  if (!front) throw new Error('Ảnh đồ tập mặt trước không còn trong thư viện');
  const backId = backOf(id, ctx.inputs.outfitBacks?.[id]);
  const back = ctx.assetPath(backId);
  if (!back) throw new Error(`Đồ tập (${ctx.assetName(id)}) chưa có ảnh mặt sau — chọn hoặc bấm "Tạo mặt sau" trong trang quy trình rồi chạy lại`);
  const captionMode = captionModeOf(ctx.run.options);
  const code = codeOfAsset(id) || (captionMode === 'code' ? assignCode(id).productCode : null);
  let caption = null;
  if (captionMode === 'code') caption = code;
  if (captionMode === 'text') {
    caption = cleanCaptionText(ctx.run.options.captionTexts?.[id]);
    if (!caption) throw new Error('Chưa nhập chữ in trên video — nhập ở ô "Chữ trên video" hoặc đổi sang "Mã sản phẩm" / "Không chữ"');
  }
  const images = [model, front, back, bg];
  const tag = (f) => `@Image${images.indexOf(f) + 1}`;
  return { images, tags: { model: '@Image1', front: tag(front), back: tag(back), bg: tag(bg) }, captionMode, caption, code, outfit: { id, code, caption } };
}

export default {
  id: 'video-tap-gym',
  name: 'Video tập gym',
  icon: '🏋️',
  noVideo: true,
  codedInput: 'outfits',
  backInput: 'outfitBacks',
  captionModes: true,
  // Giao diện hiện ô nhập tên động tác + nút gọi Gemini viết prompt + ô sửa prompt (options.exercise, options.customPrompt)
  promptWriter: {
    baseKey: 'base',
    defaultExercise: DEFAULT_EXERCISE,
    placeholder: 'VD: Hip thrust, Deadlift, Lat pulldown, Bench press, Biceps curl…',
  },
  sceneJobs: [{ key: 'video:part1', label: `Video tập gym (${GYM_DURATION})`, note: 'Thử lại / đổi bản → ghép lại (xoá logo) với bản đang chọn.' }],
  description: '1 ảnh nhân vật + 1 bộ đồ tập (mặt trước + mặt sau) + 1 ảnh bối cảnh phòng gym → 1 video 15s không voice: nhân vật mặc sẵn bộ đồ và tập 1 động tác đúng kỹ thuật, máy quay cố định theo nhóm cơ. Nhập tên động tác để Gemini viết prompt mới từ prompt gốc.',
  inputs: [
    { key: 'model', kind: 'model', label: 'Ảnh nhân vật (@Image1)', required: true },
    { key: 'outfits', kind: 'product', label: 'Ảnh đồ tập MẶT TRƯỚC (chọn 1)', required: true, multiple: true, max: 1, hideBackViews: true },
    { key: 'background', kind: 'background', label: 'Ảnh bối cảnh phòng gym', required: true },
  ],
  prompts: {
    base: { label: 'Prompt gốc (động tác trong video mẫu). Dòng Exercise / Camera / Form / các mốc giây là phần của động tác; {MODEL} {OUTFIT} {BACK} {BG} {CAPTION} là chỗ điền', text: GYM_BASE_PROMPT },
    rewrite: { label: 'Hướng dẫn cho Gemini khi viết prompt cho động tác mới (có luật góc quay theo nhóm cơ; {EXERCISE} = tên động tác, {BASE} = prompt gốc)', text: GYM_REWRITE_PROMPT },
  },
  options: [
    { key: 'flowModel', label: 'Mô hình Flow (15s cần Omni 1.2 Flash)', options: FASHION_MODELS.map((m) => ({ value: m, label: m })), default: FASHION_MODELS[0] },
    { key: 'removeWatermark', label: 'Tự động xoá logo Gemini khi ghép', default: true },
    { key: 'autoPublish', label: 'Tự động chuyển sang Đăng video khi hoàn thành', default: true },
  ],

  stages: [
    {
      id: 'video',
      label: `Tạo video ${GYM_DURATION}`,
      async run(ctx) {
        const { images, tags, captionMode, caption, outfit } = prepare(ctx);
        const o = ctx.run.options;
        // Prompt đã viết cho động tác người dùng nhập (đóng băng vào lần chạy); trống = prompt gốc
        const custom = String(o.customPrompt || '').trim();
        const exercise = String(o.exercise || '').trim() || (custom ? 'động tác tuỳ chỉnh' : DEFAULT_EXERCISE.split(' (')[0]);
        const template = buildGymPrompt({ template: custom || ctx.prompt('base'), tags, captionMode, caption });
        const left = template.match(/\{[A-Z]+\}/);
        if (left) throw new Error(`Prompt còn chỗ điền lạ ${left[0]} — chỉ dùng {MODEL} {OUTFIT} {BACK} {BG} {CAPTION}`);
        ctx.state.prompt = template;
        ctx.state.exercise = exercise;
        ctx.state.tag = tagOf(outfit);
        const job = ctx.ensureJob('video:part1', {
          type: 'video',
          imagePaths: images,
          template,
          videoLabel: `[${tagOf(outfit)}] Tập gym · ${exercise.slice(0, 40)} ${GYM_DURATION} – ${ctx.assetName(ctx.inputs.outfits[0])}`,
          meta: { aspectRatio: '9:16', flowVideoModel: o.flowModel || FASHION_MODELS[0], flowDuration: GYM_DURATION, flowResolution: '720p', exercise, captionMode },
        });
        if (job.status === 'failed') throw ctx.jobError(job);
        if (job.status !== 'done') return 'waiting';
        return 'done';
      },
    },
    {
      id: 'merge',
      label: 'Xoá logo & xuất video',
      async run(ctx) {
        const j = ctx.job('video:part1');
        if (!j?.outputPath || !fs.existsSync(j.outputPath)) throw new Error('Thiếu video đầu ra');
        const st = ctx.stages.video || {};
        return ctx.ensureMerge({
          jobIds: [j.id],
          name: `[${st.tag || ''}] Video tập gym · ${(st.exercise || '').slice(0, 40)} – ${ctx.assetName(ctx.inputs.outfits[0])}`,
          removeWatermark: ctx.run.options.removeWatermark ?? true,
          keepOriginalAudio: false,
        });
      },
    },
  ],

  // Thử lại (thêm lần tạo) / chọn lần tạo khác -> chỉ ghép lại với bản đang chọn
  sync(run) {
    const id = run.stages._jobs?.['video:part1'];
    const j = id && db.jobs.find((x) => x.id === id);
    const ms = run.stages.merge;
    const merge = ms?.mergeId && db.merges.find((m) => m.id === ms.mergeId);
    if (merge?.inputPaths && j?.outputPath && merge.inputPaths[0] !== j.outputPath) {
      run.stages.merge = { status: 'pending' };
      return true;
    }
    return false;
  },
};
