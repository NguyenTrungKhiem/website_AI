// Tích hợp Zernio API (https://zernio.com/api/v1)
// Quản lý kết nối, tải video lên CDN và lên lịch hẹn giờ đăng đa nền tảng
import fs from 'node:fs';
import path from 'node:path';
import { fetch } from 'undici';

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
 * Lấy chi tiết trạng thái bài viết từ Zernio bằng ID bài viết
 */
export async function getPost(apiKey, postId) {
  if (!apiKey?.trim()) throw new Error('Chưa cung cấp Zernio API Key');
  if (!postId) throw new Error('Thiếu ID bài viết');
  const res = await zernioFetch(`/posts/${postId}`, apiKey, { method: 'GET' });
  return res.post || res;
}
