import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Badge, useAction } from '../components.jsx';

export const PLATFORMS = [
  { id: 'tiktok', label: 'TikTok', ok: (s) => !!s.tiktok?.accessToken },
  { id: 'instagram', label: 'Instagram Reels', ok: (s) => !!(s.instagram?.igUserId && s.instagram?.accessToken) },
  { id: 'threads', label: 'Threads', ok: (s) => !!(s.threads?.userId && s.threads?.accessToken && s.publicBaseUrl) },
  { id: 'facebook', label: 'Facebook Page', ok: (s) => !!(s.facebook?.pageId && s.facebook?.pageToken) },
  { id: 'youtube', label: 'YouTube Shorts', ok: (s) => !!s.youtube?.refreshToken },
];

function toLocalISOString(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function getDefaultScheduleTime() {
  const d = new Date(Date.now() + 60 * 60 * 1000); // Mặc định 1 tiếng sau
  return toLocalISOString(d);
}

function getPlatformIcon(platform = '') {
  const p = platform.toLowerCase();
  if (p.includes('tiktok')) return '🎵';
  if (p.includes('instagram')) return '📸';
  if (p.includes('youtube')) return '▶️';
  if (p.includes('facebook')) return '📘';
  if (p.includes('threads')) return '🧵';
  if (p.includes('twitter') || p === 'x') return '🐦';
  if (p.includes('linkedin')) return '💼';
  return '🌐';
}

export default function PublishPage({ state, refresh, go, handoff }) {
  const merges = state.merges.filter((m) => m.status === 'done');
  const done = [
    ...merges.map((m) => ({ id: m.id, kind: 'merge', label: m.name, thumbUrl: m.thumbUrl, icon: '🎞️', watermarkRemoved: m.watermarkRemoved })),
    ...state.jobs
      .filter((j) => j.status === 'done')
      .map((j) => ({ id: j.id, kind: 'job', label: j.videoLabel, thumbUrl: j.thumbUrl, icon: j.type === 'import' ? '📥' : j.type === 'background' ? '🏞️' : '🕺' })),
  ];

  const hasZernioKey = !!state.settings.zernioApiKey?.trim();
  const [provider, setProvider] = useState(hasZernioKey ? 'zernio' : 'direct');
  const [videoIds, setVideoIds] = useState(handoff.publish);
  const [platforms, setPlatforms] = useState([]);
  const [title, setTitle] = useState('');
  const [caption, setCaption] = useState('');

  // Zernio state
  const [zernioLoading, setZernioLoading] = useState(false);
  const [zernioAccounts, setZernioAccounts] = useState([]);
  const [zernioError, setZernioError] = useState(null);
  const [selectedZernioAccountIds, setSelectedZernioAccountIds] = useState([]);
  const [publishMode, setPublishMode] = useState('schedule'); // 'schedule' | 'now'
  const [scheduleTime, setScheduleTime] = useState(getDefaultScheduleTime());
  const [syncing, setSyncing] = useState(false);

  const { busy, error, run } = useAction();

  useEffect(() => setVideoIds(handoff.publish), [handoff.publish]);

  // Tự động load danh sách tài khoản Zernio khi có API key
  useEffect(() => {
    if (state.settings.zernioApiKey?.trim()) {
      setZernioLoading(true);
      setZernioError(null);
      api.zernioAccounts()
        .then((res) => {
          const accs = res.accounts || [];
          setZernioAccounts(accs);
          setSelectedZernioAccountIds(accs.map((a) => a._id || a.id || a.accountId));
        })
        .catch((e) => setZernioError(e.message))
        .finally(() => setZernioLoading(false));
    }
  }, [state.settings.zernioApiKey]);

  const toggle = (list, set, id) => set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const toggleAllZernio = () => {
    if (selectedZernioAccountIds.length === zernioAccounts.length) {
      setSelectedZernioAccountIds([]);
    } else {
      setSelectedZernioAccountIds(zernioAccounts.map((a) => a._id || a.id || a.accountId));
    }
  };

  const label = (p) => PLATFORMS.find((x) => x.id === p)?.label || p;

  const quickSetSchedule = (hoursAhead) => {
    const d = new Date(Date.now() + hoursAhead * 60 * 60 * 1000);
    setScheduleTime(toLocalISOString(d));
  };

  const quickSetSpecificTime = (targetHour) => {
    const d = new Date();
    d.setHours(targetHour, 0, 0, 0);
    if (d.getTime() <= Date.now()) {
      d.setDate(d.getDate() + 1);
    }
    setScheduleTime(toLocalISOString(d));
  };

  const submit = () =>
    run(async () => {
      const isMerge = (id) => merges.some((m) => m.id === id);
      const selectedJobs = videoIds.filter((id) => !isMerge(id));
      const selectedMerges = videoIds.filter(isMerge);

      if (provider === 'zernio') {
        const targetAccounts = zernioAccounts.filter((a) =>
          selectedZernioAccountIds.includes(a._id || a.id || a.accountId)
        );
        if (!targetAccounts.length) throw new Error('Vui lòng chọn ít nhất 1 tài khoản mạng xã hội Zernio');

        let scheduledFor = null;
        if (publishMode === 'schedule') {
          if (!scheduleTime) throw new Error('Vui lòng chọn thời gian hẹn giờ đăng');
          const targetDate = new Date(scheduleTime);
          if (isNaN(targetDate.getTime())) throw new Error('Thời gian hẹn giờ không hợp lệ');
          if (targetDate.getTime() <= Date.now() + 60 * 1000) {
            throw new Error('Thời gian hẹn giờ phải cách hiện tại ít nhất 1-2 phút');
          }
          scheduledFor = targetDate.toISOString();
        }

        await api.post({
          jobIds: selectedJobs,
          mergeIds: selectedMerges,
          useZernio: true,
          zernioAccounts: targetAccounts.map((a) => ({
            platform: a.platform,
            accountId: a._id || a.id || a.accountId,
            username: a.username || a.name || '',
            name: a.name || a.username || '',
          })),
          scheduledFor,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Ho_Chi_Minh',
          title,
          caption,
        });
      } else {
        await api.post({
          jobIds: selectedJobs,
          mergeIds: selectedMerges,
          platforms,
          title,
          caption,
        });
      }
      await refresh();
    });

  const syncPosts = async () => {
    setSyncing(true);
    try {
      await api.syncZernioPosts();
      await refresh();
    } catch (e) {
      alert('Đồng bộ thất bại: ' + e.message);
    } finally {
      setSyncing(false);
    }
  };

  const canSubmit =
    !busy &&
    videoIds.length > 0 &&
    (provider === 'zernio' ? selectedZernioAccountIds.length > 0 : platforms.length > 0);

  return (
    <section>
      <h1>Đăng & Lên lịch video</h1>

      <div className="card stack">
        {/* Chọn chế độ đăng */}
        <div className="row between">
          <b>Phương thức đăng</b>
          <div className="tabs">
            <button
              type="button"
              className={provider === 'zernio' ? 'on' : ''}
              onClick={() => setProvider('zernio')}
            >
              ⚡ Zernio API {hasZernioKey ? '🟢' : '⚪ (Chưa nhập key)'}
            </button>
            <button
              type="button"
              className={provider === 'direct' ? 'on' : ''}
              onClick={() => setProvider('direct')}
            >
              🔑 Token trực tiếp (Cũ)
            </button>
          </div>
        </div>

        {/* Cảnh báo chưa có Zernio API Key */}
        {provider === 'zernio' && !hasZernioKey && (
          <div className="alert warn small">
            Bạn chưa cài đặt Zernio API Key. Vui lòng vào{' '}
            <a onClick={() => go('settings')}>Cài đặt</a> để nhập API Key và kết nối các tài khoản mạng xã hội.
          </div>
        )}

        {/* Chọn video */}
        <b>Chọn video ({videoIds.length})</b>
        {done.length === 0 ? (
          <p className="muted">Chưa có video nào hoàn thành.</p>
        ) : (
          <div className="thumbs">
            {done.map((v) => (
              <div
                key={v.id}
                className={'thumb wide' + (videoIds.includes(v.id) ? ' selected' : '')}
                onClick={() => toggle(videoIds, setVideoIds, v.id)}
                title={v.label}
              >
                <img src={v.thumbUrl} alt="" />
                <span className="cap">{v.icon} {v.label}{v.watermarkRemoved ? ' ✨' : ''}</span>
              </div>
            ))}
          </div>
        )}

        {/* Chọn nền tảng */}
        {provider === 'zernio' ? (
          <div className="stack" style={{ gap: 8 }}>
            <div className="row between">
              <b>Kênh đăng Zernio ({selectedZernioAccountIds.length}/{zernioAccounts.length})</b>
              {zernioAccounts.length > 0 && (
                <button type="button" className="link small" onClick={toggleAllZernio}>
                  {selectedZernioAccountIds.length === zernioAccounts.length ? 'Bỏ chọn tất cả' : 'Chọn tất cả'}
                </button>
              )}
            </div>

            {zernioLoading ? (
              <p className="muted small">⏳ Đang tải danh sách tài khoản Zernio…</p>
            ) : zernioError ? (
              <div className="err small">
                Không thể tải danh sách tài khoản Zernio: {zernioError}. Vui lòng kiểm tra lại Key trong{' '}
                <a onClick={() => go('settings')}>Cài đặt</a>.
              </div>
            ) : zernioAccounts.length === 0 ? (
              <p className="muted small">
                Chưa có tài khoản nào được kết nối trong Zernio. Hãy truy cập <b>zernio.com</b> để liên kết TikTok, Instagram, YouTube, Facebook...
              </p>
            ) : (
              <div className="row wrap">
                {zernioAccounts.map((acc) => {
                  const accId = acc._id || acc.id || acc.accountId;
                  const isChecked = selectedZernioAccountIds.includes(accId);
                  return (
                    <label
                      key={accId}
                      className={'check pill' + (isChecked ? ' on' : '')}
                      style={{ cursor: 'pointer' }}
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggle(selectedZernioAccountIds, setSelectedZernioAccountIds, accId)}
                      />
                      <span>
                        {getPlatformIcon(acc.platform)} <b>{acc.platform.toUpperCase()}</b> ({acc.name || acc.username || accId})
                      </span>
                    </label>
                  );
                })}
              </div>
            )}

            {/* Chọn lịch đăng */}
            <div className="card stack" style={{ margin: '8px 0 0', background: 'var(--panel2)' }}>
              <b>⏰ Thời điểm đăng</b>
              <div className="row" style={{ gap: 16 }}>
                <label className="check" style={{ cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="publishMode"
                    checked={publishMode === 'schedule'}
                    onChange={() => setPublishMode('schedule')}
                  />
                  <span><b>Hẹn giờ đăng tự động (Lên lịch)</b></span>
                </label>
                <label className="check" style={{ cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="publishMode"
                    checked={publishMode === 'now'}
                    onChange={() => setPublishMode('now')}
                  />
                  <span><b>Đăng ngay lập tức</b></span>
                </label>
              </div>

              {publishMode === 'schedule' && (
                <div className="stack" style={{ gap: 10, marginTop: 4 }}>
                  <div className="row wrap" style={{ alignItems: 'flex-end', gap: 12 }}>
                    <label style={{ minWidth: 260 }}>
                      Thời gian đăng (Giờ Việt Nam)
                      <input
                        type="datetime-local"
                        value={scheduleTime}
                        onChange={(e) => setScheduleTime(e.target.value)}
                        min={toLocalISOString(new Date())}
                      />
                    </label>
                    <div className="row wrap" style={{ gap: 6 }}>
                      <span className="muted small">Gợi ý nhanh:</span>
                      <button type="button" className="quick-time-btn" onClick={() => quickSetSchedule(1)}>+1 giờ</button>
                      <button type="button" className="quick-time-btn" onClick={() => quickSetSchedule(3)}>+3 giờ</button>
                      <button type="button" className="quick-time-btn" onClick={() => quickSetSpecificTime(20)}>8h tối nay</button>
                      <button type="button" className="quick-time-btn" onClick={() => quickSetSpecificTime(9)}>9h sáng mai</button>
                    </div>
                  </div>
                  <div className="alert ok small" style={{ margin: 0 }}>
                    💡 <b>Tự động đăng khi đến giờ:</b> Video sẽ được tải lên và lên lịch trên đám mây Zernio. Đến đúng thời điểm đã hẹn, Zernio sẽ tự động đăng lên mạng xã hội. <b>Bạn có thể tắt máy tính mà không bị ảnh hưởng!</b>
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="stack" style={{ gap: 8 }}>
            <b>Nền tảng trực tiếp</b>
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
          </div>
        )}

        <label>
          Tiêu đề (YouTube Shorts / Tham khảo)
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} placeholder="Tiêu đề video..." />
        </label>
        <label>
          Caption / mô tả + hashtag
          <textarea rows={4} value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="Mô tả sản phẩm… #review #shorts" />
        </label>

        <button className="primary" disabled={!canSubmit} onClick={submit}>
          {provider === 'zernio' && publishMode === 'schedule'
            ? `⏰ Lên lịch hẹn giờ (${videoIds.length} video × ${selectedZernioAccountIds.length} tài khoản)`
            : `🚀 Đăng ngay (${videoIds.length} video × ${provider === 'zernio' ? selectedZernioAccountIds.length : platforms.length} nền tảng)`}
        </button>
        {error && <div className="err">{error}</div>}
      </div>

      <div className="row between" style={{ marginTop: 24 }}>
        <h2>Lịch sử đăng & Bài đã lên lịch</h2>
        {state.posts.some((p) => p.status === 'scheduled') && (
          <button type="button" disabled={syncing} onClick={syncPosts}>
            {syncing ? '⏳ Đang đồng bộ…' : '🔄 Đồng bộ trạng thái Zernio'}
          </button>
        )}
      </div>

      {state.posts.length === 0 ? (
        <p className="muted">Chưa có bài đăng nào.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Thời gian</th>
              <th>Video</th>
              <th>Nền tảng / Tài khoản</th>
              <th>Phương thức</th>
              <th>Trạng thái</th>
              <th>Chi tiết</th>
            </tr>
          </thead>
          <tbody>
            {state.posts.map((p) => {
              const isScheduled = p.status === 'scheduled';
              const targetTime = isScheduled && p.scheduledFor ? new Date(p.scheduledFor).toLocaleString('vi-VN') : null;
              return (
                <tr key={p.id}>
                  <td>
                    {isScheduled ? (
                      <div>
                        <b style={{ color: '#cb92f9' }}>⏰ Hẹn: {targetTime}</b>
                        <div className="muted small">Tạo lúc: {new Date(p.createdAt).toLocaleTimeString('vi-VN')}</div>
                      </div>
                    ) : (
                      new Date(p.createdAt).toLocaleString('vi-VN')
                    )}
                  </td>
                  <td>{p.videoLabel}</td>
                  <td>{p.platform}</td>
                  <td>
                    {p.provider === 'zernio' ? (
                      <span className="badge blue">Zernio</span>
                    ) : (
                      <span className="badge gray">Direct</span>
                    )}
                  </td>
                  <td><Badge status={p.status} /></td>
                  <td className="small">
                    {isScheduled && <span className="muted">Đang đợi Zernio phát hành tự động</span>}
                    {p.error && <span className="err">{p.error}</span>}
                    {p.result?.url ? (
                      <a href={p.result.url} target="_blank" rel="noreferrer">🔗 Mở bài viết</a>
                    ) : (
                      p.zernioPostId && <span className="muted">ID: {p.zernioPostId}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
