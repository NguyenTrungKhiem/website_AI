import React, { useEffect, useRef, useState } from 'react';
import { api } from './api.js';

export const fmt = (s) => `${Number(s).toFixed(1)}s`;

// Nút xoá bấm 2 lần (lần 1 hỏi lại ngay trên nút). Không dùng window.confirm vì
// khung trình duyệt trong app không hiện hộp thoại đó (luôn trả về "Không").
export function ConfirmButton({ onConfirm, children, armedText = 'Bấm lần nữa để xoá', className = 'danger', link, disabled, title }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  const click = (e) => {
    e.stopPropagation();
    if (!armed) return setArmed(true);
    setArmed(false);
    onConfirm();
  };
  const cls = (className || '') + (armed ? ' armed' : '');
  return link ? (
    <a className={cls} onClick={click} title={title}>{armed ? armedText : children}</a>
  ) : (
    <button className={cls} onClick={click} disabled={disabled} title={title}>{armed ? armedText : children}</button>
  );
}

const STATUS = {
  queued: ['Đang chờ', 'gray'],
  running: ['Đang tạo…', 'blue'],
  done: ['Xong', 'green'],
  failed: ['Lỗi', 'red'],
  scheduled: ['⏰ Đã lên lịch', 'purple'],
};
export function Badge({ status }) {
  const [label, color] = STATUS[status] || [status, 'gray'];
  return <span className={`badge ${color}`}>{label}</span>;
}

export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run, setError };
}

export function FileDrop({ accept, multiple, onFiles, children }) {
  const ref = useRef();
  const [over, setOver] = useState(false);
  return (
    <div
      className={'drop' + (over ? ' over' : '')}
      onClick={() => ref.current.click()}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        onFiles([...e.dataTransfer.files]);
      }}
    >
      <input
        ref={ref}
        type="file"
        hidden
        accept={accept}
        multiple={multiple}
        onChange={(e) => { onFiles([...e.target.files]); e.target.value = ''; }}
      />
      {children}
    </div>
  );
}

