// Quy trình "AI Dancing": khung hình 0.1s -> bối cảnh mới -> thay người + sản phẩm cho từng đoạn
// -> thay bối cảnh vào video đã tạo -> ghép lại + chèn âm thanh gốc.
// Quy trình khác (vd. Thay quần áo) viết thành file riêng cùng cấu trúc, không đụng vào file này.

const BACKGROUND_PROMPT = `Completely remove all people from the scene, leaving only the empty background.
Identify the key objects and architectural elements in the original reference and transform their colors to a new harmonious palette: very bright and airy, dominated by soft milky white with only a subtle hint of light beige / pale brown (cream tones), high-key exposure, no yellow, orange or dark, moody tones.
If the space appears too empty, add a few subtle, small decorative details consistent with the setting.
Strictly preserve the original camera angle, perspective, spatial depth and light direction to maintain the exact same environment, but render the lighting bright, soft and evenly exposed so a person placed in this scene later will be well lit.`;

const MOTION_PROMPT = `[PROTOCOL: TOTAL_VISUAL_RECONSTRUCTION]
IDENTITY_FUSION (MULTI-VIEW): Using 3D skeletal motion transfer.
[CORE DIRECTIVE: SKELETAL_IDENTITY_ANCHORING]
1. KINETIC_PRIORITY: The rhythmic timing, speed, and spatial translation of the source video are SACROSANCT. Do not alter the dance path.
2. GEOMETRIC_RECONSTRUCTION: Sculpt the target face's bone structure (jawline, brow, eye sockets) EXACTLY as the reference photo.
3. MOTION_MAP: Anchor every facial pixel onto the source video's head-skeleton. The face must "slide" perfectly with the original dance movement.
4. IDENTITY_OVER_EXPRESSION: If there is a conflict, prioritize the static geometry of the reference face over the fluid expressions of the source.
5. SILENT_WORKFLOW: Ignore all audio data. No lip-sync or speech editing.
STRICT MOTION LOCK: Maintain 100% original skeletal movement. Zero spatial distortion. Keep limb and torso trajectories identical to source.
FINAL_OBJECTIVE: Force the source body to wear the reference outfit and the reference face. The face MUST look like the photo, but the dance MUST be identical to the source video.`;

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
          ctx.state.assetId = ctx.registerAsset('background', job.outputPath, `Bối cảnh – ${ctx.source.name}`).id;
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
      id: 'replace',
      label: 'Thay bối cảnh vào video',
      when: (run) => run.options.replaceBackground,
      // Đầu vào mỗi đoạn = video motion của đoạn đó, hoặc video người dùng nhập thay thế (xem runner.replaceClipVideo)
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
