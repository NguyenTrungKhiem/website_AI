// Tách ảnh ĐỒ BỘ (1 ảnh có cả áo và quần / váy) thành 2 ảnh sản phẩm riêng: ÁO và QUẦN hoặc VÁY — dùng cho Chuyển động 5 (đồ bộ)
// của tab Nữ "Video thời trang không voice" (cần ảnh áo và ảnh quần / váy riêng, mỗi món mặt trước + mặt sau).
//
// Mỗi lần tách = 1 nhóm (group) gồm các job ảnh Flow (0 credit), chạy lần lượt theo thứ tự tạo:
//   áo – mặt trước, quần / váy – mặt trước (từ ảnh đồ bộ mặt trước);
//   có ảnh đồ bộ MẶT SAU  -> thêm áo – mặt sau, quần / váy – mặt sau (tách từ ảnh mặt sau đó);
//   không có ảnh mặt sau   -> khi ảnh mặt trước của từng món tạo xong, tự tạo job "mặt sau" cho món đó (như nút "AI tạo mặt sau").
// Ảnh kết quả lưu vào thư viện (kind product) kèm asset.split = { group, set, piece: 'top' | 'bottom', view: 'front' | 'back',
// bottomType }. Ảnh mặt trước của món: fromAssetId = ảnh đồ bộ (dùng chung mã sản phẩm của bộ); ảnh mặt sau của món:
// isBackView, fromAssetId = ảnh mặt trước của món đó (quy trình tự tìm thấy làm mặt sau). Giao diện theo dõi asset.split.group
// để tự điền vào ô Áo và ô Quần / Váy.
import fs from 'node:fs';
import path from 'node:path';
import { db, save, DIRS, newId } from './db.js';
import { createJob } from './queue.js';
import { DEFAULT_BACK_VIEW_PROMPT } from './prompts.js';

export const BOTTOM_TYPES = { pants: { vi: 'Quần', en: 'trousers (pants or shorts)' }, skirt: { vi: 'Váy', en: 'skirt' } };
const PIECES = {
  top: { vi: 'Áo', en: () => 'top garment (shirt, blouse, camisole, T-shirt, vest or jacket)', drop: (b) => `the ${BOTTOM_TYPES[b].en}` },
  bottom: { vi: (b) => BOTTOM_TYPES[b].vi, en: (b) => BOTTOM_TYPES[b].en, drop: () => 'the top garment' },
};
const pieceVi = (piece, bottomType) => (piece === 'top' ? PIECES.top.vi : PIECES.bottom.vi(bottomType));

/** Prompt tách 1 món khỏi ảnh đồ bộ. view = 'front' | 'back' (ảnh tham chiếu là mặt trước hay mặt sau của bộ đồ). */
export function splitPrompt({ piece, view, bottomType }) {
  const what = piece === 'top' ? PIECES.top.en() : PIECES.bottom.en(bottomType);
  const drop = PIECES[piece].drop(bottomType);
  return `The reference image shows a matching two-piece outfit${view === 'back' ? ' seen from the BACK' : ''}. Create a clean, photorealistic e-commerce product photo of ONLY its ${what}, ${view === 'back' ? 'BACK view' : 'front view'}.
Keep the exact same garment: same colour, fabric, texture, pattern, print, lace and trims, same neckline, sleeves, waistband, length, hemline and every design detail; do not redesign, simplify or add anything.
Show the whole garment alone, flat and symmetrical as on an invisible mannequin, fully visible from its top edge to its hem, centred with a little space around it, on a plain white background with soft even studio light and a faint shadow.
Remove everything else: ${drop}, any person, body parts, hands, hanger, mannequin, shoes, bag, accessories, props, text and watermarks. One single photo, not a collage.`;
}

