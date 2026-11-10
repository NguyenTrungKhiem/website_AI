// Quy trình "Video bán hàng thời trang không voice": 1 ảnh model + 1–4 trang phục (mỗi bộ có ảnh MẶT TRƯỚC + MẶT SAU,
// theo thứ tự mặc) + 1 ảnh bối cảnh -> 2 phân cảnh 10s trên Flow (Omni, Ingredients, 9:16), KHÔNG voice, KHÔNG lip-sync.
// Mỗi trang phục có 1 mã sản phẩm (asset.productCode của ảnh mặt trước, cấp tự động nếu chưa có — ../productCodes.js) in làm
// caption; sang trang phục khác thì đổi mã. Ảnh mặt sau: chọn trong thư viện hoặc tạo từ mặt trước bằng Flow (0 credit,
// POST /api/assets/:id/render-back -> asset isBackView, fromAssetId = mặt trước); không chỉ định thì lấy ảnh mặt sau mới nhất của bộ đó.
//
// "Chuyển động" = kịch bản tay chân theo mốc giây (MOTIONS). Chuyển động 1 dựng theo video mẫu 43,3K.mp4 (3 trang phục).
// Mỗi chuyển động gồm: part1 (mở đầu cầm móc + trang phục 1, 10s) và các khối cho Part 2: `segments` (luân phiên cho trang
// phục 2, 3, 4; gốc 6s / 4s), `same` (chỉ có 1 trang phục: Part 2 tiếp tục trang phục 1, gốc 10s). Server chia 10s của Part 2
// cho các trang phục còn lại và co giãn mốc giây của khối theo thời lượng được chia. Prompt cố ý ngắn gọn: Flow từ chối
// prompt quá dài, nên mỗi mốc chỉ ghi đúng động tác tay / chân / đầu, không lặp lại ràng buộc.
// Thêm chuyển động mới = thêm 1 mục vào MOTIONS (và prompts tương ứng).
//
// Chỗ điền: {MODEL} = @Image1 · {OUTFIT} = tag ảnh mặt trước của bộ đang viết · {BACK} = tag ảnh mặt sau của bộ đó ·
// {OUTFITS} = các ảnh mặt trước trên móc ("@Image2, @Image4 and @Image5") · {BG} = bối cảnh · {START} = khung hình cuối Part 1
// (chỉ Part 2) · {PART} = "Part 1 of 2" / "Part 2 of 2". Thứ tự ảnh mỗi phân cảnh: Part 1 = model, trước 1, sau 1, mặt trước
// các bộ còn lại (để cầm trên móc), bối cảnh. Part 2 = model, (trước, sau) từng bộ còn lại, bối cảnh, khung hình cuối Part 1.
import fs from 'node:fs';
import path from 'node:path';
import { extractLastFrame, removeCaptionBand } from '../ffmpeg.js';
import { DIRS, db, save } from '../db.js';
import { codeOfAsset, assignCode } from '../productCodes.js';
import { FASHION_MODELS } from './video-thoi-trang.js';

const MAX_OUTFITS = 4;
const PART_SEC = 10;

// Khoá vóc dáng: model video hay tự "làm gọn" người mẫu (thu nhỏ vòng 1, vòng 3) -> nói thẳng phải giữ số đo và đường cong
// của {MODEL} ở mọi khung hình, trang phục ôm theo đúng cơ thể đó.
const SETUP = `{PART} of a silent {DUR} Korean try-on clip: static camera, no voice, no lip-sync, mouth closed. Caption: small white serif product code at the top-center. Face and head-to-body ratio locked 1:1 to {MODEL}. Keep her real body exactly as in {MODEL} in every frame: same bust, waist, hip and thigh size and curves; never slim, flatten or shrink the bust or hips; the outfit is fitted to this body. Background: {BG}. Left/right are the model's own.`;

// Khoá trang phục: ảnh model chỉ là tham chiếu khuôn mặt / tóc / vóc dáng. Model video hay để sót đồ cũ của KOL/KOC (cổ áo,
// tay áo, quần… lộ dưới hoặc ngoài trang phục mới, nhất là ở cú quay lưng và cận cảnh) -> nói thẳng sau match cut không còn
// mảnh nào của đồ cũ. Là 1 dòng riêng, KHÔNG sửa các mốc động tác. Cố ý không viết "wears only" để không làm mất khăn / túi / giày.
// Trước match cut các mốc vẫn ghi "plain base clothes" (đồ trơn đơn giản), không phải bộ đồ trong ảnh model.
// {CUT} = mốc match cut đầu tiên · {WEAR} = trang phục theo từng khoảng thời gian của Part 2.
// Giữ thật ngắn (≈220 ký tự): Flow từ chối prompt quá dài.
const WARDROBE = `Wardrobe: use {MODEL} for face, hair and body only, never its clothes. From {CUT}s to the end she wears {OUTFIT} (back {BACK}); no part of her earlier clothes shows under, over or beside it, back views and close-ups included.`;
const WARDROBE_PART2 = `Wardrobe: use {MODEL} for face, hair and body only, never its clothes. She wears {WEAR}; no part of the clothes in {MODEL} or of an earlier outfit shows under, over or beside it, back views and close-ups included.`;

