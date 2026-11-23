// Phân tích file nhạc MP3 Suno từng giây qua Gemini Web (chạy ngầm) & dựng prompt hát nhép cho Omni Flash (16:9, 10s).
// Các hàm tách JSON, chuẩn hoá timeline 10s và dựng prompt là hàm thuần để dễ kiểm thử (scripts/test-suno-workflow.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, newId } from './db.js';
import { cutAudioSlice } from './ffmpeg.js';
import { DEFAULT_GEMINI_WEB_URL, collectJsonCandidates, runGeminiWebPrompt } from './geminiWeb.js';

export const DEFAULT_SUNO_DURATION = '10s';
export const SUNO_DURATIONS = ['10s', '8s', '15s'];
export const SUNO_ASPECT_RATIOS = ['16:9', '9:16'];
export const MIC_TYPES = [
  { value: 'handheld', label: 'Micro cầm tay không dây' },
  { value: 'stand', label: 'Micro đứng trên chân đế' },
];

const VALID_INTENSITIES = new Set(['silent', 'whisper', 'soft', 'medium', 'belting']);
const INTENSITY_CUES = {
  silent: 'mouth closed',
  whisper: 'soft breathy whisper articulation',
  soft: 'gentle lip motion, subtle jaw drop',
  medium: 'clear singing lip articulation, natural jaw rhythm',
  belting: 'wide expressive open mouth on high notes, strong diaphragm breath and slight head lift',
};

export const SUNO_AUDIO_ANALYSIS_PROMPT = `Bạn là đạo diễn MV ca nhạc chuyên đồng bộ khẩu hình hát nhép (Lip-Sync Director).
Tôi đã đính kèm một đoạn âm thanh MP3 dài ĐÚNG {DURATION} giây (từ 0.0s đến {DURATION}.0s).
{LYRICS_HINT}
Hãy LẮNG NGHE thật kỹ từng giây một (0.0→1.0s, 1.0→2.0s, …, tới {DURATION}.0s) và phân tích giọng hát + nhịp điệu để tạo kịch bản cho ca sĩ cầm micro hát nhép khớp từng giây với bản nhạc gốc này.

YÊU CẦU NGHIÊM NGẶT:
1. "timeline" PHẢI phủ kín và LIỀN NHAU từng 1 giây từ 0.0 đến {DURATION}.0 (ví dụ 10s = đúng 10 mốc: 0.0-1.0, 1.0-2.0, ..., 9.0-10.0).
2. Giây nào CÓ giọng hát/đọc rap: đặt "hasVoice": true, ghi chính xác cụm từ/âm tiết nghe được trong đúng giây đó vào "lyric" (giữ đúng ngôn ngữ của bài hát, vd. tiếng Việt có dấu), đặt "vocalIntensity" là "whisper" | "soft" | "medium" | "belting", và mô tả rõ khẩu hình môi/răng/hàm bằng tiếng Anh trong "mouthGuide".
3. Giây nào CHỈ có nhạc dạo / nghỉ lấy hơi / không có tiếng người hát: đặt "hasVoice": false, "lyric": "", "vocalIntensity": "silent", và "mouthGuide": "mouth gently closed, natural breathing".
4. "action" (tiếng Anh): mô tả cử động tay cầm micro, đầu, vai và biểu cảm khuôn mặt nối tiếp mượt mà giữa các giây. Micro luôn đặt thấp hơn môi dưới 3–5cm, KHÔNG BAO GIỜ che miệng hay môi. Không nhắc tên @Image hay chữ trên màn hình.

CHỈ trả về DUY NHẤT một khối mã JSON hợp lệ theo mẫu sau (không giải thích thêm bên ngoài):
\`\`\`json
{
  "songMeta": {
    "language": "vi | en | mixed",
    "tempoBpm": 100,
    "mood": "emotional live pop ballad",
    "vocalGender": "female | male",
    "genre": "V-Pop Ballad"
  },
  "cameraStyle": "one concise English sentence describing smooth 16:9 concert framing (medium close-up from chest up, ultra-smooth slow push-in, no cuts)",
  "stageLighting": "one concise English sentence matching stage mood, spotlight, rim light, audience & band motion in the background",
  "timeline": [
    {
      "from": 0.0,
      "to": 1.0,
      "hasVoice": false,
      "lyric": "",
      "vocalIntensity": "silent",
      "mouthGuide": "mouth gently closed, natural breathing",
      "action": "holds the wireless microphone 4cm below her chin and sways gently to the intro beat"
    }
  ]
}
\`\`\``;

