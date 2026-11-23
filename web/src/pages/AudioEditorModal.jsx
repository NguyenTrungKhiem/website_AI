// Modal cắt bỏ dạo đầu, cắt nhiều đoạn giữ lại hoặc ghép nhiều file nhạc thành 1 file MP3 mới trong thư viện.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { FileDrop, useAction } from '../components.jsx';

const fmtTime = (sec) => {
  const n = Math.max(0, Number(sec) || 0);
  const m = Math.floor(n / 60);
  const s = (n % 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
};

const round1 = (n) => Math.round(Math.max(0, Number(n) || 0) * 10) / 10;

const WAVE_BARS = 220;

function computePeaks(audioBuffer, barCount = WAVE_BARS) {
  const ch = audioBuffer.getChannelData(0);
  const blockSize = Math.max(1, Math.floor(ch.length / barCount));
  const raw = new Array(barCount).fill(0);
  let max = 0;
  for (let i = 0; i < barCount; i++) {
    const start = i * blockSize;
    const end = Math.min(ch.length, start + blockSize);
    let peak = 0;
    const step = Math.max(1, Math.floor((end - start) / 64));
    for (let j = start; j < end; j += step) {
      const v = Math.abs(ch[j]);
      if (v > peak) peak = v;
    }
    raw[i] = peak;
    if (peak > max) max = peak;
  }
  const denom = max > 0 ? max : 1;
  return raw.map((v) => Math.max(0.06, v / denom));
}

export default function AudioEditorModal({
  open,
  onClose,
  audios = [],
  initialAudioId = '',
  defaultClipSec = null,
  refresh,
  onCreated,
}) {
  const { busy, error, run } = useAction();
  const mainAudioRef = useRef(null);
  const segAudioRef = useRef(null);
  const canvasRef = useRef(null);
  const peaksCacheRef = useRef(new Map());
  const nextKeyRef = useRef(1);
  const scrubbingRef = useRef(false);
  const pendingSegSeekRef = useRef(null);
  const segPlayRef = useRef(null); // { mode: 'single' | 'playlist', index: number }

  const [srcAudioId, setSrcAudioId] = useState('');
  const [inSec, setInSec] = useState(0);
  const [outSec, setOutSec] = useState(0);
  const [curTime, setCurTime] = useState(0);
  const [metaDur, setMetaDur] = useState(0);
  const [mainPlaying, setMainPlaying] = useState(false);
  const [mainRangePreview, setMainRangePreview] = useState(false);
  const [peaks, setPeaks] = useState(null);
  const [waveLoading, setWaveLoading] = useState(false);

  const [segments, setSegments] = useState([]);
  const [segPlaying, setSegPlaying] = useState(null); // { mode, index } | null
  const [outName, setOutName] = useState('');
  const [fadeMs, setFadeMs] = useState(150);
  const [localError, setLocalError] = useState('');

  const audiosById = useMemo(
    () => Object.fromEntries(audios.map((a) => [a.id, a])),
    [audios]
  );
  const srcAudio = audiosById[srcAudioId] || null;
  const dur = Math.max(0, Number(srcAudio?.duration) || metaDur || 0);

  const stopMainAudio = () => {
    const el = mainAudioRef.current;
    if (el && !el.paused) el.pause();
    setMainPlaying(false);
    setMainRangePreview(false);
  };

  const stopSegAudio = () => {
    const el = segAudioRef.current;
    if (el && !el.paused) el.pause();
    pendingSegSeekRef.current = null;
    segPlayRef.current = null;
    setSegPlaying(null);
  };

  // Khởi tạo trạng thái mỗi lần mở modal
  useEffect(() => {
    if (!open) {
      stopMainAudio();
      stopSegAudio();
      return;
    }
    const targetId =
      (initialAudioId && audiosById[initialAudioId] ? initialAudioId : '') ||
      audios[0]?.id ||
      '';
    const picked = audiosById[targetId] || null;
    setSrcAudioId(targetId);
    setInSec(0);
    setOutSec(picked?.duration ? round1(picked.duration) : 0);
    setCurTime(0);
    setMetaDur(picked?.duration || 0);
    setSegments([]);
    setOutName('');
    setFadeMs(150);
    setLocalError('');
    setMainRangePreview(false);
    setSegPlaying(null);
    segPlayRef.current = null;
  }, [open, initialAudioId]);

  // Đóng bằng phím Escape khi không đang xuất
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape' && !busy) onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, onClose]);

  // Tải & giải mã waveform qua Web Audio API (có cache theo audioId, luôn đóng AudioContext)
  useEffect(() => {
    if (!open || !srcAudio?.url) {
      setPeaks(null);
      setWaveLoading(false);
      return;
    }
    const cached = peaksCacheRef.current.get(srcAudio.id);
    if (cached) {
      setPeaks(cached);
      setWaveLoading(false);
      return;
    }
    const ac = new AbortController();
    let cancelled = false;
    setPeaks(null);
    setWaveLoading(true);

    (async () => {
      let ctx = null;
      try {
        const res = await fetch(srcAudio.url, { signal: ac.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        if (cancelled) return;
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        ctx = new AudioCtx();
        const decoded = await ctx.decodeAudioData(buf);
        if (cancelled) return;
        const p = computePeaks(decoded, WAVE_BARS);
        peaksCacheRef.current.set(srcAudio.id, p);
        setPeaks(p);
      } catch {
        if (!cancelled) setPeaks(null);
      } finally {
        if (ctx) ctx.close().catch(() => {});
        if (!cancelled) setWaveLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [open, srcAudio?.id, srcAudio?.url]);

  // Vẽ canvas waveform + vùng chọn [inSec, outSec] + playhead
  useEffect(() => {
    if (!open) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const draw = () => {
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const rectW = Math.max(240, canvas.clientWidth || 760);
      const rectH = Math.max(64, canvas.clientHeight || 78);
      if (canvas.width !== Math.round(rectW * dpr) || canvas.height !== Math.round(rectH * dpr)) {
        canvas.width = Math.round(rectW * dpr);
        canvas.height = Math.round(rectH * dpr);
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      ctx.fillStyle = '#0b0d11';
      ctx.fillRect(0, 0, rectW, rectH);

      const safeDur = Math.max(0.1, dur);
      const xIn = Math.max(0, Math.min(rectW, (inSec / safeDur) * rectW));
      const xOut = Math.max(xIn, Math.min(rectW, (outSec / safeDur) * rectW));

      // Vùng giữ [inSec, outSec]
      ctx.fillStyle = 'rgba(108, 140, 255, 0.16)';
      ctx.fillRect(xIn, 0, Math.max(1, xOut - xIn), rectH);

      // Sóng âm hoặc đường tâm
      const bars = peaks;
      if (bars && bars.length > 0) {
        const step = rectW / bars.length;
        const barW = Math.max(1.5, step * 0.68);
        const midY = rectH / 2;
        for (let i = 0; i < bars.length; i++) {
          const x = i * step + (step - barW) / 2;
          const h = Math.max(3, bars[i] * (rectH - 18));
          const inRange = x + barW >= xIn && x <= xOut;
          ctx.fillStyle = inRange ? '#829eff' : '#353b4a';
          ctx.fillRect(x, midY - h / 2, barW, h);
        }
      } else {
        ctx.fillStyle = '#2b3140';
        ctx.fillRect(0, rectH / 2 - 1, rectW, 2);
      }

      // Làm tối vùng cắt bỏ (ngoài [inSec, outSec])
      ctx.fillStyle = 'rgba(0, 0, 0, 0.38)';
      if (xIn > 0) ctx.fillRect(0, 0, xIn, rectH);
      if (xOut < rectW) ctx.fillRect(xOut, 0, rectW - xOut, rectH);

      // Mốc Đầu (IN) & Cuối (OUT)
      ctx.fillStyle = '#3fbf7f';
      ctx.fillRect(Math.max(0, xIn - 1), 0, 2, rectH);
      ctx.fillRect(Math.min(rectW - 22, Math.max(0, xIn - 1)), 0, 22, 13);
      ctx.fillStyle = '#081a10';
      ctx.font = 'bold 9px ui-monospace, monospace';
      ctx.fillText('IN', Math.min(rectW - 18, Math.max(3, xIn + 3)), 10);

      ctx.fillStyle = '#e7b04a';
      ctx.fillRect(Math.min(rectW - 2, xOut - 1), 0, 2, rectH);
      const outBadgeX = Math.max(24, xOut - 25);
      ctx.fillRect(outBadgeX, 0, 25, 13);
      ctx.fillStyle = '#1f1504';
      ctx.fillText('OUT', outBadgeX + 3, 10);

      // Playhead hiện tại
      const curNow = mainAudioRef.current ? mainAudioRef.current.currentTime : curTime;
      const xCur = Math.max(0, Math.min(rectW, (curNow / safeDur) * rectW));
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(xCur - 1, 0, 2, rectH);
    };

    draw();
    if (!mainPlaying) return;

    let rafId = 0;
    const tick = () => {
      const el = mainAudioRef.current;
      if (el) {
        setCurTime(el.currentTime);
        if (mainRangePreview && el.currentTime >= outSec - 0.02) {
          el.pause();
          setMainRangePreview(false);
          setMainPlaying(false);
          draw();
          return;
        }
      }
      draw();
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [open, peaks, inSec, outSec, curTime, dur, mainPlaying, mainRangePreview]);

  // Chọn lại nguồn nhạc
  const selectSourceAudio = (id) => {
    stopMainAudio();
    const picked = audiosById[id] || null;
    setSrcAudioId(id);
    setInSec(0);
    setOutSec(picked?.duration ? round1(picked.duration) : 0);
    setCurTime(0);
    setMetaDur(picked?.duration || 0);
    setLocalError('');
  };

  // Tua thanh waveform bằng chuột / cảm ứng
  const seekFromPointer = (clientX) => {
    const canvas = canvasRef.current;
    const el = mainAudioRef.current;
    if (!canvas || !el || dur <= 0) return;
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    const nextT = ratio * dur;
    el.currentTime = nextT;
    setCurTime(nextT);
  };

  const handleUploadNew = (files) =>
    run(async () => {
      const f = files?.[0];
      if (!f) return;
      setLocalError('');
      const created = await api.uploadAudio(f);
      await refresh();
      setSrcAudioId(created.id);
      setInSec(0);
      setOutSec(created.duration ? round1(created.duration) : 0);
      setCurTime(0);
      setMetaDur(created.duration || 0);
    });

  // Thao tác nhanh cắt bỏ dạo đầu / lấy 10s / lấy mốc In-Out
  const cutIntroFromHere = () => {
    const cur = round1(mainAudioRef.current?.currentTime ?? curTime);
    const maxIn = Math.max(0, round1(dur - 0.1));
    const nextIn = Math.min(cur, maxIn);
    setInSec(nextIn);
    setOutSec(round1(dur));
    setLocalError('');
  };

  const takeFixedClipFromHere = () => {
    const clipLen = Number(defaultClipSec) || 10;
    const cur = round1(mainAudioRef.current?.currentTime ?? curTime);
    const maxStart = Math.max(0, round1(dur - clipLen));
    const s = Math.min(cur, maxStart);
    const e = round1(Math.min(dur, s + clipLen));
    setInSec(s);
    setOutSec(e);
    setLocalError('');
  };

  const markIn = () => {
    const cur = round1(mainAudioRef.current?.currentTime ?? curTime);
    const maxIn = Math.max(0, round1(dur - 0.1));
    const nextIn = Math.min(cur, maxIn);
    setInSec(nextIn);
    if (outSec <= nextIn + 0.1) {
      setOutSec(round1(Math.max(dur, nextIn + 0.2)));
    }
    setLocalError('');
  };

  const markOut = () => {
    const cur = round1(mainAudioRef.current?.currentTime ?? curTime);
    const minOut = round1(Math.min(dur || cur, inSec + 0.1));
    setOutSec(Math.max(minOut, Math.min(cur, round1(dur || cur))));
    setLocalError('');
  };

  const toggleMainRangePreview = () => {
    const el = mainAudioRef.current;
    if (!el || !srcAudio) return;
    if (mainRangePreview && !el.paused) {
      el.pause();
      setMainRangePreview(false);
      setMainPlaying(false);
      return;
    }
    if (outSec <= inSec + 0.05) {
      setLocalError('Khoảng chọn phải dài hơn 0.05 giây');
      return;
    }
    stopSegAudio();
    setLocalError('');
    el.currentTime = inSec;
    setCurTime(inSec);
    setMainRangePreview(true);
    el.play().catch(() => {});
  };

  const addSegment = () => {
    if (!srcAudio) return;
    const safeEnd = Math.min(dur || outSec, outSec);
    if (safeEnd <= inSec + 0.05) {
      setLocalError('Khoảng đang chọn quá ngắn (cần > 0.05s) để thêm vào danh sách ghép');
      return;
    }
    setLocalError('');
    setSegments((prev) => [
      ...prev,
      {
        key: nextKeyRef.current++,
        audioId: srcAudio.id,
        audioName: srcAudio.name,
        start: round1(inSec),
        end: round1(safeEnd),
      },
    ]);
  };

  const updateSegment = (idx, patch) => {
    setSegments((prev) => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  };

  const moveSegment = (idx, delta) => {
    setSegments((prev) => {
      const target = idx + delta;
      if (target < 0 || target >= prev.length) return prev;
      const copy = [...prev];
      [copy[idx], copy[target]] = [copy[target], copy[idx]];
      return copy;
    });
  };

  const removeSegment = (idx) => {
    stopSegAudio();
    setSegments((prev) => prev.filter((_, i) => i !== idx));
  };

  // Phát thử 1 đoạn hoặc toàn bộ danh sách ghép qua segAudioRef (tách biệt với trình phát chính)
  const playSegmentAt = (idx, mode) => {
    const el = segAudioRef.current;
    const seg = segments[idx];
    const audio = seg && audiosById[seg.audioId];
    if (!el || !audio?.url) {
      stopSegAudio();
      return;
    }
    if (seg.end <= seg.start + 0.05) {
      setLocalError(`Đoạn #${idx + 1} có khoảng thời gian không hợp lệ`);
      stopSegAudio();
      return;
    }
    stopMainAudio();
    setLocalError('');
    const nextState = { mode, index: idx };
    segPlayRef.current = nextState;
    setSegPlaying(nextState);

    const targetHref = new URL(audio.url, window.location.href).href;
    if (el.src !== targetHref) {
      pendingSegSeekRef.current = seg.start;
      el.src = audio.url;
      el.load();
    } else if (el.readyState >= 1) {
      pendingSegSeekRef.current = null;
      el.currentTime = seg.start;
      el.play().catch(() => {});
    } else {
      pendingSegSeekRef.current = seg.start;
    }
  };

  const togglePlaySegment = (idx) => {
    if (segPlaying?.mode === 'single' && segPlaying.index === idx) {
      stopSegAudio();
    } else {
      playSegmentAt(idx, 'single');
    }
  };

  const togglePlayPlaylist = () => {
    if (segPlaying?.mode === 'playlist') {
      stopSegAudio();
    } else if (segments.length > 0) {
      playSegmentAt(0, 'playlist');
    }
  };

  const handleSegLoadedMetadata = () => {
    const el = segAudioRef.current;
    if (!el || pendingSegSeekRef.current == null) return;
    el.currentTime = pendingSegSeekRef.current;
    pendingSegSeekRef.current = null;
    el.play().catch(() => {});
  };

  const handleSegTimeUpdate = () => {
    const el = segAudioRef.current;
    const state = segPlayRef.current;
    if (!el || !state) return;
    const seg = segments[state.index];
    if (!seg) {
      stopSegAudio();
      return;
    }
    if (el.currentTime >= seg.end - 0.03) {
      if (state.mode === 'playlist' && state.index + 1 < segments.length) {
        playSegmentAt(state.index + 1, 'playlist');
      } else {
        stopSegAudio();
      }
    }
  };

  const totalSegDur = segments.reduce((acc, s) => acc + Math.max(0, Number(s.end) - Number(s.start)), 0);
  const singleValid = !!srcAudio && outSec > inSec + 0.05;
  const playlistValid =
    segments.length > 0 && segments.every((s) => Number(s.end) > Number(s.start) + 0.05 && audiosById[s.audioId]);
  const canExport = segments.length > 0 ? playlistValid : singleValid;

  const defaultPlaceholder = useMemo(() => {
    if (segments.length > 0) {
      const first = segments[0]?.audioName || 'nhac';
      const base = first.replace(/\.[^.]+$/, '');
      return `${base} (ghép ${segments.length} đoạn)`;
    }
    if (!srcAudio) return 'VD: Nhac Suno (đã cắt dạo đầu)';
    const base = srcAudio.name.replace(/\.[^.]+$/, '');
    return `${base} (cắt ${round1(inSec)}-${round1(outSec)}s)`;
  }, [segments, srcAudio, inSec, outSec]);

  const handleExport = () =>
    run(async () => {
      setLocalError('');
      const payloadSegments =
        segments.length > 0
          ? segments.map((s) => ({
              audioId: s.audioId,
              start: Number(s.start),
              end: Number(s.end),
            }))
          : [{
              audioId: srcAudio.id,
              start: Number(inSec),
              end: Number(Math.min(dur || outSec, outSec)),
            }];

      const created = await api.editAudio({
        segments: payloadSegments,
        name: outName.trim(),
        fadeMs: Number(fadeMs) || 0,
      });
      stopMainAudio();
      stopSegAudio();
      await refresh();
      onCreated?.(created);
      onClose?.();
    });

  if (!open) return null;

  return (
    <div
      className="lightbox"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose?.();
      }}
    >
      <div className="audio-editor-modal stack" role="dialog" aria-modal="true" aria-label="Cắt và Ghép nhạc">
        <div className="row between">
          <div className="row gap-sm">
            <b>✂️ Cắt &amp; Ghép nhạc (MP3)</b>
            <small className="muted">Cắt bỏ dạo đầu, trích nhiều khúc hay ghép nhiều bài thành 1 file mới</small>
          </div>
          <button type="button" className="small-btn" disabled={busy} onClick={onClose}>✕ Đóng</button>
        </div>

        {/* Nguồn nhạc & Tải thêm */}
        <div className="row" style={{ gap: 8 }}>
          <select
            style={{ flex: '1 1 280px', minWidth: 0 }}
            value={srcAudioId}
            disabled={busy}
            onChange={(e) => selectSourceAudio(e.target.value)}
          >
            {audios.length === 0 && <option value="">— Chưa có file nhạc trong thư viện —</option>}
            {audios.map((a) => (
              <option key={a.id} value={a.id}>
                {a.sourceId ? '🎬 ' : '🎵 '}{a.name} ({fmtTime(a.duration)})
              </option>
            ))}
          </select>
          <FileDrop accept="audio/*,.mp3,.wav,.m4a" onFiles={handleUploadNew}>
            <button type="button" disabled={busy}>+ Tải thêm nhạc</button>
          </FileDrop>
        </div>

        {/* Trình phát chính + Waveform */}
        {srcAudio ? (
          <div className="stack" style={{ gap: 10 }}>
            <div className="waveform-box">
              <div className="row between small muted" style={{ marginBottom: 4 }}>
                <span>
                  Vị trí đang nghe: <b style={{ color: 'var(--text)' }}>{fmtTime(curTime)}</b> / {fmtTime(dur)}
                  {waveLoading && ' · đang vẽ sóng âm…'}
                </span>
                <span>Kéo hoặc bấm trực tiếp lên sóng âm để tua nhanh</span>
              </div>
              <canvas
                ref={canvasRef}
                className="waveform-canvas"
                onPointerDown={(e) => {
                  scrubbingRef.current = true;
                  e.currentTarget.setPointerCapture?.(e.pointerId);
                  seekFromPointer(e.clientX);
                }}
                onPointerMove={(e) => {
                  if (scrubbingRef.current) seekFromPointer(e.clientX);
                }}
                onPointerUp={(e) => {
                  scrubbingRef.current = false;
                  e.currentTarget.releasePointerCapture?.(e.pointerId);
                }}
                onPointerCancel={() => {
                  scrubbingRef.current = false;
                }}
              />
            </div>

            <audio
              ref={mainAudioRef}
              controls
              src={srcAudio.url}
              preload="metadata"
              style={{ width: '100%' }}
              onLoadedMetadata={(e) => {
                const d = round1(e.currentTarget.duration || 0);
                if (d > 0) {
                  setMetaDur(d);
                  setOutSec((prev) => (prev <= 0 || prev > d + 0.2 ? d : prev));
                }
              }}
              onTimeUpdate={(e) => {
                const t = e.currentTarget.currentTime;
                setCurTime(t);
                if (mainRangePreview && t >= outSec - 0.03) {
                  e.currentTarget.pause();
                  setMainRangePreview(false);
                  setMainPlaying(false);
                }
              }}
              onPlay={() => {
                stopSegAudio();
                setMainPlaying(true);
              }}
              onPause={() => {
                setMainPlaying(false);
                setMainRangePreview(false);
              }}
              onEnded={() => {
                setMainPlaying(false);
                setMainRangePreview(false);
              }}
            />

            {/* Các nút bỏ dạo đầu nhanh */}
            <div className="row" style={{ gap: 8 }}>
              <button
                type="button"
                className="primary-outline"
                onClick={cutIntroFromHere}
                title="Đặt điểm bắt đầu tại mốc đang nghe và giữ đến hết bài — bỏ toàn bộ đoạn dạo đầu phía trước"
              >
                ✂️ Bỏ dạo đầu (từ {fmtTime(curTime)} → hết bài)
              </button>
              {Number(defaultClipSec) > 0 && (
                <button
                  type="button"
                  onClick={takeFixedClipFromHere}
                  title={`Chọn đúng ${defaultClipSec} giây bắt đầu từ vị trí đang nghe`}
                >
                  ⚡ Lấy đúng {defaultClipSec}s từ mốc này
                </button>
              )}
              <button type="button" onClick={toggleMainRangePreview} disabled={!singleValid}>
                {mainRangePreview ? '⏹ Dừng nghe đoạn chọn' : '▶ Nghe đoạn đang chọn'}
              </button>
            </div>

            {/* Nhập số Bắt đầu / Kết thúc & Thêm vào danh sách ghép */}
            <div className="row" style={{ gap: 8, background: 'var(--panel2)', padding: '10px 12px', borderRadius: 8 }}>
              <label className="inline">
                <span className="small">Bắt đầu (s):</span>
                <input
                  type="number"
                  min={0}
                  max={round1(dur)}
                  step={0.1}
                  style={{ width: 82 }}
                  value={inSec}
                  onChange={(e) => {
                    const v = round1(e.target.value);
                    setInSec(Math.min(v, round1(dur)));
                    setLocalError('');
                  }}
                />
              </label>
              <button type="button" className="small-btn" onClick={markIn}>📍 Lấy đầu</button>

              <label className="inline">
                <span className="small">Kết thúc (s):</span>
                <input
                  type="number"
                  min={0}
                  max={round1(dur)}
                  step={0.1}
                  style={{ width: 82 }}
                  value={outSec}
                  onChange={(e) => {
                    const v = round1(e.target.value);
                    setOutSec(Math.min(v, round1(dur || v)));
                    setLocalError('');
                  }}
                />
              </label>
              <button type="button" className="small-btn" onClick={markOut}>📍 Lấy cuối</button>

              <span className="badge blue">
                Độ dài chọn: {fmtTime(Math.max(0, outSec - inSec))}
              </span>

              <button
                type="button"
                style={{ marginLeft: 'auto' }}
                disabled={!singleValid || busy}
                onClick={addSegment}
                title="Thêm đoạn đang chọn vào danh sách để ghép nhiều đoạn hoặc nhiều bài nhạc"
              >
                ➕ Thêm vào danh sách ghép
              </button>
            </div>
          </div>
        ) : (
          <div className="muted small">Chưa có file nhạc nào. Hãy tải lên 1 file MP3/M4A/WAV ở nút phía trên.</div>
        )}

        {/* Audio ẩn riêng để nghe thử đoạn hoặc playlist ghép */}
        <audio
          ref={segAudioRef}
          preload="auto"
          style={{ display: 'none' }}
          onLoadedMetadata={handleSegLoadedMetadata}
          onTimeUpdate={handleSegTimeUpdate}
          onEnded={() => {
            const state = segPlayRef.current;
            if (state?.mode === 'playlist' && state.index + 1 < segments.length) {
              playSegmentAt(state.index + 1, 'playlist');
            } else {
              stopSegAudio();
            }
          }}
        />

        {/* Danh sách ghép nhiều đoạn */}
        {segments.length === 0 ? (
          <div className="muted small" style={{ background: 'var(--panel2)', padding: '8px 12px', borderRadius: 8 }}>
            💡 <b>Chỉ cần bỏ dạo đầu / cắt 1 đoạn?</b> Bạn không cần bấm thêm vào danh sách — cứ chỉnh điểm <b>Bắt đầu / Kết thúc</b> phía trên rồi bấm nút <b>💾 Cắt &amp; Dùng nhạc này</b> ngay bên dưới. Muốn <b>bỏ nhiều đoạn giữa bài</b> hoặc <b>ghép nhiều file nhạc</b> thì bấm <b>➕ Thêm vào danh sách ghép</b>.
          </div>
        ) : (
          <div className="seg-editor-list stack" style={{ gap: 8 }}>
            <div className="row between">
              <b className="small">Danh sách ghép ({segments.length} đoạn · tổng {fmtTime(totalSegDur)})</b>
              <div className="row gap-xs">
                <button type="button" className="small-btn" onClick={togglePlayPlaylist}>
                  {segPlaying?.mode === 'playlist' ? '⏹ Dừng nghe ghép' : '▶ Nghe ghép thử cả danh sách'}
                </button>
                <button
                  type="button"
                  className="link small"
                  onClick={() => {
                    stopSegAudio();
                    setSegments([]);
                  }}
                >
                  Xoá danh sách
                </button>
              </div>
            </div>
            {segments.map((seg, i) => {
              const isPlayingThis = segPlaying?.mode === 'single' && segPlaying.index === i;
              const isActivePlaylist = segPlaying?.mode === 'playlist' && segPlaying.index === i;
              const segDur = Math.max(0, Number(seg.end) - Number(seg.start));
              const maxDur = audiosById[seg.audioId]?.duration || Math.max(seg.end, 600);
              return (
                <div
                  key={seg.key}
                  className={'seg-editor-row row' + (isPlayingThis || isActivePlaylist ? ' playing' : '')}
                >
                  <b>#{i + 1}</b>
                  <span className="grow ellipsis" title={seg.audioName}>{seg.audioName}</span>
                  <input
                    type="number"
                    min={0}
                    max={round1(maxDur)}
                    step={0.1}
                    style={{ width: 72, padding: '4px 6px' }}
                    value={seg.start}
                    onChange={(e) => updateSegment(i, { start: round1(e.target.value) })}
                    title="Giây bắt đầu"
                  />
                  <span className="muted">→</span>
                  <input
                    type="number"
                    min={0}
                    max={round1(maxDur)}
                    step={0.1}
                    style={{ width: 72, padding: '4px 6px' }}
                    value={seg.end}
                    onChange={(e) => updateSegment(i, { end: Math.min(round1(maxDur), round1(e.target.value)) })}
                    title="Giây kết thúc"
                  />
                  <span className="badge gray">{fmtTime(segDur)}</span>
                  <button
                    type="button"
                    className="small-btn"
                    onClick={() => togglePlaySegment(i)}
                    title={isPlayingThis ? 'Dừng' : 'Nghe thử đoạn này'}
                  >
                    {isPlayingThis ? '⏹' : '▶'}
                  </button>
                  <button
                    type="button"
                    className="small-btn"
                    disabled={i === 0}
                    onClick={() => moveSegment(i, -1)}
                    title="Đưa lên"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="small-btn"
                    disabled={i === segments.length - 1}
                    onClick={() => moveSegment(i, 1)}
                    title="Đưa xuống"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="small-btn danger"
                    onClick={() => removeSegment(i)}
                    title="Xoá đoạn"
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* Tuỳ chọn xuất file & Lưu */}
        <div className="row" style={{ gap: 10 }}>
          <label style={{ flex: '1 1 260px' }}>
            <span className="small">Tên file nhạc mới (lưu vào thư viện)</span>
            <input
              value={outName}
              onChange={(e) => setOutName(e.target.value)}
              placeholder={defaultPlaceholder}
              disabled={busy}
            />
          </label>
          <label style={{ minWidth: 230 }}>
            <span className="small">Làm mượt điểm cắt (Fade)</span>
            <select value={fadeMs} disabled={busy} onChange={(e) => setFadeMs(Number(e.target.value))}>
              <option value={0}>Không fade (giữ nguyên nhịp)</option>
              <option value={150}>Fade nhẹ 150ms (khuyên dùng)</option>
              <option value={400}>Fade vừa 400ms</option>
              <option value={800}>Fade sâu 800ms</option>
            </select>
          </label>
        </div>

        {(localError || error) && <div className="err">{localError || error}</div>}

        <div className="row between">
          <button type="button" disabled={busy} onClick={onClose}>Huỷ</button>
          <button type="button" className="primary" disabled={busy || !canExport} onClick={handleExport}>
            {busy
              ? '⏳ Đang cắt ghép FFmpeg…'
              : segments.length > 0
                ? `💾 Ghép ${segments.length} đoạn & Dùng ngay (${fmtTime(totalSegDur)})`
                : `💾 Cắt & Dùng nhạc này (${fmtTime(Math.max(0, outSec - inSec))})`}
          </button>
        </div>
      </div>
    </div>
  );
}
