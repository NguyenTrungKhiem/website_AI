// Quy trình "Fashion V2V": không tạo bối cảnh — bối cảnh là ảnh người dùng chọn sẵn.
// Người dùng chọn: ảnh khuôn mặt, ảnh sản phẩm, ảnh bối cảnh. Web tự tạo "ảnh 1" = bảng vóc dáng toàn thân 16:9
// (turnaround: trước / nghiêng / sau) của nhân vật mặc sản phẩm (Nano Banana, 0 credit), dừng cho người dùng duyệt,
// rồi mỗi đoạn tạo 1 lần video với nguyên liệu theo thứ tự cố định:
//   ảnh 1 vóc dáng 16:9 → ảnh 2 khuôn mặt → ảnh 3 sản phẩm → ảnh 4 bối cảnh → video gốc.
// Cuối cùng ghép các đoạn + chèn âm thanh gốc. Prompt mẫu do người dùng đưa; {inputs} điền tự động.

const TURNAROUND_PROMPT = `HIGH-FASHION TURNAROUND: A professional character turnaround sheet of the person from the reference image wearing the provided fashion item. Show front, side, and back views. Clean studio lighting, high-end commercial aesthetic, consistent character face and outfit details across all views.`;

const V2V_PROMPT = `Inputs, in order: {inputs}

CINEMATIC FASHION V2V & ENVIRONMENT SWAP:
1. GARMENT: Replace the outfit in the source video with the EXACT clothing shown in the reference images.
2. IDENTITY: Maintain the person's face, hair, and motion from the original video perfectly.
3. ENVIRONMENT REPLACEMENT: Completely replace the video background with the scene from the background reference image. Sync lighting, shadows, and atmosphere to match the reference image environment.

Style: Luxury fashion ad, crisp 4K details, smooth cinematic movement. Giữ nguyên hiệu ứng chuyển động của nhân vật. Chỉ thay đổi bối cảnh và hình nhân vật theo tham chiếu; các hình ảnh phải xuyên suốt video.`;

const INPUTS_LINE = [
  'image 1 = full-body turnaround of the model wearing the garment (16:9): her body shape, proportions and the outfit from all sides',
  'image 2 = the model\'s face: her identity',
  'image 3 = the product / garment to wear',
  'image 4 = the background scene to place her in',
  'then the source video (motion to follow frame by frame)',
].join('; ');

export default {
  id: 'fashion-v2v',
  name: 'Fashion V2V',
  icon: '🎬',
  description: 'Chọn mặt + sản phẩm + bối cảnh có sẵn: web tự tạo ảnh vóc dáng 16:9 mặc sản phẩm (0 credit), bạn duyệt, rồi mỗi đoạn tạo 1 lần video (4 ảnh + video gốc) thay trang phục và bối cảnh, giữ nguyên chuyển động; cuối cùng ghép lại.',
  inputs: [
    { key: 'face', kind: 'model', label: 'Ảnh 2 – khuôn mặt nhân vật', required: true },
    { key: 'product', kind: 'product', label: 'Ảnh 3 – sản phẩm / trang phục', required: true },
    { key: 'background', kind: 'background', label: 'Ảnh 4 – bối cảnh (ảnh có sẵn)', required: true },
  ],
  prompts: {
    turnaround: { label: '1. Tạo ảnh vóc dáng toàn thân 16:9 (từ ảnh mặt + sản phẩm)', text: TURNAROUND_PROMPT },
    v2v: { label: '2. Tạo video từng đoạn ({inputs} điền tự động: ảnh 1 vóc dáng → 2 mặt → 3 sản phẩm → 4 bối cảnh → video)', text: V2V_PROMPT },
  },
  options: [
    { key: 'reviewTurnaround', label: 'Dừng lại để kiểm tra ảnh vóc dáng trước khi tạo video (bấm Tiếp tục mới tốn credit)', default: true },
    { key: 'merge', label: 'Ghép các đoạn lại + chèn âm thanh gốc', default: true },
    { key: 'removeWatermark', label: 'Tự động xoá logo Gemini khi ghép', default: true },
    { key: 'autoPublish', label: 'Tự động chuyển sang Đăng video khi hoàn thành', default: true },
  ],

  stages: [
    {
      id: 'turnaround',
      label: 'Tạo ảnh vóc dáng 16:9',
      // Ảnh = Nano Banana (0 credit), ép 16:9; nguyên liệu: ảnh mặt → ảnh sản phẩm. Kết quả lưu thành ảnh model
      // (có flowTitle để bước video dùng lại ngay trên Flow). Tạo lại -> runner.syncRun cập nhật và làm lại video.
      async run(ctx) {
        const face = ctx.assetPath(ctx.inputs.face);
        const product = ctx.assetPath(ctx.inputs.product);
        if (!face || !product) throw new Error('Ảnh khuôn mặt / sản phẩm không còn trong thư viện — chọn lại rồi chạy lại.');
        const job = ctx.ensureJob('turnaround:sheet', {
          type: 'image',
          imagePaths: [face, product],
          template: ctx.prompt('turnaround'),
          videoLabel: `Vóc dáng 16:9 – ${ctx.source.name}`,
          meta: { aspectRatio: '16:9' },
        });
        if (job.status === 'failed') throw ctx.jobError(job);
        if (job.status !== 'done') return 'waiting';
        if (!ctx.state.assetId) {
          const att = job.attempts.find((a) => a.outputPath === job.outputPath);
          ctx.state.assetId = ctx.registerAsset('model', job.outputPath, `Vóc dáng 16:9 – ${ctx.source.name}`, { flowTitle: att?.flowTitle || null }).id;
          ctx.state.assetFrom = job.outputPath;
        }
        return 'done';
      },
    },
    {
      id: 'review',
      label: 'Kiểm tra ảnh vóc dáng',
      when: (run) => run.options.reviewTurnaround !== false,
      async run(ctx) {
        return ctx.state.approved ? 'done' : 'paused';
      },
    },
    {
      id: 'motion',
      label: 'Thay trang phục + bối cảnh (V2V)',
      async run(ctx) {
        const body = ctx.assetPath(ctx.stages.turnaround.assetId);
        const paths = [body, ...['face', 'product', 'background'].map((k) => ctx.assetPath(ctx.inputs[k]))];
        if (paths.some((p) => !p)) throw new Error('Thiếu ảnh tham chiếu (vóc dáng / mặt / sản phẩm / bối cảnh không còn trong thư viện).');
        const template = ctx.prompt('v2v').replace('{inputs}', INPUTS_LINE);
        const jobs = ctx.clips.map((clip) =>
          ctx.ensureJob(`motion:${clip.id}`, {
            type: 'motion',
            videoPath: clip.path,
            videoLabel: clip.name,
            imagePaths: paths, // đúng thứ tự: vóc dáng, mặt, sản phẩm, bối cảnh (rồi tới video)
            template,
            sourceRange: { sourceId: clip.sourceId, start: clip.start, end: clip.end },
          }),
        );
        return ctx.waitAll(jobs);
      },
    },
    {
      id: 'merge',
      label: 'Ghép video & xoá logo',
      when: (run) => run.options.merge,
      async run(ctx) {
        const jobIds = ctx.clips.map((clip) => ctx.job(`motion:${clip.id}`).id);
        return ctx.ensureMerge({
          jobIds,
          name: `${ctx.source.name.replace(/\.[^.]+$/, '')} – Fashion V2V`,
          removeWatermark: ctx.run.options.removeWatermark ?? true,
          watermarkMode: 'delogo',
        });
      },
    },
  ],
};
