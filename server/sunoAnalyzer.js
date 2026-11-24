// Phân tích file nhạc MP3 Suno theo cụm câu chính xác 0.1s qua Gemini Web (chạy ngầm)
// & dựng prompt "Nói thoại khô 0 hát / 0 nhạc / vào đúng 0.0s" kèm đa góc quay MV ngôi sao cho Omni Flash.
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

export const CAMERA_PRESETS = [
  { value: 'star-multicam', label: 'Đa góc quay MV ca sĩ nổi tiếng (2–3 góc điện ảnh — Khuyên dùng)' },
  { value: 'steadicam-orbit', label: '1 cú máy Steadicam lượn vòng quanh sân khấu' },
  { value: 'closeup-intimate', label: 'Cận cảnh cảm xúc (ưu tiên tối đa rõ khẩu hình)' },
];

export const LIP_SYNC_MODES = [
  { value: 'spoken', label: 'Nói thoại khô để nhép chặt (0 hát, 0 nhạc → tự thay bằng MP3 gốc)' },
  { value: 'mute', label: 'Câm hoàn toàn trên Flow (bật công tắc Mute trên Flow)' },
];

const VALID_INTENSITIES = new Set(['silent', 'whisper', 'soft', 'medium', 'belting']);

export const SUNO_AUDIO_ANALYSIS_PROMPT = `Bạn là đạo diễn MV ca nhạc chuyên đồng bộ khẩu hình & chỉ đạo diễn xuất sân khấu (Lip-Sync & Star Stage Director).
Tôi đã đính kèm một đoạn âm thanh MP3 dài ĐÚNG {DURATION} giây (từ 0.0s đến {DURATION}.0s).
{LYRICS_HINT}
Hãy LẮNG NGHE thật kỹ từ giây 0.0 đến {DURATION}.0 và trả về kịch bản theo **CỤM CÂU TỰ NHIÊN** chính xác tới 0.1 giây để hệ thống tạo video hát nhép khớp tuyệt đối với bản nhạc gốc.

YÊU CẦU NGHIÊM NGẶT:
1. CHIA THEO CỤM CÂU TỰ NHIÊN (thường 3–5 cụm liền nhau phủ kín từ 0.0 đến {DURATION}.0, độ chính xác 0.1s). TUYỆT ĐỐI KHÔNG chẻ đôi 1 từ/cụm câu chỉ để ép chia chẵn từng 1 giây, và KHÔNG lặp lại chữ kéo dài ngân thành 2 dòng (vd. "đêm dài" phải nằm gọn trong 1 cụm, không tách thêm "dài...").
2. ĐO MỐC MỞ ĐẦU CHÍNH XÁC: Nếu giọng bắt đầu ngay ở đầu file (trong 0.0–0.2s), đặt "from": 0.0 cho cụm đầu tiên. Nếu đầu file thực sự im lặng >= 0.3s trước khi cất tiếng, tạo cụm "hasVoice": false từ 0.0 đến đúng giây bắt đầu nói/hát.
3. ĐỦ 100% CHỮ & ĐỘ DÀI CỤM LÝ TƯỞNG: Mỗi cụm câu giữ tự nhiên khoảng 4–10 từ (ngưỡng đọc nguyên văn chuẩn nhất). Nếu có Lời bài hát tham khảo, trường "lyric" của các cụm gộp lại PHẢI giữ ĐẦY ĐỦ từng chữ của lời tham khảo đó, KHÔNG bỏ sót hay đổi chữ. Giữ nguyên tiếng Việt có dấu (hoặc đúng ngôn ngữ gốc).
4. MỖI CỤM THÊM TRƯỜNG "shot" (<= 12 từ) & "action" (<= 14 từ, VIẾT BẰNG TIẾNG ANH) ĐỂ QUAY NHƯ CA SĨ NGÔI SAO NỔI TIẾNG:
   - "shot": mô tả góc quay điện ảnh gọn sắc thay đổi đa dạng giữa các cụm (vd: "Hero medium shot from waist up, slight low-angle slow push-in" -> "Smooth cut to dramatic 3/4 close-up orbit with glowing rim light" -> "Steadicam medium close-up sweeping smoothly across stage"), luôn nhìn rõ khuôn mặt và đôi môi.
   - "action": mô tả ngắn gọn phong thái ngôi sao hạng A đứng biểu diễn trên sân khấu (tự tin, chuyển trọng tâm uyển chuyển, tay tự do biểu cảm đặt ngực hoặc mở bàn tay hướng khán giả, ánh mắt có hồn). Micro luôn giữ cách môi dưới 3–4cm, KHÔNG BAO GIỜ che môi hay miệng.
5. CẤM TỪ KHOÁ GÂY TẠO NHẠC/HÁT: Trong "shot", "action", "cameraStyle", "stageLighting", TUYỆT ĐỐI KHÔNG dùng các từ: piano, guitar, drums, orchestra, live band, band, concert music, singing, song, melody, ballad, BPM, beat, cheering, applause, high note. Chỉ tả hình ảnh ánh sáng (spotlight, rim light, volumetric stage haze, audience lights bokeh) và cử động cơ thể.

CHỈ trả về DUY NHẤT một khối mã JSON hợp lệ theo mẫu sau (không giải thích bên ngoài):
\`\`\`json
{
  "songMeta": {
    "language": "vi | en | mixed",
    "mood": "emotional dramatic stage atmosphere",
    "vocalGender": "male | female",
    "expression": "passionate intense stage storytelling"
  },
  "cameraStyle": "High-budget 16:9 multi-angle live stage framing alternating hero medium shot, dramatic 3/4 close-up orbit, and smooth Steadicam sweep.",
  "stageLighting": "Warm golden overhead key spotlight with cool blue rim light on shoulders and hair, soft stage haze, and blurred audience lights bokeh behind.",
  "timeline": [
    {
      "from": 0.0,
      "to": 3.2,
      "hasVoice": true,
      "lyric": "Ta quen nhau đã bao lâu rồi",
      "vocalIntensity": "medium",
      "shot": "Hero medium shot from chest up centered under stage spotlight, slow confident push-in",
      "action": "stands with commanding superstar poise, grips wireless mic 4cm below lower lip, tilts chin gently and locks magnetic gaze into camera"
    },
    {
      "from": 3.2,
      "to": 4.0,
      "hasVoice": false,
      "lyric": "",
      "vocalIntensity": "silent",
      "shot": "Hold close-up framing with dramatic backlight rim light",
      "action": "closes eyes briefly for an emotional beat, draws calm breath with lips gently closed"
    }
  ]
}
\`\`\``;

