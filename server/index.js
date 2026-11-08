import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { db, save, DIRS, DATA_DIR, newId, mediaUrl, updateSettings } from './db.js';
import { probe, cutClip, thumbnail, splitRanges, extractAudio, filmstrip, removeWatermarkVideo, cropImage } from './ffmpeg.js';
import { createJob, createImportJob, retryJob, recoverJobs, pump, settledHooks, applyFlowVideoToJob } from './queue.js';
import { publish } from './social.js';
import * as zernio from './zernio.js';
import * as flow from './flow.js';
import * as shopee from './shopee.js';
import * as productScraper from './productScraper.js';
import { DEFAULT_MOTION_TEMPLATE, DEFAULT_BACKGROUND_TEMPLATE, DEFAULT_PRODUCT_CLEAN_PROMPT, DEFAULT_BACK_VIEW_PROMPT } from './prompts.js';
import { analyzeFashionGarment, generateFashionScenePrompts, DEFAULT_FASHION_SCENE1_TEMPLATE, DEFAULT_FASHION_SCENE2_TEMPLATE, DEFAULT_FASHION_AODAI_SCENE1_TEMPLATE, DEFAULT_FASHION_AODAI_SCENE2_TEMPLATE } from './geminiFashion.js';
import { createMerge, rangeOf } from './merge.js';
import { listWorkflows } from './workflows/index.js';
import { setWorkflowPrompts, listPromptVersions, rollbackPrompt, currentPrompt } from './promptVersions.js';
import { assignCode, codeOfAsset, normalizeCode, isValidCode, listCodes, exportText, importText } from './productCodes.js';
import { createRun, resumeRun, cancelRun, deleteRun, advanceAll, viewRun, replaceClipVideos, touchJob, importFlowVideoToRun, resyncRun } from './workflows/runner.js';
import { buildProductRows, saveRunProducts, buildWorkbook, exportFilename, frameSizeOf, suggestProductCode, runHasProducts, productInputsOf } from './productExport.js';

const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_CLIP = 10; // Omni Flash chỉ nhận video đầu vào tối đa 10 giây

const app = express();
app.use(express.json({ limit: '20mb' })); // PUT /api/runs/:id/products gửi kèm PNG khung mã (data URL) của từng ảnh
app.use('/media', express.static(DATA_DIR));

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, DIRS.tmp),
    filename: (req, file, cb) => {
      let ext = path.extname(file.originalname).toLowerCase();
      if (['.jfif', '.jif', '.jpe'].includes(ext)) ext = '.jpg';
      cb(null, newId() + ext);
    },
  }),
  limits: { fileSize: 2 * 1024 ** 3 },
});

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => res.status(400).json({ error: e.message }));

const rm = (f) => f && fs.rm(f, { force: true }, () => {});

// Đảm bảo các ảnh mặt sau đã render không bị ẩn staging
for (const a of db.assets) {
  if (a.isBackView || a.name?.includes('Mặt sau Flow')) {
    a.staging = false;
  }
}

// ---------- Trạng thái tổng ----------
const viewJob = (j) => ({
  ...j,
  range: rangeOf(j),
  videoUrl: mediaUrl(j.videoPath),
  imageUrls: (j.imagePaths || []).map(mediaUrl),
  outputUrl: mediaUrl(j.outputPath),
  thumbUrl: mediaUrl(j.thumbPath),
  attempts: j.attempts.map((a) => ({ ...a, outputUrl: mediaUrl(a.outputPath), thumbUrl: mediaUrl(a.thumbPath) })),
});

app.get('/api/state', (req, res) => {
  res.json({
    settings: db.settings,
    defaults: {
      motionTemplate: DEFAULT_MOTION_TEMPLATE,
      backgroundTemplate: DEFAULT_BACKGROUND_TEMPLATE,
      productCleanPrompt: DEFAULT_PRODUCT_CLEAN_PROMPT,
      backViewPrompt: DEFAULT_BACK_VIEW_PROMPT,
    },
    sources: db.sources.map((s) => ({
      ...s,
      url: mediaUrl(s.path),
      thumbUrl: mediaUrl(s.thumbPath),
      filmstrip: s.filmstrip && { ...s.filmstrip, url: mediaUrl(s.filmstrip.path) },
    })),
    clips: db.clips.map((c) => ({ ...c, url: mediaUrl(c.path), thumbUrl: mediaUrl(c.thumbPath) })),
    assets: db.assets.map((a) => ({ ...a, url: mediaUrl(a.path) })),
    jobs: db.jobs.map(viewJob),
    audios: db.audios.map((a) => ({ ...a, url: mediaUrl(a.path) })),
    merges: db.merges.map((m) => ({ ...m, url: mediaUrl(m.outputPath), thumbUrl: mediaUrl(m.thumbPath) })),
    runs: db.runs.map(viewRun),
    workflows: listWorkflows(),
    posts: db.posts,
  });
});

app.put('/api/settings', wrap(async (req, res) => {
  const patch = { ...(req.body || {}) };
  // Prompt gốc của quy trình: thay cả bản trong hệ thống, bản cũ được lưu ra file phiên bản (xem promptVersions.js).
  // `prompts` gửi lên là toàn bộ các bước đã sửa (thiếu / rỗng = về mặc định) nên không deep-merge như cài đặt khác.
  if (patch.workflows && typeof patch.workflows === 'object') {
    const rest = {};
    for (const [wfId, w] of Object.entries(patch.workflows)) {
      if (w && typeof w === 'object' && 'prompts' in w) {
        setWorkflowPrompts(wfId, w.prompts || {});
        const { prompts, ...other } = w;
        if (Object.keys(other).length) rest[wfId] = other;
      } else rest[wfId] = w;
    }
    if (Object.keys(rest).length) patch.workflows = rest;
    else delete patch.workflows;
  }
  const s = updateSettings(patch);
  pump();
  res.json(s);
}));
// Lịch sử prompt gốc của 1 bước + quay lại phiên bản cũ
app.get('/api/workflows/:id/prompts/:key/versions', wrap(async (req, res) => {
  res.json({ versions: listPromptVersions(req.params.id, req.params.key), current: currentPrompt(req.params.id, req.params.key) });
}));
app.post('/api/workflows/:id/prompts/:key/rollback', wrap(async (req, res) => {
  const text = rollbackPrompt(req.params.id, req.params.key, String(req.body?.file || ''));
  res.json({ text, versions: listPromptVersions(req.params.id, req.params.key) });
}));