// ---- Chuyển động 1 (theo video mẫu 43,3K: cầm móc -> khăn/túi -> quay lưng -> cận chi tiết -> kết dáng) ----
const M1_PART1 = `0.0-2.0s: Medium-wide shot. {MODEL} in plain base clothes, feet shoulder-width apart, holds the hangers of {OUTFITS} together at chest height with both hands and swings the dresses left-right twice, eyes on them, soft smile.
2.0-2.7s: Both hands lift to eye level; the left hand takes the hangers up above her head, the right hand drops to chest level.
2.7-3.5s: The left hand pushes the dresses toward the camera until the {OUTFIT} fabric fills the frame.
3.5-4.5s: Match cut, medium shot: she now wears {OUTFIT} exactly (back as {BACK}); both arms at shoulder height holding the two ends of its shawl or accent piece in a U before her chest, head tilted right, smiling, feet together.
4.5-5.3s: Jump cut: shawl draped over her shoulders; right arm relaxed holding one end, left arm out and down holding a small clutch bag at hip level, head tilted left.
5.3-6.3s: Left forearm lifts the bag to shoulder height, palm to camera; right hand touches the skirt; chin up, smile.
6.3-7.0s: Jump cut, full body: right hand on right hip, left arm down with the bag, left foot crossed in front, weight on the back leg, heels.
7.0-7.7s: Jump cut, back to camera showing {BACK}: head turned down toward her left shoulder, both arms lower slowly to her sides, bag in the left hand.
7.7-8.7s: Jump cut, medium front: shawl around the neck like a scarf, left hand holds the bag at the thigh, right hand on the right thigh, head tilted right.
8.7-9.6s: Jump cut, full body: legs crossed, both hands hold the bag together at the lower belly, still.
9.6-10.0s: Jump cut, medium front: right hand lifts the right skirt hem slightly, left hand holds the bag; sharp frame at 10.0s.`;

// Khối trang phục kế tiếp (gốc 6s): nâng túi -> toàn thân dang tay -> quay lưng -> cận chi tiết -> dang tay -> hai tay cầm túi
const M1_SEG_OUTFIT = `0.0-0.7s: Match cut, medium shot: she now wears {OUTFIT} exactly (back as {BACK}); left hand holds a small clutch bag at her left thigh, right arm relaxed, feet together, soft smile.
0.7-1.7s: Left forearm lifts the bag to shoulder height, handle hooked on open fingers; head tilts left, smile widens.
1.7-2.3s: Jump cut, full body: right arm out to the side at hip height palm down, left arm down with the bag, right foot crossed in front, weight back, heels.
2.3-3.3s: Jump cut, back to camera showing {BACK}: both arms lower slowly to her sides, hands on her thighs, head straight then slightly down to the right.
3.3-4.3s: Jump cut, close-up of the {OUTFIT} bodice and neckline from collarbone to waist, hands out of frame, still.
4.3-5.0s: Jump cut, full body front: arms slightly open with palms forward, bag in the left hand, feet together, chin down, smiling.
5.0-6.0s: Jump cut, medium front: both hands hold the bag together at the lower belly, head tilted left; sharp frame.`;

// Khối biến thể (gốc 4s): nâng vạt váy -> quay lưng -> tay bên má -> toàn thân chống hông
const M1_SEG_OUTFIT_ALT = `0.0-0.7s: Match cut, medium shot: she now wears {OUTFIT} exactly (back as {BACK}); left hand holds a small clutch bag at her left hip, right hand pinches the right skirt hem out to the side, eyes down-left at the skirt.
0.7-1.3s: She looks up at the camera smiling and sways the lifted hem once; left hand unchanged.
1.3-2.3s: Jump cut, back to camera showing {BACK}: head over her left shoulder looking down, both arms lower slowly and hold still, bag in the left hand.
2.3-3.0s: Jump cut, medium front: right hand raised beside her right cheek with fingers loosely curled, left hand holds the bag at the thigh, head tilted right, playful smile.
3.0-4.0s: Jump cut, full body front: right hand on right hip, left hand flat on the skirt near the left hip, right leg crossed in front, heels; still, gentle smile; sharp final frame.`;

// Chỉ có 1 trang phục (gốc 10s): Part 2 tiếp tục trang phục 1, không match cut
const M1_SEG_SAME = `0.0-2.0s: Same {OUTFIT} outfit, medium front: left forearm lifts the clutch bag to shoulder height, handle hooked on open fingers; right arm relaxed; head tilts left, smile widens.
2.0-4.0s: Jump cut, full body: right hand on right hip, left arm down with the bag, left foot crossed in front, weight back, heels; smiling.
4.0-6.0s: Jump cut, back to camera showing {BACK}: head over her left shoulder looking down, both arms lower slowly to her sides, bag in the left hand.
6.0-8.0s: Jump cut, close-up of the {OUTFIT} bodice and neckline from collarbone to waist, hands out of frame, still.
8.0-10.0s: Jump cut, medium front: both hands hold the bag together at the lower belly, head tilted left; sharp final frame at 10.0s.`;

