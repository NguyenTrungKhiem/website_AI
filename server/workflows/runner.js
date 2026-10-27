// Trình chạy quy trình: lưu trạng thái từng bước vào db.runs, tiếp tục được sau khi server khởi động lại,
// dừng khi có job lỗi (người dùng bấm "Tiếp tục" để chạy lại job lỗi và đi tiếp).
import path from 'node:path';
import { db, save, DIRS, newId, mediaUrl } from '../db.js';
import { createJob, createImportJob, retryJob, settledHooks } from '../queue.js';
import { createMerge, mergeSettledHooks } from '../merge.js';
import { frameAt } from '../ffmpeg.js';
import { WORKFLOWS } from './index.js';
import fs from 'node:fs';

export function createRun({ workflowId, sourceId, clipIds = [], inputs = {}, clipInputs = {}, options = {}, prompts = {} }) {
  const wf = WORKFLOWS[workflowId];
  if (!wf) throw new Error('Không có quy trình ' + workflowId);
  // Quy trình chỉ làm ảnh (noVideo) không cần video gốc / đoạn cắt
  let source = null;
  let clips = [];
  if (!wf.noVideo) {
    source = db.sources.find((s) => s.id === sourceId);
    if (!source) throw new Error('Không tìm thấy video gốc');
    clips = clipIds.map((id) => db.clips.find((c) => c.id === id && c.sourceId === sourceId));
    if (!clips.length || clips.includes(undefined)) throw new Error('Chọn ít nhất 1 đoạn đã cắt của video gốc này');
  }
  const cleanInputs = {};
  for (const inp of wf.inputs) {
    const v = inputs[inp.key];
    if (inp.multiple) {
      const ids = (Array.isArray(v) ? v : v ? [v] : []).filter((id) => db.assets.find((a) => a.id === id));
      if (inp.required && !ids.length) throw new Error(`Thiếu ${inp.label}`);
      cleanInputs[inp.key] = ids;
    } else {
      if (inp.required && !v) throw new Error(`Thiếu ${inp.label}`);
      if (v && !db.assets.find((a) => a.id === v)) throw new Error(`${inp.label}: ảnh không còn trong thư viện`);
      cleanInputs[inp.key] = v || null;
    }
  }
  // Ảnh riêng cho từng đoạn (vd. Thay trang phục: mỗi đoạn một bộ trang phục): { [clipId]: { [key]: assetId } }
  const perClip = {};
  for (const clip of clips) {
    const given = clipInputs[clip.id] || {};
    perClip[clip.id] = {};
    for (const inp of wf.perClipInputs || []) {
      const v = given[inp.key] || null;
      if (inp.required && !v) throw new Error(`Đoạn "${clip.name}": thiếu ${inp.label}`);
      if (v && !db.assets.find((a) => a.id === v)) throw new Error(`Đoạn "${clip.name}": ảnh ${inp.label} không còn trong thư viện`);
      perClip[clip.id][inp.key] = v;
    }
  }
  const opts = Object.fromEntries(wf.options.map((o) => [o.key, options[o.key] ?? o.default]));
  // Prompt dùng cho lần chạy này được "đóng băng" vào run để sửa prompt mẫu sau không ảnh hưởng run đang chạy
  const saved = db.settings.workflows?.[workflowId]?.prompts || {};
  const frozen = Object.fromEntries(Object.entries(wf.prompts).map(([k, p]) => [k, (prompts[k] ?? saved[k] ?? '').trim() || p.text]));

  const run = {
    id: newId(),
    workflow: workflowId,
    sourceId: source?.id || null,
    clipIds: clips.map((c) => c.id),
    inputs: cleanInputs,
    clipInputs: perClip,
    options: opts,
    prompts: frozen,
    status: 'running',
    stage: null,
    error: null,
    stages: {},
    createdAt: Date.now(),
    finishedAt: null,
  };
  db.runs.unshift(run);
  save();
  advance(run);
  return run;
}

export function resumeRun(run) {
  if (run.status === 'done') return run;
  // Đang dừng chờ kiểm tra -> người dùng đã duyệt bước đó
  if (run.status === 'paused' && run.stage && run.stages[run.stage]) run.stages[run.stage].approved = true;
  run.status = 'running';
  run.error = null;
  // Chạy lại các job lỗi mà lần chạy đang dùng (job đã bị thay bằng video từ máy thì không còn trong danh sách)
  for (const id of Object.values(run.stages._jobs || {})) {
    const job = db.jobs.find((j) => j.id === id);
    if (job?.status === 'failed' && job.type !== 'import') retryJob(job);
  }
  save();
  advance(run);
  return run;
}

