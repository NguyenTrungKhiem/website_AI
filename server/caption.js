// Chữ in trên video thời trang (dùng chung cho "Video bán hàng thời trang" và "… không voice"):
//   'code' = mã sản phẩm (VAY_01…, mặc định, như trước) · 'text' = chữ tuỳ ý người dùng nhập · 'none' = video không có chữ.
// Prompt mẫu viết sẵn cho chế độ 'code'; các hàm dưới đây đổi câu về chữ trên màn hình theo chế độ, KHÔNG đụng các mốc động tác.

export const CAPTION_MODES = ['code', 'text', 'none'];
export const captionModeOf = (options = {}) => (CAPTION_MODES.includes(options.captionMode) ? options.captionMode : 'code');

// Chữ tuỳ ý: 1 dòng, bỏ dấu nháy (prompt bọc chữ trong "…"), tối đa 40 ký tự. Giữ dấu tiếng Việt nếu người dùng gõ
// (lưu ý: model video vẽ chữ có dấu hay sai — nên viết ngắn, không dấu nếu được).
export const MAX_CAPTION_TEXT = 40;
export function cleanCaptionText(v) {
  return String(v ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/["“”„«»`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CAPTION_TEXT)
    .trim();
}

// Câu dặn "không có chữ" thêm vào prompt khi chế độ 'none'
export const NO_TEXT_RULE = 'No title, caption, subtitle, logo or any other text anywhere on screen.';

// Chia 1 dòng prompt thành các câu ("…. Câu sau"), không cắt số thập phân như "1.5s"
const sentences = (line) => line.split(/(?<=[.!?])\s+(?=[A-Z"(])/);
// Chia 1 câu theo dấu phẩy ở ngoài ngoặc đơn
function clauses(sentence) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < sentence.length; i++) {
    const ch = sentence[i];
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Bỏ mọi chỉ dẫn in chữ có chứa `marker` (regex) khỏi prompt: câu có nhiều vế (dấu phẩy) thì chỉ bỏ vế chứa chữ,
 * còn lại bỏ cả câu. Dòng trống sau khi bỏ thì xoá. Trả về prompt mới.
 */
export function stripTextInstructions(prompt, marker) {
  return String(prompt)
    .split('\n')
    .map((line) => {
      if (!marker.test(line)) return line;
      const kept = sentences(line).flatMap((s) => {
        if (!marker.test(s)) return [s];
        const parts = clauses(s);
        if (parts.length > 1) {
          const rest = parts.filter((p) => !marker.test(p));
          if (rest.length && rest.length < parts.length) {
            let joined = rest.join(',').trimEnd();
            if (!/[.!?]$/.test(joined)) joined += '.';
            return [joined];
          }
        }
        return [];
      });
      return kept.join(' ').trim();
    })
    .filter((line, i, all) => line !== '' || (i > 0 && all[i - 1] !== ''))
    .join('\n')
    .trim();
}

// Thêm 1 câu vào dòng "Technical Rule:" (nếu có), không thì thêm thành dòng cuối
export function appendRule(prompt, sentence) {
  const lines = String(prompt).split('\n');
  const idx = lines.findIndex((l) => /^\s*Technical Rule\s*:/i.test(l));
  if (idx >= 0) lines[idx] = `${lines[idx].trimEnd()} ${sentence}`;
  else lines.push(sentence);
  return lines.join('\n');
}

// "Video bán hàng thời trang": chữ "TODAY'S OUTFIT" (cả dấu nháy cong) trong prompt là chỗ in chữ trên video
const TITLE_RE = /TODAY[’']S OUTFIT/g;
const TITLE_TEST = /TODAY[’']S OUTFIT/;
export function applyTitle(template, { mode = 'code', code, text } = {}) {
  if (mode === 'none') {
    const stripped = stripTextInstructions(template, TITLE_TEST);
    return TITLE_TEST.test(stripped) ? stripped.replace(TITLE_RE, '') : appendRule(stripped, NO_TEXT_RULE);
  }
  const value = mode === 'text' ? cleanCaptionText(text) : code;
  if (!value) {
    throw new Error(mode === 'text'
      ? 'Chưa nhập chữ để in lên video (ô "Chữ trên video" trong module)'
      : 'Chưa có mã sản phẩm để in lên video (ô "Mã sản phẩm" trong module)');
  }
  return String(template).replace(TITLE_RE, value);
}
