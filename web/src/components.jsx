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

// Chọn 1 ảnh (model / sản phẩm / bối cảnh) từ thư viện hoặc tải ảnh mới
export function AssetPicker({ kind, label, assets, value, onChange, refresh }) {
  const list = assets.filter((a) => a.kind === kind);
  const { busy, error, run } = useAction();
  const upload = (files) =>
    run(async () => {
      let last;
      for (const f of files) last = await api.uploadAsset(kind, f);
      await refresh();
      if (last) onChange(last.id);
    });
  return (
    <div className="picker">
      <div className="picker-head">
        <b>{label}</b>
        {value && <a onClick={() => onChange(null)}>Bỏ chọn</a>}
      </div>
      <div className="thumbs">
        <FileDrop accept="image/*" multiple onFiles={upload}>
          <div className="thumb add">{busy ? '…' : '+ Tải ảnh'}</div>
        </FileDrop>
        {list.map((a) => (
          <div
            key={a.id}
            className={'thumb' + (value === a.id ? ' selected' : '')}
            onClick={() => onChange(value === a.id ? null : a.id)}
            title={a.name}
          >
            <img src={a.url} alt={a.name} />
            <ConfirmButton
              className="x"
              armedText="Xoá?"
              title="Xoá ảnh"
              onConfirm={() => run(async () => { await api.deleteAsset(a.id); if (value === a.id) onChange(null); await refresh(); })}
            >
              ×
            </ConfirmButton>
          </div>
        ))}
      </div>
      {error && <div className="err">{error}</div>}
      {kind === 'product' && <ProductImport kind={kind} refresh={refresh} onImported={(added) => onChange(added[0].id)} />}
    </div>
  );
}

// Bóc tách dữ liệu & ảnh sản phẩm đa sàn (Shopee, Lazada, TikTok Shop) với AI làm sạch và Fallback tìm kiếm ảnh
export function ProductImport({ kind, refresh, onImported }) {
  const [url, setUrl] = useState('');
  const [found, setFound] = useState(null);
  const [picked, setPicked] = useState([]);
  const [showRawTitle, setShowRawTitle] = useState(false);
  const { busy, error, run } = useAction();

  const fetchProductData = () =>
    run(async () => {
      const r = await api.fetchProduct(url);
      setFound(r);
      setPicked(r.images.filter((im) => im.suggested).map((im) => im.id));
    });

  const toggle = (id) => setPicked((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const importPicked = () =>
    run(async () => {
      const images = found.images
        .filter((im) => picked.includes(im.id))
        .map((im) => ({ url: im.url, name: `${found.title} – ${im.name || 'ảnh'}` }));
      const added = await api.importProduct(kind, images);
      await refresh();
      setFound(null);
      setUrl('');
      onImported(added);
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
                <span className="badge fallback-pill" title="Ảnh bổ sung từ DuckDuckGo do sàn chặn/thiếu ảnh">
                  🔍 Tìm ảnh ngoài (DuckDuckGo)
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
              Tìm thấy {found.images.length} ảnh. {found.images.length ? 'Bấm ảnh để chọn / bỏ chọn (3 ảnh đầu chọn sẵn):' : 'Không tìm thấy ảnh.'}
            </small>
          </div>

          <div className="thumbs">
            {found.images.map((im) => (
              <div
                key={im.id}
                className={'thumb' + (picked.includes(im.id) ? ' selected' : '')}
                onClick={() => toggle(im.id)}
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
            <button className="primary" disabled={busy || !picked.length} onClick={importPicked}>
              Thêm {picked.length} ảnh vào thư viện
            </button>
            <button onClick={() => setFound(null)}>Đóng</button>
          </div>
        </div>
      )}

      {error && <div className="err">{error}</div>}
    </div>
  );
}

export const ShopeeImport = ProductImport;

// Thẻ 1 job: xem trước/sau, lịch sử các lần tạo, nút Thử lại (có thể sửa prompt).
// compact = chỉ video kết quả + các lần tạo + nút (dùng trong bảng từng đoạn của quy trình)
export function JobCard({ job, refresh, selectable, selected, onToggle, compact }) {
  const [editing, setEditing] = useState(false);
  const [prompt, setPrompt] = useState(job.prompt);
  const [showPrompt, setShowPrompt] = useState(false);
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
