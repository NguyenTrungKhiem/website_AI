// Quy trình "AI Dancing": khung hình 0.1s -> bối cảnh mới -> thay người + sản phẩm cho từng đoạn
// -> thay bối cảnh vào video đã tạo -> ghép lại + chèn âm thanh gốc.
// Quy trình khác (vd. Thay quần áo) viết thành file riêng cùng cấu trúc, không đụng vào file này.

const BACKGROUND_PROMPT = `Completely remove all people from the scene, leaving only the empty background.
Identify the key objects and architectural elements in the original reference and transform their colors to a new harmonious palette: very bright and airy, dominated by soft milky white with only a subtle hint of light beige / pale brown (cream tones), high-key exposure, no yellow, orange or dark, moody tones.
If the space appears too empty, add a few subtle, small decorative details consistent with the setting.
Strictly preserve the original camera angle, perspective, spatial depth and light direction to maintain the exact same environment, but render the lighting bright, soft and evenly exposed so a person placed in this scene later will be well lit.`;

// Bước 2 – thay nhân vật + sản phẩm. Thứ tự file trong ô prompt Flow: ảnh 1 = model, ảnh 2 = sản phẩm, rồi video gốc.
// Viết bằng câu rõ ràng (model video hiểu tốt hơn thuật ngữ giả kỹ thuật), tách 3 phần: GIỮ NGUYÊN / THAY / CẤM,
// nhấn mạnh khớp từng khung với video gốc vì đây là chỗ hay lệch nhất.
const MOTION_PROMPT = `Video-to-video character and outfit replacement. Inputs, in order: image 1 = the model (face and identity), image 2 = the outfit (product), then the source video.

KEEP EXACTLY FROM THE SOURCE VIDEO, frame by frame, for its full duration:
- The same dance: every movement, pose, gesture, step, turn and hair flip, with identical timing, speed and rhythm. Each output frame must match the source frame at the same moment. Do not add, skip, smooth out, slow down or speed up any movement.
- The same body position and size in the frame, the same distance to the camera, and the same camera framing, angle, zoom and camera movement. If the camera is static in the source, keep it static.
- The same background, room, lighting direction and color temperature. Do not change or clean up the background.
- The same body proportions and silhouette as the dancer, so the movement fits naturally.

REPLACE:
- The dancer's face, head and hair with the person in image 1. Match her face exactly: face shape, jawline, eyes, eyebrows, nose, lips, skin tone and hairstyle. Keep this same face consistent in every frame, including when she turns her head, moves fast or is partly in profile. The facial expression may follow the source naturally, but the identity must stay the same.
- The dancer's clothing with the garment in image 2. Reproduce it exactly: same color, pattern, print, fabric and sheen, neckline, straps, sleeves, length, fit and every detail. She wears only this garment as her outfit, and it moves, folds and stretches realistically with every dance movement.

DO NOT:
- Do not invent new moves, change the choreography, or change the camera.
- Do not add text, logos, watermarks, captions, extra people, accessories or props that are not in the inputs.
- Do not morph, flicker or drift the face, body or clothes between frames. Hands, fingers, arms and legs must stay natural and anatomically correct.
- Ignore the audio of the source video. No lip-sync or speech.

Output: a photorealistic video with the same duration, aspect ratio and framing as the source video, looking like the person in image 1 performed this exact dance wearing the garment from image 2.`;

const REPLACE_PROMPT = `Keep the person, their motion, the product and the camera movement exactly the same as the input video.
Replace only the background and environment with the scene shown in the reference image, with matching lighting, shadows and perspective so it looks naturally filmed there.`;

