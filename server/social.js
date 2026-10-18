// Đăng video lên các nền tảng qua API chính thức.
// Mỗi nền tảng cần app developer + token riêng (nhập ở tab Cài đặt). Xem README.md.
import fs from 'node:fs';
import path from 'node:path';
import { fetch } from 'undici';
import { mediaUrl } from './db.js';

const GRAPH = 'https://graph.facebook.com/v21.0';

async function json(res, label) {
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  // TikTok luôn trả error.code = "ok" khi thành công
  if (!res.ok || (data.error && data.error.code !== 'ok')) {
    const msg = data.error?.message || data.error?.description || data.error_description || text;
    throw new Error(`${label} ${res.status}: ${msg}`);
  }
  return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- YouTube (Data API v3, upload resumable) ----------
async function youtube(s, file, { title, caption }) {
  const { clientId, clientSecret, refreshToken, privacy } = s.youtube;
  if (!refreshToken) throw new Error('Chưa cấu hình YouTube');
  const tok = await json(
    await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
    }),
    'YouTube token',
  );
  const size = fs.statSync(file).size;
  const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tok.access_token}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': 'video/mp4',
      'X-Upload-Content-Length': String(size),
    },
    body: JSON.stringify({
      snippet: { title: (title || caption || 'Video').slice(0, 100), description: caption },
      status: { privacyStatus: privacy || 'private', selfDeclaredMadeForKids: false },
    }),
  });
  if (!init.ok) await json(init, 'YouTube init');
  const up = await fetch(init.headers.get('location'), {
    method: 'PUT',
    headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(size) },
    body: fs.readFileSync(file),
  });
  const v = await json(up, 'YouTube upload');
  return { id: v.id, url: `https://youtube.com/shorts/${v.id}` };
}

// ---------- Facebook Page (Graph API, upload trực tiếp) ----------
async function facebook(s, file, { caption }) {
  const { pageId, pageToken } = s.facebook;
  if (!pageId || !pageToken) throw new Error('Chưa cấu hình Facebook Page');
  const form = new FormData();
  form.append('access_token', pageToken);
  form.append('description', caption || '');
  form.append('source', new Blob([fs.readFileSync(file)], { type: 'video/mp4' }), path.basename(file));
  const r = await json(await fetch(`https://graph-video.facebook.com/v21.0/${pageId}/videos`, { method: 'POST', body: form }), 'Facebook');
  return { id: r.id, url: `https://facebook.com/${r.id}` };
}

// ---------- Instagram Reels (Graph API, upload resumable — không cần URL public) ----------
async function instagram(s, file, { caption }) {
  const { igUserId, accessToken } = s.instagram;
  if (!igUserId || !accessToken) throw new Error('Chưa cấu hình Instagram');
  const c = await json(
    await fetch(`${GRAPH}/${igUserId}/media`, {
      method: 'POST',
      body: new URLSearchParams({ media_type: 'REELS', upload_type: 'resumable', caption: caption || '', access_token: accessToken }),
    }),
    'Instagram container',
  );
  const buf = fs.readFileSync(file);
  await json(
    await fetch(`https://rupload.facebook.com/ig-api-upload/v21.0/${c.id}`, {
      method: 'POST',
      headers: { Authorization: `OAuth ${accessToken}`, offset: '0', file_size: String(buf.length) },
      body: buf,
    }),
    'Instagram upload',
  );
  await waitStatus(`${GRAPH}/${c.id}?fields=status_code&access_token=${accessToken}`, 'Instagram');
  const p = await json(
    await fetch(`${GRAPH}/${igUserId}/media_publish`, {
      method: 'POST',
      body: new URLSearchParams({ creation_id: c.id, access_token: accessToken }),
    }),
    'Instagram publish',
  );
  return { id: p.id };
}

// ---------- Threads (cần URL public để Threads tải video về) ----------
async function threads(s, file, { caption }) {
  const { userId, accessToken } = s.threads;
  if (!userId || !accessToken) throw new Error('Chưa cấu hình Threads');
  if (!s.publicBaseUrl) throw new Error('Threads cần "URL public" trong Cài đặt (vd. dùng cloudflared/ngrok)');
  const videoUrl = s.publicBaseUrl.replace(/\/$/, '') + mediaUrl(file);
  const c = await json(
    await fetch(`https://graph.threads.net/v1.0/${userId}/threads`, {
      method: 'POST',
      body: new URLSearchParams({ media_type: 'VIDEO', video_url: videoUrl, text: caption || '', access_token: accessToken }),
    }),
    'Threads container',
  );
  await waitStatus(`https://graph.threads.net/v1.0/${c.id}?fields=status,error_message&access_token=${accessToken}`, 'Threads');
  const p = await json(
    await fetch(`https://graph.threads.net/v1.0/${userId}/threads_publish`, {
      method: 'POST',
      body: new URLSearchParams({ creation_id: c.id, access_token: accessToken }),
    }),
    'Threads publish',
  );
  return { id: p.id };
}

async function waitStatus(url, label) {
  for (let i = 0; i < 60; i++) {
    const st = await json(await fetch(url), label);
    const code = st.status_code || st.status;
    if (code === 'FINISHED' || code === 'PUBLISHED') return;
    if (code === 'ERROR' || code === 'EXPIRED') throw new Error(`${label}: xử lý video lỗi ${st.error_message || ''}`);
    await sleep(5000);
  }
  throw new Error(`${label}: quá thời gian chờ xử lý video`);
}

// ---------- TikTok (Content Posting API, Direct Post) ----------
async function tiktok(s, file, { caption }) {
  const { accessToken, privacy } = s.tiktok;
  if (!accessToken) throw new Error('Chưa cấu hình TikTok');
  const buf = fs.readFileSync(file);
  const init = await json(
    await fetch('https://open.tiktokapis.com/v2/post/publish/video/init/', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({
        post_info: { title: caption || '', privacy_level: privacy || 'SELF_ONLY' },
        source_info: { source: 'FILE_UPLOAD', video_size: buf.length, chunk_size: buf.length, total_chunk_count: 1 },
      }),
    }),
    'TikTok init',
  );
  const up = await fetch(init.data.upload_url, {
    method: 'PUT',
    headers: { 'Content-Type': 'video/mp4', 'Content-Range': `bytes 0-${buf.length - 1}/${buf.length}` },
    body: buf,
  });
  if (!up.ok) throw new Error(`TikTok upload ${up.status}: ${await up.text()}`);
  return { id: init.data.publish_id };
}

export const PLATFORMS = { tiktok, instagram, threads, facebook, youtube };

export async function publish(settings, platform, file, meta) {
  const fn = PLATFORMS[platform];
  if (!fn) throw new Error(`Nền tảng không hỗ trợ: ${platform}`);
  return fn(settings, file, meta);
}
