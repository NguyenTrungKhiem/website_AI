// ---- Prompt mẫu cho từng bước ----

// Prompt mẫu sửa được ở Cài đặt. {prompt} = prompt riêng của từng lần tạo (không có thì nối vào cuối).
// Ảnh luôn gửi theo thứ tự: ảnh model -> ảnh sản phẩm (motion) | ảnh bối cảnh (thay bối cảnh), rồi tới video.
export const DEFAULT_MOTION_TEMPLATE = `[PROTOCOL: TOTAL_VISUAL_RECONSTRUCTION]
IDENTITY_FUSION (MULTI-VIEW): Using 3D skeletal motion transfer.
[CORE DIRECTIVE: SKELETAL_IDENTITY_ANCHORING]
1. KINETIC_PRIORITY: The rhythmic timing, speed, and spatial translation of the source video are SACROSANCT. Do not alter the dance path.
2. GEOMETRIC_RECONSTRUCTION: Sculpt the target face's bone structure (jawline, brow, eye sockets) EXACTLY as the reference photo.
3. MOTION_MAP: Anchor every facial pixel onto the source video's head-skeleton. The face must "slide" perfectly with the original dance movement.
4. IDENTITY_OVER_EXPRESSION: If there is a conflict, prioritize the static geometry of the reference face over the fluid expressions of the source.
5. SILENT_WORKFLOW: Ignore all audio data. No lip-sync or speech editing.

STRICT MOTION LOCK: Maintain 100% original skeletal movement. Zero spatial distortion. Keep limb and torso trajectories identical to source.
FINAL_OBJECTIVE: Force the source body to wear the reference outfit and the reference face. The face MUST look like the photo, but the dance MUST be identical to the source.
{prompt}`;

export const DEFAULT_BACKGROUND_TEMPLATE = `Keep the person, their motion, the product and the camera movement exactly the same as the input video.
Replace only the background and environment with the scene shown in the reference image, with matching lighting, shadows and perspective so it looks naturally filmed there.
{prompt}`;

export function fillTemplate(template, userPrompt) {
  const p = (userPrompt || '').trim();
  const out = template.includes('{prompt}') ? template.replace('{prompt}', p) : `${template}\n${p}`;
  return out.trim();
}

// Flow hiểu ảnh tham chiếu theo thứ tự ảnh trong ô prompt nên không cần đánh nhãn từng ảnh
export function buildMotionPrompt({ userPrompt, raw, template }) {
  if (raw) return userPrompt;
  return fillTemplate(template || DEFAULT_MOTION_TEMPLATE, userPrompt);
}

export function buildBackgroundPrompt({ userPrompt, raw, template }) {
  if (raw) return userPrompt;
  return fillTemplate(template || DEFAULT_BACKGROUND_TEMPLATE, userPrompt);
}
