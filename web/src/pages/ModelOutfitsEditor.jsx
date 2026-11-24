// Bộ tạo danh sách Bộ trang phục cho quy trình "Ảnh model mặc đồ" (Nữ & Nam).
// - Nữ: Váy/Đầm, Áo, Quần, Đồ bộ (1 ảnh áo+váy hoặc áo+quần), Áo khoác (tuỳ chọn), Túi xách (tuỳ chọn — bỏ trống AI tự phối).
//   Luật khoá chéo: chọn Váy -> khoá Quần & Đồ bộ (cho phối Áo + Váy cho set chân váy); chọn Quần -> khoá Váy & Đồ bộ;
//   chọn Đồ bộ -> khoá Áo, Quần, Váy. Giày dép luôn AI tự phối hợp bộ.
// - Nam: Áo, Quần, Đồ bộ (1 ảnh áo+quần), Áo khoác (tuỳ chọn). Khoá chéo Đồ bộ <-> Áo & Quần. Giày dép luôn AI tự phối.
// - Nhập thiếu món nào -> AI tự phối phần còn thiếu (KHÔNG tự thêm áo khoác trừ khi bạn nhập Áo khoác);
//   nhập 2, 3, 4 món -> AI giữ chính xác toàn bộ các món đã nhập.
// - Công cụ sản xuất hàng loạt TikTok: ⚡ Nhập nhanh hàng loạt 1 chạm & 🧬 Ma trận Tự Phối Đồ (Mix & Match).
import React, { useMemo, useState } from 'react';
import { AssetPicker } from '../components.jsx';

export const emptyModelOutfit = () => ({
  id: 'o' + Math.random().toString(36).slice(2, 7),
  items: {},
  style: '',
});

const SLOT_ORDER = ['set', 'top', 'dress', 'bottom', 'jacket', 'bag'];

const QUICK_MODES = {
  female: [
    { key: 'all', label: 'Tất cả ô', keep: null },
    { key: 'dress', label: '👗 Váy / Đầm', keep: ['dress', 'jacket', 'bag'] },
    { key: 'top_bottom', label: '👚👖 Áo + Quần', keep: ['top', 'bottom', 'jacket', 'bag'] },
    { key: 'top_skirt', label: '👚👗 Áo + Chân váy', keep: ['top', 'dress', 'jacket', 'bag'] },
    { key: 'set', label: '🎀 Đồ bộ 1 ảnh', keep: ['set', 'jacket', 'bag'] },
  ],
  male: [
    { key: 'all', label: 'Tất cả ô', keep: null },
    { key: 'top_bottom', label: '👕👖 Áo + Quần', keep: ['top', 'bottom', 'jacket'] },
    { key: 'set', label: '👔 Đồ bộ 1 ảnh', keep: ['set', 'jacket'] },
  ],
};

function detectQuickMode(gender, items = {}) {
  if (items.set) return 'set';
  if (gender === 'female') {
    if (items.dress && items.top) return 'top_skirt';
    if (items.dress) return 'dress';
    if (items.bottom) return 'top_bottom';
  } else {
    if (items.top || items.bottom) return 'top_bottom';
  }
  return 'all';
}

/**
 * Kiểm tra phía giao diện (khớp với validateOutfitItems ở server) để báo thiếu/lỗi trước khi bấm Chạy.
 */
export function validateModelOutfitsClient(config, outfits = [], assets = []) {
  const has = (id) => !!id && assets.some((a) => a.id === id);
  const list = Array.isArray(outfits) ? outfits : [];
  if (!list.length) return ['Chọn ít nhất 1 bộ trang phục'];
  const errors = [];
  list.forEach((o, idx) => {
    const it = o?.items || {};
    const count = SLOT_ORDER.filter((k) => has(it[k])).length;
    if (!count) errors.push(`Bộ #${idx + 1} chưa chọn ảnh sản phẩm nào`);
    if (it.set && (it.top || it.bottom || it.dress)) {
      errors.push(`Bộ #${idx + 1} đang chọn Đồ bộ cùng Áo/Quần/Váy`);
    }
    if (config?.gender === 'female' && it.dress && it.bottom) {
      errors.push(`Bộ #${idx + 1} đang chọn cả Váy lẫn Quần`);
    }
  });
  return errors;
}

