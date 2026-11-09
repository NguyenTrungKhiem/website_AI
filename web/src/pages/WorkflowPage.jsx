// Trang chạy 1 quy trình tự động (AI Dancing…). Giao diện dựng từ mô tả quy trình do server gửi (wf),
// nên thêm quy trình mới ở server/workflows là tự có trang riêng.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { AssetPicker, ConfirmButton, FileDrop, ImageZoom, JobCard, JobList, PromptVersionPicker, fmt, useAction } from '../components.jsx';
import FashionSalesView from './FashionSalesView.jsx';

export default function WorkflowPage({ state, refresh, go, wf }) {
  if (wf?.id === 'video-thoi-trang') {
    return <FashionSalesView wf={wf} state={state} refresh={refresh} go={go} />;
  }

  const draftKey = `wf_draft_${wf.id}`;
  const savedWfDraft = useMemo(() => {
    try {
      const raw = localStorage.getItem(draftKey);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }, [draftKey]);

  const [sourceId, setSourceId] = useState(() => savedWfDraft?.sourceId || state.sources[0]?.id || null);
  const [clipIds, setClipIds] = useState(() => savedWfDraft?.clipIds || []);
  const [inputs, setInputs] = useState(() => savedWfDraft?.inputs || {});
  const [clipInputs, setClipInputs] = useState(() => savedWfDraft?.clipInputs || {}); // ảnh riêng từng đoạn: { [clipId]: { [key]: assetId } }
  const [options, setOptions] = useState(() => savedWfDraft?.options || Object.fromEntries(wf.options.map((o) => [o.key, o.default])));
  const { busy, error, run } = useAction();

  // Tự động lưu nháp dữ liệu vào localStorage khi người dùng chọn/nhập
  useEffect(() => {
    try {
      localStorage.setItem(draftKey, JSON.stringify({ sourceId, clipIds, inputs, clipInputs, options }));
    } catch {}
  }, [draftKey, sourceId, clipIds, inputs, clipInputs, options]);

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
  const noVideo = !!wf.noVideo; // quy trình chỉ làm ảnh
  const isEmpty = (inp) => (inp.multiple ? !(inputs[inp.key]?.length) : !inputs[inp.key]);
  const missing = wf.inputs.filter((i) => i.required && isEmpty(i)).map((i) => i.label);
  // Quy trình cần ảnh mặt sau cho từng trang phục: chưa chọn và cũng chưa có ảnh mặt sau tạo từ ảnh đó -> chưa chạy được
  if (wf.backInput && wf.codedInput) {
    const backOf = (frontId) => inputs[wf.backInput]?.[frontId] || state.assets.find((a) => a.fromAssetId === frontId && (a.isBackView || /Mặt sau Flow/.test(a.name || '')))?.id;
    (inputs[wf.codedInput] || []).forEach((id, i) => { if (!backOf(id)) missing.push(`Mặt sau trang phục ${i + 1}`); });
  }
  const outfitCount = wf.inputs.find((i) => i.multiple) ? (inputs[wf.inputs.find((i) => i.multiple).key]?.length || 0) : 0;
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

      {!noVideo && <div className="card stack">
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
      </div>}

      <div className="card stack">
        <b>{noVideo ? '1' : '2'}. Ảnh tham chiếu</b>
        <div className="grid2">
          {wf.inputs.map((inp) => (
            <AssetPicker
              key={inp.key}
              kind={inp.kind}
              label={inp.label + (inp.required ? ' *' : '')}
              assets={state.assets}
              multiple={!!inp.multiple}
              hide={inp.hideBackViews ? (a) => a.isBackView || /Mặt sau Flow/.test(a.name || '') : null}
              value={inputs[inp.key] || (inp.multiple ? [] : null)}
              onChange={(v) => setInputs((s) => ({ ...s, [inp.key]: inp.multiple && inp.max && Array.isArray(v) ? v.slice(0, inp.max) : v }))}
              refresh={refresh}
              state={state}
            />
          ))}
        </div>
        {wf.codedInput && (inputs[wf.codedInput]?.length || 0) > 0 && (
          <OutfitCodes
            ids={inputs[wf.codedInput]}
            backs={wf.backInput ? inputs[wf.backInput] || {} : null}
            onBacks={wf.backInput ? (v) => setInputs((s) => ({ ...s, [wf.backInput]: v })) : null}
            state={state}
            refresh={refresh}
          />
        )}
      </div>

      <div className="card stack">
        <b>{noVideo ? '2' : '3'}. Tuỳ chọn</b>
        {wf.options.map((o) =>
          Array.isArray(o.options) ? (
            // Tuỳ chọn dạng chọn 1 trong danh sách (vd. Chuyển động, Mô hình Flow)
            <label key={o.key} className="row" style={{ gap: 8, alignItems: 'center' }}>
              <span>{o.label}</span>
              <select value={options[o.key] ?? o.default ?? ''} onChange={(e) => setOptions((s) => ({ ...s, [o.key]: e.target.value }))}>
                {o.options.map((opt) => {
                  const v = typeof opt === 'string' ? opt : opt.value;
                  return <option key={v} value={v}>{typeof opt === 'string' ? opt : opt.label}</option>;
                })}
              </select>
            </label>
          ) : (
            <label key={o.key} className="check">
              <input type="checkbox" checked={!!options[o.key]} onChange={(e) => setOptions((s) => ({ ...s, [o.key]: e.target.checked }))} />
              {o.label}
            </label>
          ),
        )}
        <PromptEditor wf={wf} settings={state.settings} refresh={refresh} />
      </div>

      <div className="row">
        <button className="primary big" disabled={busy || (!noVideo && !clipIds.length) || missing.length > 0 || missingClips > 0} onClick={start}>
          ▶ Chạy {wf.name} {noVideo ? (outfitCount ? `– ${outfitCount} ảnh` : '') : `cho ${clipIds.length} đoạn`}
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

// Từng ảnh trang phục đã chọn (quy trình có codedInput, vd. Video thời trang không voice): mã sản phẩm in làm caption
// (ảnh chưa có mã thì server tự cấp khi chạy; sửa ở đây lưu lên ảnh) và, khi quy trình cần (backInput), ảnh MẶT SAU của bộ đó:
// tự lấy ảnh mặt sau đã tạo từ ảnh mặt trước, hoặc bấm "Tạo mặt sau" (Flow, 0 credit, như quy trình có voice), hoặc chọn ảnh khác.
function OutfitCodes({ ids, backs, onBacks, state, refresh }) {
  const { busy, error, run } = useAction();
  const [drafts, setDrafts] = useState({});
  const [pendingBack, setPendingBack] = useState({}); // { frontId: jobId } đang tạo mặt sau
  const normalize = (v) => String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toUpperCase().replace(/[\s.]+/g, '_').replace(/[^A-Z0-9_-]/g, '');
  const assetOf = (id) => state.assets.find((a) => a.id === id);
  const isBack = (a) => a.isBackView || /Mặt sau Flow/.test(a.name || '');
  const generatedBacks = (frontId) => state.assets.filter((a) => a.fromAssetId === frontId && isBack(a));
  const backOf = (frontId) => backs?.[frontId] || generatedBacks(frontId)[0]?.id || null;
  const products = state.assets.filter((a) => a.kind === 'product' && !a.staging);
  const save = (id) =>
    run(async () => {
      const code = normalize(drafts[id]);
      if (!code) return;
      await api.assignCode(id, code);
      setDrafts((d) => { const n = { ...d }; delete n[id]; return n; });
      await refresh();
    });
  const assign = (id) => run(async () => { await api.assignCode(id); await refresh(); });
  const renderBack = (id) =>
    run(async () => {
      const res = await api.renderBackAsset(id, state.defaults?.backViewPrompt);
      setPendingBack((p) => ({ ...p, [id]: res.id }));
      await refresh();
    });
  // Ảnh mới nhất đã xong trên Flow -> lưu làm mặt sau của bộ này và chọn luôn (khi Flow tạo xong mà tải về lỗi / tạo tay)
  const backFromFlow = (id) =>
    run(async () => {
      const a = await api.backFromFlow(id);
      if (onBacks) onBacks({ ...(backs || {}), [id]: a.id });
      await refresh();
    });
  // Job tạo mặt sau xong -> gắn luôn ảnh mới vào bộ đó
  useEffect(() => {
    for (const [frontId, jobId] of Object.entries(pendingBack)) {
      const job = state.jobs?.find((j) => j.id === jobId);
      if (!job || job.status === 'running' || job.status === 'queued') continue;
      setPendingBack((p) => { const n = { ...p }; delete n[frontId]; return n; });
      const a = state.assets.find((x) => x.fromJobId === jobId) || (job.meta?.assetId && assetOf(job.meta.assetId));
      if (a && onBacks) onBacks({ ...(backs || {}), [frontId]: a.id });
    }
  }, [state.jobs, state.assets]);
  // Đang tạo thì làm mới nhanh để thấy tiến trình
  useEffect(() => {
    if (!Object.keys(pendingBack).length) return;
    const t = setInterval(refresh, 1500);
    return () => clearInterval(t);
  }, [Object.keys(pendingBack).join(','), refresh]);

  return (
    <div className="stack outfit-codes">
      <b className="small">🏷️ Từng trang phục: mã sản phẩm in trên video{backs ? ' · ảnh mặt sau (cho đoạn quay lưng)' : ''}</b>
      <div className="stack" style={{ gap: 8 }}>
        {ids.map((id, i) => {
          const a = assetOf(id);
          if (!a) return null;
          const value = drafts[id] ?? a.productCode ?? '';
          const backId = backs ? backOf(id) : null;
          const back = backId && assetOf(backId);
          const job = pendingBack[id] && state.jobs?.find((j) => j.id === pendingBack[id]);
          return (
            <div key={id} className="row outfit-code" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <img src={a.url} alt="" className="mini-thumb" title={a.name} />
              <div className="stack" style={{ gap: 2 }}>
                <small className="muted">Bộ {i + 1} · {a.name.slice(0, 28)}</small>
                <div className="row" style={{ gap: 4 }}>
                  <input
                    className="mono"
                    style={{ width: 120, fontWeight: 700 }}
                    placeholder="VAY_01"
                    value={value}
                    onChange={(e) => setDrafts((d) => ({ ...d, [id]: normalize(e.target.value) }))}
                    onBlur={() => drafts[id] != null && drafts[id] !== a.productCode && save(id)}
                    onKeyDown={(e) => e.key === 'Enter' && e.target.blur()}
                    title="Mã dạng LOAI_SO (không dấu, in hoa); rời ô để lưu lên ảnh"
                  />
                  {!a.productCode && <button className="small-btn" disabled={busy} onClick={() => assign(id)} title="Server cấp mã tiếp theo theo loại sản phẩm">Cấp mã</button>}
                </div>
              </div>
              {backs && (
                <div className="row" style={{ gap: 6, alignItems: 'center' }}>
                  <span className="small muted">Mặt sau:</span>
                  {back ? <img src={back.url} alt="" className="mini-thumb" title={back.name} /> : <span className="mini-thumb placeholder-thumb" title="Chưa có ảnh mặt sau">?</span>}
                  <select
                    value={backId || ''}
                    onChange={(e) => onBacks({ ...(backs || {}), [id]: e.target.value || undefined })}
                    title="Chọn ảnh mặt sau trong thư viện (ảnh tạo từ mặt trước được xếp đầu)"
                    style={{ maxWidth: 180 }}
                  >
                    <option value="">— chọn ảnh mặt sau —</option>
                    {[...generatedBacks(id), ...products.filter((p) => p.id !== id && !generatedBacks(id).includes(p))].map((p) => (
                      <option key={p.id} value={p.id}>{(isBack(p) ? '↩ ' : '') + p.name.slice(0, 40)}</option>
                    ))}
                  </select>
                  <button className="small-btn" disabled={busy || !!job} onClick={() => renderBack(id)} title="Tạo ảnh mặt sau từ ảnh mặt trước bằng Flow (Nano Banana, 0 credit)">
                    {job ? `⏳ ${job.attempts?.at(-1)?.progress || 'Đang tạo…'}` : '✨ Tạo mặt sau'}
                  </button>
                  <button className="small-btn" disabled={busy} onClick={() => backFromFlow(id)} title="Lấy ảnh mới nhất đã render xong trong cửa sổ Chrome Google Flow về làm mặt sau của bộ này (khi Flow tạo xong mà tải về lỗi, hoặc bạn tự tạo bằng tay)">
                    📥 Lấy mặt sau từ Flow
                  </button>
                  {job?.status === 'failed' && <span className="err small">{job.error}</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <small className="muted">
        Mã: ảnh chưa có mã sẽ được cấp tự động khi chạy; mã gắn với ảnh nên lần sau dùng lại là có.
        {backs && <> Mặt sau: không chọn thì quy trình tự lấy ảnh mặt sau mới nhất đã tạo từ ảnh mặt trước đó; chưa có thì phải tạo trước khi chạy.</>}
      </small>
      {error && <div className="err small">{error}</div>}
    </div>
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

  const hasCustom = Object.keys(draft).some((k) => (draft[k] || '').trim() && draft[k] !== wf.prompts[k]?.text);

  return (
    <div className="stack">
      <div className="row between" style={{ alignItems: 'center' }}>
        <a onClick={() => setOpen(!open)}>{open ? '▾' : '▸'} Prompt mẫu của quy trình ({Object.keys(wf.prompts).length} bước)</a>
        {open && hasCustom && (
          <button
            type="button"
            className="small"
            onClick={() => setDraft({})}
            style={{ padding: '2px 8px', fontSize: 11 }}
            title="Khôi phục toàn bộ các bước về prompt mẫu gốc"
          >
            🔄 Reset tất cả về prompt gốc
          </button>
        )}
      </div>
      {open && (
        <div className="stack wf-prompts">
          {Object.entries(wf.prompts).map(([key, p]) => {
            const custom = (draft[key] || '').trim() && draft[key] !== p.text;
            return (
              <label key={key}>
                <span className="row between">
                  <b>{p.label}</b>
                  {custom && (
                    <button
                      type="button"
                      className="small"
                      onClick={() => setDraft((d) => ({ ...d, [key]: '' }))}
                      style={{ padding: '2px 8px', fontSize: 11 }}
                      title="Khôi phục bước này về prompt gốc"
                    >
                      🔄 Reset về prompt gốc
                    </button>
                  )}
                </span>
                <textarea rows={8} className="mono" value={draft[key] || p.text} onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))} />
                <PromptVersionPicker wfId={wf.id} promptKey={key} reload={saved[key] || ''} onRestored={(t) => { setDraft((d) => ({ ...d, [key]: t })); refresh(); }} />
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
                    <div className="row gap-xs" style={{ marginTop: 4, flexWrap: 'wrap' }}>
                      <FileDrop accept="video/*" multiple onFiles={(files) => replaceWith(row.clipId, files)}>
                        <button disabled={busy} className="small-btn" title="Thay video motion của đoạn này bằng file từ máy; chọn nhiều file thì các file sau thay các đoạn kế tiếp">
                          📁 Từ máy
                        </button>
                      </FileDrop>
                      <button
                        type="button"
                        disabled={busy}
                        className="small-btn"
                        title="Lấy video mới nhất vừa render xong trên Google Flow gán cho đoạn này"
                        onClick={() => act(async () => {
                          await api.importFlowRun(r.id, { clipId: row.clipId });
                          await refresh();
                        })}
                      >
                        📥 Lấy từ Flow
                      </button>
                    </div>
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

// Ảnh kết quả của quy trình chỉ làm ảnh: mỗi ảnh là thẻ job thu gọn (xem, Thử lại, chọn lần tạo) + tải về + lưu làm ảnh model
function OutputGallery({ run: r, jobs, refresh }) {
  const { busy, error, run } = useAction();
  const byId = useMemo(() => Object.fromEntries(jobs.map((j) => [j.id, j])), [jobs]);
  const [savedMsg, setSavedMsg] = useState('');
  const [zoom, setZoom] = useState(null); // { key, coded } ảnh kết quả đang phóng to (coded = xem bản có mã)
  const zoomOut = zoom && r.outputs.find((o) => o.key === zoom.key);
  const saveAs = (assetId, kind) =>
    run(async () => {
      await api.copyAsset(assetId, kind);
      await refresh();
      setSavedMsg(kind === 'model' ? 'Đã lưu vào thư viện ảnh model' : 'Đã lưu');
      setTimeout(() => setSavedMsg(''), 2500);
    });
  return (
    <div className="stack">
      <b>Ảnh kết quả ({r.outputs.filter((o) => o.status === 'done').length}/{r.outputs.length})</b>
      <div className="outputs">
        {r.outputs.map((o) => {
          const job = byId[o.id];
          return (
            <div key={o.key} className="output stack">
              <small className="ellipsis" title={o.label}>
                {o.code && <span className="code-chip" style={{ marginTop: 0, marginRight: 6 }}>{o.code}</span>}
                {o.label}
              </small>
              {job ? (
                <div className="zoomable" onClick={(e) => { if (o.outputUrl && e.target.tagName === 'IMG') setZoom({ key: o.key, coded: false }); }} title={o.outputUrl ? 'Bấm vào ảnh để phóng to' : undefined}>
                  <JobCard compact job={job} refresh={refresh} />
                </div>
              ) : <span className="muted">–</span>}
              {o.outputUrl && (
                <div className="row gap-xs" style={{ flexWrap: 'wrap' }}>
                  <a onClick={() => setZoom({ key: o.key, coded: false })} title="Xem ảnh to">🔍 Phóng to</a>
                  <a href={o.outputUrl} download>Tải về</a>
                  {o.codedUrl && <a href={o.codedUrl} download title="Ảnh kết quả đã in mã sản phẩm (khung đen mờ, chữ trắng)">🏷️ Tải ảnh có mã</a>}
                  {o.code && o.codedStale && <span className="warn-text" title="Mã / vị trí khung đổi hoặc ảnh render mới — sẽ in lại khi lần chạy tiếp tục">⚠ chưa in mã mới</span>}
                  {o.assetId && <a onClick={() => saveAs(o.assetId, 'model')} title="Sao chép vào thư viện ảnh model để dùng cho AI Dancing / Thay trang phục">Lưu làm ảnh model</a>}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {savedMsg && <span className="ok small">{savedMsg}</span>}
      {error && <div className="err">{error}</div>}
      {zoomOut?.outputUrl && (
        <ImageZoom
          url={zoom.coded && zoomOut.codedUrl ? zoomOut.codedUrl : zoomOut.outputUrl}
          name={`${zoomOut.code ? `[${zoomOut.code}] ` : ''}${zoomOut.label}${zoom.coded ? ' (có mã)' : ''}`}
          downloadUrl={zoom.coded && zoomOut.codedUrl ? zoomOut.codedUrl : zoomOut.outputUrl}
          onClose={() => setZoom(null)}
        >
          {zoomOut.codedUrl && (
            <button className="small" onClick={() => setZoom((z) => ({ ...z, coded: !z.coded }))}>
              {zoom.coded ? 'Xem ảnh gốc' : '🏷️ Xem ảnh có mã'}
            </button>
          )}
        </ImageZoom>
      )}
      <small className="muted">Bấm vào ảnh hoặc 🔍 để phóng to. Ảnh được tải về từ Flow ở bản 2K Upscaled (≈1536×2752). Mỗi ảnh có nút Thử lại / chọn lần tạo như video. Ảnh kết quả đã được lưu vào thư viện (loại lookbook); bấm "Lưu làm ảnh model" nếu muốn dùng nó cho các quy trình video.{r.hasProductInputs && <> Bấm <b>🏷️ Mã & sản phẩm</b> để đặt mã in lên từng ảnh và tải Excel (tên, giá, link Shopee có sẵn từ lúc lấy ảnh trang phục) cho DiamondShop.</>}</small>
    </div>
  );
}

// ---------- Mã & sản phẩm (Ảnh model mặc đồ): khung mã in lên ảnh kết quả + Excel cho DiamondShop ----------
const BADGE_FONT = "'Segoe UI', Roboto, Arial, sans-serif";
// Mã dạng LOAI_SO như video thời trang (server/productCodes.js): bỏ dấu, in hoa, khoảng trắng/chấm -> "_"
const normalizeCodeInput = (v) =>
  String(v || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'D')
    .toUpperCase()
    .replace(/[\s.]+/g, '_')
    .replace(/[^A-Z0-9_-]/g, '');
const isValidCode = (c) => /^[A-Z0-9]+(?:_[A-Z0-9-]+)+$/.test(c || '');

function badgeMetrics(frameH, scale = 1) {
  const font = Math.max(10, Math.round((frameH || 1280) * 0.036 * (Number(scale) || 1)));
  return { font, padX: Math.round(font * 0.6), padY: Math.round(font * 0.32), radius: Math.round(font * 0.38) };
}
function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) return ctx.roundRect(x, y, w, h, r);
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
// PNG (data URL) của khung mã: nền đen mờ 55% bo góc nhẹ, chữ trắng đậm, vẽ ở kích thước thật của ảnh kết quả
function renderBadgePng(code, frame, scale) {
  const m = badgeMetrics(frame.height, scale);
  const canvas = document.createElement('canvas');
  let ctx = canvas.getContext('2d');
  ctx.font = `700 ${m.font}px ${BADGE_FONT}`;
  const textW = Math.ceil(ctx.measureText(code).width);
  canvas.width = textW + m.padX * 2;
  canvas.height = Math.round(m.font * 1.25) + m.padY * 2;
  ctx = canvas.getContext('2d'); // đổi kích thước canvas thì context bị đặt lại
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  roundRectPath(ctx, 0, 0, canvas.width, canvas.height, m.radius);
  ctx.fill();
  ctx.font = `700 ${m.font}px ${BADGE_FONT}`;
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(code, canvas.width / 2, canvas.height / 2 + m.font * 0.04);
  return canvas.toDataURL('image/png');
}

// Ảnh kết quả + khung mã vẽ đè đúng tỷ lệ; kéo thả (hoặc bấm) để đặt tâm khung (x, y = tỷ lệ 0–1)
function BadgePreview({ frameUrl, frame, code, badge, onChange }) {
  const ref = useRef();
  const [dragging, setDragging] = useState(false);
  const ar = frame.width / frame.height || 9 / 16;
  // Ô xem trước: cao tối đa 240px, rộng tối đa 320px, giữ đúng tỷ lệ khung hình
  let h = 240;
  let pw = Math.round(h * ar);
  if (pw > 320) { pw = 320; h = Math.round(pw / ar); }
  const k = h / frame.height; // 1px khung hình thật = k px xem trước
  const m = badgeMetrics(frame.height, badge.scale);
  const place = (e) => {
    const rect = ref.current.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    onChange({ x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 });
  };
  const down = (e) => { e.preventDefault(); ref.current.setPointerCapture?.(e.pointerId); setDragging(true); place(e); };
  const move = (e) => { if (dragging) place(e); };
  const up = () => setDragging(false);
  return (
    <div
      ref={ref}
      className={'badge-preview' + (dragging ? ' dragging' : '')}
      style={{ width: pw, height: h }}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      title="Kéo / bấm để đặt vị trí khung mã"
    >
      {frameUrl ? <img src={frameUrl} alt="" draggable={false} /> : <div className="no-frame">Chưa có ảnh kết quả (đang render)</div>}
      <div
        className="code-badge"
        style={{
          left: `${badge.x * 100}%`,
          top: `${badge.y * 100}%`,
          fontSize: Math.max(6, m.font * k),
          padding: `${m.padY * k}px ${m.padX * k}px`,
          borderRadius: m.radius * k,
          opacity: code ? 1 : 0.4,
        }}
      >
        {code || 'MÃ'}
      </div>
    </div>
  );
}

// Bảng "Mã & sản phẩm" của 1 lần chạy Ảnh model mặc đồ: mỗi ảnh trang phục một dòng (mã, tên, giá, mô tả, ảnh chính, link,
// khung mã), lưu & in mã lên từng ảnh kết quả, tải Excel cho Admin DiamondShop. Dữ liệu từ GET /api/runs/:id/products
// (key = id ảnh trang phục; tên / giá / link lấy từ metadata Shopee của ảnh đó; mã theo sổ mã chung VAY_01…).
function ProductCodeSheet({ run: r, refresh, onClose }) {
  const [frame, setFrame] = useState(null); // { width, height } của ảnh kết quả
  const [rows, setRows] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(null); // { at, remerge } sau khi lưu
  const [copied, setCopied] = useState(false);
  const { busy, error, run, setError } = useAction();

  useEffect(() => {
    let alive = true;
    api.runProducts(r.id)
      .then((d) => { if (!alive) return; setFrame(d.frame); setRows(d.rows); })
      .catch((e) => alive && setError(e.message));
    return () => { alive = false; };
  }, [r.id]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'INPUT') onClose(); };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [onClose]);
  // Bước "In mã lên ảnh" xong / in lại (ảnh có mã trên thẻ lần chạy đổi) -> tải lại dòng để ảnh thu nhỏ hiện bản đã in mã
  // (chỉ khi không có thay đổi đang sửa, để không đè dữ liệu người dùng đang gõ)
  const codedSig = (r.outputs || []).map((o) => `${o.outfitId}:${o.codedUrl || ''}:${o.codedStale ? 1 : 0}`).join('|');
  useEffect(() => {
    if (!rows || dirty) return;
    let alive = true;
    api.runProducts(r.id).then((d) => { if (alive) setRows(d.rows); }).catch(() => {});
    return () => { alive = false; };
  }, [codedSig]);

  const update = (key, patch) => { setRows((rs) => rs.map((x) => (x.key === key ? { ...x, ...patch } : x))); setDirty(true); };
  const updateBadge = (key, patch) => { setRows((rs) => rs.map((x) => (x.key === key ? { ...x, badge: { ...x.badge, ...patch } } : x))); setDirty(true); };
  const applyBadgeAll = (key) => {
    const b = rows.find((x) => x.key === key)?.badge;
    if (!b) return;
    setRows((rs) => rs.map((x) => ({ ...x, badge: { ...x.badge, x: b.x, y: b.y, scale: b.scale } })));
    setDirty(true);
  };
  const resuggest = (row) =>
    run(async () => {
      const taken = rows.filter((x) => x.key !== row.key).map((x) => x.code).filter(Boolean);
      const { code } = await api.suggestProductCode(row.name, taken);
      update(row.key, { code });
    });
  const codeOf = (row) => normalizeCodeInput(row.code).replace(/^_+|_+$/g, '');
  const dupCodes = new Set(rows ? rows.map(codeOf).filter((c, i, a) => c && a.indexOf(c) !== i) : []);
  const badCode = (row) => { const c = codeOf(row); return c && (!isValidCode(c) || dupCodes.has(c)); };
  const invalid = rows ? rows.filter(badCode).length : 0;
  const withCode = rows ? rows.filter((x) => codeOf(x)).length : 0;

  // Dữ liệu gửi server; withPng = kèm PNG khung mã vẽ bằng Canvas (lúc lưu; xuất Excel thử thì không cần)
  const payload = (withPng) =>
    Object.fromEntries(
      rows.map((x) => [
        x.key,
        {
          code: codeOf(x),
          name: x.name,
          price: x.price,
          description: x.description,
          mainImage: x.mainImage,
          category: x.category,
          badge: {
            x: x.badge.x,
            y: x.badge.y,
            scale: x.badge.scale,
            png: withPng && codeOf(x) && frame ? renderBadgePng(codeOf(x), frame, x.badge.scale) : null,
            frameWidth: frame?.width,
            frameHeight: frame?.height,
          },
        },
      ]),
    );
  const save = () =>
    run(async () => {
      const res = await api.saveRunProducts(r.id, { products: payload(true) });
      setRows(res.rows);
      setDirty(false);
      setSaved({ at: Date.now(), remerge: res.remerge });
      await refresh();
    });
  const download = () =>
    run(async () => {
      const { blob, filename } = await api.exportRunProducts(r.id, dirty ? { products: payload(false) } : null);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    });
  const copyCodes = async () => {
    try {
      await navigator.clipboard.writeText(rows.map((x) => `${codeOf(x)}\t${x.name}`).join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) { setError('Không sao chép được: ' + e.message); }
  };

  // Tiến trình in mã lên ảnh (RunCard nhận state mới mỗi vài giây nên r luôn mới)
  const badgeSt = r.stages?.badge?.status;
  const printing = r.status === 'running' && (r.stage === 'badge' || badgeSt === 'running' || badgeSt === 'pending');
  const outputs = r.outputs || [];
  const codedCodes = outputs.filter((o) => o.codedUrl && !o.codedStale).map((o) => o.code).filter(Boolean);
  const codedStale = outputs.some((o) => o.code && o.codedStale);
  const rendered = outputs.some((o) => o.status === 'done');
  let note = null;
  if (printing) note = ['busy', '⏳ Đang in mã lên ảnh kết quả… (xem bước "In mã lên ảnh" trên thẻ lần chạy)'];
  else if (r.status === 'failed' && r.stage === 'badge') note = ['warn', `In mã lên ảnh lỗi: ${r.error || ''}`];
  else if (codedStale) note = ['warn', r.status === 'running' ? '⚠ Ảnh kết quả chưa có mã mới — sẽ in khi render xong.' : '⚠ Ảnh kết quả chưa có mã mới (sẽ in lại khi lần chạy tiếp tục).'];
  else if (codedCodes.length) note = ['ok', `✓ Đã in mã lên ảnh: ${codedCodes.join(', ')} — tải "ảnh có mã" ở mục Ảnh kết quả.`];
  else if (rendered) note = ['', 'Ảnh kết quả hiện chưa in mã nào — đặt mã rồi bấm Lưu & in mã lên ảnh. Ảnh gốc vẫn giữ nguyên.'];
  else note = ['', 'Chưa có ảnh kết quả (đang render). Vẫn đặt mã / tải Excel được; mã sẽ in lên ảnh khi render xong.'];

  return (
    <div className="lightbox" onClick={onClose}>
      <div className="products-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="row between">
          <div>
            <h2>🏷️ Mã & sản phẩm — {rows ? rows.length : r.productItemCount || 0} ảnh trang phục</h2>
            <small className="muted">
              Mỗi ảnh trang phục là một sản phẩm: tên, giá, link Shopee lấy sẵn từ lúc bóc link; mã dạng <code>VAY_01</code> dùng chung sổ mã với video thời trang
              và in lên ảnh model đã render (khung đen mờ, chữ trắng, phía trên đầu nhân vật). Excel đúng cột để Admin DiamondShop nhập; hoa hồng Shopee để trống.
              {frame && ` Ảnh ${frame.width}×${frame.height}${frame.probed ? '' : ' (ước lượng, chưa có ảnh render)'}.`}
            </small>
          </div>
          <button className="lightbox-close" onClick={onClose} title="Đóng (Esc)">×</button>
        </div>

        {!rows ? (
          <p className="muted">{error ? '' : 'Đang tải…'}</p>
        ) : (
          <table className="table products-table">
            <thead>
              <tr>
                <th className="clip-col">Trang phục → ảnh kết quả</th>
                <th>Sản phẩm</th>
                <th className="badge-col">Khung mã trên ảnh kết quả</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key}>
                  <td className="clip-col">
                    <b>#{row.index}</b> <span className="small muted">{row.clipName}</span>
                    <div className="row gap-xs" style={{ marginTop: 4, alignItems: 'flex-start' }}>
                      {row.thumbUrl ? <img className="mini-thumb" src={row.thumbUrl} alt="" title={row.assetName || 'Ảnh trang phục'} style={{ width: 64, height: 86 }} /> : <div className="small muted">Không có ảnh trang phục</div>}
                      {row.codedUrl || row.outputUrl ? (
                        <img className="mini-thumb" src={row.codedUrl || row.outputUrl} alt="" title={row.codedUrl ? 'Ảnh kết quả đã in mã' : 'Ảnh kết quả (chưa in mã)'} style={{ width: 64, height: 86 }} />
                      ) : <div className="small muted" style={{ width: 64 }}>Chưa render</div>}
                    </div>
                    {!row.hasMeta && <div className="warn-text" title="Ảnh này không được tải từ link sản phẩm nên không có tên/giá/link sẵn">⚠ Ảnh chưa có dữ liệu sản phẩm</div>}
                  </td>
                  <td>
                    <div className="field-grid">
                      <label>
                        <span>Mã sản phẩm * (dạng VAY_01)</span>
                        <div className="code-row">
                          <input className={'code-input' + (badCode(row) ? ' bad' : '')} value={row.code || ''} placeholder={row.suggestedCode} onChange={(e) => update(row.key, { code: normalizeCodeInput(e.target.value) })} />
                          <button className="small-btn" disabled={busy} onClick={() => resuggest(row)} title="Gợi ý mã mới theo tên sản phẩm (số kế tiếp trong sổ mã)">Gợi ý lại</button>
                        </div>
                        {badCode(row) && <span className="err small">{dupCodes.has(codeOf(row)) ? 'Mã trùng với ảnh khác' : 'Cần dạng LOAI_SO, vd. VAY_01 (chữ, số, gạch dưới)'}</span>}
                      </label>
                      <label>
                        <span>Giá (đ)</span>
                        <input type="number" min="0" step="1000" value={row.price ?? ''} onChange={(e) => update(row.key, { price: e.target.value === '' ? null : Number(e.target.value) })} />
                      </label>
                      <label className="full">
                        <span>Tên sản phẩm</span>
                        <input value={row.name || ''} onChange={(e) => update(row.key, { name: e.target.value })} />
                      </label>
                      <label className="full">
                        <span>Mô tả (≤ 600 ký tự) · {(row.description || '').length}/600</span>
                        <textarea rows={3} maxLength={600} value={row.description || ''} onChange={(e) => update(row.key, { description: e.target.value })} />
                      </label>
                      <label>
                        <span>Danh mục</span>
                        <input value={row.category || ''} placeholder="(tuỳ chọn)" onChange={(e) => update(row.key, { category: e.target.value })} />
                      </label>
                      <label>
                        <span>Ảnh chính (Ảnh 1 trong Excel) · {row.images.length} ảnh</span>
                        {row.images.length ? (
                          <div className="img-pick">
                            {row.images.map((u) => <img key={u} src={u} alt="" className={u === row.mainImage ? 'on' : ''} title={u} onClick={() => update(row.key, { mainImage: u })} />)}
                          </div>
                        ) : <span className="warn-text">Không có URL ảnh gốc (ảnh tải từ máy)</span>}
                      </label>
                      <div className="full link-ro">
                        Link Shopee:{' '}
                        {row.shopeeUrl ? <a href={row.shopeeUrl} target="_blank" rel="noreferrer">{row.shopeeUrl}</a> : <span>– chưa có –</span>}
                        {!row.linkOk && <div className="warn-text">⚠ Thiếu shopId/itemId nên chưa dựng được link chuẩn <code>shopee.vn/product/&lt;shopId&gt;/&lt;itemId&gt;</code> — dán lại link sản phẩm khi lấy ảnh để có đủ.</div>}
                      </div>
                    </div>
                  </td>
                  <td className="badge-col">
                    <div className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}>
                      {frame && <BadgePreview frameUrl={row.frameUrl} frame={frame} code={codeOf(row)} badge={row.badge} onChange={(p) => updateBadge(row.key, p)} />}
                      <div className="badge-tools small">
                        <span className="muted">Kéo khung trên hình để đổi vị trí.</span>
                        <label>
                          <span>Cỡ chữ ×{Number(row.badge.scale).toFixed(2)}</span>
                          <input type="range" min="0.5" max="2" step="0.05" value={row.badge.scale} onChange={(e) => updateBadge(row.key, { scale: Number(e.target.value) })} />
                        </label>
                        <span className="muted">Tâm: {Math.round(row.badge.x * 100)}% · {Math.round(row.badge.y * 100)}%</span>
                        <a onClick={() => updateBadge(row.key, { x: 0.5, y: 0.12, scale: 1 })}>Về mặc định</a>
                        {rows.length > 1 && <a onClick={() => applyBadgeAll(row.key)} title="Dùng vị trí và cỡ này cho mọi ảnh">Áp vị trí cho mọi ảnh</a>}
                      </div>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {note && <div className={'merge-note ' + note[0]}>{note[1]}</div>}
        {saved && !dirty && !printing && <small className="ok">Đã lưu lúc {new Date(saved.at).toLocaleTimeString('vi-VN')}{saved.remerge ? ' · đã yêu cầu in mã lên ảnh' : ' · không có gì đổi so với ảnh đã in mã'}</small>}
        {error && <div className="err">{error}</div>}

        <div className="row">
          <button className="primary" disabled={busy || !rows || invalid > 0 || !frame} onClick={save} title="Lưu mã / thông tin và in khung mã lên từng ảnh kết quả (ảnh gốc giữ nguyên)">
            💾 Lưu & in mã lên ảnh{withCode ? ` (${withCode} mã)` : ''}
          </button>
          <button disabled={busy || !rows} onClick={download} title="Tải file Excel đúng cột cho Admin DiamondShop (dữ liệu đang sửa cũng được xuất)">📊 Tải Excel</button>
          <button disabled={!rows} onClick={copyCodes}>{copied ? '✓ Đã sao chép' : '📋 Sao chép mã'}</button>
          {dirty && <small className="muted">Có thay đổi chưa lưu</small>}
          {invalid > 0 && <small className="err">Sửa {invalid} mã không hợp lệ / trùng trước khi lưu</small>}
          <span className="grow" />
          <button onClick={onClose}>Đóng</button>
        </div>
      </div>
    </div>
  );
}

const RUN_STATUS = { running: ['Đang chạy', 'blue'], paused: ['Chờ bạn kiểm tra', 'amber'], done: ['Hoàn thành', 'green'], failed: ['Dừng vì lỗi', 'red'], cancelled: ['Đã huỷ', 'gray'] };

function RunCard({ run: r, state, refresh, go }) {
  const [showJobs, setShowJobs] = useState(false);
  const [showProducts, setShowProducts] = useState(false); // bảng Mã & sản phẩm (Ảnh model mặc đồ)
  const canProducts = r.hasProductInputs && r.productItemCount > 0;
  const { busy, error, run } = useAction();
  const source = state.sources.find((s) => s.id === r.sourceId);
  const jobs = state.jobs.filter((j) => j.runId === r.id);
  const [label, color] = RUN_STATUS[r.status] || [r.status, 'gray'];
  const bgJob = r.background && jobs.find((j) => j.id === r.background.id);
  const trJob = r.turnaround && jobs.find((j) => j.id === r.turnaround.id); // Fashion V2V: ảnh vóc dáng 16:9
  // Đang dừng chờ kiểm tra ở bước nào (trước khi tạo video, hay sau khi thay nhân vật)
  const pausedBeforeMotion = r.status === 'paused' && r.stageList.some((s) => s.id === 'motion' && s.status !== 'done');
  const act = (fn) => run(async () => { await fn(); await refresh(); });

  return (
    <div className={'card stack run' + (r.status === 'failed' ? ' failed' : '')}>
      <div className="row between">
        <div>
          <b>{r.sourceId ? (source?.name || 'Video gốc đã xoá') : r.workflowName}</b>{' '}
          <small className="muted">· {r.sourceId ? `${r.clipIds.length} đoạn` : `${r.outputs?.length || 0} ảnh`} · {new Date(r.createdAt).toLocaleString('vi-VN')}</small>
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

      {(r.frameUrl || bgJob || trJob || r.backgroundUrl) && (
        <div className="row">
          {r.frameUrl && <figure className="mini"><img src={r.frameUrl} alt="" /><figcaption>Khung hình gốc</figcaption></figure>}
          {trJob && (
            // Thẻ job ảnh vóc dáng 16:9: Thử lại / Sửa prompt / chọn lần tạo. Đổi ảnh → mọi đoạn tạo video lại.
            <div className="stack bg-job wide">
              <small className="muted">Ảnh 1 – vóc dáng toàn thân 16:9 (mặc sản phẩm)</small>
              <JobCard compact job={trJob} refresh={refresh} />
              <small className="muted">Thử lại hoặc chọn lần tạo khác → kiểm tra lại, rồi mọi đoạn tạo video lại (≈20 credit/đoạn).</small>
            </div>
          )}
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
      {r.status === 'paused' && (pausedBeforeMotion ? (
        <div className="alert warn small">
          ⏸ Ảnh vóc dáng 16:9 đã tạo xong (0 credit). Xem ảnh ở trên; chưa ưng thì <b>Thử lại</b> / <b>Sửa prompt</b> hoặc chọn lần tạo khác.
          Ưng rồi bấm <b>▶ Tiếp tục</b> để tạo video cho từng đoạn (bước này bắt đầu tốn credit, ≈20 credit/đoạn).
        </div>
      ) : (
        <div className="alert warn small">
          ⏸ Đã thay nhân vật + sản phẩm xong. Xem video ở bảng <b>Từng đoạn</b> bên dưới; chưa ưng thì <b>Thử lại</b> / <b>Sửa prompt</b> hoặc thay bằng video từ máy.
          Ưng rồi bấm <b>▶ Tiếp tục</b> để thay bối cảnh (bước này bắt đầu tốn credit).
        </div>
      ))}

      {r.clipRows.length > 0 && <ClipTable run={r} jobs={jobs} refresh={refresh} />}
      {r.outputs?.length > 0 && <OutputGallery run={r} jobs={jobs} refresh={refresh} />}
      {showProducts && <ProductCodeSheet run={r} refresh={refresh} onClose={() => setShowProducts(false)} />}

      <div className="row" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        {r.status === 'paused' && (
          <button className="primary" disabled={busy} onClick={() => act(() => api.resumeRun(r.id))}>
            {pausedBeforeMotion ? '▶ Tiếp tục: tạo video' : '▶ Tiếp tục: thay bối cảnh'}
          </button>
        )}
        {r.status === 'failed' && <button className="primary" disabled={busy} onClick={() => act(() => api.resumeRun(r.id))}>▶ Tiếp tục</button>}
        {r.status === 'cancelled' && <button disabled={busy} onClick={() => act(() => api.resumeRun(r.id))}>▶ Chạy tiếp</button>}
        {r.status !== 'done' && (
          <button
            type="button"
            className="small-btn"
            disabled={busy}
            style={{ background: '#0284c7', color: '#fff', border: 'none', fontWeight: 600, padding: '5px 12px' }}
            title="Tải video mới nhất vừa render xong trong cửa sổ Chrome Google Flow về để tiếp tục quy trình này"
            onClick={() => act(async () => {
              await api.importFlowRun(r.id);
              await refresh();
            })}
          >
            📥 Tải video từ Google Flow về
          </button>
        )}
        {(r.status === 'running' || r.status === 'paused') && <button disabled={busy} onClick={() => act(() => api.cancelRun(r.id))}>⏹ Huỷ</button>}
        {r.merge?.status === 'done' && <button className="primary" onClick={() => go('publish', [r.merge.id])}>🚀 Đăng video →</button>}
        {r.merge?.status === 'done' && <button onClick={() => go('merge')}>Xem ở Ghép video</button>}
        {canProducts && (
          <button onClick={() => setShowProducts(true)} title="Đặt mã sản phẩm in lên từng ảnh kết quả và xuất Excel (tên, giá, link Shopee có sẵn) cho DiamondShop">
            🏷️ Mã & sản phẩm{r.productCount ? ` (${r.productCount})` : ''}{(r.outputs || []).some((o) => o.code && o.codedStale) ? ' ⚠' : ''}
          </button>
        )}
        <button className="link" onClick={() => setShowJobs(!showJobs)}>{showJobs ? 'Ẩn' : 'Xem'} {jobs.length} video của lần chạy</button>
        <span className="grow" />
        <ConfirmButton disabled={r.status === 'running'} armedText="Xoá cả lần chạy và video?" onConfirm={() => act(() => api.deleteRun(r.id))}>Xoá</ConfirmButton>
      </div>
      {error && <div className="err">{error}</div>}

      {showJobs && <JobList jobs={jobs} refresh={refresh} />}
    </div>
  );
}
