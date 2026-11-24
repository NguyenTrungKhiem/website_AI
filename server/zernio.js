// Tích hợp Zernio API (https://zernio.com/api/v1)
// Quản lý kết nối, tải video lên CDN và lên lịch hẹn giờ đăng đa nền tảng
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fetch } from 'undici';
import { DIRS } from './db.js';
import { convertToJpeg } from './ffmpeg.js';

const ZERNIO_BASE_URL = 'https://zernio.com/api/v1';

async function zernioFetch(endpoint, apiKey, options = {}) {
  const url = `${ZERNIO_BASE_URL}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;
  const headers = {
    Authorization: `Bearer ${apiKey.trim()}`,
    ...options.headers,
  };
  const res = await fetch(url, { ...options, headers });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const msg = data.message || data.error?.message || data.error || data.raw || `Lỗi HTTP ${res.status}`;
    throw new Error(`Zernio API (${res.status}): ${msg}`);
  }
  return data;
}

/**
 * Lấy danh sách các tài khoản mạng xã hội đã liên kết trên Zernio
 */
export async function getAccounts(apiKey) {
  if (!apiKey?.trim()) throw new Error('Chưa cung cấp Zernio API Key');
  const res = await zernioFetch('/accounts', apiKey, { method: 'GET' });
  return res.accounts || [];
}

/**
 * Tải file video từ ổ cứng lên storage Zernio qua URL presigned (Cloudflare R2)
 * Trả về publicUrl dùng để đăng lên các mạng xã hội
 */
export async function uploadMedia(apiKey, filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`Không tìm thấy file video: ${filePath}`);
  const stats = fs.statSync(filePath);
  const filename = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mimeMap = {
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
    '.m4v': 'video/x-m4v',
    '.avi': 'video/x-msvideo',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.png': 'image/png',
  };
  const contentType = mimeMap[ext] || 'video/mp4';

  // 1. Xin presigned upload URL từ Zernio
  const presign = await zernioFetch('/media/presign', apiKey, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filename,
      contentType,
      size: stats.size,
    }),
  });

  const { uploadUrl, publicUrl } = presign;
  if (!uploadUrl || !publicUrl) {
    throw new Error('Zernio presign không trả về link upload hoặc public URL');
  }

  // 2. Upload file trực tiếp lên uploadUrl (không kèm Authorization Bearer token)
  const buf = fs.readFileSync(filePath);
  const upRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(buf.length),
    },
    body: buf,
  });

  if (!upRes.ok) {
    const errText = await upRes.text().catch(() => '');
    throw new Error(`Tải video lên Zernio storage thất bại (${upRes.status}): ${errText}`);
  }

  return publicUrl;
}

/**
 * Đăng ngay hoặc lên lịch đăng video đa nền tảng qua Zernio
 */
export async function createOrSchedulePost(apiKey, {
  content = '',
  title = '',
  publicUrl,
  filePath,
  platforms = [], // Danh sách [{ platform, accountId }]
  scheduledFor = null, // Chuỗi ISO-8601 hoặc null
  timezone = 'Asia/Ho_Chi_Minh',
  publishNow = false,
  tiktokSettings = null,
}) {
  if (!apiKey?.trim()) throw new Error('Chưa cung cấp Zernio API Key');
  if (!platforms.length) throw new Error('Chưa chọn tài khoản mạng xã hội để đăng trên Zernio');

  let mediaUrl = publicUrl;
  if (!mediaUrl && filePath) {
    mediaUrl = await uploadMedia(apiKey, filePath);
  }
  if (!mediaUrl) throw new Error('Không có URL video để đăng');

  const formattedPlatforms = platforms.map((p) => {
    const item = {
      platform: p.platform,
      accountId: p.accountId || p._id || p.id,
    };
    if (p.platform === 'youtube' && title) {
      item.platformSpecificData = { youtube: { title: title.slice(0, 100) } };
    }
    return item;
  });

  const body = {
    content: content || title || 'Video',
    mediaItems: [
      {
        type: 'video',
        url: mediaUrl,
        filename: filePath ? path.basename(filePath) : undefined,
      },
    ],
    platforms: formattedPlatforms,
  };

  if (title) {
    body.title = title;
  }

  // Cấu hình chuyên biệt cho TikTok (bao gồm TikTok Shop Affiliate / Draft / Commercial Disclosure)
  if (tiktokSettings) {
    body.tiktokSettings = {
      privacy_level: tiktokSettings.draft ? 'SELF_ONLY' : (tiktokSettings.privacy_level || 'PUBLIC_TO_EVERYONE'),
      allow_comment: tiktokSettings.allow_comment ?? true,
      allow_duet: tiktokSettings.allow_duet ?? true,
      allow_stitch: tiktokSettings.allow_stitch ?? true,
      content_preview_confirmed: true,
      express_consent_given: true,
      ...(tiktokSettings.draft ? { draft: true } : {}),
      ...(tiktokSettings.commercialContentType ? { commercialContentType: tiktokSettings.commercialContentType } : {}),
      ...(tiktokSettings.isBrandOrganicPost ? { isBrandOrganicPost: true, brand_organic_toggle: true } : {}),
      ...(tiktokSettings.brandContentToggle ? { brand_content_toggle: true } : {}),
    };
  }

  if (scheduledFor) {
    body.scheduledFor = scheduledFor;
    body.timezone = timezone || 'Asia/Ho_Chi_Minh';
  } else if (publishNow) {
    body.publishNow = true;
  }

  const res = await zernioFetch('/posts', apiKey, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  return res;
}

/**
 * TikTok Photo Mode chỉ nhận JPG/JPEG/WebP (từ chối PNG). Nếu ảnh gốc là PNG -> chuyển sang JPG sắc nét (lưu cache ở data/tmp).
 */
export async function ensureTikTokJpeg(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`Không tìm thấy file ảnh: ${filePath}`);
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg' || ext === '.webp') return filePath;
  const st = fs.statSync(filePath);
  const hash = crypto.createHash('md5').update(`${filePath}:${st.mtimeMs}:${st.size}`).digest('hex').slice(0, 12);
  const dest = path.join(DIRS.tmp, `tt-${hash}.jpg`);
  if (!fs.existsSync(dest)) await convertToJpeg(filePath, dest, 2);
  return dest;
}

/**
 * Dựng payload chuẩn Zernio API cho TikTok Photo Mode Carousel (hàm thuần phục vụ cả chạy thật & test).
 */
export function buildPhotoCarouselPayload({
  content = '',
  title = '',
  mediaUrls = [],
  filenames = [],
  platforms = [],
  scheduledFor = null,
  timezone = 'Asia/Ho_Chi_Minh',
  publishNow = false,
  tiktokSettings = null,
}) {
  const ttPayload = {
    media_type: 'photo',
    photo_cover_index: 0,
    auto_add_music: tiktokSettings?.autoAddMusic ?? tiktokSettings?.auto_add_music ?? true,
    privacy_level: tiktokSettings?.draft ? 'SELF_ONLY' : (tiktokSettings?.privacy_level || 'PUBLIC_TO_EVERYONE'),
    allow_comment: tiktokSettings?.allow_comment ?? true,
    content_preview_confirmed: true,
    express_consent_given: true,
    ...(tiktokSettings?.draft ? { draft: true } : {}),
    ...(tiktokSettings?.commercialContentType ? { commercialContentType: tiktokSettings.commercialContentType } : {}),
    ...(tiktokSettings?.isBrandOrganicPost ? { isBrandOrganicPost: true, brand_organic_toggle: true } : {}),
    ...(tiktokSettings?.brandContentToggle ? { brand_content_toggle: true } : {}),
  };

  const formattedPlatforms = platforms.map((p) => {
    const item = {
      platform: p.platform,
      accountId: p.accountId || p._id || p.id,
    };
    if (String(p.platform || '').toLowerCase().includes('tiktok')) {
      item.platformSpecificData = ttPayload;
    }
    return item;
  });

  const body = {
    content: content || title || 'Lookbook Outfit',
    mediaItems: mediaUrls.map((url, idx) => ({
      type: 'image',
      url,
      ...(filenames[idx] ? { filename: filenames[idx] } : {}),
    })),
    platforms: formattedPlatforms,
    tiktokSettings: ttPayload,
  };
  if (title) body.title = title;
  if (scheduledFor) {
    body.scheduledFor = scheduledFor;
    body.timezone = timezone || 'Asia/Ho_Chi_Minh';
  } else if (publishNow) {
    body.publishNow = true;
  }
  return body;
}

/**
 * Đăng hoặc lên lịch bài đăng nhiều ảnh TikTok Photo Mode (Carousel 2..35 ảnh) qua Zernio API.
 */
export async function createOrSchedulePhotoCarousel(apiKey, {
  content = '',
  title = '',
  imagePaths = [],
  platforms = [],
  scheduledFor = null,
  timezone = 'Asia/Ho_Chi_Minh',
  publishNow = false,
  tiktokSettings = null,
}) {
  if (!apiKey?.trim()) throw new Error('Chưa cung cấp Zernio API Key');
  if (!platforms.length) throw new Error('Chưa chọn tài khoản mạng xã hội trên Zernio');
  if (!Array.isArray(imagePaths) || imagePaths.length < 2) {
    throw new Error('TikTok Photo Carousel cần ít nhất 2 ảnh cho 1 bài đăng');
  }
  if (imagePaths.length > 35) {
    throw new Error('TikTok Photo Carousel hỗ trợ tối đa 35 ảnh/bài');
  }

  const jpgPaths = [];
  for (const p of imagePaths) {
    jpgPaths.push(await ensureTikTokJpeg(p));
  }
  const mediaUrls = [];
  const filenames = [];
  for (const jp of jpgPaths) {
    mediaUrls.push(await uploadMedia(apiKey, jp));
    filenames.push(path.basename(jp));
  }

  const body = buildPhotoCarouselPayload({
    content,
    title,
    mediaUrls,
    filenames,
    platforms,
    scheduledFor,
    timezone,
    publishNow,
    tiktokSettings,
  });

  return zernioFetch('/posts', apiKey, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * Lấy chi tiết trạng thái bài viết từ Zernio bằng ID bài viết
 */
export async function getPost(apiKey, postId) {
  if (!apiKey?.trim()) throw new Error('Chưa cung cấp Zernio API Key');
  if (!postId) throw new Error('Thiếu ID bài viết');
  const res = await zernioFetch(`/posts/${postId}`, apiKey, { method: 'GET' });
  return res.post || res;
}