export function cancelRun(run) {
  run.status = 'cancelled';
  run.finishedAt = Date.now();
  // Job còn chờ trong hàng đợi thì bỏ luôn
  for (const j of db.jobs) if (j.runId === run.id && j.status === 'queued') Object.assign(j, { status: 'failed', error: 'Quy trình đã huỷ' });
  save();
  return run;
}

export function deleteRun(run, { withJobs = true } = {}) {
  if (withJobs) {
    for (const j of db.jobs.filter((j) => j.runId === run.id)) {
      if (j.status === 'running') throw new Error('Có job đang chạy, chờ xong rồi xoá');
    }
    for (const j of db.jobs.filter((j) => j.runId === run.id)) {
      for (const a of j.attempts) { rm(a.outputPath); rm(a.thumbPath); }
    }
    db.jobs = db.jobs.filter((j) => j.runId !== run.id);
  }
  db.runs = db.runs.filter((r) => r !== run);
  save();
}

const rm = (f) => f && fs.rm(f, { force: true }, () => {});

/**
 * Thay video motion của 1 đoạn bằng video người dùng nhập từ máy, rồi làm lại các bước sau nó
 * (thay bối cảnh cho đoạn đó + ghép). files[i] ứng với đoạn thứ i tính từ clipId trong thứ tự của run.
 */
export async function replaceClipVideos(run, clipId, files) {
  const startIdx = run.clipIds.indexOf(clipId);
  if (startIdx < 0) throw new Error('Đoạn này không thuộc lần chạy');
  if (run.status === 'running' && run.stage && run.stage !== 'motion' && run.stage !== 'replace' && run.stage !== 'merge') {
    throw new Error('Chờ quy trình qua bước hiện tại rồi thay');
  }
  const jobsMap = (run.stages._jobs ||= {});
  const replaced = [];
  for (const [i, f] of files.entries()) {
    const cid = run.clipIds[startIdx + i];
    if (!cid) break; // thừa file thì bỏ qua
    const clip = db.clips.find((c) => c.id === cid);
    const job = await createImportJob({
      file: f.path,
      name: f.originalname,
      sourceRange: clip ? { sourceId: clip.sourceId, start: clip.start, end: clip.end } : null,
      runId: run.id,
      stage: 'motion',
      videoLabel: `${clip?.name || cid} (nhập từ máy)`,
    });
    jobsMap[`motion:${cid}`] = job.id;
    delete jobsMap[`replace:${cid}`]; // thay nền lại cho đoạn này
    replaced.push(cid);
  }
  // Các bước phía sau phải chạy lại (kể cả kiểm tra lại video)
  if (run.stages.review && run.stages.review.status !== 'skipped') run.stages.review = { status: 'pending' };
  if (run.stages.replace && run.stages.replace.status !== 'skipped') run.stages.replace.status = 'pending';
  if (run.stages.merge && run.stages.merge.status !== 'skipped') run.stages.merge = { status: 'pending' };
  if (run.status === 'done' || run.status === 'failed' || run.status === 'cancelled') {
    run.status = 'running';
    run.error = null;
    run.finishedAt = null;
  }
  save();
  advance(run);
  return replaced;
}

const locks = new Set();

/**
 * Đồng bộ khi người dùng đổi kết quả 1 bước (thử lại / chọn lần tạo khác / xoá lần tạo / thay video):
 * bước sau đang dùng đầu vào cũ thì bỏ để làm lại. Trả về true nếu có gì phải làm lại.
 */