/** Tạo nhóm job tách đồ bộ. Trả { group, bottomType, jobs }. */
export function createSplitJobs({ setId, backId = null, bottomType = 'pants' }) {
  const set = db.assets.find((a) => a.id === setId);
  if (!set || !fs.existsSync(set.path)) throw new Error('Chọn ảnh đồ bộ (mặt trước) trước khi tách');
  const back = backId ? db.assets.find((a) => a.id === backId) : null;
  if (backId && (!back || !fs.existsSync(back.path))) throw new Error('Ảnh đồ bộ mặt sau không còn trong thư viện');
  const bt = BOTTOM_TYPES[bottomType] ? bottomType : 'pants';
  const group = newId();
  const jobs = [];
  const add = (piece, view, src) => jobs.push(createJob({
    type: 'image',
    imagePaths: [src.path],
    template: splitPrompt({ piece, view, bottomType: bt }),
    videoLabel: `Tách ${pieceVi(piece, bt).toLowerCase()} (${view === 'back' ? 'mặt sau' : 'mặt trước'}) – ${set.name}`,
    meta: { kind: 'product', split: { group, set: set.id, setBack: back?.id || null, piece, view, bottomType: bt } },
  }));
  // Mặt trước tạo trước: Flow chạy lần lượt nên lúc ảnh mặt sau của 1 món xong thì ảnh mặt trước của món đó đã có
  add('top', 'front', set);
  add('bottom', 'front', set);
  if (back) {
    add('top', 'back', back);
    add('bottom', 'back', back);
  }
  return { group, bottomType: bt, jobs };
}

const baseName = (a) => (a?.name || 'đồ bộ').replace(/ \((Flow|Mặt sau Flow)\)( #\d+)?$/, '').slice(0, 60);

/**
 * Hook khi 1 job tách xong: lưu ảnh kết quả thành ảnh sản phẩm của món đó. Ảnh mặt trước của món: không có ảnh đồ bộ mặt sau thì
 * tự tạo job mặt sau cho món đó. Thử lại / chọn lần tạo khác ra file mới -> lưu thêm ảnh mới (assetFrom chống lưu trùng).
 */
export function onSplitJobSettled(job) {
  const s = job.meta?.split;
  if (job.type !== 'image' || job.status !== 'done' || !s || !job.outputPath) return;
  if (job.meta.assetFrom === job.outputPath) return; // đã lưu rồi
  const set = db.assets.find((x) => x.id === s.set);
  const id = newId();
  const dest = path.join(DIRS.assets, id + path.extname(job.outputPath));
  fs.copyFileSync(job.outputPath, dest);
  const isBack = s.view === 'back';
  // Ảnh mặt trước của cùng món trong nhóm (để ảnh mặt sau trỏ về)
  const frontOf = () => db.assets.find((x) => x.split?.group === s.group && x.split.piece === s.piece && x.split.view === 'front');
  const front = isBack ? frontOf() : null;
  const flowTitle = job.attempts.find((a) => a.outputPath === job.outputPath)?.flowTitle || null;
  const asset = {
    id,
    kind: 'product',
    name: `${pieceVi(s.piece, s.bottomType)} – ${baseName(set)}${isBack ? ' (Mặt sau Flow)' : ' (tách)'}`,
    path: dest,
    createdAt: Date.now(),
    fromJobId: job.id,
    fromAssetId: isBack ? front?.id || null : s.set,
    staging: false,
    isBackView: isBack,
    flowTitle,
    product: set?.product ? structuredClone(set.product) : undefined,
    split: { group: s.group, set: s.set, piece: s.piece, view: s.view, bottomType: s.bottomType },
  };
  db.assets.unshift(asset);
  if (!isBack) {
    // Ảnh mặt sau của món này xong trước (vd. mặt trước phải thử lại): gắn lại cho trỏ về ảnh mặt trước vừa có
    for (const b of db.assets) if (b.split?.group === s.group && b.split.piece === s.piece && b.split.view === 'back' && !b.fromAssetId) b.fromAssetId = id;
    // Không có ảnh đồ bộ mặt sau -> AI tạo mặt sau cho món này từ ảnh mặt trước vừa tách (hook ảnh mặt sau có sẵn sẽ lưu kết quả)
    if (!s.setBack && !db.jobs.some((j) => j.meta?.splitBackFor === job.id)) {
      createJob({
        type: 'image',
        imagePaths: [dest],
        template: DEFAULT_BACK_VIEW_PROMPT,
        videoLabel: `Mặt sau – ${asset.name}`,
        meta: { backOf: id, kind: 'product', splitBackFor: job.id, splitGroup: s.group },
      });
    }
  }
  job.meta.assetId = id;
  job.meta.assetFrom = job.outputPath;
  save();
}
