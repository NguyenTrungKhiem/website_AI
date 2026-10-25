// Trang chạy 1 quy trình tự động (AI Dancing…). Giao diện dựng từ mô tả quy trình do server gửi (wf),
// nên thêm quy trình mới ở server/workflows là tự có trang riêng.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { AssetPicker, ConfirmButton, FileDrop, JobCard, JobList, fmt, useAction } from '../components.jsx';

export default function WorkflowPage({ state, refresh, go, wf }) {
  const [sourceId, setSourceId] = useState(state.sources[0]?.id || null);
  const [clipIds, setClipIds] = useState([]);
  const [inputs, setInputs] = useState({});
  const [clipInputs, setClipInputs] = useState({}); // ảnh riêng từng đoạn: { [clipId]: { [key]: assetId } }
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
  const selectedClips = clips.filter((c) => clipIds.includes(c.id));
  const perClip = wf.perClipInputs || [];
  const missing = wf.inputs.filter((i) => i.required && !inputs[i.key]).map((i) => i.label);
  const missingClips = perClip.length
    ? selectedClips.filter((c) => perClip.some((inp) => inp.required && !clipInputs[c.id]?.[inp.key])).length
    : 0;

  const start = () =>
    run(async () => {
      await api.createRun({ workflowId: wf.id, sourceId, clipIds, inputs, clipInputs, options });
      await refresh();
    });

  return (
    <section>
      <h1>{wf.icon} {wf.name}</h1>
      <p className="muted">{wf.description}</p>
      <p className="small muted">
        Đang tạo bằng: <b>{engine === 'mock' ? 'engine giả (thử nghiệm)' : 'Google Flow tự động'}</b>
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
        {perClip.length > 0 && selectedClips.length > 0 && (
          <ClipInputsTable
            clips={selectedClips}
            perClipInputs={perClip}
            value={clipInputs}
            onChange={setClipInputs}
            state={state}
            refresh={refresh}
          />
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
        <button className="primary big" disabled={busy || !clipIds.length || missing.length > 0 || missingClips > 0} onClick={start}>
          ▶ Chạy {wf.name} cho {clipIds.length} đoạn
        </button>
        {missing.length > 0 && <span className="muted small">Cần chọn: {missing.join(', ')}</span>}
        {missingClips > 0 && <span className="muted small">Còn {missingClips} đoạn chưa chọn trang phục</span>}
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

// Bảng chọn ảnh riêng cho từng đoạn (vd. Thay trang phục: mặt trước bắt buộc, mặt sau tuỳ chọn).
// Bấm ô ảnh để mở thư viện chọn; "↓ áp cho các đoạn sau" chép ảnh của đoạn này xuống các đoạn kế tiếp.
function ClipInputsTable({ clips, perClipInputs, value, onChange, state, refresh }) {
  const [picking, setPicking] = useState(null); // { clipId, key }
  const assetOf = (id) => state.assets.find((a) => a.id === id);
  const set = (clipId, key, assetId) => onChange((v) => ({ ...v, [clipId]: { ...(v[clipId] || {}), [key]: assetId } }));
  const fillDown = (fromIdx, key) => {
    const src = value[clips[fromIdx].id]?.[key];
    if (!src) return;
    onChange((v) => {
      const next = { ...v };
      for (const c of clips.slice(fromIdx + 1)) next[c.id] = { ...(next[c.id] || {}), [key]: src };
      return next;
    });
  };
  const inp = picking && perClipInputs.find((i) => i.key === picking.key);
  return (
    <div className="stack">
      <b>Trang phục cho từng đoạn</b>
      <table className="table clip-inputs">
        <thead>
          <tr>
            <th>Đoạn</th>
            {perClipInputs.map((i) => <th key={i.key}>{i.label}{i.required ? ' *' : ''}</th>)}
          </tr>
        </thead>
        <tbody>
          {clips.map((c, idx) => (
            <tr key={c.id}>
              <td className="clip-name">
                <div className="row">
                  <img className="mini-thumb" src={c.thumbUrl} alt="" />
                  <div><b>#{idx + 1}</b><div className="small muted">{c.name} · {fmt(c.end - c.start)}</div></div>
                </div>
              </td>
              {perClipInputs.map((i) => {
                const a = assetOf(value[c.id]?.[i.key]);
                return (
                  <td key={i.key}>
                    <div className="row">
                      <div className={'thumb pick' + (a ? '' : ' empty') + (i.required && !a ? ' missing' : '')} onClick={() => setPicking({ clipId: c.id, key: i.key })} title={a ? a.name : 'Bấm để chọn ảnh'}>
                        {a ? <img src={a.url} alt="" /> : <span>+ Chọn</span>}
                      </div>
                      <div className="stack gap-xs">
                        {a && <a onClick={() => set(c.id, i.key, null)}>Bỏ</a>}
                        {a && idx < clips.length - 1 && <a onClick={() => fillDown(idx, i.key)} title="Dùng ảnh này cho các đoạn sau">↓ áp cho đoạn sau</a>}
                      </div>
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {picking && (
        <div className="lightbox" onClick={() => setPicking(null)}>
          <div className="lightbox-body chooser" onClick={(e) => e.stopPropagation()}>
            <button className="lightbox-close" onClick={() => setPicking(null)} title="Đóng">×</button>
            <div className="lightbox-side stack">
              <b>Chọn {inp?.label} cho {clips.find((c) => c.id === picking.clipId)?.name}</b>
              <AssetPicker
                kind={inp?.kind || 'product'}
                label="Thư viện ảnh"
                assets={state.assets}
                value={value[picking.clipId]?.[picking.key] || null}
                onChange={(id) => { if (id) { set(picking.clipId, picking.key, id); setPicking(null); } }}
                refresh={refresh}
                state={state}
              />
            </div>
          </div>
        </div>
      )}
    </div>
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

// Từng đoạn của lần chạy: video motion → video đã thay nền. Mỗi ô là thẻ video thu gọn:
// xem video, các lần tạo (chọn bản tốt nhất), Thử lại / Sửa prompt. Có nút thay video motion bằng file từ máy.
function ClipTable({ run: r, jobs, refresh }) {
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
                    {row.inputs && Object.values(row.inputs).some(Boolean) && (
                      <div className="row gap-xs" title="Ảnh riêng của đoạn này">
                        {Object.entries(row.inputs).map(([k, a]) => a && <img key={k} className="mini-thumb" src={a.url} alt="" title={a.name} />)}
                      </div>
                    )}
                    <FileDrop accept="video/*" multiple onFiles={(files) => replaceWith(row.clipId, files)}>
                      <button disabled={busy} className="small-btn" title="Thay video motion của đoạn này bằng file từ máy; chọn nhiều file thì các file sau thay các đoạn kế tiếp">
                        📥 Thay bằng video từ máy
                      </button>
                    </FileDrop>
                  </td>
                  <td>{cell(row.motion)}</td>
                  {r.options.replaceBackground && <td>{cell(row.replace)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
          <small className="muted">
            Thử lại hoặc chọn lần tạo khác ở cột trái → web dừng lại để bạn kiểm tra, bấm Tiếp tục mới thay bối cảnh lại cho đoạn đó và ghép lại. Đổi ở cột phải → chỉ ghép lại.
          </small>
          {error && <div className="err">{error}</div>}
        </>
      )}
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
  const act = (fn) => run(async () => { await fn(); await refresh(); });

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

      {(r.frameUrl || bgJob || r.backgroundUrl) && (
        <div className="row">
          {r.frameUrl && <figure className="mini"><img src={r.frameUrl} alt="" /><figcaption>Khung hình gốc</figcaption></figure>}
          {r.anchorUrl && <figure className="mini"><img src={r.anchorUrl} alt="" /><figcaption>Mặt đã render (đoạn 1) làm mẫu cho đoạn sau</figcaption></figure>}
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
      {r.status === 'paused' && (
        <div className="alert warn small">
          ⏸ Đã thay nhân vật + sản phẩm xong. Xem video ở bảng <b>Từng đoạn</b> bên dưới; chưa ưng thì <b>Thử lại</b> / <b>Sửa prompt</b> hoặc thay bằng video từ máy.
          Ưng rồi bấm <b>▶ Tiếp tục</b> để thay bối cảnh (bước này bắt đầu tốn credit).
        </div>
      )}

      <ClipTable run={r} jobs={jobs} refresh={refresh} />

      <div className="row">
        {r.status === 'paused' && <button className="primary" disabled={busy} onClick={() => act(() => api.resumeRun(r.id))}>▶ Tiếp tục: thay bối cảnh</button>}
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