// Chọn 1 ảnh (model / sản phẩm / bối cảnh) từ thư viện hoặc tải ảnh mới.
// state (tuỳ chọn) = state toàn app, để popup xem ảnh to biết job/cài đặt/prompt mặc định.
// multiple = chọn nhiều ảnh: value là mảng id (theo thứ tự chọn), bấm ảnh để thêm/bỏ, có số thứ tự trên ảnh.
export function AssetPicker({ kind, label, assets, value, onChange, refresh, state, multiple = false }) {
  // Ảnh nháp (bóc tách / kết quả làm sạch chưa bấm Dùng) không hiện trong thư viện
  const list = assets.filter((a) => a.kind === kind && !a.staging);
  const { busy, error, run } = useAction();
  const [viewing, setViewing] = useState(null); // id ảnh đang phóng to
  const [found, setFound] = useState(null); // kết quả bóc tách gần nhất (giữ nguyên sau khi chọn ảnh)
  const [slider, setSlider] = useState(null); // { images, startIdx } popup trượt + làm sạch
  const viewingAsset = list.find((a) => a.id === viewing);
  const selectedIds = multiple ? (Array.isArray(value) ? value : []) : value ? [value] : [];
  const isSelected = (id) => selectedIds.includes(id);
  // Chọn 1 ảnh: đơn -> đặt/bỏ; nhiều -> thêm vào cuối / bỏ khỏi danh sách
  const pick = (id) => {
    if (!multiple) return onChange(value === id ? null : id);
    onChange(isSelected(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id]);
  };
  const addSelected = (id) => (multiple ? onChange(isSelected(id) ? selectedIds : [...selectedIds, id]) : onChange(id));
  const removeSelected = (id) => (multiple ? onChange(selectedIds.filter((x) => x !== id)) : value === id && onChange(null));
  const upload = (files) =>
    run(async () => {
      const added = [];
      for (const f of files) added.push(await api.uploadAsset(kind, f));
      await refresh();
      if (!added.length) return;
      if (multiple) onChange([...selectedIds, ...added.map((a) => a.id)]);
      else onChange(added.at(-1).id);
    });
  // Mở popup trượt: ưu tiên các ảnh vừa bóc tách; chưa bóc tách thì trượt qua ảnh sản phẩm trong thư viện
  const openSlider = (startId) => {
    const images = found?.images?.length ? found.images : list.map((a) => ({ id: a.id, url: a.url, name: a.name, assetId: a.id }));
    const src = assets.find((a) => a.id === startId)?.source;
    const i = images.findIndex((im) => im.id === startId || im.assetId === startId || (src && im.url === src));
    setSlider({ images, startIdx: Math.max(0, i) });
    setViewing(null);
  };
  // Dùng 1 ảnh (gốc hoặc kết quả làm sạch): đưa vào thư viện rồi chọn cho bước này; giao diện bóc tách giữ nguyên
  const use = (id) =>
    run(async () => {
      await api.useAsset(id);
      await refresh();
      addSelected(id);
      setSlider(null);
    });
  return (
    <div className="picker">
      <div className="picker-head">
        <b>{label}{multiple && selectedIds.length > 0 ? ` (${selectedIds.length} đã chọn)` : ''}</b>
        <span className="row gap-xs">
          {multiple && list.length > selectedIds.length && <a onClick={() => onChange(list.map((a) => a.id))}>Chọn tất cả</a>}
          {selectedIds.length > 0 && <a onClick={() => onChange(multiple ? [] : null)}>Bỏ chọn</a>}
        </span>
      </div>
      <div className="thumbs">
        <FileDrop accept="image/*" multiple onFiles={upload}>
          <div className="thumb add">{busy ? '…' : '+ Tải ảnh'}</div>
        </FileDrop>
        {list.map((a) => (
          <div
            key={a.id}
            className={'thumb' + (isSelected(a.id) ? ' selected' : '')}
            onClick={() => pick(a.id)}
            title={a.name}
          >
            <img src={a.url} alt={a.name} />
            {multiple && isSelected(a.id) && <span className="order-badge">{selectedIds.indexOf(a.id) + 1}</span>}
            {a.fromJobId && <span className="flow-mark" title="Ảnh do Flow tạo lại">✨</span>}
            <button className="zoom-btn" title="Xem ảnh to" onClick={(e) => { e.stopPropagation(); setViewing(a.id); }}>🔍</button>
            <ConfirmButton
              className="x"
              armedText="Xoá?"
              title="Xoá ảnh"
              onConfirm={() => run(async () => { await api.deleteAsset(a.id); removeSelected(a.id); await refresh(); })}
            >
              ×
            </ConfirmButton>
          </div>
        ))}
      </div>
      {error && <div className="err">{error}</div>}
      {viewingAsset && (
        <Lightbox
          asset={viewingAsset}
          selected={isSelected(viewingAsset.id)}
          onSelect={(id) => addSelected(id)}
          onClose={() => setViewing(null)}
          onTryOther={kind === 'product' ? () => openSlider(viewingAsset.id) : null}
        />
      )}
      {kind === 'product' && <ProductImport kind={kind} found={found} setFound={setFound} onOpen={(i) => setSlider({ images: found.images, startIdx: i })} />}
      {slider && (
        <ExtractPopup
          images={slider.images}
          startIdx={slider.startIdx}
          kind={kind}
          state={state}
          refresh={refresh}
          busyOuter={busy}
          onUse={use}
          onClose={() => setSlider(null)}
        />
      )}
    </div>
  );
}

