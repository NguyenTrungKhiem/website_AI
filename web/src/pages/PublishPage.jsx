import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Badge, useAction } from '../components.jsx';

export const PLATFORMS = [
  { id: 'tiktok', label: 'TikTok', ok: (s) => !!s.tiktok.accessToken },
  { id: 'instagram', label: 'Instagram Reels', ok: (s) => !!(s.instagram.igUserId && s.instagram.accessToken) },
  { id: 'threads', label: 'Threads', ok: (s) => !!(s.threads.userId && s.threads.accessToken && s.publicBaseUrl) },
  { id: 'facebook', label: 'Facebook Page', ok: (s) => !!(s.facebook.pageId && s.facebook.pageToken) },
  { id: 'youtube', label: 'YouTube Shorts', ok: (s) => !!s.youtube.refreshToken },
];

export default function PublishPage({ state, refresh, go, handoff }) {
  // Video ghép hoàn chỉnh lên đầu, sau đó là từng video lẻ
  const merges = state.merges.filter((m) => m.status === 'done');
  const done = [
    ...merges.map((m) => ({ id: m.id, kind: 'merge', label: m.name, thumbUrl: m.thumbUrl, icon: '🎞️' })),
    ...state.jobs
      .filter((j) => j.status === 'done')
      .map((j) => ({ id: j.id, kind: 'job', label: j.videoLabel, thumbUrl: j.thumbUrl, icon: j.type === 'import' ? '📥' : j.type === 'background' ? '🏞️' : '🕺' })),
  ];
  const [videoIds, setVideoIds] = useState(handoff.publish);
  const [platforms, setPlatforms] = useState([]);
  const [title, setTitle] = useState('');
  const [caption, setCaption] = useState('');
  const { busy, error, run } = useAction();

  useEffect(() => setVideoIds(handoff.publish), [handoff.publish]);

  const toggle = (list, set, id) => set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const label = (p) => PLATFORMS.find((x) => x.id === p)?.label || p;

  const submit = () =>
    run(async () => {
      const isMerge = (id) => merges.some((m) => m.id === id);
      await api.post({
        jobIds: videoIds.filter((id) => !isMerge(id)),
        mergeIds: videoIds.filter(isMerge),
        platforms,
        title,
        caption,
      });
      await refresh();
    });

  return (
    <section>
      <h1>Đăng video</h1>
      <div className="card stack">
        <b>Chọn video ({videoIds.length})</b>
        {done.length === 0 ? (
          <p className="muted">Chưa có video nào hoàn thành.</p>
        ) : (
          <div className="thumbs">
            {done.map((v) => (
              <div key={v.id} className={'thumb wide' + (videoIds.includes(v.id) ? ' selected' : '')} onClick={() => toggle(videoIds, setVideoIds, v.id)} title={v.label}>
                <img src={v.thumbUrl} alt="" />
                <span className="cap">{v.icon} {v.label}</span>
              </div>
            ))}
          </div>
        )}

        <b>Nền tảng</b>
        <div className="row wrap">
          {PLATFORMS.map((p) => {
            const ok = p.ok(state.settings);
            return (
              <label key={p.id} className={'check pill' + (ok ? '' : ' off')} title={ok ? '' : 'Chưa cấu hình — vào Cài đặt'}>
                <input type="checkbox" disabled={!ok} checked={platforms.includes(p.id)} onChange={() => toggle(platforms, setPlatforms, p.id)} />
                {p.label} {!ok && <small>(chưa cấu hình)</small>}
              </label>
            );
          })}
        </div>
        {PLATFORMS.some((p) => !p.ok(state.settings)) && (
          <small className="muted">Nền tảng chưa cấu hình: <a onClick={() => go('settings')}>nhập token ở Cài đặt</a>.</small>
        )}

        <label>
          Tiêu đề (YouTube)
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} />
        </label>
        <label>
          Caption / mô tả + hashtag
          <textarea rows={4} value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="Mô tả sản phẩm… #review #shorts" />
        </label>
        <button className="primary" disabled={busy || !videoIds.length || !platforms.length} onClick={submit}>
          🚀 Đăng {videoIds.length} video × {platforms.length} nền tảng
        </button>
        {error && <div className="err">{error}</div>}
      </div>

      <h2>Lịch sử đăng</h2>
      {state.posts.length === 0 ? (
        <p className="muted">Chưa đăng video nào.</p>
      ) : (
        <table className="table">
          <thead>
            <tr><th>Thời gian</th><th>Video</th><th>Nền tảng</th><th>Trạng thái</th><th>Chi tiết</th></tr>
          </thead>
          <tbody>
            {state.posts.map((p) => (
              <tr key={p.id}>
                <td>{new Date(p.createdAt).toLocaleString('vi-VN')}</td>
                <td>{p.videoLabel}</td>
                <td>{label(p.platform)}</td>
                <td><Badge status={p.status} /></td>
                <td className="small">
                  {p.error && <span className="err">{p.error}</span>}
                  {p.result?.url ? <a href={p.result.url} target="_blank" rel="noreferrer">Mở</a> : p.result?.id}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
