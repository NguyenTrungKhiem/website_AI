// Quy trình "Thay trang phục": giống AI Dancing (face swap + thay đồ + bối cảnh mới + ghép) nhưng video gốc
// gồm nhiều cảnh, mỗi cảnh một bộ trang phục khác, nên MỖI ĐOẠN có ảnh trang phục riêng (mặt trước, mặt sau tuỳ chọn
// cho lúc nhân vật quay lưng). Yêu cầu quan trọng nhất: khuôn mặt phải giống hệt nhau từ đoạn 1 tới đoạn cuối.
//
// Cách giữ mặt nhất quán: mọi đoạn dùng cùng 1 ảnh model, VÀ (tuỳ chọn, mặc định bật) đoạn 1 được render trước,
// lấy 1 khung hình mặt đã render của đoạn 1 làm "mỏ neo" đưa thêm vào các đoạn sau, để các đoạn sau bám theo
// đúng khuôn mặt ĐÃ RENDER chứ không chỉ theo ảnh chụp — cùng một người, cùng một buổi quay.
//
// Thứ tự file trong ô prompt Flow cho mỗi đoạn: ảnh model → (khung mặt khoá) → trang phục mặt trước → (mặt sau) → video gốc.
// Trong prompt mẫu có các chỗ điền tự động: {inputs} (danh sách ảnh theo thứ tự), {identity_rule}, {outfit_rule}.

const BACKGROUND_PROMPT = `Completely remove all people from the scene, leaving only the empty background.
Identify the key objects and architectural elements in the original reference and transform their colors to a new harmonious palette: very bright and airy, dominated by soft milky white with only a subtle hint of light beige / pale brown (cream tones), high-key exposure, no yellow, orange or dark, moody tones.
If the space appears too empty, add a few subtle, small decorative details consistent with the setting.
Strictly preserve the original camera angle, perspective, spatial depth and light direction to maintain the exact same environment, but render the lighting bright, soft and evenly exposed so a person placed in this scene later will be well lit.`;

const MOTION_PROMPT = `Video-to-video face and outfit replacement. This is ONE shot of a multi-shot video of the SAME person: her identity must be identical in every shot of this video.
Inputs, in order: {inputs}

KEEP EXACTLY FROM THE SOURCE VIDEO, frame by frame, for its full duration:
- The same movement: every pose, gesture, step, turn, walk and hair motion, with identical timing, speed and rhythm. Each output frame must match the source frame at the same moment. Do not add, skip, smooth out, slow down or speed up any movement.
- The same body position and size in the frame, the same distance to the camera, and the same camera framing, angle, zoom and camera movement. If the camera is static in the source, keep it static.
- The same background, room, lighting direction and color temperature. Do not change or clean up the background.
- The same body proportions and silhouette as the person in the source, so the movement fits naturally.

REPLACE:
- The person's face, head and hair with the model in image 1. Match her face exactly: face shape, jawline, eyes, eyebrows, nose, lips, skin tone and hairstyle. {identity_rule} Keep this same face consistent in every frame, including when she turns her head, moves fast, is partly in profile or turns away and back. The facial expression may follow the source naturally, but the identity must never change.
- The person's clothing with the outfit shown in the outfit image(s). Reproduce it exactly: same color, pattern, print, fabric and sheen, neckline, straps, sleeves, length, fit and every detail. She wears only this outfit, and it moves, folds and stretches realistically with every movement. {outfit_rule}

DO NOT:
- Do not invent new moves, change the choreography, or change the camera.
- Do not add text, logos, watermarks, captions, extra people, accessories or props that are not in the inputs.
- Do not morph, flicker or drift the face, body or clothes between frames. Hands, fingers, arms and legs must stay natural and anatomically correct.
- Ignore the audio of the source video. No lip-sync or speech.

Output: a photorealistic video with the same duration, aspect ratio and framing as the source video, looking like the model in image 1 performed exactly this shot wearing the given outfit — and looking like the very same person as in the other shots of this video.`;

const REPLACE_PROMPT = `Keep the person, their motion, the outfit and the camera movement exactly the same as the input video.
Replace only the background and environment with the scene shown in the reference image, with matching lighting, shadows and perspective so it looks naturally filmed there.`;

// Điền {inputs} / {identity_rule} / {outfit_rule} theo số ảnh thật sự gửi cho đoạn này
function fillMotion(template, { anchor, back }) {
  const lines = ['image 1 = the model: her face and identity'];
  let n = 2;
  if (anchor) lines.push(`image ${n++} = the same model as already rendered in the first shot of this video (her final on-screen look): match this face exactly`);
  lines.push(`image ${n++} = the outfit, front view`);
  if (back) lines.push(`image ${n++} = the same outfit, back view`);
  lines.push('then the source video');
  const identityRule = anchor
    ? 'Her face must match BOTH image 1 and image 2 (the already rendered first shot), so every shot of this video looks like the same person filmed in one session.'
    : 'Use image 1 as the only reference for her identity, exactly as it is.';
  const outfitRule = back
    ? 'When the person turns away from the camera, render the back of the outfit exactly as in the back-view image; front and back are the same garment.'
    : 'If the person turns away from the camera, render the back of the outfit consistently with its front design, colors and materials.';
  return template
    .replace('{inputs}', lines.join('; '))
    .replace('{identity_rule}', identityRule)
    .replace('{outfit_rule}', outfitRule);
}

