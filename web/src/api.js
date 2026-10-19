async function req(method, url, body) {
  const isForm = body instanceof FormData;
  const res = await fetch(url, {
    method,
    headers: body && !isForm ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Lỗi ${res.status}`);
  return data;
}

export const api = {
  state: () => req('GET', '/api/state'),
  saveSettings: (s) => req('PUT', '/api/settings', s),
  uploadSource: (file) => {
    const f = new FormData();
    f.append('file', file);
    return req('POST', '/api/sources', f);
  },
  deleteSource: (id) => req('DELETE', `/api/sources/${id}`),
  cut: (id, body) => req('POST', `/api/sources/${id}/cut`, body),
  deleteClip: (id) => req('DELETE', `/api/clips/${id}`),
  uploadAsset: (kind, file) => {
    const f = new FormData();
    f.append('kind', kind);
    f.append('file', file);
    return req('POST', '/api/assets', f);
  },
  deleteAsset: (id) => req('DELETE', `/api/assets/${id}`),
  cleanAsset: (id, prompt) => req('POST', `/api/assets/${id}/clean`, { prompt }),
  fetchProduct: (url) => req('POST', '/api/product/fetch', { url }),
  importProduct: (kind, images) => req('POST', '/api/product/import', { kind, images }),
  shopeeProduct: (url) => req('POST', '/api/product/fetch', { url }),
  shopeeImport: (kind, images) => req('POST', '/api/product/import', { kind, images }),
  motion: (body) => req('POST', '/api/jobs/motion', body),
  background: (body) => req('POST', '/api/jobs/background', body),
  retry: (id, prompt) => req('POST', `/api/jobs/${id}/retry`, { prompt }),
  selectAttempt: (id, n) => req('POST', `/api/jobs/${id}/select`, { n }),
  deleteJob: (id) => req('DELETE', `/api/jobs/${id}`),
  deleteAttempt: (id, n) => req('DELETE', `/api/jobs/${id}/attempts/${n}`),
  post: (body) => req('POST', '/api/posts', body),
  importVideos: (files, clipId) => {
    const f = new FormData();
    if (clipId) f.append('clipId', clipId);
    for (const file of files) f.append('files', file);
    return req('POST', '/api/jobs/import', f);
  },
  setJobRange: (id, clipId) => req('PATCH', `/api/jobs/${id}/range`, { clipId }),
  replaceRunClip: (runId, clipId, files) => {
    const f = new FormData();
    f.append('clipId', clipId);
    for (const file of files) f.append('files', file);
    return req('POST', `/api/runs/${runId}/replace`, f);
  },
  createRun: (body) => req('POST', '/api/runs', body),
  resumeRun: (id) => req('POST', `/api/runs/${id}/resume`),
  cancelRun: (id) => req('POST', `/api/runs/${id}/cancel`),
  deleteRun: (id, withJobs = true) => req('DELETE', `/api/runs/${id}?withJobs=${withJobs ? 1 : 0}`),
  flowStatus: () => req('GET', '/api/flow/status'),
  flowLaunch: () => req('POST', '/api/flow/launch'),
  extractAudio: (sourceId) => req('POST', `/api/sources/${sourceId}/extract-audio`),
  uploadAudio: (file) => {
    const f = new FormData();
    f.append('file', file);
    return req('POST', '/api/audios', f);
  },
  deleteAudio: (id) => req('DELETE', `/api/audios/${id}`),
  merge: (body) => req('POST', '/api/merges', body),
  deleteMerge: (id) => req('DELETE', `/api/merges/${id}`),
};
