// Nhà máy tạo định nghĩa quy trình "Ảnh model mặc đồ" cho Tab Nữ ('anh-model') và Tab Nam ('anh-model-nam').
// Toàn bộ schema slot, kiểm tra khoá chéo & ghép prompt động nằm tại anh-model-schema.js.
import fs from 'node:fs';
import {
  SLOT_ORDER,
  MODEL_OUTFIT_SLOTS,
  STYLE_PRESETS,
  CLEAN_BACKGROUND_PROMPT,
  BASE_RENDER_TEMPLATE_FEMALE,
  BASE_RENDER_TEMPLATE_MALE,
  validateOutfitItems,
  prepareModelInputs,
  resolveOutfitList,
  buildDynamicRenderPrompt,
} from './anh-model-schema.js';
import { db } from '../db.js';
import { codedImagesOf, codedImagesStale, ensureCodedImages, productMetaOf } from '../productExport.js';

export {
  SLOT_ORDER,
  MODEL_OUTFIT_SLOTS,
  STYLE_PRESETS,
  validateOutfitItems,
  prepareModelInputs,
  resolveOutfitList,
  buildDynamicRenderPrompt,
};

function assetShortListLabel(ctx, outfit, gender) {
  const slots = MODEL_OUTFIT_SLOTS[gender] || MODEL_OUTFIT_SLOTS.female;
  const parts = SLOT_ORDER
    .filter((s) => outfit.items?.[s])
    .map((s) => {
      const sl = slots.find((x) => x.key === s);
      const name = ctx.assetName(outfit.items[s]);
      return `${sl?.shortLabel || s.toUpperCase()}: ${name}`;
    });
  return parts.join(' + ');
}

function backgroundIdsOf(inputs = {}) {
  if (Array.isArray(inputs.backgrounds) && inputs.backgrounds.length) return inputs.backgrounds;
  if (inputs.background) return [inputs.background];
  return [];
}

/**
 * Tạo định nghĩa workflow hoàn chỉnh cho Tab Nữ (`anh-model`) hoặc Tab Nam (`anh-model-nam`).
 */
