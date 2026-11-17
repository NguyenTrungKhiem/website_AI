// Khối "Outfit" của tab Nam (Video thời trang không voice – Nam, quy trình có wf.outfitSets): danh sách outfit, mỗi outfit gồm
// các ô món (áo, quần, áo khoác, giày, túi — slots do server khai báo), mỗi ô có ảnh MẶT TRƯỚC (chọn trong thư viện / tải từ máy /
// 🛒 bóc tách link) và ảnh MẶT SAU (BackViewControl: thư viện / tải từ máy / AI tạo / AI làm sạch / lấy từ Flow).
// KHÔNG ô nào bắt buộc: món thiếu AI tự phối theo "phong cách" của outfit khi tạo ảnh xem trước.
// value = [{ items: { [slot]: { front, back } }, style, main, text }] · onChange(danh sách mới) · max = số outfit tối đa của chuyển động.
// captionMode: 'code' = in mã của món `main` (mặc định món đầu tiên có ảnh) · 'text' = chữ tuỳ ý của outfit (`text`) · 'none'.
// Mỗi outfit có khối "Ảnh outfit" (LookPreview): nút tạo ảnh KOL/KOC mặc đủ bộ ngay tại đây (Flow, 0 credit) để xem trước khi chạy;
// look.preview = id ảnh đã chọn (lần chạy dùng đúng ảnh này nếu còn khớp lựa chọn), look.previewJob = job đang tạo.
// onChange nhận danh sách mới HOẶC hàm (danh sách hiện tại) => danh sách mới (dùng khi job xong, tránh ghi đè nhau).
import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { AssetPicker, BackViewControl, CaptionModePicker, ImageZoom, MAX_CAPTION_TEXT, cleanCaptionText, useAction } from '../components.jsx';

// [tên nút, câu phong cách tiếng Anh gửi cho AI]
const STYLE_PRESETS = [
  ['Hàn Quốc streetwear', 'Korean streetwear: relaxed fit, layered, chunky sneakers'],
  ['Công sở lịch lãm', 'smart office menswear: clean tailored lines, leather shoes'],
  ['Thể thao', 'sporty athleisure: joggers or shorts, running sneakers'],
  ['Tối giản', 'minimalist: neutral colours, clean lines, no visible logos'],
  ['Đi biển', 'summer beach holiday: light breathable fabrics, sandals or canvas shoes'],
];

export const emptyLook = () => ({ items: {}, style: '', main: null, text: '' });
const isBack = (a) => a.isBackView || /Mặt sau Flow/.test(a.name || '');

