// Quy trình "Video bán hàng thời trang": Tạo video lookbook chuẩn Hàn Quốc (không cần video gốc),
// sử dụng Flow (model + thời lượng từng cảnh do người dùng chọn trong module) kết hợp các ảnh tham chiếu (người mẫu, bối cảnh, trang phục trước/sau, giày, túi).
// Hỗ trợ 3 kịch bản:
// - Trường hợp 1: Đầy đủ outfit (6 ảnh: model, front, back, shoes, bag, scene) với pop-up UI mã sản phẩm (1 video 10s).
// - Trường hợp 2: Chỉ trang phục (2 Phân cảnh: Cảnh 1 Mặt trước 10s -> Cắt Last Frame -> Cảnh 2 Mặt sau 6s Start Frame -> Ghép 2 video).
// - Trường hợp 3: Áo dài — y như TH2 nhưng prompt gốc riêng cho áo dài và Cảnh 2 dài 10s.
// Chữ "TODAY'S OUTFIT" trong các prompt gốc là chỗ điền: khi gửi Flow được thay bằng mã sản phẩm của ảnh mặt trước
// (options.productCode, vd. VAY_01 — xem ../productCodes.js).

import fs from 'node:fs';
import path from 'node:path';
import { extractLastFrame } from '../ffmpeg.js';
import { DIRS } from '../db.js';
import {
  DEFAULT_FASHION_SCENE1_TEMPLATE, DEFAULT_FASHION_SCENE2_TEMPLATE,
  DEFAULT_FASHION_AODAI_SCENE1_TEMPLATE, DEFAULT_FASHION_AODAI_SCENE2_TEMPLATE,
  sanitizeFlowPromptMentions,
} from '../geminiFashion.js';

// Model / thời lượng Flow cho từng phân cảnh do người dùng chọn ngay trong module (không theo Cài đặt chung)
export const FASHION_MODELS = ['Omni 1.2 Flash', 'Omni 1.1 Flash', 'Veo 3.1 - Fast', 'Veo 3.1 - Quality', 'Veo 3.1 - Lite'];
export const FASHION_DURATIONS = ['10s', '8s', '6s', '4s'];
const DEFAULT_MODEL = FASHION_MODELS[0];
const pickModel = (v) => (FASHION_MODELS.includes(v) ? v : DEFAULT_MODEL);
const pickDuration = (v, fallback) => (FASHION_DURATIONS.includes(v) ? v : fallback);