function syncRun(run) {
  const jobsMap = run.stages._jobs || {};
  const get = (k) => db.jobs.find((j) => j.id === jobsMap[k]);
  let stale = false;
  const reset = (stageId) => {
    const st = run.stages[stageId];
    if (st && st.status !== 'skipped' && st.status !== 'pending') { st.status = 'pending'; stale = true; }
  };
  // Bối cảnh: job ảnh có kết quả mới -> lưu lại ảnh bối cảnh mới, mọi đoạn phải thay nền lại
  const bgState = run.stages.background;
  const bgJob = get('background:bg');
  if (bgState?.assetId && bgJob?.outputPath && bgState.assetFrom && bgState.assetFrom !== bgJob.outputPath) {
    const a = db.assets.find((x) => x.id === bgState.assetId);
    if (a) {
      fs.copyFileSync(bgJob.outputPath, a.path);
      a.flowTitle = bgJob.attempts.find((x) => x.outputPath === bgJob.outputPath)?.flowTitle || null; // ảnh mới trên Flow
    }
    bgState.assetFrom = bgJob.outputPath;
    for (const cid of run.clipIds) delete jobsMap[`replace:${cid}`];
    reset('replace');
    stale = true;
  }
  // Ảnh vóc dáng 16:9 (Fashion V2V) tạo lại -> cập nhật ảnh, kiểm tra lại, mọi đoạn phải tạo video lại
  const trState = run.stages.turnaround;
  const trJob = get('turnaround:sheet');
  if (trState?.assetId && trJob?.outputPath && trState.assetFrom && trState.assetFrom !== trJob.outputPath) {
    const a = db.assets.find((x) => x.id === trState.assetId);
    if (a) {
      fs.copyFileSync(trJob.outputPath, a.path);
      a.flowTitle = trJob.attempts.find((x) => x.outputPath === trJob.outputPath)?.flowTitle || null;
    }
    trState.assetFrom = trJob.outputPath;
    for (const cid of run.clipIds) delete jobsMap[`motion:${cid}`];
    if (run.stages.review && run.stages.review.status !== 'skipped') run.stages.review = { status: 'pending' };
    reset('motion');
    stale = true;
  }
  // Thay nền: đầu vào phải là video motion hiện tại của đoạn đó; video motion đổi -> kiểm tra lại trước khi thay nền
  for (const cid of run.clipIds) {
    const mj = get(`motion:${cid}`);
    const rj = get(`replace:${cid}`);
    if (rj && mj?.outputPath && rj.videoPath !== mj.outputPath) {
      delete jobsMap[`replace:${cid}`];
      if (run.stages.review && run.stages.review.status !== 'skipped') run.stages.review = { status: 'pending' };
      reset('replace');
      stale = true;
    }
  }
  // Ghép: các video nguồn phải đúng là kết quả hiện tại
  const mergeState = run.stages.merge;
  const merge = mergeState?.mergeId && db.merges.find((m) => m.id === mergeState.mergeId);
  if (merge) {
    const finalKey = run.options.replaceBackground ? 'replace' : 'motion';
    const current = run.clipIds.map((cid) => get(`${finalKey}:${cid}`)?.outputPath || null);
    const same = merge.inputPaths && current.every((p, i) => p && p === merge.inputPaths[i]);
    if (!same) { run.stages.merge = { status: 'pending' }; stale = true; }
  }
  if (stale) save();
  return stale;
}

// Gọi khi 1 job của quy trình đổi kết quả (xong sau khi thử lại, chọn lần tạo khác, xoá lần tạo)
export function touchJob(jobId) {
  const job = db.jobs.find((j) => j.id === jobId);
  const run = job?.runId && db.runs.find((r) => r.id === job.runId);
  if (!run) return;
  if (syncRun(run) && (run.status === 'done' || run.status === 'failed')) {
    run.status = 'running';
    run.error = null;
    run.finishedAt = null;
    save();
  }
  advance(run); // đang dừng chờ kiểm tra thì vẫn dừng (advance bỏ qua)
}

// Chạy tiếp quy trình từ bước đang dở. Gọi lại bao nhiêu lần cũng được.
export async function advance(run) {
  if (run.status !== 'running' || locks.has(run.id)) return;
  locks.add(run.id);
  try {
    const wf = WORKFLOWS[run.workflow];
    const ctx = makeCtx(run, wf);
    syncRun(run);
    for (const stage of wf.stages) {
      const st = (run.stages[stage.id] ||= { status: 'pending' });
      if (stage.when && !stage.when(run)) { st.status = 'skipped'; continue; }
      if (st.status === 'done' || st.status === 'skipped') continue;
      run.stage = stage.id;
      ctx.state = st;
      st.status = 'running';
      save();
      const result = await stage.run(ctx);
      if (result === 'paused') { st.status = 'paused'; run.status = 'paused'; save(); return; } // chờ người dùng bấm Tiếp tục
      if (result !== 'done') { save(); return; } // 'waiting': chờ job xong rồi quay lại
      st.status = 'done';
      save();
    }
    run.status = 'done';
    run.stage = null;
    run.finishedAt = Date.now();
    save();
  } catch (e) {
    run.status = 'failed';
    run.error = e.message;
    save();
  } finally {
    locks.delete(run.id);
  }
}