const fmtT = (t) => (Math.round(Number(t) * 10) / 10).toFixed(1);
const round1 = (t) => Math.round(Number(t) * 10) / 10;

const cleanLine = (v) =>
  String(v ?? '')
    .replace(/\s+/g, ' ')
    .replace(/[{}]/g, '')
    .replace(/@Image\d+/gi, 'the reference')
    .trim();

/**
 * Lọc bỏ các từ khoá dễ kích hoạt chế độ hát/tạo nhạc nền/tiếng khán giả trên Omni Flash,
 * đồng thời giữ nguyên từ khoá thị giác sân khấu & diễn xuất ngôi sao (spotlight, rim light, Steadicam...).
 */
export function sanitizeVisualCue(text) {
  let s = String(text ?? '');
  if (!s.trim()) return '';
  s = s
    .replace(/\b\d+\s*bpm\b/gi, '')
    .replace(/\b(pop ballad|ballad)\b/gi, 'dramatic stage piece')
    .replace(/\b(live band|band members?)\b/gi, 'stage backdrop')
    .replace(/\b(concert music|music video soundtrack)\b/gi, 'stage visuals')
    .replace(/\b(cheering|applause|crowd noise)\b/gi, 'glowing lights')
    .replace(/\b(singing|sings|sing|sung|vocal performance|vocal projection)\b/gi, 'expressive delivery')
    .replace(/\b(piano|guitar|drums?|orchestra|instruments?|melody|vibrato|high notes?|song|lyrics?)\b/gi, '')
    .replace(/\b(beat)\b/gi, 'rhythm');

  return s
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/^[,.;:\s]+|[,.;:\s]+$/g, '')
    .trim();
}