// Thay chỗ điền "TODAY'S OUTFIT" (cả dấu nháy cong) bằng mã sản phẩm
export function applyProductCode(template, code) {
  if (!code) throw new Error('Chưa có mã sản phẩm để in lên video (ô "Mã sản phẩm" trong module)');
  return template.replace(/TODAY[’']S OUTFIT/g, code);
}

// Chế độ của lần chạy: 'case1' đầy đủ outfit (1 video) | 'case2' chỉ trang phục | 'case3' áo dài (như TH2, prompt riêng, cảnh 2 10s)
function caseOf(run, inputs) {
  const m = run.options.caseMode || 'auto';
  if (m === 'case1' || m === 'case2' || m === 'case3') return m;
  return inputs.shoes && inputs.bag ? 'case1' : 'case2';
}

const CASE1_PROMPT = `Duration & Global Setup: Strictly generate a full 10-second video (10 continuous 1-second segments), realistic Korean fashion clip, silent, static camera. Overlay fixed small 20pt white vintage serif typography strictly reading "TODAY'S OUTFIT" (display only the exact words "TODAY'S OUTFIT"; do not print the word 'size' or number '20' on screen) at the top-center fifth without blocking the subject.   Scene: Consistent throughout all 10 seconds using @Image6.   0-1.0s: Wearing the base outfit in @Image1, the model holds the @Image2 front-view garment at her chest, leans forward with bright eyes, and shakes it once.   1.0-2.0s: Clean hard cut to the same spot, now wearing the @Image2 outfit and @Image4 footwear while holding the @Image5 bag, one foot pointed forward, shrugging slightly and smiling at the camera. Simultaneously, pop-up UI overlays appear: on the left side, a small thumbnail of @Image2 with the text "Mã sản phẩm" directly below it; on the bottom-right side, small thumbnails of @Image4 (shoes) and @Image5 (bag), each with the text "Mã sản phẩm" underneath.   2.0-3.0s: The product thumbnails (@Image2 on the left; @Image4 and @Image5 on the bottom-right) and their "Mã sản phẩm" labels remain steadily visible on screen. She tucks side hair behind her ear to reveal her shoulder line, looks down, and flutters her eyelashes.   3.0-4.0s: All product thumbnails and "Mã sản phẩm" text overlays cleanly disappear (ending their 2-second display). She looks up at the camera, smiles, and blinks once.   4.0-5.0s: Shrugs lightly and slides her fingers from her collarbone to press the silver shoulder buttons as she breathes naturally.   5.0-6.0s: Places her hand on the waist ruching, pressing her thumb down along the folds to the first silver button to highlight the tailored silhouette.   6.0-7.0s: Pivots on her heel in place with her long hair swinging, turning to showcase the @Image3 back view of the outfit and the @Image4 footwear.   7.0-8.0s: Turns back to the front, switches the @Image5 bag from one hand to the other, and glances down at it.   8.0-9.0s: Leans sideways against the walnut door frame, smooths her hair ends downward, and looks down with a soft smile.   9.0-10.0s: Looks straight into the camera with her chin slightly raised in a calm, cool vibe, chuckling softly in the final half-second.   Technical Rule: Render the complete 10.0-second duration across all 10 segments with identical lighting, color tone, and background, changing outfits strictly via clean hard cuts with no transition effects or fades. The top text overlay must solely display the words "TODAY'S OUTFIT" in 20pt font scale without showing any size numbers or parentheses.`;

export default {
  id: 'video-thoi-trang',
  name: 'Video bán hàng thời trang',
  icon: '🛍️',
  noVideo: true,
  description: 'Tạo video bán hàng thời trang lookbook chuẩn Hàn Quốc (Full outfit hoặc 2 Phân cảnh Mặt trước/sau kế thừa Khung hình). Bóc tách/làm sạch ảnh, AI phân tích sản phẩm và sinh prompt tùy biến.',
  inputs: [
    { key: 'model', kind: 'model', label: 'Ảnh người mẫu', required: true },
    { key: 'background', kind: 'background', label: 'Ảnh bối cảnh', required: true },
    { key: 'outfitSheet', kind: 'product', label: 'Ảnh tổng hợp outfit (giày + túi + trang phục trước/sau)', required: false },
    { key: 'outfitFront', kind: 'product', label: 'Trang phục – Mặt trước', required: true },
    { key: 'outfitBack', kind: 'product', label: 'Trang phục – Mặt sau', required: true },
    { key: 'shoes', kind: 'product', label: 'Ảnh giày (cho TH1: Đầy đủ outfit)', required: false },
    { key: 'bag', kind: 'product', label: 'Ảnh túi xách (cho TH1: Đầy đủ outfit)', required: false },
  ],
  prompts: {
    case1: { label: 'Prompt TH1: Đầy đủ Outfit (@Image1: model, @Image2: trước, @Image3: sau, @Image4: giày, @Image5: túi, @Image6: cảnh)', text: CASE1_PROMPT },
    case2_scene1: { label: 'Prompt TH2 - Phân cảnh 1: Mặt trước (10s)', text: DEFAULT_FASHION_SCENE1_TEMPLATE },
    case2_scene2: { label: 'Prompt TH2 - Phân cảnh 2: Mặt sau (6s - Khung hình bắt đầu)', text: DEFAULT_FASHION_SCENE2_TEMPLATE },
    case3_scene1: { label: 'Prompt TH3 Áo dài - Phân cảnh 1: Mặt trước (10s)', text: DEFAULT_FASHION_AODAI_SCENE1_TEMPLATE },
    case3_scene2: { label: 'Prompt TH3 Áo dài - Phân cảnh 2: Mặt sau (10s - Khung hình bắt đầu)', text: DEFAULT_FASHION_AODAI_SCENE2_TEMPLATE },
  },
  options: [
    { key: 'caseMode', label: 'Chế độ tạo video', options: ['auto', 'case1', 'case2', 'case3'], default: 'auto' },
    { key: 'promptScene1', label: 'Prompt Phân cảnh 1' },
    { key: 'promptScene2', label: 'Prompt Phân cảnh 2' },
    { key: 'customPrompt', label: 'Prompt TH1' },
    { key: 'productCode', label: `Mã sản phẩm in trên video (thay "TODAY'S OUTFIT")` },
    // Model / thời lượng Flow từng cảnh (TH1 dùng của cảnh 1). Cảnh 2: TH2 mặc định 6s, TH3 mặc định 10s
    { key: 'scene1Model', label: 'Mô hình Flow – Cảnh 1 / TH1', default: DEFAULT_MODEL },
    { key: 'scene1Duration', label: 'Thời lượng – Cảnh 1 / TH1', default: '10s' },
    { key: 'scene2Model', label: 'Mô hình Flow – Cảnh 2', default: DEFAULT_MODEL },
    { key: 'scene2Duration', label: 'Thời lượng – Cảnh 2', default: '' },
    { key: 'removeWatermark', label: 'Tự động xoá logo Gemini / Đè logo riêng khi tạo xong', default: true },
    { key: 'autoPublish', label: 'Tự động chuyển sang Đăng video khi hoàn thành', default: true },
  ],

  stages: [
    {
      id: 'scene1',
      label: 'Phân cảnh 1 (Mặt trước)',
      async run(ctx) {
        const model = ctx.assetPath(ctx.inputs.model);
        const bg = ctx.assetPath(ctx.inputs.background);
        const front = ctx.assetPath(ctx.inputs.outfitFront);
        const back = ctx.assetPath(ctx.inputs.outfitBack);
        const shoes = ctx.assetPath(ctx.inputs.shoes);
        const bag = ctx.assetPath(ctx.inputs.bag);

        if (!model) throw new Error('Chưa chọn hoặc thiếu ảnh người mẫu');
        if (!bg) throw new Error('Chưa chọn hoặc thiếu ảnh bối cảnh');
        if (!front) throw new Error('Chưa chọn hoặc thiếu ảnh trang phục mặt trước');
        if (!back) throw new Error('Chưa chọn hoặc thiếu ảnh trang phục mặt sau');

        if (!fs.existsSync(model)) throw new Error(`File ảnh người mẫu không tồn tại (${model})`);
        if (!fs.existsSync(bg)) throw new Error(`File ảnh bối cảnh không tồn tại (${bg})`);
        if (!fs.existsSync(front)) throw new Error(`File ảnh trang phục mặt trước không tồn tại (${front})`);
        if (!fs.existsSync(back)) throw new Error(`File ảnh trang phục mặt sau không tồn tại (${back})`);

        const mode = caseOf(ctx.run, ctx.inputs);
        const isCase1 = mode === 'case1';
        const o = ctx.run.options;
        const model1 = pickModel(o.scene1Model);
        const dur1 = pickDuration(o.scene1Duration, '10s');
        const code = o.productCode;
        const tag = `[${code}] `;

        if (isCase1) {
          if (!shoes) throw new Error('Trường hợp 1 (Đầy đủ outfit) cần ảnh giày (footwear)');
          if (!bag) throw new Error('Trường hợp 1 (Đầy đủ outfit) cần ảnh túi xách (bag)');
          const imagePaths = [model, front, back, shoes, bag, bg];
          const rawTemplate = (o.customPrompt || '').trim() || ctx.prompt('case1');
          const template = sanitizeFlowPromptMentions(applyProductCode(rawTemplate, code), true);

          const job = ctx.ensureJob('video:main', {
            type: 'video',
            imagePaths,
            template,
            videoLabel: `${tag}Thời trang ${dur1} – ${ctx.assetName(ctx.inputs.outfitFront)}`,
            meta: { aspectRatio: '9:16', isCase1: true, flowVideoModel: model1, flowDuration: dur1 },
          });

          if (job.status === 'failed') throw ctx.jobError(job);
          if (job.status !== 'done') return 'waiting';
          return 'done';
        }

        // Trường hợp 2 / 3: Phân cảnh 1 (Mặt trước - 10s). TH3 (áo dài) dùng prompt gốc riêng
        const imagePaths = [model, front, bg, back];
        const rawTemplate = (o.promptScene1 || '').trim() || ctx.prompt(mode === 'case3' ? 'case3_scene1' : 'case2_scene1');
        const template = sanitizeFlowPromptMentions(applyProductCode(rawTemplate, code), false);

        const job1 = ctx.ensureJob('video:scene1', {
          type: 'video',
          imagePaths,
          template,
          videoLabel: `${tag}${mode === 'case3' ? 'Áo dài' : 'Thời trang'} Cảnh 1 (Mặt trước ${dur1}) – ${ctx.assetName(ctx.inputs.outfitFront)}`,
          meta: { aspectRatio: '9:16', isCase1: false, flowVideoModel: model1, flowDuration: dur1, flowResolution: '720p' },
        });

        if (job1.status === 'failed') throw ctx.jobError(job1);
        if (job1.status !== 'done') return 'waiting';
        return 'done';
      },
    },
    {
      id: 'last_frame',
      label: 'Cắt khung hình cuối Cảnh 1',
      async run(ctx) {
        if (caseOf(ctx.run, ctx.inputs) === 'case1') return 'done';

        const j1 = ctx.job('video:scene1');
        if (!j1?.outputPath || !fs.existsSync(j1.outputPath)) throw new Error('Chưa có video Phân cảnh 1 để cắt khung hình');

        if (!ctx.state.lastFramePath || !fs.existsSync(ctx.state.lastFramePath)) {
          const dest = path.join(DIRS.tmp, `fashion-last-frame-${j1.id}.png`);
          await extractLastFrame(j1.outputPath, dest);
          ctx.state.lastFramePath = dest;
          (ctx.stages.last_frame ||= {}).lastFramePath = dest;
        }
        return 'done';
      },
    },
    {
      id: 'scene2',
      label: 'Phân cảnh 2 (Mặt sau - Khung hình)',
      async run(ctx) {
        const mode = caseOf(ctx.run, ctx.inputs);
        if (mode === 'case1') return 'done';

        const framePath = ctx.stages.last_frame?.lastFramePath || ctx.state.lastFramePath;
        if (!framePath || !fs.existsSync(framePath)) throw new Error('Chưa có ảnh khung hình cuối của Phân cảnh 1');

        const o = ctx.run.options;
        const rawTemplate = (o.promptScene2 || '').trim() || ctx.prompt(mode === 'case3' ? 'case3_scene2' : 'case2_scene2');
        // Cảnh 2 thường không có chữ tiêu đề, nhưng nếu prompt có "TODAY'S OUTFIT" thì cũng thay bằng mã
        const template = sanitizeFlowPromptMentions(o.productCode ? applyProductCode(rawTemplate, o.productCode) : rawTemplate, false);
        const dur2 = pickDuration(o.scene2Duration, mode === 'case3' ? '10s' : '6s');

        const job2 = ctx.ensureJob('video:scene2', {
          type: 'video',
          imagePaths: [framePath],
          template,
          videoLabel: `${o.productCode ? `[${o.productCode}] ` : ''}${mode === 'case3' ? 'Áo dài' : 'Thời trang'} Cảnh 2 (Mặt sau ${dur2}) – ${ctx.assetName(ctx.inputs.outfitFront)}`,
          meta: {
            aspectRatio: '9:16',
            flowVideoModel: pickModel(o.scene2Model),
            flowDuration: dur2,
            flowResolution: '720p',
            flowVideoMode: 'frames',
            isFramesMode: true,
          },
        });

        if (job2.status === 'failed') throw ctx.jobError(job2);
        if (job2.status !== 'done') return 'waiting';
        return 'done';
      },
    },
    {
      id: 'merge',
      label: 'Ghép video & Xoá logo',
      async run(ctx) {
        const mode = caseOf(ctx.run, ctx.inputs);
        const isCase1 = mode === 'case1';

        let jobIds;
        let mergeName;
        const tag = ctx.run.options.productCode ? `[${ctx.run.options.productCode}] ` : '';

        if (isCase1) {
          const vJob = ctx.job('video:main');
          if (!vJob?.outputPath) throw new Error('Chưa có video đầu ra');
          jobIds = [vJob.id];
          mergeName = `${tag}Video thời trang – ${ctx.assetName(ctx.inputs.outfitFront)}`;
        } else {
          const j1 = ctx.job('video:scene1');
          const j2 = ctx.job('video:scene2');
          if (!j1?.outputPath || !fs.existsSync(j1.outputPath)) throw new Error('Thiếu video Phân cảnh 1');
          if (!j2?.outputPath || !fs.existsSync(j2.outputPath)) throw new Error('Thiếu video Phân cảnh 2');
          jobIds = [j1.id, j2.id];
          mergeName = `${tag}${mode === 'case3' ? 'Video áo dài' : 'Video thời trang'} (2 Cảnh) – ${ctx.assetName(ctx.inputs.outfitFront)}`;
        }

        return ctx.ensureMerge({
          jobIds,
          name: mergeName,
          removeWatermark: ctx.run.options.removeWatermark ?? true,
          keepOriginalAudio: ctx.run.options.keepAudio !== false,
        });
      },
    },
  ],
};