// ---- Chuyển động 2 (theo video mẫu 40,5K: 1 trang phục dáng dài — giơ móc -> match cut từ sau lưng, bước ra xa ->
//      trước mặt cầm túi -> chạm dây vai -> bước tới -> quay lưng | Part 2: lưng -> trước -> nghiêng ngoái nhìn -> lưng) ----
// Chỉ dùng cho 1 trang phục (mặt trước + mặt sau) và CHỈ 1 PHÂN CẢNH (model video đã hỗ trợ tới 15s): không cắt khung
// hình cuối, không Part 2. Hai bản prompt cùng một chuyển động: 15s = đúng nhịp video mẫu; 10s = cùng trình tự, rút gọn nhịp.
const M2_15S = `0.0-1.0s: Medium-full shot. {MODEL} in plain base clothes stands left of center; her left arm is raised high holding one hanger with the long {OUTFIT} dress hanging beside her, right arm relaxed, soft smile at camera.
1.0-2.3s: Her right hand sweeps across to smooth the dress at waist height, then she pulls the dress in front of her body and steps toward the camera until its fabric fills the frame.
2.3-3.0s: Match cut, close shot from behind: she now wears {OUTFIT} exactly (back as {BACK}), back to camera, long hair down her back, arms relaxed at her sides.
3.0-4.6s: She walks slowly away from the camera with a natural hip sway, arms loose, until her full body and the trailing hem are in frame, then stops with her back to camera.
4.6-6.0s: Jump cut, full body front: both hands hold a small round handbag by its handle in front of her waist, feet together, shoulders swaying gently, smiling.
6.0-7.6s: Jump cut, medium shot: left hand raised to touch the strap at her left collarbone with curled fingers, right hand holds the bag at her right thigh, weight on one leg with the hip out, head tilted.
7.6-9.6s: Jump cut, far full-body shot: she walks three slow steps toward the camera, both hands holding the bag in front, hem flowing, then stops.
9.6-11.2s: Jump cut, full body, back to camera showing {BACK}: bag in her right hand at her side, left arm relaxed; she shifts her weight slowly from one leg to the other, head turned slightly right.
11.2-12.6s: Jump cut, front, medium-full: right hand holds the bag beside her right thigh, left hand rests on the front of her left hip, weight on the right leg, gentle smile.
12.6-14.0s: She turns into a side profile facing the right of frame and looks back over her right shoulder at the camera, bag raised to waist level in front of her, showing the full side silhouette.
14.0-15.0s: She turns fully away: back to camera showing {BACK}, hair swept forward over one shoulder to reveal the back straps, bag in her right hand, still; sharp final frame.`;

const M2_10S = `0.0-0.8s: Medium-full shot. {MODEL} in plain base clothes stands left of center; her left arm is raised high holding one hanger with the long {OUTFIT} dress hanging beside her, right arm relaxed, soft smile at camera.
0.8-1.8s: Her right hand smooths the dress at waist height, then she pulls it in front of her body and steps toward the camera until its fabric fills the frame.
1.8-3.2s: Match cut, close shot from behind: she now wears {OUTFIT} exactly (back as {BACK}), back to camera, long hair down her back; she walks slowly away with a natural hip sway until her full body and the trailing hem are in frame.
3.2-4.4s: Jump cut, full body front: both hands hold a small round handbag by its handle in front of her waist, feet together, shoulders swaying gently, smiling.
4.4-5.6s: Jump cut, medium shot: left hand touches the strap at her left collarbone with curled fingers, right hand holds the bag at her right thigh, weight on one leg with the hip out, head tilted.
5.6-7.0s: Jump cut, far full-body shot: she walks two slow steps toward the camera, both hands holding the bag in front, hem flowing, then stops.
7.0-8.0s: Jump cut, full body, back to camera showing {BACK}: bag in her right hand at her side, she shifts her weight from one leg to the other.
8.0-9.0s: She turns into a side profile facing the right of frame and looks back over her right shoulder at the camera, bag raised to waist level, showing the side silhouette.
9.0-10.0s: She turns fully away: back to camera showing {BACK}, hair swept forward over one shoulder to reveal the back straps, still; sharp final frame.`;

const COMMON_RULE = `Jump cuts are instant cuts; the camera never moves. One small bag per outfit, kept consistent, never hiding the garment. Natural hands, smooth motion, no text except the caption.`;