// Chữ ký outfit = KOL/KOC | phong cách | ảnh dùng cho từng ô (mặt trước, không có thì mặt sau). PHẢI tính giống server
// (server/workflows/video-thoi-trang-khong-voice-nam.js: lookSig) — ảnh outfit chỉ được dùng khi chữ ký còn khớp.
// bag = outfit này có túi (true / false — chuyển động túi tuỳ outfit đã quy về từng outfit, xem bagOfLook); không túi thì ô Túi
// không tính và chữ ký có đuôi "|nobag".
const lookSigOf = (modelId, look, slots, has, bag = true) =>
  [
    has(modelId) ? modelId : '',
    String(look.style || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    ...slots.map((s) => {
      if (!bag && s.key === 'bag') return '';
      const it = look.items?.[s.key] || {};
      return (has(it.front) && it.front) || (has(it.back) && it.back) || '';
    }),
  ].join('|') + (bag ? '' : '|nobag');

// Túi của 1 outfit theo kiểu túi của chuyển động (giống server: bagForLook): 'optional' = outfit có ảnh túi mới có túi
const bagOfLook = (motionBag, look, has) => {
  if (motionBag !== 'optional') return motionBag !== false;
  const it = look.items?.bag || {};
  return has(it.front) || has(it.back);
};

// Khối "Ảnh outfit" của 1 outfit: tạo ảnh KOL/KOC mặc đủ bộ (món đã nhập giữ đúng, món thiếu AI tự phối theo phong cách).
// patch(fn) = cập nhật danh sách outfit bằng hàm (an toàn khi nhiều job xong cùng lúc).
function LookPreview({ index, look, slots, given, auto, modelId, wfId, bag, motion, patch, state, refresh }) {
  const { busy, error, run } = useAction();
  const [zoom, setZoom] = useState(false);
  const [failMsg, setFailMsg] = useState('');
  const has = (id) => !!id && state.assets.some((a) => a.id === id);
  const modelOk = has(modelId);
  const sig = lookSigOf(modelId, look, slots, has, bag);
  const current = look.preview ? state.assets.find((a) => a.id === look.preview) : null;
  const stale = !!current && current.lookSig !== sig;
  const versions = modelOk ? state.assets.filter((a) => a.lookSig === sig && a.id !== current?.id) : [];
  const jobId = look.previewJob || null;
  const job = jobId ? state.jobs?.find((j) => j.id === jobId) : null;
  const pending = !!job && (job.status === 'running' || job.status === 'queued');
  const setOn = (match, change) => patch((list) => list.map((l, k) => (match(l, k) ? { ...l, ...change } : l)));

  // Job xong -> gắn ảnh vừa tạo vào outfit (tìm outfit theo id job, vì người dùng có thể đã đổi thứ tự outfit)
  useEffect(() => {
    if (!jobId) return;
    const j = state.jobs?.find((x) => x.id === jobId);
    if (!j || j.status === 'running' || j.status === 'queued') return;
    const a = state.assets.find((x) => x.fromJobId === jobId && x.lookSig);
    if (a) setOn((l) => l.previewJob === jobId, { preview: a.id, previewJob: null });
    else if (j.status === 'failed') {
      setFailMsg(j.error || 'Flow lỗi');
      setOn((l) => l.previewJob === jobId, { previewJob: null });
    }
  }, [state.jobs, state.assets, jobId]);
  // Đang tạo thì làm mới nhanh để thấy tiến trình
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(refresh, 1500);
    return () => clearInterval(t);
  }, [pending, refresh]);

  const create = () =>
    run(async () => {
      setFailMsg('');
      const res = await api.lookPreview(wfId, { model: modelId, look: { items: look.items || {}, style: look.style || '' }, motion });
      setOn((_, k) => k === index, { previewJob: res.id });
      await refresh();
    });
  // Ảnh mới nhất đã tạo xong trên Flow -> lưu làm ảnh outfit này (khi Flow tạo xong mà web báo lỗi / tải về lỗi, hoặc tự tạo bằng tay)
  const [fetching, setFetching] = useState(false);
  const fromFlow = () =>
    run(async () => {
      setFailMsg('');
      setFetching(true);
      try {
        const a = await api.lookFromFlow(wfId, { model: modelId, look: { items: look.items || {}, style: look.style || '' }, motion });
        await refresh();
        setOn((_, k) => k === index, { preview: a.id, previewJob: null });
      } finally {
        setFetching(false);
      }
    });
  const progress = job?.attempts?.at(-1)?.progress || 'Đang tạo…';

  return (
    <div className="look-preview row">
      <div
        className={'look-shot' + (current ? '' : ' empty') + (stale ? ' stale' : '')}
        onClick={() => current && setZoom(true)}
        title={current ? 'Bấm để phóng to' : 'Chưa tạo ảnh outfit'}
      >
        {current ? <img src={current.url} alt="" /> : <span>{pending ? '⏳' : 'Chưa có ảnh'}</span>}
      </div>
      <div className="stack" style={{ gap: 6, flex: '1 1 260px', minWidth: 0 }}>
        <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <b className="small">🖼 Ảnh KOL/KOC mặc outfit {index + 1}</b>
          {current && !stale && <span className="ok small">✓ Khi chạy sẽ dùng đúng ảnh này</span>}
          {stale && <span className="warn-text">⚠ Ảnh tạo từ lựa chọn cũ (đã đổi món / phong cách / KOL, hoặc đổi giữa chuyển động có túi ↔ không túi) — bấm tạo lại, nếu không lần chạy sẽ tự tạo ảnh mới</span>}
        </div>
        <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            type="button"
            className={current && !stale ? '' : 'primary'}
            disabled={busy || pending || !modelOk}
            onClick={create}
            title={modelOk ? 'AI tự ghép prompt từ ảnh KOL/KOC + các món đã nhập + phong cách, rồi tạo 1 ảnh toàn thân đủ bộ bằng Flow (Nano Banana, 0 credit)' : 'Chọn ảnh KOL/KOC ở trên trước'}
          >
            {pending ? `⏳ ${progress}` : current && !stale ? '🔄 Tạo bản khác (0 credit)' : current ? '🔄 Tạo lại ảnh outfit (0 credit)' : '✨ Tạo ảnh outfit (0 credit)'}
          </button>
          <button
            type="button"
            disabled={busy || pending || !modelOk}
            onClick={fromFlow}
            title={modelOk ? 'Lấy ảnh mới nhất đã tạo xong trong cửa sổ Chrome Google Flow (ô ảnh đầu tiên của lưới) về làm ảnh outfit này — dùng khi Flow tạo xong mà web báo lỗi / tải về lỗi, hoặc bạn tự tạo, chỉnh ảnh bằng tay trên Flow' : 'Chọn ảnh KOL/KOC ở trên trước'}
          >
            {fetching ? '⏳ Đang lấy từ Flow…' : '📥 Lấy từ Flow'}
          </button>
          {current && <a className="small" onClick={() => setZoom(true)}>🔍 Phóng to</a>}
          {current && <a className="small" onClick={() => setOn((_, k) => k === index, { preview: null })} title="Không dùng ảnh này; lần chạy sẽ tự tạo ảnh mới">Bỏ ảnh</a>}
          {!modelOk && <span className="small muted">Chọn ảnh KOL/KOC ở trên trước.</span>}
        </div>
        <small className="muted">
          Ảnh gồm: KOL/KOC{given.length ? ` + giữ đúng ${given.map((s) => s.label.toLowerCase()).join(', ')} bạn đã nhập` : ''}
          {auto.length ? ` · AI tự phối ${auto.map((s) => s.label.toLowerCase()).join(', ')}` : ''}
          {bag ? '' : ' · KHÔNG có túi'}
          {` · phong cách: ${(look.style || '').trim() || 'AI tự chọn'}`}
        </small>
        {versions.length > 0 && (
          <div className="row look-versions" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="small muted">{current && !stale ? 'Bản khác đã tạo:' : 'Bản đã tạo cho lựa chọn này:'}</span>
            {versions.slice(0, 8).map((a) => (
              <img key={a.id} src={a.url} alt="" className="mini-thumb" title="Bấm để dùng bản này" onClick={() => setOn((_, k) => k === index, { preview: a.id })} />
            ))}
          </div>
        )}
        {(error || failMsg) && <span className="err small">{error || failMsg}</span>}
      </div>
      {zoom && current && <ImageZoom url={current.url} name={current.name} downloadUrl={current.url} onClose={() => setZoom(false)} />}
    </div>
  );
}