const fmtT = (t) => (Math.round(Number(t) * 10) / 10).toFixed(1);
const cleanLine = (v) =>
  String(v ?? '')
    .replace(/\s+/g, ' ')
    .replace(/[{}]/g, '')
    .replace(/@Image\d+/gi, 'the reference')
    .trim();

/**
 * Tách JSON từ phản hồi text / codeBlocks của Gemini Web (ưu tiên codeBlocks sạch & khối chứa "timeline").
 */
export function extractJsonBlock(rawText, codeBlocks = []) {
  const src = String(rawText || '').trim();
  const blocks = Array.isArray(codeBlocks) ? codeBlocks : [];
  if (!src && blocks.length === 0) throw new Error('Gemini Web trả về nội dung rỗng.');

  const candidates = collectJsonCandidates(src, blocks);
  let fallbackParsed = null;
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(candidates[i]);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        if (Array.isArray(obj.timeline)) return obj;
        if (!fallbackParsed) fallbackParsed = obj;
      }
    } catch {
      /* thử ứng viên tiếp theo */
    }
  }
  if (fallbackParsed) return fallbackParsed;
  const preview = (blocks.at(-1) || src).replace(/\s+/g, ' ').trim().slice(0, 160);
  throw new Error(
    `Không đọc được JSON hợp lệ từ câu trả lời của Gemini Web (nhận được: "${preview}"). Thử chạy lại hoặc kiểm tra cửa sổ Gemini.`,
  );
}

/**
 * Chuẩn hoá mảng timeline từ Gemini về các mốc liền nhau [0.0 .. totalSec], làm sạch lyric & khẩu hình.
 */
