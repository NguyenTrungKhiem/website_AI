// Quy trình "Video bán hàng thời trang": Tạo video lookbook 10s chuẩn Hàn Quốc (không cần video gốc),
// sử dụng Flow Omni 1.1 Flash kết hợp các ảnh tham chiếu (người mẫu, bối cảnh, trang phục trước/sau, giày, túi).
// Hỗ trợ 2 kịch bản:
// - Trường hợp 1: Đầy đủ outfit (6 ảnh: model, front, back, shoes, bag, scene) với pop-up UI mã sản phẩm.
// - Trường hợp 2: Chỉ trang phục (4 ảnh: model, front, scene, back).

import fs from 'node:fs';

const CASE1_PROMPT = `Duration & Global Setup: Strictly generate a full 10-second video (10 continuous 1-second segments), realistic Korean fashion clip, silent, static camera. Overlay fixed small 20pt white vintage serif typography strictly reading "TODAY'S OUTFIT" (display only the exact words "TODAY'S OUTFIT"; do not print the word 'size' or number '20' on screen) at the top-center fifth without blocking the subject.   Scene: Consistent throughout all 10 seconds using @Image6.   0-1.0s: Wearing the base outfit in @Image1, the model holds the @Image2 front-view garment at her chest, leans forward with bright eyes, and shakes it once.   1.0-2.0s: Clean hard cut to the same spot, now wearing the @Image2 outfit and @Image4 footwear while holding the @Image5 bag, one foot pointed forward, shrugging slightly and smiling at the camera. Simultaneously, pop-up UI overlays appear: on the left side, a small thumbnail of @Image2 with the text "Mã sản phẩm" directly below it; on the bottom-right side, small thumbnails of @Image4 (shoes) and @Image5 (bag), each with the text "Mã sản phẩm" underneath.   2.0-3.0s: The product thumbnails (@Image2 on the left; @Image4 and @Image5 on the bottom-right) and their "Mã sản phẩm" labels remain steadily visible on screen. She tucks side hair behind her ear to reveal her shoulder line, looks down, and flutters her eyelashes.   3.0-4.0s: All product thumbnails and "Mã sản phẩm" text overlays cleanly disappear (ending their 2-second display). She looks up at the camera, smiles, and blinks once.   4.0-5.0s: Shrugs lightly and slides her fingers from her collarbone to press the silver shoulder buttons as she breathes naturally.   5.0-6.0s: Places her hand on the waist ruching, pressing her thumb down along the folds to the first silver button to highlight the tailored silhouette.   6.0-7.0s: Pivots on her heel in place with her long hair swinging, turning to showcase the @Image3 back view of the outfit and the @Image4 footwear.   7.0-8.0s: Turns back to the front, switches the @Image5 bag from one hand to the other, and glances down at it.   8.0-9.0s: Leans sideways against the walnut door frame, smooths her hair ends downward, and looks down with a soft smile.   9.0-10.0s: Looks straight into the camera with her chin slightly raised in a calm, cool vibe, chuckling softly in the final half-second.   Technical Rule: Render the complete 10.0-second duration across all 10 segments with identical lighting, color tone, and background, changing outfits strictly via clean hard cuts with no transition effects or fades. The top text overlay must solely display the words "TODAY'S OUTFIT" in 20pt font scale without showing any size numbers or parentheses.`;

const CASE2_PROMPT = `Setup (10s): Full 10-second silent Korean fashion clip, static camera. Fixed small 20pt white vintage serif typography strictly reading "TODAY'S OUTFIT" (display only the exact words "TODAY'S OUTFIT"; do not print the word 'size' or number '20' on screen) at the top-center fifth, not blocking the subject.   Scene: Consistent across all 10 seconds using @Image3.   0-1.0s: Wearing @Image1, she holds the @Image2 garment in front of her chest, leans forward with bright eyes, and shakes the garment once.   1.0-2.0s: Same spot, now wearing @Image2 in a Korean lookbook pose with one foot pointed forward and arms relaxed, she shrugs slightly and smiles at the camera.   2.0-3.0s: Tucks side hair behind her ear to reveal the shoulder line, looks down, and flutters her eyelashes.   3.0-4.0s: Looks up at the camera, smiles, and blinks once.   4.0-5.0s: Shrugs lightly and slides her fingers from her collarbone to touch the shoulder button details.   5.0-6.0s: Places her hand on the waist ruching, pressing her thumb down along the folds to showcase the structured tailoring.   6.0-7.0s: Pivots on her heel in place with her long hair swinging, turning away from the camera in an angled lookbook posture to showcase the @Image4 back design and tailored lower-back silhouette.   7.0-8.0s: Maintaining the @Image4 back view, she gently smooths the fabric along the lower back seam to highlight the structured fit and drape, then turns back to the front.   8.0-9.0s: Leans sideways against the walnut door frame to show the side profile cut, smooths her hair ends downward, and looks down with a soft smile.   9.0-10.0s: Looks straight into the camera with her chin slightly raised in a calm, confident expression, chuckling softly in the final half-second.   Technical Rule: Render all 10 segments with identical lighting, color tone, and scene, changing outfits strictly via clean hard cuts with no transition effects or fades. The top text overlay must solely display the words "TODAY'S OUTFIT" in 20pt font scale without showing any size numbers or parentheses.`;

