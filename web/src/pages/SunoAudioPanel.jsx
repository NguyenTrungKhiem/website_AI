// Khối điều khiển chọn file MP3 Suno, chọn mốc 10s, mở Chrome Gemini đăng nhập lần đầu,
// phân tích thử từng giây qua Playwright Gemini Web ngầm và chỉnh nhanh bảng Timeline / Prompt Omni Flash.
import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { FileDrop, useAction } from '../components.jsx';
import AudioEditorModal from './AudioEditorModal.jsx';

const fmtDur = (sec) => {
  const n = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(n / 60);
  const s = n % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
};

const INTENSITY_OPTIONS = [
  { value: 'soft', label: 'Nhẹ' },
  { value: 'medium', label: 'Vừa' },
  { value: 'belting', label: 'Cao trào' },
  { value: 'whisper', label: 'Thì thầm' },
];

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
      setStatusMsg('Đã mở cửa sổ Chrome Gemini lên màn hình — đăng nhập tài khoản Google xong bạn có thể đóng cửa sổ đó lại (các lần chạy sau sẽ tự chạy ngầm hoàn toàn) rồi bấm Phân tích / Chạy.');
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
      setStatusMsg(`✓ Đã phân tích ${res.timeline.length} mốc giây bằng ${res.selectedModel || 'Gemini Web'}`);
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
      } else if (patch.hasVoice === true && merged.vocalIntensity === 'silent') {
        merged.vocalIntensity = 'medium';
      }
      return merged;
    });
    onChange({ timeline: next });
  };

  return (
    <div className="card stack">
      <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
        <b>2. File nhạc Suno (.mp3) &amp; Phân tích Gemini Web (chạy ngầm)</b>
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
            <label className="row gap-xs" style={{ alignItems: 'center' }} title="Dịch khớp âm ±500ms khi ghép MP3 Suno gốc vào video nếu cần chỉnh trễ/sớm">
              <span className="small muted">Dịch khớp (ms):</span>
              <input
                type="number"
                min="-500"
                max="500"
                step="50"
                style={{ width: 76 }}
                value={syncOffsetMs}
                onChange={(e) => onChange({ syncOffsetMs: Math.max(-500, Math.min(500, Number(e.target.value) || 0)) })}
              />
            </label>
          </div>
        </div>
      )}

      <label>
        <span className="small">Lời bài hát đoạn {durationSec}s (tuỳ chọn — dán từ Suno giúp Gemini bắt chính xác 100% từng từ)</span>
        <textarea
          rows={2}
          placeholder="VD: Đêm nay ánh đèn sân khấu sáng rực, anh vẫn đứng đây chờ em..."
          value={options.lyricsHint || ''}
          onChange={(e) => onChange({ lyricsHint: e.target.value })}
        />
      </label>

      <div className="row" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <button
          type="button"
          disabled={busy || !audioId}
          onClick={analyzePreview}
          title="Chạy Playwright ngầm vào Gemini Web (model Neon · Trung bình) để xem trước bảng kịch bản 10 giây trước khi tốn credit Flow"
        >
          {busy ? '⏳ Đang mở ngầm Gemini Web phân tích…' : '✨ Phân tích thử từng giây trước'}
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
          Bình thường Chrome Gemini tự chạy thu nhỏ dưới taskbar; chỉ bật lên nếu bạn chưa đăng nhập Google hoặc có lỗi.
        </small>
      </div>

      {statusMsg && <small className="ok">{statusMsg}</small>}
      {error && <div className="err">{error}</div>}

      {timeline.length > 0 && (
        <div className="stack" style={{ gap: 8 }}>
          <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
            <b className="small">Kịch bản nhép từng giây ({timeline.length} mốc)</b>
            <button
              type="button"
              className="small-btn"
              disabled={rebuilding}
              onClick={() => rebuildFromTimeline(timeline)}
            >
              {rebuilding ? 'Đang cập nhật…' : '↻ Cập nhật Prompt từ bảng này'}
            </button>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 84 }}>Giây</th>
                  <th style={{ width: 52 }}>Hát</th>
                  <th>Câu chữ nhép (Voice)</th>
                  <th style={{ width: 100 }}>Cường độ</th>
                  <th>Cử động cầm mic</th>
                </tr>
              </thead>
              <tbody>
                {timeline.map((row, idx) => (
                  <tr key={idx}>
                    <td className="mono small">{Number(row.from).toFixed(1)}–{Number(row.to).toFixed(1)}s</td>
                    <td>
                      <input
                        type="checkbox"
                        checked={!!row.hasVoice}
                        onChange={(e) => updateRow(idx, { hasVoice: e.target.checked })}
                      />
                    </td>
                    <td>
                      <input
                        value={row.hasVoice ? row.lyric || '' : '[Silent – nhạc dạo]'}
                        disabled={!row.hasVoice}
                        onChange={(e) => updateRow(idx, { lyric: e.target.value })}
                        placeholder="Ca từ vang lên ở giây này…"
                      />
                    </td>
                    <td>
                      <select
                        disabled={!row.hasVoice}
                        value={row.hasVoice ? row.vocalIntensity || 'medium' : 'silent'}
                        onChange={(e) => updateRow(idx, { vocalIntensity: e.target.value })}
                      >
                        {!row.hasVoice && <option value="silent">Im lặng</option>}
                        {INTENSITY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    </td>
                    <td>
                      <input
                        value={row.action || ''}
                        onChange={(e) => updateRow(idx, { action: e.target.value })}
                      />
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
          <b className="small">Prompt gửi Google Flow (Omni Flash {options.aspectRatio || '16:9'} · {options.duration || '10s'})</b>
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
