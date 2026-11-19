// Khối "Đồ bộ" của tab Nữ khi chọn chuyển động đồ bộ (Chuyển động 5: rule.set): thay ô chọn nhiều ảnh trang phục bằng 2 ô riêng
// ÁO và QUẦN / VÁY (có nút chọn món dưới là quần hay váy), kèm khối "✂️ Đồ bộ 1 ảnh": chọn 1 ảnh có cả áo và quần / váy (mặt
// trước, mặt sau nếu có) rồi để AI tách thành ảnh áo + ảnh quần / váy riêng (job ảnh Flow, 0 credit), tách xong TỰ ĐIỀN vào 2 ô.
//
// Dữ liệu lưu trong inputs (nháp): setTop / setBottom = ảnh mặt trước của áo / quần-váy; setSource / setSourceBack = ảnh đồ bộ
// mặt trước / mặt sau; setSplit = { group, top, bottom } (nhóm tách đang theo dõi + ảnh đã tự điền). inputs[codedKey] luôn được
// ghi lại = [áo, quần / váy] (thứ tự server cần). Ảnh mặt sau của từng món do khối "Từng trang phục" bên dưới tự tìm (ảnh mặt
// sau tạo từ ảnh mặt trước đó), nên ảnh mặt sau AI tách / tạo ra không cần điền tay.
import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { AssetPicker, useAction } from '../components.jsx';

export const BOTTOM_LABELS = { pants: 'Quần', skirt: 'Váy' };
const isBack = (a) => a.isBackView || /Mặt sau Flow/.test(a.name || '');
const STATUS = { queued: '⏳ chờ', running: '⚙️ đang tạo', done: '✅ xong', failed: '❌ lỗi', cancelled: '⏹ đã huỷ' };

