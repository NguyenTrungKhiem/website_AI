import React, { useRef, useState, useEffect } from 'react';
import { api } from '../api.js';
import { useAction } from '../components.jsx';

export default function CropModal({ asset, targetSlot = 'outfitFront', onCropDone, onClose }) {
  const [slot, setSlot] = useState(targetSlot);
  const [box, setBox] = useState(null); // { x, y, w, h } in display pixels
  const [dragging, setDragging] = useState(false);
  const [startPos, setStartPos] = useState(null);
  const imgRef = useRef(null);
  const { busy, error, run } = useAction();

  const slotLabels = {
    outfitFront: '👗 Trang phục – Mặt trước',
    outfitBack: '👚 Trang phục – Mặt sau',
    shoes: '👠 Giày (Footwear)',
    bag: '👜 Túi xách (Bag)',
  };

  const handleMouseDown = (e) => {
    if (!imgRef.current) return;
    const rect = imgRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const y = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
    setStartPos({ x, y });
    setBox({ x, y, w: 0, h: 0 });
    setDragging(true);
  };

  const handleMouseMove = (e) => {
    if (!dragging || !startPos || !imgRef.current) return;
    const rect = imgRef.current.getBoundingClientRect();
    const curX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const curY = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
    const x = Math.min(startPos.x, curX);
    const y = Math.min(startPos.y, curY);
    const w = Math.abs(curX - startPos.x);
    const h = Math.abs(curY - startPos.y);
    setBox({ x, y, w, h });
  };

  const handleMouseUp = () => {
    setDragging(false);
  };

  useEffect(() => {
    const onEsc = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, [onClose]);

  const doCrop = () =>
    run(async () => {
      if (!imgRef.current || !box || box.w < 10 || box.h < 10) {
        throw new Error('Vui lòng kéo chuột vẽ khung chọn vùng cần cắt trên ảnh');
      }
      const img = imgRef.current;
      const scaleX = img.naturalWidth / img.clientWidth;
      const scaleY = img.naturalHeight / img.clientHeight;

      const cropX = Math.round(box.x * scaleX);
      const cropY = Math.round(box.y * scaleY);
      const cropW = Math.round(box.w * scaleX);
      const cropH = Math.round(box.h * scaleY);

      const slotName = slotLabels[slot] || slot;
      const res = await api.cropAsset({
        assetId: asset.id,
        x: cropX,
        y: cropY,
        width: cropW,
        height: cropH,
        name: `${asset.name} – ${slotName}`,
        kind: 'product',
      });

      onCropDone(res, slot);
    });

  return (
    <div className="lightbox" onClick={onClose} style={{ zIndex: 1100 }}>
      <div
        className="lightbox-body"
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: 960,
          width: '90vw',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--panel)',
          borderRadius: 12,
          padding: 16,
          gap: 12,
        }}
      >
        <div className="row between" style={{ borderBottom: '1px solid var(--line)', paddingBottom: 10 }}>
          <div>
            <b>✂️ Cắt ảnh từ: {asset.name}</b>
            <div className="small muted">Nhấp giữ và kéo chuột trên ảnh để vẽ khung vùng bạn muốn cắt</div>
          </div>
          <button className="lightbox-close" onClick={onClose} style={{ position: 'static' }}>
            ×
          </button>
        </div>

        <div className="row wrap between" style={{ alignItems: 'center', gap: 10 }}>
          <div className="row" style={{ alignItems: 'center', gap: 8 }}>
            <span>Lưu vùng cắt vào mục:</span>
            <select value={slot} onChange={(e) => setSlot(e.target.value)}>
              {Object.entries(slotLabels).map(([k, lbl]) => (
                <option key={k} value={k}>
                  {lbl}
                </option>
              ))}
            </select>
          </div>
          {box && box.w > 0 && (
            <div className="badge blue small">
              Vùng chọn: {Math.round(box.w)} × {Math.round(box.h)} px
            </div>
          )}
        </div>

        <div
          style={{
            flex: 1,
            minHeight: 380,
            maxHeight: '60vh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: '#0a0c10',
            borderRadius: 8,
            overflow: 'hidden',
            position: 'relative',
            userSelect: 'none',
          }}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        >
          <div style={{ position: 'relative', display: 'inline-block' }}>
            <img
              ref={imgRef}
              src={asset.url}
              alt=""
              draggable={false}
              onMouseDown={handleMouseDown}
              style={{
                display: 'block',
                maxHeight: '58vh',
                maxWidth: '85vw',
                objectFit: 'contain',
                cursor: 'crosshair',
              }}
            />
            {box && box.w > 0 && box.h > 0 && (
              <div
                style={{
                  position: 'absolute',
                  left: box.x,
                  top: box.y,
                  width: box.w,
                  height: box.h,
                  border: '2px dashed #6c8cff',
                  backgroundColor: 'rgba(108, 140, 255, 0.25)',
                  boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.45)',
                  pointerEvents: 'none',
                }}
              >
                <span
                  style={{
                    position: 'absolute',
                    top: 2,
                    left: 2,
                    background: '#6c8cff',
                    color: '#fff',
                    fontSize: 10,
                    padding: '1px 4px',
                    borderRadius: 3,
                    fontWeight: 600,
                  }}
                >
                  {slotLabels[slot]?.split(' ')[1] || 'Vùng cắt'}
                </span>
              </div>
            )}
          </div>
        </div>

        {error && <div className="err small">{error}</div>}

        <div className="row between" style={{ paddingTop: 8 }}>
          <span className="small muted">
            Mẹo: Cắt lần lượt các món (mặt trước, mặt sau, giày, túi) từ cùng một ảnh tổng hợp outfit mà không cần thoát.
          </span>
          <div className="row" style={{ gap: 8 }}>
            <button onClick={onClose}>Đóng</button>
            <button className="primary" disabled={busy || !box || box.w < 10 || box.h < 10} onClick={doCrop}>
              {busy ? '… Đang cắt' : '✂️ Cắt & Lưu vào ô đã chọn'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
