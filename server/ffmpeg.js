// Cắt video + tắt tiếng bằng ffmpeg (cài sẵn qua npm: ffmpeg-static, ffprobe-static).
import fs from 'node:fs';
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
 * Cắt chính xác một lát âm thanh [startSec, startSec + durationSec) thành MP3 nhỏ gọn để gửi AI phân tích.
 * Đặt -i trước -ss để cắt chính xác từng mili-giây theo đồng hồ chuẩn 0.0 -> durationSec.
 */
export function cutAudioSlice(src, dest, startSec = 0, durationSec = 10) {
  const ss = Math.max(0, Number(startSec) || 0);
  const dur = Math.max(1, Number(durationSec) || 10);
  return run(ffmpegPath, [
    '-y', '-i', src,
    '-ss', String(ss), '-t', String(dur),
    '-vn', '-c:a', 'libmp3lame', '-b:a', '128k', '-ac', '1', '-ar', '24000',
    dest,
  ]);
}

/**
 * Tạo mảng tham số ffmpeg để cắt và/hoặc ghép nhiều đoạn âm thanh từ một hoặc nhiều file thành 1 file MP3.
 * segments: [{ file, start, end }]
 */
export function buildConcatAudioArgs(segments, dest, { fadeMs = 0 } = {}) {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error('Cần ít nhất 1 đoạn âm thanh để cắt hoặc ghép');
  }
  const fadeSec = Math.max(0, Math.min(2, (Number(fadeMs) || 0) / 1000));
  const args = ['-y'];
  const filters = [];

  segments.forEach((seg, i) => {
    const file = seg?.file;
    const s = Number(seg?.start);
    const e = Number(seg?.end);
    if (!file || typeof file !== 'string') {
      throw new Error(`Đoạn #${i + 1} thiếu đường dẫn file âm thanh`);
    }
    if (!Number.isFinite(s) || !Number.isFinite(e) || s < 0 || e <= s + 0.05) {
      throw new Error(`Khoảng thời gian đoạn #${i + 1} không hợp lệ (${seg?.start}–${seg?.end}s)`);
    }
    args.push('-i', file);
    const dur = e - s;
    let chain = `[${i}:a]atrim=start=${s.toFixed(4)}:end=${e.toFixed(4)},asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo`;
    if (fadeSec > 0) {
      const segFade = Math.min(fadeSec, dur / 3);
      const fadeOutStart = Math.max(0, dur - segFade);
      chain += `,afade=t=in:st=0:d=${segFade.toFixed(4)},afade=t=out:st=${fadeOutStart.toFixed(4)}:d=${segFade.toFixed(4)}`;
    }
    filters.push(`${chain}[a${i}]`);
  });

  if (segments.length === 1) {
    args.push('-filter_complex', filters.join(';'), '-map', '[a0]');
  } else {
    const pads = segments.map((_, i) => `[a${i}]`).join('');
    filters.push(`${pads}concat=n=${segments.length}:v=0:a=1[aout]`);
    args.push('-filter_complex', filters.join(';'), '-map', '[aout]');
  }

  args.push('-vn', '-c:a', 'libmp3lame', '-b:a', '192k', '-ar', '44100', '-ac', '2', dest);
  return args;
}

/** Cắt và/hoặc ghép danh sách đoạn âm thanh thành 1 file MP3 mới. */
export function concatAudioSegments(segments, dest, opts = {}) {
  return run(ffmpegPath, buildConcatAudioArgs(segments, dest, opts));
}

/**
 * Tính toạ độ logo Gemini/Flow (ngôi sao 4 cánh) ở góc dưới bên phải
 * Mẫu gốc 720x1280: x=572, y=1132, w=56, h=56
 */
export function getWatermarkBox(width, height) {
  const isPortrait = height >= width;
  let scaleX, scaleY, boxW, boxH, marginR, marginB;

  if (isPortrait) {
    scaleX = width / 720;
    scaleY = height / 1280;
    boxW = Math.max(32, Math.round(56 * Math.min(scaleX, scaleY)));
    boxH = Math.max(32, Math.round(56 * Math.min(scaleX, scaleY)));
    marginR = Math.round(92 * scaleX);
    marginB = Math.round(92 * scaleY);
  } else {
    scaleX = width / 1280;
    scaleY = height / 720;
    boxW = Math.max(32, Math.round(56 * Math.min(scaleX, scaleY)));
    boxH = Math.max(32, Math.round(56 * Math.min(scaleX, scaleY)));
    marginR = Math.round(64 * scaleX);
    marginB = Math.round(64 * scaleY);
  }

  const x = Math.max(0, Math.min(width - boxW - 2, width - marginR - boxW));
  const y = Math.max(0, Math.min(height - boxH - 2, height - marginB - boxH));
  return { x, y, w: boxW, h: boxH };
}

