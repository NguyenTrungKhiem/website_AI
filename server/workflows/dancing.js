// Quy trình "AI Dancing": khung hình 0.1s -> bối cảnh mới -> KHOÁ NHẬN DIỆN (bảng mặt 360° của model
// -> keyframe cho từng đoạn, người dùng duyệt) -> thay người + sản phẩm cho từng đoạn (animate keyframe theo video gốc)
// -> thay bối cảnh vào video đã tạo -> ghép lại + chèn âm thanh gốc.
// Quy trình khác (vd. Thay quần áo) viết thành file riêng cùng cấu trúc, không đụng vào file này.
import fs from 'node:fs';
import { db } from '../db.js';

const BACKGROUND_PROMPT = `Completely remove all people from the scene, leaving only the empty background.
Identify the key objects and architectural elements in the original reference and transform their colors to a new harmonious palette: very bright and airy, dominated by soft milky white with only a subtle hint of light beige / pale brown (cream tones), high-key exposure, no yellow, orange or dark, moody tones.
If the space appears too empty, add a few subtle, small decorative details consistent with the setting.
Strictly preserve the original camera angle, perspective, spatial depth and light direction to maintain the exact same environment, but render the lighting bright, soft and evenly exposed so a person placed in this scene later will be well lit.`;

// Khoá nhận diện, bước 1 – bảng mặt 360° (identity sheet) của ảnh model: ảnh 16:9 gồm 24 góc mặt (0° -> 345°, mỗi 15°)
// của cùng một người. Tạo 1 lần cho mỗi ảnh model (Nano Banana, 0 credit), lưu làm ảnh nháp gắn với ảnh model,
// dùng lại được trên Flow (flowTitle) cho mọi keyframe về sau.
const IDENTITY_PROMPT = `Create a photorealistic facial identity reference sheet of the exact same person shown in the reference photo, as one single 16:9 image.

LAYOUT: a clean grid of 24 head-and-shoulders views of this person, 6 columns x 4 rows, each view in its own cell on a plain, neutral light-gray background. The head rotates 15 degrees from one cell to the next, in reading order: 0° (front view), 15°, 30°, 45°, 60°, 75°, 90° (full right profile), 105°, 120°, 135°, 150°, 165°, 180° (back of the head), 195°, 210°, 225°, 240°, 255°, 270° (full left profile), 285°, 300°, 315°, 330°, 345°. Write the angle of each cell in small plain text in its corner. Same head size, camera height and distance in every cell.

IDENTITY: it must be unmistakably the same person in every cell: the same face shape, jawline, chin, cheekbones, forehead, eye shape, eye size and spacing, eyebrows, nose shape and size, lips, ears, skin tone, skin texture, moles, freckles and marks, the same hairstyle, hair length and hair color, the same age and build as the reference photo. Neutral expression, mouth closed, eyes open, looking straight ahead relative to the head. No glasses, hats or accessories unless they are in the reference photo. Soft, even studio lighting with no hard shadows, sharp focus, natural color.

DO NOT beautify, retouch, slim the face, enlarge the eyes, sharpen the jaw into a V-line, lengthen or narrow the chin, shrink the nose, smooth or whiten the skin, add makeup that is not in the reference, or make the person look younger, thinner or more symmetrical. Do not add any text other than the angle labels, and no logos or watermarks.`;