export const MOTIONS = {
  motion1: {
    name: 'Chuyển động 1 – cầm móc → khăn/túi → quay lưng → cận chi tiết → kết dáng (theo video mẫu)',
    prompts: {
      m1_part1: { label: 'Chuyển động 1 · Part 1 (0–10s): mở đầu cầm móc + trang phục 1 ({OUTFIT}/{BACK} = mặt trước/sau bộ 1)', text: M1_PART1 },
      m1_seg_outfit: { label: 'Chuyển động 1 · Khối trang phục kế tiếp (gốc 6s, tự co giãn theo thời lượng được chia)', text: M1_SEG_OUTFIT },
      m1_seg_outfit_alt: { label: 'Chuyển động 1 · Khối biến thể cho trang phục kế tiếp (gốc 4s)', text: M1_SEG_OUTFIT_ALT },
      m1_seg_same: { label: 'Chuyển động 1 · Khi chỉ có 1 trang phục: Part 2 tiếp tục trang phục 1 (gốc 10s)', text: M1_SEG_SAME },
    },
    part1: 'm1_part1',
    cutAt: 3.5, // mốc match cut đầu tiên trong Part 1
    segments: ['m1_seg_outfit', 'm1_seg_outfit_alt'], // luân phiên cho trang phục 2, 3, 4…
    same: 'm1_seg_same',
  },
  motion2: {
    name: 'Chuyển động 2 – 1 trang phục, 1 phân cảnh (15s hoặc 10s): giơ móc → bước ra xa (lưng) → cầm túi → chạm dây vai → bước tới → lưng → nghiêng ngoái nhìn → lưng',
    prompts: {
      m2_15s: { label: 'Chuyển động 2 · bản 15s (1 phân cảnh, đúng nhịp video mẫu; {OUTFIT}/{BACK} = mặt trước/sau)', text: M2_15S },
      m2_10s: { label: 'Chuyển động 2 · bản 10s (1 phân cảnh, cùng trình tự động tác, nhịp rút gọn)', text: M2_10S },
    },
    single: true, // 1 phân cảnh duy nhất: không cắt khung hình cuối, không Part 2
    durations: { '15s': { prompt: 'm2_15s', cutAt: 2.3 }, '10s': { prompt: 'm2_10s', cutAt: 1.8 } },
    maxOutfits: 1,
  },
};
export const SINGLE_DURATIONS = ['15s', '10s'];
const isSingle = (run) => !!(MOTIONS[run.options.motion] || MOTIONS[DEFAULT_MOTION]).single;
const singleDuration = (run) => (SINGLE_DURATIONS.includes(run.options.duration) ? run.options.duration : SINGLE_DURATIONS[0]);
const DEFAULT_MOTION = 'motion1';
const motionOf = (run) => MOTIONS[run.options.motion] || MOTIONS[DEFAULT_MOTION];

const fmtT = (t) => (Math.round(t * 10) / 10).toFixed(1);
const fill = (text, vars) => text.replace(/\{(MODEL|OUTFITS|OUTFIT|BACK|CODE|BG|START|PART|DUR|CUT|WEAR)\}/g, (m, k) => (vars[k] != null ? vars[k] : m));

/**
 * Prompt cho chuyển động 1 phân cảnh (motion.single): cả video trong 1 lần tạo, thời lượng '15s' | '10s' chọn bản prompt
 * tương ứng (cùng chuyển động, khác nhịp). outfit = { code, p1: { front, back } }.
 */
export function buildSinglePrompt({ motion, prompt, outfit, tags, duration }) {
  const d = motion.durations[duration] || Object.values(motion.durations)[0];
  const setup = (prompt('setup') || SETUP).trim();
  const rule = (prompt('rule') ?? COMMON_RULE).trim();
  const vars = { MODEL: '@Image1', BG: tags.p1.bg, OUTFITS: outfit.p1.front, OUTFIT: outfit.p1.front, BACK: outfit.p1.back, CODE: outfit.code, PART: 'One continuous take', DUR: duration, CUT: fmtT(d.cutAt) };
  return [
    fill(setup, vars),
    `Caption: "${outfit.code}" for the whole clip.`,
    fill((prompt('wardrobe') || WARDROBE).trim(), vars),
    fill(prompt(d.prompt), vars),
    `${rule} Clean match cut at ${fmtT(d.cutAt)}s. Sharp final frame at ${fmtT(parseFloat(duration))}s.`.trim(),
  ].join('\n');
}
const listTags = (tags) => (tags.length <= 1 ? tags[0] || '' : tags.slice(0, -1).join(', ') + ' and ' + tags.at(-1));

// Đổi mốc giây của 1 khối "a-bs: …" (thời gian cục bộ, gốc = mốc cuối lớn nhất) sang [offset, offset+slot] rồi điền chỗ trống
export function rescaleBeats(text, { offset, slot }, vars) {
  const beats = text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const m = l.match(/^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)s\s*:\s*(.*)$/);
    return m ? { a: Number(m[1]), b: Number(m[2]), text: m[3] } : { text: l };
  });
  const timed = beats.filter((b) => b.a != null);
  const base = timed.length ? Math.max(...timed.map((b) => b.b)) : slot;
  const k = base > 0 ? slot / base : 1;
  return beats
    .map((b) => (b.a == null ? fill(b.text, vars) : `${fmtT(offset + b.a * k)}-${fmtT(offset + b.b * k)}s: ${fill(b.text, vars)}`))
    .join('\n');
}

// Chia 10s của Part 2 cho k trang phục còn lại: 0 -> [10] (tiếp tục bộ 1); 1 -> [10]; 2 -> [6, 4] (đúng video mẫu); 3 -> ~3.3s mỗi bộ
export function part2Slots(k) {
  if (k <= 1) return [PART_SEC];
  if (k === 2) return [6, 4];
  const each = Math.round((PART_SEC / k) * 10) / 10;
  const slots = Array.from({ length: k - 1 }, () => each);
  slots.push(Math.round((PART_SEC - each * (k - 1)) * 10) / 10);
  return slots;
}