export default function SetPieces({ wfId, codedKey, inputs, setInputs, bottomType = 'pants', onBottomType, state, refresh }) {
  const { busy, error, run } = useAction();
  const has = (id) => !!id && state.assets.some((a) => a.id === id);
  const top = has(inputs.setTop) ? inputs.setTop : null;
  const bottom = has(inputs.setBottom) ? inputs.setBottom : null;
  const source = has(inputs.setSource) ? inputs.setSource : null;
  const sourceBack = has(inputs.setSourceBack) ? inputs.setSourceBack : null;
  const split = inputs.setSplit || null;
  const bt = BOTTOM_LABELS[bottomType] ? bottomType : 'pants';

  // Ghi 1 thay đổi vào nháp và dựng lại danh sách trang phục gửi server = [áo, quần / váy]
  const patch = (change) => setInputs((s) => {
    const next = { ...s, ...(typeof change === 'function' ? change(s) : change) };
    return { ...next, [codedKey]: [next.setTop, next.setBottom].filter(Boolean) };
  });

  // Mới chuyển sang chuyển động đồ bộ mà ô trang phục cũ đã có ảnh: ảnh 1 -> Áo, ảnh 2 -> Quần / Váy
  // (đã từng chọn ở 2 ô này thì 2 ô này là chuẩn: ghi lại danh sách trang phục theo chúng)
  useEffect(() => {
    if (inputs.setTop !== undefined || inputs.setBottom !== undefined) { patch({}); return; }
    const cur = (inputs[codedKey] || []).filter(has);
    patch({ setTop: cur[0] || null, setBottom: cur[1] || null });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Khối "Đồ bộ 1 ảnh" tự mở khi chưa có ảnh áo / quần-váy hoặc đang dùng dở; sau đó người dùng tự đóng / mở
  const [open, setOpen] = useState(() => !!inputs.setSource || !!inputs.setSplit?.group || (!inputs.setTop && !inputs.setBottom));

  // AI tách xong: tự điền ảnh mặt trước của áo / quần-váy (ảnh mới nhất của nhóm; mỗi ảnh chỉ điền 1 lần để không đè lựa chọn tay)
  const newest = (piece) => (split?.group ? state.assets.find((a) => a.split?.group === split.group && a.split.piece === piece && a.split.view === 'front') : null);
  const nt = newest('top');
  const nb = newest('bottom');
  useEffect(() => {
    if (!split?.group) return;
    const fillTop = nt && split.top !== nt.id;
    const fillBottom = nb && split.bottom !== nb.id;
    if (!fillTop && !fillBottom) return;
    patch((s) => ({
      setTop: fillTop ? nt.id : s.setTop,
      setBottom: fillBottom ? nb.id : s.setBottom,
      setSplit: { ...s.setSplit, top: nt?.id || s.setSplit?.top || null, bottom: nb?.id || s.setSplit?.bottom || null },
    }));
  }, [split?.group, nt?.id, nb?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const jobs = split?.group
    // state.jobs: mới nhất đứng đầu -> đảo lại để hiện theo thứ tự tạo (áo trước, quần / váy sau, rồi các ảnh mặt sau)
    ? (state.jobs || []).filter((j) => j.meta?.split?.group === split.group || j.meta?.splitGroup === split.group).reverse()
    : [];
  const working = jobs.some((j) => j.status === 'queued' || j.status === 'running');
  const start = () => run(async () => {
    const out = await api.splitSet(wfId, { setId: source, backId: sourceBack, bottomType: bt });
    patch({ setSplit: { group: out.group, top: null, bottom: null } });
    await refresh();
  });
  const hideBacks = (a) => isBack(a);

  return (
    <div className="stack set-pieces">
      <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <b className="small">👗 Đồ bộ: 1 ảnh ÁO + 1 ảnh {BOTTOM_LABELS[bt].toUpperCase()} của cùng 1 bộ (mặt trước; mặt sau chọn / tạo ở khối bên dưới)</b>
        <span className="row" style={{ gap: 6, alignItems: 'center' }}>
          <span className="small muted">Món dưới là:</span>
          {Object.entries(BOTTOM_LABELS).map(([v, l]) => (
            <button key={v} type="button" className={'small-btn' + (bt === v ? ' primary' : '')} onClick={() => onBottomType(v)} title={v === 'pants' ? 'Video: cầm cạp quần, bước chân vào rồi mặc' : 'Video: ướm váy lên eo rồi mặc'}>
              {l}
            </button>
          ))}
        </span>
      </div>
      <div className="grid2">
        <AssetPicker kind="product" label="ÁO – mặt trước *" assets={state.assets} value={top} onChange={(v) => patch({ setTop: v || null })} hide={hideBacks} refresh={refresh} state={state} storageKey="set_top" />
        <AssetPicker kind="product" label={`${BOTTOM_LABELS[bt].toUpperCase()} – mặt trước *`} assets={state.assets} value={bottom} onChange={(v) => patch({ setBottom: v || null })} hide={hideBacks} refresh={refresh} state={state} storageKey="set_bottom" />
      </div>

      <details className="set-split" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary className="small"><b>✂️ Chỉ có 1 ảnh ĐỒ BỘ (áo và {BOTTOM_LABELS[bt].toLowerCase()} chung 1 ảnh)?</b> Chọn ảnh rồi để AI tách thành ảnh áo + ảnh {BOTTOM_LABELS[bt].toLowerCase()} riêng, tách xong tự điền vào 2 ô trên (0 credit)</summary>
        <div className="grid2" style={{ marginTop: 8 }}>
          <AssetPicker kind="product" label="Ảnh ĐỒ BỘ – mặt trước" assets={state.assets} value={source} onChange={(v) => patch({ setSource: v || null })} hide={hideBacks} refresh={refresh} state={state} storageKey="set_source" />
          <AssetPicker kind="product" label="Ảnh ĐỒ BỘ – mặt sau (không bắt buộc)" assets={state.assets} value={sourceBack} onChange={(v) => patch({ setSourceBack: v || null })} refresh={refresh} state={state} storageKey="set_source_back" />
        </div>
        <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
          <button type="button" className="primary" disabled={busy || working || !source} onClick={start} title={source ? 'Tạo ảnh áo và ảnh quần / váy riêng trên Flow (ảnh, 0 credit)' : 'Chọn ảnh đồ bộ mặt trước trước'}>
            ✂️ AI tách áo + {BOTTOM_LABELS[bt].toLowerCase()}{split?.group ? ' (tách lại)' : ''}
          </button>
          <small className="muted">
            {sourceBack
              ? 'Có ảnh mặt sau: tách 4 ảnh (áo trước / sau, ' + BOTTOM_LABELS[bt].toLowerCase() + ' trước / sau).'
              : 'Không có ảnh mặt sau: tách 2 ảnh mặt trước, rồi AI tự tạo mặt sau cho từng món.'}
            {' '}Chọn đúng "Món dưới là" trước khi tách.
          </small>
        </div>
        {error && <div className="err">{error}</div>}
        {jobs.length > 0 && (
          <div className="stack" style={{ gap: 4, marginTop: 8 }}>
            {jobs.map((j) => (
              <div key={j.id} className="row small" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span>{STATUS[j.status] || j.status}</span>
                <span className="muted">{j.videoLabel}</span>
                {j.status === 'failed' && (
                  <>
                    <span className="warn-text">{String(j.error || '').slice(0, 140)}</span>
                    <a onClick={() => run(async () => { await api.retry(j.id); await refresh(); })}>Thử lại</a>
                  </>
                )}
              </div>
            ))}
            {!working && jobs.every((j) => j.status === 'done') && <small className="muted">Đã tách xong và điền vào 2 ô trên. Ảnh chưa ưng thì bấm "tách lại" hoặc chọn ảnh khác trong thư viện.</small>}
          </div>
        )}
      </details>
    </div>
  );
}
