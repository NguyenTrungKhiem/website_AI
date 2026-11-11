// Ghép nhiều video đã tạo thành 1 video + chèn âm thanh (dùng cho trang Ghép video và các quy trình tự động)
import fs from 'node:fs';
import path from 'node:path';
import { db, save, DIRS, newId } from './db.js';
import { probe, thumbnail, mergeVideos } from './ffmpeg.js';

export const mergeSettledHooks = [];

// Vị trí của job trong video gốc (job cũ chưa lưu sourceRange thì suy ra từ clip / job cha)
export function rangeOf(job) {
  if (!job) return null;
  if (job.sourceRange) return job.sourceRange;
  const clip = db.clips.find((c) => c.path === job.videoPath);
  if (clip) return { sourceId: clip.sourceId, start: clip.start, end: clip.end };
  return rangeOf(db.jobs.find((j) => j.id === job.parentJobId));
}

// Kiểm tra trước khi ghép, trả về danh sách đoạn + cấu hình âm thanh cho ffmpeg
export function planMerge({ jobIds, audioId, audioMode, offset, keepOriginalAudio = true }) {
  const jobs = jobIds.map((id) => db.jobs.find((j) => j.id === id));
  if (!jobs.length) throw new Error('Chọn ít nhất 1 video');
  if (jobs.some((j) => !j?.outputPath || !fs.existsSync(j.outputPath))) throw new Error('Có video chưa xong hoặc đã bị xoá');
  const audio = audioId ? db.audios.find((a) => a.id === audioId) : null;
  if (audioId && !audio) throw new Error('Không tìm thấy file âm thanh');

  if (audio && audioMode === 'match') {
    const ranges = jobs.map(rangeOf);
    const bad = jobs.filter((j, i) => ranges[i]?.sourceId !== audio.sourceId);
    if (!audio.sourceId || bad.length) {
      throw new Error(
        `Chế độ "khớp từng đoạn" cần mọi video được cắt từ cùng video gốc của âm thanh này` +
        (bad.length ? ` (không khớp: ${bad.map((j) => j.videoLabel).join(', ')})` : '') +
        '. Hãy dùng chế độ "phát liên tục".',
      );
    }
    return {
      segments: jobs.map((j, i) => ({ file: j.outputPath, duration: +(ranges[i].end - ranges[i].start).toFixed(3) })),
      audio: { file: audio.path, ranges: ranges.map((r) => [r.start, r.end]) },
      keepOriginalAudio: false,
    };
  }
  return {
    segments: jobs.map((j) => ({ file: j.outputPath })),
    audio: audio ? { file: audio.path, offset: Number(offset) || 0 } : null,
    keepOriginalAudio: audio ? false : (keepOriginalAudio !== false),
  };
}

export function createMerge({
  jobIds = [],
  audioId = null,
  audioMode = 'match',
  offset = 0,
  name,
  runId = null,
  removeWatermark = true,
  watermarkMode,
  watermarkText,
  watermarkImageId,
  keepOriginalAudio = true,
}) {
  const plan = planMerge({ jobIds, audioId, audioMode, offset, keepOriginalAudio });
  const id = newId();
  const effectiveMode = watermarkMode || (removeWatermark === false ? 'off' : (db.settings.watermarkMode || 'delogo'));
  const effectiveText = watermarkText !== undefined ? watermarkText : (db.settings.watermarkText || '');
  const effectiveImgId = watermarkImageId !== undefined ? watermarkImageId : (db.settings.watermarkImageId || '');

  const merge = {
    id,
    name: name?.trim() || `Video ghép ${new Date().toLocaleString('vi-VN')}`,
    jobIds,
    audioId,
    audioMode: audioId ? audioMode : null,
    offset,
    runId,
    watermarkMode: effectiveMode,
    watermarkText: effectiveText,
    watermarkImageId: effectiveImgId,
    watermarkRemoved: effectiveMode !== 'off',
    keepOriginalAudio: audioId ? false : (keepOriginalAudio !== false),
    inputPaths: plan.segments.map((s) => s.file), // để biết video nguồn có đổi sau khi ghép không
    status: 'running',
    error: null,
    outputPath: null,
    thumbPath: null,
    createdAt: Date.now(),
  };
  db.merges.unshift(merge);
  save();
  runMerge(merge, plan);
  return merge;
}

async function runMerge(merge, plan) {
  try {
    const first = await probe(plan.segments[0].file);
    let [w, h] = first.width && first.height ? [first.width, first.height] : db.settings.aspectRatio === '16:9' ? [1280, 720] : [720, 1280];
    // Các đoạn cùng tỉ lệ nhưng khác độ nét (đoạn tải 1080p, đoạn rơi về 720p): xuất theo đoạn nét nhất, không hạ xuống 720p
    for (const seg of plan.segments.slice(1)) {
      const m = await probe(seg.file).catch(() => null);
      if (m?.width > w && m.height && Math.abs(m.width / m.height - w / h) < 0.02) [w, h] = [m.width, m.height];
    }
    const dest = path.join(DIRS.merged, `${merge.id}.mp4`);

    let watermarkImagePath = null;
    if (merge.watermarkMode === 'brand' && merge.watermarkImageId) {
      const asset = db.assets.find((a) => a.id === merge.watermarkImageId);
      if (asset?.path && fs.existsSync(asset.path)) {
        watermarkImagePath = asset.path;
      }
    }

    // libx264 cần kích thước chẵn
    await mergeVideos({
      ...plan,
      width: w - (w % 2),
      height: h - (h % 2),
      dest,
      watermarkMode: merge.watermarkMode,
      watermarkText: merge.watermarkText,
      watermarkImagePath,
      watermarkFontSize: db.settings.watermarkFontSize || 20,
      keepOriginalAudio: merge.keepOriginalAudio !== false,
    });
    const thumbPath = path.join(DIRS.merged, `${merge.id}.jpg`);
    await thumbnail(dest, thumbPath).catch(() => {});
    const { duration } = await probe(dest);
    Object.assign(merge, { status: 'done', outputPath: dest, thumbPath, duration });
  } catch (e) {
    Object.assign(merge, { status: 'failed', error: e.message });
  }
  merge.finishedAt = Date.now();
  save();
  for (const h of mergeSettledHooks) Promise.resolve().then(() => h(merge)).catch((err) => console.error(err));
}