export default {
  id: 'thay-trang-phuc',
  name: 'Thay trang phục',
  icon: '👗',
  description: 'Video gốc có nhiều cảnh, mỗi cảnh một bộ đồ: thay mặt bằng model của bạn, mỗi đoạn mặc đúng trang phục của đoạn đó (có mặt sau khi quay lưng), bối cảnh mới, mặt giữ nguyên từ đầu tới cuối.',
  inputs: [
    { key: 'model', kind: 'model', label: 'Ảnh model (dùng chung mọi đoạn)', required: true },
  ],
  perClipInputs: [
    { key: 'outfit', kind: 'product', label: 'Trang phục – mặt trước', required: true },
    { key: 'outfitBack', kind: 'product', label: 'Mặt sau (khi quay lưng, tuỳ chọn)', required: false },
  ],
  prompts: {
    background: { label: '1. Tạo bối cảnh mới (từ khung hình 0.1s của video gốc)', text: BACKGROUND_PROMPT },
    motion: { label: '2. Thay mặt + trang phục (từng đoạn; {inputs}, {identity_rule}, {outfit_rule} được điền tự động)', text: MOTION_PROMPT },
    replace: { label: '3. Thay bối cảnh mới vào video đã tạo', text: REPLACE_PROMPT },
  },
  options: [
    { key: 'identityAnchor', label: 'Khoá khuôn mặt: render đoạn 1 trước, lấy mặt đã render làm mẫu cho các đoạn sau', default: true },
    { key: 'replaceBackground', label: 'Tạo bối cảnh mới và thay vào video', default: true },
    { key: 'reviewMotion', label: 'Dừng lại để kiểm tra video sau bước thay mặt + trang phục (bấm Tiếp tục mới thay bối cảnh)', default: true },
    { key: 'merge', label: 'Ghép các đoạn lại + chèn âm thanh gốc', default: true },
    { key: 'removeWatermark', label: 'Tự động xoá logo Gemini khi ghép', default: true },
    { key: 'autoPublish', label: 'Tự động chuyển sang Đăng video khi hoàn thành', default: true },
  ],

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
          const att = job.attempts.find((a) => a.outputPath === job.outputPath);
          ctx.state.assetId = ctx.registerAsset('background', job.outputPath, `Bối cảnh – ${ctx.source.name}`, { flowTitle: att?.flowTitle || null }).id;
          ctx.state.assetFrom = job.outputPath;
        }
        return 'done';
      },
    },
    {
      id: 'motion',
      label: 'Thay mặt + trang phục',
      // Đoạn 1 chạy trước. Xong thì cắt 1 khung mặt đã render làm "mỏ neo", các đoạn sau nhận thêm ảnh này.
      async run(ctx) {
        const model = ctx.assetPath(ctx.inputs.model);
        if (!model) throw new Error('Ảnh model không còn trong thư viện');
        const spec = (clip, anchorPath) => {
          const ci = ctx.clipInputs[clip.id] || {};
          const front = ctx.assetPath(ci.outfit);
          const back = ctx.assetPath(ci.outfitBack);
          if (!front) throw new Error(`Đoạn "${clip.name}": ảnh trang phục không còn trong thư viện`);
          return {
            type: 'motion',
            videoPath: clip.path,
            videoLabel: clip.name,
            imagePaths: [model, anchorPath, front, back].filter(Boolean),
            template: fillMotion(ctx.prompt('motion'), { anchor: !!anchorPath, back: !!back }),
            sourceRange: { sourceId: clip.sourceId, start: clip.start, end: clip.end },
          };
        };
        const [first, ...rest] = ctx.clips;
        const useAnchor = ctx.run.options.identityAnchor !== false && rest.length > 0;
        const job1 = ctx.ensureJob(`motion:${first.id}`, spec(first, null));
        if (!useAnchor) return ctx.waitAll([job1, ...rest.map((c) => ctx.ensureJob(`motion:${c.id}`, spec(c, null)))]);

        if (job1.status === 'failed') throw ctx.jobError(job1);
        if (job1.status !== 'done') return 'waiting';
        if (!ctx.state.anchorPath || ctx.state.anchorFrom !== job1.outputPath) {
          // 0.5s: qua khung đầu thường còn mờ; nếu lúc này mặt đang quay đi thì người dùng Thử lại đoạn 1 / tắt khoá mặt
          ctx.state.anchorPath = await ctx.frameOf(job1.outputPath, 0.5, 'face-anchor');
          ctx.state.anchorFrom = job1.outputPath;
        }
        const others = rest.map((c) => ctx.ensureJob(`motion:${c.id}`, spec(c, ctx.state.anchorPath)));
        return ctx.waitAll([job1, ...others]);
      },
    },
    {
      id: 'review',
      label: 'Kiểm tra video',
      when: (run) => run.options.replaceBackground && run.options.reviewMotion !== false,
      async run(ctx) {
        return ctx.state.approved ? 'done' : 'paused';
      },
    },
    {
      id: 'replace',
      label: 'Thay bối cảnh vào video',
      when: (run) => run.options.replaceBackground,
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
          name: `${ctx.source.name.replace(/\.[^.]+$/, '')} – Thay trang phục`,
          removeWatermark: ctx.run.options.removeWatermark ?? true,
          watermarkMode: 'delogo',
        });
      },
    },
  ],
};
