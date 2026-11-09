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
  promptVersions: (wfId, key) => req('GET', `/api/workflows/${wfId}/prompts/${key}/versions`), // lịch sử prompt gốc của 1 bước
  rollbackPrompt: (wfId, key, file) => req('POST', `/api/workflows/${wfId}/prompts/${key}/rollback`, { file }),
  uploadSource: (file) => {
    const f = new FormData();
    f.append('file', file);
    return req('POST', '/api/sources', f);
  },
  deleteSource: (id) => req('DELETE', `/api/sources/${id}`),
  cut: (id, body) => req('POST', `/api/sources/${id}/cut`, body),
  mergeSource: (id, body) => req('POST', `/api/sources/${id}/merge`, body),
  deleteMergedSource: (id) => req('DELETE', `/api/sources/${id}/merge`),
  deleteClip: (id) => req('DELETE', `/api/clips/${id}`),
  uploadAsset: (kind, file) => {
    const f = new FormData();
    f.append('kind', kind);
    f.append('file', file);
    return req('POST', '/api/assets', f);
  },
  deleteAsset: (id) => req('DELETE', `/api/assets/${id}`),
  cleanAsset: (id, prompt) => req('POST', `/api/assets/${id}/clean`, { prompt }),
  copyAsset: (id, kind) => req('POST', `/api/assets/${id}/copy`, { kind }),
  fetchProduct: (url) => req('POST', '/api/product/fetch', { url }),
  // product = kết quả bóc tách (found) để server lưu metadata (tên, giá, mô tả, link…) vào asset.product
  importProduct: (kind, images, staging = false, product = null) => req('POST', '/api/product/import', { kind, images, staging, product }),
  useAsset: (id) => req('POST', `/api/assets/${id}/use`),
  // Mã sản phẩm in lên video thời trang (VAY_01…): cấp / đổi mã cho ảnh, sổ mã, nhập từ file .txt
  assignCode: (id, code) => req('POST', `/api/assets/${id}/code`, { code: code || undefined }),
  codes: () => req('GET', '/api/codes'),
  importCodes: (text) => req('POST', '/api/codes/import', { text }),
  shopeeProduct: (url) => req('POST', '/api/product/fetch', { url }),
  shopeeImport: (kind, images) => req('POST', '/api/product/import', { kind, images }),
  motion: (body) => req('POST', '/api/jobs/motion', body),
  background: (body) => req('POST', '/api/jobs/background', body),
  retry: (id, prompt) => req('POST', `/api/jobs/${id}/retry`, { prompt }),
  importFlowJob: (id) => req('POST', `/api/jobs/${id}/import-flow`),
  selectAttempt: (id, n) => req('POST', `/api/jobs/${id}/select`, { n }),
  deleteJob: (id) => req('DELETE', `/api/jobs/${id}`),
  deleteAttempt: (id, n) => req('DELETE', `/api/jobs/${id}/attempts/${n}`),
  post: (body) => req('POST', '/api/posts', body),
  zernioAccounts: (apiKey) => req('GET', apiKey ? `/api/zernio/accounts?apiKey=${encodeURIComponent(apiKey)}` : '/api/zernio/accounts'),
  syncZernioPosts: () => req('POST', '/api/posts/sync-zernio'),
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
  // Mã sản phẩm trên ảnh kết quả & Excel cho DiamondShop (Ảnh model mặc đồ)
  runProducts: (id) => req('GET', `/api/runs/${id}/products`), // { mode: 'input', rows, frame: { width, height }, products }
  saveRunProducts: (id, body) => req('PUT', `/api/runs/${id}/products`, body), // { products: { [assetId]: {...} } } -> { rows, remerge, run }
  suggestProductCode: (title, taken = []) =>
    req('GET', `/api/products/suggest-code?title=${encodeURIComponent(title || '')}&taken=${encodeURIComponent(taken.join(','))}`),
  // Tải file Excel (blob). body.products (tuỳ chọn) = dữ liệu đang sửa để xuất thử chưa cần lưu
  exportRunProducts: async (id, body = null) => {
    const res = await fetch(`/api/runs/${id}/products.xlsx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Lỗi ${res.status}`);
    }
    const m = /filename\*?=(?:UTF-8'')?"?([^";]+)/i.exec(res.headers.get('content-disposition') || '');
    return { blob: await res.blob(), filename: m ? decodeURIComponent(m[1]) : 'san-pham.xlsx' };
  },
  cancelRun: (id) => req('POST', `/api/runs/${id}/cancel`),
  importFlowRun: (id, body = {}) => req('POST', `/api/runs/${id}/import-flow`, body),
  deleteRun: (id, withJobs = true) => req('DELETE', `/api/runs/${id}?withJobs=${withJobs ? 1 : 0}`),
  fetchLatestFlowVideo: () => req('POST', '/api/flow/latest-video'),
  flowStatus: () => req('GET', '/api/flow/status'),
  flowLaunch: () => req('POST', '/api/flow/launch'),
  flowPreset: (body) => req('POST', '/api/flow/preset', body),
  extractAudio: (sourceId) => req('POST', `/api/sources/${sourceId}/extract-audio`),
  uploadAudio: (file) => {
    const f = new FormData();
    f.append('file', file);
    return req('POST', '/api/audios', f);
  },
  deleteAudio: (id) => req('DELETE', `/api/audios/${id}`),
  merge: (body) => req('POST', '/api/merges', body),
  deleteMerge: (id) => req('DELETE', `/api/merges/${id}`),
  delogoMerge: (id) => req('POST', `/api/merges/${id}/delogo`),
  cropAsset: (body) => req('POST', '/api/assets/crop', body),
  renderBackAsset: (id, prompt) => req('POST', `/api/assets/${id}/render-back`, { prompt }),
  backFromFlow: (id) => req('POST', `/api/assets/${id}/back-from-flow`),
  analyzeFashionGarment: (body) => req('POST', '/api/fashion/analyze-and-prompt', body),
};
