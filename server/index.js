import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { db, save, DIRS, DATA_DIR, newId, mediaUrl, updateSettings } from './db.js';
import { probe, cutClip, thumbnail, splitRanges, extractAudio, filmstrip } from './ffmpeg.js';
import { createJob, createImportJob, retryJob, recoverJobs, pump } from './queue.js';
import { publish } from './social.js';
import * as flow from './flow.js';
import * as shopee from './shopee.js';
import * as productScraper from './productScraper.js';
import { DEFAULT_MOTION_TEMPLATE, DEFAULT_BACKGROUND_TEMPLATE } from './prompts.js';
import { createMerge, rangeOf } from './merge.js';
import { listWorkflows } from './workflows/index.js';
import { createRun, resumeRun, cancelRun, deleteRun, advanceAll, viewRun, replaceClipVideos, touchJob } from './workflows/runner.js';

const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_CLIP = 10; // Omni Flash chỉ nhận video đầu vào tối đa 10 giây

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use('/media', express.static(DATA_DIR));

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, DIRS.tmp),
    filename: (req, file, cb) => cb(null, newId() + path.extname(file.originalname).toLowerCase()),
  }),
  limits: { fileSize: 2 * 1024 ** 3 },
});

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => res.status(400).json({ error: e.message }));

const rm = (f) => f && fs.rm(f, { force: true }, () => {});

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
    defaults: { motionTemplate: DEFAULT_MOTION_TEMPLATE, backgroundTemplate: DEFAULT_BACKGROUND_TEMPLATE },
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

app.put('/api/settings', (req, res) => {
  const s = updateSettings(req.body || {});
  pump();
  res.json(s);
});

// ---------- Google Flow (Playwright) ----------
app.get('/api/flow/status', wrap(async (req, res) => res.json(await flow.status())));
app.post('/api/flow/launch', wrap(async (req, res) => res.json(await flow.launchChrome())));

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
  let ranges = manual?.length ? manual.map(([a, b]) => [Number(a), Number(b)]) : splitRanges(src.duration, Number(segment) || 8);
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
  if (!['model', 'product', 'background'].includes(kind)) throw new Error('kind không hợp lệ');
  const id = newId();
  const dest = path.join(DIRS.assets, id + path.extname(req.file.filename));
  fs.renameSync(req.file.path, dest);
  const a = { id, kind, name: req.file.originalname, path: dest, createdAt: Date.now() };
  db.assets.unshift(a);
  save();
  res.json({ ...a, url: mediaUrl(dest) });
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
app.post('/api/product/import', wrap(async (req, res) => {
  const { kind = 'product', images = [] } = req.body || {};
  if (!['model', 'product', 'background'].includes(kind)) throw new Error('kind không hợp lệ');
  if (!images.length) throw new Error('Chưa chọn ảnh');
  res.json(await productScraper.importImages(kind, images));
}));
// Tương thích ngược với các gọi cũ
app.post('/api/shopee/product', wrap(async (req, res) => res.json(await productScraper.fetchProduct(req.body?.url || ''))));
app.post('/api/shopee/import', wrap(async (req, res) => {
  const { kind = 'product', images = [] } = req.body || {};
  if (!['model', 'product', 'background'].includes(kind)) throw new Error('kind không hợp lệ');
  if (!images.length) throw new Error('Chưa chọn ảnh');
  res.json(await productScraper.importImages(kind, images));
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
  const { jobIds = [], audioId = null, audioMode = 'match', offset = 0, name } = req.body;
  res.json(createMerge({ jobIds, audioId, audioMode, offset, name }));
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
app.post('/api/runs', wrap(async (req, res) => res.json(viewRun(createRun(req.body || {})))));
app.post('/api/runs/:id/resume', wrap(async (req, res) => res.json(viewRun(resumeRun(findRun(req.params.id))))));
app.post('/api/runs/:id/cancel', wrap(async (req, res) => res.json(viewRun(cancelRun(findRun(req.params.id))))));
// Thay video motion của đoạn clipId (và các đoạn kế tiếp nếu nhiều file) bằng video nhập từ máy
app.post('/api/runs/:id/replace', upload.array('files', 50), wrap(async (req, res) => {
  if (!req.files?.length) throw new Error('Chưa chọn file');
  const run = findRun(req.params.id);
  const replaced = await replaceClipVideos(run, req.body.clipId, req.files);
  res.json({ replaced, run: viewRun(run) });
}));
app.delete('/api/runs/:id', wrap(async (req, res) => {
  deleteRun(findRun(req.params.id), { withJobs: req.query.withJobs !== '0' });
  res.json({ ok: true });
}));

// ---------- Đăng mạng xã hội ----------
app.post('/api/posts', wrap(async (req, res) => {
  const { jobIds = [], platforms = [], caption = '', title = '' } = req.body;
  const { mergeIds = [] } = req.body;
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
        platform, caption, title, status: 'queued', createdAt: Date.now(),
      };
      db.posts.unshift(post);
      created.push(post);
    }
  }
  save();
  runPosts(created);
  res.json(created);
}));

// Đăng lần lượt để tránh bị nền tảng chặn vì spam
async function runPosts(posts) {
  for (const post of posts) {
    post.status = 'running';
    save();
    try {
      if (!fs.existsSync(post.filePath)) throw new Error('File video không còn tồn tại');
      const r = await publish(db.settings, post.platform, post.filePath, { caption: post.caption, title: post.title });
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
  if (p.status === 'running' || p.status === 'queued') Object.assign(p, { status: 'failed', error: 'Server bị dừng giữa chừng' });
}
// Bài đăng cũ chưa lưu filePath
for (const p of db.posts) if (!p.filePath && p.jobId) p.filePath = db.jobs.find((j) => j.id === p.jobId)?.outputPath;
save();

app.listen(PORT, HOST, () => console.log(`Server: http://${HOST}:${PORT}`));
