// Timecode kiểu CapCut: mm:ss:ff (ff = số khung trong giây), thêm giờ nếu video ≥ 1 tiếng
const pad = (n) => String(n).padStart(2, '0');

export function tc(frame, fps) {
  const f = Math.max(0, Math.round(frame));
  const sec = Math.floor(f / fps + 1e-9);
  const ff = Math.floor(f - sec * fps + 1e-6);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return (h ? `${h}:${pad(m)}` : pad(m)) + `:${pad(s)}:${pad(ff)}`;
}

// Giây -> timecode
export const tcs = (seconds, fps) => tc(Math.round(seconds * fps), fps);

// "00:24:01" | "1:00:24:01" | "24:01" -> số khung
export function parseTc(text, fps) {
  const parts = String(text).trim().split(/[:.]/).map(Number);
  if (!parts.length || parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  const ff = parts.pop();
  const [h = 0, m = 0, s = 0] = [0, 0, 0, ...parts].slice(-3);
  return Math.round((h * 3600 + m * 60 + s) * fps) + ff;
}