const captionRule = (ranges) =>
  'Caption: ' + ranges.map(([a, b, code]) => `${fmtT(a)}-${fmtT(b)}s "${code}"`).join('; ') + ' (switches exactly on each match cut).';

/**
 * Dựng prompt 2 phân cảnh. outfits = [{ code, p1: { front, back }, p2: { front, back } }] với các tag theo thứ tự ảnh của
 * TỪNG phân cảnh (xem imagesFor). prompt(key) = prompt mẫu đã đóng băng của lần chạy.
 */
export function buildPrompts({ motion, prompt, outfits, tags }) {
  const setup = (prompt('setup') || SETUP).trim();
  const rule = (prompt('rule') ?? COMMON_RULE).trim();
  const first = outfits[0];
  if (motion.maxOutfits && outfits.length > motion.maxOutfits) {
    throw new Error(`"${motion.name.split(' – ')[0]}" chỉ dùng cho ${motion.maxOutfits} trang phục (đang chọn ${outfits.length}) — bỏ bớt trang phục hoặc đổi sang chuyển động khác`);
  }
  const v1 = { MODEL: '@Image1', BG: tags.p1.bg, OUTFITS: listTags(outfits.map((o) => o.p1.front)), OUTFIT: first.p1.front, BACK: first.p1.back, CODE: first.code, DUR: '10s', CUT: fmtT(motion.cutAt ?? 3.5) };
  const part1 = [
    fill(setup, { ...v1, PART: 'Part 1 of 2' }),
    `Caption: "${first.code}" for the whole clip.`,
    fill((prompt('wardrobe') || WARDROBE).trim(), v1),
    fill(prompt(motion.part1), v1),
    `${rule} Clean match cut at ${fmtT(motion.cutAt ?? 3.5)}s; the last frame is the first frame of Part 2.`.trim(),
  ].join('\n');

  const rest = outfits.slice(1);
  const slots = part2Slots(rest.length);
  const ranges = [];
  const blocks = [];
  const wear = []; // trang phục theo từng khoảng thời gian (cho dòng Wardrobe của Part 2)
  const v2 = { MODEL: '@Image1', BG: tags.p2.bg, START: tags.p2.start, DUR: '10s' };
  if (!rest.length) {
    ranges.push([0, PART_SEC, first.code]);
    wear.push(`${first.p2.front} (back ${first.p2.back}) for the whole clip`);
    blocks.push(rescaleBeats(prompt(motion.same), { offset: 0, slot: PART_SEC }, { ...v2, OUTFIT: first.p2.front, BACK: first.p2.back, CODE: first.code }));
  } else {
    let t = 0;
    rest.forEach((o, i) => {
      ranges.push([t, t + slots[i], o.code]);
      wear.push(`${o.p2.front} (back ${o.p2.back}) ${rest.length > 1 ? `at ${fmtT(t)}-${fmtT(t + slots[i])}s` : 'for the whole clip'}`);
      blocks.push(rescaleBeats(prompt(motion.segments[i % motion.segments.length]), { offset: t, slot: slots[i] }, { ...v2, OUTFIT: o.p2.front, BACK: o.p2.back, CODE: o.code }));
      t += slots[i];
    });
  }
  const cuts = ranges.map(([a]) => `${fmtT(a)}s`).join(' and ');
  const part2 = [
    fill(setup, { ...v2, PART: 'Part 2 of 2' }),
    `Opens exactly on ${tags.p2.start} (last frame of Part 1: same pose, framing, background), then continues. ${tags.p2.start} is a pose reference only: any text in it belongs to Part 1 and must not appear; from the very first frame the caption reads "${ranges[0][2]}".`,
    captionRule(ranges),
    fill((prompt('wardrobe2') || WARDROBE_PART2).trim(), { ...v2, WEAR: wear.join(', then ') }),
    ...blocks,
    `${rule}${rest.length ? ` Clean match cuts at ${cuts}.` : ''} Sharp final frame at 10.0s.`.trim(),
  ].join('\n');
  return { part1, part2, ranges };
}

