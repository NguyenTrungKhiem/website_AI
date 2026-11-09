import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { ConfirmButton, FileDrop, fmt, useAction } from '../components.jsx';
import { tcs } from '../timecode.js';
import CutEditor from './CutEditor.jsx';

export default function CutPage({ state, refresh, go }) {
  const [sourceId, setSourceId] = useState(state.sources[0]?.id || null);
  const { busy, error, run } = useAction();

  const src = state.sources.find((s) => s.id === sourceId);
  const clips = state.clips.filter((c) => c.sourceId === sourceId);
  const fps = src?.fps || 30;

  useEffect(() => {
    if (!src && state.sources[0]) setSourceId(state.sources[0].id);
  }, [state.sources, src]);

  const upload = (files) =>
    run(async () => {
      let last;
      for (const f of files) last = await api.uploadSource(f);
      await refresh();
      if (last) setSourceId(last.id);
    });

  const exportClips = ({ ranges, mute }) =>
    run(async () => {
      await api.cut(src.id, { ranges, mute });
      await refresh();
    });
  // Gộp các đoạn giữ thành 1 video (giữ âm thanh gốc) để tải về
  const mergeKept = ({ ranges }) =>
    run(async () => {
      await api.mergeSource(src.id, { ranges, mute: false });
      await refresh();
    });

  return (
    <section>
      <h1>Cắt video gốc</h1>
      <p className="muted">
        Kéo playhead tới đúng khung hình rồi bấm <b>Cắt</b> hoặc <kbd>Ctrl+B</kbd>. Mỗi đoạn tối đa 10s (giới hạn đầu vào của Omni Flash).
        Âm thanh gốc được tự động tách và lưu lại để ghép vào video hoàn chỉnh (AI Dancing tự ghép, hoặc ghép tay ở trang Ghép video).
      </p>

      <div className="row">
        <FileDrop accept="video/*" multiple onFiles={upload}>
          <div className="drop-inner small">{busy ? 'Đang xử lý…' : '📥 Tải video gốc (kéo thả hoặc bấm)'}</div>
        </FileDrop>
        <div className="sources grow">
          {state.sources.map((s) => (
            <div
              key={s.id}
              className={'source' + (s.id === sourceId ? ' selected' : '')}
              onClick={() => setSourceId(s.id)}
            >
              {s.thumbUrl && <img src={s.thumbUrl} alt="" />}
              <div>
                <div className="ellipsis">{s.name}</div>
                <small className="muted">{tcs(s.duration, s.fps || 30)} · {s.width}×{s.height} · {s.fps || '?'}fps</small>
              </div>
            </div>
          ))}
        </div>
      </div>

      {src && (
        <div className="card stack">
          <CutEditor key={src.id} src={src} busy={busy} onExport={exportClips} onMerge={mergeKept} defaultSec={parseFloat(state.settings.flowDuration) || 10} />
          {src.merged && <MergedSource src={src} refresh={refresh} />}
          <div className="row between">
            <SourceAudio src={src} audios={state.audios} refresh={refresh} />
            <ConfirmButton
              armedText="Bấm lần nữa để xoá (các đoạn đã cắt vẫn giữ)"
              onConfirm={() => run(async () => { await api.deleteSource(src.id); setSourceId(null); await refresh(); })}
            >
              Xoá video gốc
            </ConfirmButton>
          </div>
        </div>
      )}
      {error && <div className="err">{error}</div>}

      {clips.length > 0 && (
        <>
          <div className="row between">
            <h2>Các đoạn đã xuất ({clips.length})</h2>
            {state.workflows?.[0] && (
              <button className="primary" onClick={() => go('wf:' + state.workflows[0].id)}>
                Sang {state.workflows[0].name} →
              </button>
            )}
          </div>
          <div className="clips">
            {clips.map((c) => (
              <div key={c.id} className="clip">
                <video src={c.url} muted controls preload="metadata" poster={c.thumbUrl} />
                <div className="row between">
                  <small>
                    {c.name} {c.muted ? '🔇' : ''}
                    <br />
                    <span className="muted">{tcs(c.start, fps)} → {tcs(c.end, fps)} ({fmt(c.end - c.start)})</span>
                  </small>
                  <a onClick={() => run(async () => { await api.deleteClip(c.id); await refresh(); })}>Xoá</a>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

// Video đã gộp lại từ các đoạn giữ (nút "Gộp lại" trong trình cắt): xem, tải về, xoá
function MergedSource({ src, refresh }) {
  const { busy, error, run } = useAction();
  const m = src.merged;
  const fps = src.fps || 30;
  return (
    <div className="stack merged-box">
      <div className="row between">
        <b>🔗 Video đã gộp lại</b>
        <small className="muted">{m.ranges.length} đoạn · {fmt(m.duration)} · {new Date(m.createdAt).toLocaleString('vi-VN')}</small>
      </div>
      <div className="row">
        <video src={m.url} controls preload="metadata" poster={m.thumbUrl || undefined} className="merged-video" />
        <div className="stack">
          <small className="muted">
            Gồm: {m.ranges.map(([a, b]) => `${tcs(a, fps)}→${tcs(b, fps)}`).join(', ')}
          </small>
          <div className="row">
            <a className="btn primary" href={m.url} download={m.name}>⬇ Tải video đã gộp</a>
            <ConfirmButton disabled={busy} armedText="Xoá bản gộp này?" onConfirm={() => run(async () => { await api.deleteMergedSource(src.id); await refresh(); })}>Xoá</ConfirmButton>
          </div>
          <small className="muted">Gộp lại lần nữa sẽ thay bản này.</small>
        </div>
      </div>
      {error && <div className="err">{error}</div>}
    </div>
  );
}

// Âm thanh đã tách của video gốc (tự tách khi tải lên)
function SourceAudio({ src, audios, refresh }) {
  const { busy, error, run } = useAction();
  const audio = audios.find((a) => a.sourceId === src.id);
  if (!src.hasAudio && !audio) return <p className="muted small">Video gốc không có âm thanh.</p>;
  return (
    <div className="stack">
      <div className="audio-bar">
        <b>🎵 Âm thanh đã tách</b>
        {audio ? (
          <>
            <audio src={audio.url} controls preload="none" />
            <a href={audio.url} download={`${audio.name}.m4a`}>Tải về</a>
          </>
        ) : (
          <button disabled={busy} onClick={() => run(async () => { await api.extractAudio(src.id); await refresh(); })}>
            {busy ? 'Đang tách…' : 'Tách âm thanh'}
          </button>
        )}
      </div>
      {error && <div className="err">{error}</div>}
    </div>
  );
}