/** Tách JSON từ phản hồi text / codeBlocks của Gemini Web (ưu tiên codeBlocks sạch & khối chứa "timeline"). */
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
 * Chuẩn hoá mảng timeline từ Gemini theo mốc chính xác 0.1s trong [0 .. totalSec].
 * Chấp nhận từ 1 cụm câu trở lên; tự chèn cụm [Silent] khi có khoảng nghỉ >= 0.3s.
 */
export function normalizeSunoTimeline(rawTimeline, totalSec = 10) {
  const total = Math.max(1, round1(Number(totalSec) || 10));
  const rawArr = Array.isArray(rawTimeline) ? rawTimeline : [];
  const allMissingFrom = rawArr.length > 0 && rawArr.every((b) => !Number.isFinite(Number(b?.from)));

  let fallbackCursor = 0;
  const items = rawArr
    .map((b, idx) => {
      const hasExplicitFrom = Number.isFinite(Number(b?.from));
      const fromRaw = hasExplicitFrom ? Number(b.from) : fallbackCursor;
      const toRaw = Number.isFinite(Number(b?.to)) ? Number(b.to) : fromRaw + 1;
      fallbackCursor = toRaw;

      const lyric = cleanLine(b?.lyric || b?.voice || '').replace(/"/g, "'");
      const silentText = /^\[?(silent|instrumental|none|music|nghỉ)\]?$/i.test(lyric);
      const hasVoice = b?.hasVoice === false ? false : (!!lyric && !silentText) || !!b?.hasVoice;
      const intensityRaw = String(b?.vocalIntensity || '').trim().toLowerCase();
      const vocalIntensity = !hasVoice
        ? 'silent'
        : VALID_INTENSITIES.has(intensityRaw) && intensityRaw !== 'silent'
          ? intensityRaw
          : 'medium';

      const shot = cleanLine(sanitizeVisualCue(b?.shot || ''));
      const rawAct = cleanLine(sanitizeVisualCue(b?.action || b?.micAndBodyAction || ''));
      const action =
        rawAct ||
        'stands with commanding superstar stage presence, keeping face and lips completely unobstructed with subtle expressive posture';

      return {
        from: Math.max(0, fromRaw),
        to: Math.max(0.1, toRaw),
        hasVoice: hasVoice && !silentText && !!lyric,
        lyric: hasVoice && !silentText ? lyric : '',
        vocalIntensity,
        shot,
        action,
      };
    })
    .filter((b) => Number.isFinite(b.to) && b.to > 0);

  if (items.length < 1) {
    throw new Error(`Gemini trả về kịch bản trống (cần ít nhất 1 cụm cho đoạn ${total}s).`);
  }

  items.sort((a, b) => (a.from === b.from ? a.to - b.to : a.from - b.from));
  const maxTo = items.at(-1).to;
  const shouldScale = maxTo > total * 1.05 || (allMissingFrom && maxTo > 0);
  const scale = shouldScale && maxTo > 0 ? total / maxTo : 1;

  const out = [];
  let cursor = 0;

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const scaledFrom = round1(Math.max(0, Math.min(total, it.from * scale)));
    const scaledTo = round1(Math.max(0, Math.min(total, it.to * scale)));

    if (scaledFrom - cursor >= 0.3) {
      out.push({
        from: cursor,
        to: scaledFrom,
        hasVoice: false,
        lyric: '',
        vocalIntensity: 'silent',
        shot: '',
        action: 'holds emotional stage poise under the spotlight with calm breathing and gently closed lips',
      });
      cursor = scaledFrom;
    }

    const from = cursor;
    let to = i === items.length - 1 ? Math.max(from, scaledTo) : scaledTo;
    if (to <= from) continue;
    if (to - from < 0.2 && i < items.length - 1) to = Math.min(total, round1(from + 0.2));

    out.push({
      from,
      to,
      hasVoice: it.hasVoice,
      lyric: it.lyric,
      vocalIntensity: it.hasVoice ? it.vocalIntensity : 'silent',
      shot: it.shot,
      action: it.action,
    });
    cursor = to;
  }

  if (out.length === 0) {
    throw new Error(`Không chuẩn hoá được các mốc thời gian hợp lệ trong ${total}s.`);
  }

  if (total - cursor >= 0.3) {
    out.push({
      from: cursor,
      to: total,
      hasVoice: false,
      lyric: '',
      vocalIntensity: 'silent',
      shot: '',
      action: 'holds a poised superstar stage expression as the lighting gently settles, lips closed',
    });
  } else if (cursor < total) {
    out.at(-1).to = total;
  }

  return out;
}

