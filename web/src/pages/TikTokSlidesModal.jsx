// Hộp thoại Đăng / Lên lịch bài TikTok Photo Mode Carousel (mặc định 5 slide / bài) qua Zernio API.
// Cho phép chọn gửi vào Nháp TikTok (Draft — lên app chọn nhạc trend + gắn giỏ hàng Affiliate trong 5s)
// hoặc Đăng thẳng / Hẹn giờ rải đều tự động nhiều bài liên tiếp (tự gắn auto_add_music: true).
import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAction } from '../components.jsx';

function toLocalISO(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function defaultCaptionFor(pack, idx) {
  const codes = pack.flatMap((o) => (o.codes?.length ? o.codes : o.code ? [o.code] : []));
  const codeLine = codes.length ? `🏷️ Mã sản phẩm: ${codes.join(' · ')}\n` : '';
  return `${codeLine}✨ Lướt xem từng outfit trong bài ${idx + 1} nhé! #thoitrang #outfit #lookbook`;
}

export default function TikTokSlidesModal({ run: r, packs = [], state, refresh, onClose }) {
  const { busy, error, run, setError } = useAction();
  const [accounts, setAccounts] = useState([]);
  const [loadingAcc, setLoadingAcc] = useState(false);
  const [selectedAccIds, setSelectedAccIds] = useState([]);
  const [selectedPackIdx, setSelectedPackIdx] = useState(() => packs.filter((p) => p.length >= 2).map((_, i) => i));
  const [captions, setCaptions] = useState(() => Object.fromEntries(packs.map((p, i) => [i, defaultCaptionFor(p, i)])));
  const [titles, setTitles] = useState(() => Object.fromEntries(packs.map((p, i) => [i, `Lookbook Bài ${i + 1} (${p.length} outfit)`])));
  const [useCoded, setUseCoded] = useState(true);
  const [postMode, setPostMode] = useState('draft'); // 'draft' | 'direct'
  const [autoAddMusic, setAutoAddMusic] = useState(true);
  const [scheduleMode, setScheduleMode] = useState('now'); // 'now' | 'schedule'
  const [startAt, setStartAt] = useState(() => toLocalISO(new Date(Date.now() + 60 * 60 * 1000)));
  const [gapHours, setGapHours] = useState(4);
  const [doneCount, setDoneCount] = useState(null);

  const hasZernioKey = !!state.settings?.zernioApiKey?.trim();

  useEffect(() => {
    if (!hasZernioKey) return;
    setLoadingAcc(true);
    api.zernioAccounts()
      .then((res) => {
        const list = res.accounts || [];
        const tiktokFirst = list.filter((a) => String(a.platform || '').toLowerCase().includes('tiktok'));
        const shown = tiktokFirst.length ? tiktokFirst : list;
        setAccounts(shown);
        setSelectedAccIds(tiktokFirst.length ? tiktokFirst.map((a) => a._id || a.id || a.accountId) : []);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoadingAcc(false));
  }, [hasZernioKey]);

  const togglePack = (i) => {
    setSelectedPackIdx((cur) => (cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i].sort((a, b) => a - b)));
  };

  const toggleAcc = (id) => {
    setSelectedAccIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  };

  const submit = () =>
    run(async () => {
      if (!hasZernioKey) throw new Error('Chưa nhập Zernio API Key trong Cài đặt');
      const targetAccs = accounts.filter((a) => selectedAccIds.includes(a._id || a.id || a.accountId));
      if (!targetAccs.length) throw new Error('Chọn ít nhất 1 tài khoản Zernio');
      if (!selectedPackIdx.length) throw new Error('Chọn ít nhất 1 bài có từ 2 ảnh trở lên');

      let baseTime = null;
      if (scheduleMode === 'schedule') {
        const d = new Date(startAt);
        if (isNaN(d.getTime()) || d.getTime() <= Date.now() + 60_000) {
          throw new Error('Thời gian hẹn giờ đầu tiên phải cách hiện tại ít nhất 2 phút');
        }
        baseTime = d.getTime();
      }

      const posts = selectedPackIdx.map((pi, order) => {
        const pack = packs[pi];
        const scheduledFor = baseTime ? new Date(baseTime + order * Math.max(0, Number(gapHours) || 0) * 3600_000).toISOString() : null;
        return {
          outputKeys: pack.map((o) => o.key),
          caption: captions[pi] || '',
          title: titles[pi] || '',
          scheduledFor,
        };
      });

      const res = await api.publishTiktokSlides(r.id, {
        posts,
        useCoded,
        zernioAccounts: targetAccs.map((a) => ({
          platform: a.platform,
          accountId: a._id || a.id || a.accountId,
          username: a.username || a.name || '',
        })),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Ho_Chi_Minh',
        tiktokSettings: {
          draft: postMode === 'draft',
          autoAddMusic,
        },
      });
      setDoneCount(Array.isArray(res) ? res.length : posts.length);
      await refresh();
    });

  return (
    <div className="lightbox" onClick={onClose}>
      <div className="products-sheet" style={{ width: 'min(920px, 100%)' }} onClick={(e) => e.stopPropagation()}>
        <button type="button" className="lightbox-close" onClick={onClose} title="Đóng">×</button>
        <h2>🎞️ Đăng / Lên lịch TikTok Photo Mode (Slide ảnh)</h2>
        <small className="muted">
          Tự động chuyển sang JPG chuẩn TikTok và đăng dưới dạng bài trượt nhiều ảnh (<code>media_type: "photo"</code>).
          Mỗi bài cần từ 2–35 ảnh.
        </small>

        {!hasZernioKey && (
          <div className="alert warn small">
            Chưa có <b>Zernio API Key</b> trong Cài đặt. Bạn vẫn có thể dùng nút <b>📦 Tải ZIP</b> để tải về đăng thủ công.
          </div>
        )}

        <div className="card stack">
          <b>1. Tài khoản Zernio nhận bài</b>
          {loadingAcc ? <small className="muted">Đang tải danh sách tài khoản…</small> : accounts.length === 0 ? (
            <small className="muted">Chưa có tài khoản nào trên Zernio.</small>
          ) : (
            <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
              {accounts.map((a) => {
                const aid = a._id || a.id || a.accountId;
                const on = selectedAccIds.includes(aid);
                return (
                  <label key={aid} className={'check small mo-acc-pill' + (on ? ' on' : '')}>
                    <input type="checkbox" checked={on} onChange={() => toggleAcc(aid)} />
                    <span>{a.platform} · <b>{a.username || a.name || aid}</b></span>
                  </label>
                );
              })}
            </div>
          )}

          <div className="row" style={{ gap: 16, flexWrap: 'wrap', marginTop: 4 }}>
            <label className="check small">
              <input type="checkbox" checked={useCoded} onChange={(e) => setUseCoded(e.target.checked)} />
              Ưu tiên dùng ảnh <b>đã in mã sản phẩm</b> (thiếu thì dùng ảnh gốc)
            </label>
            <label className="check small">
              <input type="checkbox" checked={autoAddMusic} onChange={(e) => setAutoAddMusic(e.target.checked)} />
              🎵 Bật TikTok tự ghép nhạc xu hướng (<code>auto_add_music</code>)
            </label>
          </div>

          <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
            <label className="check small">
              <input type="radio" name="ttSlideMode" checked={postMode === 'draft'} onChange={() => setPostMode('draft')} />
              <b>📥 Gửi vào Nháp TikTok (Draft — khuyên dùng để tự chọn nhạc trend & ghim giỏ hàng)</b>
            </label>
            <label className="check small">
              <input type="radio" name="ttSlideMode" checked={postMode === 'direct'} onChange={() => setPostMode('direct')} />
              <b>🌐 Đăng công khai trực tiếp</b>
            </label>
          </div>

          <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
            <label className="check small">
              <input type="radio" name="ttSchedMode" checked={scheduleMode === 'now'} onChange={() => setScheduleMode('now')} />
              Gửi ngay bây giờ
            </label>
            <label className="check small">
              <input type="radio" name="ttSchedMode" checked={scheduleMode === 'schedule'} onChange={() => setScheduleMode('schedule')} />
              ⏰ Hẹn giờ rải đều
            </label>
            {scheduleMode === 'schedule' && (
              <>
                <input type="datetime-local" value={startAt} onChange={(e) => setStartAt(e.target.value)} />
                <label className="row small" style={{ gap: 6, alignItems: 'center' }}>
                  <span>Cách nhau:</span>
                  <input type="number" min={0} max={72} style={{ width: 64 }} value={gapHours} onChange={(e) => setGapHours(e.target.value)} />
                  <span>giờ/bài</span>
                </label>
              </>
            )}
          </div>
        </div>

        <div className="stack" style={{ gap: 8 }}>
          <b>2. Chọn bài & chỉnh Caption ({selectedPackIdx.length}/{packs.length} bài được chọn)</b>
          {packs.map((pack, i) => {
            const tooShort = pack.length < 2;
            const checked = !tooShort && selectedPackIdx.includes(i);
            return (
              <div key={i} className="card stack" style={{ padding: 10 }}>
                <div className="row between" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <label className="check">
                    <input type="checkbox" disabled={tooShort} checked={checked} onChange={() => togglePack(i)} />
                    <b>Bài {i + 1} ({pack.length} slide)</b>
                    {tooShort && <span className="warn-text">Cần ít nhất 2 ảnh để tạo TikTok Carousel</span>}
                  </label>
                  <div className="row gap-xs">
                    {pack.map((o, s) => (
                      <img key={o.key} className="mini-thumb" src={(useCoded && o.codedUrl) || o.outputUrl} alt="" title={`Slide ${s + 1}: ${o.code || o.label}`} />
                    ))}
                  </div>
                </div>
                {checked && (
                  <div className="stack" style={{ gap: 6 }}>
                    <input
                      value={titles[i] || ''}
                      onChange={(e) => setTitles((t) => ({ ...t, [i]: e.target.value }))}
                      placeholder="Tiêu đề tham khảo..."
                    />
                    <textarea
                      rows={2}
                      value={captions[i] || ''}
                      onChange={(e) => setCaptions((c) => ({ ...c, [i]: e.target.value }))}
                      placeholder="Caption + mã sản phẩm + hashtag TikTok..."
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {doneCount != null && (
          <div className="merge-note ok">
            ✓ Đã đưa {doneCount} bài TikTok Photo Carousel vào hàng đợi Zernio! Xem tiến trình chi tiết ở mục <b>Đăng video</b>.
          </div>
        )}
        {error && <div className="err">{error}</div>}

        <div className="row">
          <button type="button" className="primary" disabled={busy || !hasZernioKey || !selectedPackIdx.length} onClick={submit}>
            {busy ? '⏳ Đang gửi lên Zernio…' : scheduleMode === 'schedule' ? `⏰ Lên lịch ${selectedPackIdx.length} bài TikTok Slide` : `🚀 Gửi ${selectedPackIdx.length} bài TikTok Slide`}
          </button>
          <span className="grow" />
          <button type="button" onClick={onClose}>Đóng</button>
        </div>
      </div>
    </div>
  );
}