export default {
  id: 'video-thoi-trang-khong-voice',
  name: 'Video bán hàng thời trang không voice',
  icon: '🤫',
  noVideo: true,
  codedInput: 'outfits', // input có mã sản phẩm theo từng ảnh (giao diện hiện ô sửa mã)
  backInput: 'outfitBacks', // inputs.outfitBacks = { [ảnh mặt trước]: ảnh mặt sau } (giao diện chọn / tạo mặt sau cho từng bộ)
  // Thẻ video của từng phân cảnh hiện ngay trong lần chạy (Thử lại -> thêm lần tạo 1, 2, 3… trên cùng thẻ, chọn bản tốt nhất)
  sceneJobs: [
    { key: 'video:part1', label: 'Phân cảnh 1 (hoặc cả video nếu 1 phân cảnh)', note: 'Đổi bản → cắt lại khung hình cuối, tạo lại Phân cảnh 2 và ghép lại.' },
    { key: 'video:part2', label: 'Phân cảnh 2', note: 'Thử lại / đổi bản → chỉ ghép lại với bản đang chọn.' },
  ],
  description: '1 ảnh model + 1–4 trang phục (mặt trước + mặt sau, theo thứ tự) + 1 ảnh bối cảnh → 2 phân cảnh 10s không voice: mở đầu cầm móc, mặc từng bộ với mã sản phẩm riêng làm caption, quay lưng khoe mặt sau, động tác tay chân theo "chuyển động" chọn sẵn.',
  inputs: [
    { key: 'model', kind: 'model', label: 'Ảnh model (@Image1)', required: true },
    // hideBackViews: thư viện ở ô này không hiện ảnh mặt sau (chúng được chọn ở khối "Từng trang phục" bên dưới)
    { key: 'outfits', kind: 'product', label: `Ảnh trang phục MẶT TRƯỚC (chọn 1–${MAX_OUTFITS} theo thứ tự mặc)`, required: true, multiple: true, max: MAX_OUTFITS, hideBackViews: true },
    { key: 'background', kind: 'background', label: 'Ảnh bối cảnh', required: true },
  ],
  prompts: {
    setup: { label: 'Phần mở đầu chung của mỗi phân cảnh ({PART}, {MODEL}, {BG})', text: SETUP },
    wardrobe: { label: 'Khoá trang phục – Part 1 / video 1 phân cảnh: sau match cut ({CUT}s) không còn đồ cũ của model ({OUTFIT}/{BACK})', text: WARDROBE },
    wardrobe2: { label: 'Khoá trang phục – Part 2 ({WEAR} = trang phục theo từng khoảng thời gian)', text: WARDROBE_PART2 },
    ...Object.fromEntries(Object.values(MOTIONS).flatMap((m) => Object.entries(m.prompts))),
    rule: { label: 'Dòng quy tắc ngắn cuối mỗi phân cảnh (để trống nếu không cần)', text: COMMON_RULE },
  },
  options: [
    { key: 'motion', label: 'Chuyển động (kịch bản tay chân)', options: Object.entries(MOTIONS).map(([k, m]) => ({ value: k, label: m.name })), default: DEFAULT_MOTION },
    { key: 'duration', label: 'Thời lượng (chỉ cho chuyển động 1 phân cảnh, vd. Chuyển động 2)', options: SINGLE_DURATIONS.map((d) => ({ value: d, label: d === '15s' ? '15s – đúng nhịp video mẫu' : '10s – cùng chuyển động, nhịp rút gọn' })), default: SINGLE_DURATIONS[0] },
    { key: 'flowModel', label: 'Mô hình Flow', options: FASHION_MODELS.map((m) => ({ value: m, label: m })), default: FASHION_MODELS[0] },
    { key: 'removeWatermark', label: 'Tự động xoá logo Gemini khi ghép', default: true },
    { key: 'autoPublish', label: 'Tự động chuyển sang Đăng video khi hoàn thành', default: true },
  ],

  stages: [
    {
      id: 'part1',
      label: 'Phân cảnh 1 (hoặc cả video nếu 1 phân cảnh)',
      async run(ctx) {
        const { outfits, tags, images } = prepare(ctx);
        const motion = motionOf(ctx.run);
        // Chuyển động 1 phân cảnh: cả video trong 1 lần tạo, thời lượng 15s / 10s chọn bản prompt tương ứng
        const single = !!motion.single;
        const duration = single ? singleDuration(ctx.run) : '10s';
        const template = single
          ? buildSinglePrompt({ motion, prompt: (k) => ctx.prompt(k), outfit: outfits[0], tags, duration })
          : buildPrompts({ motion, prompt: (k) => ctx.prompt(k), outfits, tags }).part1;
        ctx.state.codes = outfits.map((o) => o.code);
        ctx.state.part1Prompt = template;
        const job = ctx.ensureJob('video:part1', {
          type: 'video',
          imagePaths: images.p1,
          template,
          videoLabel: `[${outfits.map((o) => o.code).join('+')}] Không voice · ${single ? `1 phân cảnh ${duration}` : 'Part 1'} – ${ctx.assetName(ctx.inputs.outfits[0])}`,
          meta: { aspectRatio: '9:16', flowVideoModel: ctx.run.options.flowModel || FASHION_MODELS[0], flowDuration: duration, flowResolution: '720p', codes: outfits.map((o) => o.code) },
        });
        if (job.status === 'failed') throw ctx.jobError(job);
        if (job.status !== 'done') return 'waiting';
        return 'done';
      },
    },
    {
      id: 'last_frame',
      label: 'Cắt khung hình cuối Part 1',
      when: (run) => !isSingle(run),
      async run(ctx) {
        const j1 = ctx.job('video:part1');
        if (!j1?.outputPath || !fs.existsSync(j1.outputPath)) throw new Error('Chưa có video Part 1 để cắt khung hình cuối');
        if (!ctx.state.path || ctx.state.from !== j1.outputPath || !fs.existsSync(ctx.state.path)) {
          const raw = path.join(DIRS.tmp, `novoice-last-${j1.id}-${Date.now()}.png`);
          await extractLastFrame(j1.outputPath, raw);
          // Khung hình cuối có sẵn dòng mã của trang phục 1 -> xoá dải chữ phía trên, nếu không Flow chép mã cũ sang Part 2
          const clean = raw.replace(/\.png$/, '-clean.png');
          try {
            await removeCaptionBand(raw, clean);
            ctx.state.path = clean;
          } catch (e) {
            console.error('Xoá dải chữ khung hình cuối lỗi, dùng ảnh gốc:', e.message);
            ctx.state.path = raw;
          }
          ctx.state.rawPath = raw;
          ctx.state.cleanTried = true;
          ctx.state.from = j1.outputPath;
        }
        return 'done';
      },
    },
    {
      id: 'part2',
      label: 'Phân cảnh 2 (10–20s)',
      when: (run) => !isSingle(run),
      async run(ctx) {
        const frame = ctx.stages.last_frame?.path;
        if (!frame || !fs.existsSync(frame)) throw new Error('Chưa có khung hình cuối của Part 1');
        const { outfits, tags, images } = prepare(ctx, frame);
        const built = buildPrompts({ motion: motionOf(ctx.run), prompt: (k) => ctx.prompt(k), outfits, tags });
        ctx.state.part2Prompt = built.part2;
        ctx.state.ranges = built.ranges;
        const job = ctx.ensureJob('video:part2', {
          type: 'video',
          imagePaths: images.p2,
          template: built.part2,
          videoLabel: `[${(outfits.slice(1).length ? outfits.slice(1) : outfits).map((o) => o.code).join('+')}] Không voice · Part 2 – ${ctx.assetName(ctx.inputs.outfits[0])}`,
          meta: { aspectRatio: '9:16', flowVideoModel: ctx.run.options.flowModel || FASHION_MODELS[0], flowDuration: '10s', flowResolution: '720p', startFrame: frame },
        });
        if (job.status === 'failed') throw ctx.jobError(job);
        if (job.status !== 'done') return 'waiting';
        return 'done';
      },
    },
    {
      id: 'merge',
      label: 'Ghép phân cảnh & xoá logo',
      async run(ctx) {
        const single = isSingle(ctx.run);
        const j1 = ctx.job('video:part1');
        const j2 = single ? null : ctx.job('video:part2');
        if (!j1?.outputPath || (!single && !j2?.outputPath)) throw new Error(single ? 'Thiếu video đầu ra' : 'Thiếu video Part 1 hoặc Part 2');
        const codes = ctx.stages.part1?.codes || [];
        return ctx.ensureMerge({
          jobIds: single ? [j1.id] : [j1.id, j2.id],
          name: `[${codes.join('+')}] Video thời trang không voice – ${ctx.assetName(ctx.inputs.outfits[0])}`,
          removeWatermark: ctx.run.options.removeWatermark ?? true,
          keepOriginalAudio: false,
        });
      },
    },
  ],

  // Đồng bộ khi kết quả 1 phân cảnh đổi (Thử lại = thêm 1 lần tạo vào CÙNG job, chọn lần tạo khác, xoá lần tạo):
  //  - Part 1 đổi -> cắt lại khung hình cuối, làm lại Part 2 (job mới vì ảnh đầu vào đổi) và ghép lại. Chỉ xảy ra 1 lần cho
  //    mỗi kết quả Part 1: bước last_frame ghi lại `from` = video Part 1 đã dùng.
  //  - Part 2 đổi (hoặc video duy nhất của chuyển động 1 phân cảnh) -> CHỈ ghép lại với bản đang chọn.
  // Tuyệt đối không đặt lại Part 2 theo điều kiện "đúng mãi" (vd. tên file khung hình): mỗi lần Part 2 xong lại sinh job mới
  // -> lặp vô hạn, tốn credit, và không còn các lần tạo 1, 2, 3 trên cùng 1 thẻ để chọn bản tốt nhất.
  sync(run) {
    const jobsMap = run.stages._jobs || {};
    const jobOf = (k) => (jobsMap[k] ? db.jobs.find((j) => j.id === jobsMap[k]) : null);
    const single = isSingle(run);
    const j1 = jobOf('video:part1');
    let changed = false;
    if (!single) {
      const lf = run.stages.last_frame;
      if (j1?.outputPath && lf?.from && lf.from !== j1.outputPath) {
        for (const id of ['last_frame', 'part2']) {
          const st = run.stages[id];
          if (st && st.status !== 'pending' && st.status !== 'skipped') { st.status = 'pending'; changed = true; }
        }
        const ms = run.stages.merge;
        if (ms && ms.status !== 'skipped' && (ms.status !== 'pending' || ms.mergeId)) { run.stages.merge = { status: 'pending' }; changed = true; }
        if (jobsMap['video:part2']) { delete jobsMap['video:part2']; changed = true; }
        return changed;
      }
      upgradeOldFrame(lf, jobOf('video:part2'));
    }
    const ms = run.stages.merge;
    const merge = ms?.mergeId && db.merges.find((m) => m.id === ms.mergeId);
    if (merge?.inputPaths) {
      const current = single ? [j1?.outputPath] : [j1?.outputPath, jobOf('video:part2')?.outputPath];
      if (current.every(Boolean) && current.some((p, i) => p !== merge.inputPaths[i])) { run.stages.merge = { status: 'pending' }; changed = true; }
    }
    return changed;
  },
};