// ---------- Google Flow (Playwright) ----------
app.get('/api/flow/status', wrap(async (req, res) => res.json(await flow.status())));
app.post('/api/flow/launch', wrap(async (req, res) => res.json(await flow.launchChrome())));
app.post('/api/flow/preset', wrap(async (req, res) => res.json(await flow.preset(req.body))));

// ---------- Video gốc + cắt ----------
app.post('/api/sources', upload.single('file'), wrap(async (req, res) => {
  const id = newId();
  const dest = path.join(DIRS.sources, id + path.extname(req.file.filename));
  fs.renameSync(req.file.path, dest);
  const meta = await probe(dest);
  const thumbPath = path.join(DIRS.sources, id + '.jpg');
  await thumbnail(dest, thumbPath, Math.min(1, meta.duration / 2)).catch(() => {});
  const src = { id, name: req.file.originalname, path: dest, thumbPath, ...meta, createdAt: Date.now() };
  db.sources.unshift(src);
  await makeFilmstrip(src);
  // Tự tách âm thanh ngay khi tải lên để dùng lại lúc ghép video
  if (meta.hasAudio) await extractSourceAudio(src).catch((e) => console.error('Tách âm thanh lỗi:', e.message));
  save();
  res.json(src);
}));

async function makeFilmstrip(src) {
  try {
    const file = path.join(DIRS.sources, `${src.id}-strip.jpg`);
    src.filmstrip = { path: file, ...(await filmstrip(src.path, file, src)) };
    save();
  } catch (e) {
    console.error('Tạo filmstrip lỗi:', e.message);
  }
}

// Video gốc tải lên từ bản cũ: bổ sung fps + filmstrip cho timeline
async function backfillSources() {
  for (const src of db.sources) {
    if (!fs.existsSync(src.path)) continue;
    if (!src.fps) Object.assign(src, await probe(src.path));
    if (!src.filmstrip) await makeFilmstrip(src);
  }
  save();
}

async function extractSourceAudio(src) {
  const id = newId();
  const file = path.join(DIRS.audio, `${id}.m4a`);
  await extractAudio(src.path, file);
  const { duration } = await probe(file);
  const audio = { id, sourceId: src.id, name: `${path.parse(src.name).name} (âm thanh gốc)`, path: file, duration, createdAt: Date.now() };
  db.audios.unshift(audio);
  save();
  return audio;
}

app.post('/api/sources/:id/extract-audio', wrap(async (req, res) => {
  const src = db.sources.find((s) => s.id === req.params.id);
  if (!src) throw new Error('Không tìm thấy video gốc');
  if (!src.hasAudio && !(await probe(src.path)).hasAudio) throw new Error('Video gốc không có âm thanh');
  res.json(await extractSourceAudio(src));
}));

// ---------- Âm thanh: đã tách hoặc tải lên (nhạc ngoài, sau này là nhạc Suno) ----------
app.post('/api/audios', upload.single('file'), wrap(async (req, res) => {
  const id = newId();
  const dest = path.join(DIRS.audio, id + path.extname(req.file.filename));
  fs.renameSync(req.file.path, dest);
  const meta = await probe(dest);
  if (!meta.hasAudio) { rm(dest); throw new Error('File không có âm thanh'); }
  const audio = { id, sourceId: null, name: req.file.originalname, path: dest, duration: meta.duration, createdAt: Date.now() };
  db.audios.unshift(audio);
  save();
  res.json(audio);
}));

app.delete('/api/audios/:id', (req, res) => {
  const a = db.audios.find((x) => x.id === req.params.id);
  if (a) {
    rm(a.path);
    db.audios = db.audios.filter((x) => x !== a);
    save();
  }
  res.json({ ok: true });
});

app.delete('/api/sources/:id', (req, res) => {
  const src = db.sources.find((s) => s.id === req.params.id);
  if (src) {
    rm(src.path); rm(src.thumbPath); rm(src.filmstrip?.path);
    db.sources = db.sources.filter((s) => s !== src);
    save();
  }
  res.json({ ok: true });
});

// body: { segment: 8 } để chia đều, hoặc { ranges: [[0, 5.5], [7, 12]] } để cắt tay
app.post('/api/sources/:id/cut', wrap(async (req, res) => {
  const src = db.sources.find((s) => s.id === req.params.id);
  if (!src) throw new Error('Không tìm thấy video gốc');
  const { segment, ranges: manual, mute = true } = req.body;
  // Không chỉ định -> chia theo "Thời lượng video" trong Cài đặt (video-to-video ra dài đúng bằng đoạn cắt)
  const defaultSeg = Math.min(MAX_CLIP, parseFloat(db.settings.flowDuration) || 10);
  let ranges = manual?.length ? manual.map(([a, b]) => [Number(a), Number(b)]) : splitRanges(src.duration, Number(segment) || defaultSeg);
  for (const [a, b] of ranges) {
    if (!(b > a) || a < 0 || b > src.duration + 0.1) throw new Error(`Đoạn ${a}–${b}s không hợp lệ`);
    if (b - a > MAX_CLIP + 0.01) throw new Error(`Đoạn ${a}–${b}s dài hơn ${MAX_CLIP}s (giới hạn của Omni Flash)`);
  }
  const existing = db.clips.filter((c) => c.sourceId === src.id).length;
  const created = [];
  for (const [i, [a, b]] of ranges.entries()) {
    const id = newId();
    const file = path.join(DIRS.clips, `${id}.mp4`);
    await cutClip(src.path, file, a, b, { mute, fps: src.fps || 30 });
    const thumbPath = path.join(DIRS.clips, `${id}.jpg`);
    await thumbnail(file, thumbPath, Math.min(0.5, (b - a) / 2)).catch(() => {});
    created.push({
      id, sourceId: src.id, name: `${path.parse(src.name).name} #${existing + i + 1}`,
      start: a, end: b, muted: mute, path: file, thumbPath, createdAt: Date.now(),
    });
  }
  db.clips.unshift(...created.reverse());
  save();
  res.json(created);
}));