// Cửa sổ so sánh: video gốc (trái) và video kết quả (phải) phát đồng bộ; đổi giữa các lần tạo,
// chọn bản dùng, thử lại — để quyết định lấy hay làm lại.
export function CompareModal({ job, refresh, onClose }) {
  const attempts = job.attempts.filter((a) => a.outputUrl);
  const current = attempts.find((a) => a.outputUrl === job.outputUrl) || attempts.at(-1);
  const [n, setN] = useState(current?.n);
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const [dur, setDur] = useState(0);
  const [loop, setLoop] = useState(true);
  const [sound, setSound] = useState(false);
  const [rate, setRate] = useState(1);
  const [editing, setEditing] = useState(false);
  const [prompt, setPrompt] = useState(job.prompt);
  const left = useRef();
  const right = useRef();
  const { busy, error, run } = useAction();
  const att = attempts.find((a) => a.n === n) || current;
  const isActive = att && att.outputUrl === job.outputUrl;
  const vids = () => [left.current, right.current].filter(Boolean);

  // Đồng bộ: video phải làm chủ, video trái bám theo
  useEffect(() => {
    const r = right.current;
    const l = left.current;
    if (!r) return;
    const onTime = () => {
      setT(r.currentTime);
      if (l && Math.abs(l.currentTime - r.currentTime) > 0.12) l.currentTime = r.currentTime;
    };
    const onMeta = () => setDur(Math.max(r.duration || 0, l?.duration || 0));
    const onEnd = () => { if (loop) { for (const v of vids()) { v.currentTime = 0; v.play().catch(() => {}); } } else setPlaying(false); };
    r.addEventListener('timeupdate', onTime);
    r.addEventListener('loadedmetadata', onMeta);
    r.addEventListener('ended', onEnd);
    return () => { r.removeEventListener('timeupdate', onTime); r.removeEventListener('loadedmetadata', onMeta); r.removeEventListener('ended', onEnd); };
  }, [att?.outputUrl, loop]);

  useEffect(() => { for (const v of vids()) v.playbackRate = rate; }, [rate, att?.outputUrl]);
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
      if (e.key === 'Escape') onClose();
      if (e.key === ' ') { e.preventDefault(); toggle(); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1 / 30); }
      if (e.key === 'ArrowRight') { e.preventDefault(); step(1 / 30); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });

  const toggle = () => {
    const r = right.current;
    if (!r) return;
    if (r.paused) { for (const v of vids()) { v.currentTime = r.currentTime; v.play().catch(() => {}); } setPlaying(true); }
    else { for (const v of vids()) v.pause(); setPlaying(false); }
  };
  const seek = (sec) => { for (const v of vids()) v.currentTime = Math.max(0, Math.min(dur || 1e9, sec)); setT(sec); };
  const step = (d) => { for (const v of vids()) v.pause(); setPlaying(false); seek((right.current?.currentTime || 0) + d); };
  const fmtT = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}.${String(Math.floor((s % 1) * 100)).padStart(2, '0')}`;

  const use = () => run(async () => { await api.selectAttempt(job.id, att.n); await refresh(); });
  const retry = () => run(async () => { await api.retry(job.id, prompt); setEditing(false); await refresh(); onClose(); });

  return (
    <div className="lightbox" onClick={onClose}>
      <div className="compare" onClick={(e) => e.stopPropagation()}>
        <div className="row between compare-head">
          <b>⇄ So sánh — {job.videoLabel}</b>
          <button className="lightbox-close static" onClick={onClose} title="Đóng (Esc)">×</button>
        </div>
        <div className="compare-videos">
          <figure>
            <video ref={left} src={job.videoUrl} muted playsInline preload="auto" onClick={toggle} />
            <figcaption>Video gốc (đầu vào)</figcaption>
          </figure>
          <figure>
            {att ? (
              <video key={att.outputUrl} ref={right} src={att.outputUrl} muted={!sound} playsInline preload="auto" onClick={toggle} />
            ) : (
              <div className="placeholder">Chưa có kết quả</div>
            )}
            <figcaption>
              Kết quả — lần {att?.n} {isActive ? '(đang dùng)' : ''}
            </figcaption>
          </figure>
        </div>

        <div className="compare-controls">
          <button onClick={() => step(-1 / 30)} title="Lùi 1 khung (←)">◀︎|</button>
          <button className="play" onClick={toggle} title="Phát / dừng (Space)">{playing ? '❚❚' : '▶'}</button>
          <button onClick={() => step(1 / 30)} title="Tới 1 khung (→)">|▶︎</button>
          <input type="range" min={0} max={dur || 0} step={0.01} value={Math.min(t, dur || 0)} onChange={(e) => seek(Number(e.target.value))} className="grow" />
          <span className="tc small">{fmtT(t)} / {fmtT(dur)}</span>
          <select value={rate} onChange={(e) => setRate(Number(e.target.value))} title="Tốc độ">
            {[0.25, 0.5, 1].map((r) => <option key={r} value={r}>{r}×</option>)}
          </select>
          <label className="check small"><input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} /> Lặp</label>
          <label className="check small"><input type="checkbox" checked={sound} onChange={(e) => setSound(e.target.checked)} /> Tiếng kết quả</label>
        </div>

        {attempts.length > 1 && (
          <div className="row attempts">
            Lần tạo:
            {attempts.map((a) => (
              <button key={a.n} className={'chip' + (a.n === att?.n ? ' on' : '')} onClick={() => setN(a.n)} title={a.prompt}>
                {a.outputUrl === job.outputUrl ? '★ ' : ''}{a.n}
              </button>
            ))}
            <small className="muted">★ = bản đang dùng</small>
          </div>
        )}

        {editing ? (
          <div className="stack">
            <textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
            <div className="row">
              <button className="primary" disabled={busy} onClick={retry}>Tạo lại với prompt này</button>
              <button onClick={() => setEditing(false)}>Huỷ</button>
            </div>
          </div>
        ) : (
          <div className="row">
            <button className="primary" disabled={busy || !att || isActive} onClick={use}>
              {isActive ? '✓ Đang dùng bản này' : `✓ Dùng lần ${att?.n}`}
            </button>
            <button disabled={busy || job.status === 'running' || job.status === 'queued'} onClick={() => { setPrompt(job.prompt); retry(); }}>🔄 Thử lại</button>
            <button disabled={job.status === 'running' || job.status === 'queued'} onClick={() => { setPrompt(job.prompt); setEditing(true); }}>✏️ Sửa prompt rồi thử lại</button>
            {att && attempts.length > 1 && (
              <ConfirmButton
                link
                className=""
                armedText={`Xoá lần ${att.n}?`}
                onConfirm={() => run(async () => { await api.deleteAttempt(job.id, att.n); setN(null); await refresh(); })}
              >
                Xoá lần {att.n}
              </ConfirmButton>
            )}
            <span className="grow" />
            <small className="muted">Space: phát/dừng · ←/→: từng khung · bấm vào video để phát</small>
          </div>
        )}
        {error && <div className="err">{error}</div>}
      </div>
    </div>
  );
}

// Phóng to 1 ảnh trong thư viện: chỉ ảnh + nút Dùng / "Thử ảnh khác" (mở popup trượt để chọn ảnh khác và làm sạch lại).
function Lightbox({ asset, selected, onSelect, onClose, onTryOther }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="lightbox" onClick={onClose}>
      <div className="zoom-body" onClick={(e) => e.stopPropagation()}>
        <button className="lightbox-close" onClick={onClose} title="Đóng (Esc)">×</button>
        <img src={asset.url} alt={asset.name} />
        <div className="zoom-bar">
          <span className="zoom-name" title={asset.name}>{asset.fromJobId && '✨ '}{asset.name}</span>
          <span className="grow" />
          {selected ? <span className="ok">✓ Đang dùng</span> : <button onClick={() => onSelect(asset.id)}>✓ Dùng ảnh này</button>}
          {onTryOther && <button className="primary" onClick={onTryOther} title="Trượt qua các ảnh khác và làm sạch lại">🔄 Thử ảnh khác</button>}
        </div>
      </div>
    </div>
  );
}

// Bóc tách dữ liệu & ảnh sản phẩm đa sàn (Shopee, Lazada, TikTok Shop) với AI làm sạch và Fallback tìm kiếm ảnh.
// Kết quả bóc tách (found) do AssetPicker giữ, nên vẫn còn sau khi chọn ảnh. Chế độ 1 ảnh (AI Dancing): bấm 1 ảnh
// -> onOpen(i) mở popup trượt (xem to, làm sạch bằng Flow, chọn dùng). Module nào cần nhiều ảnh thì truyền
// multiple (chọn nhiều rồi thêm thẳng vào thư viện).
export function ProductImport({ kind, found, setFound, onOpen, refresh, onImported, multiple = false }) {
  const [url, setUrl] = useState('');
  const [picked, setPicked] = useState([]);
  const [showRawTitle, setShowRawTitle] = useState(false);
  const { busy, error, run } = useAction();

  const fetchProductData = () =>
    run(async () => {
      const r = await api.fetchProduct(url);
      setFound(r);
      const suggested = r.images.filter((im) => im.suggested).map((im) => im.id);
      setPicked(multiple ? suggested : suggested.slice(0, 1));
    });

  const toggle = (id) =>
    setPicked((s) => (s.includes(id) ? s.filter((x) => x !== id) : multiple ? [...s, id] : [id]));

  // Chế độ nhiều ảnh: chỉ thêm vào thư viện
  const importPicked = () =>
    run(async () => {
      const images = found.images
        .filter((im) => picked.includes(im.id))
        .map((im) => ({ url: im.url, name: `${found.title} – ${im.name || 'ảnh'}` }));
      const added = await api.importProduct(kind, images);
      await refresh?.();
      setFound(null);
      setUrl('');
      onImported?.(added);
    });

  return (
    <div className="stack product-import">
      <div className="row">
        <input
          placeholder="Dán link Shopee, Lazada hoặc TikTok Shop (kể cả link rút gọn) để lấy ảnh sản phẩm"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && url.trim() && fetchProductData()}
        />
        <button disabled={busy || !url.trim()} onClick={fetchProductData}>
          {busy ? '… Đang xử lý' : '🛒 Bóc tách & Lấy ảnh'}
        </button>
      </div>

      {found && (
        <div className="card product-card stack">
          <div className="product-header">
            <div className="row wrap gap-sm">
              <span className={`platform-pill platform-${found.platform}`}>
                {found.platform === 'shopee' ? '🛒 Shopee' : found.platform === 'lazada' ? '🛍️ Lazada' : found.platform === 'tiktok' ? '🎵 TikTok Shop' : '📦 TMĐT'}
              </span>
              <span className="badge ai-pill" title={found.usedGemini ? 'Đã làm sạch bằng Gemini AI' : 'Đã làm sạch bằng Heuristic Regex'}>
                {found.usedGemini ? '✨ Gemini AI' : '⚡ Heuristic'}
              </span>
              {found.usedFallbackImage && (
                <span className="badge fallback-pill" title="Ảnh bổ sung từ DuckDuckGo do sàn chặn/thiếu ảnh — có thể KHÔNG đúng sản phẩm">
                  🔍 Tìm ảnh ngoài (có thể sai sản phẩm)
                </span>
              )}
              {found.priceFormatted && (
                <span className="product-price">{found.priceFormatted}</span>
              )}
            </div>

            <div className="product-title-block">
              <div className="product-title">
                <b>{found.title}</b>
                {found.rawTitle && found.rawTitle !== found.title && (
                  <button className="btn-link small" onClick={() => setShowRawTitle(!showRawTitle)}>
                    {showRawTitle ? 'Ẩn tên gốc' : 'Xem tên gốc'}
                  </button>
                )}
              </div>
              {showRawTitle && found.rawTitle && (
                <small className="muted raw-title">Tên gốc trên sàn: {found.rawTitle}</small>
              )}
            </div>

            {found.features && found.features.length > 0 && (
              <div className="product-features">
                <small className="muted"><b>Đặc điểm nổi bật (kịch bản video):</b></small>
                <div className="row wrap gap-xs">
                  {found.features.map((f, idx) => (
                    <span key={idx} className="feature-chip">✓ {f}</span>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="thumbs-info">
            <small className="muted">
              Tìm thấy {found.images.length} ảnh.{' '}
              {!found.images.length
                ? 'Không tìm thấy ảnh.'
                : multiple
                  ? 'Bấm ảnh để chọn / bỏ chọn (3 ảnh đầu chọn sẵn):'
                  : 'Bấm 1 ảnh để xem to, trượt qua các ảnh, làm sạch bằng Flow rồi chọn ảnh dùng:'}
            </small>
            {found.note && <div className={found.images.length ? 'muted small' : 'err small'}>{found.note}</div>}
          </div>

          <div className="thumbs">
            {found.images.map((im, i) => (
              <div
                key={im.id}
                className={'thumb' + (picked.includes(im.id) ? ' selected' : '')}
                onClick={() => (multiple ? toggle(im.id) : (setPicked([im.id]), onOpen(i)))}
                title={im.name || ''}
              >
                <img src={im.url} alt="" loading="lazy" />
                {im.isFallback ? (
                  <span className="cap">🔍 Tìm kiếm ngoài</span>
                ) : im.name ? (
                  <span className="cap">{im.name}</span>
                ) : null}
              </div>
            ))}
          </div>

          <div className="row">
            {multiple && (
              <button className="primary" disabled={busy || !picked.length} onClick={importPicked}>
                Thêm {picked.length} ảnh vào thư viện
              </button>
            )}
            <button onClick={() => setFound(null)}>Đóng</button>
          </div>
        </div>
      )}

      {error && <div className="err">{error}</div>}
    </div>
  );
}

export const ShopeeImport = ProductImport;

// Popup trượt + làm sạch. images = ảnh vừa bóc tách ({ id, url, name }) hoặc ảnh trong thư viện (có assetId).
// - Trái: ảnh đang xem, trượt ◀ ▶ / ←/→ / dải ảnh nhỏ. Phải: prompt + "Làm sạch ảnh này" (ảnh gốc được tải về
//   thư viện dưới dạng nháp rồi chạy Flow, 0 credit) + "Chọn ảnh này" (dùng nguyên ảnh).
// - Dưới: mọi kết quả đã làm sạch của các ảnh này, xếp cạnh nhau theo thứ tự tạo. Kết quả nằm trên server
//   (ảnh nháp, nhận lại theo URL ảnh gốc) nên đóng/mở lại popup, bóc tách lại hay khởi động lại server vẫn còn.
//   Rê chuột vào kết quả: 👁 Xem to · 🔄 Thử lại · ✓ Dùng · 🗑 Xoá (bấm 2 lần).
function ExtractPopup({ images, startIdx, kind, state, refresh, busyOuter, onUse, onClose }) {
  const defaults = state?.defaults || {};
  const settings = state?.settings || {};
  const [idx, setIdx] = useState(startIdx);
  const [viewId, setViewId] = useState(null); // kết quả đang xem to (null = ảnh gốc)
  const [prompt, setPrompt] = useState(settings.productCleanPrompt || defaults.productCleanPrompt || '');
  const [armed, setArmed] = useState(null); // kết quả đang chờ bấm lần 2 để xoá
  const { busy: busyIn, error, run } = useAction();
  const busy = busyIn || busyOuter;
  const assets = state?.assets || [];
  const jobs = state?.jobs || [];

  const cur = images[idx];
  const go = (d) => { setIdx((i) => (i + d + images.length) % images.length); setViewId(null); };
  // Ảnh bóc tách <-> ảnh trong thư viện: theo assetId (ảnh thư viện) hoặc URL ảnh gốc (đã tải về trước đó)
  const assetIdOf = (im) => im.assetId || assets.find((a) => a.source === im.url)?.id || null;
  const ensureAsset = async (im) => {
    const have = assetIdOf(im);
    if (have) return have;
    const [added] = await api.importProduct(kind, [{ url: im.url, name: im.name || 'Ảnh sản phẩm' }], true);
    await refresh();
    return added.id;
  };
  // id thư viện -> số thứ tự ảnh (để ghi "#n" lên kết quả)
  const srcNo = {};
  images.forEach((im, i) => { const id = assetIdOf(im); if (id) srcNo[id] = i + 1; });
  const results = assets.filter((a) => srcNo[a.fromAssetId]).sort((a, b) => a.createdAt - b.createdAt);
  const jobOf = (assetId) => jobs.filter((j) => j.meta?.cleanOf === assetId).sort((a, b) => b.createdAt - a.createdAt)[0];
  const isWorking = (j) => j && (j.status === 'running' || j.status === 'queued');
  const curAssetId = assetIdOf(cur);
  const curJob = curAssetId ? jobOf(curAssetId) : null;
  const pending = Object.keys(srcNo).map((aId) => ({ aId, job: jobOf(aId) })).filter(({ job }) => isWorking(job));
  const viewing = viewId ? results.find((r) => r.id === viewId) : null;

  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft') go(-1);
      if (e.key === 'ArrowRight') go(1);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });

  const clean = (im) => run(async () => { await api.cleanAsset(await ensureAsset(im), prompt); await refresh(); });
  const retry = (r) => run(async () => { await api.cleanAsset(r.fromAssetId, prompt); await refresh(); });
  const pickSource = () => run(async () => onUse(await ensureAsset(cur)));
  const remove = (r) => {
    if (armed !== r.id) { setArmed(r.id); setTimeout(() => setArmed((a) => (a === r.id ? null : a)), 3000); return; }
    setArmed(null);
    run(async () => { await api.deleteAsset(r.id); if (viewId === r.id) setViewId(null); await refresh(); });
  };
  const engine = settings.engine;

  return (
    <div className="lightbox" onClick={onClose}>
      <div className="lightbox-body extract-body" onClick={(e) => e.stopPropagation()}>
        <button className="lightbox-close" onClick={onClose} title="Đóng (Esc)">×</button>

        <div className="lightbox-left">
          <div className="lightbox-img">
            {images.length > 1 && <button className="slide-nav prev" onClick={() => go(-1)} title="Ảnh trước (←)">‹</button>}
            <img key={viewing?.id || cur.id} src={viewing ? viewing.url : cur.url} alt="" />
            {images.length > 1 && <button className="slide-nav next" onClick={() => go(1)} title="Ảnh sau (→)">›</button>}
            <div className="img-label">
              {viewing ? (
                <>✨ Kết quả của ảnh #{srcNo[viewing.fromAssetId]} · <a onClick={() => setViewId(null)}>về ảnh gốc</a></>
              ) : (
                <>{idx + 1} / {images.length}{cur.name ? ` · ${cur.name}` : ''}</>
              )}
            </div>
          </div>
          {images.length > 1 && (
            <div className="lightbox-strip">
              {images.map((im, i) => (
                <img key={im.id} src={im.url} alt="" title={im.name || ''} className={i === idx ? 'on' : ''} onClick={() => { setIdx(i); setViewId(null); }} />
              ))}
            </div>
          )}
        </div>

        <div className="lightbox-side stack">
          <div>
            <b>{viewing ? `Kết quả sạch của ảnh #${srcNo[viewing.fromAssetId]}` : `Ảnh #${idx + 1}`}</b>
            <div className="small muted">{viewing ? viewing.name : cur.name || 'Ảnh sản phẩm'}</div>
          </div>
          {viewing ? (
            <div className="row">
              <button className="primary" disabled={busy} onClick={() => onUse(viewing.id)}>✓ Dùng ảnh này</button>
              <button disabled={busy} onClick={() => retry(viewing)} title="Tạo bản sạch khác từ cùng ảnh gốc">🔄 Thử lại</button>
              <button className={armed === viewing.id ? 'armed' : ''} disabled={busy} onClick={() => remove(viewing)}>
                {armed === viewing.id ? 'Bấm lần nữa để xoá' : '🗑 Xoá'}
              </button>
            </div>
          ) : (
            <div className="row">
              <button className="primary" disabled={busy || isWorking(curJob) || !prompt.trim()} onClick={() => clean(cur)}>
                ✨ Làm sạch ảnh này {engine === 'mock' ? '(engine giả)' : '(Flow, 0 credit)'}
              </button>
              <button disabled={busy} onClick={pickSource} title="Dùng nguyên ảnh này, không làm sạch">✓ Chọn ảnh này</button>
            </div>
          )}
          {isWorking(curJob) && <small className="muted">⏳ {curJob.attempts?.at(-1)?.progress || 'Đang chờ đến lượt…'}</small>}
          {curJob?.status === 'failed' && !isWorking(curJob) && <div className="err small">{curJob.error}</div>}

          <label>
            <span>Prompt làm sạch (tiếng Anh)</span>
            <textarea rows={6} className="mono" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          </label>
          <small className="muted">
            Trượt ◀ ▶ (←/→) tới ảnh muốn làm sạch rồi bấm Làm sạch; làm sạch được nhiều ảnh, kết quả xếp cạnh nhau bên dưới
            và vẫn còn khi mở lại. Chỉ ảnh bạn bấm Dùng mới hiện trong thư viện.
          </small>
          {error && <div className="err">{error}</div>}
        </div>

        {(results.length > 0 || pending.length > 0) && (
          <div className="extract-results">
            <small className="muted">Kết quả đã làm sạch ({results.length}) — bấm để xem to, rê chuột để thao tác:</small>
            <div className="result-strip">
              {results.map((r) => (
                <div key={r.id} className={'rthumb' + (viewId === r.id ? ' on' : '')} onClick={() => setViewId(r.id)}>
                  <img src={r.url} alt="" />
                  <span className="src-no">#{srcNo[r.fromAssetId]}</span>
                  <div className="acts" onClick={(e) => e.stopPropagation()}>
                    <button className="icon-btn" data-tip="Xem to" onClick={() => setViewId(r.id)}>👁</button>
                    <button className="icon-btn" data-tip="Thử lại" disabled={busy} onClick={() => retry(r)}>🔄</button>
                    <button className="icon-btn" data-tip="Dùng ảnh này" disabled={busy} onClick={() => onUse(r.id)}>✓</button>
                    <button className={'icon-btn' + (armed === r.id ? ' danger' : '')} data-tip={armed === r.id ? 'Bấm lần nữa để xoá' : 'Xoá'} disabled={busy} onClick={() => remove(r)}>🗑</button>
                  </div>
                </div>
              ))}
              {pending.map(({ aId, job }) => (
                <div key={aId} className="rthumb pending" title={job.attempts?.at(-1)?.progress || ''}>
                  <span>⏳ #{srcNo[aId]}<br />{job.attempts?.at(-1)?.progress || 'Đang chờ…'}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Thẻ 1 job: xem trước/sau, lịch sử các lần tạo, nút Thử lại (có thể sửa prompt).
// compact = chỉ video kết quả + các lần tạo + nút (dùng trong bảng từng đoạn của quy trình)
export function JobCard({ job, refresh, selectable, selected, onToggle, compact }) {
  const [editing, setEditing] = useState(false);
  const [prompt, setPrompt] = useState(job.prompt);
  const [showPrompt, setShowPrompt] = useState(false);
  const [compare, setCompare] = useState(false);
  const { busy, error, run } = useAction();
  const active = job.attempts.find((a) => a.outputPath === job.outputPath);

  const retry = () =>
    run(async () => {
      await api.retry(job.id, prompt);
      setEditing(false);
      await refresh();
    });

  return (
    <div className={'job' + (selected ? ' selected' : '') + (compact ? ' compact' : '')}>
      {!compact && (
        <div className="job-head">
          {selectable && job.status === 'done' && (
            <input type="checkbox" checked={!!selected} onChange={onToggle} />
          )}
          <b className="grow">{job.videoLabel}</b>
          <Badge status={job.status} />
        </div>
      )}
      <div className="job-media">
        {!compact && <figure>
          {job.videoUrl ? (
            <video src={job.videoUrl} muted controls preload="metadata" />
          ) : job.imageUrls?.[0] ? (
            <img src={job.imageUrls[0]} alt="" />
          ) : (
            <div className="placeholder">–</div>
          )}
          <figcaption>Đầu vào</figcaption>
        </figure>}
        <figure>
          {job.outputUrl && job.type === 'image' ? (
            <img key={job.outputUrl} src={job.outputUrl} alt="" />
          ) : job.outputUrl ? (
            <video key={job.outputUrl} src={job.outputUrl} controls preload="metadata" poster={job.thumbUrl || undefined} />
          ) : (
            <div className="placeholder">{job.status === 'failed' ? '⚠️' : '⏳'}</div>
          )}
          <figcaption>
            {compact ? <Badge status={job.status} /> : 'Kết quả'} {active ? `(lần ${active.n})` : ''}
          </figcaption>
        </figure>
      </div>
      {job.status === 'running' && job.attempts.at(-1)?.progress && (
        <small className="muted">⏳ {job.attempts.at(-1).progress}</small>
      )}
      {job.status === 'failed' && <div className="err">{job.error}</div>}
      {job.attempts.length > 1 && (
        <div className="attempts">
          Các lần tạo:
          {job.attempts.map((a) => (
            <button
              key={a.n}
              disabled={!a.outputPath || busy}
              className={'chip' + (a.outputPath && a.outputPath === job.outputPath ? ' on' : '')}
              title={a.error || a.prompt}
              onClick={() => run(async () => { await api.selectAttempt(job.id, a.n); await refresh(); })}
            >
              {a.status === 'failed' ? '✕' : a.status === 'running' ? '…' : '✓'} {a.n}
            </button>
          ))}
          {active && (
            <ConfirmButton
              link
              armedText={`Bấm lần nữa để xoá lần ${active.n}`}
              onConfirm={() => run(async () => { await api.deleteAttempt(job.id, active.n); await refresh(); })}
            >
              Xoá lần {active.n}
            </ConfirmButton>
          )}
        </div>
      )}
      {editing ? (
        <div className="stack">
          <textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          <div className="row">
            <button className="primary" disabled={busy} onClick={retry}>Tạo lại với prompt này</button>
            <button onClick={() => setEditing(false)}>Huỷ</button>
          </div>
        </div>
      ) : job.type === 'import' ? (
        <div className="row">
          <small className="muted">📥 Nhập từ máy: {job.importedName}</small>
          <span className="grow" />
          <ConfirmButton armedText="Xoá video này?" onConfirm={() => run(async () => { await api.deleteJob(job.id); await refresh(); })}>Xoá</ConfirmButton>
        </div>
      ) : (
        <div className="row">
          <button
            disabled={busy || job.status === 'running' || job.status === 'queued'}
            onClick={retry}
          >
            🔄 Thử lại
          </button>
          <button
            disabled={job.status === 'running' || job.status === 'queued'}
            onClick={() => { setPrompt(job.prompt); setEditing(true); }}
          >
            ✏️ Sửa prompt
          </button>
          {job.videoUrl && job.outputUrl && job.type !== 'image' && (
            <button className="primary-outline" onClick={() => setCompare(true)} title="Xem video gốc và kết quả cạnh nhau, phát đồng bộ">
              ⇄ So sánh
            </button>
          )}
          <button className="link" onClick={() => setShowPrompt(!showPrompt)}>
            {showPrompt ? 'Ẩn prompt' : 'Xem prompt'}
          </button>
          <span className="grow" />
          {!compact && (
            <ConfirmButton
              disabled={job.status === 'running'}
              armedText="Xoá cả video này?"
              title="Xoá video và mọi lần tạo của nó"
              onConfirm={() => run(async () => { await api.deleteJob(job.id); await refresh(); })}
            >
              Xoá
            </ConfirmButton>
          )}
        </div>
      )}
      {showPrompt && <pre className="prompt">{job.attempts.at(-1)?.finalPrompt || job.prompt}</pre>}
      {compare && <CompareModal job={job} refresh={refresh} onClose={() => setCompare(false)} />}
      {error && <div className="err">{error}</div>}
    </div>
  );
}

// Danh sách job + chọn nhiều để chuyển bước
export function JobList({ jobs, refresh, selected, setSelected }) {
  const done = jobs.filter((j) => j.status === 'done');
  const toggle = (id) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  if (!jobs.length) return <p className="muted">Chưa có video nào.</p>;
  return (
    <>
      {setSelected && done.length > 0 && (
        <div className="row">
          <a onClick={() => setSelected(done.map((j) => j.id))}>Chọn tất cả video xong ({done.length})</a>
          {selected.length > 0 && <a onClick={() => setSelected([])}>Bỏ chọn</a>}
        </div>
      )}
      <div className="jobs">
        {jobs.map((j) => (
          <JobCard
            key={j.id}
            job={j}
            refresh={refresh}
            selectable={!!setSelected}
            selected={selected?.includes(j.id)}
            onToggle={() => toggle(j.id)}
          />
        ))}
      </div>
    </>
  );
}