// Khoá nhận diện, bước 2 – keyframe 9:16 cho từng đoạn. Thứ tự nguyên liệu: ảnh 1 = bảng mặt 360° (identity),
// ảnh 2 = khung hình đầu của đoạn (scene / pose / outfit), ảnh 3 = sản phẩm (nếu có). Người dùng duyệt keyframe
// (0 credit) rồi mới cho video model animate theo video gốc (tốn credit).
const KEYFRAME_PROMPT = `Create one photorealistic 9:16 keyframe image. Inputs, in order: image 1 = a facial identity sheet of the target person (a grid of the same face seen from many angles), image 2 = one frame of the source video (the scene, the camera, the dancer's pose and outfit), and optionally image 3 = the product (the garment to wear).

IDENTITY, from image 1: look at the head angle of the dancer in image 2 and pick the cell of image 1 whose angle is closest; use that view as the main face reference and the neighbouring cells to keep the 3D shape of the head consistent. Rebuild the dancer's face, head and hair as exactly this person: the same face shape, jawline, chin, cheekbones, forehead, eye shape, eye size and spacing, eyebrows, nose, lips, ears, skin tone and texture, hairstyle, hair length and hair color.

SCENE, from image 2: keep everything else exactly as in image 2: the same body pose, limb and hand positions, body proportions and size in the frame, the same camera angle, framing, height and distance, the same background, lighting direction, shadows and color temperature, the same head direction and gaze. If image 3 is provided, dress the person in that garment exactly (same color, pattern, print, fabric, sheen, neckline, straps, sleeves, length and fit), fitted naturally to the pose; otherwise keep the outfit from image 2.

DO NOT: do not enlarge the eyes, do not slim the face or create a V-line jaw, do not lengthen, narrow or sharpen the chin, do not shrink the nose, do not smooth, brighten or whiten the skin, do not beautify, retouch, slim the body or make the person younger or more symmetrical, do not change the pose, body shape, camera, framing or background, do not add text, logos, watermarks, extra people, accessories or props, and do not copy the grid, cells, labels or layout of image 1 into the output.

Output: a single clean full-frame photo, same framing as image 2, that looks like the person from image 1 was photographed in that exact pose, place and light.`;

// Bước thay nhân vật khi đã khoá nhận diện. Thứ tự file trong ô prompt Flow: ảnh 1 = keyframe (người đã đúng mặt,
// outfit và bối cảnh), ảnh 2 = sản phẩm (nếu có), rồi video gốc. Keyframe quyết định "trông như thế nào",
// video gốc chỉ quyết định "chuyển động ra sao"; giữ nguyên các ràng buộc chuyển động của prompt cũ.
const MOTION_KEYFRAME_PROMPT = `Video-to-video animation. Inputs, in order: image 1 = the keyframe (the exact person, face, hair, outfit and background to show), image 2 = the outfit (product) for extra detail if provided, then the source video (the motion to follow).

Animate image 1 so that it performs exactly the motion of the source video, frame by frame, for its full duration. Image 1 defines how everything looks; the source video defines only how everything moves. The first frame of the output must look like image 1.

KEEP IDENTICAL TO IMAGE 1 IN EVERY FRAME:
- The face and identity: face shape, jawline, chin, eyes, eyebrows, nose, lips, skin tone and the hairstyle. Keep this same face consistent in every frame, including when she turns her head, moves fast or is partly in profile. The expression may follow the source naturally, but the identity must not drift, morph or flicker.
- The outfit: every color, pattern, print, fabric, sheen, neckline, strap, sleeve, length and fit detail (matching image 2 if provided). It moves, folds and stretches realistically with every movement.
- The body proportions and silhouette, the background, room, lighting direction and color temperature. Do not change or clean up the background.

FOLLOW EXACTLY FROM THE SOURCE VIDEO:
- The same dance: every movement, pose, gesture, step, turn and hair flip, with identical timing, speed and rhythm. Each output frame must match the source frame at the same moment. Do not add, skip, smooth out, slow down or speed up any movement.
- The same body position and size in the frame, the same distance to the camera, and the same camera framing, angle, zoom and camera movement. If the camera is static in the source, keep it static.

DO NOT:
- Do not invent new moves, change the choreography, or change the camera.
- Do not add text, logos, watermarks, captions, extra people, accessories or props that are not in the inputs.
- Do not morph, flicker or drift the face, body or clothes between frames. Hands, fingers, arms and legs must stay natural and anatomically correct.
- Ignore the audio of the source video. No lip-sync or speech.

Output: a photorealistic video with the same duration, aspect ratio and framing as the source video, looking like the person in image 1 performed this exact dance.`;