app.delete('/api/clips/:id', (req, res) => {
  const c = db.clips.find((x) => x.id === req.params.id);
  if (c) {
    rm(c.path); rm(c.thumbPath);
    db.clips = db.clips.filter((x) => x !== c);
    save();
  }
  res.json({ ok: true });
});

// ---------- Ảnh: model / sản phẩm / bối cảnh ----------
app.post('/api/assets', upload.single('file'), wrap(async (req, res) => {
  const kind = req.body.kind;
  if (!['model', 'product', 'background', 'logo'].includes(kind)) throw new Error('kind không hợp lệ');
  const id = newId();
  let ext = path.extname(req.file.filename).toLowerCase();
  if (['.jfif', '.jif', '.jpe'].includes(ext)) ext = '.jpg';
  const dest = path.join(DIRS.assets, id + ext);
  fs.renameSync(req.file.path, dest);
  const a = { id, kind, name: req.file.originalname, path: dest, createdAt: Date.now() };
  db.assets.unshift(a);
  save();
  res.json({ ...a, url: mediaUrl(dest) });
}));

// Tạo lại ảnh "sạch" từ 1 ảnh trong thư viện (bỏ người/vật thể, chỉ giữ sản phẩm) bằng job sinh ảnh trên Flow.
// Khi job xong, ảnh kết quả được tự lưu thành ảnh mới cùng loại (xem hook bên dưới).
app.post('/api/assets/:id/clean', wrap(async (req, res) => {
  const a = db.assets.find((x) => x.id === req.params.id);
  if (!a) throw new Error('Không tìm thấy ảnh');
  const prompt = (req.body?.prompt || '').trim() || db.settings.productCleanPrompt || DEFAULT_PRODUCT_CLEAN_PROMPT;
  const job = createJob({
    type: 'image',
    imagePaths: [a.path],
    template: prompt,
    videoLabel: `Ảnh sạch – ${a.name}`,
    meta: { cleanOf: a.id, kind: a.kind },
  });
  res.json(viewJob(job));
}));

// Tạo ảnh mặt sau của trang phục dựa trên ảnh mặt trước bằng Flow
app.post('/api/assets/:id/render-back', wrap(async (req, res) => {
  const a = db.assets.find((x) => x.id === req.params.id);
  if (!a) throw new Error('Không tìm thấy ảnh');
  const prompt = (req.body?.prompt || '').trim() || DEFAULT_BACK_VIEW_PROMPT;
  const job = createJob({
    type: 'image',
    imagePaths: [a.path],
    template: prompt,
    videoLabel: `Mặt sau – ${a.name}`,
    meta: { backOf: a.id, kind: 'product' },
  });
  res.json(viewJob(job));
}));

// Phân tích ảnh mặt trước & mặt sau bằng Gemini -> sinh Mô tả sản phẩm & 2 Prompt cho 2 Phân cảnh
app.post('/api/fashion/analyze-and-prompt', wrap(async (req, res) => {
  const { frontAssetId, backAssetId, basePromptScene1, basePromptScene2, caseMode } = req.body || {};
  const isAoDai = caseMode === 'case3'; // TH3 Áo dài: prompt gốc riêng
  if (!frontAssetId) throw new Error('Chưa chọn ảnh trang phục mặt trước');
  if (!backAssetId) throw new Error('Chưa chọn ảnh trang phục mặt sau');

  const frontAsset = db.assets.find((a) => a.id === frontAssetId);
  const backAsset = db.assets.find((a) => a.id === backAssetId);
  if (!frontAsset?.path || !fs.existsSync(frontAsset.path)) throw new Error('File ảnh mặt trước không tồn tại');
  if (!backAsset?.path || !fs.existsSync(backAsset.path)) throw new Error('File ảnh mặt sau không tồn tại');

  const apiKey = db.settings.geminiApiKey || process.env.GEMINI_API_KEY || '';
  if (!apiKey) throw new Error('Chưa cấu hình Gemini API Key trong Cài đặt');
  const model = db.settings.geminiModel || 'gemini-2.5-flash';

  // Bước 1: Phân tích 2 ảnh
  const productData = await analyzeFashionGarment({
    frontPath: frontAsset.path,
    backPath: backAsset.path,
    apiKey,
    model,
  });

  // Bước 2: Chỉ viết lại lời thoại Voice của 2 prompt gốc (phần tiếng Anh giữ nguyên) cho khớp sản phẩm
  const savedPrompts = db.settings?.workflows?.['video-thoi-trang']?.prompts || {};
  const scenePrompts = await generateFashionScenePrompts({
    productData,
    basePromptScene1: (basePromptScene1 || '').trim() || (isAoDai ? savedPrompts.case3_scene1 || DEFAULT_FASHION_AODAI_SCENE1_TEMPLATE : savedPrompts.case2_scene1 || DEFAULT_FASHION_SCENE1_TEMPLATE),
    basePromptScene2: (basePromptScene2 || '').trim() || (isAoDai ? savedPrompts.case3_scene2 || DEFAULT_FASHION_AODAI_SCENE2_TEMPLATE : savedPrompts.case2_scene2 || DEFAULT_FASHION_SCENE2_TEMPLATE),
    apiKey,
    model,
  });

  res.json({
    ok: true,
    productData,
    productDescription: productData.summary || '',
    promptScene1: scenePrompts.promptScene1 || '',
    promptScene2: scenePrompts.promptScene2 || '',
    voices: scenePrompts.voices,
  });
}));

