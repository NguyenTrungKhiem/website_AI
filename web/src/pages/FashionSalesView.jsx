import React, { useState, useEffect } from 'react';
import { api } from '../api.js';
import { AssetPicker, ConfirmButton, useAction, Badge } from '../components.jsx';
import CropModal from '../components/CropModal.jsx';

export default function FashionSalesView({ wf, state, refresh, go }) {
  const [inputs, setInputs] = useState({
    model: null,
    background: null,
    outfitSheet: null,
    outfitFront: null,
    outfitBack: null,
    shoes: null,
    bag: null,
  });

  const [caseMode, setCaseMode] = useState('case1'); // 'case1' (Full outfit) | 'case2' (Garment only)
  const [cropTarget, setCropTarget] = useState(null); // { asset, slot }
  const [backOption, setBackOption] = useState('generate'); // 'cleanFront' | 'cleanBack' | 'generate'
  const [backPrompt, setBackPrompt] = useState(
    state?.defaults?.backViewPrompt ||
      `Create a clean, photorealistic product photo of the BACK VIEW of the exact clothing garment shown in the reference image (front view). Keep the same color, fabric, pattern, texture, neckline style from the back, sleeve length, hemline, and design language. Show the back details naturally (e.g. back zipper, back seams, back cut, back buttons) faithful to the front garment's style. Present the back-view garment cleanly on a plain, neutral, evenly lit white studio background, front-to-back perspective, fully visible, centered, with no person, no mannequin, no hangers, no text or props.`
  );

  const [showPromptEditor, setShowPromptEditor] = useState(false);
  const [removeWatermark, setRemoveWatermark] = useState(state.settings?.removeWatermark !== false);
  const [autoPublish, setAutoPublish] = useState(true);
  const [pendingBackJobId, setPendingBackJobId] = useState(null);
  const [backMsg, setBackMsg] = useState(null);

  const { busy, error, run } = useAction();
  const runs = state.runs.filter((r) => r.workflow === wf.id);

  const assetOf = (id) => state.assets?.find((a) => a.id === id);
  const frontAsset = assetOf(inputs.outfitFront);
  const backAsset = assetOf(inputs.outfitBack);
  const sheetAsset = assetOf(inputs.outfitSheet);

  // Danh sách các ảnh mặt sau đã được tạo từ ảnh mặt trước đang chọn
  const generatedBacks = (state.assets || []).filter(
    (a) =>
      inputs.outfitFront &&
      a.fromAssetId === inputs.outfitFront &&
      (a.isBackView || a.name?.includes('Mặt sau Flow'))
  );

  // Tự động đảm bảo Flow ở chế độ Omni Flash 10s khi vào module Video bán hàng thời trang
  useEffect(() => {
    api.flowPreset({ model: 'Omni 1.1 Flash', duration: '10s' }).catch(() => {});
  }, []);

  // Khi chọn ảnh mặt trước mới: nếu đã có sẵn ảnh mặt sau của nó mà ô mặt sau đang trống thì tự động gắn luôn
  useEffect(() => {
    if (inputs.outfitFront && !inputs.outfitBack && generatedBacks.length > 0) {
      setInputs((s) => ({ ...s, outfitBack: generatedBacks[0].id }));
      setBackMsg({ type: 'ok', text: `Đã tự động gắn ảnh mặt sau đã tạo trước đó: "${generatedBacks[0].name}"` });
    }
  }, [inputs.outfitFront, generatedBacks.length]);

  // Polling nhanh khi đang tạo ảnh mặt sau để cập nhật state.assets và state.jobs ngay lập tức
  useEffect(() => {
    if (!pendingBackJobId) return;
    const timer = setInterval(() => {
      refresh();
    }, 1500);
    return () => clearInterval(timer);
  }, [pendingBackJobId, refresh]);

  // Theo dõi tiến trình tạo ảnh mặt sau và tự động gắn vào ô Mặt sau ngay khi hoàn thành
  const backJob = state.jobs?.find((j) => j.id === pendingBackJobId);
  useEffect(() => {
    if (!pendingBackJobId || !backJob) return;

    if (backJob.status === 'running' || backJob.status === 'queued') {
      const progress = backJob.attempts?.at(-1)?.progress || 'Đang chờ lượt xử lý trên Flow...';
      setBackMsg({ type: 'loading', text: `⏳ ${progress}` });
    } else if (backJob.status === 'done') {
      const newAsset = (state.assets || []).find(
        (a) =>
          a.fromJobId === backJob.id ||
          a.id === backJob.meta?.assetId ||
          (a.fromAssetId === inputs.outfitFront && (a.isBackView || a.name?.includes('Mặt sau Flow')))
      );
      if (newAsset) {
        setInputs((s) => ({ ...s, outfitBack: newAsset.id }));
        setBackMsg({ type: 'ok', text: `✅ Đã tạo xong và tự động gắn ảnh mặt sau: "${newAsset.name}"!` });
        setPendingBackJobId(null);
      }
    } else if (backJob.status === 'failed') {
      setBackMsg({ type: 'err', text: `❌ Lỗi khi tạo ảnh mặt sau: ${backJob.error || 'Vui lòng thử lại'}` });
      setPendingBackJobId(null);
    }
  }, [backJob?.status, backJob?.attempts?.length, state.assets, pendingBackJobId, inputs.outfitFront]);

  // Tự động chuyển mode nếu người dùng bỏ giày/túi hoặc ngược lại
  const isCase1 = caseMode === 'case1';

  // Kiểm tra thiếu nguyên liệu
  const missing = [];
  if (!inputs.model) missing.push('Ảnh người mẫu');
  if (!inputs.background) missing.push('Ảnh bối cảnh');
  if (!inputs.outfitFront) missing.push('Trang phục – Mặt trước');
  if (!inputs.outfitBack) missing.push('Trang phục – Mặt sau');
  if (isCase1) {
    if (!inputs.shoes) missing.push('Ảnh giày');
    if (!inputs.bag) missing.push('Ảnh túi xách');
  }

  // Khởi tạo chạy workflow
  const startRun = () =>
    run(async () => {
      await api.createRun({
        workflowId: wf.id,
        inputs,
        options: {
          caseMode,
          removeWatermark,
          autoPublish,
        },
      });
      await refresh();
    });

  // Xử lý tạo ảnh mặt sau từ ảnh mặt trước
  const handleRenderBack = () =>
    run(async () => {
      if (!inputs.outfitFront) throw new Error('Vui lòng chọn ảnh Trang phục – Mặt trước trước khi tạo mặt sau');
      setBackMsg({ type: 'loading', text: '⏳ Đang gửi yêu cầu tạo ảnh mặt sau sang Flow (0 credit)...' });
      const res = await api.renderBackAsset(inputs.outfitFront, backPrompt);
      setPendingBackJobId(res.id);
      await refresh();
    });

  // Làm sạch ảnh mặt trước hoặc mặt sau
  const handleClean = (assetId, label) =>
    run(async () => {
      if (!assetId) throw new Error(`Chưa có ảnh ${label} để làm sạch`);
      await api.cleanAsset(assetId);
      await refresh();
      alert(`Đã gửi yêu cầu làm sạch ảnh ${label} sang Flow (0 credit). Vui lòng chờ vài giây!`);
    });

  return (
    <section className="stack" style={{ gap: 20 }}>
      <div>
        <h1>🛍️ {wf.name}</h1>
        <p className="muted">
          Tạo video bán hàng thời trang 10 giây phong cách lookbook Hàn Quốc tự động bằng Google Flow (Omni 1.1 Flash).
          Tự động phối hợp người mẫu, bối cảnh, trang phục, giày, túi và xoá logo Gemini thành phẩm.
        </p>
      </div>

      {/* KHỐI 1: NGƯỜI MẪU & BỐI CẢNH (BẮT BUỘC) */}
      <div className="card stack">
        <b>1. Người mẫu & Bối cảnh (Bắt buộc)</b>
        <div className="grid2">
          <div className="stack gap-xs">
            <div className="row between">
              <b>Ảnh người mẫu *</b>
              <span className="badge" style={{ background: '#2563eb', color: '#fff', fontSize: 11, padding: '2px 8px', borderRadius: 4 }}>@Image1</span>
            </div>
            <AssetPicker
              kind="model"
              label="Chọn ảnh người mẫu (toàn thân / chân dung rõ mặt)"
              assets={state.assets}
              value={inputs.model}
              onChange={(id) => setInputs((s) => ({ ...s, model: id }))}
              refresh={refresh}
              state={state}
            />
          </div>
          <div className="stack gap-xs">
            <div className="row between">
              <b>Ảnh bối cảnh *</b>
              <span className="badge" style={{ background: '#7c3aed', color: '#fff', fontSize: 11, padding: '2px 8px', borderRadius: 4 }}>{isCase1 ? '@Image6' : '@Image3'}</span>
            </div>
            <AssetPicker
              kind="background"
              label="Chọn ảnh bối cảnh (phòng / studio / cửa hàng)"
              assets={state.assets}
              value={inputs.background}
              onChange={(id) => setInputs((s) => ({ ...s, background: id }))}
              refresh={refresh}
              state={state}
            />
          </div>
        </div>
      </div>

      {/* KHỐI 2: CHẾ ĐỘ VIDEO & ẢNH TỔNG HỢP OUTFIT */}
      <div className="card stack">
        <div className="row between">
          <b>2. Chế độ Video & Outfit</b>
          <div className="row" style={{ gap: 16 }}>
            <label className="check">
              <input
                type="radio"
                name="caseMode"
                checked={caseMode === 'case1'}
                onChange={() => setCaseMode('case1')}
              />
              <span>
                <b>Trường hợp 1: Đầy đủ Outfit</b> (Trang phục + Giày + Túi xách, có pop-up mã sản phẩm)
              </span>
            </label>
            <label className="check">
              <input
                type="radio"
                name="caseMode"
                checked={caseMode === 'case2'}
                onChange={() => setCaseMode('case2')}
              />
              <span>
                <b>Trường hợp 2: Chỉ Trang phục</b> (Mặt trước + Mặt sau)
              </span>
            </label>
          </div>
        </div>

        {/* ẢNH TỔNG HỢP OUTFIT (LOOKBOOK / COLLAGE) */}
        <div
          style={{
            background: 'var(--panel2)',
            padding: 14,
            borderRadius: 8,
            border: '1px dashed var(--line)',
          }}
          className="stack"
        >
          <div className="row between" style={{ alignItems: 'center' }}>
            <div>
              <b>📸 Ảnh tổng hợp outfit (gồm giày + túi + trang phục trước/sau)</b>
              <div className="small muted">
                Nếu bạn có 1 ảnh lookbook ghép sẵn nhiều món từ sàn TMĐT/Pinterest, hãy tải vào đây để cắt nhanh từng món.
              </div>
            </div>
            {sheetAsset && (
              <button
                type="button"
                className="small-btn primary"
                onClick={() => setCropTarget({ asset: sheetAsset, slot: 'outfitFront' })}
              >
                ✂️ Mở công cụ cắt từ ảnh này
              </button>
            )}
          </div>

          <AssetPicker
            kind="product"
            label="Chọn hoặc tải lên ảnh tổng hợp outfit (tuỳ chọn)"
            assets={state.assets}
            value={inputs.outfitSheet}
            onChange={(id) => setInputs((s) => ({ ...s, outfitSheet: id }))}
            refresh={refresh}
            state={state}
          />
        </div>

        {/* CÁC Ô NGUYÊN LIỆU CHI TIẾT */}
        <div className="grid2" style={{ marginTop: 10 }}>
          {/* MẶT TRƯỚC */}
          <div className="stack" style={{ background: 'var(--panel2)', padding: 12, borderRadius: 8 }}>
            <div className="row between">
              <b>👗 Trang phục – Mặt trước *</b>
              <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                <span className="badge" style={{ background: '#059669', color: '#fff', fontSize: 11, padding: '2px 8px', borderRadius: 4 }}>@Image2</span>
                {sheetAsset && (
                  <a
                    className="small"
                    onClick={() => setCropTarget({ asset: sheetAsset, slot: 'outfitFront' })}
                  >
                    ✂️ Cắt từ ảnh tổng hợp
                  </a>
                )}
              </div>
            </div>
            <AssetPicker
              kind="product"
              label="Ảnh mặt trước phẳng/treo/mặc"
              assets={state.assets}
              value={inputs.outfitFront}
              onChange={(id) => setInputs((s) => ({ ...s, outfitFront: id }))}
              refresh={refresh}
              state={state}
            />
            {frontAsset && (
              <div className="row">
                <button
                  type="button"
                  className="small-btn"
                  disabled={busy}
                  onClick={() => handleClean(frontAsset.id, 'mặt trước')}
                >
                  ✨ Làm sạch mặt trước này
                </button>
              </div>
            )}
          </div>

          {/* MẶT SAU */}
          <div className="stack" style={{ background: 'var(--panel2)', padding: 12, borderRadius: 8 }}>
            <div className="row between">
              <b>👚 Trang phục – Mặt sau *</b>
              <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                <span className="badge" style={{ background: '#d97706', color: '#fff', fontSize: 11, padding: '2px 8px', borderRadius: 4 }}>{isCase1 ? '@Image3' : '@Image4'}</span>
                {sheetAsset && (
                  <a
                    className="small"
                    onClick={() => setCropTarget({ asset: sheetAsset, slot: 'outfitBack' })}
                  >
                    ✂️ Cắt từ ảnh tổng hợp
                  </a>
                )}
              </div>
            </div>

            <div className="stack gap-xs" style={{ background: 'var(--panel)', padding: 10, borderRadius: 6 }}>
              <span className="small"><b>Tuỳ chọn xử lý mặt sau:</b></span>
              <label className="check small">
                <input
                  type="radio"
                  name="backOpt"
                  checked={backOption === 'cleanFront'}
                  onChange={() => setBackOption('cleanFront')}
                />
                <span>Đây là mặt trước và chỉ làm sạch</span>
              </label>
              <label className="check small">
                <input
                  type="radio"
                  name="backOpt"
                  checked={backOption === 'cleanBack'}
                  onChange={() => setBackOption('cleanBack')}
                />
                <span>Đây là mặt sau chỉ cần làm sạch</span>
              </label>
              <label className="check small">
                <input
                  type="radio"
                  name="backOpt"
                  checked={backOption === 'generate'}
                  onChange={() => setBackOption('generate')}
                />
                <span>
                  <b>Đây là mặt sau nhưng chưa có, dựa trên mặt trước để tạo mặt sau</b>
                </span>
              </label>

              {backOption === 'generate' && (
                <div className="stack" style={{ marginTop: 6 }}>
                  <label className="small">
                    <span>Prompt sinh ảnh mặt sau (tiếng Anh):</span>
                    <textarea
                      rows={3}
                      className="mono small"
                      value={backPrompt}
                      onChange={(e) => setBackPrompt(e.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    className="small-btn primary"
                    disabled={busy || !inputs.outfitFront || !!pendingBackJobId}
                    onClick={handleRenderBack}
                  >
                    {pendingBackJobId ? '⏳ Đang tạo trên Flow…' : '✨ Tạo ảnh mặt sau từ mặt trước (Flow, 0 credit)'}
                  </button>
                  {!inputs.outfitFront && (
                    <small className="err">Cần chọn ảnh mặt trước ở cột bên trái trước</small>
                  )}
                </div>
              )}

              {/* Thông báo tiến trình & kết quả tạo mặt sau */}
              {backMsg && (
                <div
                  className="small"
                  style={{
                    padding: '6px 10px',
                    borderRadius: 6,
                    background: backMsg.type === 'ok' ? 'rgba(63, 191, 127, 0.15)' : backMsg.type === 'err' ? 'rgba(239, 93, 93, 0.15)' : 'rgba(108, 140, 255, 0.15)',
                    border: `1px solid ${backMsg.type === 'ok' ? 'var(--green)' : backMsg.type === 'err' ? 'var(--red)' : 'var(--accent)'}`,
                    color: backMsg.type === 'ok' ? 'var(--green)' : backMsg.type === 'err' ? 'var(--red)' : '#9db2ff',
                  }}
                >
                  {backMsg.text}
                </div>
              )}

              {/* Danh sách các ảnh mặt sau đã sinh từ ảnh mặt trước này */}
              {generatedBacks.length > 0 && (
                <div className="stack gap-xs" style={{ background: 'var(--panel2)', padding: 8, borderRadius: 6, marginTop: 4 }}>
                  <span className="small muted">
                    <b>Ảnh mặt sau của sản phẩm này ({generatedBacks.length}):</b>
                  </span>
                  <div className="row wrap gap-xs">
                    {generatedBacks.map((gb) => {
                      const isChosen = inputs.outfitBack === gb.id;
                      return (
                        <div
                          key={gb.id}
                          className={'thumb' + (isChosen ? ' selected' : '')}
                          style={{
                            width: 72,
                            height: 72,
                            position: 'relative',
                            cursor: 'pointer',
                            borderRadius: 6,
                            overflow: 'hidden',
                            border: isChosen ? '2px solid var(--accent)' : '1px solid var(--line)',
                          }}
                          onClick={() => {
                            setInputs((s) => ({ ...s, outfitBack: gb.id }));
                            setBackMsg({ type: 'ok', text: `Đã gắn ảnh "${gb.name}" làm mặt sau!` });
                          }}
                          title={`Bấm để chọn: ${gb.name}`}
                        >
                          <img src={gb.url} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain', background: '#000' }} />
                          {isChosen ? (
                            <span
                              style={{
                                position: 'absolute',
                                bottom: 2,
                                left: 2,
                                right: 2,
                                background: 'var(--accent)',
                                color: '#fff',
                                fontSize: 9,
                                textAlign: 'center',
                                borderRadius: 3,
                                fontWeight: 600,
                              }}
                            >
                              ✓ Đang chọn
                            </span>
                          ) : (
                            <span
                              style={{
                                position: 'absolute',
                                bottom: 2,
                                left: 2,
                                right: 2,
                                background: 'rgba(0,0,0,0.7)',
                                color: '#ddd',
                                fontSize: 9,
                                textAlign: 'center',
                                borderRadius: 3,
                              }}
                            >
                              Gắn ảnh
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {backOption === 'cleanBack' && backAsset && (
                <button
                  type="button"
                  className="small-btn"
                  disabled={busy}
                  onClick={() => handleClean(backAsset.id, 'mặt sau')}
                >
                  ✨ Làm sạch ảnh mặt sau đã chọn
                </button>
              )}
            </div>

            <AssetPicker
              kind="product"
              label="Hoặc chọn ảnh mặt sau từ thư viện"
              assets={state.assets}
              value={inputs.outfitBack}
              onChange={(id) => setInputs((s) => ({ ...s, outfitBack: id }))}
              refresh={refresh}
              state={state}
            />
          </div>

          {/* GIÀY (NẾU CHẾ ĐỘ 1) */}
          {isCase1 && (
            <div className="stack" style={{ background: 'var(--panel2)', padding: 12, borderRadius: 8 }}>
              <div className="row between">
                <b>👠 Giày (Footwear) *</b>
                <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                  <span className="badge" style={{ background: '#db2777', color: '#fff', fontSize: 11, padding: '2px 8px', borderRadius: 4 }}>@Image4</span>
                  {sheetAsset && (
                    <a
                      className="small"
                      onClick={() => setCropTarget({ asset: sheetAsset, slot: 'shoes' })}
                    >
                      ✂️ Cắt từ ảnh tổng hợp
                    </a>
                  )}
                </div>
              </div>
              <AssetPicker
                kind="product"
                label="Ảnh giày (cho TH1)"
                assets={state.assets}
                value={inputs.shoes}
                onChange={(id) => setInputs((s) => ({ ...s, shoes: id }))}
                refresh={refresh}
                state={state}
              />
            </div>
          )}

          {/* TÚI XÁCH (NẾU CHẾ ĐỘ 1) */}
          {isCase1 && (
            <div className="stack" style={{ background: 'var(--panel2)', padding: 12, borderRadius: 8 }}>
              <div className="row between">
                <b>👜 Túi xách (Bag) *</b>
                <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                  <span className="badge" style={{ background: '#4f46e5', color: '#fff', fontSize: 11, padding: '2px 8px', borderRadius: 4 }}>@Image5</span>
                  {sheetAsset && (
                    <a
                      className="small"
                      onClick={() => setCropTarget({ asset: sheetAsset, slot: 'bag' })}
                    >
                      ✂️ Cắt từ ảnh tổng hợp
                    </a>
                  )}
                </div>
              </div>
              <AssetPicker
                kind="product"
                label="Ảnh túi xách (cho TH1)"
                assets={state.assets}
                value={inputs.bag}
                onChange={(id) => setInputs((s) => ({ ...s, bag: id }))}
                refresh={refresh}
                state={state}
              />
            </div>
          )}
        </div>
      </div>

      {/* KHỐI 3: KỊCH BẢN PROMPT & TUỲ CHỌN XUẤT VIDEO */}
      <div className="card stack">
        <div className="row between">
          <b>3. Kịch bản & Tuỳ chọn xuất video</b>
          <a onClick={() => setShowPromptEditor(!showPromptEditor)}>
            {showPromptEditor ? 'Ẩn prompt' : 'Xem / Tuỳ chỉnh prompt 10s'}
          </a>
        </div>

        <div style={{ background: 'var(--panel2)', padding: 12, borderRadius: 8 }}>
          <div className="small muted" style={{ marginBottom: 6 }}>
            <b>Liên kết nguyên liệu thực tế (@Image Mention) vào Google Flow:</b>
          </div>
          <div className="row wrap" style={{ gap: 8 }}>
            <span className="badge" style={{ background: '#2563eb', color: '#fff', padding: '3px 8px', borderRadius: 4, fontSize: 12 }}>
              @Image1: {assetOf(inputs.model)?.name || '⚠️ Chưa chọn người mẫu'}
            </span>
            <span className="badge" style={{ background: '#059669', color: '#fff', padding: '3px 8px', borderRadius: 4, fontSize: 12 }}>
              @Image2: {assetOf(inputs.outfitFront)?.name || '⚠️ Chưa chọn mặt trước'}
            </span>
            {isCase1 ? (
              <>
                <span className="badge" style={{ background: '#d97706', color: '#fff', padding: '3px 8px', borderRadius: 4, fontSize: 12 }}>
                  @Image3: {assetOf(inputs.outfitBack)?.name || '⚠️ Chưa chọn mặt sau'}
                </span>
                <span className="badge" style={{ background: '#db2777', color: '#fff', padding: '3px 8px', borderRadius: 4, fontSize: 12 }}>
                  @Image4: {assetOf(inputs.shoes)?.name || '⚠️ Chưa chọn giày'}
                </span>
                <span className="badge" style={{ background: '#4f46e5', color: '#fff', padding: '3px 8px', borderRadius: 4, fontSize: 12 }}>
                  @Image5: {assetOf(inputs.bag)?.name || '⚠️ Chưa chọn túi'}
                </span>
                <span className="badge" style={{ background: '#7c3aed', color: '#fff', padding: '3px 8px', borderRadius: 4, fontSize: 12 }}>
                  @Image6: {assetOf(inputs.background)?.name || '⚠️ Chưa chọn bối cảnh'}
                </span>
              </>
            ) : (
              <>
                <span className="badge" style={{ background: '#7c3aed', color: '#fff', padding: '3px 8px', borderRadius: 4, fontSize: 12 }}>
                  @Image3: {assetOf(inputs.background)?.name || '⚠️ Chưa chọn bối cảnh'}
                </span>
                <span className="badge" style={{ background: '#d97706', color: '#fff', padding: '3px 8px', borderRadius: 4, fontSize: 12 }}>
                  @Image4: {assetOf(inputs.outfitBack)?.name || '⚠️ Chưa chọn mặt sau'}
                </span>
              </>
            )}
          </div>
        </div>

        {showPromptEditor && (
          <div className="stack" style={{ background: 'var(--panel2)', padding: 12, borderRadius: 8 }}>
            <span className="small muted">
              Prompt 10s được gửi sang Flow Omni Flash với đầy đủ các phân đoạn 1s và thẻ định vị @Image:
            </span>
            <textarea
              rows={8}
              className="mono small"
              readOnly
              value={isCase1 ? wf.prompts.case1.text : wf.prompts.case2.text}
            />
          </div>
        )}

        <label className="check">
          <input
            type="checkbox"
            checked={removeWatermark}
            onChange={(e) => setRemoveWatermark(e.target.checked)}
          />
          <span>
            <b>Tự động xử lý xoá logo Gemini / Đè logo riêng sau khi tạo</b> (dùng Delogo hoặc Logo thương hiệu trong Cài đặt).
          </span>
        </label>

        <label className="check">
          <input
            type="checkbox"
            checked={autoPublish}
            onChange={(e) => setAutoPublish(e.target.checked)}
          />
          <span>
            <b>Tự động chuyển sang Đăng video</b> khi video render và xử lý xong.
          </span>
        </label>
      </div>

      {/* NÚT TẠO VIDEO */}
      <div className="row" style={{ alignItems: 'center', gap: 14 }}>
        <button
          className="primary big"
          disabled={busy || missing.length > 0}
          onClick={startRun}
        >
          {busy ? '… Đang xử lý' : '🎬 Tạo Video bán hàng thời trang (10s, Omni Flash)'}
        </button>
        {missing.length > 0 && (
          <span className="muted small">Cần chọn thêm: {missing.join(', ')}</span>
        )}
      </div>
      {error && <div className="err">{error}</div>}

      {/* LỊCH SỬ CÁC LẦN TẠO VIDEO */}
      <h2>Các video đã tạo</h2>
      {runs.length === 0 ? (
        <p className="muted">Chưa tạo video nào bằng quy trình này.</p>
      ) : (
        <div className="stack">
          {runs.map((r) => {
            const m = r.merge;
            const mainJob = state.jobs?.find((j) => j.runId === r.id && j.type === 'video');
            const videoUrl = m?.url || mainJob?.outputUrl;
            return (
              <div key={r.id} className="card stack">
                <div className="row between">
                  <div>
                    <b>{r.workflowName || 'Video bán hàng thời trang'}</b>{' '}
                    <small className="muted">· {new Date(r.createdAt).toLocaleString('vi-VN')}</small>
                  </div>
                  <Badge status={r.status} />
                </div>

                <div className="stages">
                  {r.stageList.map((s, idx) => (
                    <React.Fragment key={s.id}>
                      {idx > 0 && <span className="arrow">→</span>}
                      <span className={'stage ' + s.status} title={s.label}>
                        {s.status === 'done' ? '✓' : s.status === 'running' ? '⏳' : '○'} {s.label}
                      </span>
                    </React.Fragment>
                  ))}
                </div>

                {videoUrl && (
                  <div className="row" style={{ alignItems: 'flex-start', gap: 16 }}>
                    <figure className="mini" style={{ width: 140 }}>
                      <video src={videoUrl} controls preload="metadata" />
                    </figure>
                    <div className="stack" style={{ flex: 1 }}>
                      <b>Video hoàn chỉnh 10 giây</b>
                      <small className="muted">Lookbook thời trang chuẩn Hàn Quốc</small>
                      <div className="row" style={{ marginTop: 8 }}>
                        <a href={videoUrl} download={`${r.workflowName || 'video-thoi-trang'}.mp4`}>
                          ⬇ Tải về
                        </a>
                        {m?.id && (
                          <button
                            className="primary small-btn"
                            onClick={() => go('publish', [m.id])}
                          >
                            🚀 Đăng video ngay →
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {r.error && <div className="err small">{r.error}</div>}

                <div className="row between" style={{ borderTop: '1px solid var(--line)', paddingTop: 8 }}>
                  <ConfirmButton
                    disabled={r.status === 'running'}
                    armedText="Xoá lần chạy này?"
                    onConfirm={() => run(async () => { await api.deleteRun(r.id); await refresh(); })}
                  >
                    Xoá
                  </ConfirmButton>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* CỬA SỔ CẮT ẢNH TRỰC QUAN (CROP MODAL) */}
      {cropTarget && (
        <CropModal
          asset={cropTarget.asset}
          targetSlot={cropTarget.slot}
          onCropDone={(newAsset, slot) => {
            setInputs((s) => ({ ...s, [slot]: newAsset.id }));
            setCropTarget(null);
            refresh();
          }}
          onClose={() => setCropTarget(null)}
        />
      )}
    </section>
  );
}