// Lần chạy cũ (trước khi có bước xoá dải mã): khung hình cuối còn dòng mã của trang phục 1. Làm sạch đúng 1 lần ở nền rồi đổi
// ảnh đầu vào của job Part 2 sang khung sạch, để lần "Thử lại" sau dùng khung sạch. KHÔNG đặt lại bước nào, KHÔNG tạo job.
function upgradeOldFrame(lf, j2) {
  if (!lf?.path || lf.cleanTried || /-clean\.png$/.test(lf.path) || !fs.existsSync(lf.path)) return;
  lf.cleanTried = true;
  const raw = lf.path;
  const clean = raw.replace(/\.png$/, '-clean.png');
  removeCaptionBand(raw, clean)
    .then(() => {
      if (lf.path !== raw) return; // khung hình đã được cắt lại trong lúc chờ
      lf.rawPath = raw;
      lf.path = clean;
      if (j2?.imagePaths) j2.imagePaths = j2.imagePaths.map((p) => (p === raw ? clean : p));
      if (j2?.meta?.startFrame === raw) j2.meta.startFrame = clean;
      save();
    })
    .catch((e) => console.error('Xoá dải chữ khung hình cuối (lần chạy cũ) lỗi:', e.message));
}

// Ảnh mặt sau của 1 ảnh mặt trước: người dùng chỉ định (inputs.outfitBacks), không thì ảnh mặt sau mới nhất tạo từ ảnh đó
export function backOf(frontId, chosen) {
  if (chosen && db.assets.some((a) => a.id === chosen)) return chosen;
  const gen = db.assets.find((a) => a.fromAssetId === frontId && (a.isBackView || /Mặt sau Flow/.test(a.name || '')));
  return gen?.id || null;
}

