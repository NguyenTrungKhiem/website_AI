// Trang chạy 1 quy trình tự động (AI Dancing…). Giao diện dựng từ mô tả quy trình do server gửi (wf),
// nên thêm quy trình mới ở server/workflows là tự có trang riêng.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { AssetPicker, BackViewControl, CaptionModePicker, ConfirmButton, FileDrop, ImageZoom, JobCard, JobList, MAX_CAPTION_TEXT, PromptVersionPicker, cleanCaptionText, fmt, useAction } from '../components.jsx';
import FashionSalesView from './FashionSalesView.jsx';
import MaleOutfits, { emptyLook } from './MaleOutfits.jsx';
import ModelOutfitsEditor, { emptyModelOutfit, validateModelOutfitsClient } from './ModelOutfitsEditor.jsx';
import SetPieces, { BOTTOM_LABELS } from './SetPieces.jsx';
import SunoAudioPanel from './SunoAudioPanel.jsx';
import TikTokSlidesModal from './TikTokSlidesModal.jsx';

function initInputsForWorkflow(wf, saved = {}) {
  const next = { ...(saved || {}) };
  if (wf?.modelOutfits) {
    if (!next.backgrounds && next.background) next.backgrounds = [next.background];
    if ((!Array.isArray(next.modelOutfits) || !next.modelOutfits.length) && Array.isArray(next.outfits) && next.outfits.length) {
      const slotKey = wf.modelOutfits.gender === 'female' ? 'dress' : 'set';
      next.modelOutfits = next.outfits.map((id, i) => ({ id: `o${i + 1}`, items: { [slotKey]: id }, style: '' }));
    }
    if (!Array.isArray(next.modelOutfits) || !next.modelOutfits.length) {
      next.modelOutfits = [emptyModelOutfit()];
    }
  }
  return next;
}

