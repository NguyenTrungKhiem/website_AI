// Trình cắt video kiểu CapCut: xem từng khung, kéo playhead trên timeline, cắt tại playhead (Ctrl+B).
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { tc, parseTc } from '../timecode.js';

const MAX_CLIP = 10;
const TRACK_H = 64;
const RULER_H = 26;

// Bước vạch chia (giây). Bước nhỏ hơn 1s tính theo khung.
function tickStep(pps, fps) {
  const steps = [1, 2, 5, 10, 15].map((f) => f / fps).concat([0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]);
  return steps.find((s) => s * pps >= 70) || 600;
}

const loadSaved = (id) => {
  try {
    return JSON.parse(localStorage.getItem('cut:' + id)) || null;
  } catch {
    return null;
  }
};

export default function CutEditor({ src, onExport, busy }) {
  const fps = src.fps || 30;
  const totalFrames = Math.max(1, Math.round(src.duration * fps));
  const videoRef = useRef();
  const scrollRef = useRef();
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [viewW, setViewW] = useState(800);
  const [scrollX, setScrollX] = useState(0);
  const [zoom, setZoom] = useState(0); // 0 = vừa khung, 1 = phóng to tối đa
  const [splits, setSplits] = useState(() => loadSaved(src.id)?.splits || []);
  const [excluded, setExcluded] = useState(() => loadSaved(src.id)?.excluded || []);
  const [selected, setSelected] = useState(null); // frame bắt đầu của đoạn đang chọn
  const [history, setHistory] = useState([]);
  const [autoSec, setAutoSec] = useState(8);
  const [mute, setMute] = useState(true);
  const [tcInput, setTcInput] = useState(null);

  // ---- zoom: pixel / giây ----
  const minPps = Math.max(1, (viewW - 24) / src.duration);
  const maxPps = fps * 14; // ~14px mỗi khung
  const pps = minPps * Math.pow(Math.max(1, maxPps / minPps), zoom);
  const width = src.duration * pps;
  const xOf = (f) => (f / fps) * pps;

  useLayoutEffect(() => {
    const el = scrollRef.current;
    const ro = new ResizeObserver(() => setViewW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Lưu điểm cắt theo từng video gốc
  useEffect(() => {
    try {
      localStorage.setItem('cut:' + src.id, JSON.stringify({ splits, excluded }));
    } catch {}
  }, [src.id, splits, excluded]);

  // ---- phát / tua ----
  const seek = useCallback(
    (f) => {
      const v = Math.min(totalFrames - 1, Math.max(0, Math.round(f)));
      setFrame(v);
      const el = videoRef.current;
      // Tua vào giữa khung để trình duyệt hiển thị đúng khung đó
      if (el) el.currentTime = Math.min(src.duration - 0.001, (v + 0.5) / fps);
    },
    [fps, totalFrames, src.duration],
  );

  useEffect(() => {
    if (!playing) return;
    let raf;
    const tick = () => {
      const t = videoRef.current?.currentTime || 0;
      setFrame(Math.min(totalFrames - 1, Math.floor(t * fps + 1e-6)));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, fps, totalFrames]);

  const togglePlay = () => {
    const el = videoRef.current;
    if (!el) return;
    if (el.paused) {
      if (frame >= totalFrames - 1) seek(0);
      el.play();
    } else el.pause();
  };

  // Giữ playhead trong tầm nhìn khi phát / bấm phím / zoom
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const x = xOf(frame);
    if (x < el.scrollLeft + 20 || x > el.scrollLeft + el.clientWidth - 40) {
      el.scrollLeft = Math.max(0, x - el.clientWidth * 0.3);
    }
  }, [frame, pps]);

  // ---- đoạn & điểm cắt ----
  const segments = useMemo(() => {
    const pts = [0, ...splits, totalFrames];
    return pts.slice(0, -1).map((start, i) => {
      const end = pts[i + 1];
      const startS = start / fps;
      const endS = end === totalFrames ? src.duration : end / fps;
      return { start, end, startS, endS, dur: endS - startS, excluded: excluded.includes(start), index: i };
    });
  }, [splits, excluded, totalFrames, fps, src.duration]);

  const segAt = (f) => segments.find((s) => f >= s.start && f < s.end) || segments.at(-1);
  const commit = (nextSplits, nextExcluded = excluded) => {
    setHistory((h) => [...h.slice(-49), { splits, excluded }]);
    setSplits(nextSplits);
    // Đoạn bị bỏ qua giữ theo frame bắt đầu; bỏ các mốc không còn là đầu đoạn
    const starts = new Set([0, ...nextSplits]);
    setExcluded(nextExcluded.filter((f) => starts.has(f)));
  };

  const split = () => {
    if (frame <= 0 || frame >= totalFrames || splits.includes(frame)) return;
    const seg = segAt(frame);
    const nextEx = seg.excluded ? [...excluded, frame] : excluded; // nửa sau giữ trạng thái bỏ qua
    commit([...splits, frame].sort((a, b) => a - b), nextEx);
    setSelected(frame);
  };
  const removeSplit = (f = frame) => {
    if (!splits.includes(f)) return;
    commit(splits.filter((x) => x !== f), excluded.filter((x) => x !== f));
  };
  const toggleExclude = () => {
    const seg = segments.find((s) => s.start === selected) || segAt(frame);
    commit(splits, seg.excluded ? excluded.filter((x) => x !== seg.start) : [...excluded, seg.start]);
  };
  const undo = () => {
    const last = history.at(-1);
    if (!last) return;
    setHistory((h) => h.slice(0, -1));
    setSplits(last.splits);
    setExcluded(last.excluded);
  };
  const autoSplit = () => {
    const step = Math.round(Math.min(MAX_CLIP, Math.max(0.5, autoSec)) * fps);
    const pts = [];
    for (let f = step; f < totalFrames - Math.round(fps * 0.5); f += step) pts.push(f);
    commit(pts, []);
  };
  const clearAll = () => commit([], []);

  // ---- phím tắt ----
  const keyRef = useRef();
  keyRef.current = (e) => {
    const t = e.target;
    if (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' ||
      (t.tagName === 'INPUT' && !['checkbox', 'radio', 'range', 'button'].includes(t.type))) return;
    const k = e.key.toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;
    let handled = true;
    if (ctrl && k === 'b') split();
    else if (ctrl && k === 'z') undo();
    else if (k === ' ') togglePlay();
    else if (k === 'arrowleft') seek(frame - (e.shiftKey ? Math.round(fps) : 1));
    else if (k === 'arrowright') seek(frame + (e.shiftKey ? Math.round(fps) : 1));
    else if (k === 'home') seek(0);
    else if (k === 'end') seek(totalFrames - 1);
    else if (k === 'delete' || k === 'backspace') toggleExclude();
    else if (k === 'arrowup' || k === 'arrowdown') {
      // nhảy tới điểm cắt trước / sau
      const pts = [0, ...splits, totalFrames - 1];
      const next = k === 'arrowup' ? [...pts].reverse().find((p) => p < frame) : pts.find((p) => p > frame);
      if (next != null) seek(next);
    } else handled = false;
    if (handled) {
      e.preventDefault();
      if (k !== ' ') videoRef.current?.pause();
    }
  };
  useEffect(() => {
    const h = (e) => keyRef.current(e);
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  // ---- kéo trên timeline ----
  const frameAtClientX = (clientX) => {
    const rect = scrollRef.current.querySelector('.tl-content').getBoundingClientRect();
    return Math.round(((clientX - rect.left - 12) / pps) * fps); // 12 = padding trái của timeline
  };
  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    videoRef.current?.pause();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    seek(frameAtClientX(e.clientX));
    const move = (ev) => seek(frameAtClientX(ev.clientX));
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };
  const onWheel = (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setZoom((z) => Math.min(1, Math.max(0, z - Math.sign(e.deltaY) * 0.06)));
  };
  useEffect(() => {
    // wheel cần passive:false để chặn zoom trang khi Ctrl+lăn chuột
    const el = scrollRef.current;
    const h = (e) => onWheelRef.current(e);
    el.addEventListener('wheel', h, { passive: false });
    return () => el.removeEventListener('wheel', h);
  }, []);
  const onWheelRef = useRef();
  onWheelRef.current = onWheel;

  // ---- vẽ ----
  const viewStart = scrollX - 100;
  const viewEnd = scrollX + viewW + 100;
  const step = tickStep(pps, fps);
  const minor = step * pps >= 140 ? step / 10 : step * pps >= 50 ? step / 5 : step / 2;
  const ticks = [];
  for (let t = Math.max(0, Math.floor(viewStart / pps / minor) * minor); t <= Math.min(src.duration, viewEnd / pps); t += minor) {
    const isMajor = Math.abs(t / step - Math.round(t / step)) < 1e-6;
    ticks.push({ t, x: t * pps, major: isMajor });
  }
  const showFrames = step < 1;

  const strip = src.filmstrip;
  const cellW = strip ? (strip.tileW * TRACK_H) / strip.tileH : 40;
  const cells = [];
  if (strip) {
    for (let i = Math.max(0, Math.floor(viewStart / cellW)); i * cellW < Math.min(width, viewEnd); i++) {
      const t = ((i + 0.5) * cellW) / pps;
      const idx = Math.min(strip.count - 1, Math.floor((t / src.duration) * strip.count));
      cells.push({ i, idx });
    }
  }

  const kept = segments.filter((s) => !s.excluded);
  const tooLong = kept.filter((s) => s.dur > MAX_CLIP + 1e-3);
  const cur = segAt(frame);

  return (
    <div className="editor">
      <div className="ed-player">
        <video
          ref={videoRef}
          src={src.url}
          onClick={togglePlay}
          onPlay={() => setPlaying(true)}
          onPause={() => {
            setPlaying(false);
            const t = videoRef.current.currentTime;
            setFrame(Math.min(totalFrames - 1, Math.floor(t * fps + 1e-6)));
          }}
          onLoadedMetadata={() => seek(frame)}
          preload="auto"
        />
      </div>

      <div className="ed-toolbar">
        <div className="row">
          <button title="Lùi 1 giây (Shift+←)" onClick={() => seek(frame - Math.round(fps))}>⏪</button>
          <button title="Lùi 1 khung (←)" onClick={() => seek(frame - 1)}>◀︎|</button>
          <button className="play" title="Phát / dừng (Space)" onClick={togglePlay}>{playing ? '❚❚' : '▶'}</button>
          <button title="Tới 1 khung (→)" onClick={() => seek(frame + 1)}>|▶︎</button>
          <button title="Tới 1 giây (Shift+→)" onClick={() => seek(frame + Math.round(fps))}>⏩</button>
          {tcInput == null ? (
            <span className="tc" title="Bấm để nhập thời gian cần tới" onClick={() => setTcInput(tc(frame, fps))}>
              <b>{tc(frame, fps)}</b> <span className="muted">/ {tc(totalFrames, fps)}</span>
            </span>
          ) : (
            <input
              className="tc-input"
              autoFocus
              value={tcInput}
              onChange={(e) => setTcInput(e.target.value)}
              onBlur={() => setTcInput(null)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const f = parseTc(tcInput, fps);
                  if (f != null) seek(f);
                  setTcInput(null);
                }
                if (e.key === 'Escape') setTcInput(null);
              }}
            />
          )}
          <small className="muted">{fps} fps · khung {frame + 1}/{totalFrames}</small>
        </div>
        <div className="row">
          <button className="primary" title="Cắt tại playhead (Ctrl+B)" onClick={split} disabled={frame <= 0 || splits.includes(frame)}>
            ✂️ Cắt <kbd>Ctrl+B</kbd>
          </button>
          <button title="Bỏ điểm cắt tại playhead" disabled={!splits.includes(frame)} onClick={() => removeSplit()}>Gộp lại</button>
          <button title="Bỏ qua / lấy lại đoạn đang chọn (Delete)" onClick={toggleExclude}>
            {(segments.find((s) => s.start === selected) || cur)?.excluded ? '↺ Lấy lại đoạn' : '🗑 Bỏ đoạn'} <kbd>Del</kbd>
          </button>
          <button title="Hoàn tác (Ctrl+Z)" disabled={!history.length} onClick={undo}>↶ <kbd>Ctrl+Z</kbd></button>
          <span className="zoom">
            <button onClick={() => setZoom((z) => Math.max(0, z - 0.1))}>−</button>
            <input type="range" min={0} max={1} step={0.01} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} title="Zoom (Ctrl + lăn chuột)" />
            <button onClick={() => setZoom((z) => Math.min(1, z + 0.1))}>+</button>
            <button onClick={() => setZoom(0)} title="Vừa khung">⤢</button>
          </span>
        </div>
      </div>

      <div className="tl-scroll" ref={scrollRef} onScroll={(e) => setScrollX(e.currentTarget.scrollLeft)}>
        <div className="tl-content" style={{ width: width + 24 }} onPointerDown={onPointerDown}>
          <div className="tl-ruler" style={{ height: RULER_H }}>
            {ticks.map((k) => (
              <div key={k.t.toFixed(5)} className={'tick' + (k.major ? ' major' : '')} style={{ left: k.x }}>
                {k.major && <span>{showFrames ? tc(Math.round(k.t * fps), fps) : tc(Math.round(k.t * fps), fps).slice(0, -3)}</span>}
              </div>
            ))}
          </div>
          <div className="tl-track" style={{ height: TRACK_H, width }}>
            {cells.map((c) => (
              <div
                key={c.i}
                className="cell"
                style={{
                  left: c.i * cellW,
                  width: cellW,
                  backgroundImage: `url(${strip.url})`,
                  backgroundSize: `${strip.count * cellW}px ${TRACK_H}px`,
                  backgroundPosition: `-${c.idx * cellW}px 0`,
                }}
              />
            ))}
            {segments.map((s) => (
              <div
                key={s.start}
                className={
                  'seg' + (s.excluded ? ' excluded' : '') + (s.dur > MAX_CLIP + 1e-3 && !s.excluded ? ' long' : '') +
                  (selected === s.start ? ' selected' : '')
                }
                style={{ left: xOf(s.start), width: Math.max(1, xOf(s.end) - xOf(s.start)) }}
                onPointerDown={() => setSelected(s.start)}
              >
                <span className="seg-label">
                  {s.excluded ? 'Bỏ qua' : `${s.dur.toFixed(2)}s`}
                </span>
              </div>
            ))}
          </div>
          {splits.map((f) => (
            <div key={f} className="split-mark" style={{ left: xOf(f) }} title={`Điểm cắt ${tc(f, fps)}`} />
          ))}
          <div className="playhead" style={{ left: xOf(frame) }}>
            <div className="ph-head" />
          </div>
        </div>
      </div>
      <small className="muted">
        Kéo trên thước/timeline để tua · ←/→ từng khung · Shift+←/→ từng giây · ↑/↓ nhảy tới điểm cắt · Space phát/dừng · Ctrl+lăn chuột để zoom
      </small>

      <div className="ed-bottom">
        <div className="row">
          <span>Tự chia mỗi</span>
          <input type="number" min={0.5} max={MAX_CLIP} step={0.5} value={autoSec} onChange={(e) => setAutoSec(Number(e.target.value))} style={{ width: 70 }} />
          <span>giây</span>
          <button onClick={autoSplit}>Áp dụng</button>
          <button onClick={clearAll} disabled={!splits.length && !excluded.length}>Xoá hết điểm cắt</button>
          <span className="grow" />
          <label className="check">
            <input type="checkbox" checked={mute} onChange={(e) => setMute(e.target.checked)} /> Tắt âm thanh
          </label>
        </div>

        <div className="seg-list">
          {segments.map((s, i) => (
            <div
              key={s.start}
              className={'seg-chip' + (s.excluded ? ' excluded' : '') + (s.dur > MAX_CLIP + 1e-3 && !s.excluded ? ' long' : '') + (selected === s.start ? ' selected' : '')}
              onClick={() => { setSelected(s.start); seek(s.start); }}
            >
              <b>Đoạn {i + 1}</b> {tc(s.start, fps)} → {tc(s.end, fps)} <span className="muted">({s.dur.toFixed(2)}s)</span>
              {s.excluded && <span className="muted"> · bỏ qua</span>}
            </div>
          ))}
        </div>

        {tooLong.length > 0 && (
          <div className="err">
            {tooLong.length} đoạn dài hơn {MAX_CLIP}s (giới hạn của Omni Flash) — cắt thêm hoặc bỏ qua đoạn đó.
          </div>
        )}
        <button
          className="primary big"
          disabled={busy || !kept.length || tooLong.length > 0}
          onClick={() => onExport({ ranges: kept.map((s) => [s.startS, s.endS]), mute })}
        >
          {busy ? 'Đang xuất…' : `✂️ Xuất ${kept.length} đoạn`}
        </button>
      </div>
    </div>
  );
}