/**
 * Nối nhiều video thành 1 và (tuỳ chọn) chèn âm thanh, tự động xoá logo Gemini hoặc đè logo riêng.
 * segments: [{ file, duration? }] — có duration thì ép đoạn đó đúng độ dài (cắt bớt hoặc giữ khung cuối)
 * audio: null | { file, ranges: [[start, end], ...] } (ghép từng khúc âm thanh) | { file, offset } (phát liên tục)
 */
export async function mergeVideos({
  segments,
  width,
  height,
  fps = 30,
  audio,
  dest,
  removeWatermark = true,
  watermarkMode = 'delogo',
  watermarkText = '',
  watermarkImagePath = null,
  watermarkFontSize = 20,
  keepOriginalAudio = true,
}) {
  const mode = removeWatermark === false ? 'off' : (watermarkMode || 'delogo');
  const args = ['-y'];
  for (const s of segments) args.push('-i', s.file);
  if (audio) args.push('-i', audio.file);

  const hasBrandImage = mode === 'brand' && watermarkImagePath && fs.existsSync(watermarkImagePath);
  let brandImageInputIndex = -1;
  if (hasBrandImage) {
    brandImageInputIndex = segments.length + (audio ? 1 : 0);
    args.push('-i', watermarkImagePath);
  }

  const filters = [];
  segments.forEach((s, i) => {
    let f = `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p`;
    if (s.duration) f += `,tpad=stop_mode=clone:stop_duration=${s.duration},trim=duration=${s.duration}`;
    filters.push(`${f},setpts=PTS-STARTPTS[v${i}]`);
  });

  // Xác định có giữ và nối âm thanh gốc của các đoạn video hay không
  let preserveAudio = false;
  let segProbes = [];
  if (!audio && keepOriginalAudio !== false) {
    segProbes = await Promise.all(segments.map((s) => probe(s.file).catch(() => ({ hasAudio: false }))));
    preserveAudio = segProbes.some((p) => p.hasAudio);
  }

  const needsFilter = mode !== 'off';
  const concatTag = needsFilter ? 'vconcat' : 'v';

  if (preserveAudio) {
    segments.forEach((s, i) => {
      if (segProbes[i]?.hasAudio) {
        filters.push(`[${i}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,asetpts=PTS-STARTPTS[a${i}]`);
      } else {
        const d = s.duration || segProbes[i]?.duration || 10;
        filters.push(`anullsrc=channel_layout=stereo:sample_rate=44100:d=${d}[a${i}]`);
      }
    });
    filters.push(`${segments.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${segments.length}:v=1:a=1[${concatTag}][aconcat]`);
  } else {
    filters.push(`${segments.map((_, i) => `[v${i}]`).join('')}concat=n=${segments.length}:v=1:a=0[${concatTag}]`);
  }

  if (mode === 'brand') {
    const box = getWatermarkBox(width, height);
    const cx = box.x + Math.round(box.w / 2);
    const cy = box.y + Math.round(box.h / 2);

    if (hasBrandImage) {
      const imgW = Math.max(48, Math.round(box.w * 1.3));
      filters.push(`[${brandImageInputIndex}:v]scale=${imgW}:-1[brand_logo]`);
      filters.push(`[${concatTag}][brand_logo]overlay=x=${cx}-(overlay_w/2):y=${cy}-(overlay_h/2)[v]`);
    } else if (watermarkText?.trim()) {
      const cleanText = watermarkText.trim().replace(/'/g, "\\'").replace(/:/g, "\\:");
      const fsize = Number(watermarkFontSize) || 20;
      filters.push(
        `[${concatTag}]drawtext=text='${cleanText}':x=${cx}-(text_w/2):y=${cy}-(text_h/2):fontsize=${fsize}:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=8[v]`
      );
    } else {
      filters.push(`[${concatTag}]delogo=x=${box.x}:y=${box.y}:w=${box.w}:h=${box.h}:show=0[v]`);
    }
  } else if (mode === 'delogo') {
    const box = getWatermarkBox(width, height);
    filters.push(`[${concatTag}]delogo=x=${box.x}:y=${box.y}:w=${box.w}:h=${box.h}:show=0[v]`);
  }

  const maps = ['-map', '[v]'];
  if (audio) {
    const a = segments.length;
    if (audio.ranges) {
      audio.ranges.forEach(([s, e], i) => filters.push(`[${a}:a]atrim=start=${s}:end=${e},asetpts=PTS-STARTPTS[a${i}]`));
      filters.push(`${audio.ranges.map((_, i) => `[a${i}]`).join('')}concat=n=${audio.ranges.length}:v=0:a=1[a]`);
    } else {
      const delayMs = Math.round(Number(audio.delayMs) || 0);
      const baseOffset = Math.max(0, Number(audio.offset) || 0);
      if (delayMs > 0) {
        filters.push(`[${a}:a]atrim=start=${baseOffset},asetpts=PTS-STARTPTS,adelay=${delayMs}:all=1[a]`);
      } else if (delayMs < 0) {
        const trimStart = +(baseOffset + Math.abs(delayMs) / 1000).toFixed(3);
        filters.push(`[${a}:a]atrim=start=${trimStart},asetpts=PTS-STARTPTS[a]`);
      } else {
        filters.push(`[${a}:a]atrim=start=${baseOffset},asetpts=PTS-STARTPTS[a]`);
      }
    }
    maps.push('-map', '[a]', '-c:a', 'aac', '-b:a', '192k', '-shortest');
  } else if (preserveAudio) {
    maps.push('-map', '[aconcat]', '-c:a', 'aac', '-b:a', '192k');
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

/**
 * Xoá logo Gemini hoặc đè logo riêng cho 1 video đơn lẻ đã có sẵn
 */
export async function removeWatermarkVideo(src, dest, { width, height, watermarkMode = 'delogo', watermarkText = '', watermarkImagePath = null, watermarkFontSize = 20 } = {}) {
  let w = width;
  let h = height;
  if (!w || !h) {
    const meta = await probe(src);
    w = meta.width;
    h = meta.height;
  }
  const box = getWatermarkBox(w, h);
  const cx = box.x + Math.round(box.w / 2);
  const cy = box.y + Math.round(box.h / 2);

  const args = ['-y', '-i', src];

  if (watermarkMode === 'brand') {
    if (watermarkImagePath && fs.existsSync(watermarkImagePath)) {
      args.push('-i', watermarkImagePath);
      const imgW = Math.max(48, Math.round(box.w * 1.3));
      args.push('-filter_complex', `[1:v]scale=${imgW}:-1[brand_logo];[0:v][brand_logo]overlay=x=${cx}-(overlay_w/2):y=${cy}-(overlay_h/2)[v]`, '-map', '[v]', '-map', '0:a?');
    } else if (watermarkText?.trim()) {
      const cleanText = watermarkText.trim().replace(/'/g, "\\'").replace(/:/g, "\\:");
      const fsize = Number(watermarkFontSize) || 20;
      args.push('-vf', `drawtext=text='${cleanText}':x=${cx}-(text_w/2):y=${cy}-(text_h/2):fontsize=${fsize}:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=8`, '-c:a', 'copy');
    } else {
      args.push('-vf', `delogo=x=${box.x}:y=${box.y}:w=${box.w}:h=${box.h}:show=0`, '-c:a', 'copy');
    }
  } else {
    args.push('-vf', `delogo=x=${box.x}:y=${box.y}:w=${box.w}:h=${box.h}:show=0`, '-c:a', 'copy');
  }

  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-movflags', '+faststart', dest);
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

// Lấy 1 khung hình nguyên kích thước tại giây `at` (dùng làm ảnh tham chiếu bối cảnh / khung hình)
export function frameAt(src, dest, at = 0.1) {
  const isPng = dest.toLowerCase().endsWith('.png');
  const args = ['-y', '-ss', String(at), '-i', src, '-frames:v', '1'];
  if (isPng) {
    args.push('-c:v', 'png', '-pix_fmt', 'rgb24');
  } else {
    args.push('-q:v', '2');
  }
  args.push(dest);
  return run(ffmpegPath, args);
}

/**
 * Xoá dải chữ (caption mã sản phẩm ở phần trên khung hình) trong 1 ảnh bằng delogo (nội suy nền), lưu ra dest.
 * Dùng cho khung hình cuối của Part 1 trước khi làm khung mở đầu Part 2: nếu để nguyên, Flow chép luôn dòng mã cũ sang Part 2.
 * Vùng mặc định = dải ngang giữa, từ 4% tới 21% chiều cao (chỗ Flow in "caption at the top-center fifth").
 */
export async function removeCaptionBand(src, dest, { x = 0.1, y = 0.04, w = 0.8, h = 0.17 } = {}) {
  const info = await probe(src);
  const W = info.width, H = info.height;
  if (!W || !H) throw new Error('Không đọc được kích thước ảnh để xoá dải chữ');
  const X = Math.max(1, Math.round(W * x)), Y = Math.max(1, Math.round(H * y));
  const BW = Math.min(W - X - 1, Math.round(W * w)), BH = Math.min(H - Y - 1, Math.round(H * h));
  return run(ffmpegPath, ['-y', '-i', src, '-vf', `delogo=x=${X}:y=${Y}:w=${BW}:h=${BH}:show=0`, '-c:v', 'png', '-pix_fmt', 'rgb24', dest]);
}

// Chạy ffmpeg và trả về stderr (bộ lọc signalstats in số đo ra stderr)
function runStderr(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(err) : reject(new Error(err.split('\n').slice(-6).join('\n') || `exit ${code}`))));
  });
}

/**
 * Độ sáng / màu trung bình (YUV 0–255) của PHẦN NỀN trong 1 đoạn video: 2 dải dọc sát mép trái và phải (mỗi dải 18% chiều rộng,
 * thường là tường / cửa của bối cảnh) để người mẫu đổi dáng / cỡ khung hình không làm lệch số đo. start / dur tính bằng giây.
 */
export async function backgroundStats(src, { start = 0, dur = 0.4 } = {}) {
  const vals = { YAVG: [], UAVG: [], VAVG: [] };
  for (const x of ['0', 'iw*0.82']) {
    const err = await runStderr(['-hide_banner', '-ss', String(Math.max(0, start)), '-t', String(dur), '-i', src, '-vf', `crop=iw*0.18:ih:${x}:0,signalstats,metadata=mode=print`, '-f', 'null', '-']);
    for (const m of err.matchAll(/lavfi\.signalstats\.(YAVG|UAVG|VAVG)=([\d.]+)/g)) vals[m[1]].push(Number(m[2]));
  }
  const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
  return { y: avg(vals.YAVG), u: avg(vals.UAVG), v: avg(vals.VAVG) };
}

/**
 * CÂN MÀU phân cảnh sau theo phân cảnh trước (ghép 2 phân cảnh tạo riêng: Flow hay ra phân cảnh 2 sáng / tối hoặc ám màu khác).
 * So nền của 0,4s CUỐI video tham chiếu với 0,4s ĐẦU video cần chỉnh, rồi nhân độ sáng (Y) và dịch 2 kênh màu (U, V) của cả video
 * cần chỉnh cho khớp (giới hạn ±20% sáng, ±10 màu để không làm hỏng video khi số đo bất thường). Lệch rất nhỏ thì không chỉnh.
 * Trả { applied, ky, du, dv, ref, cur }; applied = true thì video đã chỉnh được ghi ra dest.
 */
export async function colorMatchVideo(refVideo, src, dest) {
  const refInfo = await probe(refVideo);
  const ref = await backgroundStats(refVideo, { start: (refInfo.duration || 1) - 0.45, dur: 0.4 });
  const cur = await backgroundStats(src, { start: 0.05, dur: 0.4 });
  if (![ref.y, ref.u, ref.v, cur.y, cur.u, cur.v].every(Number.isFinite) || cur.y <= 0) return { applied: false, ref, cur, reason: 'không đo được' };
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const ky = clamp(ref.y / cur.y, 0.8, 1.25);
  const du = clamp(ref.u - cur.u, -10, 10);
  const dv = clamp(ref.v - cur.v, -10, 10);
  if (Math.abs(ky - 1) < 0.015 && Math.abs(du) < 1.5 && Math.abs(dv) < 1.5) return { applied: false, ky, du, dv, ref, cur, reason: 'đã khớp' };
  const off = (d) => (d >= 0 ? `+${d.toFixed(2)}` : `-${Math.abs(d).toFixed(2)}`);
  await run(ffmpegPath, [
    '-y', '-i', src,
    '-vf', `lutyuv=y=val*${ky.toFixed(4)}:u=val${off(du)}:v=val${off(dv)}`,
    '-c:v', 'libx264', '-crf', '15', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'copy',
    dest,
  ]);
  return { applied: true, ky, du, dv, ref, cur };
}

// Trích xuất khung hình cuối cùng của video ở định dạng PNG chuẩn màu rgb24 nguyên bản (giữ nguyên dải màu gốc, không bị nén mất màu như JPG)
export async function extractLastFrame(src, dest) {
  const info = await probe(src);
  const at = Math.max(0, (info.duration || 1) - 0.08);
  const targetPath = dest.toLowerCase().endsWith('.png') ? dest : `${dest.replace(/\.[^.]+$/, '')}.png`;
  await run(ffmpegPath, [
    '-y',
    '-ss', String(at),
    '-i', src,
    '-frames:v', '1',
    '-c:v', 'png',
    '-pix_fmt', 'rgb24',
    targetPath,
  ]);
  return targetPath;
}

// Cắt một vùng hình chữ nhật từ ảnh nguồn
export function cropImage(src, dest, { x = 0, y = 0, width, height }) {
  const w = Math.round(Number(width));
  const h = Math.round(Number(height));
  const cx = Math.max(0, Math.round(Number(x)));
  const cy = Math.max(0, Math.round(Number(y)));
  return run(ffmpegPath, ['-y', '-i', src, '-vf', `crop=${w}:${h}:${cx}:${cy}`, dest]);
}

// Ảnh thu nhỏ cho file ảnh
export function imageThumb(src, dest) {
  return run(ffmpegPath, ['-y', '-i', src, '-vf', 'scale=320:-2', dest]);
}

// Tỷ lệ 0–1 -> chuỗi số gọn cho biểu thức ffmpeg (chặn trong [0, 1])
const badgeRatio = (v, dflt) => {
  const n = Number(v);
  return String(Math.min(1, Math.max(0, Number.isFinite(n) ? n : dflt)));
};

/**
 * Đè PNG khung mã sản phẩm lên 1 ảnh (ảnh kết quả của quy trình chỉ làm ảnh "Ảnh model mặc đồ") -> file ảnh mới.
 * x, y = tỷ lệ tâm khung (0–1) so với khung hình; frameWidth = chiều rộng khung hình mà PNG được vẽ cho,
 * width = chiều rộng ảnh thật -> PNG được scale cho đúng cỡ nếu hai số khác nhau. Hàm thuần (để kiểm thử), overlayBadge chạy ffmpeg.
 */
export function buildOverlayBadgeArgs({ src, badge, dest, x = 0.5, y = 0.12, frameWidth, width }) {
  const fw = Number(frameWidth);
  const w = Number(width);
  const prep = fw > 0 && w > 0 && Math.abs(fw - w) > 1
    ? `[1:v]format=rgba,scale=trunc(iw*${w}/${fw}/2)*2:-2[b]`
    : '[1:v]format=rgba[b]';
  const filter = `${prep};[0:v][b]overlay=x=W*${badgeRatio(x, 0.5)}-overlay_w/2:y=H*${badgeRatio(y, 0.12)}-overlay_h/2:format=auto[v]`;
  return ['-y', '-i', src, '-i', badge, '-filter_complex', filter, '-map', '[v]', '-frames:v', '1', dest];
}
export function overlayBadge(opts) {
  return run(ffmpegPath, buildOverlayBadgeArgs(opts));
}

/**
 * Gộp các khoảng [start, end] của CÙNG một video thành 1 file (bỏ các đoạn không có trong ranges), một lần chạy ffmpeg,
 * không cần file tạm: trim từng khoảng rồi concat. Giữ âm thanh gốc nếu có và không mute.
 */
export function concatRanges(src, dest, ranges, { mute = false, fps = 30, hasAudio = true } = {}) {
  const useAudio = hasAudio && !mute;
  const filters = [];
  ranges.forEach(([a, b], i) => {
    filters.push(`[0:v]trim=start=${a.toFixed(6)}:end=${b.toFixed(6)},setpts=PTS-STARTPTS,fps=${fps},format=yuv420p[v${i}]`);
    if (useAudio) filters.push(`[0:a]atrim=start=${a.toFixed(6)}:end=${b.toFixed(6)},asetpts=PTS-STARTPTS[a${i}]`);
  });
  const pads = ranges.map((_, i) => (useAudio ? `[v${i}][a${i}]` : `[v${i}]`)).join('');
  filters.push(`${pads}concat=n=${ranges.length}:v=1:a=${useAudio ? 1 : 0}[v]${useAudio ? '[a]' : ''}`);
  const args = ['-y', '-i', src, '-filter_complex', filters.join(';'), '-map', '[v]'];
  if (useAudio) args.push('-map', '[a]', '-c:a', 'aac', '-b:a', '192k');
  else args.push('-an');
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-movflags', '+faststart', dest);
  return run(ffmpegPath, args);
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