// siblings = các quy trình cùng nhóm tab (wf.tab.group, vd. không voice Nữ / Nam): hiện thanh tab trên đầu trang
export default function WorkflowPage({ state, refresh, go, wf, siblings = [] }) {
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
  const [inputs, setInputs] = useState(() => initInputsForWorkflow(wf, savedWfDraft?.inputs));
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
  const noVideo = !!wf.noVideo; // quy trình chỉ làm ảnh / video không cần video gốc
  const isEmpty = (inp) => (inp.multiple ? !(inputs[inp.key]?.length) : !inputs[inp.key]);
  const missing = wf.inputs.filter((i) => (i.required || i.requiredUi) && isEmpty(i)).map((i) => i.label);
  if (wf.sunoMode && (!options.audioId || !state.audios.some((a) => a.id === options.audioId))) {
    missing.push('File nhạc Suno (.mp3)');
  }
  const modelOutfitsKey = wf.modelOutfits?.key || null;
  const modelOutfits = modelOutfitsKey
    ? (Array.isArray(inputs[modelOutfitsKey]) && inputs[modelOutfitsKey].length ? inputs[modelOutfitsKey] : [emptyModelOutfit()])
    : null;
  if (wf.modelOutfits) {
    for (const msg of validateModelOutfitsClient(wf.modelOutfits, modelOutfits, state.assets)) missing.push(msg);
  }
  // Quy trình cần ảnh mặt sau cho từng trang phục: chưa chọn và cũng chưa có ảnh mặt sau tạo từ ảnh đó -> chưa chạy được
  if (wf.backInput && wf.codedInput) {
    const backOf = (frontId) => inputs[wf.backInput]?.[frontId] || state.assets.find((a) => a.fromAssetId === frontId && (a.isBackView || /Mặt sau Flow/.test(a.name || '')))?.id;
    (inputs[wf.codedInput] || []).forEach((id, i) => { if (!backOf(id)) missing.push(`Mặt sau trang phục ${i + 1}`); });
  }
  // Tuỳ chọn đang chọn có ràng buộc riêng (vd. Chuyển động 3: ĐÚNG 2 trang phục, chỉ có bản 15s): giới hạn ô chọn trang phục,
  // báo thiếu / thừa, và chỉ cho chọn các thời lượng chuyển động đó có
  // Giá trị đang chọn của tuỳ chọn dạng danh sách; giá trị không còn trong danh sách (nháp cũ, vd. Chuyển động 5 đã chuyển
  // sang tab Nam) thì về mặc định
  const choiceOf = (o) => {
    const v = options[o.key] ?? o.default;
    return o.options.some((x) => (typeof x === 'string' ? x : x.value) === v) ? v : o.default;
  };
  const validOptions = { ...options, ...Object.fromEntries(wf.options.filter((o) => Array.isArray(o.options)).map((o) => [o.key, choiceOf(o)])) };
  const rule = wf.options
    .map((o) => (Array.isArray(o.options) ? o.options.find((x) => typeof x === 'object' && x.value === validOptions[o.key]) : null))
    .find((x) => x && x.minOutfits) || null;
  const ruleName = rule ? rule.label.split(' – ')[0] : '';
  const ruleNeed = rule ? (rule.minOutfits === rule.maxOutfits ? `đúng ${rule.minOutfits}` : `${rule.minOutfits}–${rule.maxOutfits}`) : '';
  const pickedCount = wf.codedInput ? inputs[wf.codedInput]?.length || 0 : 0;
  if (rule && pickedCount > 0 && (pickedCount < rule.minOutfits || pickedCount > rule.maxOutfits)) {
    missing.push(`${ruleName} cần ${ruleNeed} trang phục (đang chọn ${pickedCount})`);
  }
  const allowedDurations = rule?.durations || null; // [] = chuyển động 2 phân cảnh, không dùng ô Thời lượng
  const effectiveOptions = allowedDurations?.length && !allowedDurations.includes(validOptions.duration)
    ? { ...validOptions, duration: allowedDurations[0] }
    : validOptions;
  // Chữ trên video = chữ tuỳ ý: bộ 1 phải có chữ (các bộ sau để trống thì dùng chữ của bộ trước)
  const captionMode = wf.captionModes ? options.captionMode || 'code' : null;
  const firstOutfit = wf.codedInput && inputs[wf.codedInput]?.[0];
  if (captionMode === 'text' && firstOutfit && !cleanCaptionText(options.captionTexts?.[firstOutfit]).trim()) missing.push('Chữ trên video (bộ 1)');
  // Quy trình có khối outfit nhiều món (tab Nam): inputs[key] = [{ items, style, main, text }], luôn có ít nhất 1 outfit
  const looksKey = wf.outfitSets?.key || null;
  const looks = looksKey ? (Array.isArray(inputs[looksKey]) && inputs[looksKey].length ? inputs[looksKey] : [emptyLook()]) : null;
  // Số outfit tối đa có thể khác theo thời lượng (vd. Chuyển động Nam 2: 10s tối đa 4, 15s tối đa 6)
  const maxLooks = rule?.maxOutfitsByDuration?.[effectiveOptions.duration] || rule?.maxOutfits || 3;
  if (looks && looks.length > maxLooks) missing.push(`${ruleName}${rule?.maxOutfitsByDuration ? ` bản ${effectiveOptions.duration}` : ''} nhận tối đa ${maxLooks} outfit (đang có ${looks.length})`);
  if (looks && captionMode === 'text' && !cleanCaptionText(looks[0]?.text).trim()) missing.push('Chữ trên video (outfit 1)');
  const outfitCount = modelOutfits
    ? modelOutfits.length
    : wf.inputs.find((i) => i.multiple)
      ? (inputs[wf.inputs.find((i) => i.multiple).key]?.length || 0)
      : 0;
  const missingClips = perClip.length
    ? selectedClips.filter((c) => perClip.some((inp) => inp.required && !clipInputs[c.id]?.[inp.key])).length
    : 0;

  const start = () =>
    run(async () => {
      const payloadInputs = modelOutfitsKey
        ? { ...inputs, [modelOutfitsKey]: modelOutfits }
        : looksKey
          ? { ...inputs, [looksKey]: looks }
          : inputs;
      await api.createRun({ workflowId: wf.id, sourceId, clipIds, inputs: payloadInputs, clipInputs, options: effectiveOptions });
      await refresh();
    });

  return (
    <section>
      {siblings.length > 1 && (
        <div className="tabs wf-tabs" role="tablist" aria-label="Chọn tab của quy trình">
          {siblings.map((sib) => (
            <button key={sib.id} type="button" role="tab" aria-selected={sib.id === wf.id} className={sib.id === wf.id ? 'on' : ''} onClick={() => go('wf:' + sib.id)}>
              {sib.tab?.label || sib.name}
            </button>
          ))}
        </div>
      )}
      <h1>{wf.icon} {wf.tab ? `${wf.tab.title} – ${wf.tab.label}` : wf.name}</h1>
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
          {wf.inputs.map((inp) => {
            // Ô trang phục: số ảnh tối đa và chữ "chọn 1–4" theo chuyển động đang chọn (vd. Chuyển động 3: đúng 2)
            const limited = rule && inp.key === wf.codedInput;
            // Chuyển động đồ bộ: ô trang phục thay bằng khối riêng (ô Áo, ô Quần / Váy, tách ảnh đồ bộ) ở ngay dưới
            if (limited && rule.set) return null;
            const max = limited ? Math.min(inp.max || rule.maxOutfits, rule.maxOutfits) : inp.max;
            // Chuyển động cần đúng món theo thứ tự (đồ bộ): ghi rõ ảnh 1 = áo, ảnh 2 = quần / váy
            const label = (limited ? inp.label.replace(/chọn \d+[–-]\d+/, `chọn ${ruleNeed}`) : inp.label)
              + (limited && rule.outfitLabels ? ` — ${rule.outfitLabels.map((l, i) => `ảnh ${i + 1} = ${l.toUpperCase()}`).join(', ')}` : '');
            return (
              <AssetPicker
                key={inp.key}
                kind={inp.kind}
                label={label + (inp.required || inp.requiredUi ? ' *' : '')}
                assets={state.assets}
                multiple={!!inp.multiple}
                hide={inp.hideBackViews ? (a) => a.isBackView || /Mặt sau Flow/.test(a.name || '') : null}
                value={inputs[inp.key] || (inp.multiple ? [] : null)}
                onChange={(v) => setInputs((s) => ({ ...s, [inp.key]: inp.multiple && max && Array.isArray(v) ? v.slice(0, max) : v }))}
                refresh={refresh}
                state={state}
              />
            );
          })}
        </div>
        {rule?.set && wf.codedInput && (
          <SetPieces
            wfId={wf.id}
            codedKey={wf.codedInput}
            inputs={inputs}
            setInputs={setInputs}
            bottomType={effectiveOptions.bottomType}
            onBottomType={(v) => setOptions((s) => ({ ...s, bottomType: v }))}
            state={state}
            refresh={refresh}
          />
        )}
        {wf.codedInput && (inputs[wf.codedInput]?.length || 0) > 0 && (
          <OutfitCodes
            ids={inputs[wf.codedInput]}
            backs={wf.backInput ? inputs[wf.backInput] || {} : null}
            onBacks={wf.backInput ? (v) => setInputs((s) => ({ ...s, [wf.backInput]: v })) : null}
            caption={captionMode ? { mode: captionMode, texts: options.captionTexts || {} } : null}
            onCaption={(patch) => setOptions((s) => ({ ...s, ...patch }))}
            // đồ bộ: tên từng dòng theo ô đang có ảnh (Áo / Quần hoặc Váy)
            labels={rule?.set
              ? [inputs.setTop && 'Áo', inputs.setBottom && (BOTTOM_LABELS[effectiveOptions.bottomType] || 'Quần')].filter(Boolean)
              : rule?.outfitLabels || null}
            isSet={!!rule?.set}
            state={state}
            refresh={refresh}
          />
        )}
        {looks && (
          <MaleOutfits
            slots={wf.outfitSets.slots}
            value={looks}
            onChange={(v) => setInputs((st) => ({ ...st, [looksKey]: typeof v === 'function' ? v(st[looksKey]) : v }))}
            modelId={inputs.model || null}
            wfId={wf.id}
            bag={rule ? (rule.bag ?? true) : true}
            bagNote={rule?.bagNote || null}
            motion={rule?.value || null}
            backOutfits={rule?.backOutfits?.[rule?.dynamic ? 'auto' : effectiveOptions.duration]?.[looks.length] ?? null}
            max={maxLooks}
            captionMode={captionMode || 'code'}
            onCaptionMode={(v) => setOptions((st) => ({ ...st, captionMode: v }))}
            state={state}
            refresh={refresh}
          />
        )}
        {wf.modelOutfits && (
          <ModelOutfitsEditor
            config={wf.modelOutfits}
            value={modelOutfits}
            onChange={(v) => setInputs((s) => ({ ...s, [wf.modelOutfits.key]: v }))}
            state={state}
            refresh={refresh}
          />
        )}
      </div>

      {wf.promptWriter && (
        <ExercisePromptBox
          wf={wf}
          value={{ exercise: options.exercise || '', prompt: options.customPrompt || '', note: options.exerciseNote || '' }}
          onChange={(patch) => setOptions((s) => ({ ...s, ...patch }))}
        />
      )}

      {wf.sunoMode && (
        <SunoAudioPanel
          state={state}
          refresh={refresh}
          wf={wf}
          options={effectiveOptions}
          onChange={(patch) => setOptions((s) => ({ ...s, ...patch }))}
        />
      )}

      <div className="card stack">
        <b>{noVideo ? (wf.sunoMode ? '3' : '2') : '3'}. Tuỳ chọn</b>
        {wf.options.map((o) => {
          // Ô "Thời lượng": chỉ hiện các bản chuyển động đang chọn có; chuyển động 2 phân cảnh (không có bản nào) thì ẩn
          const isDuration = o.key === 'duration' && allowedDurations;
          if (isDuration && !allowedDurations.length) {
            // Chuyển động thời lượng tự tính (vd. Chuyển động Nam 2): hiện số giây theo số outfit, giống server (dynamicSeconds)
            const dyn = rule?.dynamic;
            if (!dyn || !looks) return null;
            const n = Math.max(1, looks.length);
            const sec = Math.min(dyn.max, Math.max(3, Math.ceil(dyn.intro + dyn.per * (n - 1) - 1e-6)));
            const per = n > 1 ? String(Math.round(((sec - dyn.intro) / (n - 1)) * 100) / 100).replace('.', ',') : null;
            return (
              <small key={o.key} className="muted" style={{ display: 'block' }}>
                ⏱ Thời lượng video tự tính theo số outfit: <b>{n} outfit → {sec}s</b>
                {per ? ` (mở đầu ${String(dyn.intro).replace('.', ',')}s + ${n - 1} outfit × ~${per}s)` : ' (chỉ đoạn mở đầu)'}
                . Cần mô hình Omni 1.2 Flash (chọn độ dài 3–{dyn.max}s từng giây).
              </small>
            );
          }
          // showFor: tuỳ chọn chỉ dùng cho một số lựa chọn của tuỳ chọn khác (vd. món dưới / màu quần gym chỉ cho Chuyển động 5 – đồ bộ)
          if (o.showFor && !Object.entries(o.showFor).every(([k, vals]) => vals.includes(effectiveOptions[k]))) return null;
          if (o.inline) return null; // tuỳ chọn đã có nút chọn ngay ở khối khác (vd. "Món dưới là" trong khối Đồ bộ)
          // Tuỳ chọn dạng ô nhập chữ ngắn (type: 'text')
          if (o.type === 'text') {
            return (
              <label key={o.key} className="row" style={{ gap: 8, alignItems: 'center' }}>
                <span style={{ flex: '0 0 auto' }}>{o.label}</span>
                <input
                  style={{ flex: '0 1 220px', minWidth: 0 }}
                  maxLength={o.maxLength || 60}
                  placeholder={o.placeholder || ''}
                  value={options[o.key] ?? o.default ?? ''}
                  onChange={(e) => setOptions((s) => ({ ...s, [o.key]: e.target.value }))}
                />
              </label>
            );
          }
          const choices = Array.isArray(o.options) && isDuration ? o.options.filter((opt) => allowedDurations.includes(typeof opt === 'string' ? opt : opt.value)) : o.options;
          return Array.isArray(o.options) ? (
            // Tuỳ chọn dạng chọn 1 trong danh sách (vd. Chuyển động, Mô hình Flow)
            <label key={o.key} className="row" style={{ gap: 8, alignItems: 'center' }}>
              <span style={{ flex: '0 0 auto' }}>{o.label}</span>
              {/* tên chuyển động dài: ô chọn co theo khung, không đẩy cả trang tràn ngang */}
              <select style={{ flex: '1 1 0', minWidth: 0, maxWidth: '100%' }} value={effectiveOptions[o.key] ?? o.default ?? ''} onChange={(e) => setOptions((s) => ({ ...s, [o.key]: e.target.value }))}>
                {choices.map((opt) => {
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
          );
        })}
        <PromptEditor wf={wf} settings={state.settings} refresh={refresh} />
      </div>

      <div className="row">
        <button className="primary big" disabled={busy || (!noVideo && !clipIds.length) || missing.length > 0 || missingClips > 0} onClick={start}>
          {wf.runLabel || (
            <>
              ▶ Chạy {wf.name}{' '}
              {noVideo
                ? (outfitCount
                    ? modelOutfits && outfitCount >= 2
                      ? `– ${outfitCount} bộ (${Math.ceil(outfitCount / 5)} bài TikTok 5 slide)`
                      : `– ${outfitCount} ảnh`
                    : '')
                : `cho ${clipIds.length} đoạn`}
            </>
          )}
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

// Quy trình có promptWriter (Video tập gym): nhập tên động tác -> Gemini viết lại phần động tác của prompt gốc (góc quay theo
// nhóm cơ) -> prompt hiện trong ô để xem / sửa tay rồi chạy. value = { exercise, prompt (trống = dùng prompt gốc), note };
// onChange(patch) ghi vào options (exercise, customPrompt, exerciseNote) nên được lưu nháp và gửi theo lần chạy.
function ExercisePromptBox({ wf, value, onChange }) {
  const { busy, error, run } = useAction();
  const [name, setName] = useState(value.exercise);
  const pw = wf.promptWriter;
  const base = wf.prompts?.[pw.baseKey]?.text || '';
  const usingBase = !value.prompt.trim();
  const shown = usingBase ? base : value.prompt;
  const write = () =>
    run(async () => {
      const res = await api.exercisePrompt(wf.id, name.trim());
      const view = { rear: 'từ phía sau', 'rear-three-quarter': 'chéo từ phía sau', side: 'quay ngang', front: 'từ phía trước', 'front-three-quarter': 'chéo từ phía trước' }[res.view] || res.view;
      onChange({
        exercise: res.exercise,
        customPrompt: res.prompt,
        exerciseNote: [res.exerciseEn?.split('.')[0], res.muscleGroup && `nhóm cơ: ${res.muscleGroup}`, view && `góc quay: ${view}`, res.note].filter(Boolean).join(' · '),
      });
    });
  const reset = () => { setName(''); onChange({ exercise: '', customPrompt: '', exerciseNote: '' }); };
  return (
    <div className="card stack exercise-box">
      <b>🏋️ Động tác tập</b>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          style={{ flex: '1 1 240px', minWidth: 0 }}
          maxLength={120}
          placeholder={pw.placeholder || 'Tên động tác'}
          value={name}
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && name.trim() && !busy && write()}
          title="Nhập tên động tác (tiếng Việt hoặc tiếng Anh) rồi bấm nút để Gemini viết prompt mới từ prompt gốc"
        />
        <button className="primary" disabled={busy || !name.trim()} onClick={write}>
          {busy ? '⏳ Gemini đang viết…' : '✨ Viết prompt cho động tác này'}
        </button>
        {!usingBase && <button disabled={busy} onClick={reset} title="Bỏ prompt đã viết, quay về prompt gốc">↩ Về prompt gốc</button>}
      </div>
      <small className="muted">
        {usingBase
          ? <>Đang dùng <b>prompt gốc</b>: {pw.defaultExercise}. Nhập tên động tác khác rồi bấm nút: Gemini (API key trong Cài đặt) viết lại phần động tác — thiết bị, tư thế, kỹ thuật, các nhịp theo giây và <b>góc quay theo nhóm cơ</b> (chân / mông: từ phía sau · ngực: quay ngang · tay: phía trước…); các dòng nhân vật, đồ tập, bối cảnh giữ nguyên.</>
          : <>Đang dùng prompt cho <b>{value.exercise || 'động tác tuỳ chỉnh'}</b>{value.note ? <> — {value.note}</> : null}</>}
      </small>
      <textarea
        className="mono small"
        rows={14}
        value={shown}
        disabled={busy}
        onChange={(e) => onChange({ customPrompt: e.target.value })}
        title="Prompt sẽ gửi Flow (sửa tay được). {MODEL} {OUTFIT} {BACK} {BG} {CAPTION} là chỗ điền, giữ nguyên."
      />
      <small className="muted">
        {shown.length.toLocaleString('vi-VN')} ký tự · video {`15s`}, 1 phân cảnh, máy quay cố định. Xem lại dòng <code>Camera:</code> và các mốc giây trước khi chạy; sửa tay trong ô nếu cần. Giữ nguyên các chỗ điền <code>{'{MODEL} {OUTFIT} {BACK} {BG} {CAPTION}'}</code>.
      </small>
      {error && <div className="err small">{error}</div>}
    </div>
  );
}

// Từng ảnh trang phục đã chọn (quy trình có codedInput, vd. Video thời trang không voice): mã sản phẩm in làm caption
// (ảnh chưa có mã thì server tự cấp khi chạy; sửa ở đây lưu lên ảnh) và, khi quy trình cần (backInput), ảnh MẶT SAU của bộ đó:
// tự lấy ảnh mặt sau đã tạo từ ảnh mặt trước, hoặc chọn / tải từ máy / AI tạo / AI làm sạch / lấy từ Flow (BackViewControl).
// caption (quy trình có captionModes): { mode: 'code' | 'text' | 'none', texts: { [ảnh mặt trước]: chữ } } — chọn in mã sản
// phẩm, chữ tuỳ ý hay không chữ; onCaption(patch) ghi vào options (captionMode, captionTexts).
// labels = tên từng ảnh khi chuyển động cần đúng món (đồ bộ: ['Áo', 'Quần / váy']); isSet = 2 ảnh là 1 bộ mặc cùng lúc ->
// chỉ ảnh đầu (áo) có mã / chữ, in cho cả video
function OutfitCodes({ ids, backs, onBacks, caption, onCaption, labels = null, isSet = false, state, refresh }) {
  const mode = caption?.mode || 'code';
  const setText = (id, v) => onCaption({ captionTexts: { ...(caption?.texts || {}), [id]: cleanCaptionText(v) } });
  const { busy, error, run } = useAction();
  const [drafts, setDrafts] = useState({});
  const normalize = (v) => String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toUpperCase().replace(/[\s.]+/g, '_').replace(/[^A-Z0-9_-]/g, '');
  const assetOf = (id) => state.assets.find((a) => a.id === id);
  const save = (id) =>
    run(async () => {
      const code = normalize(drafts[id]);
      if (!code) return;
      await api.assignCode(id, code);
      setDrafts((d) => { const n = { ...d }; delete n[id]; return n; });
      await refresh();
    });
  const assign = (id) => run(async () => { await api.assignCode(id); await refresh(); });

  return (
    <div className="stack outfit-codes">
      <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <b className="small">
          {caption ? '🏷️ Từng trang phục: chữ trên video' : '🏷️ Từng trang phục: mã sản phẩm in trên video'}
          {backs ? ' · ảnh mặt sau (cho đoạn quay lưng)' : ''}
        </b>
        {caption && <CaptionModePicker value={mode} onChange={(v) => onCaption({ captionMode: v })} />}
      </div>
      <div className="stack" style={{ gap: 8 }}>
        {ids.map((id, i) => {
          const a = assetOf(id);
          if (!a) return null;
          const value = drafts[id] ?? a.productCode ?? '';
          return (
            <div key={id} className="row outfit-code" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <img src={a.url} alt="" className="mini-thumb" title={a.name} />
              <div className="stack" style={{ gap: 2 }}>
                <small className="muted">{labels?.[i] ? <b>{labels[i]}</b> : `Bộ ${i + 1}`} · {a.name.slice(0, 28)}</small>
                {isSet && i > 0 && mode !== 'none' && <span className="small muted">cùng bộ với ảnh 1: dùng chung {mode === 'code' ? 'mã' : 'chữ'} của áo</span>}
                {mode === 'code' && !(isSet && i > 0) && (
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
                )}
                {mode === 'text' && !(isSet && i > 0) && (
                  <input
                    className="caption-text"
                    maxLength={MAX_CAPTION_TEXT}
                    placeholder={i === 0 ? 'VD: NEW ARRIVAL' : '(để trống = giống bộ trên)'}
                    value={caption.texts[id] || ''}
                    onChange={(e) => setText(id, e.target.value)}
                    onBlur={(e) => setText(id, e.target.value.trim())}
                    title={`Chữ in lên video khi mặc bộ này (tối đa ${MAX_CAPTION_TEXT} ký tự, không dùng dấu nháy kép)`}
                  />
                )}
                {mode === 'none' && <span className="small muted">Không in chữ</span>}
              </div>
              {backs && (
                <BackViewControl
                  frontId={id}
                  backId={backs[id] || null}
                  auto
                  onChange={(v) => onBacks({ ...(backs || {}), [id]: v || undefined })}
                  state={state}
                  refresh={refresh}
                  backPrompt={state.defaults?.backViewPrompt}
                />
              )}
            </div>
          );
        })}
      </div>
      <small className="muted">
        {mode === 'code' && 'Mã: ảnh chưa có mã sẽ được cấp tự động khi chạy; mã gắn với ảnh nên lần sau dùng lại là có.'}
        {mode === 'text' && `Chữ tuỳ ý: tối đa ${MAX_CAPTION_TEXT} ký tự, in ở giữa phía trên video; bộ để trống dùng chữ của bộ trên. Model video hay vẽ sai chữ có dấu — nên viết ngắn, không dấu.`}
        {mode === 'none' && 'Không chữ: prompt dặn video không có chữ nào trên màn hình.'}
        {backs && <> Mặt sau: không chọn thì quy trình tự lấy ảnh mặt sau mới nhất đã tạo từ ảnh mặt trước đó; chưa có thì chọn trong thư viện, tải ảnh từ máy hoặc để AI tạo trước khi chạy. Ảnh mặt sau còn dính người / tay / móc thì bấm 🧹 AI làm sạch.</>}
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

// Từng phân cảnh của quy trình tạo video từ ảnh (run.scenes): mỗi phân cảnh 1 thẻ video thu gọn. Thử lại -> thêm lần tạo
// 1, 2, 3… trên CÙNG thẻ; bấm số để chốt bản tốt nhất (server tự làm lại bước phía sau / ghép lại).
function SceneTable({ run: r, jobs, refresh }) {
  const [open, setOpen] = useState(true);
  const byId = useMemo(() => Object.fromEntries(jobs.map((j) => [j.id, j])), [jobs]);
  return (
    <div className="stack">
      <a onClick={() => setOpen(!open)}>{open ? '▾' : '▸'} Từng phân cảnh ({r.scenes.length}): xem video, thử lại, chọn bản tốt nhất</a>
      {open && (
        <div className="scene-grid">
          {r.scenes.map((s) => {
            const job = byId[s.job.id];
            const made = job ? job.attempts.filter((a) => a.outputPath).length : 0;
            return (
              <div key={s.key} className="stack scene-cell">
                <b className="small">{s.label}{made > 1 ? ` · ${made} bản` : ''}</b>
                {job ? <JobCard compact job={job} refresh={refresh} /> : <span className="muted">–</span>}
                {s.note && <small className="muted">{s.note}</small>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Ảnh kết quả của quy trình chỉ làm ảnh: mỗi ảnh là thẻ job thu gọn (xem, Thử lại, chọn lần tạo) + tải về + lưu làm ảnh model
// + chế độ gom bài TikTok Photo Mode (mặc định 5 slide/bài): Tải ZIP theo bài hoặc Đăng/Lên lịch Carousel qua Zernio.
function OutputGallery({ run: r, jobs, state, refresh }) {
  const { busy, error, run } = useAction();
  const byId = useMemo(() => Object.fromEntries(jobs.map((j) => [j.id, j])), [jobs]);
  const [savedMsg, setSavedMsg] = useState('');
  const [zoom, setZoom] = useState(null); // { key, coded } ảnh kết quả đang phóng to (coded = xem bản có mã)
  const [slideMode, setSlideMode] = useState(false);
  const [perPost, setPerPost] = useState(5);
  const [useCodedZip, setUseCodedZip] = useState(true);
  const [slideModalPacks, setSlideModalPacks] = useState(null);

  const zoomOut = zoom && r.outputs.find((o) => o.key === zoom.key);
  const doneOutputs = useMemo(() => r.outputs.filter((o) => o.status === 'done' && o.outputUrl), [r.outputs]);
  const slidePacks = useMemo(() => {
    const n = Math.max(2, Math.min(35, Number(perPost) || 5));
    const chunks = [];
    for (let i = 0; i < doneOutputs.length; i += n) chunks.push(doneOutputs.slice(i, i + n));
    return chunks;
  }, [doneOutputs, perPost]);

  const saveAs = (assetId, kind) =>
    run(async () => {
      await api.copyAsset(assetId, kind);
      await refresh();
      setSavedMsg(kind === 'model' ? 'Đã lưu vào thư viện ảnh model' : 'Đã lưu');
      setTimeout(() => setSavedMsg(''), 2500);
    });

  const downloadZip = (postIndex = 'all') =>
    run(async () => {
      const { blob, filename } = await api.downloadTiktokZip(r.id, {
        perPost: Math.max(1, Math.min(35, Number(perPost) || 5)),
        coded: useCodedZip,
        format: 'jpg',
        postIndex,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    });

  const renderOutputCard = (o, slideNum = null) => {
    const job = byId[o.id];
    const codes = o.codes?.length ? o.codes : o.code ? [o.code] : [];
    return (
      <div key={o.key} className="output stack">
        <small className="ellipsis" title={o.label}>
          {slideNum != null && <span className="slide-num-pill">#{slideNum}</span>}
          {codes.map((c) => <span key={c} className="code-chip" style={{ marginTop: 0, marginRight: 4 }}>{c}</span>)}
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
            {o.codedUrl && <a href={o.codedUrl} download title="Ảnh kết quả đã in đủ mã sản phẩm">🏷️ Tải ảnh có mã</a>}
            {codes.length > 0 && o.codedStale && <span className="warn-text" title="Mã / vị trí / font đổi — sẽ in lại khi lần chạy tiếp tục">⚠ chưa in mã mới</span>}
            {o.assetId && <a onClick={() => saveAs(o.assetId, 'model')} title="Sao chép vào thư viện ảnh model để dùng cho AI Dancing / Thay trang phục">Lưu làm ảnh model</a>}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="stack">
      <div className="row between" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <b>Ảnh kết quả ({doneOutputs.length}/{r.outputs.length})</b>
          {r.outputs.length >= 2 && (
            <div className="tabs" style={{ marginBottom: 0 }}>
              <button type="button" className={!slideMode ? 'on' : ''} onClick={() => setSlideMode(false)}>🖼️ Tất cả ảnh</button>
              <button type="button" className={slideMode ? 'on' : ''} onClick={() => setSlideMode(true)}>🎞️ Bài TikTok Slide ({slidePacks.length})</button>
            </div>
          )}
        </div>
        {doneOutputs.length >= 1 && (
          <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {slideMode && (
              <label className="row small" style={{ gap: 4, alignItems: 'center' }} title="Mặc định 5 slide cho 1 bài đăng TikTok Photo Mode">
                <span>Slide/bài:</span>
                <input type="number" min={2} max={35} style={{ width: 52 }} value={perPost} onChange={(e) => setPerPost(e.target.value)} />
              </label>
            )}
            <label className="check small" title="Ưu tiên đóng gói / đăng bản đã in mã sản phẩm (nếu có)">
              <input type="checkbox" checked={useCodedZip} onChange={(e) => setUseCodedZip(e.target.checked)} />
              Bản có mã
            </label>
            <button type="button" className="small-btn" disabled={busy} onClick={() => downloadZip('all')} title="Tải toàn bộ ảnh dạng .jpg chia sẵn từng thư mục Bài-01, Bài-02…">
              {busy ? '⏳ Đang nén ZIP…' : `📦 Tải ZIP (${slidePacks.length} bài)`}
            </button>
            {doneOutputs.length >= 2 && (
              <button type="button" className="small-btn primary" disabled={busy} onClick={() => setSlideModalPacks(slidePacks)} title="Đăng hoặc lên lịch bài TikTok Photo Carousel qua Zernio API">
                🚀 Đăng TikTok Slide
              </button>
            )}
          </div>
        )}
      </div>

      {!slideMode ? (
        <div className="outputs">
          {r.outputs.map((o) => renderOutputCard(o))}
        </div>
      ) : (
        <div className="stack" style={{ gap: 10 }}>
          {slidePacks.map((pack, pi) => {
            const packCodes = [...new Set(pack.flatMap((o) => (o.codes?.length ? o.codes : o.code ? [o.code] : [])))];
            return (
              <div key={pi} className="tiktok-slide-pack stack">
                <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
                  <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <b>🎞️ Bài {pi + 1} · {pack.length} slide</b>
                    {packCodes.length > 0 && (
                      <span className="small muted">Mã trong bài: {packCodes.join(' · ')}</span>
                    )}
                  </div>
                  <div className="row gap-xs">
                    <button type="button" className="small-btn" disabled={busy} onClick={() => downloadZip(pi)}>
                      📦 Tải ZIP bài {pi + 1} (.jpg)
                    </button>
                    {pack.length >= 2 && (
                      <button type="button" className="small-btn primary" disabled={busy} onClick={() => setSlideModalPacks([pack])}>
                        🚀 Đăng bài này
                      </button>
                    )}
                  </div>
                </div>
                <div className="outputs">
                  {pack.map((o, si) => renderOutputCard(o, si + 1))}
                </div>
              </div>
            );
          })}
          {r.outputs.some((o) => o.status !== 'done' || !o.outputUrl) && (
            <div className="stack">
              <small className="muted">Ảnh đang chờ / chưa hoàn thành:</small>
              <div className="outputs">
                {r.outputs.filter((o) => o.status !== 'done' || !o.outputUrl).map((o) => renderOutputCard(o))}
              </div>
            </div>
          )}
        </div>
      )}

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
      {slideModalPacks && (
        <TikTokSlidesModal
          run={r}
          packs={slideModalPacks}
          state={state}
          refresh={refresh}
          onClose={() => setSlideModalPacks(null)}
        />
      )}
      <small className="muted">Bấm vào ảnh hoặc 🔍 để phóng to. Ảnh được tải về từ Flow ở bản 2K Upscaled (≈1536×2752). Chọn chế độ <b>🎞️ Bài TikTok Slide</b> để gom {perPost} ảnh thành 1 bài trượt Photo Mode, tải ZIP JPG hoặc đăng thẳng qua Zernio.{r.hasProductInputs && <> Bấm <b>🏷️ Mã & sản phẩm</b> để đặt mã cho từng món và xuất Excel DiamondShop.</>}</small>
    </div>
  );
}

// Ảnh xem trước của lần chạy (quy trình khai báo previewJobs, vd. tab Nam: KOL/KOC mặc từng outfit, mặt trước + mặt sau):
// mỗi ảnh là thẻ job thu gọn (Thử lại / Sửa prompt / chọn lần tạo), bấm ảnh hoặc 🔍 để phóng to. Người dùng duyệt xong mới
// bấm Tiếp tục trên thẻ lần chạy.
function PreviewGallery({ run: r, jobs, refresh }) {
  const byId = useMemo(() => Object.fromEntries(jobs.map((j) => [j.id, j])), [jobs]);
  const [zoom, setZoom] = useState(null); // key ảnh đang phóng to
  const groups = [...new Set(r.previews.map((p) => p.group))];
  const zoomed = zoom && r.previews.find((p) => p.key === zoom);
  return (
    <div className="stack">
      <b>Ảnh xem trước ({r.previews.filter((p) => p.status === 'done').length}/{r.previews.length})</b>
      {groups.map((g) => (
        <div key={g} className="stack" style={{ gap: 4 }}>
          <small className="muted">{g}</small>
          <div className="outputs">
            {r.previews.filter((p) => p.group === g).map((p) => {
              const job = byId[p.id];
              return (
                <div key={p.key} className="output stack">
                  <small className="ellipsis" title={p.label}>{p.label}</small>
                  {job ? (
                    <div className="zoomable" onClick={(e) => { if (p.outputUrl && e.target.tagName === 'IMG') setZoom(p.key); }} title={p.outputUrl ? 'Bấm vào ảnh để phóng to' : undefined}>
                      <JobCard compact job={job} refresh={refresh} />
                    </div>
                  ) : p.preset && p.outputUrl ? (
                    // Ảnh outfit người dùng tạo sẵn ở ô nhập: lần chạy dùng thẳng, không có job nên không có Thử lại
                    <img className="preset-shot" src={p.outputUrl} alt="" onClick={() => setZoom(p.key)} title="Ảnh tạo sẵn ở thẻ outfit — muốn đổi thì tạo lại ở đó rồi chạy lần mới. Bấm để phóng to" />
                  ) : <span className="muted">–</span>}
                  {p.outputUrl && (
                    <div className="row gap-xs" style={{ flexWrap: 'wrap' }}>
                      <a onClick={() => setZoom(p.key)} title="Xem ảnh to">🔍 Phóng to</a>
                      <a href={p.outputUrl} download>Tải về</a>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
      {zoomed?.outputUrl && <ImageZoom url={zoomed.outputUrl} name={zoomed.label} downloadUrl={zoomed.outputUrl} onClose={() => setZoom(null)} />}
    </div>
  );
}

// ---------- Mã & sản phẩm (Ảnh model mặc đồ): nhiều khung mã + font chữ cá tính dễ đọc + Excel cho DiamondShop ----------
const BADGE_STYLES = {
  boutique_female: {
    label: '✨ Boutique Nữ (Quicksand)',
    font: "'Quicksand', 'Segoe UI', sans-serif",
    bg: 'rgba(24, 15, 30, 0.72)',
    border: 'rgba(255, 236, 244, 0.82)',
    color: '#ffffff',
    pill: true,
  },
  editorial_serif: {
    label: '🌷 Tạp chí (Playfair)',
    font: "'Playfair Display', Georgia, serif",
    bg: 'rgba(28, 22, 18, 0.72)',
    border: 'rgba(248, 232, 208, 0.78)',
    color: '#fffaf2',
    pill: false,
  },
  modern_male: {
    label: '⚡ Hiện đại / Nam (Space Grotesk)',
    font: "'Space Grotesk', 'Montserrat', 'Segoe UI', sans-serif",
    bg: 'rgba(12, 16, 22, 0.78)',
    border: 'rgba(255, 255, 255, 0.45)',
    color: '#ffffff',
    pill: false,
  },
  classic: {
    label: '⬜ Cổ điển',
    font: "'Segoe UI', Roboto, Arial, sans-serif",
    bg: 'rgba(0, 0, 0, 0.55)',
    border: null,
    color: '#ffffff',
    pill: false,
  },
};

const normalizeCodeInput = (v) =>
  String(v || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'D')
    .toUpperCase()
    .replace(/[\s.]+/g, '_')
    .replace(/[^A-Z0-9_-]/g, '');
const isValidCode = (c) => /^[A-Z0-9]+(?:_[A-Z0-9-]+)+$/.test(c || '');

function badgeDisplayText(row, codeVal, showSlotPrefix) {
  const cleanCode = codeVal || '';
  if (row?.outfitItemCount >= 2 && showSlotPrefix && row?.slotShort) {
    return `${row.slotShort} · ${cleanCode || 'MÃ'}`;
  }
  return cleanCode || row?.slotShort || 'MÃ';
}

function badgeMetrics(frameH, scale = 1) {
  const font = Math.max(10, Math.round((frameH || 1280) * 0.036 * (Number(scale) || 1)));
  return { font, padX: Math.round(font * 0.62), padY: Math.round(font * 0.34), radius: Math.round(font * 0.38) };
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

// PNG (data URL) của khung mã theo đúng font + phong cách đã chọn ở kích thước thật 2K
function renderBadgePng(text, frame, scale, styleId = 'boutique_female') {
  const st = BADGE_STYLES[styleId] || BADGE_STYLES.boutique_female;
  const m = badgeMetrics(frame.height, scale);
  const canvas = document.createElement('canvas');
  let ctx = canvas.getContext('2d');
  ctx.font = `700 ${m.font}px ${st.font}`;
  const textW = Math.ceil(ctx.measureText(text).width);
  canvas.width = textW + m.padX * 2;
  canvas.height = Math.round(m.font * 1.28) + m.padY * 2;
  ctx = canvas.getContext('2d');

  const r = st.pill ? canvas.height / 2 : m.radius;
  const lw = st.border ? Math.max(1.5, Math.round(m.font * 0.045)) : 0;
  roundRectPath(ctx, lw / 2, lw / 2, canvas.width - lw, canvas.height - lw, Math.max(1, r - lw / 2));
  ctx.fillStyle = st.bg;
  ctx.fill();
  if (st.border && lw > 0) {
    ctx.strokeStyle = st.border;
    ctx.lineWidth = lw;
    ctx.stroke();
  }

  ctx.font = `700 ${m.font}px ${st.font}`;
  ctx.fillStyle = st.color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
  ctx.shadowBlur = Math.max(2, Math.round(m.font * 0.08));
  ctx.shadowOffsetY = 1;
  ctx.fillText(text, canvas.width / 2, canvas.height / 2 + m.font * 0.03);
  return canvas.toDataURL('image/png');
}

// Xem trước đồng thời TẤT CẢ khung mã của 1 Bộ trên cùng 1 ảnh kết quả; bấm/kéo thả trực tiếp từng khung mã!
function MultiBadgePreview({ frameUrl, frame, badges, activeKey, styleId, onSelectKey, onChange }) {
  const ref = useRef();
  const dragKeyRef = useRef(null);
  const [draggingKey, setDraggingKey] = useState(null);
  const st = BADGE_STYLES[styleId] || BADGE_STYLES.boutique_female;

  const ar = frame.width / frame.height || 9 / 16;
  let h = 260;
  let pw = Math.round(h * ar);
  if (pw > 330) { pw = 330; h = Math.round(pw / ar); }
  const k = h / frame.height;

  const coordsOf = (e) => {
    const rect = ref.current.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    return { x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 };
  };

  const activeInGroup = badges.some((b) => b.key === activeKey) ? activeKey : badges[0]?.key;

  const down = (e, targetKey = null) => {
    e.preventDefault();
    e.stopPropagation();
    const chosen = targetKey || activeInGroup;
    if (!chosen) return;
    dragKeyRef.current = chosen;
    setDraggingKey(chosen);
    onSelectKey(chosen);
    ref.current.setPointerCapture?.(e.pointerId);
    onChange(chosen, coordsOf(e));
  };
  const move = (e) => {
    if (!dragKeyRef.current) return;
    onChange(dragKeyRef.current, coordsOf(e));
  };
  const up = () => {
    dragKeyRef.current = null;
    setDraggingKey(null);
  };

  return (
    <div
      ref={ref}
      className={'badge-preview' + (draggingKey ? ' dragging' : '')}
      style={{ width: pw, height: h }}
      onPointerDown={(e) => down(e, null)}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      title="Kéo từng khung mã để đổi vị trí (bấm nền ảnh để di chuyển mã đang chọn)"
    >
      {frameUrl ? <img src={frameUrl} alt="" draggable={false} /> : <div className="no-frame">Chưa có ảnh kết quả (đang render)</div>}
      {badges.map((b) => {
        const m = badgeMetrics(frame.height, b.scale);
        const isActive = badges.length > 1 && b.key === activeKey;
        return (
          <div
            key={b.key}
            className={`code-badge ${styleId}` + (isActive ? ' active-badge' : '')}
            onPointerDown={(e) => down(e, b.key)}
            style={{
              left: `${b.x * 100}%`,
              top: `${b.y * 100}%`,
              fontSize: Math.max(6, m.font * k),
              fontFamily: st.font,
              background: st.bg,
              color: st.color,
              border: st.border ? `1px solid ${st.border}` : 'none',
              padding: `${m.padY * k}px ${m.padX * k}px`,
              borderRadius: st.pill ? 999 : m.radius * k,
              opacity: b.hasCode ? 1 : 0.45,
            }}
            title={`Kéo để đặt vị trí cho ${b.text}`}
          >
            {b.text}
          </div>
        );
      })}
    </div>
  );
}

// Bảng "Mã & sản phẩm": hỗ trợ nhiều sản phẩm trên cùng 1 ảnh (Áo Trái trên, Quần/Váy Phải trên, Khoác/Túi đối xứng)
// + 4 bộ font chữ cá tính dễ nhìn + xuất Excel 5 cột chuẩn DiamondShop.
function ProductCodeSheet({ run: r, refresh, onClose }) {
  const [frame, setFrame] = useState(null);
  const [rows, setRows] = useState(null);
  const [badgeStyle, setBadgeStyle] = useState(() => (r.workflow === 'anh-model-nam' ? 'modern_male' : 'boutique_female'));
  const [showSlotPrefix, setShowSlotPrefix] = useState(true);
  const [activeKey, setActiveKey] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(null);
  const [copied, setCopied] = useState(false);
  const { busy, error, run, setError } = useAction();

  useEffect(() => {
    let alive = true;
    api.runProducts(r.id)
      .then((d) => {
        if (!alive) return;
        setFrame(d.frame);
        setRows(d.rows);
        if (d.badgePrefs?.style) setBadgeStyle(d.badgePrefs.style);
        if (typeof d.badgePrefs?.showSlotPrefix === 'boolean') setShowSlotPrefix(d.badgePrefs.showSlotPrefix);
      })
      .catch((e) => alive && setError(e.message));
    return () => { alive = false; };
  }, [r.id]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'INPUT') onClose(); };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [onClose]);

  const codedSig = (r.outputs || []).map((o) => `${o.outfitId}:${o.codedUrl || ''}:${o.codedStale ? 1 : 0}`).join('|');
  useEffect(() => {
    if (!rows || dirty) return;
    let alive = true;
    api.runProducts(r.id).then((d) => { if (alive) setRows(d.rows); }).catch(() => {});
    return () => { alive = false; };
  }, [codedSig]);

  const update = (key, patch) => {
    setRows((rs) => {
      const target = rs.find((x) => x.key === key);
      // Nếu Mix & Match dùng cùng 1 ảnh sản phẩm ở nhiều Bộ -> tự đồng bộ mã sản phẩm & Link Shopee Aff theo cùng ảnh
      if (target?.assetId && (patch.code !== undefined || patch.affiliateUrl !== undefined)) {
        const sharedPatch = {
          ...(patch.code !== undefined ? { code: patch.code } : {}),
          ...(patch.affiliateUrl !== undefined ? { affiliateUrl: patch.affiliateUrl } : {}),
        };
        return rs.map((x) => (x.key === key ? { ...x, ...patch } : x.assetId === target.assetId ? { ...x, ...sharedPatch } : x));
      }
      return rs.map((x) => (x.key === key ? { ...x, ...patch } : x));
    });
    setDirty(true);
  };
  const updateBadge = (key, patch) => {
    setRows((rs) => rs.map((x) => (x.key === key ? { ...x, badge: { ...x.badge, ...patch } } : x)));
    setDirty(true);
  };
  const resetOutfitLayout = (outfitKey) => {
    setRows((rs) => rs.map((x) => {
      if (x.outfitKey !== outfitKey) return x;
      const d = x.defaultBadge || { x: 0.5, y: 0.12, scale: 1 };
      return { ...x, badge: { ...x.badge, x: d.x, y: d.y, scale: d.scale } };
    }));
    setDirty(true);
  };
  const applyScaleAll = (scale) => {
    setRows((rs) => rs.map((x) => ({ ...x, badge: { ...x.badge, scale } })));
    setDirty(true);
  };

  const resuggest = (row) =>
    run(async () => {
      const taken = rows
        .filter((x) => x.key !== row.key && (!row.assetId || x.assetId !== row.assetId))
        .map((x) => x.code)
        .filter(Boolean);
      const { code } = await api.suggestProductCode(row.name, taken);
      update(row.key, { code });
    });

  const codeOf = (row) => normalizeCodeInput(row.code).replace(/^_+|_+$/g, '');
  // Chỉ báo trùng mã khi 2 SẢN PHẨM KHÁC NHAU đặt cùng 1 mã (Mix & Match cùng assetId dùng chung mã là hợp lệ!)
  const dupCodes = useMemo(() => {
    if (!rows) return new Set();
    const owner = new Map();
    const dups = new Set();
    for (const row of rows) {
      const c = codeOf(row);
      if (!c) continue;
      const aId = row.assetId || row.key;
      if (owner.has(c) && owner.get(c) !== aId) dups.add(c);
      else owner.set(c, aId);
    }
    return dups;
  }, [rows]);

  const badCode = (row) => { const c = codeOf(row); return c && (!isValidCode(c) || dupCodes.has(c)); };
  const invalid = rows ? rows.filter(badCode).length : 0;
  const withCode = rows ? rows.filter((x) => codeOf(x)).length : 0;

  const outfitGroups = useMemo(() => {
    if (!rows) return [];
    const map = new Map();
    for (const row of rows) {
      const gk = row.outfitKey || row.key;
      if (!map.has(gk)) map.set(gk, { outfitKey: gk, outfitLabel: row.outfitLabel || `Bộ #${map.size + 1}`, rows: [] });
      map.get(gk).rows.push(row);
    }
    return [...map.values()];
  }, [rows]);

  const payload = (withPng) =>
    Object.fromEntries(
      rows.map((x) => {
        const c = codeOf(x);
        const text = badgeDisplayText(x, c, showSlotPrefix);
        return [
          x.key,
          {
            code: c,
            name: x.name,
            price: x.price,
            description: x.description,
            commission: x.commission,
            affiliateUrl: x.affiliateUrl ?? '',
            badge: {
              x: x.badge.x,
              y: x.badge.y,
              scale: x.badge.scale,
              png: withPng && c && frame ? renderBadgePng(text, frame, x.badge.scale, badgeStyle) : null,
              frameWidth: frame?.width,
              frameHeight: frame?.height,
            },
          },
        ];
      }),
    );

  const fetchCommission = (row) =>
    run(async () => {
      const res = await api.fetchAssetCommission(row.assetId, true);
      if (!res.ok) throw new Error(res.message || 'Không lấy được hoa hồng');
      update(row.key, { commission: res.commission, commissionRateText: res.commissionRateText });
    });

  const save = () =>
    run(async () => {
      if (document.fonts?.ready) await document.fonts.ready;
      const res = await api.saveRunProducts(r.id, {
        products: payload(true),
        badgePrefs: { style: badgeStyle, showSlotPrefix },
      });
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

  const badgeSt = r.stages?.badge?.status;
  const printing = r.status === 'running' && (r.stage === 'badge' || badgeSt === 'running' || badgeSt === 'pending');
  const outputs = r.outputs || [];
  const codedCodes = [...new Set(outputs.filter((o) => o.codedUrl && !o.codedStale).flatMap((o) => (o.codes?.length ? o.codes : o.code ? [o.code] : [])))];
  const codedStale = outputs.some((o) => (o.codes?.length || o.code) && o.codedStale);
  const rendered = outputs.some((o) => o.status === 'done');
  let note = null;
  if (printing) note = ['busy', '⏳ Đang in mã lên ảnh kết quả… (xem bước "In mã lên ảnh" trên thẻ lần chạy)'];
  else if (r.status === 'failed' && r.stage === 'badge') note = ['warn', `In mã lên ảnh lỗi: ${r.error || ''}`];
  else if (codedStale) note = ['warn', r.status === 'running' ? '⚠ Ảnh kết quả chưa có mã mới — sẽ in khi render xong.' : '⚠ Ảnh kết quả chưa có mã / font mới (sẽ in lại khi lần chạy tiếp tục).'];
  else if (codedCodes.length) note = ['ok', `✓ Đã in mã lên ảnh: ${codedCodes.join(', ')} — tải "ảnh có mã" ở Ảnh kết quả hoặc gói ZIP TikTok.`];
  else if (rendered) note = ['', 'Ảnh kết quả hiện chưa in mã nào — đặt mã rồi bấm Lưu & in mã lên ảnh. Ảnh gốc vẫn giữ nguyên.'];
  else note = ['', 'Chưa có ảnh kết quả (đang render). Vẫn đặt mã / tải Excel được; mã sẽ in lên ảnh khi render xong.'];

  return (
    <div className="lightbox" onClick={onClose}>
      <div className="products-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="row between">
          <div>
            <h2>🏷️ Mã & sản phẩm — {outfitGroups.length} Bộ ({rows ? rows.length : r.productItemCount || 0} sản phẩm)</h2>
            <small className="muted">
              Khi 1 ảnh mặc 2–4 món (VD Áo + Quần/Váy), hệ thống tự chia vị trí Trái trên (Áo/Bộ) · Phải trên (Quần/Váy) · Tầng 2 (Khoác/Túi) và in đủ các mã lên cùng 1 ảnh 2K. Excel 6 cột (Mã · Giá · Mô tả · Ảnh · Hoa hồng Shopee · Link Shopee Aff) xuất đủ từng món.
              {frame && ` Ảnh ${frame.width}×${frame.height}${frame.probed ? '' : ' (ước lượng)'}.`}
            </small>
          </div>
          <button className="lightbox-close" onClick={onClose} title="Đóng (Esc)">×</button>
        </div>

        {/* Thanh chọn Font chữ & Phong cách khung mã */}
        <div className="badge-style-bar row between" style={{ flexWrap: 'wrap', gap: 8 }}>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <b className="small">Font & kiểu khung mã:</b>
            {Object.entries(BADGE_STYLES).map(([id, s]) => (
              <button
                key={id}
                type="button"
                className={'small-btn' + (badgeStyle === id ? ' on primary-outline' : '')}
                style={{ fontFamily: s.font }}
                onClick={() => { setBadgeStyle(id); setDirty(true); }}
              >
                {s.label}
              </button>
            ))}
          </div>
          <label className="check small" title="Khi 1 ảnh có từ 2 sản phẩm trở lên, tự thêm nhãn món ở trước mã để khách dễ phân biệt (VD: ÁO · AO_01)">
            <input type="checkbox" checked={showSlotPrefix} onChange={(e) => { setShowSlotPrefix(e.target.checked); setDirty(true); }} />
            Hiện tên món khi ảnh có ≥ 2 mã (VD: <code>ÁO · AO_01</code>)
          </label>
        </div>

        {!rows ? (
          <p className="muted">{error ? '' : 'Đang tải…'}</p>
        ) : (
          <table className="table products-table">
            <thead>
              <tr>
                <th className="clip-col">Sản phẩm</th>
                <th>Thông tin & Mã sản phẩm</th>
                <th className="badge-col">Khung mã trên ảnh kết quả</th>
              </tr>
            </thead>
            <tbody>
              {outfitGroups.map((group) => {
                const first = group.rows[0];
                const previewBadges = group.rows.map((x) => {
                  const c = codeOf(x);
                  return {
                    key: x.key,
                    text: badgeDisplayText(x, c, showSlotPrefix),
                    hasCode: !!c,
                    x: x.badge.x,
                    y: x.badge.y,
                    scale: x.badge.scale,
                  };
                });
                const activeRow = group.rows.find((x) => x.key === activeKey) || first;

                return group.rows.map((row, ri) => (
                  <tr key={row.key} className={ri === 0 ? 'outfit-group-start' : ''}>
                    <td className="clip-col">
                      <b>#{row.index}</b>{' '}
                      {row.slotLabel && <span className="slot-pill">{row.slotLabel}</span>}
                      <div className="small muted">{group.outfitLabel} · {row.clipName}</div>
                      <div className="row gap-xs" style={{ marginTop: 4, alignItems: 'flex-start' }}>
                        {row.thumbUrl ? <img className="mini-thumb" src={row.thumbUrl} alt="" title={row.assetName || 'Ảnh sản phẩm'} style={{ width: 64, height: 86 }} /> : <div className="small muted">Không có ảnh SP</div>}
                        {ri === 0 && (row.codedUrl || row.outputUrl) && (
                          <img className="mini-thumb" src={row.codedUrl || row.outputUrl} alt="" title={row.codedUrl ? 'Ảnh kết quả đã in mã — đây là ảnh xuất vào Excel' : 'Ảnh kết quả (chưa in mã)'} style={{ width: 64, height: 86 }} />
                        )}
                      </div>
                      <div className="small muted" style={{ marginTop: 2 }}>{row.renderName ? `Ảnh Excel: ${row.renderCoded ? 'bản có mã' : 'ảnh render'}` : 'Ảnh Excel: chưa render'}</div>
                      {!row.hasMeta && <div className="warn-text">⚠ Chưa có dữ liệu SP</div>}
                    </td>
                    <td>
                      <div className="field-grid">
                        <label>
                          <span>Mã sản phẩm * (dạng LOAI_SO)</span>
                          <div className="code-row">
                            <input
                              className={'code-input' + (badCode(row) ? ' bad' : '')}
                              value={row.code || ''}
                              placeholder={row.suggestedCode}
                              onFocus={() => setActiveKey(row.key)}
                              onChange={(e) => update(row.key, { code: normalizeCodeInput(e.target.value) })}
                            />
                            <button className="small-btn" disabled={busy} onClick={() => resuggest(row)} title="Gợi ý mã mới">Gợi ý lại</button>
                          </div>
                          {badCode(row) && <span className="err small">{dupCodes.has(codeOf(row)) ? 'Mã trùng với sản phẩm khác' : 'Cần dạng LOAI_SO, vd. VAY_01'}</span>}
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
                          <textarea rows={2} maxLength={600} value={row.description || ''} onChange={(e) => update(row.key, { description: e.target.value })} />
                        </label>
                        <label className="full">
                          <span>
                            Hoa hồng Shopee (đ){row.commissionRateBps ? ` · ${(row.commissionRateBps / 100).toLocaleString('vi-VN')}%` : ''}
                            {row.commissionRateText ? ` (${row.commissionRateText})` : ''}
                          </span>
                          <div className="code-row">
                            <input type="number" min="0" step="100" value={row.commission ?? ''} placeholder="nhập tay hoặc lấy từ Shopee" onChange={(e) => update(row.key, { commission: e.target.value === '' ? null : Number(e.target.value) })} />
                            {row.itemId && row.platform === 'shopee' && (
                              <button className="small-btn" disabled={busy} onClick={() => fetchCommission(row)}>🔄 Lấy hoa hồng</button>
                            )}
                          </div>
                        </label>
                        <label className="full">
                          <span>🔗 Link Shopee Aff (đi theo ảnh sản phẩm · xuất ra cột 6 Excel)</span>
                          <div className="code-row">
                            <input
                              type="url"
                              value={row.affiliateUrl || ''}
                              placeholder="https://s.shopee.vn/... (tự điền khi bóc link, hoặc dán tay)"
                              onChange={(e) => update(row.key, { affiliateUrl: e.target.value })}
                            />
                            {/^https?:\/\//i.test((row.affiliateUrl || '').trim()) && (
                              <a className="small" href={row.affiliateUrl.trim()} target="_blank" rel="noreferrer" style={{ whiteSpace: 'nowrap' }}>Mở ↗</a>
                            )}
                          </div>
                          {row.shopeeUrl && row.shopeeUrl !== row.affiliateUrl && (
                            <small className="muted">Link gốc SP: <a href={row.shopeeUrl} target="_blank" rel="noreferrer">{row.shopeeUrl}</a></small>
                          )}
                        </label>
                      </div>
                    </td>
                    {ri === 0 && (
                      <td className="badge-col" rowSpan={group.rows.length}>
                        <div className="stack" style={{ gap: 8 }}>
                          {frame && (
                            <MultiBadgePreview
                              frameUrl={first.frameUrl}
                              frame={frame}
                              badges={previewBadges}
                              activeKey={activeRow.key}
                              styleId={badgeStyle}
                              onSelectKey={(k) => setActiveKey(k)}
                              onChange={(k, p) => updateBadge(k, p)}
                            />
                          )}
                          <div className="badge-tools small">
                            <span className="muted">
                              {group.rows.length > 1
                                ? <>Đang chỉnh: <b>{activeRow.slotLabel || activeRow.clipName}</b> (bấm trực tiếp từng khung mã trên ảnh để kéo)</>
                                : 'Kéo khung mã trên hình để đổi vị trí.'}
                            </span>
                            <label>
                              <span>Cỡ chữ ({activeRow.slotShort || 'Mã'}): ×{Number(activeRow.badge.scale).toFixed(2)}</span>
                              <input type="range" min="0.45" max="2" step="0.05" value={activeRow.badge.scale} onChange={(e) => updateBadge(activeRow.key, { scale: Number(e.target.value) })} />
                            </label>
                            <div className="row gap-xs" style={{ flexWrap: 'wrap' }}>
                              <a onClick={() => resetOutfitLayout(group.outfitKey)} title="Đặt lại vị trí Trái/Phải trên gọn đẹp">↺ Vị trí mặc định</a>
                              {rows.length > 1 && (
                                <a onClick={() => applyScaleAll(activeRow.badge.scale)} title="Áp cỡ chữ đang chỉnh cho toàn bộ các mã">Áp cỡ chữ cho tất cả</a>
                              )}
                            </div>
                          </div>
                        </div>
                      </td>
                    )}
                  </tr>
                ));
              })}
            </tbody>
          </table>
        )}

        {note && <div className={'merge-note ' + note[0]}>{note[1]}</div>}
        {saved && !dirty && !printing && <small className="ok">Đã lưu lúc {new Date(saved.at).toLocaleTimeString('vi-VN')}{saved.remerge ? ' · đã yêu cầu in mã lên ảnh' : ' · không có gì đổi so với ảnh đã in mã'}</small>}
        {error && <div className="err">{error}</div>}

        <div className="row">
          <button className="primary" disabled={busy || !rows || invalid > 0 || !frame} onClick={save} title="Lưu mã / thông tin và in đủ các khung mã lên từng ảnh kết quả">
            💾 Lưu & in mã lên ảnh{withCode ? ` (${withCode} mã)` : ''}
          </button>
          <button disabled={busy || !rows} onClick={download} title="Tải file Excel 6 cột (kèm Link Shopee Aff)">📊 Tải Excel</button>
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
  const [syncMs, setSyncMs] = useState(Number(r.options?.syncOffsetMs) || 0);
  useEffect(() => {
    setSyncMs(Number(r.options?.syncOffsetMs) || 0);
  }, [r.options?.syncOffsetMs]);
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
  const isSuno = r.workflow === 'nhac-suno';

  return (
    <div className={'card stack run' + (r.status === 'failed' ? ' failed' : '')}>
      <div className="row between">
        <div>
          <b>{r.sourceId ? (source?.name || 'Video gốc đã xoá') : r.workflowName}</b>{' '}
          <small className="muted">
            · {r.sourceId
              ? `${r.clipIds.length} đoạn`
              : isSuno
                ? `${r.options?.duration || '10s'} · ${r.options?.aspectRatio || '16:9'}`
                : r.previews?.length
                  ? `${r.previews.length} ảnh xem trước`
                  : `${r.outputs?.length || 0} ảnh`} · {new Date(r.createdAt).toLocaleString('vi-VN')}
          </small>
        </div>
        <span className={`badge ${color}`}>{label}</span>
      </div>

      <div className="stages">
        {r.stageList.filter((s) => !s.hidden).map((s, i) => (
          <React.Fragment key={s.id}>
            {i > 0 && <span className="arrow">→</span>}
            <span className={'stage ' + s.status} title={s.label}>
              {s.status === 'done' ? '✓' : s.status === 'running' ? '⏳' : s.status === 'paused' ? '⏸' : s.status === 'skipped' ? '–' : '○'} {s.label}
              {s.total > 1 && <small> {s.done}/{s.total}</small>}
            </span>
          </React.Fragment>
        ))}
      </div>

      {(r.frameUrl || bgJob || r.backgrounds?.length > 1 || trJob || r.backgroundUrl || r.merge?.url) && (
        <div className="row" style={{ flexWrap: 'wrap' }}>
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
          {r.backgrounds?.length > 1 ? (
            r.backgrounds.map((bgItem) => {
              const j = jobs.find((x) => x.id === bgItem.id);
              return j ? (
                <div key={bgItem.key} className="stack bg-job">
                  <small className="muted">Bối cảnh sạch #{bgItem.index}</small>
                  <JobCard compact job={j} refresh={refresh} />
                </div>
              ) : null;
            })
          ) : bgJob ? (
            // Thẻ job ảnh bối cảnh: Thử lại / Sửa prompt / chọn lần tạo. Đổi bối cảnh → web tự thay nền lại cho mọi đoạn.
            <div className="stack bg-job">
              <small className="muted">Bối cảnh mới</small>
              <JobCard compact job={bgJob} refresh={refresh} />
              <small className="muted">Thử lại hoặc chọn lần tạo khác → mọi đoạn phải thay bối cảnh lại (≈20 credit/đoạn) và ghép lại.</small>
            </div>
          ) : r.backgroundUrl && <figure className="mini"><img src={r.backgroundUrl} alt="" /><figcaption>Bối cảnh mới</figcaption></figure>}
          {r.merge?.url && (isSuno ? (
            <div className="suno-final-wrap row">
              <figure className="suno-final-fig" style={{ margin: 0 }}>
                <video
                  className={'suno-final-video' + (r.options?.aspectRatio === '9:16' ? ' portrait' : '')}
                  src={r.merge.url}
                  controls
                  preload="metadata"
                  poster={r.merge.thumbUrl}
                />
                <figcaption className="small muted">
                  Video hoàn chỉnh (100% nhạc gốc Suno)
                  {r.merge?.watermarkRemoved !== false && <span style={{ display: 'block', color: 'var(--green)', fontSize: 10 }}>✓ Đã xoá logo Gemini</span>}
                </figcaption>
              </figure>
              <div className="suno-resync-box stack">
                <b className="small">🎚️ Dịch khớp nhạc (0 credit)</b>
                <small className="muted">
                  Nếu miệng mở sớm/trễ hơn nhạc gốc, chỉnh độ dịch âm thanh (ms) rồi bấm Ghép lại — chỉ chạy FFmpeg (~1s), không tốn credit Flow.
                </small>
                <div className="row gap-xs" style={{ flexWrap: 'wrap' }}>
                  {[-500, -200, 0, 200, 500].map((v) => (
                    <button
                      key={v}
                      type="button"
                      className={'small-btn' + (syncMs === v ? ' primary-outline' : '')}
                      disabled={busy}
                      onClick={() => setSyncMs(v)}
                    >
                      {v > 0 ? `+${v}ms` : `${v}ms`}
                    </button>
                  ))}
                </div>
                <div className="row gap-xs" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
                  <input
                    type="number"
                    min={-1500}
                    max={1500}
                    step={50}
                    style={{ width: 90 }}
                    disabled={busy}
                    value={syncMs}
                    onChange={(e) => setSyncMs(Math.max(-1500, Math.min(1500, Number(e.target.value) || 0)))}
                  />
                  <button
                    type="button"
                    className="small-btn primary"
                    disabled={busy || r.status === 'running'}
                    onClick={() => act(() => api.resyncRunAudio(r.id, syncMs))}
                  >
                    🔄 Ghép lại nhạc (0 credit)
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <figure className="mini">
              <video src={r.merge.url} controls preload="metadata" poster={r.merge.thumbUrl} />
              <figcaption>
                Video hoàn chỉnh
                {r.merge?.watermarkRemoved !== false && <span style={{ display: 'block', color: 'var(--green)', fontSize: 10 }}>✓ Đã xoá logo Gemini</span>}
              </figcaption>
            </figure>
          ))}
        </div>
      )}

      {r.stageList.filter((s) => s.note && !s.hidden).map((s) => (
        <small key={s.id} className="muted">ℹ {s.label}: {s.note}</small>
      ))}
      {r.previews?.length > 0 && <PreviewGallery run={r} jobs={jobs} refresh={refresh} />}

      {r.error && <div className="err">{r.error}</div>}
      {r.status === 'paused' && (r.reviewNote ? (
        <div className="alert warn small">⏸ {r.reviewNote}</div>
      ) : pausedBeforeMotion ? (
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
      {r.scenes?.length > 0 && <SceneTable run={r} jobs={jobs} refresh={refresh} />}
      {r.outputs?.length > 0 && <OutputGallery run={r} jobs={jobs} state={state} refresh={refresh} />}
      {showProducts && <ProductCodeSheet run={r} refresh={refresh} onClose={() => setShowProducts(false)} />}

      <div className="row" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        {r.status === 'paused' && (
          <button className="primary" disabled={busy} onClick={() => act(() => api.resumeRun(r.id))}>
            {r.resumeLabel || (pausedBeforeMotion ? '▶ Tiếp tục: tạo video' : '▶ Tiếp tục: thay bối cảnh')}
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
            🏷️ Mã & sản phẩm{r.productCount ? ` (${r.productCount})` : ''}{(r.outputs || []).some((o) => (o.codes?.length || o.code) && o.codedStale) ? ' ⚠' : ''}
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