const normalizeWords = (str) =>
  String(str || '')
    .toLowerCase()
    .replace(/[.,!?;:"'()\[\]{}…–—\-/\\]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

/**
 * Đối chiếu lời trong timeline với lời bài hát gốc người dùng nhập vào + tính mật độ tốc độ nói.
 */
export function checkLyricsCoverage(lyricsHint, timeline = [], durationSec = 10) {
  const dur = Math.max(1, Number(durationSec) || 10);
  const rows = Array.isArray(timeline) ? timeline : [];
  const voicedRows = rows.filter((r) => r?.hasVoice && String(r?.lyric || '').trim());
  const timelineWordsArr = voicedRows.flatMap((r) => normalizeWords(r.lyric));
  const voicedSec = voicedRows.reduce((sum, r) => sum + Math.max(0.1, (Number(r.to) || 0) - (Number(r.from) || 0)), 0);
  const wordsPerSec = voicedSec > 0 ? +(timelineWordsArr.length / voicedSec).toFixed(2) : 0;

  const expectedArr = normalizeWords(lyricsHint);
  const counts = new Map();
  for (const w of timelineWordsArr) counts.set(w, (counts.get(w) || 0) + 1);

  const missingWords = [];
  for (const w of expectedArr) {
    const c = counts.get(w) || 0;
    if (c > 0) counts.set(w, c - 1);
    else missingWords.push(w);
  }

  const maxRecommended = Math.round(dur * 3.5);
  return {
    timelineWords: timelineWordsArr.length,
    expectedWords: expectedArr.length,
    voicedSec: +voicedSec.toFixed(1),
    wordsPerSec,
    missingWords,
    tooDense: timelineWordsArr.length > maxRecommended,
    maxRecommended,
  };
}

function langDisplay(code) {
  const c = String(code || '').toLowerCase();
  if (c === 'vi' || c.includes('viet')) return 'Vietnamese';
  if (c === 'en' || c.includes('eng')) return 'English';
  if (c === 'mixed') return 'bilingual Vietnamese and English';
  return 'Vietnamese';
}

function singerPronouns(vocalGender) {
  const g = String(vocalGender || '').trim().toLowerCase();
  if (/(^|\b)(female|woman|girl|nữ|nu)\b/.test(g)) return { subj: 'She', poss: 'her', genderWord: 'female' };
  if (/(^|\b)(male|man|boy|nam)\b/.test(g)) return { subj: 'He', poss: 'his', genderWord: 'male' };
  return { subj: 'The singer', poss: 'their', genderWord: '' };
}

function compactCue(text, maxChars = 100) {
  const s = cleanLine(text).replace(/[.,;:\s]+$/, '');
  if (!s || s.length <= maxChars) return s;
  const sub = s.slice(0, maxChars);
  const commaIdx = sub.lastIndexOf(',');
  const spaceIdx = sub.lastIndexOf(' ');
  const cut = commaIdx >= Math.floor(maxChars * 0.55) ? commaIdx : (spaceIdx > 20 ? spaceIdx : maxChars);
  return sub.slice(0, cut).replace(/[,.;:\s]+$/, '');
}

function formatVerbatimLyric(text) {
  const cleaned = String(text ?? '')
    .replace(/"/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  return /[.!?…]$/.test(cleaned) ? cleaned : `${cleaned}.`;
}

function fallbackShotFor(preset, idx) {
  if (preset === 'steadicam-orbit') {
    return idx === 0
      ? 'Smooth continuous Steadicam medium close-up orbiting gracefully around @Image1 on stage'
      : 'Steadicam arc sweeps cleanly toward a subtle low-angle 3/4 hero framing on stage';
  }
  if (preset === 'closeup-intimate') {
    return 'Intimate hero medium close-up from chest up under spotlight, slow subtle push-in';
  }
  const multicam = [
    'Hero medium shot from waist up on stage, slight low-angle slow push-in',
    'Smooth cut to dramatic 3/4 close-up orbit with sparkling rim light and stage bokeh',
    'Smooth cut to Steadicam medium close-up sweeping smoothly across glowing @Image2 stage',
  ];
  return multicam[idx % multicam.length];
}

/**
 * Dựng prompt 2 lớp chuẩn Omni 1.2 Flash (tương đồng khuôn Voice: "..." của geminiFashion.js):
 *   - Setup / Scene / <from>-<to>s: <shot>. <action>. Voice: "<câu tiếng Việt>." / Technical Rule
 *   - Cấm tuyệt đối mọi dấu ngoặc kép ngoài Voice: "..." để Omni Flash đọc nguyên văn, không tự chế lyric
 *   - Không dùng từ khoá nhạc/hát, giữ đa góc quay & phong thái ngôi sao sân khấu trên @Image2.
 */
export function buildSunoVideoPrompt({
  timeline,
  songMeta = {},
  cameraStyle = '',
  stageLighting = '',
  aspectRatio = '16:9',
  durationSec = 10,
  micType = 'handheld',
  cameraPreset = 'star-multicam',
  lipSyncMode = 'spoken',
}) {
  const total = Math.max(1, Number(durationSec) || 10);
  const ratioLabel = aspectRatio === '9:16' ? 'vertical 9:16' : 'widescreen 16:9';
  const langLabel = langDisplay(songMeta?.language);
  const { subj, poss, genderWord } = singerPronouns(songMeta?.vocalGender);
  const isMuteMode = lipSyncMode === 'mute';

  const beats = normalizeSunoTimeline(timeline, total);
  const firstBeat = beats[0];

  const camStyleTag =
    cameraPreset === 'steadicam-orbit'
      ? 'continuous Steadicam orbit (no cuts)'
      : cameraPreset === 'closeup-intimate'
        ? 'intimate hero close-up'
        : compactCue(sanitizeVisualCue(cameraStyle), 90) || 'dynamic multi-angle stage camera';

  let startPhrase = `speaks from 0.0s to ${fmtT(total)}s`;
  if (firstBeat?.hasVoice && firstBeat.from <= 0.2) {
    startPhrase = isMuteMode ? 'mouthing begins immediately at 0.0s' : 'speech begins immediately on frame 1 at 0.0s';
  } else if (firstBeat && !firstBeat.hasVoice) {
    startPhrase = `mouth stays closed from 0.0s to ${fmtT(firstBeat.to)}s then ${isMuteMode ? 'begins mouthing' : 'begins'} immediately at ${fmtT(firstBeat.to)}s`;
  }

  const genderPart = genderWord ? ` ${genderWord}` : '';
  const audioSetup = isMuteMode
    ? `completely silent video (zero sound, zero music, clear silent lip-sync mouthing every word, ${startPhrase})`
    : `clear dry spoken ${langLabel}${genderPart} voice with exact lip-sync (dry spoken voice ONLY, zero music, zero melody, zero intro pause — ${startPhrase})`;

  const micRule =
    micType === 'stand'
      ? `${subj} stands with confident superstar posture behind a stage stand microphone 3-4cm below ${poss} lower lip without ever blocking ${poss} mouth.`
      : `${subj} commands the stage with charismatic superstar poise, gripping a wireless handheld microphone 3-4cm below ${poss} lower lip without ever blocking ${poss} lips or mouth.`;

  const stageDesc =
    compactCue(sanitizeVisualCue(stageLighting), 130) ||
    'warm overhead spotlights, glowing shoulder rim light, soft stage haze, and blurred audience lights behind';

  const beatLines = beats.map((b, i) => {
    const tLabel = `${fmtT(b.from)}-${fmtT(b.to)}s`;
    const shotDesc = compactCue(b.shot || fallbackShotFor(cameraPreset, i), 92);
    const actionDesc = compactCue(b.action, 112);
    if (b.hasVoice && b.lyric) {
      const safeLyric = formatVerbatimLyric(b.lyric);
      if (isMuteMode) {
        const wps = normalizeWords(b.lyric).length / Math.max(0.4, b.to - b.from);
        const paceWord = wps > 3.2 ? 'brisk crisp pace' : 'natural steady pace';
        return `${tLabel}: ${shotDesc}. ${actionDesc}. Silent lip-sync mouthing (${paceWord}): "${safeLyric}"`;
      }
      return `${tLabel}: ${shotDesc}. ${actionDesc}. Voice: "${safeLyric}"`;
    }
    return `${tLabel}: ${shotDesc}. ${actionDesc}, lips gently closed. Voice: [Silent]`;
  });

  const setupLine = `Setup (${total}s): Full ${total}s ${ratioLabel} live-stage clip, ${camStyleTag}, ${audioSetup}. Strictly lock 100% facial features, hairstyle, physique, and outfit to @Image1.`;
  const sceneLine = `Scene: @Image1 stands center-stage on the venue floor of @Image2 with ${stageDesc} (silent visual backdrop only). ${micRule}`;
  const ruleLine = isMuteMode
    ? `Technical Rule: 1:1 face and outfit lock to @Image1 and stage consistency with @Image2. Completely silent video with clear natural lip-sync mouthing ONLY the exact listed words in order from 0.0s to ${fmtT(total)}s — zero invented or skipped words. Keep lips unobstructed by microphone and closed during Voice: [Silent]. Zero on-screen text, subtitles, or watermarks.`
    : `Technical Rule: 1:1 face and outfit lock to @Image1 and stage consistency with @Image2. Speak ONLY the exact verbatim words inside each Voice line in order from 0.0s to ${fmtT(total)}s — strictly zero invented, added, altered, or skipped words; zero music, zero melody, zero intro delay. Keep lips unobstructed by microphone and closed during Voice: [Silent]. Zero on-screen text, subtitles, or watermarks.`;

  return [setupLine, sceneLine, ...beatLines, ruleLine].join('\n');
}

export function formatAnalysisPrompt(template, { durationSec = 10, lyricsHint = '' } = {}) {
  const base = String(template || '').trim() || SUNO_AUDIO_ANALYSIS_PROMPT;
  const lyricsBlock = String(lyricsHint || '').trim()
    ? `Lời bài hát GỐC của đoạn ${durationSec} giây này (BẮT BUỘC giữ ĐỦ 100% từng chữ trong "lyric", không bỏ sót từ nào):\n"""\n${String(lyricsHint).trim().slice(0, 1500)}\n"""\n`
    : 'Chú ý: Không có lời gợi ý kèm theo — hãy tự lắng nghe thật chuẩn từng âm tiết trong file MP3.\n';
  return base.replace(/\{DURATION\}/g, String(durationSec)).replace(/\{LYRICS_HINT\}/g, lyricsBlock);
}

/**
 * Cắt đoạn MP3 theo [startSec, startSec + durationSec) rồi gọi Playwright Gemini Web chạy ngầm phân tích từng cụm câu
 * và trả về { songMeta, cameraStyle, stageLighting, timeline, coverage, videoPrompt, rawText, selectedModel }.
 */
export async function analyzeSunoAudioWithWeb({
  audioPath,
  startSec = 0,
  durationSec = 10,
  lyricsHint = '',
  micType = 'handheld',
  aspectRatio = '16:9',
  cameraPreset = 'star-multicam',
  lipSyncMode = 'spoken',
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
    const cameraStyle = cleanLine(sanitizeVisualCue(parsed.cameraStyle || ''));
    const stageLighting = cleanLine(sanitizeVisualCue(parsed.stageLighting || ''));
    const coverage = checkLyricsCoverage(lyricsHint, timeline, dur);
    const videoPrompt = buildSunoVideoPrompt({
      timeline,
      songMeta,
      cameraStyle,
      stageLighting,
      aspectRatio,
      durationSec: dur,
      micType,
      cameraPreset,
      lipSyncMode,
    });

    return {
      songMeta,
      cameraStyle,
      stageLighting,
      timeline,
      coverage,
      videoPrompt,
      rawText: webRes?.rawText || '',
      selectedModel: webRes?.selectedModel || modelName || 'Neon',
    };
  } finally {
    fs.rm(slicePath, { force: true }, () => {});
  }
}
