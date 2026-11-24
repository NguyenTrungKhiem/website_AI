// Schema, quy tắc khoá chéo và bộ ghép prompt thuần cho "Ảnh model mặc đồ" (Nữ & Nam).
// Tách thành module lá không phụ thuộc db / productExport để tránh vòng lặp import ESM.

export const SLOT_ORDER = ['set', 'top', 'dress', 'bottom', 'jacket', 'bag'];

export const MODEL_OUTFIT_SLOTS = {
  female: [
    { key: 'dress', label: 'Váy / Đầm', icon: '👗', shortLabel: 'VÁY', conflicts: ['bottom', 'set'], hint: 'Chọn 1 mình = đầm liền; chọn kèm Áo = set áo + chân váy (khoá Quần)' },
    { key: 'top', label: 'Áo', icon: '👚', shortLabel: 'ÁO', conflicts: ['set'] },
    { key: 'bottom', label: 'Quần', icon: '👖', shortLabel: 'QUẦN', conflicts: ['dress', 'set'], hint: 'Phối với Áo (khoá Váy)' },
    { key: 'set', label: 'Đồ bộ (1 ảnh)', icon: '🎀', shortLabel: 'BỘ', conflicts: ['top', 'bottom', 'dress'], hint: '1 ảnh gồm áo+váy hoặc áo+quần (khoá Áo/Quần/Váy)' },
    { key: 'jacket', label: 'Áo khoác', icon: '🧥', shortLabel: 'KHOÁC', optional: true, conflicts: [], hint: 'Không bắt buộc — bỏ trống thì KHÔNG mặc thêm áo khoác' },
    { key: 'bag', label: 'Túi xách', icon: '👜', shortLabel: 'TÚI', optional: true, autoWhenEmpty: true, conflicts: [], hint: 'Bỏ trống → AI tự chọn mẫu túi hợp bộ; nhập ảnh → giữ đúng túi đó' },
  ],
  male: [
    { key: 'top', label: 'Áo', icon: '👕', shortLabel: 'ÁO', conflicts: ['set'] },
    { key: 'bottom', label: 'Quần', icon: '👖', shortLabel: 'QUẦN', conflicts: ['set'] },
    { key: 'set', label: 'Đồ bộ (1 ảnh)', icon: '👔', shortLabel: 'BỘ', conflicts: ['top', 'bottom'], hint: '1 ảnh gồm cả áo và quần (khoá Áo/Quần)' },
    { key: 'jacket', label: 'Áo khoác', icon: '🧥', shortLabel: 'KHOÁC', optional: true, conflicts: [], hint: 'Không bắt buộc — bỏ trống thì KHÔNG mặc thêm áo khoác' },
  ],
};

export const STYLE_PRESETS = [
  { value: '', label: '✨ AI tự chọn theo trang phục', prompt: '' },
  { value: 'korean_street', label: '🇰🇷 Hàn Quốc Streetwear (trẻ trung, năng động)', prompt: 'Korean street fashion styling: relaxed modern proportions, clean trendy footwear, effortless editorial confidence' },
  { value: 'smart_office', label: '💼 Công sở Thanh lịch (chỉn chu, sang trọng)', prompt: 'Smart tailored office styling: crisp polished silhouette, refined footwear, poised editorial presence' },
  { value: 'feminine_chic', label: '🌷 Tiểu thư / Nàng thơ (nữ tính, cuốn hút)', prompt: 'Romantic feminine boutique styling: soft graceful allure, delicate elevated footwear and accessories, flattering proportions' },
  { value: 'old_money', label: '🏛️ Old Money / Tối giản (cao cấp, tinh tế)', prompt: 'Quiet luxury minimalist styling: clean harmonious tones, understated refined footwear, timeless upscale aesthetic' },
  { value: 'casual_daily', label: '☀️ Dạo phố / Cafe hàng ngày (tự nhiên, bắt mắt)', prompt: 'Effortless daily café & street lookbook styling: relaxed approachable charm, comfortable stylish footwear, candid social-media appeal' },
];

export const CLEAN_BACKGROUND_PROMPT = `Remove every person from this photo, including any body parts, hair, clothing, accessories, shadows and reflections of people.
Keep everything else exactly as it is: the same place, walls, floor, furniture, objects, decorations, colors, lighting, camera angle, perspective and framing. Do not redesign, restyle or recolor the scene.
Fill the areas behind the removed people seamlessly and realistically, continuing the surfaces and objects that were hidden.
Output a clean, empty background photo with the same framing, ready for a person to be placed in later.`;

