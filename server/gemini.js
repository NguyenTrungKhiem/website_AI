// Gọi Gemini Omni Flash qua REST (Interactions API).
// Tài liệu: https://ai.google.dev/gemini-api/docs/omni
import fs from 'node:fs';
import path from 'node:path';
import { fetch, Agent } from 'undici';

const BASE = 'https://generativelanguage.googleapis.com';
// Tạo video chạy đồng bộ, có thể mất vài phút -> nới timeout mặc định (5 phút) của fetch.
const dispatcher = new Agent({ headersTimeout: 20 * 60_000, bodyTimeout: 20 * 60_000 });
const INLINE_LIMIT = 12 * 1024 * 1024; // video nhỏ hơn thì gửi base64 trực tiếp

const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.mp4': 'video/mp4', '.mov': 'video/quicktime' };
const mimeOf = (f) => MIME[path.extname(f).toLowerCase()] || 'application/octet-stream';

async function api(url, apiKey, init = {}) {
  const res = await fetch(url, {
    dispatcher,
    ...init,
    headers: { 'x-goog-api-key': apiKey, ...init.headers },
  });
  if (!res.ok) {
    const text = await res.text();
    let msg = text;
    try {
      const j = JSON.parse(text);
      msg = (Array.isArray(j) ? j[0] : j)?.error?.message || text;
    } catch {}
    // "limit: 0" = model này không có quota miễn phí -> cần bật thanh toán, thử lại cũng vô ích
    const noQuota = res.status === 429 && /limit:\s*0\b/.test(msg);
    const hint = noQuota
      ? '\n→ API key đang ở gói Free, model này không có lượt miễn phí. Bật thanh toán (Billing) cho project của API key tại https://aistudio.google.com/usage rồi thử lại. Credit Google Flow / gói Google AI Pro không dùng được cho Gemini API.'
      : '';
    const err = new Error(`Gemini ${res.status}: ${msg}${hint}`);
    err.status = res.status;
    err.permanent = noQuota;
    throw err;
  }
  return res;
}

// Upload file lên Files API (resumable) và chờ tới khi ACTIVE.
export async function uploadFile(apiKey, file) {
  const size = fs.statSync(file).size;
  const start = await api(`${BASE}/upload/v1beta/files`, apiKey, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(size),
      'X-Goog-Upload-Header-Content-Type': mimeOf(file),
    },
    body: JSON.stringify({ file: { display_name: path.basename(file) } }),
  });
  const uploadUrl = start.headers.get('x-goog-upload-url');
  const done = await api(uploadUrl, apiKey, {
    method: 'POST',
    headers: { 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' },
    body: fs.readFileSync(file),
  });
  let info = (await done.json()).file;
  return waitActive(apiKey, info);
}

async function waitActive(apiKey, info) {
  for (let i = 0; info.state === 'PROCESSING' && i < 120; i++) {
    await sleep(5000);
    info = await (await api(`${BASE}/v1beta/${info.name}`, apiKey)).json();
  }
  if (info.state !== 'ACTIVE') throw new Error(`File ${info.name} không xử lý được (state=${info.state})`);
  return info;
}

async function videoPart(apiKey, file) {
  if (fs.statSync(file).size <= INLINE_LIMIT) {
    return { type: 'video', mime_type: mimeOf(file), data: fs.readFileSync(file).toString('base64') };
  }
  const info = await uploadFile(apiKey, file);
  return { type: 'video', uri: info.uri };
}

const imagePart = (file) => ({ type: 'image', mime_type: mimeOf(file), data: fs.readFileSync(file).toString('base64') });

/**
 * Gửi 1 yêu cầu tạo video. Ảnh được đánh số <IMAGE_REF_0>, <IMAGE_REF_1>... theo thứ tự trong `images`.
 * Trả về { id, outputFile, text }.
 */
