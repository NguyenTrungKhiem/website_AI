import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAction } from '../components.jsx';

// Ô nhập gắn với 1 đường dẫn trong settings, vd. "youtube.clientId"
function Field({ s, set, path, label, type = 'text', hint, options }) {
  const keys = path.split('.');
  const value = keys.reduce((o, k) => o?.[k], s) ?? '';
  const onChange = (e) => {
    const v = type === 'number' ? Number(e.target.value) : e.target.value;
    set((prev) => {
      const next = structuredClone(prev);
      keys.slice(0, -1).reduce((o, k) => o[k], next)[keys.at(-1)] = v;
      return next;
    });
  };
  return (
    <label>
      {label}
      {options ? (
        <select value={value} onChange={onChange}>
          {options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : (
        <input type={type} value={value} onChange={onChange} autoComplete="off" />
      )}
      {hint && <small className="muted">{hint}</small>}
    </label>
  );
}

function FlowPanel() {
  const [st, setSt] = useState(null);
  const { busy, error, run } = useAction();
  const check = () => api.flowStatus().then(setSt).catch(() => setSt(null));
  useEffect(() => {
    check();
    const t = setInterval(check, 4000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="stack flow-panel">
      <div className="alert warn small">
        Tự động hoá Flow không được Google hỗ trợ chính thức và có thể vi phạm điều khoản sử dụng — tài khoản Google có nguy cơ bị hạn chế/khoá.
        Nên dùng 1 tài khoản Google riêng cho việc này. Web không giải CAPTCHA: nếu Google hỏi xác minh, hãy tự làm trong cửa sổ Chrome.
      </div>
      <div className="row">
        <button className="primary" disabled={busy} onClick={() => run(async () => { await api.flowLaunch(); await check(); })}>
          🌐 Mở Chrome & đăng nhập
        </button>
        <span>
          {!st ? '…' : !st.running ? '⚪ Chrome chưa mở' : !st.connected ? '🟠 Không kết nối được Chrome' : st.needsLogin ? '🟠 Đang chờ bạn đăng nhập' : st.flowOpen ? '🟢 Đã kết nối Flow' : '🟠 Chưa mở trang Flow'}
        </span>
      </div>
      <small className="muted">
        Chrome mở bằng hồ sơ riêng (data/flow-chrome), tách biệt với Chrome bạn đang dùng. Đăng nhập 1 lần, lần sau tự nhớ. Giữ cửa sổ đó mở khi đang tạo video.
      </small>
      {error && <div className="err">{error}</div>}
    </div>
  );
}

export default function SettingsPage({ state, refresh }) {
  const [s, set] = useState(state.settings);
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useAction();
  const f = { s, set };

  const saveAll = () =>
    run(async () => {
      await api.saveSettings(s);
      await refresh();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    });

  return (
    <section>
      <h1>Cài đặt</h1>
      <p className="muted small">Mọi thông tin lưu trong <code>data/db.json</code> trên máy của bạn.</p>

      <div className="card stack">
        <h2>Cách tạo video</h2>
        <div className="row wrap">
          <label className={'check pill' + (s.engine === 'api' ? ' on' : '')}>
            <input type="radio" checked={s.engine === 'api'} onChange={() => set({ ...s, engine: 'api' })} />
            Gemini API <small className="muted">(trả tiền theo giây, chạy song song)</small>
          </label>
          <label className={'check pill' + (s.engine === 'flow' ? ' on' : '')}>
            <input type="radio" checked={s.engine === 'flow'} onChange={() => set({ ...s, engine: 'flow' })} />
            Google Flow tự động <small className="muted">(dùng credit Flow, chạy lần lượt)</small>
          </label>
        </div>
        {s.engine === 'flow' && (
          <>
            <FlowPanel />
            <div className="grid3">
              <Field {...f} path="flowResolution" label="Độ phân giải trên Flow" options={['720p', '360p']} hint="Có video tham chiếu: 720p ≈ 20 credit, 360p ≈ 10 credit / video" />
              <Field {...f} path="flowProjectUrl" label="Dự án Flow dùng chung" hint="Để trống thì tự tạo dự án mới lần đầu" />
            </div>
            <label className="check">
              <input type="checkbox" checked={!!s.flowAutoAgree} onChange={(e) => set({ ...s, flowAutoAgree: e.target.checked })} />
              <span>
                <b>Tự bấm "I agree" ở hộp thoại "Rights to use this video" của Flow</b> mỗi lần tải video/ảnh lên.
                <br />
                <small className="muted">
                  Tick nghĩa là bạn cam kết với Google cho mọi lần tải lên: bạn có đủ quyền với nội dung (kể cả nội dung có trẻ vị thành niên),
                  không tạo nội dung vi phạm quyền người khác, lừa dối, quấy rối hay gây hại, và tuân thủ Google's Prohibited Use Policy.
                  Bỏ tick thì công cụ sẽ dừng lại chờ bạn tự bấm.
                </small>
              </span>
            </label>
          </>
        )}
      </div>

      <div className="card stack">
        <h2>Gemini Omni Flash</h2>
        <Field {...f} path="geminiApiKey" label="Gemini API key" type="password" hint="Lấy tại aistudio.google.com/apikey" />
        <div className="grid3">
          <Field {...f} path="model" label="Model" hint="Mặc định: gemini-omni-1.1-flash" />
          <Field {...f} path="aspectRatio" label="Tỉ lệ khung hình" options={['9:16', '16:9']} />
          <Field {...f} path="resolution" label="Độ phân giải" options={['360p', '720p', '1080p', '4k']} />
          <Field {...f} path="task" label="Task" options={['auto', 'edit', 'reference_to_video', 'image_to_video']} hint="auto = để model tự hiểu từ prompt (Google khuyên dùng)" />
          <Field {...f} path="concurrency" label="Số video xử lý song song" type="number" hint="Tăng nếu quota API cho phép" />
        </div>
      </div>

      <div className="card stack">
        <h2>Mạng xã hội</h2>
        <p className="muted small">Mỗi nền tảng cần tạo app developer và cấp quyền đăng video. Hướng dẫn chi tiết trong README.md.</p>
        <h3>TikTok</h3>
        <div className="grid3">
          <Field {...f} path="tiktok.accessToken" label="Access token" type="password" hint="Scope video.publish" />
          <Field {...f} path="tiktok.privacy" label="Quyền riêng tư" options={['SELF_ONLY', 'PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR']} hint="App chưa được TikTok duyệt chỉ đăng được SELF_ONLY" />
        </div>
        <h3>Instagram</h3>
        <div className="grid3">
          <Field {...f} path="instagram.igUserId" label="IG User ID" />
          <Field {...f} path="instagram.accessToken" label="Access token" type="password" />
        </div>
        <h3>Threads</h3>
        <div className="grid3">
          <Field {...f} path="threads.userId" label="Threads User ID" />
          <Field {...f} path="threads.accessToken" label="Access token" type="password" />
          <Field {...f} path="publicBaseUrl" label="URL public của server" hint="Threads tải video qua URL, vd. https://xxx.trycloudflare.com" />
        </div>
        <h3>Facebook Page</h3>
        <div className="grid3">
          <Field {...f} path="facebook.pageId" label="Page ID" />
          <Field {...f} path="facebook.pageToken" label="Page access token" type="password" />
        </div>
        <h3>YouTube</h3>
        <div className="grid3">
          <Field {...f} path="youtube.clientId" label="OAuth Client ID" />
          <Field {...f} path="youtube.clientSecret" label="Client secret" type="password" />
          <Field {...f} path="youtube.refreshToken" label="Refresh token" type="password" />
          <Field {...f} path="youtube.privacy" label="Quyền riêng tư" options={['private', 'unlisted', 'public']} />
        </div>
      </div>

      <div className="row sticky-save">
        <button className="primary" disabled={busy} onClick={saveAll}>💾 Lưu cài đặt</button>
        {saved && <span className="ok">Đã lưu</span>}
        {error && <span className="err">{error}</span>}
      </div>
    </section>
  );
}