export const BASE_RENDER_TEMPLATE_FEMALE = `Photorealistic full-body fashion photo, vertical 9:16 portrait format. {INPUT_LIST}

Output ONE single photo of this woman (not a collage, not a sheet, not multiple views, not multiple people): she stands in the background scene wearing the exact outfit specified below.

BODY — the most important rule: keep her exact body shape and proportions as seen in image 1: height, overall build, shoulder width, bust, waist, hips, belly, arm and leg length and thickness, hand and foot size, posture. Do NOT slim, elongate, enlarge, idealize, reshape or restyle her figure in any way; do not change her head-to-body ratio. The outfit must fit THIS body, not an idealized one.

IDENTITY: her face must match image 1 exactly (face shape, eyes, eyebrows, nose, lips, skin tone, hairstyle and hair color). Same person, recognizable at a glance.

{OUTFIT_BLOCK}

{FOOTWEAR_BLOCK}

{HANDBAG_BLOCK}

{POSE_BLOCK}
{VIBE_BLOCK}
SCENE: use the background image as it is — do not change the place, objects or colors. Place her naturally on the floor with correct scale, perspective and contact shadows; match the scene's lighting direction, softness and color temperature so she looks genuinely photographed there. If the background image is not 9:16, extend it naturally to fill the vertical frame.

FRAMING: full body visible from the top of the head down to the shoes, centered, with a little breathing room above the head and below the feet; eye-level camera, sharp focus, no motion blur.

Do not add text, logos, watermarks, captions, extra people or mannequins. Hands and fingers must look natural.
{prompt}`;

export const BASE_RENDER_TEMPLATE_MALE = `Photorealistic full-body menswear fashion photo, vertical 9:16 portrait format. {INPUT_LIST}

Output ONE single photo of this man (not a collage, not a sheet, not multiple views, not multiple people): he stands in the background scene wearing the exact outfit specified below.

BODY — the most important rule: keep his exact body shape and proportions as seen in image 1: height, build, shoulder breadth, chest, waist, torso-to-leg ratio, arm and leg muscle/thickness, hand and shoe size, natural posture. Do NOT slim, bulk up, elongate, idealize, reshape or restyle his physique in any way; do not change his head-to-body ratio. The outfit must fit THIS body naturally.

IDENTITY: his face must match image 1 exactly (face structure, jawline, eyes, eyebrows, nose, lips, skin tone, hairstyle and hair color). Same man, recognizable at a glance.

{OUTFIT_BLOCK}

{FOOTWEAR_BLOCK}

{HANDBAG_BLOCK}

{POSE_BLOCK}
{VIBE_BLOCK}
SCENE: use the background image as it is — do not change the place, objects or colors. Place him naturally on the floor with correct scale, perspective and contact shadows; match the scene's lighting direction, softness and color temperature so he looks genuinely photographed there. If the background image is not 9:16, extend it naturally to fill the vertical frame.

FRAMING: full body visible from the top of the head down to the shoes, centered, with a little breathing room above the head and below the feet; eye-level camera, sharp focus, no motion blur.

Do not add text, logos, watermarks, captions, extra people or mannequins. Hands and fingers must look natural.
{prompt}`;

const STYLE_MAP = Object.fromEntries(STYLE_PRESETS.map((s) => [s.value, s.prompt]));

/**
 * Kiểm tra & làm sạch từng món trong 1 Bộ trang phục theo giới tính, chặn cứng các cặp khoá chéo.
 */
export function validateOutfitItems(gender, rawItems = {}, hasAsset = () => true) {
  const allowed = new Set((MODEL_OUTFIT_SLOTS[gender] || MODEL_OUTFIT_SLOTS.female).map((s) => s.key));
  const items = {};
  for (const key of SLOT_ORDER) {
    if (!allowed.has(key)) continue;
    const id = rawItems?.[key];
    if (typeof id === 'string' && id.trim() && hasAsset(id)) items[key] = id;
  }
  if (items.set && (items.top || items.bottom || items.dress)) {
    throw new Error('Không thể chọn "Đồ bộ (1 ảnh)" cùng lúc với Áo / Quần / Váy trong cùng 1 bộ');
  }
  if (gender === 'female' && items.dress && items.bottom) {
    throw new Error('Không thể chọn đồng thời Váy và Quần trong cùng 1 bộ');
  }
  if (!Object.keys(items).length) {
    throw new Error('Mỗi bộ trang phục cần chọn ít nhất 1 ảnh sản phẩm');
  }
  return items;
}