export default {
  id: 'dancing',
  name: 'AI Dancing',
  icon: '💃',
  description: 'Thay người nhảy bằng model của bạn, đưa sản phẩm vào, đổi bối cảnh mới và ghép lại thành video hoàn chỉnh.',
  inputs: [
    { key: 'model', kind: 'model', label: 'Ảnh model', required: true },
    { key: 'product', kind: 'product', label: 'Ảnh sản phẩm', required: false },
  ],
  prompts: {
    background: { label: '1. Tạo bối cảnh mới (từ khung hình 0.1s của video gốc)', text: BACKGROUND_PROMPT },
    motion: { label: '2. Thay nhân vật + sản phẩm (từng đoạn đã cắt)', text: MOTION_PROMPT },
    replace: { label: '3. Thay bối cảnh mới vào video đã tạo', text: REPLACE_PROMPT },
  },
  options: [
    { key: 'replaceBackground', label: 'Tạo bối cảnh mới và thay vào video', default: true },
    { key: 'reviewMotion', label: 'Dừng lại để kiểm tra video sau bước thay nhân vật (bấm Tiếp tục mới thay bối cảnh)', default: true },
    { key: 'merge', label: 'Ghép các đoạn lại + chèn âm thanh gốc', default: true },
    { key: 'removeWatermark', label: 'Tự động xoá logo Gemini khi ghép', default: true },
    { key: 'autoPublish', label: 'Tự động chuyển sang Đăng video khi hoàn thành', default: true },
  ],

  // Mỗi bước được gọi lặp lại cho tới khi trả về 'done'; phải an toàn khi gọi nhiều lần.
  stages: [
    {
      id: 'frame',
      label: 'Cắt khung hình 0.1s',
      when: (run) => run.options.replaceBackground,
      async run(ctx) {
        if (!ctx.state.path) ctx.state.path = await ctx.frame(0.1);
        return 'done';
      },
    },
    {
      id: 'background',
      label: 'Tạo bối cảnh mới',
      when: (run) => run.options.replaceBackground,
      async run(ctx) {
        const job = ctx.ensureJob('background:bg', {
          type: 'image',
          imagePaths: [ctx.stages.frame.path],
          template: ctx.prompt('background'),
          videoLabel: `Bối cảnh – ${ctx.source.name}`,
        });
        if (job.status === 'failed') throw ctx.jobError(job);
        if (job.status !== 'done') return 'waiting';
        if (!ctx.state.assetId) {
          // flowTitle = tên ảnh này trên Flow -> bước thay bối cảnh dùng lại ngay, không tải lên lại
          const att = job.attempts.find((a) => a.outputPath === job.outputPath);
          ctx.state.assetId = ctx.registerAsset('background', job.outputPath, `Bối cảnh – ${ctx.source.name}`, { flowTitle: att?.flowTitle || null }).id;
          ctx.state.assetFrom = job.outputPath; // để biết khi ảnh bối cảnh được tạo lại
        }
        return 'done';
      },
    },
    {
      id: 'motion',
      label: 'Thay nhân vật + sản phẩm',
      async run(ctx) {
        const jobs = ctx.clips.map((clip) =>
          ctx.ensureJob(`motion:${clip.id}`, {
            type: 'motion',
            videoPath: clip.path,
            videoLabel: clip.name,
            assets: { model: ctx.inputs.model || null, product: ctx.inputs.product || null },
            template: ctx.prompt('motion'),
            sourceRange: { sourceId: clip.sourceId, start: clip.start, end: clip.end },
          }),
        );
        return ctx.waitAll(jobs);
      },
    },
    {
      id: 'review',
      label: 'Kiểm tra video',
      when: (run) => run.options.replaceBackground && run.options.reviewMotion !== false,
      // Dừng lại cho người dùng xem video thay nhân vật (Thử lại / Sửa prompt nếu chưa ưng);
      // bấm "Tiếp tục" mới sang bước thay bối cảnh (bắt đầu tốn credit). Video motion đổi -> kiểm tra lại.
      async run(ctx) {
        return ctx.state.approved ? 'done' : 'paused';
      },
    },
    {
      id: 'replace',
      label: 'Thay bối cảnh vào video',
      when: (run) => run.options.replaceBackground,
      // Đầu vào mỗi đoạn = video motion của đoạn đó, hoặc video người dùng nhập thay thế (xem runner.replaceClipVideo).
      // Ảnh bối cảnh do Flow tạo được dùng lại ngay trên Flow (asset có flowTitle), không tải lên lại.
      async run(ctx) {
        const jobs = ctx.clips.map((clip) => {
          const parent = ctx.job(`motion:${clip.id}`);
          return ctx.ensureJob(`replace:${clip.id}`, {
            type: 'background',
            videoPath: parent.outputPath,
            parentJobId: parent.id,
            videoLabel: clip.name,
            assets: { background: ctx.stages.background.assetId },
            template: ctx.prompt('replace'),
            sourceRange: { sourceId: clip.sourceId, start: clip.start, end: clip.end },
          });
        });
        return ctx.waitAll(jobs);
      },
    },
    {
      id: 'merge',
      label: 'Ghép video & xoá logo',
      when: (run) => run.options.merge,
      async run(ctx) {
        const finalKey = ctx.run.options.replaceBackground ? 'replace' : 'motion';
        const jobIds = ctx.clips.map((clip) => ctx.job(`${finalKey}:${clip.id}`).id);
        return ctx.ensureMerge({
          jobIds,
          name: `${ctx.source.name.replace(/\.[^.]+$/, '')} – AI Dancing`,
          removeWatermark: ctx.run.options.removeWatermark ?? true,
          watermarkMode: 'delogo',
        });
      },
    },
  ],
};
