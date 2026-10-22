// Trang chạy 1 quy trình tự động (AI Dancing…). Giao diện dựng từ mô tả quy trình do server gửi (wf),
// nên thêm quy trình mới ở server/workflows là tự có trang riêng.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { AssetPicker, ConfirmButton, FileDrop, JobCard, JobList, fmt, useAction } from '../components.jsx';

export default function WorkflowPage({ state, refresh, go, wf }) {
  const [sourceId, setSourceId] = useState(state.sources[0]?.id || null);
  const [clipIds, setClipIds] = useState([]);
  const [inputs, setInputs] = useState({});
  const [options, setOptions] = useState(() => Object.fromEntries(wf.options.map((o) => [o.key, o.default])));
  const { busy, error, run } = useAction();

  const source = state.sources.find((s) => s.id === sourceId);
  const clips = useMemo(() => state.clips.filter((c) => c.sourceId === sourceId).slice().sort((a, b) => a.start - b.start), [state.clips, sourceId]);
  const runs = state.runs.filter((r) => r.workflow === wf.id);
  const engine = state.settings.engine;

  // Đổi video gốc -> chọn sẵn tất cả đoạn đã cắt
  useEffect(() => {
    if (!source && state.sources[0]) setSourceId(state.sources[0].id);
  }, [state.sources, source]);
  useEffect(() => setClipIds(clips.map((c) => c.id)), [sourceId, clips.length]);

  const redirectedRef = useRef(new Set());

  // Tự động chuyển sang trang Đăng video khi quy trình hoàn tất nếu bật tuỳ chọn autoPublish
  useEffect(() => {
    for (const r of runs) {
      if (
        r.status === 'done' &&
        r.merge?.status === 'done' &&
        r.options?.autoPublish &&
        !redirectedRef.current.has(r.id)
      ) {
        // Chỉ tự chuyển nếu hoàn thành gần đây (trong vòng 60 giây)
        const justFinished = r.finishedAt && (Date.now() - r.finishedAt < 60000);
        if (justFinished) {
          redirectedRef.current.add(r.id);
          go('publish', [r.merge.id]);
          break;
        }
      }
    }
  }, [runs, go]);

  const toggleClip = (id) => setClipIds((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const missing = wf.inputs.filter((i) => i.required && !inputs[i.key]).map((i) => i.label);
  const sheetCount = state.assets.filter((a) => a.identitySheet && a.fromAssetId === inputs.model).length;

  const start = () =>
    run(async () => {
      await api.createRun({ workflowId: wf.id, sourceId, clipIds, inputs, options });
      await refresh();
    });

  return (
    <section>
      <h1>{wf.icon} {wf.name}</h1>
      <p className="muted">{wf.description}</p>
      <p className="small muted">
        Đang tạo bằng: <b>{engine === 'mock' ? 'engine giả (thử nghiệm)' : 'Google Flow qua extension (bạn bấm nút tạo trên tab Flow khi được nhắc)'}</b>
        {' · '}<a onClick={() => go('settings')}>cài đặt</a>
      </p>

      <div className="card stack">
        <div className="row between">
          <b>1. Video gốc và các đoạn đã cắt ({clipIds.length}/{clips.length})</b>
          <div className="row">
            <select value={sourceId || ''} onChange={(e) => setSourceId(e.target.value)}>
              {state.sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <a onClick={() => setClipIds(clips.map((c) => c.id))}>Chọn tất cả</a>
            <a onClick={() => setClipIds([])}>Bỏ chọn</a>
          </div>
        </div>
        {!source ? (
          <p className="muted">Chưa có video gốc. <a onClick={() => go('cut')}>Tải và cắt video trước</a>.</p>
        ) : clips.length === 0 ? (
          <p className="muted">Video này chưa cắt đoạn nào. <a onClick={() => go('cut')}>Sang trang Cắt video</a>.</p>
        ) : (
          <div className="thumbs">
            {clips.map((c) => (
              <div key={c.id} className={'thumb wide' + (clipIds.includes(c.id) ? ' selected' : '')} onClick={() => toggleClip(c.id)} title={c.name}>
                <img src={c.thumbUrl} alt="" />
                <span className="cap">{c.name} · {fmt(c.end - c.start)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card stack">
        <b>2. Ảnh tham chiếu</b>
        <div className="grid2">
          {wf.inputs.map((inp) => (
            <AssetPicker
              key={inp.key}
              kind={inp.kind}
              label={inp.label + (inp.required ? ' *' : '')}
              assets={state.assets}
              value={inputs[inp.key] || null}
              onChange={(v) => setInputs((s) => ({ ...s, [inp.key]: v }))}
              refresh={refresh}
              state={state}
            />
          ))}
        </div>
        {inputs.model && options.identityLock && (
          <small className="muted">
            Bảng mặt 360° của ảnh model: {sheetCount > 0
              ? `đã có ${sheetCount} bảng (quy trình dùng bảng mới nhất; bấm 🔍 trên ảnh model để xem / tạo lại).`
              : 'chưa có → quy trình sẽ tự tạo khi chạy (Nano Banana, 0 credit). Muốn xem trước, bấm 🔍 trên ảnh model rồi "Tạo bảng mặt 360°".'}
          </small>
        )}
      </div>

      <div className="card stack">
        <b>3. Tuỳ chọn</b>
        {wf.options.map((o) => (
          <label key={o.key} className="check">
            <input type="checkbox" checked={!!options[o.key]} onChange={(e) => setOptions((s) => ({ ...s, [o.key]: e.target.checked }))} />
            {o.label}
          </label>
        ))}
        <PromptEditor wf={wf} settings={state.settings} refresh={refresh} />
      </div>

      <div className="row">
        <button className="primary big" disabled={busy || !clipIds.length || missing.length > 0} onClick={start}>
          ▶ Chạy {wf.name} cho {clipIds.length} đoạn
        </button>
        {missing.length > 0 && <span className="muted small">Cần chọn: {missing.join(', ')}</span>}
      </div>
      {error && <div className="err">{error}</div>}

      <h2>Các lần chạy</h2>
      {runs.length === 0 ? (
        <p className="muted">Chưa chạy lần nào.</p>
      ) : (
        runs.map((r) => <RunCard key={r.id} run={r} state={state} refresh={refresh} go={go} />)
      )}
    </section>
  );
}

// Prompt mẫu của quy trình, lưu trong Cài đặt (settings.workflows[wf.id].prompts); trống = mặc định
function PromptEditor({ wf, settings, refresh }) {
  const saved = settings.workflows?.[wf.id]?.prompts || {};
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(saved);
  const [ok, setOk] = useState(false);
  const { busy, error, run } = useAction();
  useEffect(() => setDraft(saved), [JSON.stringify(saved)]);

  const save = () =>
    run(async () => {
      await api.saveSettings({ workflows: { [wf.id]: { prompts: draft } } });
      await refresh();
      setOk(true);
      setTimeout(() => setOk(false), 2000);
    });

  return (
    <div className="stack">
      <a onClick={() => setOpen(!open)}>{open ? '▾' : '▸'} Prompt mẫu của quy trình ({Object.keys(wf.prompts).length} bước)</a>
      {open && (
        <div className="stack wf-prompts">
          {Object.entries(wf.prompts).map(([key, p]) => {
            const custom = (draft[key] || '').trim() && draft[key] !== p.text;
            return (
              <label key={key}>
                <span className="row between">
                  <b>{p.label}</b>
                  {custom && <a onClick={() => setDraft((d) => ({ ...d, [key]: '' }))}>Khôi phục mặc định</a>}
                </span>
                <textarea rows={8} className="mono" value={draft[key] || p.text} onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))} />
              </label>
            );
          })}
          <div className="row">
            <button className="primary" disabled={busy} onClick={save}>💾 Lưu prompt mẫu</button>
            {ok && <span className="ok">Đã lưu</span>}
            {error && <span className="err">{error}</span>}
            <small className="muted">Prompt được "đóng băng" vào từng lần chạy: sửa ở đây chỉ ảnh hưởng lần chạy mới.</small>
          </div>
        </div>
      )}
    </div>
  );
}

// Từng đoạn của lần chạy: keyframe (khoá nhận diện) → video motion → video đã thay nền. Mỗi ô là thẻ thu gọn:
// xem kết quả, các lần tạo (chọn bản tốt nhất), Thử lại / Sửa prompt. Có nút thay video motion bằng file từ máy.
function ClipTable({ run: r, jobs, refresh, state }) {
  const [open, setOpen] = useState(true);
  const { busy, error, run } = useAction();
  const byId = useMemo(() => Object.fromEntries(jobs.map((j) => [j.id, j])), [jobs]);
  const replaceWith = (clipId, files) =>
    run(async () => {
      await api.replaceRunClip(r.id, clipId, files);
      await refresh();
    });
  const cell = (b) => {
    const job = b && byId[b.id];
    if (!job) return <span className="muted">– chưa tới bước này –</span>;
    return <JobCard compact job={job} refresh={refresh} />;
  };
  return (
    <div className="stack">
      <a onClick={() => setOpen(!open)}>{open ? '▾' : '▸'} Từng đoạn ({r.clipRows.length}): xem video, thử lại, chọn bản tốt nhất</a>
      {open && (
        <>
          <table className="table clip-table">
            <thead>
              <tr>
                <th>Đoạn</th>
                {r.options.identityLock && <th>Keyframe (mặt đã khoá theo bảng 360°)</th>}
                <th>Video motion (thay người + sản phẩm)</th>
                {r.options.replaceBackground && <th>Đã thay bối cảnh</th>}
              </tr>
            </thead>
            <tbody>
              {r.clipRows.map((row, i) => (
                <tr key={row.clipId}>
                  <td className="clip-name">
                    <b>#{i + 1}</b>
                    <div className="small muted">{row.name}</div>
                    {row.frameUrl && <img className="clip-frame" src={row.frameUrl} alt="" title="Khung hình đầu của đoạn (nguyên liệu pose/outfit cho keyframe)" />}
                    <FileDrop accept="video/*" multiple onFiles={(files) => replaceWith(row.clipId, files)}>
                      <button disabled={busy} className="small-btn" title="Thay video motion của đoạn này bằng file từ máy; chọn nhiều file thì các file sau thay các đoạn kế tiếp">
                        📥 Thay bằng video từ máy
                      </button>
                    </FileDrop>
                  </td>
                  {r.options.identityLock && <td>{cell(row.keyframe)}</td>}
                  <td>
                    {cell(row.motion)}
                    <ManualFlowBox run={r} row={row} index={i} jobs={byId} state={state} busy={busy} onImport={(files) => replaceWith(row.clipId, files)} />
                  </td>
                  {r.options.replaceBackground && <td>{cell(row.replace)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
          <small className="muted">
            {r.options.identityLock && <>Keyframe (0 credit): Thử lại / Sửa prompt / chọn lần tạo khác tới khi mặt giống model; keyframe đổi → video motion của đoạn đó phải tạo lại (web dừng duyệt lại). </>}
            Thử lại hoặc chọn lần tạo khác ở cột video motion → web dừng lại để bạn kiểm tra, bấm Tiếp tục mới thay bối cảnh lại cho đoạn đó và ghép lại. Đổi ở cột thay bối cảnh → chỉ ghép lại.
          </small>
          {error && <div className="err">{error}</div>}
        </>
      )}
    </div>
  );
}

// Tạo video motion bằng tay trên Flow (khi Flow chặn phiên tự động): tải đúng các nguyên liệu web đã chuẩn bị
// (keyframe hoặc ảnh model, ảnh sản phẩm, đoạn gốc), chép prompt đã ghép, rồi nhập video kết quả ngay tại chỗ
// (đi qua đúng đường "Thay bằng video từ máy" nên thay nền + ghép vẫn tự chạy tiếp). Tự mở khi job motion bị Flow chặn.
function ManualFlowBox({ run: r, row, index, jobs, state, busy, onImport }) {
  const motionJob = row.motion && jobs[row.motion.id];
  const blocked = motionJob?.status === 'failed' && /Flow chặn|unusual activity/i.test(motionJob.error || '');
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (blocked) setOpen(true); }, [blocked]);
  if (!open) {
    return <a className="small" onClick={() => setOpen(true)}>🖐 Tạo tay trên Flow{blocked ? ' (Flow chặn phiên tự động)' : ''}</a>;
  }
  const lock = r.options.identityLock;
  const clip = state.clips.find((c) => c.id === row.clipId);
  const asset = (id) => state.assets.find((a) => a.id === id);
  const product = asset(r.inputs?.product);
  const model = asset(r.inputs?.model);
  const keyframeJob = row.keyframe && jobs[row.keyframe.id];
  const ext = (u) => (u || '').split('?')[0].match(/\.[a-z0-9]+$/i)?.[0] || '';
  const n = index + 1;
  // Thứ tự tải lên Flow đúng như web gửi: ảnh 1 (keyframe | model) -> ảnh sản phẩm -> video gốc
  const files = [
    lock
      ? { label: `Ảnh 1 – keyframe đoạn #${n}`, url: keyframeJob?.outputUrl, name: `keyframe-${n}${ext(keyframeJob?.outputUrl) || '.png'}` }
      : { label: 'Ảnh 1 – ảnh model', url: model?.url, name: `model${ext(model?.url)}` },
    product && { label: 'Ảnh 2 – sản phẩm', url: product.url, name: `san-pham${ext(product.url)}` },
    { label: `Video gốc – đoạn #${n}`, url: clip?.url, name: `doan-${n}${ext(clip?.url) || '.mp4'}` },
  ].filter(Boolean);
  // Prompt đúng như web đã/sẽ gửi: của job motion nếu có, không thì prompt đã đóng băng của lần chạy
  const prompt = motionJob?.attempts?.at(-1)?.finalPrompt || motionJob?.prompt || r.prompts?.[lock ? 'motionKeyframe' : 'motion'] || '';
  const copy = async () => {
    try { await navigator.clipboard.writeText(prompt); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* không có clipboard: dùng ô bên dưới */ }
  };
  return (
    <div className="manual-box stack">
      <div className="row between">
        <b className="small">🖐 Tạo tay trên Flow – đoạn #{n}</b>
        <a className="small" onClick={() => setOpen(false)}>Đóng</a>
      </div>
      <ol className="small muted manual-steps">
        <li>Mở <a href="https://flow.google.com/?hl=en" target="_blank" rel="noreferrer">flow.google.com</a> trong Chrome <b>thường</b> (không phải cửa sổ do web mở), vào dự án bất kỳ.</li>
        <li>Tải các file dưới lên và thêm vào prompt <b>theo đúng thứ tự</b>.</li>
        <li>Chọn Video · Ingredients · Omni 1.1 Flash · {state.settings.aspectRatio || '9:16'} · {state.settings.flowResolution || '720p'}, dán prompt, bấm tạo.</li>
        <li>Tải video về rồi nhập ở ô cuối; web sẽ thay nền và ghép tiếp như thường.</li>
      </ol>
      <div className="row wrap">
        {files.map((f) => (
          f.url
            ? <a key={f.label} className="btn-link" href={f.url} download={f.name}>⬇ {f.label}</a>
            : <span key={f.label} className="muted small">{f.label}: chưa có</span>
        ))}
      </div>
      <div className="row">
        <button className="small-btn" onClick={copy} disabled={!prompt}>{copied ? '✓ Đã chép' : '📋 Chép prompt'}</button>
        <small className="muted">hoặc chọn hết trong ô dưới rồi chép</small>
      </div>
      <textarea readOnly rows={4} className="mono small" value={prompt} onFocus={(e) => e.target.select()} />
      <FileDrop accept="video/*" onFiles={onImport}>
        <button disabled={busy} className="small-btn primary">📥 Nhập video kết quả của đoạn #{n}</button>
      </FileDrop>
    </div>
  );
}

const RUN_STATUS = { running: ['Đang chạy', 'blue'], paused: ['Chờ bạn kiểm tra', 'amber'], done: ['Hoàn thành', 'green'], failed: ['Dừng vì lỗi', 'red'], cancelled: ['Đã huỷ', 'gray'] };

function RunCard({ run: r, state, refresh, go }) {
  const [showJobs, setShowJobs] = useState(false);
  const { busy, error, run } = useAction();
  const source = state.sources.find((s) => s.id === r.sourceId);
  const jobs = state.jobs.filter((j) => j.runId === r.id);
  const [label, color] = RUN_STATUS[r.status] || [r.status, 'gray'];
  const bgJob = r.background && jobs.find((j) => j.id === r.background.id);
  const sheetJob = r.identity && jobs.find((j) => j.id === r.identity.id);
  const act = (fn) => run(async () => { await fn(); await refresh(); });
  // Đang dừng ở bước nào thì lời nhắc / nút Tiếp tục nói về bước đó
  const pausedAtKeyframe = r.status === 'paused' && r.stage === 'keyframe';

  return (
    <div className={'card stack run' + (r.status === 'failed' ? ' failed' : '')}>
      <div className="row between">
        <div>
          <b>{source?.name || 'Video gốc đã xoá'}</b>{' '}
          <small className="muted">· {r.clipIds.length} đoạn · {new Date(r.createdAt).toLocaleString('vi-VN')}</small>
        </div>
        <span className={`badge ${color}`}>{label}</span>
      </div>

      <div className="stages">
        {r.stageList.map((s, i) => (
          <React.Fragment key={s.id}>
            {i > 0 && <span className="arrow">→</span>}
            <span className={'stage ' + s.status} title={s.label}>
              {s.status === 'done' ? '✓' : s.status === 'running' ? '⏳' : s.status === 'paused' ? '⏸' : s.status === 'skipped' ? '–' : '○'} {s.label}
              {s.total > 1 && <small> {s.done}/{s.total}</small>}
            </span>
          </React.Fragment>
        ))}
      </div>

      {(r.frameUrl || bgJob || r.backgroundUrl || sheetJob || r.identityUrl) && (
        <div className="row">
          {r.frameUrl && <figure className="mini"><img src={r.frameUrl} alt="" /><figcaption>Khung hình gốc</figcaption></figure>}
          {sheetJob ? (
            // Bảng mặt 360° tạo trong lần chạy này: Thử lại / Sửa prompt / chọn lần tạo (các keyframe đã tạo không tự làm lại)
            <div className="stack bg-job sheet-job">
              <small className="muted">Bảng mặt 360° (khoá nhận diện)</small>
              <JobCard compact job={sheetJob} refresh={refresh} />
              <small className="muted">Bảng mới chỉ dùng cho keyframe tạo sau đó: muốn áp dụng, bấm Thử lại trên keyframe từng đoạn.</small>
            </div>
          ) : r.identityUrl && <figure className="mini wide"><img src={r.identityUrl} alt="" /><figcaption>Bảng mặt 360° (có sẵn)</figcaption></figure>}
          {bgJob ? (
            // Thẻ job ảnh bối cảnh: Thử lại / Sửa prompt / chọn lần tạo. Đổi bối cảnh → web tự thay nền lại cho mọi đoạn.
            <div className="stack bg-job">
              <small className="muted">Bối cảnh mới</small>
              <JobCard compact job={bgJob} refresh={refresh} />
              <small className="muted">Thử lại hoặc chọn lần tạo khác → mọi đoạn phải thay bối cảnh lại (≈20 credit/đoạn) và ghép lại.</small>
            </div>
          ) : r.backgroundUrl && <figure className="mini"><img src={r.backgroundUrl} alt="" /><figcaption>Bối cảnh mới</figcaption></figure>}
          {r.merge?.url && (
            <figure className="mini">
              <video src={r.merge.url} controls preload="metadata" poster={r.merge.thumbUrl} />
              <figcaption>
                Video hoàn chỉnh
                {r.merge?.watermarkRemoved !== false && <span style={{ display: 'block', color: 'var(--green)', fontSize: 10 }}>✓ Đã xoá logo Gemini</span>}
              </figcaption>
            </figure>
          )}
        </div>
      )}

      {r.error && <div className="err">{r.error}</div>}
      {pausedAtKeyframe && (
        <div className="alert warn small">
          ⏸ Đã tạo keyframe cho từng đoạn (0 credit). Xem cột <b>Keyframe</b> ở bảng <b>Từng đoạn</b> bên dưới: mặt phải giống model, pose / outfit / bối cảnh giống khung hình gốc;
          chưa ưng thì <b>Thử lại</b> / <b>Sửa prompt</b> hoặc chọn lần tạo khác. Ưng rồi bấm <b>▶ Tiếp tục</b> để thay nhân vật theo keyframe (bước này bắt đầu tốn credit, ≈20 credit/đoạn).
        </div>
      )}
      {r.status === 'paused' && !pausedAtKeyframe && (
        <div className="alert warn small">
          ⏸ Đã thay nhân vật + sản phẩm xong. Xem video ở bảng <b>Từng đoạn</b> bên dưới; chưa ưng thì <b>Thử lại</b> / <b>Sửa prompt</b> hoặc thay bằng video từ máy.
          Ưng rồi bấm <b>▶ Tiếp tục</b> để thay bối cảnh (bước này bắt đầu tốn credit).
        </div>
      )}

      <ClipTable run={r} jobs={jobs} refresh={refresh} state={state} />

      <div className="row">
        {r.status === 'paused' && (
          <button className="primary" disabled={busy} onClick={() => act(() => api.resumeRun(r.id))}>
            {pausedAtKeyframe ? '▶ Tiếp tục: thay nhân vật theo keyframe' : '▶ Tiếp tục: thay bối cảnh'}
          </button>
        )}
        {r.status === 'failed' && <button className="primary" disabled={busy} onClick={() => act(() => api.resumeRun(r.id))}>▶ Tiếp tục</button>}
        {r.status === 'cancelled' && <button disabled={busy} onClick={() => act(() => api.resumeRun(r.id))}>▶ Chạy tiếp</button>}
        {(r.status === 'running' || r.status === 'paused') && <button disabled={busy} onClick={() => act(() => api.cancelRun(r.id))}>⏹ Huỷ</button>}
        {r.merge?.status === 'done' && <button className="primary" onClick={() => go('publish', [r.merge.id])}>🚀 Đăng video →</button>}
        {r.merge?.status === 'done' && <button onClick={() => go('merge')}>Xem ở Ghép video</button>}
        <button className="link" onClick={() => setShowJobs(!showJobs)}>{showJobs ? 'Ẩn' : 'Xem'} {jobs.length} video của lần chạy</button>
        <span className="grow" />
        <ConfirmButton disabled={r.status === 'running'} armedText="Xoá cả lần chạy và video?" onConfirm={() => act(() => api.deleteRun(r.id))}>Xoá</ConfirmButton>
      </div>
      {error && <div className="err">{error}</div>}

      {showJobs && <JobList jobs={jobs} refresh={refresh} />}
    </div>
  );
}
