// Quy trình "Nhạc Suno":
//   - Đầu vào: 1 ảnh nhân vật (@Image1), 1 ảnh bối cảnh sân khấu (@Image2), 1 file nhạc Suno (.mp3) + mốc bắt đầu (mặc định 10s).
//   - Bước 1 (analyze): FFmpeg cắt lát MP3 đúng 10s → Playwright mở ngầm gemini.google.com/app (chọn model Neon · Tư duy
//     Trung bình; chỉ bung cửa sổ Chrome khi lỗi) nghe từng giây → trả JSON timeline → dựng prompt Omni Flash.
//   - Bước 2 (review, tuỳ chọn): dừng kiểm tra/sửa prompt từng giây trước khi render.
//   - Bước 3 (video): gửi [@Image1, @Image2] + prompt lên Flow (Omni Flash, mặc định 16:9 · 10s, BẬT sound để khẩu hình khớp âm).
//   - Bước 4 (merge): FFmpeg TẮT tiếng AI của Omni Flash, CHÈN đúng đoạn 10s MP3 Suno gốc (+ syncOffsetMs) & xoá logo Gemini.
import fs from 'node:fs';
import path from 'node:path';
import { db, save } from '../db.js';
import { DEFAULT_GEMINI_WEB_URL, runGeminiWebPrompt } from '../geminiWeb.js';
import {
  analyzeSunoAudioWithWeb,
  buildSunoVideoPrompt,
  MIC_TYPES,
  SUNO_ASPECT_RATIOS,
  SUNO_AUDIO_ANALYSIS_PROMPT,
  SUNO_DURATIONS,
} from '../sunoAnalyzer.js';
import { FASHION_MODELS } from './video-thoi-trang.js';

let webRunner = runGeminiWebPrompt;
export function _setSunoWebRunnerForTest(fn) {
  webRunner = fn || runGeminiWebPrompt;
}