const sanitizeId = (raw, fallback) => {
  const cleaned = String(raw || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
  return cleaned || fallback;
};

/**
 * Chuẩn hoá inputs cho cả `anh-model` (Nữ) và `anh-model-nam` (Nam), giữ tương thích ngược inputs cũ
 * (`inputs.background` đơn + `inputs.outfits = [assetId, ...]`).
 */
export function prepareModelInputs(gender, rawInputs = {}, hasAsset = () => true) {
  const rawBgs = Array.isArray(rawInputs?.backgrounds)
    ? rawInputs.backgrounds
    : rawInputs?.background
      ? [rawInputs.background]
      : [];
  const backgrounds = [...new Set(rawBgs.filter((id) => typeof id === 'string' && hasAsset(id)))];
  if (!backgrounds.length) {
    throw new Error('Thiếu Ảnh bối cảnh');
  }

  const usedIds = new Set();
  const uniqueId = (base) => {
    let id = base;
    let n = 2;
    while (usedIds.has(id)) id = `${base}_${n++}`;
    usedIds.add(id);
    return id;
  };

  let modelOutfits;
  if (Array.isArray(rawInputs?.modelOutfits) && rawInputs.modelOutfits.length) {
    modelOutfits = rawInputs.modelOutfits.map((entry, idx) => {
      const items = validateOutfitItems(gender, entry?.items || entry || {}, hasAsset);
      const id = uniqueId(sanitizeId(entry?.id, `o${idx + 1}`));
      const style = String(entry?.style || '').trim().slice(0, 200);
      return { id, items, ...(style ? { style } : {}) };
    });
  } else if (Array.isArray(rawInputs?.outfits) && rawInputs.outfits.length) {
    const slotKey = gender === 'female' ? 'dress' : 'set';
    const valid = rawInputs.outfits.filter((id) => typeof id === 'string' && hasAsset(id));
    if (!valid.length) throw new Error('Ảnh trang phục không còn trong thư viện');
    modelOutfits = valid.map((assetId, idx) => ({
      id: uniqueId(sanitizeId(assetId, `o${idx + 1}`)),
      legacy: true,
      items: { [slotKey]: assetId },
    }));
  } else {
    throw new Error('Chọn ít nhất 1 bộ trang phục');
  }

  return {
    backgrounds,
    background: backgrounds[0],
    modelOutfits,
  };
}

export function resolveOutfitList(run, gender = 'female') {
  if (Array.isArray(run?.inputs?.modelOutfits) && run.inputs.modelOutfits.length) {
    return run.inputs.modelOutfits.map((o, idx) => ({
      id: o.id || `o${idx + 1}`,
      legacy: !!o.legacy,
      legacyAssetId: o.legacyAssetId || null,
      items: o.items || {},
      style: o.style || '',
    }));
  }
  const slotKey = gender === 'female' ? 'dress' : 'set';
  return (run?.inputs?.outfits || []).map((assetId, idx) => ({
    id: assetId || `o${idx + 1}`,
    legacy: true,
    legacyAssetId: assetId,
    items: { [slotKey]: assetId },
    style: '',
  }));
}

function garmentRoleInstruction(gender, slot, imgNum, items) {
  switch (slot) {
    case 'set':
      return `image ${imgNum} = COMPLETE MATCHING OUTFIT SET (one image containing both top and ${gender === 'female' ? 'skirt/trousers' : 'trousers'}): reproduce BOTH pieces faithfully (exact colors, prints, fabric, neckline, straps/sleeves, waist, length and cut).`;
    case 'dress':
      if (items.top) {
        return `image ${imgNum} = SKIRT / LOWER PIECE: reproduce this exact skirt faithfully (pattern, pleats/cut, fabric, length) paired together with the top from image ${1 + SLOT_ORDER.filter((k) => items[k]).indexOf('top') + 1}.`;
      }
      return `image ${imgNum} = DRESS or SKIRT: if image ${imgNum} is a full dress/gown/jumpsuit, wear ONLY this exact dress from top to hem; if it is a standalone skirt (with no upper garment attached), keep the skirt 100% exact and pair it with a stylish, complementary women's top/blouse.`;
    case 'top':
      return `image ${imgNum} = TOP (shirt/blouse/t-shirt/knit): reproduce this exact top faithfully (neckline, collar, sleeves, print, fabric sheen, fit and cropped/tucked/untucked proportions).`;
    case 'bottom':
      return `image ${imgNum} = TROUSERS / PANTS / SHORTS: reproduce these exact bottoms faithfully (cut, wide/slim silhouette, waist height, wash/color, length and hem details).`;
    case 'jacket':
      return `image ${imgNum} = OUTER JACKET / COAT: wear this exact jacket layered naturally over the outfit (slightly open/relaxed in front so the inner top remains visible, accurate collar, lapels, sleeves, buttons/zipper, fabric and length).`;
    case 'bag':
      return `image ${imgNum} = HANDBAG / PURSE: carry this exact bag faithfully (same shape, size, hardware, strap and color) in hand, over the forearm or on the shoulder without covering outfit details.`;
    default:
      return `image ${imgNum} = GARMENT: reproduce faithfully.`;
  }
}

export function buildDynamicRenderPrompt({
  gender = 'female',
  items = {},
  stylePreset = '',
  outfitStyle = '',
  autoBag = true,
  baseTemplate = '',
}) {
  const presentSlots = SLOT_ORDER.filter((k) => items[k]);
  const isFemale = gender === 'female';
  const subjectLabel = isFemale
    ? 'the same woman photographed from several angles (use ONLY for face identity and exact body shape — NEVER wear her old clothes from image 1)'
    : 'the same man photographed from several angles (use ONLY for face identity and exact body physique — NEVER wear his old clothes from image 1)';

  const garmentDescs = presentSlots.map((slot, idx) => {
    const imgNum = idx + 2;
    const roleShort = MODEL_OUTFIT_SLOTS[gender]?.find((s) => s.key === slot)?.label || slot;
    return `image ${imgNum} = ${roleShort}`;
  });
  const bgImgNum = presentSlots.length + 2;
  const inputList = `Inputs, in exact order: image 1 = model reference sheet (${subjectLabel}); ${garmentDescs.join('; ')}; image ${bgImgNum} = the background scene.`;

  const garmentLines = presentSlots.map((slot, idx) => `- ${garmentRoleInstruction(gender, slot, idx + 2, items)}`);
  const missingLines = [];
  const hasTopOrDressOrSet = !!(items.set || items.top || items.dress);
  const hasLowerOrSet = !!(items.set || items.bottom || items.dress);

  if (!items.set) {
    if (!hasLowerOrSet) {
      missingLines.push(
        isFemale
          ? '- MISSING BOTTOM (not provided): dress her with stylish, well-fitted matching trousers, jeans or a skirt selected by AI to complement the provided top/jacket in color palette, fabric weight and silhouette.'
          : '- MISSING TROUSERS (not provided): dress him with well-tailored matching trousers, chinos, jeans or shorts selected by AI to match the color palette and style of the provided top/jacket.'
      );
    } else if (!items.top && !items.dress) {
      missingLines.push(
        isFemale
          ? '- MISSING TOP (not provided): dress her with a chic, flattering top/blouse/tee selected by AI that harmonizes cleanly with the provided bottoms/jacket.'
          : '- MISSING TOP (not provided): dress him with a clean, stylish shirt/t-shirt/polo/knitwear selected by AI that harmonizes with the provided trousers/jacket.'
      );
    }
  }
  if (!hasTopOrDressOrSet && !items.bottom && items.jacket) {
    missingLines.push(
      isFemale
        ? '- ONLY OUTER JACKET PROVIDED: style a complete, flattering inner top and matching bottoms/dress selected by AI underneath the exact outer jacket.'
        : '- ONLY OUTER JACKET PROVIDED: style a complete, sharp inner top and matching trousers selected by AI underneath the exact outer jacket.'
    );
  }
  if (isFemale && presentSlots.length === 1 && items.bag) {
    missingLines.push('- ONLY HANDBAG PROVIDED: style a complete, cohesive chic women’s outfit (top + bottoms or dress, WITHOUT outerwear) that pairs seamlessly with the exact handbag from image 2.');
  }

  const jacketRule = items.jacket
    ? '- OUTERWEAR RULE: Keep the exact jacket/coat provided as the ONLY outer layer.'
    : '- NO OUTERWEAR / NO JACKET (STRICT): Do NOT add any jacket, blazer, coat, cardigan, vest, overshirt or extra outer layer. Leave the arms and torso cleanly showing the inner outfit without outerwear.';

  const outfitBlock = [
    `OUTFIT & GARMENT FIDELITY (${presentSlots.length} provided item${presentSlots.length > 1 ? 's' : ''}):`,
    'Reproduce every provided product faithfully: exact color tone, pattern, print, fabric texture/sheen, straps, neckline, sleeves, waist, buttons, length and drape — fitted naturally onto the model’s exact body.',
    ...garmentLines,
    ...(missingLines.length ? ['AUTO-COMPLETED GARMENTS (ONLY for missing pieces):', ...missingLines] : []),
    jacketRule,
  ].join('\n');

  const footwearBlock = isFemale
    ? 'FOOTWEAR (AI-STYLED): Do NOT leave her barefoot. Automatically generate realistic, fashionable women’s shoes/footwear (such as sleek strappy heels, minimalist mules, pointed flats, Mary Janes, chic ankle boots or clean fashion sneakers) whose style and color harmonize seamlessly with her outfit.'
    : 'FOOTWEAR (AI-STYLED): Do NOT leave him barefoot. Automatically generate realistic, stylish men’s footwear (minimalist leather sneakers, retro trainers, suede loafers, clean derbies or Chelsea boots) whose vibe and colorway match his outfit cleanly.';

  let handbagBlock;
  if (!isFemale) {
    handbagBlock = 'ACCESSORIES: Keep it clean and masculine (subtle wristwatch or leather belt only if natural). Do NOT add any handbag, purse or clutch.';
  } else if (items.bag) {
    const bagImgNum = presentSlots.indexOf('bag') + 2;
    handbagBlock = `HANDBAG: Use ONLY the exact handbag from image ${bagImgNum} — carry it naturally (in hand, over the forearm or on the shoulder) without hiding key outfit details (neckline, waist, print).`;
  } else if (autoBag !== false) {
    handbagBlock = 'HANDBAG (AI-STYLED): Add ONE realistic, chic fashionable women’s handbag (shoulder bag, tote or mini structured handbag) chosen by AI to complement the outfit’s color palette and style; place it naturally (in hand, on forearm or on shoulder) without blocking waist or neckline details.';
  } else {
    handbagBlock = 'HANDBAG: Do NOT add any handbag or purse.';
  }

  const poseBlock = isFemale
    ? (items.dress && !items.top
      ? 'POSE: Confident, sensual, feminine front-facing lookbook pose that flatters the dress silhouette: weight on one leg, hip gently shifted for a soft S-curve, natural graceful hands (lightly touching hair, waist or handbag), engaging look at the camera. Torso may angle 10–25° while face remains toward camera. Vary pose naturally between renders, never a stiff catalogue stance.'
      : 'POSE: Polished, refined luxury women’s lookbook pose: poised posture, one foot slightly stepped forward, relaxed shoulders, natural hand placement near waist/bag/jacket, gentle head tilt, warm confident expression. Vary stance naturally between renders while keeping full body visible.')
    : 'POSE: Natural, confident, masculine Korean menswear lookbook pose (never stiff, never feminine): upright relaxed shoulders, weight casually on one leg, torso angled 15–25° while face looks naturally toward camera, one hand casually in pocket or lightly adjusting jacket lapel/hem, easy natural stride. Vary pose slightly between renders.';

  const presetText = [STYLE_MAP[stylePreset] || '', outfitStyle || ''].filter(Boolean).join('. ');
  const vibeBlock = presetText ? `\nSTYLING VIBE: ${presetText}.\n` : '';

  const fallbackTpl = isFemale ? BASE_RENDER_TEMPLATE_FEMALE : BASE_RENDER_TEMPLATE_MALE;
  const tpl = (baseTemplate || '').trim() || fallbackTpl;

  if (tpl.includes('{OUTFIT_BLOCK}')) {
    return tpl
      .replace(/\{INPUT_LIST\}/g, inputList)
      .replace(/\{OUTFIT_BLOCK\}/g, outfitBlock)
      .replace(/\{FOOTWEAR_BLOCK\}/g, footwearBlock)
      .replace(/\{HANDBAG_BLOCK\}/g, handbagBlock)
      .replace(/\{POSE_BLOCK\}/g, poseBlock)
      .replace(/\{VIBE_BLOCK\}/g, vibeBlock);
  }
  const hasUserTag = tpl.includes('{prompt}');
  const cleaned = tpl.replace(/\{prompt\}/g, '').trim();
  return `${cleaned}\n\n${inputList}\n\n${outfitBlock}\n\n${footwearBlock}\n\n${handbagBlock}\n\n${poseBlock}${vibeBlock}${hasUserTag ? '\n{prompt}' : ''}`;
}
