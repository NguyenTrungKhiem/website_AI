// Quy trình "AI Dancing":
// 1. Cắt khung hình 0.1s -> tạo bối cảnh mới trên Flow (0 credit)
// 2. Ghép mặt Model vào video bằng Local Face-Swap (0 credit, giữ 100% vũ đạo, vóc dáng và độ nét gốc!)
// 3. Kiểm tra video sau khi ghép mặt (người dùng xem và duyệt)
// 4. Thay bối cảnh mới vào video trên Flow
// 5. Ghép lại + chèn âm thanh gốc + xoá logo Gemini.
import fs from 'node:fs';
import path from 'node:path';
import { db, DIRS } from '../db.js';
import { swapFaceVideo } from '../faceSwap.js';
import { createCompletedVideoJob } from '../queue.js';

const BACKGROUND_PROMPT = `Completely remove all people from the scene, leaving only the empty background.
Identify the key objects and architectural elements in the original reference and transform their colors to a new harmonious palette: very bright and airy, dominated by soft milky white with only a subtle hint of light beige / pale brown (cream tones), high-key exposure, no yellow, orange or dark, moody tones.
If the space appears too empty, add a few subtle, small decorative details consistent with the setting.
Strictly preserve the original camera angle, perspective, spatial depth and light direction to maintain the exact same environment, but render the lighting bright, soft and evenly exposed so a person placed in this scene later will be well lit.`;

const REPLACE_PROMPT = `Keep the person, their motion, the product and the camera movement exactly the same as the input video.
Replace only the background and environment with the scene shown in the reference image, with matching lighting, shadows and perspective so it looks naturally filmed there.`;

export default {
  id: 'dancing',
  name: 'AI Dancing',
  icon: '💃',
  description: 'Ghép mặt Model vào video nhảy (Local Face-Swap 98-100%, 0 credit, giữ nguyên 100% vũ đạo và độ nét gốc), thay bối cảnh mới trên Flow và ghép lại thành video hoàn chỉnh.',
  inputs: [
    { key: 'model', kind: 'model', label: 'Ảnh model', required: true },
  ],
  prompts: {
    background: { label: '1. Tạo bối cảnh mới (từ khung hình 0.1s của video gốc)', text: BACKGROUND_PROMPT },
    replace: { label: '2. Thay bối cảnh mới vào video đã tạo', text: REPLACE_PROMPT },
  },
  options: [
    { key: 'replaceBackground', label: 'Tạo bối cảnh mới và thay vào video', default: true },
    { key: 'reviewMotion', label: 'Dừng lại để kiểm tra video sau khi ghép mặt (bấm Tiếp tục mới thay bối cảnh)', default: true },
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
          const att = job.attempts.find((a) => a.outputPath === job.outputPath);
          ctx.state.assetId = ctx.registerAsset('background', job.outputPath, `Bối cảnh – ${ctx.source.name}`, { flowTitle: att?.flowTitle || null }).id;
          ctx.state.assetFrom = job.outputPath;
        }
        return 'done';
      },
    },
    {
      id: 'motion',
      label: 'Ghép mặt Model vào video (Local Face-Swap 98-100%)',
      async run(ctx) {
        const model = ctx.asset(ctx.inputs.model);
        if (!model) throw new Error('Ảnh model không còn trong thư viện');

        const jobsMap = (ctx.run.stages._jobs ||= {});

        for (const clip of ctx.clips) {
          const jobKey = `motion:${clip.id}`;
          let job = ctx.job(jobKey);

          // File video đầu ra của clip này
          const outPath = path.join(DIRS.outputs, `motion-${ctx.run.id}-${clip.id}.mp4`);

          // Nếu chưa có file kết quả, thực hiện Local Face-Swap trực tiếp trên video clip gốc
          if (!fs.existsSync(outPath)) {
            console.log(`[workflow:dancing] Đang ghép mặt model vào video clip "${clip.name}" bằng Local Face-Swap...`);
            await swapFaceVideo(model.path, clip.path, outPath);
          }

          // Tạo job hoàn thành hiển thị trên giao diện Studio (JobCard)
          if (!job) {
            job = await createCompletedVideoJob({
              runId: ctx.run.id,
              stage: 'motion',
              sourceRange: { sourceId: clip.sourceId, start: clip.start, end: clip.end },
              videoLabel: clip.name,
              outputPath: outPath,
              note: 'Ghép mặt Model (Local Face-Swap 98-100%, giữ nguyên vũ đạo gốc)',
            });
            jobsMap[jobKey] = job.id;
          }
        }

        return 'done';
      },
    },
    {
      id: 'review',
      label: 'Kiểm tra video',
      when: (run) => run.options.replaceBackground && run.options.reviewMotion !== false,
      // Dừng lại cho người dùng xem video đã ghép mặt; bấm "Tiếp tục" mới sang bước thay bối cảnh.
      async run(ctx) {
        return ctx.state.approved ? 'done' : 'paused';
      },
    },
    {
      id: 'replace',
      label: 'Thay bối cảnh vào video',
      when: (run) => run.options.replaceBackground,
      // Đầu vào mỗi đoạn = video đã ghép mặt của đoạn đó (giữ trọn vẹn vũ đạo gốc)
      // Flow chỉ thay bối cảnh phía sau thành bối cảnh mới
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