export function advanceAll() {
  for (const run of db.runs) if (run.status === 'running') advance(run);
}

function makeCtx(run, wf) {
  const source = db.sources.find((s) => s.id === run.sourceId);
  const clips = run.clipIds.map((id) => db.clips.find((c) => c.id === id)).filter(Boolean);
  const ctx = {
    run,
    source,
    clips,
    inputs: run.inputs,
    clipInputs: run.clipInputs || {}, // ảnh riêng từng đoạn: { [clipId]: { [key]: assetId } }
    stages: run.stages,
    state: null, // trạng thái riêng của bước đang chạy (được lưu)
    prompt: (key) => run.prompts[key] || wf.prompts[key]?.text || '',
    assetPath: (id) => (id ? db.assets.find((a) => a.id === id)?.path || null : null),

    // Lấy 1 khung hình của video gốc
    async frame(at) {
      if (!source) throw new Error('Quy trình này không có video gốc');
      const file = path.join(DIRS.assets, `frame-${run.id}.jpg`);
      await frameAt(source.path, file, at);
      return file;
    },
    // Tên ảnh trong thư viện (để đặt tên kết quả)
    assetName: (id) => (id ? db.assets.find((a) => a.id === id)?.name || '' : ''),
    // Lấy 1 khung hình của video bất kỳ (vd. video đã render) -> file ảnh đặt tên theo `name`
    async frameOf(videoPath, at, name) {
      const file = path.join(DIRS.assets, `frame-${run.id}-${name}.jpg`);
      await frameAt(videoPath, file, at);
      return file;
    },

    // Tạo job 1 lần duy nhất cho mỗi khoá; lần sau trả về job đã có
    ensureJob(key, spec) {
      const ids = (run.stages._jobs ||= {});
      let job = ids[key] && db.jobs.find((j) => j.id === ids[key]);
      if (!job) {
        job = createJob({ ...spec, runId: run.id, stage: run.stage });
        ids[key] = job.id;
        save();
      }
      return job;
    },
    job: (key) => db.jobs.find((j) => j.id === run.stages._jobs?.[key]),
    jobError: (job) => new Error(`"${job.videoLabel}" lỗi: ${job.error} — bấm Tiếp tục để chạy lại.`),

    // 'done' khi tất cả xong; ném lỗi khi có job lỗi và không còn job nào chạy; còn lại 'waiting'
    waitAll(jobs) {
      if (jobs.every((j) => j.status === 'done')) return 'done';
      const failed = jobs.filter((j) => j.status === 'failed');
      const active = jobs.some((j) => j.status === 'running' || j.status === 'queued');
      if (failed.length && !active) throw this.jobError(failed[0]);
      return 'waiting';
    },

    // Lưu file thành 1 ảnh trong thư viện (để dùng lại ở bước khác / quy trình khác)
    // extra: vd. { flowTitle } = tên ảnh trên Flow để dùng lại làm nguyên liệu mà không tải lên lại
    registerAsset(kind, file, name, extra = {}) {
      const id = newId();
      const dest = path.join(DIRS.assets, id + path.extname(file));
      fs.copyFileSync(file, dest);
      const a = { id, kind, name, path: dest, createdAt: Date.now(), runId: run.id, ...extra };
      db.assets.unshift(a);
      save();
      return a;
    },

    // Ghép các job theo thứ tự + âm thanh gốc (khớp từng đoạn) nếu có, tuỳ chọn xoá logo
    ensureMerge({ jobIds, name, removeWatermark, watermarkMode }) {
      const st = this.state;
      let merge = st.mergeId && db.merges.find((m) => m.id === st.mergeId);
      if (!merge) {
        const audio = db.audios.find((a) => a.sourceId === source.id);
        const shouldRemoveWatermark = removeWatermark ?? run.options.removeWatermark ?? db.settings.removeWatermark ?? true;
        merge = createMerge({
          jobIds,
          audioId: audio?.id || null,
          audioMode: audio ? 'match' : null,
          name,
          runId: run.id,
          removeWatermark: shouldRemoveWatermark,
          watermarkMode: watermarkMode || 'delogo',
        });
        st.mergeId = merge.id;
        save();
      }
      if (merge.status === 'failed') throw new Error('Ghép video lỗi: ' + merge.error);
      return merge.status === 'done' ? 'done' : 'waiting';
    },
  };
  return ctx;
}

