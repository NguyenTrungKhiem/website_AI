// Cắt video + tắt tiếng bằng ffmpeg (cài sẵn qua npm: ffmpeg-static, ffprobe-static).
import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import ffprobe from 'ffprobe-static';

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(err.split('\n').slice(-6).join('\n') || `exit ${code}`)),
    );
  });
}

export async function probe(file) {
  const out = await run(ffprobe.path, [
    '-v', 'error',
    '-show_entries', 'stream=codec_type,width,height,avg_frame_rate,r_frame_rate:format=duration',
    '-of', 'json',
    file,
  ]);
  const j = JSON.parse(out);
  const v = j.streams?.find((s) => s.codec_type === 'video');
  return {
    duration: Number(j.format?.duration || 0),
    width: v?.width || 0,
    height: v?.height || 0,
    fps: v ? parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate) || 30 : 0,
    hasAudio: !!j.streams?.some((s) => s.codec_type === 'audio'),
  };
}

// "30000/1001" -> 29.97
function parseRate(r) {
  const [a, b] = String(r || '').split('/').map(Number);
  const fps = b ? a / b : a;
  return fps > 0 && fps < 1000 ? Math.round(fps * 1000) / 1000 : 0;
}

/**
 * Dải ảnh thu nhỏ (1 file jpg, các khung xếp ngang) để hiển thị trên timeline.
 * Trả về { count, tileW, tileH }.
 */
export async function filmstrip(src, dest, { duration, width, height }) {
  const count = Math.min(120, Math.max(10, Math.ceil(duration * 2)));
  const tileH = 72;
  const tileW = 2 * Math.round((tileH * (width || 9)) / (height || 16) / 2);
  await run(ffmpegPath, [
    '-y', '-i', src,
    '-vf', `fps=${count}/${duration},scale=${tileW}:${tileH},tile=${count}x1`,
    '-frames:v', '1', '-q:v', '5',
    dest,
  ]);
  return { count, tileW, tileH };
}

// Tách toàn bộ âm thanh ra file .m4a (AAC)
export function extractAudio(src, dest) {
  return run(ffmpegPath, ['-y', '-i', src, '-vn', '-c:a', 'aac', '-b:a', '192k', dest]);
}

/**
 * Nối nhiều video thành 1 và (tuỳ chọn) chèn âm thanh.
 * segments: [{ file, duration? }] — có duration thì ép đoạn đó đúng độ dài (cắt bớt hoặc giữ khung cuối)
 * audio: null | { file, ranges: [[start, end], ...] } (ghép từng khúc âm thanh) | { file, offset } (phát liên tục)
 */
export function mergeVideos({ segments, width, height, fps = 30, audio, dest }) {
  const args = ['-y'];
  for (const s of segments) args.push('-i', s.file);
  if (audio) args.push('-i', audio.file);

  const filters = [];
  segments.forEach((s, i) => {
    let f = `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p`;
    if (s.duration) f += `,tpad=stop_mode=clone:stop_duration=${s.duration},trim=duration=${s.duration}`;
    filters.push(`${f},setpts=PTS-STARTPTS[v${i}]`);
  });
  filters.push(`${segments.map((_, i) => `[v${i}]`).join('')}concat=n=${segments.length}:v=1:a=0[v]`);

  const maps = ['-map', '[v]'];
  if (audio) {
    const a = segments.length;
    if (audio.ranges) {
      audio.ranges.forEach(([s, e], i) => filters.push(`[${a}:a]atrim=start=${s}:end=${e},asetpts=PTS-STARTPTS[a${i}]`));
      filters.push(`${audio.ranges.map((_, i) => `[a${i}]`).join('')}concat=n=${audio.ranges.length}:v=0:a=1[a]`);
    } else {
      filters.push(`[${a}:a]atrim=start=${audio.offset || 0},asetpts=PTS-STARTPTS[a]`);
    }
    maps.push('-map', '[a]', '-c:a', 'aac', '-b:a', '192k', '-shortest');
  }

  args.push(
    '-filter_complex', filters.join(';'),
    ...maps,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-movflags', '+faststart',
    dest,
  );
  return run(ffmpegPath, args);
}

// Cắt đoạn [start, end) và bỏ âm thanh. Encode lại để cắt chính xác từng khung hình.
// Lùi mốc 1/4 khung để sai số làm tròn không làm rơi/thừa khung đầu & cuối.
export function cutClip(src, dest, start, end, { mute = true, fps = 30 } = {}) {
  const shift = 0.25 / fps;
  const ss = Math.max(0, start - shift);
  const args = [
    '-y',
    '-ss', ss.toFixed(6),
    '-i', src,
    '-t', (end - shift - ss).toFixed(6),
    ...(mute ? ['-an'] : ['-c:a', 'aac']),
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    dest,
  ];
  return run(ffmpegPath, args);
}

// Lấy 1 khung hình nguyên kích thước tại giây `at` (dùng làm ảnh tham chiếu bối cảnh)
export function frameAt(src, dest, at = 0.1) {
  return run(ffmpegPath, ['-y', '-ss', String(at), '-i', src, '-frames:v', '1', '-q:v', '2', dest]);
}

// Ảnh thu nhỏ cho file ảnh
export function imageThumb(src, dest) {
  return run(ffmpegPath, ['-y', '-i', src, '-vf', 'scale=320:-2', dest]);
}

export function thumbnail(src, dest, at = 0.5) {
  return run(ffmpegPath, ['-y', '-ss', String(at), '-i', src, '-frames:v', '1', '-vf', 'scale=320:-2', dest]);
}

// Chia thời lượng thành các đoạn đều nhau, đoạn cuối quá ngắn (<1s) thì gộp vào đoạn trước.
export function splitRanges(duration, segment) {
  const ranges = [];
  for (let s = 0; s < duration - 0.05; s += segment) {
    ranges.push([round(s), round(Math.min(s + segment, duration))]);
  }
  if (ranges.length > 1 && ranges.at(-1)[1] - ranges.at(-1)[0] < 1) {
    const last = ranges.pop();
    ranges.at(-1)[1] = last[1];
  }
  return ranges;
}

const round = (n) => Math.round(n * 100) / 100;
