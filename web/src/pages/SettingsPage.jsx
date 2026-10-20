import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAction, AssetPicker } from '../components.jsx';

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
  const [zernioStatus, setZernioStatus] = useState(null);
  const [zernioTesting, setZernioTesting] = useState(false);
  const { busy, error, run } = useAction();
  const f = { s, set };

  const checkZernio = async () => {
    if (!s.zernioApiKey?.trim()) {
      setZernioStatus({ error: 'Vui lòng nhập Zernio API Key trước' });
      return;
    }
    setZernioTesting(true);
    setZernioStatus(null);
    try {
      const res = await api.zernioAccounts(s.zernioApiKey.trim());
      setZernioStatus({ accounts: res.accounts || [] });
    } catch (e) {
      setZernioStatus({ error: e.message });
    } finally {
      setZernioTesting(false);
    }
  };

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
        <h2>Google Flow tự động</h2>
        <p className="muted small">Tạo video/ảnh bằng credit Flow, chạy lần lượt từng video trong 1 cửa sổ Chrome riêng.</p>
        <FlowPanel />
        <div className="grid3">
          <Field {...f} path="flowResolution" label="Độ phân giải trên Flow" options={['720p', '360p']} hint="Có video tham chiếu: 720p ≈ 20 credit, 360p ≈ 10 credit / video" />
          <Field {...f} path="aspectRatio" label="Tỉ lệ khung hình" options={['9:16', '16:9']} />
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
      </div>

      <div className="card stack">
        <h2>Xử lý Logo Gemini & Cấu hình Logo riêng</h2>
        <p className="muted small">
          Google Flow tự động gắn logo ngôi sao ở góc dưới bên phải video. Bạn có thể chọn cách xử lý mặc định: dùng thuật toán nội suy xoá logo (Delogo) hoặc đè Logo riêng (Brand Badge) để che hoàn toàn logo mà không bị biến dạng chuyển động (rất hữu ích cho video nhảy / dancing).
        </p>

        <div className="stack" style={{ background: 'var(--panel2)', padding: 12, borderRadius: 8 }}>
          <b>Chế độ mặc định khi ghép video:</b>
          <label className="check">
            <input
              type="radio"
              name="watermarkMode"
              checked={s.watermarkMode === 'delogo' || (!s.watermarkMode && s.removeWatermark !== false)}
              onChange={() => set({ ...s, watermarkMode: 'delogo', removeWatermark: true })}
            />
            <span>
              <b>Nội suy delogo (Mặc định)</b> — Dùng thuật toán nội suy các pixel viền xung quanh để xoá mờ logo Gemini. Phù hợp video ít chuyển động ở góc dưới phải.
            </span>
          </label>
          <label className="check">
            <input
              type="radio"
              name="watermarkMode"
              checked={s.watermarkMode === 'brand'}
              onChange={() => set({ ...s, watermarkMode: 'brand', removeWatermark: true })}
            />
            <span>
              <b>Đè Logo thương hiệu riêng (Khuyên dùng cho video nhảy/dancing)</b> — Đè chữ handle kênh hoặc ảnh logo riêng lên đúng vị trí góc dưới phải để che kín ngôi sao Gemini, không bao giờ bị vệt mờ khi cơ thể/váy áo lướt qua.
            </span>
          </label>
          <label className="check">
            <input
              type="radio"
              name="watermarkMode"
              checked={s.watermarkMode === 'off' || s.removeWatermark === false}
              onChange={() => set({ ...s, watermarkMode: 'off', removeWatermark: false })}
            />
            <span>
              <b>Không xử lý</b> — Giữ nguyên logo gốc của Flow/Gemini.
            </span>
          </label>
        </div>

        <div className="stack">
          <h3>Cấu hình Logo riêng của bạn</h3>
          <div className="row" style={{ gap: 20 }}>
            <label className="check">
              <input
                type="radio"
                name="watermarkType"
                checked={s.watermarkType !== 'image'}
                onChange={() => set({ ...s, watermarkType: 'text' })}
              />
              <span>Dạng chữ (Tên kênh / Handle, vd: @bubine1601)</span>
            </label>
            <label className="check">
              <input
                type="radio"
                name="watermarkType"
                checked={s.watermarkType === 'image'}
                onChange={() => set({ ...s, watermarkType: 'image' })}
              />
              <span>Dạng hình ảnh (Logo PNG/JPG từ máy)</span>
            </label>
          </div>

          {s.watermarkType !== 'image' ? (
            <div className="grid2" style={{ alignItems: 'center' }}>
              <div className="stack">
                <Field
                  {...f}
                  path="watermarkText"
                  label="Chữ / Tên kênh / Handle hiển thị"
                  hint="Ví dụ: @bubine1601 hoặc Tên Shop của bạn. Sẽ hiển thị trong khung bo tròn đen mờ chuyên nghiệp."
                />
                <Field
                  {...f}
                  path="watermarkFontSize"
                  label="Cỡ chữ (px)"
                  type="number"
                  hint="Mặc định: 20px (Khuyến nghị 16 - 24 cho video dọc 720x1280)"
                />
              </div>

              <div className="stack" style={{ alignItems: 'center' }}>
                <small className="muted">Xem trước góc dưới video (tỉ lệ 9:16):</small>
                <div
                  style={{
                    position: 'relative',
                    width: 220,
                    height: 140,
                    background: 'linear-gradient(135deg, #2b3240, #14171d)',
                    borderRadius: 10,
                    border: '1px solid var(--line)',
                    overflow: 'hidden',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <span style={{ color: '#4d5566', fontSize: 11, userSelect: 'none' }}>Khung hình video</span>
                  <div
                    style={{
                      position: 'absolute',
                      right: 12,
                      bottom: 12,
                      background: 'rgba(0, 0, 0, 0.55)',
                      color: '#ffffff',
                      fontSize: `${Math.max(12, Math.min(24, (s.watermarkFontSize || 20) * 0.7))}px`,
                      fontWeight: 600,
                      padding: '4px 10px',
                      borderRadius: 6,
                      boxShadow: '0 2px 6px rgba(0,0,0,0.4)',
                      letterSpacing: '0.5px',
                    }}
                  >
                    {s.watermarkText?.trim() || '@kenh_cua_ban'}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="stack">
              <AssetPicker
                kind="logo"
                label="Chọn hoặc tải lên ảnh Logo thương hiệu (PNG không nền / JPG)"
                assets={state.assets || []}
                value={s.watermarkImageId}
                onChange={(id) => set({ ...s, watermarkImageId: id || '' })}
                refresh={refresh}
                state={state}
              />
              <small className="muted">
                Logo ảnh sẽ được tự động thu nhỏ vừa vặn (~64-80px) và đặt chính xác đè lên ngôi sao Gemini ở góc dưới phải.
              </small>
            </div>
          )}
        </div>
      </div>

      <div className="card stack">
        <h2>Gemini AI (Chuẩn hoá dữ liệu sàn TMĐT)</h2>
        <p className="muted small">
          Dùng AI để tự động làm sạch từ rác (Chính hãng, Freeship, Sale...), trích xuất 2-3 tính năng nổi bật cho kịch bản video và chuẩn hóa giá VND từ link Shopee, Lazada, TikTok Shop.
        </p>
        <div className="grid2">
          <Field {...f} path="geminiApiKey" label="Gemini API Key" type="password" hint="Lấy API key miễn phí tại Google AI Studio (aistudio.google.com). Để trống sẽ dùng bộ lọc Regex thông minh." />
          <Field {...f} path="geminiModel" label="Model Gemini" options={['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro']} hint="Nên dùng gemini-2.5-flash để tốc độ phản hồi nhanh nhất" />
        </div>
      </div>

      <div className="card stack">
        <div className="row between">
          <div>
            <h2>Zernio API (Tự động & Lên lịch đăng đa nền tảng)</h2>
            <p className="muted small">
              Kết nối một API duy nhất để đăng và <b>hẹn giờ tự động</b> lên TikTok, Instagram, Facebook, YouTube, Threads... (Zernio tự đăng vào đúng giờ hẹn trên cloud, không cần máy tính mở).
            </p>
          </div>
          {s.zernioApiKey && (
            <button
              type="button"
              disabled={busy || zernioTesting}
              onClick={checkZernio}
            >
              {zernioTesting ? '⏳ Đang kiểm tra…' : '🔄 Kiểm tra kết nối'}
            </button>
          )}
        </div>
        <div className="grid2">
          <Field
            {...f}
            path="zernioApiKey"
            label="Zernio API Key"
            type="password"
            hint="Lấy API key tại zernio.com -> Dashboard -> API Keys."
          />
        </div>

        {zernioStatus && (
          <div className={`alert ${zernioStatus.error ? '' : 'ok'} small`} style={{ margin: 0 }}>
            {zernioStatus.error ? (
              <span>❌ Kết nối thất bại: {zernioStatus.error}</span>
            ) : (
              <div className="stack" style={{ gap: 6 }}>
                <span>✅ Kết nối Zernio thành công!</span>
                {zernioStatus.accounts?.length > 0 ? (
                  <div>
                    <span className="muted">Tài khoản đã liên kết ({zernioStatus.accounts.length}):</span>
                    <div className="row wrap" style={{ marginTop: 4, gap: 6 }}>
                      {zernioStatus.accounts.map((acc) => (
                        <span key={acc._id || acc.id} className="badge blue">
                          {acc.platform.toUpperCase()}: {acc.name || acc.username || acc._id}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : (
                  <span className="muted">
                    Chưa có tài khoản mạng xã hội nào được liên kết trong Zernio. Hãy vào trang <b>zernio.com</b> để liên kết các kênh của bạn (TikTok, YouTube, Facebook, v.v.).
                  </span>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="card stack">
        <h2>Mạng xã hội (Trực tiếp qua Token cá nhân)</h2>
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
