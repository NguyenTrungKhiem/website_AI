// Lưu trữ đơn giản bằng file JSON (data/db.json). Đủ cho 1 người dùng chạy local.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// DATA_DIR=... để chạy thử với thư mục dữ liệu riêng (vd. engine giả) mà không đụng dữ liệu thật
export const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.resolve(import.meta.dirname, '../data');
export const DIRS = {
  sources: path.join(DATA_DIR, 'sources'),
  clips: path.join(DATA_DIR, 'clips'),
  assets: path.join(DATA_DIR, 'assets'),
  outputs: path.join(DATA_DIR, 'outputs'),
  audio: path.join(DATA_DIR, 'audio'),
  merged: path.join(DATA_DIR, 'merged'),
  tmp: path.join(DATA_DIR, 'tmp'),
};
for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });

const DB_FILE = path.join(DATA_DIR, 'db.json');

const DEFAULT_SETTINGS = {
  engine: 'extension', // extension = Flow qua extension trong Chrome thường (bạn bấm nút tạo) | mock = engine giả. (flow = Playwright, không còn dùng)
  flowResolution: '720p', // 360p rẻ hơn 1 nửa credit
  flowProjectUrl: '', // dự án Flow dùng chung, tự tạo lần đầu
  flowAutoAgree: false, // người dùng tự bật: tự bấm "I agree" ở hộp thoại "Rights to use" mỗi lần tải lên
  agentToken: '', // token cho extension (engine "extension"), tự tạo lần đầu (server/agentApi.js)
  aspectRatio: '9:16',
  geminiApiKey: '', // Google AI Studio key để làm sạch tên, trích xuất tính năng và chuẩn hóa giá sản phẩm TMĐT
  geminiModel: 'gemini-2.5-flash',
  productCleanPrompt: '', // prompt tạo lại ảnh sản phẩm sạch; trống = mặc định (server/prompts.js)
  zernioApiKey: '', // API key từ Zernio để kết nối và lên lịch đăng đa nền tảng
  removeWatermark: true, // Tự động xoá logo Gemini / Google Flow khi ghép video
  watermarkMode: 'delogo', // 'delogo' (nội suy xoá) | 'brand' (đè logo riêng) | 'off'
  watermarkType: 'text', // 'text' | 'image'
  watermarkText: '', // ví dụ '@bubine1601' hoặc tên Shop
  watermarkImageId: '', // ID của ảnh logo trong thư viện assets
  watermarkFontSize: 20, // kích thước chữ mặc định
  motionTemplate: '', // trống = dùng prompt mẫu mặc định (server/prompts.js)
  backgroundTemplate: '',
  workflows: {}, // prompt mẫu người dùng đã sửa cho từng quy trình: { dancing: { prompts: { background: '...' } } }
  publicBaseUrl: '', // URL public (ngrok/cloudflared) — Threads cần để tải video
  youtube: { clientId: '', clientSecret: '', refreshToken: '', privacy: 'private' },
  facebook: { pageId: '', pageToken: '' },
  instagram: { igUserId: '', accessToken: '' },
  threads: { userId: '', accessToken: '' },
  tiktok: { accessToken: '', privacy: 'SELF_ONLY' },
  tiktokShop: {
    enabled: false,
    defaultLink: '',
    defaultCta: '🛒 Xem ngay sản phẩm trong giỏ hàng hoặc tại:',
    autoAppendCaption: true,
    postMode: 'draft', // 'draft' | 'direct'
  },
};

const EMPTY = { settings: DEFAULT_SETTINGS, sources: [], clips: [], assets: [], jobs: [], audios: [], merges: [], posts: [], runs: [] };

// Cài đặt của Gemini API cũ (đã bỏ) -> xoá khỏi db.json cũ
const REMOVED_SETTINGS = ['resolution', 'task', 'imageModel', 'concurrency'];

function load() {
  if (!fs.existsSync(DB_FILE)) return structuredClone(EMPTY);
  const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  const settings = deepMerge(structuredClone(DEFAULT_SETTINGS), data.settings || {});
  for (const k of REMOVED_SETTINGS) delete settings[k];
  // Playwright (engine "flow") không còn dùng: cài đặt cũ tự chuyển sang extension
  if (!['mock', 'extension', 'flow'].includes(settings.engine)) settings.engine = 'extension';
  return { ...structuredClone(EMPTY), ...data, settings };
}

function deepMerge(base, extra) {
  for (const [k, v] of Object.entries(extra)) {
    base[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object'
      ? deepMerge(base[k], v)
      : v;
  }
  return base;
}

export const db = load();

let saveTimer = null;
export function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_FILE);
  }, 100);
}

export function updateSettings(patch) {
  deepMerge(db.settings, patch);
  save();
  return db.settings;
}

export const newId = () => crypto.randomBytes(6).toString('hex');

// Đường dẫn file trong data/ -> URL /media/... cho trình duyệt
export function mediaUrl(absPath) {
  if (!absPath) return null;
  return '/media/' + path.relative(DATA_DIR, absPath).split(path.sep).join('/');
}