// Thu nguyên liệu + tag theo đúng thứ tự ảnh của từng phân cảnh (xem đầu file). Mã sản phẩm: của ảnh mặt trước (kế thừa
// theo chuỗi fromAssetId), chưa có thì cấp mới.
function prepare(ctx, startFrame = null) {
  const model = ctx.assetPath(ctx.inputs.model);
  const bg = ctx.assetPath(ctx.inputs.background);
  const ids = (ctx.inputs.outfits || []).slice(0, MAX_OUTFITS);
  if (!model) throw new Error('Ảnh model không còn trong thư viện');
  if (!bg) throw new Error('Ảnh bối cảnh không còn trong thư viện');
  if (!ids.length) throw new Error('Chưa chọn ảnh trang phục');
  const outfits = ids.map((id, i) => {
    const front = ctx.assetPath(id);
    if (!front) throw new Error(`Ảnh trang phục thứ ${i + 1} không còn trong thư viện`);
    const backId = backOf(id, ctx.inputs.outfitBacks?.[id]);
    const back = ctx.assetPath(backId);
    if (!back) throw new Error(`Trang phục ${i + 1} (${ctx.assetName(id)}) chưa có ảnh mặt sau — chọn hoặc bấm "Tạo mặt sau" trong trang quy trình rồi chạy lại`);
    return { id, backId, front, back, code: codeOfAsset(id) || assignCode(id).productCode };
  });
  const motion = motionOf(ctx.run);
  if (motion.maxOutfits && outfits.length > motion.maxOutfits) {
    throw new Error(`"${motion.name.split(' – ')[0]}" chỉ dùng cho ${motion.maxOutfits} trang phục (đang chọn ${outfits.length}) — bỏ bớt trang phục hoặc đổi sang chuyển động khác`);
  }
  // Part 1: model, trước 1, sau 1, mặt trước các bộ còn lại (cầm trên móc), bối cảnh
  const p1 = [model, outfits[0].front, outfits[0].back, ...outfits.slice(1).map((o) => o.front), bg];
  // Part 2: model, (trước, sau) từng bộ còn lại (hoặc bộ 1 nếu chỉ có 1 bộ), bối cảnh, khung hình cuối Part 1
  const rest = outfits.length > 1 ? outfits.slice(1) : outfits;
  const p2 = [model, ...rest.flatMap((o) => [o.front, o.back]), bg, ...(startFrame ? [startFrame] : [])];
  const tag = (list, file) => `@Image${list.indexOf(file) + 1}`;
  const tagged = outfits.map((o) => ({
    ...o,
    p1: { front: tag(p1, o.front), back: p1.includes(o.back) ? tag(p1, o.back) : tag(p1, o.front) },
    p2: { front: p2.includes(o.front) ? tag(p2, o.front) : null, back: p2.includes(o.back) ? tag(p2, o.back) : null },
  }));
  const tags = { p1: { bg: tag(p1, bg) }, p2: { bg: tag(p2, bg), start: startFrame ? tag(p2, startFrame) : `@Image${p2.length + 1}` } };
  return { outfits: tagged, tags, images: { p1, p2 } };
}
