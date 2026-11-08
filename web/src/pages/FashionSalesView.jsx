import React, { useState, useEffect, useMemo } from 'react';
import { api } from '../api.js';
import { AssetPicker, ConfirmButton, useAction, Badge, PromptVersionPicker } from '../components.jsx';
import CropModal from '../components/CropModal.jsx';

const FASHION_DRAFT_KEY = 'fashion_sales_draft_v1';

function loadFashionDraft() {
  try {
    const raw = localStorage.getItem(FASHION_DRAFT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function sanitizeMentions(p, isCase1 = false) {
  if (!p) return '';
  let s = p;
  s = s.replace(/\bth?@+Image(\d+)/gi, 'the @Image$1');
  s = s.replace(/@+Image(\d+)/gi, '@Image$1');
  s = s.replace(/([^\s\n])@Image(\d+)/g, '$1 @Image$2');
  s = s.replace(/@Image(\d+)([a-zA-Z])/g, '@Image$1 $2');
  // Chỉ chèn @Image2 khi cả câu đó chưa có @Image2 (tránh "wears the @Image2 1:1 @Image2 outfit")
  s = s.replace(/(holds\s+the)\s+(?![^.\n]*@Image2)(.*?chest)/i, '$1 @Image2 $2');
  s = s.replace(/(wears\s+the)\s+(?![^.\n]*@Image2)(.*?on\s+bare\s+shoulders|.*?garment|.*?dress|.*?outfit)/i, '$1 @Image2 $2');
  s = s.replace(/(display\s+the\s+full)\s+(?![^.\n]*@Image2)/i, '$1 @Image2 ');
  const expectedBgTag = isCase1 ? '@Image6' : '@Image3';
  if (!s.includes(expectedBgTag)) {
    s = s.replace(/(Scene:\s*Consistent\s*background\s*using)\s*([^.\n]*)/i, `$1 ${expectedBgTag}.`);
  }
  s = s.replace(/[ \t]{2,}/g, ' ');
  return s.trim();
}

// Model + thời lượng Flow chọn riêng cho từng phân cảnh (giống danh sách FASHION_MODELS / FASHION_DURATIONS ở server)
const FLOW_MODELS = ['Omni 1.2 Flash', 'Omni 1.1 Flash', 'Veo 3.1 - Fast', 'Veo 3.1 - Quality', 'Veo 3.1 - Lite'];
const FLOW_DURATIONS = ['10s', '8s', '6s', '4s'];
function SceneFlowOptions({ model, duration, onModel, onDuration }) {
  const sel = { fontSize: 11, padding: '3px 6px' };
  return (
    <span className="row" style={{ gap: 6, alignItems: 'center' }} title="Mô hình video và thời lượng trên Flow cho riêng phân cảnh này (không theo Cài đặt chung)">
      <span className="small muted">Flow:</span>
      <select value={model} onChange={(e) => onModel(e.target.value)} style={sel} title="Mô hình video trên Flow">
        {FLOW_MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
      </select>
      <select value={duration} onChange={(e) => onDuration(e.target.value)} style={sel} title="Thời lượng video (Omni Flash)">
        {FLOW_DURATIONS.map((d) => <option key={d} value={d}>{d}</option>)}
      </select>
    </span>
  );
}

export default function FashionSalesView({ wf, state, refresh, go }) {
  const savedDraft = useMemo(() => loadFashionDraft(), []);

  const savedPrompts = state?.settings?.workflows?.[wf.id]?.prompts || {};
  // 'case1' (Full outfit) | 'case2' (Chỉ trang phục) | 'case3' (Áo dài: như TH2 nhưng prompt gốc riêng, cảnh 2 10s)
  const [caseMode, setCaseMode] = useState(() => savedDraft?.caseMode || 'case2');
  const isAoDai = caseMode === 'case3';
  const keyScene1 = isAoDai ? 'case3_scene1' : 'case2_scene1';
  const keyScene2 = isAoDai ? 'case3_scene2' : 'case2_scene2';
  const sceneKeysOf = (mode) => (mode === 'case3' ? ['case3_scene1', 'case3_scene2'] : ['case2_scene1', 'case2_scene2']);
  const basePromptOf = (key) => savedPrompts[key] || wf.prompts?.[key]?.text || '';
  const baseScene1Prompt = basePromptOf(keyScene1);
  const baseScene2Prompt = basePromptOf(keyScene2);
  const baseCase1Prompt = savedPrompts.case1 || wf.prompts?.case1?.text || '';
  // Model + thời lượng Flow cho từng phân cảnh, chọn ngay trong module (không theo Cài đặt chung). TH1 dùng của cảnh 1.
  const [scene1Model, setScene1Model] = useState(() => savedDraft?.scene1Model || FLOW_MODELS[0]);
  const [scene1Duration, setScene1Duration] = useState(() => savedDraft?.scene1Duration || '10s');
  const [scene2Model, setScene2Model] = useState(() => savedDraft?.scene2Model || FLOW_MODELS[0]);
  const [scene2Duration, setScene2Duration] = useState(() => savedDraft?.scene2Duration || (savedDraft?.caseMode === 'case3' ? '10s' : '6s'));
  const defaultBackPrompt =
    state?.defaults?.backViewPrompt ||
    `Create a clean, photorealistic product photo of the BACK VIEW of the exact clothing garment shown in the reference image (front view). Keep the same color, fabric, pattern, texture, neckline style from the back, sleeve length, hemline, and design language. Show the back details naturally (e.g. back zipper, back seams, back cut, back buttons) faithful to the front garment's style. Present the back-view garment cleanly on a plain, neutral, evenly lit white studio background, front-to-back perspective, fully visible, centered, with no person, no mannequin, no hangers, no text or props.`;

  const [inputs, setInputs] = useState(() => savedDraft?.inputs || {
    model: null,
    background: null,
    outfitSheet: null,
    outfitFront: null,
    outfitBack: null,
    shoes: null,
    bag: null,
  });

  const [cropTarget, setCropTarget] = useState(null); // { asset, slot }
  const [backOption, setBackOption] = useState(() => savedDraft?.backOption || 'generate'); // 'cleanFront' | 'cleanBack' | 'generate'
  const [backPrompt, setBackPrompt] = useState(() => savedDraft?.backPrompt || defaultBackPrompt);

  const [showPromptEditor, setShowPromptEditor] = useState(() => savedDraft?.showPromptEditor ?? true);
  const [removeWatermark, setRemoveWatermark] = useState(() => savedDraft?.removeWatermark ?? (state.settings?.removeWatermark !== false));
  const [autoPublish, setAutoPublish] = useState(() => savedDraft?.autoPublish ?? true);
  const [keepAudio, setKeepAudio] = useState(() => savedDraft?.keepAudio ?? true);
  const [pendingBackJobId, setPendingBackJobId] = useState(null);
  const [backMsg, setBackMsg] = useState(() => savedDraft?.backMsg || null);

  // Mã sản phẩm in lên video (thay "TODAY'S OUTFIT"): theo ảnh mặt trước, server cấp VAY_01, VAY_02… và lưu lên ảnh
  const [productCode, setProductCode] = useState(() => savedDraft?.productCode || '');
  const [codeMsg, setCodeMsg] = useState(null);
  const [codeList, setCodeList] = useState(null); // { codes, text } khi bấm "Xem danh sách mã"
  const [productDescription, setProductDescription] = useState(() => savedDraft?.productDescription || '');
  const [productDetails, setProductDetails] = useState(() => savedDraft?.productDetails || null);
  const [scene1FromApi, setScene1FromApi] = useState(() => savedDraft?.scene1FromApi ?? false);
  const [scene2FromApi, setScene2FromApi] = useState(() => savedDraft?.scene2FromApi ?? false);
  const [case1FromApi, setCase1FromApi] = useState(() => savedDraft?.case1FromApi ?? false);
  const [saveNotice, setSaveNotice] = useState(null);

  const [promptScene1, setPromptScene1] = useState(() => sanitizeMentions(savedDraft?.promptScene1 || baseScene1Prompt, false));
  const [promptScene2, setPromptScene2] = useState(() => {
    const raw = savedDraft?.promptScene2;
    if (!raw || (raw.includes('Strictly lock 100% facial identity') && !raw.includes('color grading'))) {
      return baseScene2Prompt;
    }
    return sanitizeMentions(raw, false);
  });
  const [customCase1Prompt, setCustomCase1Prompt] = useState(() => sanitizeMentions(savedDraft?.customCase1Prompt || baseCase1Prompt, true));
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analyzeMsg, setAnalyzeMsg] = useState(() => savedDraft?.analyzeMsg || null);

  useEffect(() => {
    if (!promptScene1 && baseScene1Prompt) {
      setPromptScene1(baseScene1Prompt);
    }
    if ((!promptScene2 || (promptScene2.includes('Strictly lock 100% facial identity') && !promptScene2.includes('color grading'))) && baseScene2Prompt) {
      setPromptScene2(baseScene2Prompt);
    }
    if (!customCase1Prompt && baseCase1Prompt) {
      setCustomCase1Prompt(baseCase1Prompt);
    }
  }, [baseScene1Prompt, baseScene2Prompt, baseCase1Prompt]);

  // Tự động lưu toàn bộ dữ liệu & prompt vào localStorage
  useEffect(() => {
    try {
      const dataToSave = {
        inputs,
        caseMode,
        backOption,
        backPrompt,
        showPromptEditor,
        removeWatermark,
        autoPublish,
        keepAudio,
        scene1FromApi,
        scene2FromApi,
        case1FromApi,
        productDescription,
        productDetails,
        promptScene1,
        promptScene2,
        customCase1Prompt,
        analyzeMsg,
        backMsg,
        scene1Model,
        scene1Duration,
        scene2Model,
        scene2Duration,
        productCode,
      };
      localStorage.setItem(FASHION_DRAFT_KEY, JSON.stringify(dataToSave));
    } catch (e) {
      console.warn('Lỗi lưu nháp FashionSalesView:', e);
    }
  }, [
    inputs,
    caseMode,
    backOption,
    backPrompt,
    showPromptEditor,
    removeWatermark,
    autoPublish,
    keepAudio,
    scene1FromApi,
    scene2FromApi,
    case1FromApi,
    productDescription,
    productDetails,
    promptScene1,
    promptScene2,
    customCase1Prompt,
    analyzeMsg,
    backMsg,
    scene1Model,
    scene1Duration,
    scene2Model,
    scene2Duration,
    productCode,
  ]);

  const isScene1Custom = promptScene1.trim() !== baseScene1Prompt.trim();
  const isScene2Custom = promptScene2.trim() !== baseScene2Prompt.trim();
  const isCase1Custom = customCase1Prompt.trim() !== baseCase1Prompt.trim();
  const isBackCustom = backPrompt.trim() !== defaultBackPrompt.trim();

  // Xác định chính xác trạng thái prompt đã render từ AI hay đang ở prompt gốc
  const isScene1FromApi = scene1FromApi || (!!(productDetails || productDescription || analyzeMsg?.type === 'success') && isScene1Custom);
  const isScene2FromApi = scene2FromApi || (!!(productDetails || productDescription || analyzeMsg?.type === 'success') && isScene2Custom);
  const isCase1FromApi = case1FromApi;

  // Đổi trường hợp: TH2 <-> TH3 có bộ prompt gốc riêng -> nạp prompt gốc của TH mới vào 2 ô soạn
  // (hỏi trước nếu đang có prompt sửa dở / prompt do Gemini render), và đặt thời lượng cảnh 2 mặc định (TH2 6s, TH3 10s)
  const switchCase = (next) => {
    if (next === caseMode) return;
    const twoScenes = (m) => m === 'case2' || m === 'case3';
    if (twoScenes(caseMode) && twoScenes(next)) {
      const dirty = isScene1Custom || isScene2Custom || scene1FromApi || scene2FromApi;
      if (dirty && !window.confirm('Chuyển trường hợp sẽ thay 2 prompt phân cảnh đang soạn bằng prompt gốc của trường hợp mới (nội dung chưa lưu sẽ mất). Tiếp tục?')) return;
      const [k1, k2] = sceneKeysOf(next);
      setPromptScene1(basePromptOf(k1));
      setPromptScene2(basePromptOf(k2));
      setScene1FromApi(false);
      setScene2FromApi(false);
      setScene2Duration(next === 'case3' ? '10s' : '6s');
    }
    setCaseMode(next);
  };

  // Reset toàn bộ prompt về gốc
  const handleResetAllPrompts = () => {
    setPromptScene1(baseScene1Prompt);
    setPromptScene2(baseScene2Prompt);
    setCustomCase1Prompt(baseCase1Prompt);
    setScene1FromApi(false);
    setScene2FromApi(false);
    setCase1FromApi(false);
    setProductDetails(null);
    setProductDescription('');
    setAnalyzeMsg(null);
  };

  // Reset từng prompt riêng lẻ về prompt gốc
  const handleResetScene1 = () => {
    setPromptScene1(baseScene1Prompt);
    setScene1FromApi(false);
    if (!scene2FromApi) {
      setProductDetails(null);
      setProductDescription('');
      setAnalyzeMsg(null);
    }
  };

  const handleResetScene2 = () => {
    setPromptScene2(baseScene2Prompt);
    setScene2FromApi(false);
    if (!scene1FromApi) {
      setProductDetails(null);
      setProductDescription('');
      setAnalyzeMsg(null);
    }
  };

  const handleResetCase1 = () => {
    setCustomCase1Prompt(baseCase1Prompt);
    setCase1FromApi(false);
  };

  // Lưu nội dung prompt đang soạn thành Prompt gốc của hệ thống
  const handleSaveScene1AsBase = () =>
    run(async () => {
      if (!promptScene1?.trim()) throw new Error('Prompt Cảnh 1 không được để trống');
      const currentSaved = state?.settings?.workflows?.[wf.id]?.prompts || {};
      await api.saveSettings({
        workflows: {
          [wf.id]: {
            prompts: {
              ...currentSaved,
              [keyScene1]: promptScene1.trim(),
            },
          },
        },
      });
      await refresh();
      setSaveNotice({ key: 'scene1', text: '✓ Đã lưu thành công làm Prompt gốc mới cho Cảnh 1!' });
      setTimeout(() => setSaveNotice(null), 3500);
    });

  const handleSaveScene2AsBase = () =>
    run(async () => {
      if (!promptScene2?.trim()) throw new Error('Prompt Cảnh 2 không được để trống');
      const currentSaved = state?.settings?.workflows?.[wf.id]?.prompts || {};
      await api.saveSettings({
        workflows: {
          [wf.id]: {
            prompts: {
              ...currentSaved,
              [keyScene2]: promptScene2.trim(),
            },
          },
        },
      });
      await refresh();
      setSaveNotice({ key: 'scene2', text: '✓ Đã lưu thành công làm Prompt gốc mới cho Cảnh 2!' });
      setTimeout(() => setSaveNotice(null), 3500);
    });

  const handleSaveCase1AsBase = () =>
    run(async () => {
      if (!customCase1Prompt?.trim()) throw new Error('Prompt TH1 không được để trống');
      const currentSaved = state?.settings?.workflows?.[wf.id]?.prompts || {};
      await api.saveSettings({
        workflows: {
          [wf.id]: {
            prompts: {
              ...currentSaved,
              case1: customCase1Prompt.trim(),
            },
          },
        },
      });
      await refresh();
      setSaveNotice({ key: 'case1', text: '✓ Đã lưu thành công làm Prompt gốc mới cho TH1!' });
      setTimeout(() => setSaveNotice(null), 3500);
    });

  const handleRestoreSystemDefault = (key) =>
    run(async () => {
      const currentSaved = { ...(state?.settings?.workflows?.[wf.id]?.prompts || {}) };
      delete currentSaved[key];
      await api.saveSettings({
        workflows: {
          [wf.id]: {
            prompts: currentSaved,
          },
        },
      });
      await refresh();
      if (key === keyScene1) {
        const factory = wf.prompts?.[keyScene1]?.factoryText || wf.prompts?.[keyScene1]?.text;
        setPromptScene1(factory);
        setScene1FromApi(false);
      } else if (key === keyScene2) {
        const factory = wf.prompts?.[keyScene2]?.factoryText || wf.prompts?.[keyScene2]?.text;
        setPromptScene2(factory);
        setScene2FromApi(false);
      } else if (key === 'case1') {
        const factory = wf.prompts?.case1?.factoryText || wf.prompts?.case1?.text;
        setCustomCase1Prompt(factory);
        setCase1FromApi(false);
      }
      setSaveNotice({ key, text: '✓ Đã khôi phục về prompt mẫu mặc định gốc của hệ thống!' });
      setTimeout(() => setSaveNotice(null), 3500);
    });

  const handleResetBackPrompt = () => {
    setBackPrompt(defaultBackPrompt);
    setBackMsg({ type: 'ok', text: 'Đã khôi phục Prompt sinh ảnh mặt sau về mẫu gốc.' });
  };

  const handleClearAnalysis = () => {
    setProductDescription('');
    setProductDetails(null);
    setAnalyzeMsg(null);
  };

  const handleResetAllDraft = () => {
    if (window.confirm('Bạn có chắc muốn xoá toàn bộ dữ liệu đang chọn và các prompt đã render để làm mới từ đầu?')) {
      localStorage.removeItem(FASHION_DRAFT_KEY);
      setInputs({
        model: null,
        background: null,
        outfitSheet: null,
        outfitFront: null,
        outfitBack: null,
        shoes: null,
        bag: null,
      });
      setProductDescription('');
      setProductDetails(null);
      setProductCode('');
      setCodeMsg(null);
      setPromptScene1(baseScene1Prompt);
      setPromptScene2(baseScene2Prompt);
      setCustomCase1Prompt(baseCase1Prompt);
      setBackPrompt(defaultBackPrompt);
      setKeepAudio(true);
      setScene1FromApi(false);
      setScene2FromApi(false);
      setCase1FromApi(false);
      setAnalyzeMsg(null);
      setBackMsg(null);
    }
  };

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

  // Cấu hình sẵn Flow theo model / thời lượng của cảnh 1 khi vào module (và khi người dùng đổi lựa chọn)
  useEffect(() => {
    api.flowPreset({ model: scene1Model, duration: scene1Duration }).catch(() => {});
  }, [scene1Model, scene1Duration]);

  // Khi chọn ảnh mặt trước mới: nếu đã có sẵn ảnh mặt sau của nó mà ô mặt sau đang trống thì tự động gắn luôn
  useEffect(() => {
    if (inputs.outfitFront && !inputs.outfitBack && generatedBacks.length > 0) {
      setInputs((s) => ({ ...s, outfitBack: generatedBacks[0].id }));
      setBackMsg({ type: 'ok', text: `Đã tự động gắn ảnh mặt sau đã tạo trước đó: "${generatedBacks[0].name}"` });
    }
  }, [inputs.outfitFront, generatedBacks.length]);

  // Mã sản phẩm theo ảnh mặt trước: ảnh đã có mã -> lấy mã đó; chưa có -> server cấp mã mới (VAY_01, VAY_02…)
  const normalizeCodeInput = (v) =>
    String(v || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd').replace(/Đ/g, 'D')
      .toUpperCase()
      .replace(/[\s.]+/g, '_')
      .replace(/[^A-Z0-9_-]/g, '');
  const isValidCode = (c) => /^[A-Z0-9]+(?:_[A-Z0-9-]+)+$/.test(c || '');
  useEffect(() => {
    if (!inputs.outfitFront) return;
    const a = assetOf(inputs.outfitFront);
    if (!a) return;
    if (a.productCode) {
      setProductCode(a.productCode);
      return;
    }
    let cancelled = false;
    api.assignCode(a.id)
      .then((res) => {
        if (cancelled) return;
        setProductCode(res.productCode || '');
        setCodeMsg({ type: 'ok', text: `Đã cấp mã ${res.productCode} cho ảnh "${a.name}"` });
        refresh();
      })
      .catch((e) => !cancelled && setCodeMsg({ type: 'err', text: `Không cấp được mã: ${e.message}` }));
    return () => { cancelled = true; };
  }, [inputs.outfitFront]);

  // Người dùng sửa mã trong ô -> lưu lên ảnh mặt trước (mã trùng ảnh khác thì báo lỗi, giữ mã cũ)
  const commitCode = () =>
    run(async () => {
      const c = normalizeCodeInput(productCode);
      setProductCode(c);
      if (!inputs.outfitFront) return;
      if (!isValidCode(c)) {
        setCodeMsg({ type: 'err', text: 'Mã phải có dạng LOAI_SO, vd. VAY_01 (không dấu, in hoa)' });
        return;
      }
      const a = assetOf(inputs.outfitFront);
      if (a?.productCode === c) return;
      try {
        const res = await api.assignCode(inputs.outfitFront, c);
        setProductCode(res.productCode);
        setCodeMsg({ type: 'ok', text: `Đã lưu mã ${res.productCode} cho ảnh mặt trước` });
        await refresh();
      } catch (e) {
        setCodeMsg({ type: 'err', text: e.message });
        if (a?.productCode) setProductCode(a.productCode);
      }
    });

  const handleImportCodes = (file) =>
    run(async () => {
      if (!file) return;
      const text = await file.text();
      const r = await api.importCodes(text);
      const inv = r.invalid?.length ? ` Bỏ qua ${r.invalid.length} mã sai dạng (${r.invalid.slice(0, 3).join(', ')}${r.invalid.length > 3 ? '…' : ''}).` : '';
      setCodeMsg({ type: 'ok', text: `Đã nhập ${r.added} mã mới, ${r.skipped} mã đã có sẵn. Sổ hiện có ${r.total} mã.${inv}` });
      if (codeList) setCodeList(await api.codes());
    });

  const toggleCodeList = () =>
    run(async () => {
      if (codeList) { setCodeList(null); return; }
      setCodeList(await api.codes());
    });

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
  if (!isValidCode(normalizeCodeInput(productCode))) missing.push('Mã sản phẩm (dạng VAY_01)');

  // Khởi tạo chạy workflow
  const startRun = () =>
    run(async () => {
      await api.createRun({
        workflowId: wf.id,
        inputs,
        options: {
          caseMode,
          promptScene1: !isCase1 ? sanitizeMentions(promptScene1, false) : undefined,
          promptScene2: !isCase1 ? sanitizeMentions(promptScene2, false) : undefined,
          customPrompt: isCase1 ? sanitizeMentions(customCase1Prompt, true) : undefined,
          scene1Model,
          scene1Duration,
          scene2Model,
          scene2Duration,
          productCode: normalizeCodeInput(productCode),
          removeWatermark,
          autoPublish,
          keepAudio,
        },
        prompts: {
          case1: sanitizeMentions(customCase1Prompt, true),
          [keyScene1]: sanitizeMentions(promptScene1, false),
          [keyScene2]: sanitizeMentions(promptScene2, false),
        },
      });
      await refresh();
    });

  // Phân tích sản phẩm bằng Gemini và tự động dựng 2 prompt phân cảnh
  const handleAnalyzeAndGeneratePrompts = () =>
    run(async () => {
      if (!inputs.outfitFront) throw new Error('Vui lòng chọn ảnh Trang phục – Mặt trước trước khi phân tích');
      if (!inputs.outfitBack) throw new Error('Vui lòng chọn ảnh Trang phục – Mặt sau trước khi phân tích');
      setIsAnalyzing(true);
      setAnalyzeMsg({ type: 'loading', text: '⏳ Đang gọi Gemini AI phân tích 2 ảnh mặt trước/sau và viết lại lời thoại (Voice) cho 2 phân cảnh...' });
      try {
        const res = await api.analyzeFashionGarment({
          frontAssetId: inputs.outfitFront,
          backAssetId: inputs.outfitBack,
          // Luôn dựng từ PROMPT GỐC (bản đã lưu / mặc định), không từ ô đang soạn: ô soạn thường còn prompt của sản phẩm
          // trước (Gemini render lần trước) nên nếu đưa vào sẽ "dính" mô tả bộ đồ cũ. Muốn đổi mẫu thì Lưu lại prompt gốc trước.
          basePromptScene1: baseScene1Prompt,
          basePromptScene2: baseScene2Prompt,
          caseMode,
        });
        if (res.productDescription) setProductDescription(res.productDescription);
        if (res.productData) setProductDetails(res.productData);
        if (res.promptScene1) {
          setPromptScene1(sanitizeMentions(res.promptScene1, false));
          setScene1FromApi(true);
        }
        if (res.promptScene2) {
          setPromptScene2(sanitizeMentions(res.promptScene2, false));
          setScene2FromApi(true);
        }
        setShowPromptEditor(true);
        setAnalyzeMsg({
          type: 'success',
          text: '✨ Đã phân tích sản phẩm và viết lại lời thoại cho 2 phân cảnh (phần tiếng Anh giữ nguyên prompt gốc). Bạn có thể xem và chỉnh sửa trực tiếp bên dưới.',
        });
      } catch (e) {
        setAnalyzeMsg({ type: 'error', text: `❌ Lỗi phân tích Gemini: ${e.message}` });
        throw e;
      } finally {
        setIsAnalyzing(false);
      }
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
      <div className="row between" style={{ alignItems: 'flex-start' }}>
        <div>
          <h1>🛍️ {wf.name}</h1>
          <p className="muted" style={{ margin: 0 }}>
            Tạo video bán hàng thời trang phong cách lookbook Hàn Quốc tự động bằng Google Flow (model và thời lượng chọn riêng cho từng phân cảnh).
            Tự động phối hợp người mẫu, bối cảnh, trang phục, giày, túi và xoá logo Gemini thành phẩm.
          </p>
        </div>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <span className="small muted" title="Dữ liệu nguyên liệu và prompt mới render được tự động lưu vào bộ nhớ, không lo bị mất khi chuyển qua Cài đặt hoặc module khác">
            💾 Tự động lưu nháp
          </span>
          <button
            type="button"
            className="small"
            onClick={handleResetAllDraft}
            title="Xoá toàn bộ dữ liệu đang chọn và reset prompt về mặc định ban đầu"
          >
            🗑️ Làm mới (Reset nháp)
          </button>
        </div>
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
                onChange={() => switchCase('case1')}
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
                onChange={() => switchCase('case2')}
              />
              <span>
                <b>Trường hợp 2: Chỉ Trang phục</b> (Mặt trước + Mặt sau)
              </span>
            </label>
            <label className="check">
              <input
                type="radio"
                name="caseMode"
                checked={caseMode === 'case3'}
                onChange={() => switchCase('case3')}
              />
              <span>
                <b>Trường hợp 3: Áo dài</b> (như TH2, prompt riêng cho áo dài, 2 cảnh 10s + 10s)
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
                  <div className="row between" style={{ alignItems: 'center' }}>
                    <span className="small"><b>Prompt sinh ảnh mặt sau (tiếng Anh):</b></span>
                    {isBackCustom && (
                      <button
                        type="button"
                        className="small"
                        onClick={handleResetBackPrompt}
                        style={{ padding: '2px 8px', fontSize: 11 }}
                        title="Khôi phục Prompt mặt sau về mẫu gốc"
                      >
                        🔄 Reset prompt mặt sau về gốc
                      </button>
                    )}
                  </div>
                  <textarea
                    rows={3}
                    className="mono small"
                    value={backPrompt}
                    onChange={(e) => setBackPrompt(e.target.value)}
                  />
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

      {/* KHỐI MÃ SẢN PHẨM: in lên video thay chữ "TODAY'S OUTFIT" */}
      <div className="card stack">
        <div className="row between" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <b>🏷️ Mã sản phẩm in trên video</b>
          <div className="row" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <a className="small" href="/api/codes/export" download="ma-san-pham.txt" title="Tải file .txt chứa mọi mã đã dùng trên máy này (cách nhau dấu phẩy) để đưa cho người khác nhập vào">
              📤 Xuất mã (.txt)
            </a>
            <label className="small" style={{ cursor: 'pointer' }} title="Nhập file .txt mã của máy khác: các mã đó được coi là đã dùng, mã cấp mới sẽ nhảy qua để không trùng">
              📥 Nhập mã (.txt)
              <input type="file" accept=".txt,text/plain" style={{ display: 'none' }} onChange={(e) => { handleImportCodes(e.target.files?.[0]); e.target.value = ''; }} />
            </label>
            <a className="small" onClick={toggleCodeList}>{codeList ? 'Ẩn danh sách mã' : 'Xem danh sách mã'}</a>
          </div>
        </div>
        <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            className="mono"
            style={{ width: 200, fontWeight: 700, letterSpacing: 1 }}
            placeholder="VAY_01"
            value={productCode}
            disabled={!inputs.outfitFront}
            onChange={(e) => setProductCode(normalizeCodeInput(e.target.value))}
            onBlur={commitCode}
            onKeyDown={(e) => e.key === 'Enter' && e.target.blur()}
            title="Mã của ảnh mặt trước đang chọn. Sửa được (không dấu, in hoa, dạng LOAI_SO); rời ô để lưu lên ảnh."
          />
          <span className="small muted">
            {inputs.outfitFront
              ? <>Mã gắn với ảnh mặt trước <b>{frontAsset?.name}</b>. Chữ <code>"TODAY'S OUTFIT"</code> trong prompt sẽ được thay bằng mã này khi gửi Flow. Chọn ảnh mặt trước khác → mã khác; ảnh mới chưa có mã → tự cấp số tiếp theo.</>
              : 'Chọn ảnh Trang phục – Mặt trước ở trên, app sẽ tự cấp mã (VAY_01, VAY_02…) hoặc lấy lại mã đã cấp cho ảnh đó.'}
          </span>
        </div>
        {codeMsg && (
          <div
            className="small"
            style={{
              padding: '6px 10px',
              borderRadius: 6,
              background: codeMsg.type === 'err' ? 'rgba(239, 93, 93, 0.15)' : 'rgba(63, 191, 127, 0.15)',
              border: `1px solid ${codeMsg.type === 'err' ? 'var(--red)' : 'var(--green)'}`,
              color: codeMsg.type === 'err' ? 'var(--red)' : 'var(--green)',
            }}
          >
            {codeMsg.text}
          </div>
        )}
        {codeList && (
          <div className="stack gap-xs" style={{ background: 'var(--panel2)', padding: 10, borderRadius: 6 }}>
            <span className="small muted"><b>Sổ mã trên máy này ({codeList.codes.length}):</b> mã đã cấp cho ảnh, mã sửa tay và mã nhập từ file .txt</span>
            <textarea className="mono small" rows={3} readOnly value={codeList.text} onFocus={(e) => e.target.select()} />
            {codeList.codes.length > 0 && (
              <div className="row wrap" style={{ gap: 6 }}>
                {codeList.codes.map((c) => (
                  <span key={c.code} className="badge" title={c.assetName ? `Ảnh: ${c.assetName}` : c.source === 'import' ? 'Nhập từ file .txt' : ''}
                    style={{ background: c.source === 'import' ? '#475569' : '#059669', color: '#fff', fontSize: 11, padding: '2px 8px', borderRadius: 4 }}>
                    {c.code}{c.source === 'import' ? ' (nhập)' : ''}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
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

        {/* KHỐI PHÂN TÍCH SẢN PHẨM & DỰNG 2 PROMPT (GEMINI) CHO TRƯỜNG HỢP 2 */}
        {!isCase1 && (
          <div className="card" style={{ background: 'var(--panel2)', padding: 14, borderRadius: 8, border: '1px solid var(--border)' }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <b>🤖 Phân tích Sản phẩm & Dựng 2 Prompt bằng Gemini AI</b>
              <button
                type="button"
                className="primary small"
                disabled={busy || isAnalyzing || !inputs.outfitFront || !inputs.outfitBack}
                onClick={handleAnalyzeAndGeneratePrompts}
              >
                {isAnalyzing ? '⏳ Đang phân tích...' : '✨ Phân tích Sản phẩm & Dựng 2 Prompt'}
              </button>
            </div>
            <div className="small muted" style={{ marginBottom: 10 }}>
              Gemini sẽ xem cả 2 ảnh Mặt trước & Mặt sau để trích xuất Mô tả sản phẩm, sau đó CHỈ viết lại các câu lời thoại <code>Voice: "..."</code> trong [Prompt gốc Cảnh 1 & Cảnh 2] cho khớp sản phẩm và hành động của từng mốc giây. Phần tiếng Anh (Setup, mốc giây, hành động, @Image, Technical Rule) giữ nguyên 100% prompt gốc; <code>Voice: [Silent]</code> không đổi.
            </div>

            {analyzeMsg && (
              <div
                className={`small ${analyzeMsg.type === 'error' ? 'err' : 'alert'}`}
                style={{ padding: '8px 12px', borderRadius: 6, marginBottom: 10 }}
              >
                {analyzeMsg.text}
              </div>
            )}

            {productDescription && (
              <div className="stack" style={{ background: 'var(--bg)', padding: 12, borderRadius: 6, marginBottom: 10 }}>
                <div className="row between" style={{ alignItems: 'center', marginBottom: 6 }}>
                  <div className="row wrap" style={{ gap: 6 }}>
                    {productDetails?.category && (
                      <span className="badge" style={{ background: '#0284c7', color: '#fff' }}>
                        Phân loại: {productDetails.category}
                      </span>
                    )}
                    {productDetails?.color && (
                      <span className="badge" style={{ background: '#8b5cf6', color: '#fff' }}>
                        Màu sắc: {productDetails.color}
                      </span>
                    )}
                    {productDetails?.fabric && (
                      <span className="badge" style={{ background: '#10b981', color: '#fff' }}>
                        Chất vải: {productDetails.fabric}
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    className="small"
                    onClick={handleClearAnalysis}
                    style={{ padding: '2px 8px', fontSize: 11 }}
                    title="Xoá mô tả phân tích này"
                  >
                    ✕ Xoá mô tả
                  </button>
                </div>
                {productDetails?.frontDetails?.length > 0 && (
                  <div className="small">
                    <b>Điểm nhấn Mặt trước:</b> {productDetails.frontDetails.join(' • ')}
                  </div>
                )}
                {productDetails?.backDetails?.length > 0 && (
                  <div className="small">
                    <b>Điểm nhấn Mặt sau:</b> {productDetails.backDetails.join(' • ')}
                  </div>
                )}
                <div className="small muted" style={{ marginTop: 4 }}>
                  <b>Mô tả tổng quan:</b> {productDescription}
                </div>
              </div>
            )}
          </div>
        )}

        {/* KHUNG SOẠN THẢO / KIỂM TRA PROMPT TRƯỚC KHI TẠO */}
        {showPromptEditor && (
          <div className="stack" style={{ background: 'var(--panel2)', padding: 14, borderRadius: 8 }}>
            {!isCase1 ? (
              <>
                <div className="row between" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                  <b>📝 Kiểm tra & Chỉnh sửa Prompt 2 Phân cảnh:</b>
                  <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                    {(isScene1Custom || isScene2Custom || scene1FromApi || scene2FromApi) && (
                      <button
                        type="button"
                        className="small"
                        onClick={handleResetAllPrompts}
                        title="Khôi phục toàn bộ 2 prompt phân cảnh về prompt gốc"
                      >
                        🔄 Quay lại tất cả về prompt gốc
                      </button>
                    )}
                  </div>
                </div>

                {saveNotice && (
                  <div style={{ background: '#dcfce7', color: '#166534', padding: '8px 12px', borderRadius: 6, fontWeight: 500, fontSize: 12, border: '1px solid #86efac', marginTop: 6 }}>
                    {saveNotice.text}
                  </div>
                )}

                <div className="stack" style={{ marginTop: 8 }}>
                  <div className="row between" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
                    <label className="small" style={{ margin: 0 }}>
                      <b>🎬 Phân cảnh 1: Mặt trước ({scene1Duration.replace('s', ' giây')} – Chế độ Thành phần{isAoDai ? ' – Áo dài' : ''})</b>
                    </label>
                    <SceneFlowOptions model={scene1Model} duration={scene1Duration} onModel={setScene1Model} onDuration={setScene1Duration} />
                    <div className="row" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                      {isScene1FromApi ? (
                        <>
                          <span className="badge" style={{ background: '#7c3aed', color: '#fff', fontSize: 11, padding: '2px 8px', borderRadius: 4 }} title="Prompt mới đã render từ Gemini AI cho sản phẩm này (Không có nút lưu prompt để bảo vệ prompt gốc ban đầu)">
                            ✨ Prompt mới đã render (Gemini AI)
                          </span>
                          <button
                            type="button"
                            className="small"
                            onClick={handleResetScene1}
                            style={{ padding: '2px 8px', fontSize: 11 }}
                            title="Khôi phục lại prompt gốc ban đầu (sau khi quay lại prompt gốc, bạn có thể chỉnh sửa và lưu prompt gốc mới)"
                          >
                            🔄 Quay lại prompt gốc
                          </button>
                        </>
                      ) : (
                        <>
                          {isScene1Custom ? (
                            <>
                              <span className="badge" style={{ background: '#f59e0b', color: '#fff', fontSize: 11, padding: '2px 8px', borderRadius: 4 }} title="Bạn vừa chỉnh sửa nội dung prompt gốc">
                                ✏️ Đã chỉnh sửa prompt gốc
                              </span>
                              <button
                                type="button"
                                className="small"
                                disabled={busy || !promptScene1.trim()}
                                onClick={handleSaveScene1AsBase}
                                style={{ padding: '4px 12px', fontSize: 11, background: '#16a34a', color: '#fff', border: 'none', borderRadius: 4, fontWeight: 700, cursor: 'pointer', boxShadow: '0 1px 3px rgba(0,0,0,0.2)' }}
                                title="Lưu nội dung bạn vừa chỉnh sửa thành Prompt gốc mới của hệ thống. Lần sau hoặc khi bấm 'Quay lại prompt gốc' sẽ dùng prompt này."
                              >
                                💾 Lưu lại prompt gốc
                              </button>
                              <button
                                type="button"
                                className="small"
                                onClick={handleResetScene1}
                                style={{ padding: '2px 8px', fontSize: 11 }}
                                title="Huỷ các thay đổi vừa gõ và khôi phục về prompt gốc hiện hành"
                              >
                                🔄 Huỷ thay đổi
                              </button>
                            </>
                          ) : (
                            <>
                              <span className="badge" style={{ background: '#475569', color: '#cbd5e1', fontSize: 11, padding: '2px 8px', borderRadius: 4 }}>
                                📄 Đang ở prompt gốc {savedPrompts[keyScene1] ? '(Riêng)' : '(Mặc định)'}
                              </span>
                              {savedPrompts[keyScene1] && (
                                <button
                                  type="button"
                                  className="small"
                                  disabled={busy}
                                  onClick={() => handleRestoreSystemDefault(keyScene1)}
                                  style={{ padding: '2px 6px', fontSize: 10, color: 'var(--muted)', background: 'transparent', border: '1px solid var(--line)' }}
                                  title="Khôi phục về mẫu gốc ban đầu lúc mới cài đặt của hệ thống"
                                >
                                  Khôi phục mặc định hệ thống
                                </button>
                              )}
                            </>
                          )}
                        </>
                      )}
                      <PromptVersionPicker wfId={wf.id} promptKey={keyScene1} reload={savedPrompts[keyScene1] || ''} onRestored={(t) => { setPromptScene1(t); setScene1FromApi(false); refresh(); setSaveNotice({ key: 'scene1', text: '✓ Đã quay lại phiên bản prompt cũ cho Cảnh 1 (bản vừa rồi đã được lưu thành phiên bản).' }); setTimeout(() => setSaveNotice(null), 3500); }} />
                    </div>
                  </div>
                  <span className="muted" style={{ display: 'block', fontSize: 11, marginTop: 2 }}>
                    Người mẫu mặc/giơ áo, giới thiệu chất vải và đường may mặt trước. Sử dụng @Image1 (model), @Image2 (mặt trước), @Image3 (bối cảnh), @Image4 (mặt sau).
                  </span>
                  <textarea
                    rows={7}
                    className="mono small"
                    value={promptScene1}
                    onChange={(e) => setPromptScene1(e.target.value)}
                    placeholder="Nhập prompt cho Phân cảnh 1..."
                  />

                  {/* Kiểm tra và hiển thị các thẻ mention @Image */}
                  <div className="row wrap" style={{ gap: 6, marginTop: 4, alignItems: 'center' }}>
                    <span className="small muted">Thẻ liên kết Flow:</span>
                    <span className={`badge ${promptScene1.includes('@Image1') ? 'ok' : 'err'}`} style={{ fontSize: 10, padding: '1px 6px', borderRadius: 3 }}>
                      {promptScene1.includes('@Image1') ? '✓ @Image1 (model)' : '⚠️ Thiếu @Image1'}
                    </span>
                    <span className={`badge ${promptScene1.includes('@Image2') ? 'ok' : 'err'}`} style={{ fontSize: 10, padding: '1px 6px', borderRadius: 3 }}>
                      {promptScene1.includes('@Image2') ? '✓ @Image2 (mặt trước)' : '⚠️ Thiếu @Image2'}
                    </span>
                    <span className={`badge ${promptScene1.includes('@Image3') ? 'ok' : 'err'}`} style={{ fontSize: 10, padding: '1px 6px', borderRadius: 3 }}>
                      {promptScene1.includes('@Image3') ? '✓ @Image3 (bối cảnh)' : '⚠️ Thiếu @Image3'}
                    </span>
                    <span className={`badge ${promptScene1.includes('@Image4') ? 'ok' : 'err'}`} style={{ fontSize: 10, padding: '1px 6px', borderRadius: 3 }}>
                      {promptScene1.includes('@Image4') ? '✓ @Image4 (mặt sau)' : '⚠️ Thiếu @Image4'}
                    </span>
                    {(promptScene1.includes('@@') || !promptScene1.includes('@Image2') || !promptScene1.includes('@Image3') || promptScene1.includes('t@') || promptScene1.includes('th@')) && (
                      <button
                        type="button"
                        className="small"
                        style={{ padding: '2px 8px', fontSize: 10, background: '#0284c7', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}
                        onClick={() => setPromptScene1(sanitizeMentions(promptScene1, false))}
                        title="Tự động sửa lỗi cú pháp @@ thành @ và chèn lại @Image2 vào đúng vị trí"
                      >
                        ⚡ Tự động sửa lỗi cú pháp @Image
                      </button>
                    )}
                  </div>
                </div>

                <div className="stack" style={{ marginTop: 8 }}>
                  <div className="row between" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
                    <label className="small" style={{ margin: 0 }}>
                      <b>🎬 Phân cảnh 2: Mặt sau ({scene2Duration.replace('s', ' giây')} – Chế độ Khung hình với Start Frame{isAoDai ? ' – Áo dài' : ''})</b>
                    </label>
                    <SceneFlowOptions model={scene2Model} duration={scene2Duration} onModel={setScene2Model} onDuration={setScene2Duration} />
                    <div className="row" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                      {isScene2FromApi ? (
                        <>
                          <span className="badge" style={{ background: '#7c3aed', color: '#fff', fontSize: 11, padding: '2px 8px', borderRadius: 4 }} title="Prompt mới đã render từ Gemini AI cho sản phẩm này (Không có nút lưu prompt để bảo vệ prompt gốc ban đầu)">
                            ✨ Prompt mới đã render (Gemini AI)
                          </span>
                          <button
                            type="button"
                            className="small"
                            onClick={handleResetScene2}
                            style={{ padding: '2px 8px', fontSize: 11 }}
                            title="Khôi phục lại prompt gốc ban đầu (sau khi quay lại prompt gốc, bạn có thể chỉnh sửa và lưu prompt gốc mới)"
                          >
                            🔄 Quay lại prompt gốc
                          </button>
                        </>
                      ) : (
                        <>
                          {isScene2Custom ? (
                            <>
                              <span className="badge" style={{ background: '#f59e0b', color: '#fff', fontSize: 11, padding: '2px 8px', borderRadius: 4 }} title="Bạn vừa chỉnh sửa nội dung prompt gốc">
                                ✏️ Đã chỉnh sửa prompt gốc
                              </span>
                              <button
                                type="button"
                                className="small"
                                disabled={busy || !promptScene2.trim()}
                                onClick={handleSaveScene2AsBase}
                                style={{ padding: '4px 12px', fontSize: 11, background: '#16a34a', color: '#fff', border: 'none', borderRadius: 4, fontWeight: 700, cursor: 'pointer', boxShadow: '0 1px 3px rgba(0,0,0,0.2)' }}
                                title="Lưu nội dung bạn vừa chỉnh sửa thành Prompt gốc mới của hệ thống. Lần sau hoặc khi bấm 'Quay lại prompt gốc' sẽ dùng prompt này."
                              >
                                💾 Lưu lại prompt gốc
                              </button>
                              <button
                                type="button"
                                className="small"
                                onClick={handleResetScene2}
                                style={{ padding: '2px 8px', fontSize: 11 }}
                                title="Huỷ các thay đổi vừa gõ và khôi phục về prompt gốc hiện hành"
                              >
                                🔄 Huỷ thay đổi
                              </button>
                            </>
                          ) : (
                            <>
                              <span className="badge" style={{ background: '#475569', color: '#cbd5e1', fontSize: 11, padding: '2px 8px', borderRadius: 4 }}>
                                📄 Đang ở prompt gốc {savedPrompts[keyScene2] ? '(Riêng)' : '(Mặc định)'}
                              </span>
                              {savedPrompts[keyScene2] && (
                                <button
                                  type="button"
                                  className="small"
                                  disabled={busy}
                                  onClick={() => handleRestoreSystemDefault(keyScene2)}
                                  style={{ padding: '2px 6px', fontSize: 10, color: 'var(--muted)', background: 'transparent', border: '1px solid var(--line)' }}
                                  title="Khôi phục về mẫu gốc ban đầu lúc mới cài đặt của hệ thống"
                                >
                                  Khôi phục mặc định hệ thống
                                </button>
                              )}
                            </>
                          )}
                        </>
                      )}
                      <PromptVersionPicker wfId={wf.id} promptKey={keyScene2} reload={savedPrompts[keyScene2] || ''} onRestored={(t) => { setPromptScene2(t); setScene2FromApi(false); refresh(); setSaveNotice({ key: 'scene2', text: '✓ Đã quay lại phiên bản prompt cũ cho Cảnh 2 (bản vừa rồi đã được lưu thành phiên bản).' }); setTimeout(() => setSaveNotice(null), 3500); }} />
                    </div>
                  </div>
                  <span className="muted" style={{ display: 'block', fontSize: 11, marginTop: 2 }}>
                    Tiếp nối liền mạch từ khung hình cuối của Phân cảnh 1 làm Start Frame ({scene2Model} 720p {scene2Duration}), xoay người khoe chi tiết lưng và kêu gọi mua hàng.
                  </span>
                  <textarea
                    rows={6}
                    className="mono small"
                    value={promptScene2}
                    onChange={(e) => setPromptScene2(e.target.value)}
                    placeholder="Nhập prompt cho Phân cảnh 2..."
                  />
                  {promptScene2.includes('@@') && (
                    <div className="row" style={{ marginTop: 4 }}>
                      <button
                        type="button"
                        className="small"
                        style={{ padding: '2px 8px', fontSize: 10, background: '#0284c7', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}
                        onClick={() => setPromptScene2(sanitizeMentions(promptScene2, false))}
                      >
                        ⚡ Sửa lỗi cú pháp @@ thành @
                      </button>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="stack">
                <div className="row between" style={{ alignItems: 'center', marginBottom: 4, flexWrap: 'wrap', gap: 6 }}>
                  <span className="small muted row" style={{ gap: 8, alignItems: 'center' }}>
                    Prompt {scene1Duration} Trường hợp 1 (Đầy đủ Outfit) gửi sang Flow:
                    <SceneFlowOptions model={scene1Model} duration={scene1Duration} onModel={setScene1Model} onDuration={setScene1Duration} />
                  </span>
                  <div className="row" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    {isCase1FromApi ? (
                      <>
                        <span className="badge" style={{ background: '#7c3aed', color: '#fff', fontSize: 11, padding: '2px 8px', borderRadius: 4 }}>
                          ✨ Prompt mới đã render (Gemini AI)
                        </span>
                        <button
                          type="button"
                          className="small"
                          onClick={handleResetCase1}
                          style={{ padding: '2px 8px', fontSize: 11 }}
                        >
                          🔄 Quay lại prompt gốc
                        </button>
                      </>
                    ) : (
                      <>
                        {isCase1Custom ? (
                          <>
                            <span className="badge" style={{ background: '#f59e0b', color: '#fff', fontSize: 11, padding: '2px 8px', borderRadius: 4 }}>
                              ✏️ Đã chỉnh sửa prompt gốc
                            </span>
                            <button
                              type="button"
                              className="small"
                              disabled={busy || !customCase1Prompt.trim()}
                              onClick={handleSaveCase1AsBase}
                              style={{ padding: '4px 12px', fontSize: 11, background: '#16a34a', color: '#fff', border: 'none', borderRadius: 4, fontWeight: 700, cursor: 'pointer' }}
                              title="Lưu nội dung bạn vừa chỉnh sửa thành Prompt gốc mới cho TH1."
                            >
                              💾 Lưu lại prompt gốc
                            </button>
                            <button
                              type="button"
                              className="small"
                              onClick={handleResetCase1}
                              style={{ padding: '2px 8px', fontSize: 11 }}
                            >
                              🔄 Huỷ thay đổi
                            </button>
                          </>
                        ) : (
                          <>
                            <span className="badge" style={{ background: '#475569', color: '#cbd5e1', fontSize: 11, padding: '2px 8px', borderRadius: 4 }}>
                              📄 Đang ở prompt gốc {savedPrompts.case1 ? '(Riêng)' : '(Mặc định)'}
                            </span>
                            {savedPrompts.case1 && (
                              <button
                                type="button"
                                className="small"
                                disabled={busy}
                                onClick={() => handleRestoreSystemDefault('case1')}
                                style={{ padding: '2px 6px', fontSize: 10, color: 'var(--muted)', background: 'transparent', border: '1px solid var(--line)' }}
                              >
                                Khôi phục mặc định hệ thống
                              </button>
                            )}
                          </>
                        )}
                      </>
                    )}
                    <PromptVersionPicker wfId={wf.id} promptKey="case1" reload={savedPrompts.case1 || ''} onRestored={(t) => { setCustomCase1Prompt(t); setCase1FromApi(false); refresh(); setSaveNotice({ key: 'case1', text: '✓ Đã quay lại phiên bản prompt cũ cho TH1 (bản vừa rồi đã được lưu thành phiên bản).' }); setTimeout(() => setSaveNotice(null), 3500); }} />
                  </div>
                </div>
                <textarea
                  rows={8}
                  className="mono small"
                  value={customCase1Prompt}
                  onChange={(e) => setCustomCase1Prompt(e.target.value)}
                />
              </div>
            )}
          </div>
        )}

        {/* Tuỳ chọn âm thanh video */}
        <div className="stack" style={{ background: 'var(--panel)', padding: '12px 14px', borderRadius: 8, gap: 8, border: '1px solid var(--line)' }}>
          <b style={{ fontSize: 13 }}>🔊 Âm thanh khi ghép video hoàn chỉnh:</b>
          <div className="row gap-md" style={{ flexWrap: 'wrap' }}>
            <label className="radio" style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="radio"
                name="fashionKeepAudio"
                checked={keepAudio === true}
                onChange={() => setKeepAudio(true)}
              />
              <span><b>Giữ âm thanh / Giọng đọc gốc</b> (Nối tiếng Cảnh 1 + Cảnh 2 - Mặc định)</span>
            </label>
            <label className="radio" style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="radio"
                name="fashionKeepAudio"
                checked={keepAudio === false}
                onChange={() => setKeepAudio(false)}
              />
              <span><b>Không dùng âm thanh / Tắt tiếng</b> (Video câm)</span>
            </label>
          </div>
          <small className="muted" style={{ fontSize: 11 }}>
            {keepAudio
              ? '✓ Video ghép sẽ giữ trọn vẹn lời thoại tiếng Việt và âm thanh gốc của nhân vật từ Google Flow theo từng phân cảnh.'
              : '🔇 Video ghép sẽ tắt âm thanh hoàn toàn (video câm, phù hợp khi bạn muốn tự lồng nhạc/voiceover sau).'}
          </small>
        </div>

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
          {busy
            ? '… Đang xử lý'
            : isCase1
              ? `🎬 Tạo Video thời trang TH1 (${scene1Duration} Full Outfit · ${scene1Model})`
              : isAoDai
                ? `🎬 Tạo Video áo dài TH3 (2 Phân cảnh: Cảnh 1 ${scene1Duration} + Cảnh 2 ${scene2Duration})`
                : `🎬 Tạo Video thời trang TH2 (2 Phân cảnh: Cảnh 1 ${scene1Duration} + Cảnh 2 ${scene2Duration})`}
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
                        {s.status === 'done' ? '✓' : s.status === 'running' ? '⏳' : s.status === 'failed' ? '❌' : '○'} {s.label}
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

                {r.error && (
                  <div className="err small" style={{ marginTop: 6, background: '#fee2e2', color: '#991b1b', padding: '6px 10px', borderRadius: 4 }}>
                    ❌ {r.error}
                  </div>
                )}

                <div className="row between" style={{ borderTop: '1px solid var(--line)', paddingTop: 8, alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                  <div className="row gap-sm" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
                    {r.status === 'running' && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => run(async () => { await api.cancelRun(r.id); await refresh(); })}
                      >
                        ⏹ Huỷ
                      </button>
                    )}
                    {(r.status === 'failed' || r.status === 'cancelled') && (
                      <button
                        type="button"
                        className="primary small-btn"
                        disabled={busy}
                        onClick={() => run(async () => { await api.resumeRun(r.id); await refresh(); })}
                      >
                        ▶ Thử lại / Chạy tiếp
                      </button>
                    )}
                    {r.status !== 'done' && (
                      <button
                        type="button"
                        className="small-btn"
                        disabled={busy}
                        style={{ background: '#0284c7', color: '#fff', border: 'none', fontWeight: 600, padding: '5px 12px' }}
                        title="Tải video mới nhất vừa render xong trong cửa sổ Chrome Google Flow về để tiếp tục bước tiếp theo"
                        onClick={() => run(async () => {
                          await api.importFlowRun(r.id);
                          await refresh();
                        })}
                      >
                        📥 Tải video từ Google Flow về {r.stages?.scene1?.status === 'done' ? '(Cảnh 2)' : '(Cảnh 1)'}
                      </button>
                    )}
                    {r.status !== 'done' && (
                      <div className="row gap-xs" style={{ alignItems: 'center' }}>
                        <small className="muted">hoặc gán riêng:</small>
                        <button
                          type="button"
                          className="small-btn"
                          disabled={busy}
                          style={{ fontSize: 11, padding: '3px 7px' }}
                          title="Tải video Flow gán cho Cảnh 1 (Mặt trước)"
                          onClick={() => run(async () => {
                            await api.importFlowRun(r.id, { stageId: 'scene1' });
                            await refresh();
                          })}
                        >
                          Cảnh 1
                        </button>
                        <button
                          type="button"
                          className="small-btn"
                          disabled={busy}
                          style={{ fontSize: 11, padding: '3px 7px' }}
                          title="Tải video Flow gán cho Cảnh 2 (Mặt sau)"
                          onClick={() => run(async () => {
                            await api.importFlowRun(r.id, { stageId: 'scene2' });
                            await refresh();
                          })}
                        >
                          Cảnh 2
                        </button>
                      </div>
                    )}
                  </div>
                  <ConfirmButton
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
