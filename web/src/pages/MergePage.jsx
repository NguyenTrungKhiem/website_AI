import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { Badge, ConfirmButton, FileDrop, fmt, useAction } from '../components.jsx';

export default function MergePage({ state, refresh, go, handoff }) {
  const done = state.jobs.filter((j) => j.status === 'done' && j.type !== 'image'); // chỉ video, không lấy job sinh ảnh
  const byId = useMemo(() => Object.fromEntries(state.jobs.map((j) => [j.id, j])), [state.jobs]);
  const [seq, setSeq] = useState(handoff.merge);
  const [filter, setFilter] = useState('all');
  const [audioId, setAudioId] = useState(null);
  const [mode, setMode] = useState('match');
  const [offset, setOffset] = useState(0);
  const [name, setName] = useState('');
  const [selected, setSelected] = useState([]);
  const [watermarkMode, setWatermarkMode] = useState(
    state.settings.watermarkMode || (state.settings.removeWatermark === false ? 'off' : 'delogo')
  );
  const { busy, error, run } = useAction();

  useEffect(() => setSeq(sortBySource(handoff.merge, byId)), [handoff.merge]);

  const items = seq.map((id) => byId[id]).filter(Boolean);
  const audio = state.audios.find((a) => a.id === audioId);
  const total = items.reduce((t, j) => t + (j.range ? j.range.end - j.range.start : 0), 0);
  // Chế độ khớp từng đoạn chỉ dùng được khi mọi video cắt từ video gốc của âm thanh
  const canMatch = !!audio?.sourceId && items.length > 0 && items.every((j) => j.range?.sourceId === audio.sourceId);

  // Tự chọn âm thanh gốc của video đang ghép
  useEffect(() => {
    if (audioId || !items.length) return;
    const src = items[0].range?.sourceId;
    const a = src && state.audios.find((x) => x.sourceId === src);
    if (a) setAudioId(a.id);
  }, [items.length]);
  useEffect(() => {
    if (audio) setMode(canMatch ? 'match' : 'continuous');
  }, [audioId, canMatch]);

  const add = (id) => setSeq((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const move = (i, d) =>
    setSeq((s) => {
      const n = [...s];
      [n[i], n[i + d]] = [n[i + d], n[i]];
      return n;
    });

  const submit = () =>
    run(async () => {
      await api.merge({
        jobIds: seq,
        audioId,
        audioMode: mode,
        offset,
        name,
        watermarkMode,
        removeWatermark: watermarkMode !== 'off',
      });
      await refresh();
    });

  const uploadAudio = (files) =>
    run(async () => {
      let last;
      for (const f of files) last = await api.uploadAudio(f);
      await refresh();
      if (last) setAudioId(last.id);
    });

  const list = done.filter((j) => filter === 'all' || j.type === filter);
  const toggleSel = (id) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  // Nhập video từ máy: thêm vào danh sách và nối luôn vào cuối thứ tự ghép
  const importVideos = (files) =>
    run(async () => {
      const jobs = await api.importVideos(files);
      await refresh();
      setSeq((s) => [...s, ...jobs.map((j) => j.id)]);
    });
  const setRange = (jobId, clipId) => run(async () => { await api.setJobRange(jobId, clipId || null); await refresh(); });
  // Đoạn gốc để gán cho video nhập: của video gốc đang có âm thanh được chọn, không thì mọi đoạn
  const rangeClips = (audio?.sourceId ? state.clips.filter((c) => c.sourceId === audio.sourceId) : state.clips)
    .slice().sort((a, b) => (a.sourceId === b.sourceId ? a.start - b.start : a.sourceId < b.sourceId ? -1 : 1));
  const icon = (j) => (j.type === 'import' ? '📥' : j.type === 'background' ? '🏞️' : '🕺');

  return (
    <section>
      <h1>Ghép video</h1>
      <p className="muted">Nối các video đã tạo thành 1 video hoàn chỉnh, rồi chèn âm thanh đã tách từ video gốc (hoặc file nhạc khác).</p>

      <div className="card stack">
        <div className="row between">
          <b>1. Chọn video theo thứ tự ghép</b>
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="all">Tất cả video đã xong</option>
            <option value="background">Đã thay bối cảnh</option>
            <option value="motion">Motion control</option>
            <option value="import">Nhập từ máy</option>
          </select>
        </div>
        <div className="thumbs">
          <FileDrop accept="video/*" multiple onFiles={importVideos}>
            <div className="thumb wide add" title="Thêm video từ máy để ghép hoặc thay thế video đã tạo">
              {busy ? '…' : '📥 Thêm video từ máy'}
            </div>
          </FileDrop>
          {list.map((j) => {
            const pos = seq.indexOf(j.id);
            return (
              <div key={j.id} className={'thumb wide' + (pos >= 0 ? ' selected' : '')} onClick={() => add(j.id)} title={j.videoLabel}>
                <img src={j.thumbUrl} alt="" />
                {pos >= 0 && <span className="order">{pos + 1}</span>}
                <span className="cap">{icon(j)} {j.videoLabel}</span>
              </div>
            );
          })}
        </div>
        {list.length === 0 && <p className="muted">Chưa có video nào hoàn thành. Bạn có thể thêm video từ máy.</p>}

        {items.length > 0 && (
          <div className="stack">
            <div className="row between">
              <small className="muted">Thứ tự ghép ({items.length} video{total ? `, ~${fmt(total)} theo video gốc` : ''})</small>
              <div className="row">
                <a onClick={() => setSeq(sortBySource(seq, byId))}>Sắp theo thời gian trong video gốc</a>
                <a onClick={() => setSeq([])}>Xoá hết</a>
              </div>
            </div>
            {items.map((j, i) => (
              <div key={j.id} className="range-row">
                <span>
                  <b>{i + 1}.</b> {icon(j)} {j.videoLabel}
                  {j.range && <small className="muted"> · gốc {fmt(j.range.start)}–{fmt(j.range.end)}</small>}
                  {j.type === 'import' && (
                    <select
                      className="inline-select"
                      value={rangeClips.find((c) => c.sourceId === j.range?.sourceId && c.start === j.range?.start)?.id || ''}
                      onChange={(e) => setRange(j.id, e.target.value)}
                      title="Khớp với đoạn gốc nào (để chèn đúng khúc âm thanh)"
                    >
                      <option value="">— khớp đoạn gốc: chưa chọn —</option>
                      {rangeClips.map((c) => <option key={c.id} value={c.id}>{c.name} ({fmt(c.start)}–{fmt(c.end)})</option>)}
                    </select>
                  )}
                </span>
                <a onClick={() => i > 0 && move(i, -1)}>↑</a>
                <a onClick={() => i < items.length - 1 && move(i, 1)}>↓</a>
                <a onClick={() => add(j.id)}>Bỏ</a>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card stack">
        <b>2. Âm thanh</b>
        <div className="audios">
          <label className={'audio' + (!audioId ? ' selected' : '')}>
            <input type="radio" checked={!audioId} onChange={() => setAudioId(null)} />
            <span>🔇 Không chèn âm thanh</span>
          </label>
          {state.audios.map((a) => (
            <label key={a.id} className={'audio' + (audioId === a.id ? ' selected' : '')}>
              <input type="radio" checked={audioId === a.id} onChange={() => setAudioId(a.id)} />
              <span className="grow ellipsis">{a.sourceId ? '🎬' : '🎵'} {a.name} <small className="muted">({fmt(a.duration)})</small></span>
              <audio src={a.url} controls preload="none" />
              <a href={a.url} download>Tải về</a>
              <ConfirmButton link className="" armedText="Xoá?" onConfirm={() => run(async () => { await api.deleteAudio(a.id); if (audioId === a.id) setAudioId(null); await refresh(); })}>Xoá</ConfirmButton>
            </label>
          ))}
        </div>
        <FileDrop accept="audio/*,video/*" multiple onFiles={uploadAudio}>
          <div className="drop-inner small">+ Tải file nhạc / âm thanh khác (mp3, m4a, wav…)</div>
        </FileDrop>

        {audio && (
          <div className="stack">
            <label className="check">
              <input type="radio" checked={mode === 'match'} disabled={!canMatch} onChange={() => setMode('match')} />
              <span>
                <b>Khớp từng đoạn với video gốc</b> — mỗi video lấy đúng khúc âm thanh của đoạn gốc tương ứng; video AI dài hơn thì cắt bớt,
                ngắn hơn thì giữ khung cuối, để tiếng luôn khớp hình.
                {!canMatch && <small className="err"> (Cần mọi video được cắt từ video gốc của âm thanh này)</small>}
              </span>
            </label>
            <label className="check">
              <input type="radio" checked={mode === 'continuous'} onChange={() => setMode('continuous')} />
              <span><b>Phát liên tục</b> — âm thanh chạy từ đầu (hoặc từ giây chỉ định) suốt video, cắt theo độ dài video.</span>
            </label>
            {mode === 'continuous' && (
              <label className="inline">
                Bắt đầu âm thanh từ giây
                <input type="number" min={0} step={0.1} value={offset} onChange={(e) => setOffset(Number(e.target.value))} style={{ width: 90 }} />
              </label>
            )}
          </div>
        )}
      </div>

      <div className="card stack">
        <b>3. Xuất video</b>
        <label>
          Tên video
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="VD: Review son môi – bản full" />
        </label>

        <div className="stack" style={{ background: 'var(--panel2)', padding: 12, borderRadius: 8, gap: 10 }}>
          <b>Xử lý logo Gemini (ngôi sao ở góc dưới phải):</b>
          <label className="check" style={{ alignItems: 'flex-start' }}>
            <input
              type="radio"
              name="watermarkOption"
              checked={watermarkMode === 'delogo'}
              onChange={() => setWatermarkMode('delogo')}
              style={{ marginTop: 3 }}
            />
            <span>
              <b>Nội suy delogo (Xoá mờ logo Gemini)</b>
              <br />
              <small className="muted">Thuật toán nội suy các pixel xung quanh để làm mờ xoá logo. Phù hợp khi góc dưới ít chuyển động.</small>
            </span>
          </label>

          <label className="check" style={{ alignItems: 'flex-start' }}>
            <input
              type="radio"
              name="watermarkOption"
              checked={watermarkMode === 'brand'}
              onChange={() => setWatermarkMode('brand')}
              style={{ marginTop: 3 }}
            />
            <span>
              <span className="row" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <b>Đè Logo thương hiệu riêng</b>
                <span className="badge blue" style={{ fontSize: 11 }}>Khuyên dùng cho video nhảy</span>
                {state.settings.watermarkType === 'image' && state.settings.watermarkImageId ? (
                  <span className="badge" style={{ fontSize: 11, background: '#222', color: '#fff' }}>[Ảnh logo]</span>
                ) : (
                  <span className="badge" style={{ fontSize: 11, background: 'rgba(0,0,0,0.6)', color: '#fff' }}>
                    {state.settings.watermarkText?.trim() || '@kenh_cua_ban'}
                  </span>
                )}
              </span>
              <br />
              <small className="muted">
                Đè logo/handle riêng đã cấu hình trong Cài đặt lên góc phải, che kín logo Gemini mà không bao giờ bị nhoè hình khi nhảy hoặc cử động.
              </small>
            </span>
          </label>

          <label className="check" style={{ alignItems: 'flex-start' }}>
            <input
              type="radio"
              name="watermarkOption"
              checked={watermarkMode === 'off'}
              onChange={() => setWatermarkMode('off')}
              style={{ marginTop: 3 }}
            />
            <span>
              <b>Không xử lý</b> <small className="muted">— Giữ nguyên logo gốc của Flow/Gemini</small>
            </span>
          </label>
        </div>

        <button className="primary" disabled={busy || !items.length} onClick={submit}>
          🎞️ Ghép {items.length} video{audio ? ' + âm thanh' : ''}
        </button>
        {error && <div className="err">{error}</div>}
      </div>

      <div className="row between">
        <h2>Video đã ghép</h2>
        <button className="primary" disabled={!selected.length} onClick={() => go('publish', selected)}>
          Đăng {selected.length} video →
        </button>
      </div>
      {state.merges.length === 0 ? (
        <p className="muted">Chưa có video ghép nào.</p>
      ) : (
        <div className="clips">
          {state.merges.map((m) => (
            <div key={m.id} className={'clip stack' + (selected.includes(m.id) ? ' selected' : '')}>
              {m.url ? (
                <video src={m.url} controls preload="metadata" poster={m.thumbUrl} />
              ) : (
                <div className="placeholder">{m.status === 'failed' ? '⚠️' : '⏳'}</div>
              )}
              <div className="row">
                {m.status === 'done' && <input type="checkbox" checked={selected.includes(m.id)} onChange={() => toggleSel(m.id)} />}
                <small className="grow ellipsis" title={m.name}>{m.name}</small>
                {m.watermarkMode === 'brand' ? (
                  <span className="badge blue" title="Đã đè logo riêng che logo Gemini">✓ Logo riêng</span>
                ) : m.watermarkRemoved !== false ? (
                  <span className="badge green" title="Đã nội suy xoá logo Gemini góc dưới phải">✓ Xoá logo</span>
                ) : null}
                <Badge status={m.status} />
              </div>
              <small className="muted">
                {m.jobIds.length} đoạn{m.duration ? ` · ${fmt(m.duration)}` : ''} · {m.audioMode === 'match' ? 'âm thanh khớp từng đoạn' : m.audioMode === 'continuous' ? 'âm thanh liên tục' : 'không âm thanh'}
              </small>
              {m.error && <div className="err small">{m.error}</div>}
              <div className="row">
                {m.url && <a href={m.url} download={`${m.name}.mp4`}>Tải về</a>}
                {m.status === 'done' && <button className="primary small-btn" onClick={() => go('publish', [m.id])}>🚀 Đăng video</button>}
                <a onClick={() => { setSeq(m.jobIds); setAudioId(m.audioId); window.scrollTo(0, 0); }}>Ghép lại</a>
                <span className="grow" />
                <ConfirmButton link className="" armedText="Bấm lần nữa để xoá" onConfirm={() => run(async () => { await api.deleteMerge(m.id); setSelected((s) => s.filter((x) => x !== m.id)); await refresh(); })}>Xoá</ConfirmButton>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// Video có vị trí trong video gốc thì xếp theo (video gốc, thời điểm bắt đầu); còn lại giữ nguyên ở cuối
function sortBySource(ids, byId) {
  return [...ids].sort((a, b) => {
    const ra = byId[a]?.range;
    const rb = byId[b]?.range;
    if (!ra || !rb) return (ra ? 0 : 1) - (rb ? 0 : 1);
    return ra.sourceId === rb.sourceId ? ra.start - rb.start : ra.sourceId < rb.sourceId ? -1 : 1;
  });
}
