// Khối điều khiển chọn/cắt MP3 Suno, dán lời gốc, phân tích cụm câu 0.1s qua Gemini Web ngầm,
// kiểm tra đủ chữ và chỉnh nhanh bảng Kịch bản / Prompt Omni Flash (chỉ nói thoại khô + đa góc quay ngôi sao).
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { FileDrop, useAction } from '../components.jsx';
import AudioEditorModal from './AudioEditorModal.jsx';

const fmtDur = (sec) => {
  const n = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(n / 60);
  const s = n % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
};

const round1 = (v) => Math.round(Math.max(0, Number(v) || 0) * 10) / 10;

const normalizeWords = (str) =>
  String(str || '')
    .toLowerCase()
    .replace(/[.,!?;:"'()\[\]{}…–—\-/\\]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

function computeCoverage(lyricsHint, timeline = [], durationSec = 10) {
  const dur = Math.max(1, Number(durationSec) || 10);
  const voiced = timeline.filter((r) => r?.hasVoice && String(r?.lyric || '').trim());
  const wordsArr = voiced.flatMap((r) => normalizeWords(r.lyric));
  const voicedSec = voiced.reduce((sum, r) => sum + Math.max(0.1, (Number(r.to) || 0) - (Number(r.from) || 0)), 0);
  const wordsPerSec = voicedSec > 0 ? +(wordsArr.length / voicedSec).toFixed(2) : 0;

  const expectedArr = normalizeWords(lyricsHint);
  const counts = new Map();
  for (const w of wordsArr) counts.set(w, (counts.get(w) || 0) + 1);
  const missingWords = [];
  for (const w of expectedArr) {
    const c = counts.get(w) || 0;
    if (c > 0) counts.set(w, c - 1);
    else missingWords.push(w);
  }
  const maxRecommended = Math.round(dur * 3.5);
  return {
    timelineWords: wordsArr.length,
    expectedWords: expectedArr.length,
    voicedSec: +voicedSec.toFixed(1),
    wordsPerSec,
    missingWords,
    tooDense: wordsArr.length > maxRecommended,
    maxRecommended,
  };
}

export default function SunoAudioPanel({ state, refresh, wf, options, onChange }) {
  const { busy, error, run } = useAction();
  const audioRef = useRef(null);
  const [gemStatus, setGemStatus] = useState(null);
  const [statusMsg, setStatusMsg] = useState('');
  const [rebuilding, setRebuilding] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);

  const audios = state.audios || [];
  const audioId = options.audioId || '';
  const selectedAudio = audios.find((a) => a.id === audioId) || null;
  const durationSec = parseFloat(options.duration || '10s') || 10;
  const startSec = Math.max(0, Number(options.audioStartSec) || 0);
  const syncOffsetMs = Math.round(Number(options.syncOffsetMs) || 0);
  const timeline = Array.isArray(options.timeline) ? options.timeline : [];

  const coverage = useMemo(
    () => computeCoverage(options.lyricsHint || '', timeline, durationSec),
    [options.lyricsHint, timeline, durationSec],
  );

  useEffect(() => {
    api.geminiWebStatus().then(setGemStatus).catch(() => {});
  }, []);

  // Tự chọn file audio đầu tiên chưa gắn nguồn video (ưu tiên file MP3 tải lên) nếu chưa chọn
  useEffect(() => {
    if (!audioId && audios.length > 0) {
      const preferred = audios.find((a) => !a.sourceId) || audios[0];
      onChange({ audioId: preferred.id });
    }
  }, [audios.length, audioId]);

  const uploadMp3 = (files) =>
    run(async () => {
      const f = files?.[0];
      if (!f) return;
      const created = await api.uploadAudio(f);
      await refresh();
      onChange({
        audioId: created.id,
        audioStartSec: 0,
        timeline: null,
        customPrompt: '',
      });
      setStatusMsg(`Đã tải lên: ${created.name} (${fmtDur(created.duration)})`);
    });

  const grabCurrentTime = () => {
    const t = audioRef.current?.currentTime;
    if (!Number.isFinite(t)) return;
    const maxStart = selectedAudio?.duration ? Math.max(0, selectedAudio.duration - durationSec) : t;
    const clamped = Math.round(Math.min(t, maxStart) * 10) / 10;
    onChange({ audioStartSec: clamped, timeline: null, customPrompt: '' });
  };

  const openGemini = () =>
    run(async () => {
      const st = await api.openGeminiWeb();
      setGemStatus(st);
      setStatusMsg('Đã mở cửa sổ Chrome Gemini lên màn hình — đăng nhập tài khoản Google xong bạn có thể thu nhỏ lại rồi bấm Phân tích / Chạy.');
    });

  const analyzePreview = () =>
    run(async () => {
      if (!audioId) throw new Error('Chọn hoặc tải lên 1 file nhạc Suno (.mp3) trước');
      setStatusMsg('');
      const res = await api.analyzeSunoAudio({
        audioId,
        startSec,
        durationSec,
        lyricsHint: options.lyricsHint || '',
        micType: options.micType || 'handheld',
        aspectRatio: options.aspectRatio || '16:9',
        cameraPreset: options.cameraPreset || 'star-multicam',
        lipSyncMode: options.lipSyncMode || 'spoken',
        modelName: options.geminiWebModel || 'Neon',
        thinkingLevel: options.geminiThinkingLevel || 'Trung bình',
      });
      onChange({
        timeline: res.timeline,
        songMeta: res.songMeta,
        cameraStyle: res.cameraStyle,
        stageLighting: res.stageLighting,
        customPrompt: res.videoPrompt,
      });
      setStatusMsg(`✓ Đã phân tích ${res.timeline.length} cụm câu (${res.coverage?.timelineWords || 0} từ) bằng ${res.selectedModel || 'Gemini Web'}`);
      api.geminiWebStatus().then(setGemStatus).catch(() => {});
    });

  const rebuildFromTimeline = async (nextTimeline, patchOptions = {}) => {
    setRebuilding(true);
    try {
      const res = await api.rebuildSunoPrompt({
        timeline: nextTimeline,
        songMeta: options.songMeta || {},
        cameraStyle: options.cameraStyle || '',
        stageLighting: options.stageLighting || '',
        aspectRatio: patchOptions.aspectRatio || options.aspectRatio || '16:9',
        durationSec,
        micType: patchOptions.micType || options.micType || 'handheld',
        cameraPreset: patchOptions.cameraPreset || options.cameraPreset || 'star-multicam',
        lipSyncMode: patchOptions.lipSyncMode || options.lipSyncMode || 'spoken',
        lyricsHint: options.lyricsHint || '',
      });
      onChange({ timeline: nextTimeline, customPrompt: res.videoPrompt, ...patchOptions });
    } finally {
      setRebuilding(false);
    }
  };

  const updateRow = (idx, patch) => {
    const next = timeline.map((row, i) => {
      if (i !== idx) return row;
      const merged = { ...row, ...patch };
      if (patch.hasVoice === false) {
        merged.lyric = '';
        merged.vocalIntensity = 'silent';
      } else if (patch.hasVoice === true && (!merged.vocalIntensity || merged.vocalIntensity === 'silent')) {
        merged.vocalIntensity = 'medium';
      }
      return merged;
    });
    onChange({ timeline: next });
  };

  const addPhraseRow = () => {
    const lastTo = timeline.length ? Number(timeline.at(-1)?.to) || 0 : 0;
    const from = Math.min(round1(durationSec - 0.5), round1(lastTo));
    const to = Math.min(durationSec, round1(from + 2));
    onChange({
      timeline: [
        ...timeline,
        {
          from,
          to: Math.max(round1(from + 0.5), to),
          hasVoice: true,
          lyric: '',
          vocalIntensity: 'medium',
          shot: 'Smooth cut to dramatic 3/4 hero close-up orbit with glowing stage spotlight behind',
          action: 'holds wireless mic 4cm below lower lip with charismatic star posture',
        },
      ],
    });
  };

  const removePhraseRow = (idx) => {
    if (timeline.length <= 1) return;
    onChange({ timeline: timeline.filter((_, i) => i !== idx) });
  };

  return (
    <div className="card stack">
      <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
        <b>2. File nhạc Suno (.mp3) &amp; Đạo diễn khẩu hình Gemini Web (chạy ngầm)</b>
        <div className="row gap-xs" style={{ flexWrap: 'wrap' }}>
          <button type="button" className="small-btn" disabled={busy} onClick={openGemini} title="Mở cửa sổ Chrome Gemini Web lên màn hình để đăng nhập Google lần đầu">
            🔑 Mở Chrome Gemini{gemStatus?.profileExists ? ' (đã có hồ sơ)' : ' (đăng nhập lần đầu)'}
          </button>
        </div>
      </div>

      <div className="row" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <select
          style={{ flex: '1 1 260px', minWidth: 0 }}
          value={audioId}
          onChange={(e) => onChange({ audioId: e.target.value, audioStartSec: 0, timeline: null, customPrompt: '' })}
        >
          <option value="">— Chọn file nhạc Suno (.mp3) —</option>
          {audios.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} ({fmtDur(a.duration)}){a.sourceId ? ' [tách từ video]' : ''}
            </option>
          ))}
        </select>
        <FileDrop accept="audio/*,.mp3,.wav,.m4a" onFiles={uploadMp3}>
          <button type="button" disabled={busy}>🎵 Tải lên MP3 Suno</button>
        </FileDrop>
        <button
          type="button"
          disabled={busy || audios.length === 0}
          onClick={() => setEditorOpen(true)}
          title="Cắt bỏ đoạn dạo đầu hoặc ghép nhiều đoạn nhạc thành 1 file MP3 mới"
        >
          ✂️ Cắt / Ghép nhạc
        </button>
      </div>

      {selectedAudio && (
        <div className="stack" style={{ gap: 8 }}>
          <audio ref={audioRef} controls src={selectedAudio.url} style={{ width: '100%' }} />
          <div className="row" style={{ flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
            <label className="row gap-xs" style={{ alignItems: 'center' }}>
              <span>Bắt đầu từ (giây):</span>
              <input
                type="number"
                min="0"
                max={Math.max(0, Math.floor((selectedAudio.duration || 600) - 1))}
                step="0.5"
                style={{ width: 84 }}
                value={startSec}
                onChange={(e) => onChange({ audioStartSec: Math.max(0, Number(e.target.value) || 0), timeline: null, customPrompt: '' })}
              />
            </label>
            <button type="button" className="small-btn" onClick={grabCurrentTime} title="Lấy đúng vị trí đang phát trên trình nghe phía trên">
              📍 Lấy mốc đang nghe
            </button>
            <span className="small muted">
              Đoạn trích: <b>{startSec.toFixed(1)}s → {(startSec + durationSec).toFixed(1)}s</b> ({durationSec}s)
            </span>
            <label className="row gap-xs" style={{ alignItems: 'center' }} title="Dịch khớp âm ±1500ms khi ghép MP3 Suno gốc vào video">
              <span className="small muted">Dịch khớp (ms):</span>
              <input
                type="number"
                min="-1500"
                max="1500"
                step="50"
                style={{ width: 82 }}
                value={syncOffsetMs}
                onChange={(e) => onChange({ syncOffsetMs: Math.max(-1500, Math.min(1500, Number(e.target.value) || 0)) })}
              />
            </label>
          </div>
        </div>
      )}

      <label className="stack" style={{ gap: 4 }}>
        <span className="small">
          <b>Lời bài hát GỐC đoạn {durationSec}s</b> <span className="muted">(khuyên dán từ Suno — giúp Gemini bắt đủ 100% từng chữ, không bị thiếu hay nghe nhầm)</span>
        </span>
        <textarea
          rows={2}
          placeholder="VD: Ta quen nhau đã bao lâu rồi hỡi đêm, sao vẫn mãi đêm dài. Để mình ta với con tim khô."
          value={options.lyricsHint || ''}
          onChange={(e) => onChange({ lyricsHint: e.target.value })}
        />
      </label>

      <div className="row" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <button
          type="button"
          disabled={busy || !audioId}
          onClick={analyzePreview}
          title="Chạy Playwright ngầm vào Gemini Web (model Neon · Trung bình) để chia cụm câu 0.1s & góc quay MV trước khi tốn credit Flow"
        >
          {busy ? '⏳ Đang mở ngầm Gemini Web phân tích…' : '✨ Phân tích thử từng cụm câu trước'}
        </button>
        {options.customPrompt && (
          <button
            type="button"
            className="small-btn"
            disabled={busy}
            onClick={() => onChange({ timeline: null, customPrompt: '' })}
            title="Xoá kịch bản đang giữ để lần bấm Chạy tự phân tích mới từ đầu"
          >
            🔄 Xoá kịch bản sẵn (phân tích lại khi chạy)
          </button>
        )}
        <small className="muted">
          Prompt gửi Omni Flash chỉ yêu cầu <b>nói thoại khô từng chữ (0 hát, 0 nhạc nền)</b> + góc quay MV ngôi sao; MP3 gốc tự ghép đè ở bước cuối.
        </small>
      </div>

      {statusMsg && <small className="ok">{statusMsg}</small>}
      {error && <div className="err">{error}</div>}

      {timeline.length > 0 && (
        <div className="stack" style={{ gap: 8 }}>
          <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
            <b className="small">Kịch bản nhép theo cụm câu ({timeline.length} cụm · {coverage.timelineWords} từ · {coverage.wordsPerSec} từ/giây)</b>
            <div className="row gap-xs">
              <button type="button" className="small-btn" disabled={rebuilding} onClick={addPhraseRow}>
                + Thêm cụm
              </button>
              <button
                type="button"
                className="small-btn primary-outline"
                disabled={rebuilding}
                onClick={() => rebuildFromTimeline(timeline)}
              >
                {rebuilding ? 'Đang cập nhật…' : '↻ Cập nhật Prompt từ bảng này'}
              </button>
            </div>
          </div>

          {coverage.missingWords.length > 0 && (
            <div className="alert warn small">
              ⚠ Còn thiếu <b>{coverage.missingWords.length} từ</b> so với Lời bài hát gốc: <b>{coverage.missingWords.join(', ')}</b> — hãy gõ bổ sung vào bảng rồi bấm <b>↻ Cập nhật Prompt</b>.
            </div>
          )}
          {coverage.expectedWords > 0 && coverage.missingWords.length === 0 && coverage.timelineWords > 0 && (
            <small className="ok">✓ Đã đủ 100% số từ theo lời bài hát gốc ({coverage.timelineWords}/{coverage.expectedWords} từ).</small>
          )}
          {coverage.tooDense && (
            <div className="alert warn small">
              ⚠ Đoạn {durationSec}s đang có <b>{coverage.timelineWords} từ</b> (nên ≤ {coverage.maxRecommended} từ) — quá nhiều chữ trong 10s dễ khiến AI đọc lướt hoặc hụt âm cuối.
            </div>
          )}

          <div style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 68 }}>Từ (s)</th>
                  <th style={{ width: 68 }}>Đến (s)</th>
                  <th style={{ width: 46 }}>Lời</th>
                  <th style={{ minWidth: 190 }}>Câu chữ cần nhép (Nói rõ)</th>
                  <th style={{ minWidth: 180 }}>Góc quay MV (Shot)</th>
                  <th style={{ minWidth: 180 }}>Diễn xuất ngôi sao (Action)</th>
                  <th style={{ width: 34 }}></th>
                </tr>
              </thead>
              <tbody>
                {timeline.map((row, idx) => (
                  <tr key={idx}>
                    <td>
                      <input
                        type="number"
                        step="0.1"
                        min="0"
                        max={durationSec}
                        style={{ width: 62, padding: '5px 6px' }}
                        value={row.from}
                        onChange={(e) => updateRow(idx, { from: round1(e.target.value) })}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        step="0.1"
                        min="0"
                        max={durationSec}
                        style={{ width: 62, padding: '5px 6px' }}
                        value={row.to}
                        onChange={(e) => updateRow(idx, { to: Math.min(durationSec, round1(e.target.value)) })}
                      />
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        checked={!!row.hasVoice}
                        onChange={(e) => updateRow(idx, { hasVoice: e.target.checked })}
                      />
                    </td>
                    <td>
                      <input
                        style={{ width: '100%' }}
                        value={row.hasVoice ? row.lyric || '' : '[Silent – ngậm môi lấy hơi]'}
                        disabled={!row.hasVoice}
                        onChange={(e) => updateRow(idx, { lyric: e.target.value })}
                        placeholder="Trọn cụm từ ở đoạn này…"
                      />
                    </td>
                    <td>
                      <input
                        style={{ width: '100%' }}
                        value={row.shot || ''}
                        onChange={(e) => updateRow(idx, { shot: e.target.value })}
                        placeholder="Hero medium shot / 3/4 orbit…"
                      />
                    </td>
                    <td>
                      <input
                        style={{ width: '100%' }}
                        value={row.action || ''}
                        onChange={(e) => updateRow(idx, { action: e.target.value })}
                        placeholder="Pose, mic & hand movement…"
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="small-btn danger"
                        disabled={timeline.length <= 1}
                        onClick={() => removePhraseRow(idx)}
                        title="Xoá cụm"
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {(options.customPrompt || timeline.length > 0) && (
        <label className="stack" style={{ gap: 4 }}>
          <b className="small">Prompt gửi Google Flow (Omni Flash {options.aspectRatio || '16:9'} · {options.duration || '10s'} · {options.lipSyncMode === 'mute' ? 'Mute trên Flow' : 'Nói khô không hát'})</b>
          <textarea
            rows={10}
            className="mono"
            value={options.customPrompt || ''}
            onChange={(e) => onChange({ customPrompt: e.target.value })}
          />
        </label>
      )}

      <AudioEditorModal
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        audios={audios}
        initialAudioId={audioId}
        defaultClipSec={durationSec}
        refresh={refresh}
        onCreated={(created) => {
          onChange({ audioId: created.id, audioStartSec: 0, timeline: null, customPrompt: '' });
          setStatusMsg(`✓ Đã tạo & chọn file nhạc mới: ${created.name} (${fmtDur(created.duration)})`);
        }}
      />
    </div>
  );
}