// Thay nhân vật trực tiếp (khi tắt khoá nhận diện). Thứ tự file trong ô prompt Flow: ảnh 1 = model, ảnh 2 = sản phẩm, rồi video gốc.
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
  description: 'Thay người nhảy bằng model của bạn (khoá nhận diện bằng bảng mặt 360° + keyframe), đưa sản phẩm vào, đổi bối cảnh mới và ghép lại thành video hoàn chỉnh.',
  inputs: [
    { key: 'model', kind: 'model', label: 'Ảnh model', required: true },
    { key: 'product', kind: 'product', label: 'Ảnh sản phẩm', required: false },
  ],
  prompts: {
    background: { label: '1. Tạo bối cảnh mới (từ khung hình 0.1s của video gốc)', text: BACKGROUND_PROMPT },
    identity: { label: '2. Bảng mặt 360° của ảnh model (1 lần cho mỗi ảnh model, 0 credit)', text: IDENTITY_PROMPT },
    keyframe: { label: '3. Keyframe từng đoạn: bảng mặt 360° + khung hình đoạn + sản phẩm (0 credit, bạn duyệt trước)', text: KEYFRAME_PROMPT },
    motionKeyframe: { label: '4. Thay nhân vật: animate keyframe theo video gốc (từng đoạn, tốn credit)', text: MOTION_KEYFRAME_PROMPT },
    motion: { label: '4b. Thay nhân vật trực tiếp từ ảnh model (chỉ dùng khi tắt "Khoá nhận diện")', text: MOTION_PROMPT },
    replace: { label: '5. Thay bối cảnh mới vào video đã tạo', text: REPLACE_PROMPT },
  },
  options: [
    { key: 'identityLock', label: 'Khoá nhận diện: tạo bảng mặt 360° + keyframe cho từng đoạn trước khi thay nhân vật (0 credit, mặt giống model hơn)', default: true },
    { key: 'reviewKeyframe', label: 'Dừng lại để duyệt keyframe trước khi thay nhân vật (bước thay nhân vật mới tốn credit)', default: true },
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
      id: 'identity',
      label: 'Bảng mặt 360°',
      when: (run) => run.options.identityLock,
      // Dùng lại bảng mặt mới nhất đã có của ảnh model (tạo từ popup ảnh model hoặc lần chạy trước);
      // chưa có thì tạo bằng Nano Banana (0 credit). Kết quả = ảnh nháp kind "model" gắn fromAssetId = ảnh model.
      async run(ctx) {
        const model = ctx.asset(ctx.inputs.model);
        if (!model) throw new Error('Ảnh model không còn trong thư viện');

        // 1. Bảng mặt 360° đã gắn với lần chạy này và file còn trên đĩa
        if (ctx.state.assetId) {
          const existing = ctx.asset(ctx.state.assetId);
          if (existing && existing.path && fs.existsSync(existing.path)) {
            return 'done';
          }
          ctx.state.assetId = null;
        }

        // 2. Kiểm tra trong thư viện local xem đã có bảng mặt 360° của model này chưa (nếu chưa bị đánh dấu bắt buộc tạo lại trên Flow)
        if (!ctx.state.forceRegenerate) {
          const localSheet = db.assets.find(
            (a) => a.kind === 'model' && a.identitySheet && a.fromAssetId === model.id && a.path && fs.existsSync(a.path)
          );
          if (localSheet) {
            ctx.state.assetId = localSheet.id;
            return 'done';
          }
        }

        // 3. Tạo bảng mặt 360° trực tiếp trên Flow bằng Nano Banana (0 credit, sinh ra trực tiếp trong dự án Flow)
        const job = ctx.ensureJob('identity:sheet', {
          type: 'image',
          imagePaths: [model.path],
          template: ctx.prompt('identity'),
          aspectRatio: '16:9',
          videoLabel: `Bảng mặt 360° – ${model.name}`,
          meta: { identityOf: model.id, kind: 'model' },
        });
        if (job.status === 'failed') throw ctx.jobError(job);
        if (job.status !== 'done') return 'waiting';
        ctx.state.assetId = ctx.registerIdentitySheet(job).id;
        ctx.state.forceRegenerate = false;
        return 'done';
      },
    },
    {
      id: 'keyframe',
      label: 'Keyframe từng đoạn',
      when: (run) => run.options.identityLock,
      // Khung hình đầu (0.1s) của từng đoạn + bảng mặt 360° (+ sản phẩm) -> ảnh 9:16 người đã đúng mặt / outfit / bối cảnh.
      // Mỗi keyframe được lưu thành ảnh nháp (có flowTitle) để bước thay nhân vật dùng lại ngay trên Flow.
      // Xong thì dừng (paused) cho người dùng duyệt (Thử lại / Sửa prompt / chọn lần tạo) vì bước sau tốn credit.
      // Keyframe đổi sau khi đã duyệt -> runner.syncRun làm lại motion của đoạn đó và dừng duyệt lại.
      async run(ctx) {
        let sheet = ctx.asset(ctx.stages.identity?.assetId);
        // Kiểm tra tính toàn vẹn: nếu bảng mặt 360° chưa có hoặc bị mất, tự động quay lại bước identity để tạo lại trên Flow!
        if (!sheet || !sheet.path || !fs.existsSync(sheet.path)) {
          if (ctx.stages.identity) {
            delete ctx.stages.identity.assetId;
            ctx.stages.identity.status = 'pending';
          }
          if (ctx.stages._jobs?.['identity:sheet']) delete ctx.stages._jobs['identity:sheet'];
          ctx.run.stage = 'identity';
          return 'waiting';
        }
        const product = ctx.asset(ctx.inputs.product);
        const frames = (ctx.state.frames ||= {});
        for (const clip of ctx.clips) if (!frames[clip.id]) frames[clip.id] = await ctx.clipFrame(clip, 0.1);
        const jobs = ctx.clips.map((clip) =>
          ctx.ensureJob(`keyframe:${clip.id}`, {
            type: 'image',
            imagePaths: [sheet.path, frames[clip.id], product?.path].filter(Boolean),
            template: ctx.prompt('keyframe'),
            aspectRatio: '9:16',
            videoLabel: `Keyframe – ${clip.name}`,
            sourceRange: { sourceId: clip.sourceId, start: clip.start, end: clip.end },
          }),
        );
        // Tự phục hồi: nếu bất kỳ job keyframe nào báo lỗi do thiếu nguyên liệu trên Flow (chưa có / không nạp được):
        // Kiểm tra TRƯỚC KHI gọi ctx.waitAll để tránh ctx.waitAll quăng ngoại lệ làm dừng cả workflow!
        const missingFlowAsset = jobs.find((j) => j.status === 'failed' && /Flow|nguyên liệu|không thấy|chưa có|quá 3 phút|quá 45s/i.test(j.error || ''));
        if (missingFlowAsset) {
          console.log(`[workflow:dancing] Keyframe job ${missingFlowAsset.id} thiếu nguyên liệu Flow (${missingFlowAsset.error}). Tự động chuyển luồng sang bước identity!`);
          if (ctx.stages.identity) {
            delete ctx.stages.identity.assetId;
            ctx.stages.identity.status = 'pending';
            ctx.stages.identity.forceRegenerate = true;
          }
          if (ctx.stages._jobs) {
            delete ctx.stages._jobs['identity:sheet'];
          }
          ctx.state.status = 'pending';
          ctx.run.stage = 'identity';
          for (const j of jobs) {
            j.status = 'queued';
            j.error = null;
          }
          return 'waiting';
        }
        const r = ctx.waitAll(jobs);
        if (r !== 'done') return r;
        const assets = (ctx.state.assets ||= {});
        for (const clip of ctx.clips) {
          const job = ctx.job(`keyframe:${clip.id}`);
          if (assets[clip.id]) continue;
          const att = job.attempts.find((a) => a.outputPath === job.outputPath);
          const a = ctx.registerAsset('keyframe', job.outputPath, `Keyframe – ${clip.name}`, { flowTitle: att?.flowTitle || null, staging: true, fromJobId: job.id });
          assets[clip.id] = { id: a.id, from: job.outputPath };
        }
        if (ctx.run.options.reviewKeyframe === false) return 'done';
        return ctx.state.approved ? 'done' : 'paused';
      },
    },
    {
      id: 'motion',
      label: 'Thay nhân vật + sản phẩm',
      // Khoá nhận diện: nguyên liệu = keyframe (ảnh người đã đúng mặt + outfit + bối cảnh) -> ảnh sản phẩm -> video gốc,
      // prompt "animate keyframe theo video gốc". Tắt khoá: ảnh model -> sản phẩm -> video gốc như cũ.
      async run(ctx) {
        const lock = ctx.run.options.identityLock;
        const jobs = ctx.clips.map((clip) => {
          const kf = lock ? ctx.stages.keyframe?.assets?.[clip.id] : null;
          if (lock && !kf) throw new Error(`Chưa có keyframe cho "${clip.name}" — chạy lại bước Keyframe`);
          return ctx.ensureJob(`motion:${clip.id}`, {
            type: 'motion',
            videoPath: clip.path,
            videoLabel: clip.name,
            assets: { model: lock ? kf.id : ctx.inputs.model || null, product: ctx.inputs.product || null },
            template: ctx.prompt(lock ? 'motionKeyframe' : 'motion'),
            sourceRange: { sourceId: clip.sourceId, start: clip.start, end: clip.end },
            meta: lock ? { keyframeFrom: kf.from } : null,
          });
        });
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