function summarizeOutfit(gender, items, slots, assets) {
  const has = (id) => !!id && assets.some((a) => a.id === id);
  const picked = SLOT_ORDER.filter((k) => has(items?.[k]));
  if (!picked.length) return { count: 0, text: 'Chưa chọn món nào (cần ít nhất 1 ảnh)' };
  const names = picked.map((k) => slots.find((s) => s.key === k)?.label || k);
  const missingHints = [];
  if (!items.set) {
    if (!items.top && !items.dress) missingHints.push('áo');
    if (!items.bottom && !items.dress) missingHints.push(gender === 'female' ? 'quần/chân váy' : 'quần');
  }
  missingHints.push('giày');
  if (gender === 'female' && !items.bag) missingHints.push('túi xách');
  const jacketNote = items.jacket ? 'đúng áo khoác đã nhập' : 'KHÔNG thêm áo khoác';
  return {
    count: picked.length,
    text: `Giữ đúng ${picked.length} món (${names.join(' + ')}) · AI tự phối: ${missingHints.join(', ')} · ${jacketNote}`,
  };
}

export default function ModelOutfitsEditor({ config, value, onChange, state, refresh }) {
  const gender = config?.gender === 'male' ? 'male' : 'female';
  const slots = config?.slots || [];
  const outfits = Array.isArray(value) && value.length ? value : [emptyModelOutfit()];

  const [picking, setPicking] = useState(null); // { index, slotKey }
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkSlot, setBulkSlot] = useState(gender === 'female' ? 'dress' : 'set');
  const [bulkIds, setBulkIds] = useState([]);
  const [bulkJacketId, setBulkJacketId] = useState(null);

  const [matrixOpen, setMatrixOpen] = useState(false);
  const [mxTops, setMxTops] = useState([]);
  const [mxBottomSlot, setMxBottomSlot] = useState('bottom'); // 'bottom' | 'dress' (Nữ: Quần hoặc Chân váy)
  const [mxBottoms, setMxBottoms] = useState([]);
  const [mxJackets, setMxJackets] = useState([]);
  const [mxIncludeNoJacket, setMxIncludeNoJacket] = useState(true);
  const [mxSkipSet, setMxSkipSet] = useState(() => new Set());

  const assetOf = (id) => (id ? state.assets.find((a) => a.id === id) : null);

  const updateList = (next) => onChange(next.length ? next : [emptyModelOutfit()]);
  const setOutfit = (idx, patch) => updateList(outfits.map((o, i) => (i === idx ? { ...o, ...patch } : o)));

  const assignSlot = (idx, slotKey, assetId) => {
    const slotMeta = slots.find((s) => s.key === slotKey);
    const items = { ...(outfits[idx]?.items || {}) };
    if (assetId) {
      // Tự gỡ các ô bị khoá chéo khi người dùng chủ động gán ô mới
      for (const c of slotMeta?.conflicts || []) delete items[c];
      items[slotKey] = assetId;
    } else {
      delete items[slotKey];
    }
    setOutfit(idx, { items });
  };

  const applyQuickMode = (idx, mode) => {
    if (!mode.keep) return;
    const prev = outfits[idx]?.items || {};
    const next = {};
    for (const k of mode.keep) if (prev[k]) next[k] = prev[k];
    setOutfit(idx, { items: next });
  };

  const addOutfit = () => updateList([...outfits, emptyModelOutfit()]);
  const duplicateOutfit = (idx) => {
    const src = outfits[idx];
    const copy = { ...emptyModelOutfit(), items: { ...(src.items || {}) }, style: src.style || '' };
    const next = [...outfits];
    next.splice(idx + 1, 0, copy);
    updateList(next);
  };
  const moveOutfit = (idx, d) => {
    const j = idx + d;
    if (j < 0 || j >= outfits.length) return;
    const next = [...outfits];
    [next[idx], next[j]] = [next[j], next[idx]];
    updateList(next);
  };
  const removeOutfit = (idx) => updateList(outfits.filter((_, i) => i !== idx));

  const appendGeneratedOutfits = (generated) => {
    if (!generated.length) return;
    // Nếu hiện chỉ có 1 bộ trống chưa chọn món nào -> thay thế luôn để đỡ dư 1 bộ rỗng
    const isFirstEmpty = outfits.length === 1 && !Object.values(outfits[0].items || {}).some(Boolean);
    updateList(isFirstEmpty ? generated : [...outfits, ...generated]);
  };

  // ⚡ Nhập nhanh hàng loạt: 10-20 ảnh -> 10-20 Bộ riêng
  const applyBulkImport = () => {
    if (!bulkIds.length) return;
    const allowJacket = bulkSlot !== 'jacket' && !!bulkJacketId;
    const generated = bulkIds.map((aid) => ({
      ...emptyModelOutfit(),
      items: {
        [bulkSlot]: aid,
        ...(allowJacket ? { jacket: bulkJacketId } : {}),
      },
    }));
    appendGeneratedOutfits(generated);
    setBulkIds([]);
    setBulkJacketId(null);
    setBulkOpen(false);
  };

  // 🧬 Ma trận Mix & Match: Áo × Quần/Váy × (Không khoác | Áo khoác)
  const matrixCombos = useMemo(() => {
    const tops = mxTops.length ? mxTops : [null];
    const bots = mxBottoms.length ? mxBottoms : [null];
    if (!mxTops.length && !mxBottoms.length && !mxJackets.length) return [];
    const jks = [
      ...(mxIncludeNoJacket ? [null] : []),
      ...mxJackets,
    ];
    if (!jks.length) jks.push(null);

    const list = [];
    for (const t of tops) {
      for (const b of bots) {
        for (const j of jks) {
          const items = {};
          if (t) items.top = t;
          if (b) items[mxBottomSlot] = b;
          if (j) items.jacket = j;
          if (!Object.keys(items).length) continue;
          const sig = `${t || '-'}|${mxBottomSlot}:${b || '-'}|${j || '-'}`;
          list.push({ sig, items });
        }
      }
    }
    return list;
  }, [mxTops, mxBottoms, mxBottomSlot, mxJackets, mxIncludeNoJacket]);

  const activeMatrixCombos = matrixCombos.filter((c) => !mxSkipSet.has(c.sig));

  const applyMatrix = () => {
    if (!activeMatrixCombos.length) return;
    const generated = activeMatrixCombos.slice(0, 60).map((c) => ({
      ...emptyModelOutfit(),
      items: { ...c.items },
    }));
    appendGeneratedOutfits(generated);
    setMxTops([]);
    setMxBottoms([]);
    setMxJackets([]);
    setMxSkipSet(new Set());
    setMatrixOpen(false);
  };

  const slideCount = Math.ceil(outfits.length / 5);

  return (
    <div className="stack model-outfits">
      <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
        <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <b>
            👗 Danh sách Bộ trang phục ({outfits.length} bộ
            {outfits.length >= 2 ? ` · ≈ ${slideCount} bài TikTok 5 slide` : ''})
          </b>
          <button type="button" className="small-btn primary" onClick={addOutfit}>➕ Thêm 1 bộ</button>
          <button
            type="button"
            className={'small-btn' + (bulkOpen ? ' on' : '')}
            onClick={() => { setBulkOpen((v) => !v); setMatrixOpen(false); }}
            title="Chọn hàng loạt 10–20 ảnh đầm / đồ bộ / áo rồi tách thành từng Bộ ngay lập tức"
          >
            ⚡ Nhập nhanh hàng loạt
          </button>
          <button
            type="button"
            className={'small-btn' + (matrixOpen ? ' on' : '')}
            onClick={() => { setMatrixOpen((v) => !v); setBulkOpen(false); }}
            title="Chọn nhiều Áo × Quần/Váy × Áo khoác để tự sinh toàn bộ tổ hợp phối đồ không trùng"
          >
            🧬 Tự phối Mix & Match
          </button>
        </div>
        <small className="muted">
          Mỗi Bộ ra 1 ảnh 2K (0 credit). Nhập thiếu món AI tự phối phần còn thiếu <b>(KHÔNG tự thêm áo khoác)</b> · Giày{gender === 'female' ? ' & Túi' : ''} AI tự phối hợp bộ.
        </small>
      </div>

      {/* Công cụ 1: ⚡ Nhập nhanh hàng loạt */}
      {bulkOpen && (
        <div className="mo-drawer stack">
          <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
            <b>⚡ Nhập nhanh hàng loạt (mỗi ảnh sản phẩm thành 1 Bộ riêng)</b>
            <a onClick={() => setBulkOpen(false)}>Đóng</a>
          </div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="small">Loại món của các ảnh sắp chọn:</span>
            {slots.filter((s) => s.key !== 'bag').map((s) => (
              <button
                key={s.key}
                type="button"
                className={'small-btn' + (bulkSlot === s.key ? ' on primary-outline' : '')}
                onClick={() => setBulkSlot(s.key)}
              >
                {s.icon} {s.label}
              </button>
            ))}
          </div>
          <AssetPicker
            kind="product"
            label={`Chọn nhiều ảnh ${slots.find((s) => s.key === bulkSlot)?.label || ''} (mỗi ảnh sẽ tạo thành 1 Bộ)`}
            assets={state.assets}
            multiple
            value={bulkIds}
            onChange={setBulkIds}
            refresh={refresh}
            state={state}
            storageKey={`mo_bulk_${gender}_${bulkSlot}`}
          />
          {bulkSlot !== 'jacket' && (
            <AssetPicker
              kind="product"
              label="🧥 Tuỳ chọn: gắn kèm 1 Áo khoác chung cho cả loạt trên (bỏ trống = không mặc áo khoác)"
              assets={state.assets}
              value={bulkJacketId}
              onChange={setBulkJacketId}
              refresh={refresh}
              state={state}
              storageKey={`mo_bulk_jacket_${gender}`}
            />
          )}
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            <button type="button" className="primary" disabled={!bulkIds.length} onClick={applyBulkImport}>
              ✨ Tạo {bulkIds.length || 0} Bộ ngay
            </button>
            <button type="button" onClick={() => setBulkOpen(false)}>Huỷ</button>
          </div>
        </div>
      )}

      {/* Công cụ 2: 🧬 Ma trận Tự Phối Đồ (Mix & Match) */}
      {matrixOpen && (
        <div className="mo-drawer stack">
          <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
            <b>🧬 Ma trận Tự Phối Đồ (Mix & Match) — sinh hàng loạt tổ hợp đăng TikTok</b>
            <a onClick={() => setMatrixOpen(false)}>Đóng</a>
          </div>
          <div className="mo-matrix-grid">
            <AssetPicker
              kind="product"
              label="1. Chọn nhiều Áo"
              assets={state.assets}
              multiple
              value={mxTops}
              onChange={setMxTops}
              refresh={refresh}
              state={state}
              storageKey={`mo_mx_top_${gender}`}
            />
            <div className="stack">
              {gender === 'female' && (
                <div className="row gap-xs" style={{ alignItems: 'center' }}>
                  <span className="small muted">Món dưới là:</span>
                  <button type="button" className={'small-btn' + (mxBottomSlot === 'bottom' ? ' on' : '')} onClick={() => setMxBottomSlot('bottom')}>👖 Quần</button>
                  <button type="button" className={'small-btn' + (mxBottomSlot === 'dress' ? ' on' : '')} onClick={() => setMxBottomSlot('dress')}>👗 Chân váy</button>
                </div>
              )}
              <AssetPicker
                kind="product"
                label={`2. Chọn nhiều ${mxBottomSlot === 'dress' ? 'Chân váy' : 'Quần'}`}
                assets={state.assets}
                multiple
                value={mxBottoms}
                onChange={setMxBottoms}
                refresh={refresh}
                state={state}
                storageKey={`mo_mx_bot_${gender}_${mxBottomSlot}`}
              />
            </div>
          </div>
          <AssetPicker
            kind="product"
            label="3. Tuỳ chọn: chọn nhiều Áo khoác (bỏ trống tất cả = chỉ phối Áo + Quần/Váy)"
            assets={state.assets}
            multiple
            value={mxJackets}
            onChange={setMxJackets}
            refresh={refresh}
            state={state}
            storageKey={`mo_mx_jk_${gender}`}
          />
          {mxJackets.length > 0 && (
            <label className="check small">
              <input type="checkbox" checked={mxIncludeNoJacket} onChange={(e) => setMxIncludeNoJacket(e.target.checked)} />
              Tạo thêm biến thể "Không mặc áo khoác" song song với các mẫu có áo khoác
            </label>
          )}
          {matrixCombos.length > 0 && (
            <div className="stack">
              <small className="muted">Xem trước {activeMatrixCombos.length}/{matrixCombos.length} tổ hợp (bấm để bỏ cặp không ưng; tối đa 60 bộ/lần):</small>
              <div className="mo-combo-preview">
                {matrixCombos.slice(0, 60).map((c, ci) => {
                  const skipped = mxSkipSet.has(c.sig);
                  const thumbs = SLOT_ORDER.filter((k) => c.items[k]).map((k) => ({ k, a: assetOf(c.items[k]) })).filter((x) => x.a);
                  return (
                    <button
                      key={c.sig}
                      type="button"
                      className={'mo-combo-chip' + (skipped ? ' off' : '')}
                      onClick={() => setMxSkipSet((prev) => {
                        const n = new Set(prev);
                        if (n.has(c.sig)) n.delete(c.sig);
                        else n.add(c.sig);
                        return n;
                      })}
                      title={skipped ? 'Bấm để bật lại tổ hợp này' : 'Bấm để bỏ tổ hợp này'}
                    >
                      <span className="small muted">#{ci + 1}</span>
                      {thumbs.map((t) => <img key={t.k} src={t.a.url} alt="" />)}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="primary" disabled={!activeMatrixCombos.length} onClick={applyMatrix}>
              ✨ Thêm {Math.min(60, activeMatrixCombos.length)} Bộ đã chọn
            </button>
            <button type="button" onClick={() => setMatrixOpen(false)}>Huỷ</button>
          </div>
        </div>
      )}

      {/* Danh sách từng Bộ */}
      <div className="stack" style={{ gap: 10 }}>
        {outfits.map((outfit, idx) => {
          const items = outfit.items || {};
          const qModes = QUICK_MODES[gender];
          const curMode = detectQuickMode(gender, items);
          const sum = summarizeOutfit(gender, items, slots, state.assets);
          const hasAny = sum.count > 0;
          return (
            <div key={outfit.id || idx} className={'card stack mo-card' + (!hasAny ? ' empty-card' : '')}>
              <div className="row between" style={{ gap: 8, flexWrap: 'wrap' }}>
                <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                  <b className="mo-num">Bộ #{idx + 1}</b>
                  <div className="mo-mode-pills">
                    {qModes.map((m) => (
                      <button
                        key={m.key}
                        type="button"
                        className={'small-btn' + (curMode === m.key ? ' on' : '')}
                        onClick={() => applyQuickMode(idx, m)}
                        title="Chọn nhanh nhóm ô phù hợp"
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="row gap-xs">
                  {outfits.length > 1 && idx > 0 && <button type="button" className="small-btn" onClick={() => moveOutfit(idx, -1)} title="Đưa lên">↑</button>}
                  {outfits.length > 1 && idx < outfits.length - 1 && <button type="button" className="small-btn" onClick={() => moveOutfit(idx, 1)} title="Đưa xuống">↓</button>}
                  <button type="button" className="small-btn" onClick={() => duplicateOutfit(idx)} title="Nhân bản bộ này">⧉ Nhân bản</button>
                  {outfits.length > 1 && <button type="button" className="small-btn danger-text" onClick={() => removeOutfit(idx)} title="Xoá bộ này">× Xoá</button>}
                </div>
              </div>

              <div className="mo-slots-grid">
                {slots.map((slot) => {
                  const assetId = items[slot.key] || null;
                  const asset = assetOf(assetId);
                  const blockedBy = (slot.conflicts || []).filter((ck) => !!items[ck]);
                  const locked = blockedBy.length > 0;
                  const blockedNames = blockedBy.map((ck) => slots.find((s) => s.key === ck)?.label || ck).join(' / ');

                  let emptyText = '+ Chọn ảnh';
                  if (slot.key === 'jacket') emptyText = 'Trống (không áo khoác)';
                  else if (slot.key === 'bag') emptyText = 'AI tự phối túi';

                  return (
                    <div
                      key={slot.key}
                      className={'mo-slot' + (asset ? ' picked' : '') + (locked ? ' locked' : '')}
                      onClick={() => !locked && setPicking({ index: idx, slot })}
                      title={locked ? `Đã chọn ${blockedNames} nên khoá ô ${slot.label}` : (slot.hint || slot.label)}
                    >
                      <div className="mo-slot-head row between">
                        <span className="small"><b>{slot.icon} {slot.label}</b></span>
                        {asset && (
                          <button
                            type="button"
                            className="mo-clear"
                            onClick={(e) => { e.stopPropagation(); assignSlot(idx, slot.key, null); }}
                            title="Bỏ ảnh khỏi ô này"
                          >
                            ×
                          </button>
                        )}
                      </div>

                      {asset ? (
                        <div className="mo-slot-thumb">
                          <img src={asset.url} alt={asset.name} />
                          <span className="mo-slot-name ellipsis">{asset.productCode ? `[${asset.productCode}] ` : ''}{asset.name}</span>
                        </div>
                      ) : locked ? (
                        <div className="mo-slot-locked stack">
                          <span>🔒 Đang chọn {blockedNames}</span>
                          <button
                            type="button"
                            className="small-btn"
                            onClick={(e) => { e.stopPropagation(); setPicking({ index: idx, slot }); }}
                          >
                            Đổi sang {slot.label}
                          </button>
                        </div>
                      ) : (
                        <div className="mo-slot-empty">{emptyText}</div>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="row between" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <small className={hasAny ? 'ok' : 'warn-text'}>
                  {hasAny ? '✓' : '⚠'} {sum.text}
                </small>
                <input
                  className="mo-style-input"
                  maxLength={140}
                  placeholder="Ghi chú riêng cho bộ này (VD: sơ-vin gọn, đi sandal quai mảnh…)"
                  value={outfit.style || ''}
                  onChange={(e) => setOutfit(idx, { style: e.target.value })}
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* Lightbox chọn ảnh sản phẩm cho 1 ô của 1 Bộ */}
      {picking && (
        <div className="lightbox" onClick={() => setPicking(null)}>
          <div className="lightbox-body chooser" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="lightbox-close" onClick={() => setPicking(null)} title="Đóng">×</button>
            <div className="lightbox-side stack">
              <b>Chọn {picking.slot.icon} {picking.slot.label} cho Bộ #{picking.index + 1}</b>
              {picking.slot.hint && <small className="muted">{picking.slot.hint}</small>}
              <AssetPicker
                kind="product"
                label="Thư viện ảnh sản phẩm"
                assets={state.assets}
                value={outfits[picking.index]?.items?.[picking.slot.key] || null}
                onChange={(id) => {
                  assignSlot(picking.index, picking.slot.key, id || null);
                  if (id) setPicking(null);
                }}
                refresh={refresh}
                state={state}
                storageKey={`mo_pick_${gender}_${picking.slot.key}`}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