export default {
  id: 'video-thoi-trang',
  name: 'Video bán hàng thời trang',
  icon: '🛍️',
  noVideo: true,
  description: 'Tạo video bán hàng thời trang 10s lookbook chuẩn Hàn Quốc (Full outfit hoặc Chỉ trang phục trước/sau). Bóc tách/làm sạch ảnh, tự tạo mặt sau từ mặt trước, sinh video bằng Google Flow.',
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
    case1: { label: 'Prompt Trường hợp 1: Đầy đủ Outfit (@Image1: model, @Image2: trước, @Image3: sau, @Image4: giày, @Image5: túi, @Image6: cảnh)', text: CASE1_PROMPT },
    case2: { label: 'Prompt Trường hợp 2: Chỉ Trang phục (@Image1: model, @Image2: trước, @Image3: cảnh, @Image4: sau)', text: CASE2_PROMPT },
  },
  options: [
    { key: 'caseMode', label: 'Chế độ tạo video', options: ['auto', 'case1', 'case2'], default: 'auto' },
    { key: 'removeWatermark', label: 'Tự động xoá logo Gemini / Đè logo riêng khi tạo xong', default: true },
    { key: 'autoPublish', label: 'Tự động chuyển sang Đăng video khi hoàn thành', default: true },
  ],

  stages: [
    {
      id: 'video',
      label: 'Tạo video 10s trên Flow',
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

        if (!fs.existsSync(model)) throw new Error(`File ảnh người mẫu không tồn tại trên đĩa (${model})`);
        if (!fs.existsSync(bg)) throw new Error(`File ảnh bối cảnh không tồn tại trên đĩa (${bg})`);
        if (!fs.existsSync(front)) throw new Error(`File ảnh trang phục mặt trước không tồn tại trên đĩa (${front})`);
        if (!fs.existsSync(back)) throw new Error(`File ảnh trang phục mặt sau không tồn tại trên đĩa (${back})`);

        const modeOpt = ctx.run.options.caseMode || 'auto';
        const isCase1 = modeOpt === 'case1' || (modeOpt === 'auto' && !!shoes && !!bag);

        let imagePaths;
        let promptTemplate;

        if (isCase1) {
          if (!shoes) throw new Error('Trường hợp 1 (Đầy đủ outfit) cần ảnh giày (footwear)');
          if (!bag) throw new Error('Trường hợp 1 (Đầy đủ outfit) cần ảnh túi xách (bag)');
          // Thứ tự cố định cho Case 1:
          // 1: model, 2: front, 3: back, 4: shoes, 5: bag, 6: background
          imagePaths = [model, front, back, shoes, bag, bg];
          promptTemplate = ctx.prompt('case1');
        } else {
          // Thứ tự cố định cho Case 2:
          // 1: model, 2: front, 3: background, 4: back
          imagePaths = [model, front, bg, back];
          promptTemplate = ctx.prompt('case2');
        }

        const job = ctx.ensureJob('video:main', {
          type: 'video',
          imagePaths,
          template: promptTemplate,
          videoLabel: `Thời trang 10s – ${ctx.assetName(ctx.inputs.outfitFront)}`,
          meta: { aspectRatio: '9:16', isCase1, flowVideoModel: 'Omni 1.1 Flash', flowDuration: '10s' },
        });

        if (job.status === 'failed') throw ctx.jobError(job);
        if (job.status !== 'done') return 'waiting';
        return 'done';
      },
    },
    {
      id: 'merge',
      label: 'Hậu kỳ & Xoá logo',
      async run(ctx) {
        const vJob = ctx.job('video:main');
        if (!vJob?.outputPath) throw new Error('Chưa có video đầu ra');
        return ctx.ensureMerge({
          jobIds: [vJob.id],
          name: `Video thời trang – ${ctx.assetName(ctx.inputs.outfitFront)}`,
          removeWatermark: ctx.run.options.removeWatermark ?? true,
        });
      },
    },
  ],
};