export function createModelLookbookWorkflow(gender) {
  const isFemale = gender === 'female';
  const id = isFemale ? 'anh-model' : 'anh-model-nam';
  const name = isFemale ? 'Ảnh model mặc đồ – Nữ' : 'Ảnh model mặc đồ – Nam';
  const slots = MODEL_OUTFIT_SLOTS[gender];

  return {
    id,
    name,
    icon: '📸',
    noVideo: true,
    tab: { group: 'anh-model', title: 'Ảnh model mặc đồ', label: isFemale ? 'Nữ' : 'Nam' },
    description: isFemale
      ? '1 ảnh model nữ + nhiều Bộ (Váy, Áo+Quần, Áo+Váy hoặc Đồ bộ 1 ảnh, Áo khoác & Túi tuỳ chọn) + nhiều bối cảnh xoay vòng. Nhập thiếu món nào AI tự phối, giày & túi AI tự thêm hợp bộ. Ảnh 2K 0 credit + in nhiều mã + gom bài TikTok 5 slide.'
      : '1 ảnh model nam + nhiều Bộ (Áo, Quần, Đồ bộ 1 ảnh, Áo khoác tuỳ chọn) + nhiều bối cảnh xoay vòng. Nhập thiếu AI tự phối (KHÔNG tự thêm áo khoác trừ khi bạn nhập), giày dép AI tự phối hợp bộ. Ảnh 2K 0 credit + in mã + gom bài TikTok 5 slide.',
    modelOutfits: {
      key: 'modelOutfits',
      gender,
      slots,
      stylePresets: STYLE_PRESETS,
    },
    inputs: [
      { key: 'model', kind: 'model', label: isFemale ? 'Ảnh model nữ toàn thân' : 'Ảnh model nam toàn thân', required: true },
      { key: 'backgrounds', kind: 'background', label: 'Ảnh bối cảnh (chọn 1 hoặc nhiều — tự xoay vòng cho từng bộ)', required: false, requiredUi: true, multiple: true },
    ],
    prompts: {
      background: { label: '1. Làm sạch bối cảnh (bỏ người, giữ nguyên khung cảnh)', text: CLEAN_BACKGROUND_PROMPT },
      render: {
        label: `2. Render model ${isFemale ? 'nữ' : 'nam'} mặc bộ trang phục 2K ({INPUT_LIST}/{OUTFIT_BLOCK}/{FOOTWEAR_BLOCK}/{HANDBAG_BLOCK}/{POSE_BLOCK}/{VIBE_BLOCK} = tự điền theo từng bộ; {prompt} = ghi chú thêm)`,
        text: isFemale ? BASE_RENDER_TEMPLATE_FEMALE : BASE_RENDER_TEMPLATE_MALE,
      },
    },
    options: [
      { key: 'stylePreset', label: 'Phong cách tổng thể (đồng bộ giày & dáng pose)', options: STYLE_PRESETS.map(({ value, label }) => ({ value, label })), default: '' },
      { key: 'cleanBackground', label: 'Làm sạch bối cảnh trước (bỏ người trong tất cả ảnh bối cảnh)', default: true },
      ...(isFemale
        ? [{ key: 'autoBag', label: 'AI tự chọn mẫu túi xách phù hợp bỏ vào (khi không nhập ảnh túi)', default: true }]
        : []),
      { key: 'saveAsModel', label: 'Lưu luôn ảnh kết quả thành ảnh model (để dùng cho các quy trình video)', default: false },
    ],

    prepareInputs(inputs) {
      return prepareModelInputs(gender, inputs, (assetId) => db.assets.some((a) => a.id === assetId));
    },

    stages: [
      {
        id: 'background',
        label: 'Làm sạch bối cảnh',
        when: (run) => run.options.cleanBackground !== false,
        async run(ctx) {
          const rawBgs = backgroundIdsOf(ctx.inputs);
          if (!rawBgs.length) throw new Error('Thiếu ảnh bối cảnh');
          const jobs = rawBgs.map((bgId, idx) => {
            const bgPath = ctx.assetPath(bgId);
            if (!bgPath) throw new Error(`Ảnh bối cảnh thứ ${idx + 1} không còn trong thư viện`);
            const jobKey = rawBgs.length === 1 ? 'background:bg' : `background:bg:${idx}`;
            return ctx.ensureJob(jobKey, {
              type: 'image',
              imagePaths: [bgPath],
              template: ctx.prompt('background'),
              videoLabel: `Bối cảnh sạch${rawBgs.length > 1 ? ` #${idx + 1}` : ''} – ${ctx.assetName(bgId)}`,
              meta: { aspectRatio: '9:16', bgIndex: idx },
            });
          });
          const status = ctx.waitAll(jobs);
          if (status !== 'done') return status;

          ctx.state.assetIds ||= [];
          ctx.state.assetFroms ||= [];
          jobs.forEach((job, idx) => {
            if (!job.outputPath || ctx.state.assetFroms[idx] === job.outputPath) return;
            const att = job.attempts.find((a) => a.outputPath === job.outputPath);
            const a = ctx.registerAsset(
              'background',
              job.outputPath,
              `Bối cảnh sạch${rawBgs.length > 1 ? ` #${idx + 1}` : ''} – ${ctx.assetName(rawBgs[idx])}`,
              { flowTitle: att?.flowTitle || null },
            );
            ctx.state.assetIds[idx] = a.id;
            ctx.state.assetFroms[idx] = job.outputPath;
          });
          ctx.state.assetId = ctx.state.assetIds[0] || null;
          ctx.state.assetFrom = ctx.state.assetFroms[0] || null;
          return 'done';
        },
      },
      {
        id: 'render',
        label: 'Render model mặc từng bộ',
        async run(ctx) {
          const model = ctx.assetPath(ctx.inputs.model);
          if (!model) throw new Error('Ảnh model không còn trong thư viện');
          const rawBgs = backgroundIdsOf(ctx.inputs);
          const cleanedIds = ctx.stages.background?.assetIds || (ctx.stages.background?.assetId ? [ctx.stages.background.assetId] : []);
          const bgIds = ctx.run.options.cleanBackground !== false && cleanedIds.length ? cleanedIds : rawBgs;
          if (!bgIds.length) throw new Error('Ảnh bối cảnh không còn trong thư viện');

          const outfits = resolveOutfitList(ctx.run, gender);
          const baseTemplate = ctx.prompt('render');
          const stylePreset = ctx.run.options.stylePreset || '';
          const autoBag = isFemale ? ctx.run.options.autoBag !== false : false;

          const jobs = outfits.map((outfit, i) => {
            const bgIndex = i % bgIds.length;
            const bgId = bgIds[bgIndex];
            const bgPath = ctx.assetPath(bgId);
            if (!bgPath) throw new Error(`Ảnh bối cảnh #${bgIndex + 1} không còn trong thư viện`);

            const presentSlots = SLOT_ORDER.filter((k) => outfit.items?.[k]);
            if (!presentSlots.length) throw new Error(`Bộ ${i + 1} chưa có ảnh trang phục`);
            const garmentPaths = presentSlots.map((k) => {
              const p = ctx.assetPath(outfit.items[k]);
              if (!p) throw new Error(`Ảnh món "${k}" của Bộ ${i + 1} không còn trong thư viện`);
              return p;
            });

            const imagePaths = [model, ...garmentPaths, bgPath];
            const promptText = buildDynamicRenderPrompt({
              gender,
              items: outfit.items,
              stylePreset,
              outfitStyle: outfit.style || '',
              autoBag,
              baseTemplate,
            });
            const mainSlot = presentSlots[0];
            const mainAssetId = outfit.legacyAssetId || outfit.items[mainSlot];
            const jobKey = `render:${i}:${outfit.id}`;
            const labelSummary = assetShortListLabel(ctx, outfit, gender);

            return ctx.ensureJob(jobKey, {
              type: 'image',
              imagePaths,
              template: promptText,
              videoLabel: `Bộ ${i + 1}: ${labelSummary || ctx.assetName(mainAssetId)}`,
              meta: {
                outfitId: outfit.id,
                outfitIndex: i,
                bgIndex,
                items: outfit.items,
                mainAssetId,
                kind: 'lookbook',
                aspectRatio: '9:16',
                imageQuality: '2K',
              },
            });
          });

          const saveKind = ctx.run.options.saveAsModel ? 'model' : 'lookbook';
          for (const job of jobs) {
            if (job.status !== 'done' || !job.outputPath) continue;
            if (job.meta?.assetFrom === job.outputPath) continue;
            const att = job.attempts.find((a) => a.outputPath === job.outputPath);
            const mainAsset = ctx.asset(job.meta?.mainAssetId || job.meta?.outfitId);
            const product = mainAsset ? productMetaOf(mainAsset) : null;
            const a = ctx.registerAsset(saveKind, job.outputPath, job.videoLabel, {
              flowTitle: att?.flowTitle || null,
              fromJobId: job.id,
              outfitId: job.meta?.outfitId || null,
              outfitItems: job.meta?.items || null,
              ...(product ? { product } : {}),
            });
            job.meta = { ...(job.meta || {}), assetId: a.id, assetFrom: job.outputPath };
          }
          return ctx.waitAll(jobs);
        },
      },
      {
        id: 'badge',
        label: 'In mã lên ảnh',
        when: (run) => codedImagesOf(run).some((c) => c.wanted || c.stale),
        async run(ctx) {
          await ensureCodedImages(ctx.run);
          return 'done';
        },
      },
    ],

    sync(run) {
      let changed = false;
      const jobsMap = run.stages?._jobs || {};
      const bgState = run.stages?.background;
      const rawBgs = backgroundIdsOf(run.inputs);
      if (bgState && run.options?.cleanBackground !== false && rawBgs.length) {
        bgState.assetIds ||= bgState.assetId ? [bgState.assetId] : [];
        bgState.assetFroms ||= bgState.assetFrom ? [bgState.assetFrom] : [];
        rawBgs.forEach((_, idx) => {
          const k = rawBgs.length === 1 ? 'background:bg' : `background:bg:${idx}`;
          const j = db.jobs.find((x) => x.id === jobsMap[k]);
          const aid = bgState.assetIds[idx];
          const from = bgState.assetFroms[idx];
          if (aid && j?.outputPath && from && from !== j.outputPath) {
            const a = db.assets.find((x) => x.id === aid);
            if (a && fs.existsSync(j.outputPath)) {
              fs.copyFileSync(j.outputPath, a.path);
              a.flowTitle = j.attempts.find((x) => x.outputPath === j.outputPath)?.flowTitle || null;
            }
            bgState.assetFroms[idx] = j.outputPath;
            if (idx === 0) bgState.assetFrom = j.outputPath;
            for (const [rk, rid] of Object.entries(jobsMap)) {
              if (!rk.startsWith('render:')) continue;
              const rj = db.jobs.find((x) => x.id === rid);
              if (rj && (rj.meta?.bgIndex ?? 0) === idx) delete jobsMap[rk];
            }
            if (run.stages?.render && run.stages.render.status !== 'pending') {
              run.stages.render.status = 'pending';
            }
            changed = true;
          }
        });
      }

      const st = run.stages?.badge;
      if (st && st.status !== 'pending' && st.status !== 'running' && codedImagesStale(run)) {
        st.status = 'pending';
        changed = true;
      }
      return changed;
    },
  };
}