// Cắt một vùng chữ nhật từ ảnh nguồn bằng FFmpeg và lưu thành asset mới
app.post('/api/assets/crop', wrap(async (req, res) => {
  const { assetId, x = 0, y = 0, width, height, name, kind = 'product' } = req.body || {};
  const src = db.assets.find((a) => a.id === assetId);
  if (!src || !fs.existsSync(src.path)) throw new Error('Không tìm thấy ảnh gốc để cắt');
  const w = Math.round(Number(width));
  const h = Math.round(Number(height));
  if (!w || !h || w <= 0 || h <= 0) throw new Error('Kích thước vùng cắt không hợp lệ');

  const id = newId();
  const dest = path.join(DIRS.assets, `${id}.png`);
  await cropImage(src.path, dest, { x, y, width: w, height: h });

  const newAsset = {
    id,
    kind,
    name: name?.trim() || `${src.name} (cắt)`,
    path: dest,
    createdAt: Date.now(),
    fromAssetId: src.id,
  };
  db.assets.unshift(newAsset);
  save();
  res.json({ ...newAsset, url: mediaUrl(dest) });
}));

settledHooks.push((job) => {
  if (job.type !== 'image' || job.status !== 'done' || (!job.meta?.cleanOf && !job.meta?.backOf) || !job.outputPath) return;
  const refId = job.meta.cleanOf || job.meta.backOf;
  if (job.meta.assetFrom === job.outputPath) return; // đã lưu rồi
  const src = db.assets.find((x) => x.id === refId);
  const id = newId();
  const dest = path.join(DIRS.assets, id + path.extname(job.outputPath));
  fs.copyFileSync(job.outputPath, dest);
  const isBack = !!job.meta.backOf;
  const base = (src?.name || 'ảnh').replace(/ \((Flow|Mặt sau Flow)\)( #\d+)?$/, '');
  const n = db.assets.filter((x) => x.fromAssetId === refId).length + 1;
  const flowTitle = job.attempts.find((a) => a.outputPath === job.outputPath)?.flowTitle || null;
  const suffix = isBack ? ' (Mặt sau Flow)' : ' (Flow)';
  // product = metadata sản phẩm (tên, giá, link Shopee…) đi theo ảnh gốc -> ảnh làm sạch / mặt sau vẫn xuất Excel được cho DiamondShop
  const product = src?.product ? structuredClone(src.product) : undefined;
  db.assets.unshift({
    id,
    kind: job.meta.kind || 'product',
    name: `${base}${suffix}${n > 1 ? ` #${n}` : ''}`,
    path: dest,
    createdAt: Date.now(),
    fromJobId: job.id,
    fromAssetId: refId,
    staging: isBack ? false : true,
    isBackView: isBack,
    flowTitle,
    product,
  });
  job.meta.assetId = id;
  job.meta.assetFrom = job.outputPath;
  save();
});

// Dùng 1 ảnh nháp (bóc tách / kết quả làm sạch) -> đưa vào thư viện
app.post('/api/assets/:id/use', wrap(async (req, res) => {
  const a = db.assets.find((x) => x.id === req.params.id);
  if (!a) throw new Error('Không tìm thấy ảnh');
  a.staging = false;
  save();
  res.json({ ...a, url: mediaUrl(a.path) });
}));

// ---------- Mã sản phẩm (in lên video thời trang thay "TODAY'S OUTFIT") ----------
// Cấp mã cho ảnh (tự động, dùng lại mã của ảnh gốc nếu là ảnh sạch/cắt/mặt sau) hoặc đổi sang mã gõ tay
app.post('/api/assets/:id/code', wrap(async (req, res) => {
  const a = assignCode(req.params.id, req.body?.code);
  res.json({ ...a, url: mediaUrl(a.path) });
}));
app.get('/api/codes', (req, res) => res.json(listCodes()));
// Xuất mọi mã đã dùng ra file .txt (cách nhau dấu ",") để máy khác nhập vào, tránh cấp trùng
app.get('/api/codes/export', (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="ma-san-pham.txt"');
  res.send(exportText());
});
app.post('/api/codes/import', wrap(async (req, res) => res.json(importText(req.body?.text || ''))));

// Sao chép 1 ảnh sang loại khác (vd. ảnh kết quả "lookbook" -> ảnh model để dùng cho quy trình video)
app.post('/api/assets/:id/copy', wrap(async (req, res) => {
  const a = db.assets.find((x) => x.id === req.params.id);
  if (!a) throw new Error('Không tìm thấy ảnh');
  const kind = req.body?.kind;
  if (!['model', 'product', 'background'].includes(kind)) throw new Error('kind không hợp lệ');
  const id = newId();
  const dest = path.join(DIRS.assets, id + path.extname(a.path));
  fs.copyFileSync(a.path, dest);
  // Giữ metadata sản phẩm (nếu có) để ảnh sao chép vẫn mang tên / giá / link Shopee
  const copy = { id, kind, name: a.name, path: dest, createdAt: Date.now(), fromAssetId: a.id, flowTitle: a.flowTitle || null, product: a.product ? structuredClone(a.product) : undefined };
  db.assets.unshift(copy);
  save();
  res.json({ ...copy, url: mediaUrl(dest) });
}));

app.delete('/api/assets/:id', (req, res) => {
  const a = db.assets.find((x) => x.id === req.params.id);
  if (a) {
    rm(a.path);
    db.assets = db.assets.filter((x) => x !== a);
    save();
  }
  res.json({ ok: true });
});

// ---------- Dữ liệu & Ảnh sản phẩm từ link sàn TMĐT (Shopee, Lazada, TikTok Shop) ----------
app.post('/api/product/fetch', wrap(async (req, res) => res.json(await productScraper.fetchProduct(req.body?.url || ''))));
// product = kết quả bóc tách (found) của sản phẩm chứa các ảnh -> lưu vào asset.product (tên, giá, mô tả, link, shopId/itemId)
app.post('/api/product/import', wrap(async (req, res) => {
  const { kind = 'product', images = [], staging = false, product = null } = req.body || {};
  if (!['model', 'product', 'background'].includes(kind)) throw new Error('kind không hợp lệ');
  if (!images.length) throw new Error('Chưa chọn ảnh');
  res.json(await productScraper.importImages(kind, images, { staging: !!staging, product }));
}));
// Tương thích ngược với các gọi cũ
app.post('/api/shopee/product', wrap(async (req, res) => res.json(await productScraper.fetchProduct(req.body?.url || ''))));
app.post('/api/shopee/import', wrap(async (req, res) => {
  const { kind = 'product', images = [], product = null } = req.body || {};
  if (!['model', 'product', 'background'].includes(kind)) throw new Error('kind không hợp lệ');
  if (!images.length) throw new Error('Chưa chọn ảnh');
  res.json(await productScraper.importImages(kind, images, { product }));
}));
// Gợi ý mã sản phẩm từ tên theo sổ mã chung (VAY_01…); taken = các mã đang đặt trên giao diện để không gợi ý trùng
app.get('/api/products/suggest-code', wrap(async (req, res) => {
  const taken = new Set(String(req.query.taken || '').split(',').map((s) => normalizeCode(s)).filter(Boolean));
  res.json({ code: suggestProductCode(String(req.query.title || ''), { taken }) });
}));

// ---------- Job tạo video ----------
// Motion control: 1 job cho mỗi clip được chọn (xử lý hàng loạt)
app.post('/api/jobs/motion', wrap(async (req, res) => {
  const { clipIds = [], modelAssetId, productAssetId, prompt = '', rawPrompt } = req.body;
  if (!clipIds.length) throw new Error('Chọn ít nhất 1 đoạn video');
  if (!modelAssetId && !productAssetId && !prompt) throw new Error('Cần ảnh model, ảnh sản phẩm hoặc prompt');
  const clips = clipIds.map((cid) => db.clips.find((c) => c.id === cid));
  if (clips.includes(undefined)) throw new Error('Có clip không còn tồn tại, tải lại trang');
  const batchId = newId();
  const jobs = clips.map((clip) => {
    return createJob({
      type: 'motion', batchId, videoPath: clip.path, videoLabel: clip.name, prompt, rawPrompt,
      sourceRange: { sourceId: clip.sourceId, start: clip.start, end: clip.end },
      assets: { model: modelAssetId || null, product: productAssetId || null },
    });
  });
  res.json(jobs.map(viewJob));
}));

// Thay bối cảnh: đầu vào là video kết quả của job motion control
app.post('/api/jobs/background', wrap(async (req, res) => {
  const { jobIds = [], backgroundAssetId, prompt = '', rawPrompt } = req.body;
  if (!jobIds.length) throw new Error('Chọn ít nhất 1 video đã tạo');
  if (!backgroundAssetId && !prompt) throw new Error('Cần ảnh bối cảnh hoặc prompt');
  const parents = jobIds.map((jid) => db.jobs.find((j) => j.id === jid));
  if (parents.some((p) => !p?.outputPath)) throw new Error('Có video chưa tạo xong hoặc đã bị xoá');
  const batchId = newId();
  const jobs = parents.map((parent) => {
    return createJob({
      type: 'background', batchId, parentJobId: parent.id, videoPath: parent.outputPath,
      sourceRange: rangeOf(parent),
      videoLabel: parent.videoLabel, prompt, rawPrompt, assets: { background: backgroundAssetId || null },
    });
  });
  res.json(jobs.map(viewJob));
}));

// Nhập video từ máy (nhiều file). clipId (tuỳ chọn) = đoạn gốc tương ứng để khớp âm thanh khi ghép;
// nhiều file + clipId thì file sau ứng với các đoạn kế tiếp của cùng video gốc.
app.post('/api/jobs/import', upload.array('files', 50), wrap(async (req, res) => {
  if (!req.files?.length) throw new Error('Chưa chọn file');
  const first = req.body.clipId ? db.clips.find((c) => c.id === req.body.clipId) : null;
  const siblings = first ? db.clips.filter((c) => c.sourceId === first.sourceId).sort((a, b) => a.start - b.start) : [];
  const startIdx = first ? siblings.indexOf(first) : -1;
  const jobs = [];
  for (const [i, f] of req.files.entries()) {
    const clip = startIdx >= 0 ? siblings[startIdx + i] : null;
    jobs.push(await createImportJob({
      file: f.path,
      name: f.originalname,
      sourceRange: clip ? { sourceId: clip.sourceId, start: clip.start, end: clip.end } : null,
      videoLabel: clip ? `${clip.name} (nhập từ máy)` : f.originalname,
    }));
  }
  res.json(jobs.map(viewJob));
}));

// Gán / bỏ gán đoạn gốc cho 1 video (để chế độ "khớp từng đoạn" khi ghép)
app.patch('/api/jobs/:id/range', wrap(async (req, res) => {
  const job = db.jobs.find((j) => j.id === req.params.id);
  if (!job) throw new Error('Không tìm thấy video');
  const clip = req.body.clipId ? db.clips.find((c) => c.id === req.body.clipId) : null;
  if (req.body.clipId && !clip) throw new Error('Không tìm thấy đoạn gốc');
  job.sourceRange = clip ? { sourceId: clip.sourceId, start: clip.start, end: clip.end } : null;
  if (clip && job.type === 'import') job.videoLabel = `${clip.name} (nhập từ máy)`;
  save();
  res.json(viewJob(job));
}));

app.post('/api/jobs/:id/retry', wrap(async (req, res) => {
  const job = db.jobs.find((j) => j.id === req.params.id);
  if (!job) throw new Error('Không tìm thấy job');
  res.json(viewJob(retryJob(job, req.body || {})));
}));

// Tải video mới nhất từ Flow về và gán hoàn thành cho job
app.post('/api/jobs/:id/import-flow', wrap(async (req, res) => {
  const job = db.jobs.find((j) => j.id === req.params.id);
  if (!job) throw new Error('Không tìm thấy job');
  const updated = await applyFlowVideoToJob(job);
  res.json(viewJob(updated));
}));

// Chọn 1 trong các lần tạo làm kết quả chính của job
app.post('/api/jobs/:id/select', wrap(async (req, res) => {
  const job = db.jobs.find((j) => j.id === req.params.id);
  const a = job?.attempts.find((x) => x.n === Number(req.body.n));
  if (!a?.outputPath) throw new Error('Lần tạo này không có video');
  job.outputPath = a.outputPath;
  job.thumbPath = a.thumbPath;
  save();
  touchJob(job.id); // thuộc quy trình -> làm lại bước sau với kết quả mới chọn
  res.json(viewJob(job));
}));

// Xoá 1 lần tạo; nếu đó là kết quả đang chọn thì chuyển sang lần tạo thành công gần nhất còn lại
app.delete('/api/jobs/:id/attempts/:n', wrap(async (req, res) => {
  const job = db.jobs.find((j) => j.id === req.params.id);
  const a = job?.attempts.find((x) => x.n === Number(req.params.n));
  if (!a) throw new Error('Không tìm thấy lần tạo này');
  if (a.status === 'running') throw new Error('Lần tạo này đang chạy');
  rm(a.outputPath); rm(a.thumbPath);
  job.attempts = job.attempts.filter((x) => x !== a);
  if (job.outputPath === a.outputPath) {
    const keep = job.attempts.filter((x) => x.outputPath).at(-1);
    job.outputPath = keep?.outputPath || null;
    job.thumbPath = keep?.thumbPath || null;
    if (!keep && job.status === 'done') Object.assign(job, { status: 'failed', error: 'Đã xoá hết kết quả — bấm Thử lại để tạo mới.' });
  }
  save();
  touchJob(job.id);
  res.json(viewJob(job));
}));

app.delete('/api/jobs/:id', wrap(async (req, res) => {
  const job = db.jobs.find((j) => j.id === req.params.id);
  if (job?.status === 'running') throw new Error('Job đang chạy, chờ xong rồi xoá');
  if (job) {
    for (const a of job.attempts) { rm(a.outputPath); rm(a.thumbPath); }
    db.jobs = db.jobs.filter((j) => j !== job);
    save();
  }
  res.json({ ok: true });
}));

// ---------- Ghép video + chèn âm thanh (logic trong merge.js) ----------
app.post('/api/merges', wrap(async (req, res) => {
  const { jobIds = [], audioId = null, audioMode = 'match', offset = 0, name, removeWatermark, watermarkMode, watermarkText, watermarkImageId, keepOriginalAudio = true } = req.body;
  res.json(createMerge({ jobIds, audioId, audioMode, offset, name, removeWatermark, watermarkMode, watermarkText, watermarkImageId, keepOriginalAudio }));
}));

app.post('/api/merges/:id/delogo', wrap(async (req, res) => {
  const m = db.merges.find((x) => x.id === req.params.id);
  if (!m) throw new Error('Không tìm thấy video ghép');
  if (m.status !== 'done' || !fs.existsSync(m.outputPath)) throw new Error('Video chưa ghép xong hoặc file không còn');

  const tmpOut = m.outputPath.replace(/\.mp4$/, '-delogo.mp4');
  let watermarkImagePath = null;
  if (db.settings.watermarkImageId) {
    const asset = db.assets.find((a) => a.id === db.settings.watermarkImageId);
    if (asset?.path && fs.existsSync(asset.path)) watermarkImagePath = asset.path;
  }
  await removeWatermarkVideo(m.outputPath, tmpOut, {
    watermarkMode: db.settings.watermarkMode || 'delogo',
    watermarkText: db.settings.watermarkText || '',
    watermarkImagePath,
    watermarkFontSize: db.settings.watermarkFontSize || 20,
  });
  fs.renameSync(tmpOut, m.outputPath);
  m.watermarkRemoved = true;
  m.watermarkMode = db.settings.watermarkMode || 'delogo';
  save();
  res.json({ ok: true, merge: m });
}));

app.delete('/api/merges/:id', wrap(async (req, res) => {
  const m = db.merges.find((x) => x.id === req.params.id);
  if (m?.status === 'running') throw new Error('Đang ghép, chờ xong rồi xoá');
  if (m) {
    rm(m.outputPath); rm(m.thumbPath);
    db.merges = db.merges.filter((x) => x !== m);
    save();
  }
  res.json({ ok: true });
}));

// ---------- Quy trình tự động (AI Dancing…) — xem server/workflows ----------
const findRun = (id) => {
  const r = db.runs.find((x) => x.id === id);
  if (!r) throw new Error('Không tìm thấy quy trình');
  return r;
};
app.get('/api/workflows', (req, res) => res.json(listWorkflows()));
app.post('/api/runs', wrap(async (req, res) => {
  const body = req.body || {};
  // Video thời trang: cần mã sản phẩm để in lên video (thay "TODAY'S OUTFIT"); thiếu thì lấy/cấp theo ảnh mặt trước
  if (body.workflowId === 'video-thoi-trang') {
    const o = (body.options ||= {});
    let code = normalizeCode(o.productCode || '');
    const frontId = body.inputs?.outfitFront;
    if (!code && frontId) code = codeOfAsset(frontId) || assignCode(frontId).productCode;
    if (!isValidCode(code)) throw new Error('Chưa có mã sản phẩm hợp lệ để in lên video (dạng LOAI_SO, vd. VAY_01)');
    if (frontId && codeOfAsset(frontId) !== code) assignCode(frontId, code); // người dùng sửa mã trong ô -> lưu lên ảnh
    o.productCode = code;
  }
  res.json(viewRun(createRun(body)));
}));
app.post('/api/runs/:id/resume', wrap(async (req, res) => res.json(viewRun(resumeRun(findRun(req.params.id))))));
app.post('/api/runs/:id/cancel', wrap(async (req, res) => res.json(viewRun(cancelRun(findRun(req.params.id))))));
// Thay video motion của đoạn clipId (và các đoạn kế tiếp nếu nhiều file) bằng video nhập từ máy
app.post('/api/runs/:id/replace', upload.array('files', 50), wrap(async (req, res) => {
  if (!req.files?.length) throw new Error('Chưa chọn file');
  const run = findRun(req.params.id);
  const replaced = await replaceClipVideos(run, req.body.clipId, req.files);
  res.json({ replaced, run: viewRun(run) });
}));

// Tải video mới nhất từ Google Flow về cho quy trình (để tiếp tục bước tiếp theo)
app.post('/api/runs/:id/import-flow', wrap(async (req, res) => {
  const run = findRun(req.params.id);
  const result = await importFlowVideoToRun(run, req.body || {});
  res.json({ ok: true, run: viewRun(result.run), job: result.job ? viewJob(result.job) : null });
}));

// Tải video mới nhất từ Google Flow về máy chủ (thủ công)
app.post('/api/flow/latest-video', wrap(async (req, res) => {
  const id = newId();
  const dest = path.join(DIRS.outputs, `flow-manual-${id}.mp4`);
  const result = await flow.downloadLatestVideoFromFlow(dest);
  const thumb = dest.replace(/\.[^.]+$/, '.jpg');
  await thumbnail(dest, thumb).catch(() => {});
  res.json({
    id,
    url: mediaUrl(dest),
    thumbUrl: mediaUrl(thumb),
    path: dest,
    title: result.title,
  });
}));

app.delete('/api/runs/:id', wrap(async (req, res) => {
  deleteRun(findRun(req.params.id), { withJobs: req.query.withJobs !== '0' });
  res.json({ ok: true });
}));

// ---------- Mã sản phẩm trên ảnh kết quả & Excel cho DiamondShop — Ảnh model mặc đồ (server/productExport.js) ----------
const findProductRun = (id) => {
  const run = findRun(id);
  if (!runHasProducts(run)) throw new Error('Quy trình này không có bảng Mã & sản phẩm');
  return run;
};
// Dòng sản phẩm từng ảnh trang phục + kích thước ảnh kết quả (để trình duyệt vẽ PNG khung mã đúng độ phân giải)
app.get('/api/runs/:id/products', wrap(async (req, res) => {
  const run = findProductRun(req.params.id);
  res.json({ mode: productInputsOf(run.workflow).mode, rows: buildProductRows(run), frame: await frameSizeOf(run), products: run.products || {} });
}));
// Lưu mã / tên / giá / mô tả / ảnh chính / khung mã (PNG data URL) -> mã hoặc vị trí đổi so với ảnh đã in thì in lại
// (anh-model.js stage 'badge'); remerge = true khi có bước phải làm lại
app.put('/api/runs/:id/products', wrap(async (req, res) => {
  const run = findProductRun(req.params.id);
  const rows = saveRunProducts(run, req.body?.products);
  const remerge = resyncRun(run);
  res.json({ rows, remerge, run: viewRun(run) });
}));
// Excel theo hợp đồng DiamondShop; body { products } (tuỳ chọn) = dữ liệu đang sửa trên giao diện để xuất thử mà chưa lưu
app.post('/api/runs/:id/products.xlsx', wrap(async (req, res) => {
  const run = findProductRun(req.params.id);
  const override = req.body?.products && typeof req.body.products === 'object' ? req.body.products : null;
  const rows = buildProductRows(run, { override });
  const wb = await buildWorkbook(rows);
  res.attachment(exportFilename(run));
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  await wb.xlsx.write(res);
  res.end();
}));

// ---------- Zernio API ----------
app.get('/api/zernio/accounts', wrap(async (req, res) => {
  const apiKey = req.query.apiKey || db.settings.zernioApiKey;
  if (!apiKey?.trim()) throw new Error('Chưa cấu hình Zernio API Key');
  const accounts = await zernio.getAccounts(apiKey);
  res.json({ accounts });
}));

app.post('/api/posts/sync-zernio', wrap(async (req, res) => {
  const apiKey = db.settings.zernioApiKey;
  if (!apiKey?.trim()) throw new Error('Chưa cấu hình Zernio API Key');
  const pendingPosts = db.posts.filter((p) => p.provider === 'zernio' && (p.status === 'scheduled' || p.status === 'queued') && p.zernioPostId);
  const updated = [];
  for (const p of pendingPosts) {
    try {
      const zPost = await zernio.getPost(apiKey, p.zernioPostId);
      if (zPost) {
        if (zPost.status === 'published') {
          p.status = 'done';
          p.finishedAt = Date.now();
          const pubUrl = zPost.platforms?.find((pl) => pl.platformPostUrl)?.platformPostUrl;
          if (pubUrl) p.result = { ...(p.result || {}), url: pubUrl };
          updated.push(p);
        } else if (zPost.status === 'failed') {
          p.status = 'failed';
          p.error = zPost.error || 'Đăng bài thất bại trên Zernio';
          p.finishedAt = Date.now();
          updated.push(p);
        }
      }
    } catch (e) {
      console.warn('Lỗi đồng bộ bài đăng Zernio:', p.zernioPostId, e.message);
    }
  }
  if (updated.length) save();
  res.json({ updatedCount: updated.length, posts: db.posts });
}));

// ---------- Đăng mạng xã hội ----------
app.post('/api/posts', wrap(async (req, res) => {
  const {
    jobIds = [],
    platforms = [],
    caption = '',
    title = '',
    useZernio = false,
    zernioAccounts = [],
    scheduledFor = null,
    timezone = 'Asia/Ho_Chi_Minh',
    tiktokShop = null,
    tiktokSettings = null,
  } = req.body;
  const { mergeIds = [] } = req.body;

  // Xử lý caption kèm link affiliate TikTok Shop nếu bật
  let finalCaption = caption || '';
  if (tiktokShop?.enabled && tiktokShop?.link?.trim() && tiktokShop?.autoAppendCaption !== false) {
    const cta = (tiktokShop.cta || '🛒 Xem ngay sản phẩm trong giỏ hàng hoặc tại:').trim();
    const link = tiktokShop.link.trim();
    if (!finalCaption.includes(link)) {
      finalCaption = finalCaption.trim() ? `${finalCaption.trim()}\n\n${cta} ${link}` : `${cta} ${link}`;
    }
  }

  // Cấu hình tiktokSettings
  let effectiveTiktokSettings = tiktokSettings || null;
  if (tiktokShop?.enabled) {
    effectiveTiktokSettings = {
      ...(effectiveTiktokSettings || {}),
      draft: tiktokShop.postMode === 'draft',
      commercialContentType: tiktokShop.commercialType || 'brand_organic',
      isBrandOrganicPost: true,
      brand_organic_toggle: true,
    };
  }

  // Đăng hoặc lên lịch qua Zernio
  if (useZernio || zernioAccounts.length > 0) {
    if (!db.settings.zernioApiKey) throw new Error('Chưa nhập Zernio API Key trong Cài đặt');
    if (!zernioAccounts.length) throw new Error('Chưa chọn tài khoản mạng xã hội Zernio');
    const videos = [
      ...jobIds.map((id) => db.jobs.find((j) => j.id === id)).map((j) => j && { label: j.videoLabel, file: j.outputPath, jobId: j.id }),
      ...mergeIds.map((id) => db.merges.find((m) => m.id === id)).map((m) => m && m.status === 'done' && { label: m.name, file: m.outputPath, mergeId: m.id }),
    ];
    if (!videos.length) throw new Error('Chưa chọn video để đăng');
    if (videos.some((v) => !v?.file)) throw new Error('Có video chưa xong hoặc đã bị xoá');

    const created = [];
    for (const v of videos) {
      const post = {
        id: newId(),
        jobId: v.jobId || null,
        mergeId: v.mergeId || null,
        filePath: v.file,
        videoLabel: v.label,
        provider: 'zernio',
        platform: zernioAccounts.map((a) => a.platform).join(', '),
        zernioAccounts,
        caption: finalCaption,
        title,
        tiktokShop: tiktokShop?.enabled ? tiktokShop : null,
        tiktokSettings: effectiveTiktokSettings,
        scheduledFor: scheduledFor || null,
        timezone: timezone || 'Asia/Ho_Chi_Minh',
        status: 'queued',
        createdAt: Date.now(),
      };
      db.posts.unshift(post);
      created.push(post);
    }
    save();
    runZernioPosts(created);
    return res.json(created);
  }

  // Đăng trực tiếp qua developer token cá nhân (cũ)
  if (!(jobIds.length + mergeIds.length) || !platforms.length) throw new Error('Chọn video và nền tảng');
  const videos = [
    ...jobIds.map((id) => db.jobs.find((j) => j.id === id)).map((j) => j && { label: j.videoLabel, file: j.outputPath, jobId: j.id }),
    ...mergeIds.map((id) => db.merges.find((m) => m.id === id)).map((m) => m && m.status === 'done' && { label: m.name, file: m.outputPath, mergeId: m.id }),
  ];
  if (videos.some((v) => !v?.file)) throw new Error('Có video chưa xong hoặc đã bị xoá');
  const created = [];
  for (const v of videos) {
    for (const platform of platforms) {
      const post = {
        id: newId(), jobId: v.jobId || null, mergeId: v.mergeId || null, filePath: v.file, videoLabel: v.label,
        platform, caption: finalCaption, title, tiktokShop: tiktokShop?.enabled ? tiktokShop : null, tiktokSettings: effectiveTiktokSettings, status: 'queued', createdAt: Date.now(),
      };
      db.posts.unshift(post);
      created.push(post);
    }
  }
  save();
  runPosts(created);
  res.json(created);
}));

// Đăng hoặc lên lịch bài qua Zernio
async function runZernioPosts(posts) {
  for (const post of posts) {
    post.status = 'running';
    save();
    try {
      if (!fs.existsSync(post.filePath)) throw new Error('File video không còn tồn tại');
      const apiKey = db.settings.zernioApiKey;
      if (!apiKey) throw new Error('Chưa cấu hình Zernio API Key');

      const zRes = await zernio.createOrSchedulePost(apiKey, {
        content: post.caption,
        title: post.title,
        filePath: post.filePath,
        platforms: post.zernioAccounts,
        scheduledFor: post.scheduledFor,
        timezone: post.timezone,
        publishNow: !post.scheduledFor,
        tiktokSettings: post.tiktokSettings,
      });

      const zPost = zRes.post || zRes;
      post.zernioPostId = zPost._id || zPost.id;
      post.result = zRes;

      if (post.scheduledFor) {
        post.status = 'scheduled';
      } else {
        post.status = zPost.status === 'failed' ? 'failed' : 'done';
        const pubUrl = zPost.platforms?.find((pl) => pl.platformPostUrl)?.platformPostUrl;
        if (pubUrl) {
          post.result.url = pubUrl;
        }
      }
    } catch (e) {
      post.status = 'failed';
      post.error = e.message;
    }
    post.finishedAt = Date.now();
    save();
  }
}

// Đăng lần lượt để tránh bị nền tảng chặn vì spam
async function runPosts(posts) {
  for (const post of posts) {
    post.status = 'running';
    save();
    try {
      if (!fs.existsSync(post.filePath)) throw new Error('File video không còn tồn tại');
      const r = await publish(db.settings, post.platform, post.filePath, { caption: post.caption, title: post.title, tiktokSettings: post.tiktokSettings });
      Object.assign(post, { status: 'done', result: r });
    } catch (e) {
      Object.assign(post, { status: 'failed', error: e.message });
    }
    post.finishedAt = Date.now();
    save();
  }
}

// ---------- Frontend đã build ----------
const dist = path.join(import.meta.dirname, '../web/dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist, { index: false }));
  // index.html không cache để luôn lấy bản build mới nhất
  app.get('*', (req, res) => res.set('Cache-Control', 'no-cache').sendFile(path.join(dist, 'index.html')));
}

recoverJobs();
setTimeout(advanceAll, 1000);
backfillSources().catch((e) => console.error(e));
for (const p of [...db.posts, ...db.merges]) {
  if ((p.status === 'running' || p.status === 'queued') && p.status !== 'scheduled') {
    Object.assign(p, { status: 'failed', error: 'Server bị dừng giữa chừng' });
  }
}
// Bài đăng cũ chưa lưu filePath
for (const p of db.posts) if (!p.filePath && p.jobId) p.filePath = db.jobs.find((j) => j.id === p.jobId)?.outputPath;
save();

app.listen(PORT, HOST, () => console.log(`Server: http://${HOST}:${PORT}`));