// Thông tin run cho giao diện
export function viewRun(run) {
  const wf = WORKFLOWS[run.workflow];
  const jobsMap = run.stages._jobs || {};
  const byKey = (k) => db.jobs.find((j) => j.id === jobsMap[k]);
  // Job "đang được dùng" của từng bước (job cũ bị thay thế không tính)
  const active = Object.fromEntries(Object.entries(jobsMap).map(([k, id]) => [k, db.jobs.find((j) => j.id === id)]).filter(([, j]) => j));
  const jobs = db.jobs.filter((j) => j.runId === run.id);
  const merge = run.stages.merge?.mergeId && db.merges.find((m) => m.id === run.stages.merge.mergeId);
  const bgAsset = run.stages.background?.assetId && db.assets.find((a) => a.id === run.stages.background.assetId);
  const brief = (j) => j && { id: j.id, type: j.type, status: j.status, thumbUrl: mediaUrl(j.thumbPath), outputUrl: mediaUrl(j.outputPath), label: j.videoLabel, imported: j.type === 'import' };
  return {
    ...run,
    workflowName: wf?.name || run.workflow,
    stageList: (wf?.stages || []).map((s) => {
      const st = run.stages[s.id] || { status: 'pending' };
      const sj = Object.entries(active).filter(([k]) => k.startsWith(s.id + ':')).map(([, j]) => j);
      return { id: s.id, label: s.label, status: st.status, done: sj.filter((j) => j.status === 'done').length, total: sj.length };
    }),
    // Từng đoạn: video motion (hoặc video nhập thay thế), video đã thay nền, ảnh riêng của đoạn (nếu quy trình có)
    clipRows: run.clipIds.map((cid) => {
      const clip = db.clips.find((c) => c.id === cid);
      const inputs = Object.fromEntries(
        (wf?.perClipInputs || []).map((inp) => {
          const a = db.assets.find((x) => x.id === run.clipInputs?.[cid]?.[inp.key]);
          return [inp.key, a ? { id: a.id, url: mediaUrl(a.path), name: a.name } : null];
        }),
      );
      return { clipId: cid, name: clip?.name || cid, inputs, motion: brief(byKey(`motion:${cid}`)) || null, replace: brief(byKey(`replace:${cid}`)) || null };
    }),
    anchorUrl: mediaUrl(run.stages.motion?.anchorPath), // khung mặt đã render của đoạn 1 (Thay trang phục)
    // Ảnh kết quả của quy trình chỉ làm ảnh (key "render:…"): job + ảnh đã lưu vào thư viện (nếu có)
    outputs: Object.entries(active)
      .filter(([k]) => k.startsWith('render:'))
      .map(([k, j]) => {
        const a = j.meta?.assetId && db.assets.find((x) => x.id === j.meta.assetId);
        return { key: k, ...brief(j), label: j.videoLabel, assetId: a?.id || null, assetUrl: a ? mediaUrl(a.path) : null };
      }),
    frameUrl: mediaUrl(run.stages.frame?.path),
    backgroundUrl: bgAsset ? mediaUrl(bgAsset.path) : null,
    background: brief(byKey('background:bg')) || null, // job sinh ảnh bối cảnh (để Thử lại / chọn lần tạo)
    turnaround: brief(byKey('turnaround:sheet')) || null, // Fashion V2V: job sinh ảnh vóc dáng 16:9
    jobIds: jobs.map((j) => j.id),
    merge: merge ? { id: merge.id, status: merge.status, url: mediaUrl(merge.outputPath), thumbUrl: mediaUrl(merge.thumbPath), error: merge.error } : null,
  };
}

// Job/merge xong -> chạy tiếp các quy trình đang chờ (và làm lại bước sau nếu kết quả đổi)
settledHooks.push((job) => { if (job?.runId) touchJob(job.id); advanceAll(); });
mergeSettledHooks.push(() => advanceAll());
setInterval(advanceAll, 15_000).unref();
