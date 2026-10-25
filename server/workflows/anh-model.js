// Quy trình "Ảnh model mặc đồ" (chỉ làm ảnh, không có video): 1 ảnh model toàn thân + NHIỀU ảnh trang phục
// + 1 ảnh bối cảnh (có thể dính người) -> làm sạch bối cảnh (bỏ người) -> với MỖI trang phục render 1 ảnh
// model mặc đúng bộ đó đứng trong bối cảnh đã làm sạch. Toàn bộ là sinh ảnh Nano Banana trên Flow (0 credit).
// Ảnh kết quả được lưu vào thư viện (loại "lookbook"), có nút lưu thành ảnh model để dùng cho các quy trình video.

const CLEAN_BACKGROUND_PROMPT = `Remove every person from this photo, including any body parts, hair, clothing, accessories, shadows and reflections of people.
Keep everything else exactly as it is: the same place, walls, floor, furniture, objects, decorations, colors, lighting, camera angle, perspective and framing. Do not redesign, restyle or recolor the scene.
Fill the areas behind the removed people seamlessly and realistically, continuing the surfaces and objects that were hidden.
Output a clean, empty background photo with the same framing, ready for a person to be placed in later.`;

const RENDER_PROMPT = `Photorealistic full-body fashion photo. Inputs, in order: image 1 = the model (her exact face, hair, skin tone and body proportions), image 2 = the outfit to wear, image 3 = the background scene.

Show the model from image 1 standing in the scene from image 3, wearing exactly the outfit from image 2.
- Identity: her face must match image 1 exactly (face shape, eyes, eyebrows, nose, lips, skin tone, hairstyle). Same body proportions as in image 1.
- Outfit: reproduce the garment in image 2 faithfully: same color, pattern, print, fabric and sheen, neckline, straps, sleeves, length, fit and details. She wears only this outfit; keep shoes and accessories simple and neutral unless they are part of image 2. Do not add other garments.
- Scene: use the background from image 3 as it is. Do not change the room, objects or colors. Place her naturally on the floor of the scene with correct scale, perspective and contact shadows; match the scene's lighting direction, softness and color temperature so she looks genuinely photographed there.
- Pose and framing: natural, relaxed standing pose facing the camera like a lookbook photo, full body visible from head to shoes, centered, vertical 9:16 framing, sharp focus, no motion blur.

Do not add text, logos, watermarks, captions, extra people, mannequins or props that are not in the inputs. Hands and fingers must look natural.
{prompt}`;

export default {
  id: 'anh-model',
  name: 'Ảnh model mặc đồ',
  icon: '📸',
  noVideo: true,
  description: '1 ảnh model toàn thân + nhiều ảnh trang phục + 1 ảnh bối cảnh (dính người cũng được): làm sạch bối cảnh rồi render mỗi bộ đồ thành 1 ảnh model mặc đúng bộ đó trong bối cảnh. Chỉ sinh ảnh, 0 credit.',
  inputs: [
    { key: 'model', kind: 'model', label: 'Ảnh model toàn thân', required: true },
    { key: 'outfits', kind: 'product', label: 'Ảnh trang phục (chọn nhiều — mỗi ảnh ra 1 kết quả)', required: true, multiple: true },
    { key: 'background', kind: 'background', label: 'Ảnh bối cảnh (có người cũng được)', required: true },
  ],
  prompts: {
    background: { label: '1. Làm sạch bối cảnh (bỏ người, giữ nguyên khung cảnh)', text: CLEAN_BACKGROUND_PROMPT },
    render: { label: '2. Render model mặc trang phục trong bối cảnh (ảnh 1 = model, 2 = trang phục, 3 = bối cảnh; {prompt} = ghi chú thêm)', text: RENDER_PROMPT },
  },
  options: [
    { key: 'cleanBackground', label: 'Làm sạch bối cảnh trước (bỏ người trong ảnh bối cảnh)', default: true },
    { key: 'saveAsModel', label: 'Lưu luôn ảnh kết quả thành ảnh model (để dùng cho AI Dancing / Thay trang phục)', default: false },
  ],

  stages: [
    {
      id: 'background',
      label: 'Làm sạch bối cảnh',
      when: (run) => run.options.cleanBackground,
      // Dùng chung key 'background:bg' với các quy trình video để thẻ lần chạy hiện được thẻ job bối cảnh (Thử lại…)
      async run(ctx) {
        const bg = ctx.assetPath(ctx.inputs.background);
        if (!bg) throw new Error('Ảnh bối cảnh không còn trong thư viện');
        const job = ctx.ensureJob('background:bg', {
          type: 'image',
          imagePaths: [bg],
          template: ctx.prompt('background'),
          videoLabel: `Bối cảnh sạch – ${ctx.assetName(ctx.inputs.background)}`,
        });
        if (job.status === 'failed') throw ctx.jobError(job);
        if (job.status !== 'done') return 'waiting';
        if (!ctx.state.assetId) {
          const att = job.attempts.find((a) => a.outputPath === job.outputPath);
          ctx.state.assetId = ctx.registerAsset('background', job.outputPath, `Bối cảnh sạch – ${ctx.assetName(ctx.inputs.background)}`, { flowTitle: att?.flowTitle || null }).id;
          ctx.state.assetFrom = job.outputPath;
        }
        return 'done';
      },
    },
    {
      id: 'render',
      label: 'Render model mặc từng bộ',
      // 1 job ảnh cho mỗi trang phục: ảnh model -> trang phục -> bối cảnh (đã làm sạch nếu có)
      async run(ctx) {
        const model = ctx.assetPath(ctx.inputs.model);
        if (!model) throw new Error('Ảnh model không còn trong thư viện');
        const bgId = ctx.run.options.cleanBackground ? ctx.stages.background?.assetId : ctx.inputs.background;
        const bg = ctx.assetPath(bgId);
        if (!bg) throw new Error('Ảnh bối cảnh không còn trong thư viện');
        const outfits = ctx.inputs.outfits || [];
        const jobs = outfits.map((outfitId, i) => {
          const outfit = ctx.assetPath(outfitId);
          if (!outfit) throw new Error(`Ảnh trang phục thứ ${i + 1} không còn trong thư viện`);
          return ctx.ensureJob(`render:${i}:${outfitId}`, {
            type: 'image',
            imagePaths: [model, outfit, bg],
            template: ctx.prompt('render'),
            videoLabel: `${ctx.assetName(outfitId)} – ${ctx.assetName(ctx.inputs.model)}`,
            meta: { outfitId, kind: 'lookbook' },
          });
        });
        // Lưu ảnh kết quả vào thư viện ngay khi từng job xong (kể cả khi job khác còn chạy / lỗi)
        const saveKind = ctx.run.options.saveAsModel ? 'model' : 'lookbook';
        for (const job of jobs) {
          if (job.status !== 'done' || !job.outputPath) continue;
          if (job.meta?.assetFrom === job.outputPath) continue; // đã lưu bản này (thử lại ra bản mới thì lưu thêm)
          const att = job.attempts.find((a) => a.outputPath === job.outputPath);
          const a = ctx.registerAsset(saveKind, job.outputPath, job.videoLabel, { flowTitle: att?.flowTitle || null, fromJobId: job.id });
          job.meta = { ...(job.meta || {}), assetId: a.id, assetFrom: job.outputPath };
        }
        return ctx.waitAll(jobs);
      },
    },
  ],
};