export async function generateVideo({ settings, prompt, video, images = [], outputFile }) {
  const apiKey = settings.geminiApiKey;
  if (!apiKey) throw new Error('Chưa nhập Gemini API key (vào tab Cài đặt).');

  const input = [];
  if (video) input.push(await videoPart(apiKey, video));
  for (const img of images) input.push(imagePart(img));
  input.push({ type: 'text', text: prompt });

  const body = {
    model: settings.model,
    input,
    response_format: { type: 'video', aspect_ratio: settings.aspectRatio, resolution: settings.resolution },
  };
  if (settings.task && settings.task !== 'auto') {
    body.generation_config = { video_config: { task: settings.task } };
  }

  const res = await api(`${BASE}/v1beta/interactions`, apiKey, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const interaction = await res.json();
  const { video: out, text } = extractOutput(interaction);
  if (!out) {
    throw new Error(`Model không trả về video (status=${interaction.status}). ${text || ''}`.trim());
  }

  if (out.data) {
    fs.writeFileSync(outputFile, Buffer.from(out.data, 'base64'));
  } else if (out.uri) {
    await downloadFileUri(apiKey, out.uri, outputFile);
  }
  return { id: interaction.id, outputFile, text };
}

/**
 * Sinh/sửa ảnh bằng model ảnh của Gemini (generateContent, trả inlineData).
 * images = ảnh tham chiếu (vd. khung hình cắt từ video gốc). Ghi ảnh ra outputFile (.png).
 */
export async function generateImage({ settings, prompt, images = [], outputFile }) {
  const apiKey = settings.geminiApiKey;
  if (!apiKey) throw new Error('Chưa nhập Gemini API key (vào tab Cài đặt).');
  const model = settings.imageModel || 'gemini-2.5-flash-image';
  const parts = [
    ...images.map((f) => ({ inline_data: { mime_type: mimeOf(f), data: fs.readFileSync(f).toString('base64') } })),
    { text: prompt },
  ];
  const res = await api(`${BASE}/v1beta/models/${model}:generateContent`, apiKey, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseModalities: ['IMAGE', 'TEXT'] } }),
  });
  const j = await res.json();
  const outParts = j.candidates?.[0]?.content?.parts || [];
  const img = outParts.find((p) => p.inlineData || p.inline_data);
  const text = outParts.filter((p) => p.text).map((p) => p.text).join('\n');
  if (!img) throw new Error(`Model ${model} không trả về ảnh. ${text || JSON.stringify(j).slice(0, 300)}`);
  const d = img.inlineData || img.inline_data;
  fs.writeFileSync(outputFile, Buffer.from(d.data, 'base64'));
  return { id: j.responseId || null, outputFile, text };
}

// REST trả video trong steps[] (type=model_output); SDK thì có output_video.
function extractOutput(interaction) {
  let video = interaction.output_video || null;
  const texts = [];
  for (const step of interaction.steps || interaction.outputs || []) {
    const parts = Array.isArray(step.content) ? step.content : [step];
    for (const p of parts) {
      if (p.type === 'video' && (p.data || p.uri)) video = video || p;
      if (p.type === 'text' && step.type !== 'user_input' && p.text) texts.push(p.text);
    }
  }
  return { video, text: texts.join('\n') };
}

async function downloadFileUri(apiKey, uri, dest) {
  const id = uri.match(/files\/([^/?:]+)/)?.[1];
  if (!id) throw new Error(`Không đọc được file id từ URI: ${uri}`);
  const info = await (await api(`${BASE}/v1beta/files/${id}`, apiKey)).json();
  await waitActive(apiKey, info);
  const res = await api(`${BASE}/v1beta/files/${id}:download?alt=media`, apiKey);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// Gemini API cần chỉ rõ ảnh nào là <IMAGE_REF_n>; Flow hiểu theo thứ tự ảnh trong ô prompt nên không cần
function refHeader(engine, labels) {
  if (engine !== 'api' || !labels.length) return '';
  return 'Reference images: ' + labels.map((l, i) => `<IMAGE_REF_${i}> = ${l}`).join(', ') + '.\n';
}

export function buildMotionPrompt({ userPrompt, hasModel, hasProduct, raw, template, engine }) {
  if (raw) return userPrompt;
  const labels = [hasModel && 'the reference photo (model face and identity)', hasProduct && 'the reference outfit / product'].filter(Boolean);
  return refHeader(engine, labels) + fillTemplate(template || DEFAULT_MOTION_TEMPLATE, userPrompt);
}

export function buildBackgroundPrompt({ userPrompt, hasBackground, raw, template, engine }) {
  if (raw) return userPrompt;
  return refHeader(engine, hasBackground ? ['the reference image (new background scene)'] : []) +
    fillTemplate(template || DEFAULT_BACKGROUND_TEMPLATE, userPrompt);
}