export function normalizeSunoTimeline(rawTimeline, totalSec = 10) {
  const total = Math.max(1, Math.round((Number(totalSec) || 10) * 10) / 10);
  const items = (Array.isArray(rawTimeline) ? rawTimeline : [])
    .map((b, idx) => {
      const toRaw = Number(b?.to);
      const fromRaw = Number(b?.from);
      const to = Number.isFinite(toRaw) ? toRaw : Number.isFinite(fromRaw) ? fromRaw + 1 : idx + 1;
      const lyric = cleanLine(b?.lyric || b?.voice || '').replace(/"/g, "'");
      const silentText = /^\[?(silent|instrumental|none|music|nghỉ)\]?$/i.test(lyric);
      const hasVoice = b?.hasVoice === false ? false : (!!lyric && !silentText) || !!b?.hasVoice;
      const intensityRaw = String(b?.vocalIntensity || '').trim().toLowerCase();
      const vocalIntensity = !hasVoice
        ? 'silent'
        : VALID_INTENSITIES.has(intensityRaw) && intensityRaw !== 'silent'
          ? intensityRaw
          : 'medium';
      const action = cleanLine(b?.action || b?.micAndBodyAction || 'keeps posture steady on stage holding the microphone naturally below chin');
      const mouthGuide = cleanLine(
        b?.mouthGuide ||
          (hasVoice ? 'clear lip and jaw movement matching the sung syllables' : 'mouth gently closed, natural breathing'),
      );
      return {
        from: Number.isFinite(fromRaw) ? fromRaw : idx,
        to,
        hasVoice: hasVoice && !silentText && !!lyric,
        lyric: hasVoice && !silentText ? lyric : '',
        vocalIntensity,
        mouthGuide,
        action,
      };
    })
    .filter((b) => Number.isFinite(b.to) && b.to > 0);

  if (items.length < 3) {
    throw new Error(`Gemini trả về quá ít mốc thời gian (${items.length} mốc, cần tối thiểu 3 mốc cho đoạn ${total}s).`);
  }

  items.sort((a, b) => a.to - b.to);
  const lastTo = items.at(-1).to;
  const scale = lastTo > 0 ? total / lastTo : 1;
  let prev = 0;

  return items.map((b, i) => {
    const isLast = i === items.length - 1;
    let to = isLast ? total : Math.round(b.to * scale * 10) / 10;
    if (!(to > prev)) {
      const remaining = items.length - i;
      to = Math.min(total, Math.round((prev + (total - prev) / remaining) * 10) / 10);
      if (isLast || to <= prev) to = total;
    }
    const out = {
      from: prev,
      to,
      hasVoice: b.hasVoice,
      lyric: b.lyric,
      vocalIntensity: b.hasVoice ? b.vocalIntensity : 'silent',
      mouthGuide: b.hasVoice ? b.mouthGuide : 'mouth gently closed, natural breathing',
      action: b.action,
    };
    prev = to;
    return out;
  });
}

function langDisplay(code) {
  const c = String(code || '').toLowerCase();
  if (c === 'vi' || c.includes('viet')) return 'Vietnamese';
  if (c === 'en' || c.includes('eng')) return 'English';
  if (c === 'mixed') return 'bilingual Vietnamese and English';
  return 'sung';
}

function singerPronouns(vocalGender) {
  const g = String(vocalGender || '').trim().toLowerCase();
  if (/(^|\b)(female|woman|girl|nữ|nu)\b/.test(g)) return { subj: 'She', poss: 'her' };
  if (/(^|\b)(male|man|boy|nam)\b/.test(g)) return { subj: 'He', poss: 'his' };
  return { subj: 'The singer', poss: 'their' };
}

/**
 * Dựng prompt hoàn chỉnh gửi Omni Flash (Flow) từ timeline đã phân tích.
 * Tham chiếu cố định @Image1 (nhân vật) và @Image2 (ảnh sân khấu người dùng cung cấp).
 */
export function buildSunoVideoPrompt({
  timeline,
  songMeta = {},
  cameraStyle = '',
  stageLighting = '',
  aspectRatio = '16:9',
  durationSec = 10,
  micType = 'handheld',
}) {
  const total = Math.max(1, Number(durationSec) || 10);
  const ratioLabel = aspectRatio === '9:16' ? 'vertical 9:16' : 'widescreen 16:9';
  const langLabel = langDisplay(songMeta?.language);
  const tempo = Number(songMeta?.tempoBpm);
  const moodStr = cleanLine(songMeta?.mood || songMeta?.genre || '');
  const metaTail = [moodStr && `${moodStr} vibe`, Number.isFinite(tempo) && tempo > 30 && tempo < 240 ? `around ${Math.round(tempo)} BPM` : '']
    .filter(Boolean)
    .join(', ');

  const { subj, poss } = singerPronouns(songMeta?.vocalGender);
  const micRule =
    micType === 'stand'
      ? `${subj} sings into a sleek stage microphone mounted on a stand positioned 4cm below ${poss} lower lip, hands resting naturally on the stand or gesturing expressively beside it without ever covering ${poss} mouth.`
      : `${subj} holds a wireless stage handheld microphone smoothly 3-5cm below and slightly angled away from ${poss} chin, keeping ${poss} lips, teeth, and mouth completely unobstructed in every single frame.`;

  const cam = cleanLine(cameraStyle) || 'Medium close-up from waist/chest up, front-facing at a subtle 15-degree angle so mouth movement and facial emotion stay crystal clear; ultra-smooth subtle slow push-in, single continuous shot with zero cuts.';
  const light = cleanLine(stageLighting) || 'Match the stage spotlight, warm/cool rim light, and ambient concert glow from @Image2 naturally onto the singer, with live band members and cheering audience softly out of focus in the background.';

  const beats = normalizeSunoTimeline(timeline, total);
  const beatLines = beats.map((b) => {
    const tLabel = `${fmtT(b.from)}-${fmtT(b.to)}s`;
    if (b.hasVoice && b.lyric) {
      const cue = INTENSITY_CUES[b.vocalIntensity] || INTENSITY_CUES.medium;
      return `${tLabel}: ${b.action}. ${b.mouthGuide} (${cue}). Voice: "${b.lyric}"`;
    }
    return `${tLabel}: ${b.action}. Mouth closed, calm breathing, swaying naturally to the rhythm. Voice: [Silent]`;
  });

  return [
    `Setup (${total}s): Full ${total}-second cinematic live concert music video clip, ${ratioLabel}, continuous single-take shot, realistic stage camera footage, ${langLabel} vocal performance with precise second-by-second lip-sync${metaTail ? ` (${metaTail})` : ''}.`,
    `Identity: Strictly lock 100% of facial features, hairstyle, skin tone, head-to-body ratio, physique, and outfit to @Image1 in every frame with zero face morphing or identity drift.`,
    `Scene: Place the @Image1 singer performing center-stage inside the exact venue, stage architecture, live band, and audience environment shown in @Image2. ${light}`,
    `Microphone & Camera: ${micRule} ${cam}`,
    ...beatLines,
    `Technical Rule: Maintain 1:1 identity fidelity to @Image1 and 1:1 stage consistency with @Image2 across all ${total}.0s. Anatomically accurate hands and fingers gripping the microphone; never let the microphone or hands block the mouth or lips. Match mouth opening and lip articulation accurately to every Voice line, and keep lips closed during [Silent] seconds. Zero subtitles, captions, lyrics text overlays, or watermarks.`,
  ].join('\n');
}

export function formatAnalysisPrompt(template, { durationSec = 10, lyricsHint = '' } = {}) {
  const base = String(template || '').trim() || SUNO_AUDIO_ANALYSIS_PROMPT;
  const lyricsBlock = String(lyricsHint || '').trim()
    ? `Lời bài hát tham khảo của đoạn ${durationSec} giây này (dùng để đối chiếu đúng từng chữ khi nghe):\n"""\n${String(lyricsHint).trim().slice(0, 1500)}\n"""\n`
    : 'Chú ý: Không có lời gợi ý kèm theo — hãy tự lắng nghe thật chuẩn từng âm tiết trong file MP3.\n';
  return base.replace(/\{DURATION\}/g, String(durationSec)).replace(/\{LYRICS_HINT\}/g, lyricsBlock);
}

/**
 * Cắt đoạn MP3 theo [startSec, startSec + durationSec) rồi gọi Playwright Gemini Web chạy ngầm phân tích từng giây
 * và trả về { songMeta, cameraStyle, stageLighting, timeline, videoPrompt, rawText, selectedModel }.
 */
export async function analyzeSunoAudioWithWeb({
  audioPath,
  startSec = 0,
  durationSec = 10,
  lyricsHint = '',
  micType = 'handheld',
  aspectRatio = '16:9',
  modelName = 'Neon',
  thinkingLevel = 'Trung bình',
  url = DEFAULT_GEMINI_WEB_URL,
  analysisTemplate = SUNO_AUDIO_ANALYSIS_PROMPT,
  onProgress = () => {},
  runWeb = runGeminiWebPrompt,
} = {}) {
  if (!audioPath || !fs.existsSync(audioPath)) {
    throw new Error('Không tìm thấy file nhạc MP3 Suno để phân tích.');
  }
  const dur = Math.max(1, Number(durationSec) || 10);
  const start = Math.max(0, Number(startSec) || 0);
  fs.mkdirSync(DIRS.tmp, { recursive: true });
  const slicePath = path.join(DIRS.tmp, `suno-slice-${newId()}.mp3`);

  try {
    onProgress?.(`Đang cắt đoạn nhạc ${dur}s (từ ${start.toFixed(1)}s → ${(start + dur).toFixed(1)}s)…`);
    await cutAudioSlice(audioPath, slicePath, start, dur);

    const prompt = formatAnalysisPrompt(analysisTemplate, { durationSec: dur, lyricsHint });
    const webRes = await runWeb({
      filePath: slicePath,
      prompt,
      modelName,
      thinkingLevel,
      url,
      expectJson: true,
      onProgress,
    });

    const parsed = extractJsonBlock(webRes?.rawText || '', webRes?.codeBlocks || []);
    const timeline = normalizeSunoTimeline(parsed.timeline, dur);
    const songMeta = parsed.songMeta && typeof parsed.songMeta === 'object' ? parsed.songMeta : {};
    const cameraStyle = cleanLine(parsed.cameraStyle || '');
    const stageLighting = cleanLine(parsed.stageLighting || '');
    const videoPrompt = buildSunoVideoPrompt({
      timeline,
      songMeta,
      cameraStyle,
      stageLighting,
      aspectRatio,
      durationSec: dur,
      micType,
    });

    return {
      songMeta,
      cameraStyle,
      stageLighting,
      timeline,
      videoPrompt,
      rawText: webRes?.rawText || '',
      selectedModel: webRes?.selectedModel || modelName || 'Neon',
    };
  } finally {
    fs.rm(slicePath, { force: true }, () => {});
  }
}