// bag = chuyển động đang chọn có túi (server khai báo theo từng chuyển động): không túi thì ô Túi tắt (ảnh đã chọn vẫn giữ),
// ảnh outfit và video không có túi · motion = khoá chuyển động đang chọn (gửi kèm khi tạo ảnh outfit).
// backOutfits = thứ tự (0, 1, 2…) các outfit có mốc QUAY LƯNG trong chuyển động đang chọn với số outfit hiện tại; outfit không
// nằm trong danh sách thì không cần ảnh mặt sau (không tạo ảnh xem trước mặt sau, không gửi lên Flow). null = không rõ.
// bag = kiểu túi của chuyển động: true (luôn có túi) · false (không túi) · 'optional' (túi tuỳ outfit: outfit nào có ảnh túi mới
// đeo túi đó, AI không tự thêm) · bagNote = ghi chú của chuyển động (vd. outfit nào trong video mẫu có túi).
export default function MaleOutfits({ slots, value, onChange, max = 3, captionMode = 'code', onCaptionMode, modelId = null, wfId, bag = true, bagNote = null, motion = null, backOutfits = null, state, refresh }) {
  const has = (id) => !!id && state.assets.some((a) => a.id === id);
  const bagOptional = bag === 'optional';
  const looks = Array.isArray(value) && value.length ? value : [emptyLook()];
  const [picking, setPicking] = useState(null); // { i, slot } đang chọn ảnh mặt trước cho ô nào
  const assetOf = (id) => (id ? state.assets.find((a) => a.id === id) : null);
  const setLook = (i, patch) => onChange(looks.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  const setItem = (i, slotKey, patch) => {
    const items = { ...(looks[i].items || {}) };
    const next = { ...(items[slotKey] || {}), ...patch };
    if (next.front || next.back) items[slotKey] = { front: next.front || null, back: next.back || null };
    else delete items[slotKey];
    setLook(i, { items });
  };
  const move = (i, d) => {
    const j = i + d;
    if (j < 0 || j >= looks.length) return;
    const a = [...looks];
    [a[i], a[j]] = [a[j], a[i]];
    onChange(a);
  };
  const remove = (i) => onChange(looks.filter((_, k) => k !== i));
  const over = looks.length > max;
  const pickingItem = picking && (looks[picking.i]?.items?.[picking.slot.key] || {});

  return (
    <div className="stack male-outfits">
      <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <b className="small">
          👕 Outfit trong video ({looks.length}/{max}) ·{' '}
          {Array.isArray(backOutfits) && backOutfits.length === 0
            ? 'chuyển động không quay lưng nên chỉ cần ảnh mặt trước của từng món, không ô nào bắt buộc'
            : 'mỗi món có mặt trước + mặt sau, không ô nào bắt buộc'}
        </b>
        <CaptionModePicker value={captionMode} onChange={onCaptionMode} />
      </div>
      <small className={bag === false ? 'warn-text' : 'muted'} style={{ fontSize: 12 }}>
        {bagOptional
          ? '👜 Chuyển động đang chọn có TÚI TUỲ OUTFIT: outfit nào bạn nhập ảnh ở ô Túi thì nhân vật đeo đúng túi đó; outfit không nhập thì KHÔNG có túi (AI không tự thêm).'
          : bag
            ? '🎒 Chuyển động đang chọn CÓ TÚI: outfit luôn có túi (ảnh túi bạn nhập, không nhập thì AI tự phối) rồi mới làm video.'
            : '🚫 Chuyển động đang chọn KHÔNG TÚI: ô Túi không dùng, ảnh outfit và video không có túi.'}
        {bagNote ? <> {bagNote}</> : null}
      </small>

      {looks.map((l, i) => {
        // Món đã nhập (còn ảnh trong thư viện) và món AI sẽ tự phối
        const used = slots.filter((s) => bag !== false || s.key !== 'bag'); // chuyển động không túi: ô Túi không tính
        const given = used.filter((s) => assetOf(l.items?.[s.key]?.front) || assetOf(l.items?.[s.key]?.back));
        // túi tuỳ outfit: AI không tự phối túi (không nhập = không túi)
        const auto = used.filter((s) => s.key !== 'jacket' && !(bagOptional && s.key === 'bag') && !given.includes(s));
        const lookBag = bagOfLook(bag, l, has);
        const mainSlot = given.find((s) => s.key === l.main) || given[0] || null;
        const mainAsset = mainSlot && (assetOf(l.items[mainSlot.key].front) || assetOf(l.items[mainSlot.key].back));
        return (
          <div key={i} className="outfit-card stack">
            <div className="row between" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
              <div>
                <b>Outfit {i + 1}</b>{' '}
                <small className="muted">
                  {given.length ? `· đã nhập: ${given.map((s) => s.label).join(', ')}` : '· chưa nhập món nào'}
                  {auto.length ? ` · AI tự phối: ${auto.map((s) => s.label.toLowerCase()).join(', ')}` : ''}
                </small>
                {Array.isArray(backOutfits) && (
                  <small className={backOutfits.includes(i) ? 'warn-text' : 'muted'} style={{ display: 'block', fontSize: 12 }}>
                    {backOutfits.includes(i)
                      ? '↩ Outfit này có cú quay lưng trong chuyển động đang chọn: nên nhập ảnh mặt sau của món chính.'
                      : '↩ Outfit này không quay lưng trong chuyển động đang chọn: không cần ảnh mặt sau (ô Mặt sau đã ẩn).'}
                  </small>
                )}
              </div>
              <span className="row gap-xs small">
                {i > 0 && <a onClick={() => move(i, -1)} title="Đưa outfit này lên trước (mặc sớm hơn trong video)">↑ Lên</a>}
                {i < looks.length - 1 && <a onClick={() => move(i, 1)} title="Đưa outfit này xuống sau">↓ Xuống</a>}
                {looks.length > 1 && <a onClick={() => remove(i)} title="Bỏ outfit này khỏi video">✕ Xoá outfit</a>}
              </span>
            </div>

            <div className="garment-grid">
              {slots.map((slot) => {
                const it = l.items?.[slot.key] || {};
                const front = assetOf(it.front);
                if (bag === false && slot.key === 'bag') {
                  return (
                    <div key={slot.key} className="garment-slot stack off" title="Chọn chuyển động có túi ở ô Chuyển động bên dưới để dùng ô này">
                      <b className="small">{slot.label} — không dùng</b>
                      <small className="muted">
                        Chuyển động đang chọn không có túi nên ảnh outfit và video không có túi.
                        {(it.front || it.back) ? ' Ảnh túi đã chọn vẫn được giữ, đổi sang chuyển động có túi sẽ dùng lại.' : ''}
                      </small>
                    </div>
                  );
                }
                return (
                  <div key={slot.key} className="garment-slot stack">
                    <div className="row between" style={{ alignItems: 'center' }}>
                      <b className="small">{slot.label}</b>
                      {(it.front || it.back) && <a className="small" onClick={() => setItem(i, slot.key, { front: null, back: null })} title="Bỏ cả ảnh mặt trước và mặt sau của món này">Bỏ món</a>}
                    </div>
                    <div className="row" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                      <span className="small muted">Mặt trước:</span>
                      <div className={'thumb pick' + (front ? '' : ' empty')} onClick={() => setPicking({ i, slot })} title={front ? front.name : 'Bấm để chọn ảnh trong thư viện, tải ảnh từ máy hoặc dán link sản phẩm để bóc tách'}>
                        {front ? <img src={front.url} alt="" /> : <span>+ Chọn</span>}
                      </div>
                      <div className="stack gap-xs small">
                        <a onClick={() => setPicking({ i, slot })}>{front ? 'Đổi ảnh' : 'Thư viện / tải từ máy / 🛒 bóc tách link'}</a>
                        {front && <a onClick={() => setItem(i, slot.key, { front: null })}>Bỏ mặt trước</a>}
                        {front?.productCode && <span className="code-chip" style={{ marginTop: 0 }} title="Mã sản phẩm của ảnh này">{front.productCode}</span>}
                      </div>
                    </div>
                    {/* Outfit không có cú quay lưng trong chuyển động đang chọn: không cần (và không dùng) ảnh mặt sau -> ẩn ô Mặt sau.
                        Ảnh mặt sau đã chọn trước đó vẫn được giữ trong dữ liệu (đổi sang chuyển động có quay lưng sẽ dùng lại). */}
                    {Array.isArray(backOutfits) && !backOutfits.includes(i) ? (
                      <small className="muted">Mặt sau: không cần cho chuyển động này{it.back ? ' (ảnh đã chọn vẫn giữ)' : ''}.</small>
                    ) : (
                      <BackViewControl
                        frontId={front ? it.front : null}
                        backId={it.back || null}
                        onChange={(id) => setItem(i, slot.key, { back: id })}
                        state={state}
                        refresh={refresh}
                        backPrompt={slot.key === 'shoes' || slot.key === 'bag' ? state.defaults?.itemBackViewPrompt : state.defaults?.backViewPrompt}
                        allowClear
                      />
                    )}
                  </div>
                );
              })}
            </div>

            <div className="row" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <span className="small muted">Phong cách phối đồ:</span>
              <input
                style={{ flex: '1 1 260px', minWidth: 0 }}
                maxLength={200}
                placeholder="Để trống = AI tự chọn phong cách hợp với món đã nhập (viết tiếng Việt hoặc tiếng Anh đều được)"
                value={l.style || ''}
                onChange={(e) => setLook(i, { style: e.target.value })}
                title="AI dùng phong cách này để tự phối các món bạn không nhập (quần, giày, túi…) khi tạo ảnh xem trước"
              />
              {STYLE_PRESETS.map(([vi, en]) => (
                <button key={vi} type="button" className="small-btn" onClick={() => setLook(i, { style: en })} title={en}>{vi}</button>
              ))}
            </div>

            {wfId && (
              <LookPreview
                index={i}
                look={l}
                slots={slots}
                given={given}
                auto={auto}
                modelId={modelId}
                wfId={wfId}
                bag={lookBag}
                motion={motion}
                patch={(fn) => onChange((cur) => fn(Array.isArray(cur) && cur.length ? cur : [emptyLook()]))}
                state={state}
                refresh={refresh}
              />
            )}

            <div className="row" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              {captionMode === 'code' && (
                <>
                  <span className="small muted">Mã in trên video khi mặc outfit này:</span>
                  {given.length ? (
                    <>
                      <select value={mainSlot.key} onChange={(e) => setLook(i, { main: e.target.value })} title="Mã sản phẩm của món nào được in lên video">
                        {given.map((s) => {
                          const a = assetOf(l.items[s.key].front) || assetOf(l.items[s.key].back);
                          return <option key={s.key} value={s.key}>{s.label}{a?.productCode ? ` · ${a.productCode}` : ''}</option>;
                        })}
                      </select>
                      {mainAsset?.productCode
                        ? <span className="code-chip" style={{ marginTop: 0 }}>{mainAsset.productCode}</span>
                        : <span className="small muted">chưa có mã → tự cấp khi chạy</span>}
                    </>
                  ) : <span className="small muted">outfit chưa có món nào nên không in mã</span>}
                </>
              )}
              {captionMode === 'text' && (
                <>
                  <span className="small muted">Chữ in trên video khi mặc outfit này:</span>
                  <input
                    className="caption-text"
                    maxLength={MAX_CAPTION_TEXT}
                    placeholder={i === 0 ? 'VD: NEW ARRIVAL' : '(để trống = giống outfit trên)'}
                    value={l.text || ''}
                    onChange={(e) => setLook(i, { text: cleanCaptionText(e.target.value) })}
                    onBlur={(e) => setLook(i, { text: cleanCaptionText(e.target.value).trim() })}
                  />
                </>
              )}
              {captionMode === 'none' && <span className="small muted">Không in chữ lên video</span>}
            </div>
          </div>
        );
      })}

      <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" disabled={looks.length >= max} onClick={() => onChange([...looks, emptyLook()])} title={looks.length >= max ? `Chuyển động đang chọn nhận tối đa ${max} outfit` : 'Thêm 1 outfit nữa vào cùng video'}>
          ＋ Thêm outfit
        </button>
        {over && <span className="err small">Chuyển động đang chọn nhận tối đa {max} outfit — xoá bớt {looks.length - max} outfit.</span>}
        <small className="muted">
          Video đổi outfit theo thứ tự trên, đổi đồ đúng ở các cú nhảy cắt của chuyển động. Bấm <b>✨ Tạo ảnh outfit</b> trong từng outfit để xem ngay KOL/KOC mặc
          đủ bộ (0 credit); khi chạy, quy trình dùng đúng ảnh đó (outfit chưa tạo thì tự tạo), tạo thêm ảnh mặt sau (chỉ outfit có cú quay lưng) rồi dừng chờ bạn duyệt trước khi làm video.
          Ảnh mặt sau của từng món không bắt buộc, có thì ảnh xem trước mặt sau chính xác hơn.
        </small>
      </div>

      {picking && (
        <div className="lightbox" onClick={() => setPicking(null)}>
          <div className="lightbox-body chooser" onClick={(e) => e.stopPropagation()}>
            <button className="lightbox-close" onClick={() => setPicking(null)} title="Đóng">×</button>
            <div className="lightbox-side stack">
              <b>Chọn ảnh MẶT TRƯỚC cho {picking.slot.label} – Outfit {picking.i + 1}</b>
              <AssetPicker
                kind="product"
                label="Thư viện ảnh sản phẩm (bấm ảnh để chọn, hoặc tải ảnh / dán link bên dưới)"
                assets={state.assets}
                hide={isBack}
                storageKey={`nam_${picking.slot.key}`}
                value={pickingItem.front || null}
                onChange={(id) => { if (id) { setItem(picking.i, picking.slot.key, { front: id }); setPicking(null); } }}
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
