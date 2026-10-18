import React, { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import CutPage from './pages/CutPage.jsx';
import MergePage from './pages/MergePage.jsx';
import PublishPage from './pages/PublishPage.jsx';
import SettingsPage from './pages/SettingsPage.jsx';
import WorkflowPage from './pages/WorkflowPage.jsx';

// Menu: các bước dùng chung (Cắt / Ghép / Đăng) + mỗi quy trình tự động 1 mục (lấy từ server)
function buildTabs(workflows = []) {
  return [
    { id: 'cut', label: 'Cắt video', icon: '✂️' },
    ...workflows.map((w) => ({ id: 'wf:' + w.id, label: w.name, icon: w.icon, wf: w })),
    { id: 'merge', label: 'Ghép video', icon: '🎞️' },
    { id: 'publish', label: 'Đăng video', icon: '🚀' },
    { id: 'soon', group: 'Sắp có' },
    { id: 'lipsync', label: 'Hát nhép', icon: '🎤', soon: true, sub: true },
    { id: 'suno', label: 'Nhạc Suno', icon: '🎵', soon: true, sub: true },
    { id: 'settings', label: 'Cài đặt', icon: '⚙️' },
  ];
}

export default function App() {
  // Trang cũ (motion / background) đã gộp vào AI Dancing
  const [tab, setTab] = useState(() => {
    const h = location.hash.slice(1);
    return !h || h === 'motion' || h === 'background' ? 'cut' : h;
  });
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  // Video được chọn để chuyển sang bước sau
  const [handoff, setHandoff] = useState({ merge: [], publish: [] });

  const refresh = useCallback(async () => {
    try {
      setState(await api.state());
      setError(null);
    } catch (e) {
      setError('Không kết nối được server: ' + e.message);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    location.hash = tab;
  }, [tab]);
  useEffect(() => {
    const onHash = () => setTab(location.hash.slice(1) || 'cut');
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);

  const go = (to, ids) => {
    if (ids) setHandoff((h) => ({ ...h, [to]: ids }));
    setTab(to);
  };

  const tabs = buildTabs(state?.workflows);
  const running = [...(state?.jobs || []), ...(state?.merges || [])].filter((j) => j.status === 'running' || j.status === 'queued').length;
  const props = { state, refresh, go, handoff };
  const wfTab = tabs.find((t) => t.id === tab && t.wf);

  return (
    <div className="layout">
      <nav className="sidebar">
        <div className="brand">🎬 Video Studio</div>
        {tabs.map((t) =>
          t.group ? (
            <div key={t.id} className="nav-group">{t.group}</div>
          ) : (
            <button
              key={t.id}
              className={'nav' + (tab === t.id ? ' active' : '') + (t.sub ? ' sub' : '')}
              onClick={() => setTab(t.id)}
            >
              <span>{t.icon}</span> {t.label}
              {t.soon && <span className="soon">sắp có</span>}
            </button>
          ),
        )}
        {running > 0 && <div className="running-pill">⏳ {running} video đang xử lý</div>}
      </nav>
      <main className="main">
        {error && <div className="alert">{error}</div>}
        {!state ? (
          <p className="muted">Đang tải…</p>
        ) : (
          <>
            {state.settings.engine === 'api' && !state.settings.geminiApiKey && tab !== 'settings' && (
              <div className="alert warn">
                Chưa có Gemini API key. <a onClick={() => setTab('settings')}>Vào Cài đặt</a> để nhập, hoặc chuyển sang Google Flow.
              </div>
            )}
            {tab === 'cut' && <CutPage {...props} />}
            {wfTab && <WorkflowPage key={wfTab.id} {...props} wf={wfTab.wf} />}
            {tab === 'merge' && <MergePage {...props} />}
            {tab === 'publish' && <PublishPage {...props} />}
            {tab === 'settings' && <SettingsPage {...props} />}
            {(tab === 'lipsync' || tab === 'suno') && <ComingSoon tab={tab} />}
          </>
        )}
      </main>
    </div>
  );
}

function ComingSoon({ tab }) {
  return (
    <section>
      <h1>{tab === 'lipsync' ? 'Video hát nhép' : 'Tạo nhạc với Suno'}</h1>
      <div className="card muted">
        {tab === 'lipsync'
          ? 'Tính năng sẽ phát triển ở giai đoạn sau: ghép audio + ảnh/video model để Omni Flash tạo khẩu hình hát nhép.'
          : 'Tính năng sẽ phát triển ở giai đoạn sau: tạo nhạc bằng Suno rồi ghép vào video.'}
      </div>
    </section>
  );
}