export default {
  id: 'nhac-suno',
  name: 'Nhạc Suno',
  icon: '🎵',
  noVideo: true,
  sunoMode: true,
  reviewNote: 'Đã phân tích xong lời & khẩu hình từng giây. Xem lại nếu cần rồi bấm Tiếp tục để gửi Omni Flash.',
  resumeLabel: '▶ Tiếp tục: tạo video hát nhép',
  description: 'Ảnh nhân vật + ảnh sân khấu + nhạc MP3 Suno → Playwright chạy ngầm Gemini Web (Neon · Trung bình) phân tích từng giây để Omni Flash 16:9 hát nhép khớp nhịp, rồi ghép nhạc MP3 gốc hoàn chỉnh.',
  sceneJobs: [
    { key: 'video:part1', label: 'Video hát nhép (Omni Flash)', note: 'Thử lại / chọn bản tốt nhất → tự động ghép lại với nhạc MP3 Suno gốc.' },
  ],
  inputs: [
    { key: 'model', kind: 'model', label: 'Ảnh nhân vật (@Image1)', required: true },
    { key: 'background', kind: 'background', label: 'Ảnh bối cảnh sân khấu (@Image2)', required: true },
  ],
  prompts: {
    analyze: {
      label: 'Prompt gửi Gemini Web (Neon · Tư duy trung bình) phân tích MP3 từng giây ({DURATION}, {LYRICS_HINT} điền tự động)',
      text: SUNO_AUDIO_ANALYSIS_PROMPT,
    },
  },
  options: [
    {
      key: 'flowModel',
      label: 'Mô hình Flow (khuyên dùng Omni 1.2 Flash)',
      options: FASHION_MODELS.map((m) => ({ value: m, label: m })),
      default: FASHION_MODELS[0],
    },
    {
      key: 'aspectRatio',
      label: 'Tỉ lệ khung hình',
      options: SUNO_ASPECT_RATIOS.map((r) => ({
        value: r,
        label: r === '16:9' ? '16:9 (Ngang – MV sân khấu)' : '9:16 (Dọc – TikTok / Reels)',
      })),
      default: '16:9',
    },
    {
      key: 'duration',
      label: 'Thời lượng đoạn test',
      options: SUNO_DURATIONS.map((d) => ({
        value: d,
        label: d === '10s' ? '10 giây (Test chuẩn)' : d === '15s' ? '15 giây (Omni 1.2 Flash)' : '8 giây',
      })),
      default: '10s',
    },
    {
      key: 'micType',
      label: 'Kiểu micro',
      options: MIC_TYPES,
      default: 'handheld',
    },
    {
      key: 'geminiWebModel',
      type: 'text',
      label: 'Model Gemini Web',
      default: 'Neon',
      placeholder: 'VD: Neon, Thinking, Pro',
    },
    {
      key: 'geminiThinkingLevel',
      type: 'text',
      label: 'Cấp độ tư duy Gemini',
      default: 'Trung bình',
      placeholder: 'VD: Trung bình, Medium',
    },
    {
      key: 'reviewScript',
      label: 'Dừng kiểm tra kịch bản từng giây trước khi gọi Flow (tắt = tự chạy 1 mạch)',
      default: false,
    },
    {
      key: 'removeWatermark',
      label: 'Tự động xoá logo Gemini khi ghép',
      default: true,
    },
    {
      key: 'autoPublish',
      label: 'Tự động chuyển sang Đăng video khi hoàn thành',
      default: false,
    },
  ],

  stages: [
    {
      id: 'analyze',
      label: 'Phân tích MP3 từng giây (Gemini Web ngầm)',
      async run(ctx) {
        const o = ctx.run.options || {};
        const durationSec = parseFloat(o.duration || '10s') || 10;
        const startSec = Math.max(0, Number(o.audioStartSec) || 0);
        const aspectRatio = o.aspectRatio === '9:16' ? '9:16' : '16:9';
        const micType = o.micType === 'stand' ? 'stand' : 'handheld';

        // Nếu người dùng đã bấm "Phân tích thử trước" hoặc sửa tay customPrompt từ giao diện → dùng luôn, không mở lại Gemini Web
        const presetPrompt = String(o.customPrompt || '').trim();
        if (presetPrompt) {
          ctx.state.videoPrompt = presetPrompt;
          if (Array.isArray(o.timeline)) ctx.state.timeline = o.timeline;
          if (o.songMeta) ctx.state.songMeta = o.songMeta;
          ctx.state.audioStartSec = startSec;
          ctx.state.durationSec = durationSec;
          ctx.state.note = 'Dùng kịch bản từng giây đã chuẩn bị sẵn trên giao diện';
          return 'done';
        }
        if (ctx.state.videoPrompt && ctx.state.audioStartSec === startSec && ctx.state.durationSec === durationSec) {
          return 'done';
        }

        const audio = db.audios.find((a) => a.id === o.audioId);
        if (!audio || !fs.existsSync(audio.path)) {
          throw new Error('File nhạc Suno (.mp3) không còn tồn tại trong thư viện.');
        }

        const analysis = await analyzeSunoAudioWithWeb({
          audioPath: audio.path,
          startSec,
          durationSec,
          lyricsHint: o.lyricsHint || '',
          micType,
          aspectRatio,
          modelName: o.geminiWebModel || 'Neon',
          thinkingLevel: o.geminiThinkingLevel || 'Trung bình',
          url: db.settings?.geminiWebUrl || DEFAULT_GEMINI_WEB_URL,
          analysisTemplate: ctx.prompt('analyze'),
          runWeb: webRunner,
          onProgress(msg) {
            ctx.state.note = msg;
            save();
          },
        });

        ctx.state.songMeta = analysis.songMeta;
        ctx.state.cameraStyle = analysis.cameraStyle;
        ctx.state.stageLighting = analysis.stageLighting;
        ctx.state.timeline = analysis.timeline;
        ctx.state.videoPrompt = analysis.videoPrompt;
        ctx.state.selectedModel = analysis.selectedModel;
        ctx.state.audioStartSec = startSec;
        ctx.state.durationSec = durationSec;
        ctx.state.note = `Đã phân tích ${analysis.timeline.length} mốc giây bằng ${analysis.selectedModel || 'Gemini Web'}`;
        return 'done';
      },
    },
    {
      id: 'review',
      label: 'Kiểm tra kịch bản từng giây',
      when: (run) => !!run.options.reviewScript,
      hideWhenSkipped: true,
      async run(ctx) {
        return ctx.state.approved ? 'done' : 'paused';
      },
    },
    {
      id: 'video',
      label: 'Tạo video hát nhép (Omni Flash)',
      async run(ctx) {
        const model = ctx.assetPath(ctx.inputs.model);
        const stageBg = ctx.assetPath(ctx.inputs.background);
        if (!model) throw new Error('Ảnh nhân vật không còn trong thư viện');
        if (!stageBg) throw new Error('Ảnh bối cảnh sân khấu không còn trong thư viện');

        const o = ctx.run.options || {};
        const stAnalyze = ctx.stages.analyze || {};
        const duration = o.duration || '10s';
        const durationSec = parseFloat(duration) || 10;
        const aspectRatio = o.aspectRatio === '9:16' ? '9:16' : '16:9';
        const micType = o.micType === 'stand' ? 'stand' : 'handheld';

        let template = String(o.customPrompt || '').trim() || stAnalyze.videoPrompt;
        if (!template && Array.isArray(stAnalyze.timeline)) {
          template = buildSunoVideoPrompt({
            timeline: stAnalyze.timeline,
            songMeta: stAnalyze.songMeta,
            cameraStyle: stAnalyze.cameraStyle,
            stageLighting: stAnalyze.stageLighting,
            aspectRatio,
            durationSec,
            micType,
          });
        }
        if (!template) throw new Error('Chưa có kịch bản prompt hát nhép từ bước phân tích.');

        const audio = db.audios.find((a) => a.id === o.audioId);
        const audioName = audio ? path.parse(audio.name).name.slice(0, 28) : 'Suno';
        const startSec = Math.max(0, Number(o.audioStartSec) || 0);

        const job = ctx.ensureJob('video:part1', {
          type: 'video',
          imagePaths: [model, stageBg],
          template,
          videoLabel: `🎵 ${audioName} (${startSec.toFixed(1)}s · ${duration} · ${aspectRatio})`,
          meta: {
            aspectRatio,
            flowVideoModel: o.flowModel || FASHION_MODELS[0],
            flowDuration: duration,
            flowResolution: '720p',
            flowVideoAudio: 'sound', // bắt buộc bật tiếng trên Flow để khẩu hình bám sát Voice từng giây
          },
        });
        if (job.status === 'failed') throw ctx.jobError(job);
        if (job.status !== 'done') return 'waiting';
        return 'done';
      },
    },
    {
      id: 'merge',
      label: 'Ghép nhạc gốc MP3 Suno & xoá logo',
      async run(ctx) {
        const j = ctx.job('video:part1');
        if (!j?.outputPath || !fs.existsSync(j.outputPath)) throw new Error('Thiếu video đầu ra từ Omni Flash');
        const o = ctx.run.options || {};
        const audio = db.audios.find((a) => a.id === o.audioId);
        if (!audio) throw new Error('File nhạc Suno (.mp3) không còn tồn tại trong thư viện');

        const startSec = Math.max(0, Number(o.audioStartSec) || 0);
        const delayMs = Math.round(Number(o.syncOffsetMs) || 0);
        const labelName = path.parse(audio.name).name.slice(0, 36);

        return ctx.ensureMerge({
          jobIds: [j.id],
          name: `🎵 ${labelName} (${startSec.toFixed(1)}s · ${o.duration || '10s'})`,
          audioId: audio.id,
          audioMode: 'continuous',
          offset: startSec,
          delayMs,
          removeWatermark: o.removeWatermark ?? true,
          keepOriginalAudio: false, // tắt 100% tiếng AI, thay bằng MP3 Suno gốc
        });
      },
    },
  ],

  // Khi người dùng bấm Thử lại hoặc chọn lần tạo khác của video:part1 -> tự động ghép lại với nhạc MP3 Suno
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
