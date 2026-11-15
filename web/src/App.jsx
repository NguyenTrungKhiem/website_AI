import React, { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import CutPage from './pages/CutPage.jsx';
import MergePage from './pages/MergePage.jsx';
import PublishPage from './pages/PublishPage.jsx';
import SettingsPage from './pages/SettingsPage.jsx';
import WorkflowPage from './pages/WorkflowPage.jsx';
import { MediaLightbox } from './components.jsx';

// Menu: các bước dùng chung (Cắt / Ghép / Đăng) + mỗi quy trình tự động 1 mục (lấy từ server).
// Các quy trình cùng nhóm tab (w.tab.group, vd. "không voice" Nữ / Nam) gom thành 1 mục; trong trang có nút đổi tab.
const groupKey = (g) => `wf_group_tab_${g}`;
function buildTabs(workflows = []) {
  const items = [];
  const groups = new Map();
  for (const w of workflows) {
    const g = w.tab?.group;
    if (g && groups.has(g)) { groups.get(g).members.push(w); continue; }
    const item = { id: 'wf:' + w.id, label: w.tab?.title || w.name, icon: w.icon, wf: w, group: null, wfGroup: g || null, members: [w] };
    if (g) groups.set(g, item);
    items.push(item);
  }
  return [
    { id: 'cut', label: 'Cắt video', icon: '✂️' },
    ...items,
    { id: 'merge', label: 'Ghép video', icon: '🎞️' },
    { id: 'publish', label: 'Đăng video', icon: '🚀' },
    { id: 'soon', group: 'Sắp có' },
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
  // Mục menu của quy trình đang mở (1 mục có thể gồm nhiều tab: Nữ / Nam) và quy trình đang mở
  const wfTab = tabs.find((t) => t.members?.some((m) => 'wf:' + m.id === tab));
  const curWf = wfTab?.members.find((m) => 'wf:' + m.id === tab);
  // Nhớ tab vừa mở của nhóm để lần sau bấm mục menu quay lại đúng tab đó
  useEffect(() => {
    if (!curWf?.tab?.group) return;
    try { localStorage.setItem(groupKey(curWf.tab.group), curWf.id); } catch {}
  }, [curWf?.id]);
  const openTab = (t) => {
    if (!t.wfGroup) return setTab(t.id);
    let last = null;
    try { last = localStorage.getItem(groupKey(t.wfGroup)); } catch {}
    setTab('wf:' + (t.members.find((m) => m.id === last) || t.members[0]).id);
  };

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
              className={'nav' + (tab === t.id || t === wfTab ? ' active' : '') + (t.sub ? ' sub' : '')}
              onClick={() => openTab(t)}
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
            {tab === 'cut' && <CutPage {...props} />}
            {curWf && <WorkflowPage key={curWf.id} {...props} wf={curWf} siblings={wfTab.members} />}
            {tab === 'merge' && <MergePage {...props} />}
            {tab === 'publish' && <PublishPage {...props} />}
            {tab === 'settings' && <SettingsPage {...props} />}
            {tab === 'suno' && <ComingSoon tab={tab} />}
          </>
        )}
      </main>
      {/* Bấm vào video / ảnh bất kỳ trong app -> phóng to (video tự phát) */}
      <MediaLightbox />
    </div>
  );
}

function ComingSoon({ tab }) {
  return (
    <section>
      <h1>Tạo nhạc với Suno</h1>
      <div className="card muted">Tính năng sẽ phát triển ở giai đoạn sau: tạo nhạc bằng Suno rồi ghép vào video.</div>
    </section>
  );
}
