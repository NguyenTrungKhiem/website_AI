// Service worker: nhận việc từ web AutoAffiliate (gọi ra, không mở cổng), mở tab Suno/Gemini/Flow trong chính Chrome của bạn,
// giao việc cho script trong tab, rồi báo kết quả về web. Không bao giờ đọc hay gửi mật khẩu.

// flow_studio_image / flow_studio_video: việc của Video Studio (server/agentApi.js) trên Google Flow, làm bởi content/flow-studio.js
const KINDS = ["suno_create", "gemini_image", "gemini_video", "google_flow_video", "chatgpt_image", "flow_studio_image", "flow_studio_video"];
const START_URL = {
  suno_create: "https://suno.com/create",
  gemini_image: "https://gemini.google.com/app",
  gemini_video: "https://gemini.google.com/app",
  google_flow_video: "https://flow.google.com",
  chatgpt_image: "https://chatgpt.com/",
  flow_studio_image: "https://flow.google.com/?hl=en",
  flow_studio_video: "https://flow.google.com/?hl=en",
};
const REST_MS = 4_000;
const STALE_MS = 15 * 60_000;

let pollTimer = null;
function scheduleNextPoll(delayMs = 4000) {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(poll, delayMs);
  chrome.alarms.create("poll_wake", { when: Date.now() + Math.max(delayMs, 4000) });
}

const cfg = () => chrome.storage.local.get({ server: "", token: "" });
const getCurrent = async () => (await chrome.storage.session.get("current")).current ?? null;
const setCurrent = (current) => (current ? chrome.storage.session.set({ current }) : chrome.storage.session.remove("current"));
const setStatus = (patch) => chrome.storage.local.get({ status: {} }).then(({ status }) => chrome.storage.local.set({ status: { ...status, ...patch, at: Date.now() } }));

const badge = (text, color = "#ef4444") => {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
};

async function addLog(text, level = "info") {
  if (!text) return;
  const time = new Date().toLocaleTimeString("vi-VN", { hour12: false });
  const entry = { id: Date.now() + "_" + Math.random().toString(36).slice(2, 6), time, text, level };
  try {
    const { logs = [] } = await chrome.storage.local.get({ logs: [] });
    const nextLogs = [entry, ...logs].slice(0, 100);
    await chrome.storage.local.set({ logs: nextLogs });
    const cur = await getCurrent();
    if (cur?.job?.id) {
      report(cur.job.id, { message: `[${level}] ${text}` }).catch(() => {});
    }
  } catch {}
}

async function updatePending(count) {
  const pendingCount = Math.max(0, Number(count) || 0);
  await chrome.storage.local.set({ pendingCount });
  await updateBadge();
}

async function updateBadge() {
  const current = await getCurrent();
  const { pendingCount = 0, status = {} } = await chrome.storage.local.get({ pendingCount: 0, status: {} });
  if (status.connected === false && status.error) {
    badge("!", "#ef4444");
    return;
  }
  if (current) {
    badge(pendingCount > 0 ? `${pendingCount}` : "▶", "#2563eb");
    return;
  }
  if (pendingCount > 0) {
    badge(`${pendingCount}`, "#ea580c");
    return;
  }
  badge("");
}

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

let lastConfiguredOrigin = "";
async function ensureOriginRule(serverUrl) {
  if (!chrome.declarativeNetRequest?.updateDynamicRules) return;
  let origin = "";
  try {
    origin = new URL(serverUrl).origin;
  } catch {
    return;
  }
  if (!origin || origin === lastConfiguredOrigin) return;
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [1001],
      addRules: [
        {
          id: 1001,
          priority: 1,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "origin", operation: "set", value: origin },
              { header: "referer", operation: "set", value: `${origin}/` },
            ],
          },
          condition: {
            urlFilter: `${origin}/*`,
            resourceTypes: ["xmlhttprequest"],
          },
        },
      ],
    });
    lastConfiguredOrigin = origin;
  } catch (e) {
    console.warn("Failed to update declarativeNetRequest rule:", e);
  }
}

async function api(path, { body, rawBody, contentType } = {}) {
  const { server, token } = await cfg();
  if (!server || !token) throw new ApiError("Chưa cấu hình địa chỉ web và token", 0);
  await ensureOriginRule(server);
  // Có hạn chờ để mạng chết không làm treo mãi (lượt hỏi việc bị treo thì tiện ích ngừng nhận việc). Gửi file lên thì cho lâu hơn.
  const timeoutMs = rawBody ? 15 * 60_000 : 60_000;
  let res;
  let text;
  try {
    res = await fetch(server.replace(/\/+$/, "") + path, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": contentType ?? "application/json" },
      body: rawBody ?? JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await res.text();
  } catch (e) {
    if (e?.name === "TimeoutError") throw new ApiError(`Máy chủ không trả lời sau ${timeoutMs / 1000} giây (mạng chậm hoặc mất kết nối)`, 0);
    throw e;
  }
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    /* không phải JSON */
  }
  if (!res.ok) throw new ApiError(json.error ?? `Máy chủ trả lỗi ${res.status}`, res.status);
  return json;
}

/** Báo tiến độ. Trả về true nếu việc đã bị hủy hoặc đã kết thúc trên web (tab nên dừng). */
async function report(jobId, body) {
  try {
    const r = await api(`/api/agent/jobs/${jobId}`, { body });
    if (typeof r.pendingCount === "number") {
      await updatePending(r.pendingCount);
    }
    return !!r.cancelled;
  } catch (e) {
    return e instanceof ApiError && (e.status === 404 || e.status === 409);
  }
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

const upload = (jobId, { name, mime, bytes }) =>
  api(`/api/agent/jobs/${jobId}/file?name=${encodeURIComponent(name)}&type=${encodeURIComponent(mime)}`, { rawBody: bytes, contentType: mime });

// ---------- Vòng đời một việc ----------

// Bộ nhớ đệm ngăn chặn sự kiện đóng tab (onRemoved) kích hoạt báo lỗi khi công việc đã xong hoặc tiện ích tự đóng tab
const closingTabIds = new Set();
const finishingJobIds = new Set();

async function finish(jobId, outcome, senderTabId) {
  if (finishingJobIds.has(jobId)) return;
  finishingJobIds.add(jobId);
  try {
    // Chỉ đóng tab và xoá trạng thái của ĐÚNG việc này. Trước đây luôn đóng tab "hiện tại": nếu lỡ có 2 việc chạy song song
    // thì việc A xong sẽ đóng nhầm tab của việc B (lỗi "Tab đã bị đóng").
    const current = await getCurrent();
    const mine = current?.job?.id === jobId;
    const tabIdToClose = mine ? current.tabId : senderTabId;
    if (tabIdToClose) {
      closingTabIds.add(tabIdToClose);
    }
    // Xóa trạng thái trước khi đóng tab để sự kiện đóng tab không báo lỗi lần hai
    if (mine) await setCurrent(null);
    if (outcome.result) {
      await addLog("✅ Hoàn thành công việc!", "success");
      await report(jobId, { status: "done", result: outcome.result });
    } else if (outcome.error) {
      await addLog(`❌ Thất bại: ${String(outcome.error).slice(0, 150)}`, "error");
      await report(jobId, { status: "failed", error: String(outcome.error).slice(0, 480) });
    }
    if (tabIdToClose) {
      chrome.tabs.remove(tabIdToClose).catch(() => {});
      setTimeout(() => closingTabIds.delete(tabIdToClose), 4000);
    }
    await chrome.storage.local.remove(`state:${jobId}`);
    await setStatus({ job: null, lastError: outcome.error ? String(outcome.error) : "" });

    const { pendingCount = 0 } = await chrome.storage.local.get({ pendingCount: 0 });
    await updateBadge();

    // Nếu còn công việc trong hàng đợi, nhận tiếp ngay sau 1.5s, ngược lại kiểm tra sau 3.5s
    const nextWait = pendingCount > 0 ? 1500 : 3500;
    scheduleNextPoll(nextWait);
  } finally {
    setTimeout(() => finishingJobIds.delete(jobId), 4000);
  }
}

async function runInTab(tabId) {
  const current = await getCurrent();
  if (!current || current.tabId !== tabId) return;

  let tabReloaded = false;
  for (let i = 0; i < 45; i++) {
    try {
      const ack = await chrome.tabs.sendMessage(tabId, { type: "run", job: current.job });
      if (ack?.ok) {
        await addLog(`[runInTab] Đã kết nối với tab ${tabId} ở lần thử ${i}`, "info");
        return;
      }
    } catch (e) {
      if (i === 0 || i === 5 || i === 15 || i === 30) {
        await addLog(`[runInTab] i=${i} tabId=${tabId}: ${e?.message}`, "warn");
      }
    }
    // Chỉ tải lại nếu sau 15 giây vẫn chưa kết nối được
    if (i === 15 && !tabReloaded) {
      tabReloaded = true;
      await addLog(`[runInTab] Tải lại tab ${tabId} sau 15s để gắn lại script…`, "warn");
      await chrome.tabs.reload(tabId).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  // Có thể đang ở trang đăng nhập Google (không có script):
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab?.url && /accounts\.google\.com/.test(tab.url)) {
    await chrome.tabs.update(tabId, { active: true }).catch(() => {});
    await addLog("🔑 Cần đăng nhập tài khoản Google (đã mở tab)", "warn");
    await report(current.job.id, { status: "needs_user", message: "Hãy đăng nhập Google trong tab vừa mở. Tiện ích sẽ chạy tiếp khi bạn xong." });
    return;
  }

  // Nếu vẫn không kết nối được: BÁO LỖI VÀ HOÀN TẤT VIỆC NGAY, TUYỆT ĐỐI KHÔNG TREO!
  const curTab = await chrome.tabs.get(tabId).catch(() => null);
  await addLog(`❌ Không thể kết nối với tab ${tabId} (${curTab?.url}): ${curTab?.status}`, "error");
  await finish(current.job.id, { error: `Không thể kết nối với tab (${curTab?.url || "tab đóng"}): hãy tải lại trang và thử lại` });
}

chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== "complete") return;
  const current = await getCurrent();
  if (current?.tabId === tabId) runInTab(tabId);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (closingTabIds.has(tabId)) {
    closingTabIds.delete(tabId);
    return;
  }
  const current = await getCurrent();
  if (current?.tabId === tabId) {
    if (finishingJobIds.has(current.job.id)) return;
    await finish(current.job.id, { error: "Bạn đã đóng tab đang làm việc" });
  }
});

function normalizeAccount(val) {
  if (!val || val === "auto") return "";
  const s = String(val).trim().toLowerCase();
  if (s === "auto") return "";
  if (/^u\/\d+$/.test(s)) return s;
  if (/^\d+$/.test(s)) return `u/${s}`;
  return s.startsWith("u/") ? s : `u/${s}`;
}

function getTargetUrl(kind, flowAccount, geminiAccount, payload) {
  // Video Studio gửi kèm link dự án Flow dùng chung (đã có ?hl=en): mở đúng dự án đó để dùng lại nguyên liệu đã có
  if (kind === "flow_studio_image" || kind === "flow_studio_video") {
    if (payload?.projectUrl) return payload.projectUrl;
    const acc = normalizeAccount(flowAccount);
    return acc ? `https://flow.google.com/${acc}/?hl=en` : "https://flow.google.com/?hl=en";
  }
  if (kind === "google_flow_video") {
    const acc = normalizeAccount(flowAccount);
    return acc ? `https://flow.google.com/${acc}/` : "https://flow.google.com";
  }
  if (kind === "gemini_video" || kind === "gemini_image") {
    const acc = normalizeAccount(geminiAccount);
    return acc ? `https://gemini.google.com/${acc}/app` : "https://gemini.google.com/app";
  }
  return START_URL[kind] ?? START_URL.suno_create;
}

async function startJob(job) {
  const { keepActiveTab = true, flowAccount = "auto", geminiAccount = "auto" } = await chrome.storage.local.get({
    keepActiveTab: true,
    flowAccount: "auto",
    geminiAccount: "auto",
  });

  const flowAcc = normalizeAccount(flowAccount);
  const geminiAcc = normalizeAccount(geminiAccount);
  const targetAcc = job.kind === "google_flow_video" ? flowAcc : (job.kind === "gemini_video" || job.kind === "gemini_image") ? geminiAcc : "";
  const targetHost = getTargetUrl(job.kind, flowAccount, geminiAccount, job.payload);

  // Tái sử dụng tab Flow đang mở (nếu có) để không phải tải lại toàn bộ app và không tốn RAM
  let tab = null;
  const allTabs = await chrome.tabs.query({}).catch(() => []);
  const isFlow = job.kind.includes("flow");
  if (isFlow) {
    const flowTabs = allTabs.filter((t) => t.url && (t.url.includes("flow.google") || t.url.includes("labs.google")));
    if (flowTabs.length > 0) {
      const match = flowTabs.find((t) => t.url.includes("/project/")) || flowTabs[0];
      if (match?.id) {
        tab = match;
        await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
        await addLog(`[startJob] Dùng lại tab Flow có sẵn: id=${tab.id}`, "info");
      }
    }
  }
  if (!tab) {
    tab = await chrome.tabs.create({ url: targetHost, active: true });
    await addLog(`[startJob] Mở tab Flow mới: id=${tab.id}`, "info");
  }

  const kindNames = {
    suno_create: "Tạo nhạc Suno",
    gemini_image: "Tạo ảnh bìa Gemini",
    gemini_video: "Tạo video Gemini",
    google_flow_video: "Tạo video Google Flow",
    chatgpt_image: "Tạo ảnh ChatGPT",
    flow_studio_image: "Video Studio: tạo ảnh trên Flow",
    flow_studio_video: "Video Studio: tạo video trên Flow",
  };
  const sceneNum = job.payload?.sceneOrder !== undefined ? ` (Cảnh ${job.payload.sceneOrder})` : "";
  const accTag = targetAcc ? ` [${targetAcc}]` : "";
  await addLog(`🚀 Nhận việc: ${kindNames[job.kind] ?? job.kind}${sceneNum}${accTag} (đã mở tab mới)`, "info");

  await setCurrent({ job, tabId: tab.id, startedAt: Date.now() });
  await setStatus({ job: { id: job.id, kind: job.kind, payload: job.payload }, lastError: "" });
  await updateBadge();
  await report(job.id, {
    status: "running",
    message: `Tiện ích đã mở tab mới${accTag}`,
  });
  runInTab(tab.id);
}

// ---------- Thông báo hệ thống (vd: lô video hàng loạt đã xong) ----------

/** Hiện thông báo Chrome cho các thông báo máy chủ gửi kèm khi hỏi việc. Bấm vào thì mở trang tương ứng trên web. */
async function showNotifications(list) {
  if (!Array.isArray(list) || list.length === 0 || !chrome.notifications) return;
  const { server } = await cfg();
  for (const n of list) {
    const id = `aa-${n.id}`;
    const url = n.link ? server.replace(/\/+$/, "") + n.link : server;
    await chrome.storage.session.set({ [`notif:${id}`]: url });
    chrome.notifications.create(id, {
      type: "basic",
      iconUrl: "icons/icon-128.png",
      title: String(n.title || "AutoAffiliate").slice(0, 120),
      message: String(n.body || "").slice(0, 300),
      priority: 2,
      requireInteraction: true,
    });
    await addLog(`🔔 ${n.title}`, "success");
  }
}

chrome.notifications?.onClicked.addListener(async (id) => {
  const key = `notif:${id}`;
  const url = (await chrome.storage.session.get(key))[key];
  if (url) await chrome.tabs.create({ url, active: true });
  chrome.notifications.clear(id);
  await chrome.storage.session.remove(key);
});

// Mỗi lúc chỉ một lượt hỏi việc. poll() được gọi từ nhiều nơi (hẹn giờ 4 giây, báo thức 30 giây, khởi động, nút "nhận ngay"):
// mạng chậm thì một lượt hỏi việc mất 2-18 giây, lượt sau chen vào khi chưa kịp ghi "đang có việc" và nhận thêm việc nữa
// (đã gặp: 4 tab Flow chạy cùng lúc, đóng nhầm tab của nhau rồi kẹt).
let polling = null;
let pollingAt = 0;
function poll() {
  // Phòng hờ một lượt bị treo vì lý do khác: quá 5 phút thì cho lượt mới chạy
  if (polling && Date.now() - pollingAt < 5 * 60_000) return polling;
  pollingAt = Date.now();
  const p = pollOnce().finally(() => {
    if (polling === p) polling = null;
  });
  polling = p;
  return p;
}

let isReloading = false;

async function pollOnce() {
  if (isReloading) return;
  const { server, token } = await cfg();
  if (!server || !token) {
    badge("!");
    return;
  }
  try {
    const current = await getCurrent();

    // 1. Luôn đồng bộ số lượng hàng đợi mới nhất từ server (kể cả khi đang bận chạy việc)
    try {
      const extVersion = chrome.runtime.getManifest()?.version || "";
      const { buildId: currentBuild = "" } = await chrome.storage.local.get({ buildId: "" });
      const syncRes = await api("/api/agent/claim", {
        body: { kinds: KINDS, syncOnly: true, version: extVersion, buildId: currentBuild, currentJobId: current?.job?.id || null },
      });
      if (syncRes?.reload) {
        if (!isReloading) {
          isReloading = true;
          await addLog(`🔄 Cập nhật tiện ích mới (v${syncRes.targetVersion || "mới"}), tự khởi động lại…`, "info");
          const allTabs = await chrome.tabs.query({}).catch(() => []);
          for (const t of allTabs) {
            if (t.url && (t.url.includes("flow.google") || t.url.includes("labs.google"))) {
              chrome.tabs.reload(t.id).catch(() => {});
            }
          }
          setTimeout(() => chrome.runtime.reload(), 300);
        }
        return;
      }
      await showNotifications(syncRes?.notifications);
      if (syncRes?.inspect) {
        handlers.inspectFlowTab().then((res) => {
          api("/api/agent/inspect-result", { body: res }).catch(() => {});
        }).catch(() => {});
      }
      if (syncRes?.requestLogs) {
        try {
          const allTabs = await chrome.tabs.query({}).catch(() => []);
          const flowTab = allTabs.find((t) => t.url && (t.url.includes("flow.google") || t.url.includes("labs.google")));
          if (flowTab?.id) {
            const probeRes = await chrome.scripting.executeScript({
              target: { tabId: flowTab.id },
              func: () => {
                const inputs = [...document.querySelectorAll('input')].map(i => ({ type: i.type, name: i.name, id: i.id, accept: i.accept, className: i.className, visible: !!(i.offsetWidth || i.offsetHeight) }));
                const btns = [...document.querySelectorAll('button, [role="button"]')].map(b => ({
                  text: (b.innerText || '').trim(),
                  aria: b.getAttribute('aria-label') || '',
                  tag: b.tagName,
                  classes: b.className,
                  visible: !!(b.offsetWidth || b.offsetHeight),
                })).filter(b => /upload|media|tải/i.test(b.text + ' ' + b.aria));
                return { inputs, btns, url: location.href };
              },
            }).catch(e => ({ error: e.message }));
            if (probeRes?.[0]?.result) {
              await api("/api/agent/logs", { body: { logs: [{ text: "[DOM_PROBE] " + JSON.stringify(probeRes[0].result) }] } }).catch(() => {});
            }
          }
        } catch (pe) {
          console.warn("[probe error]", pe);
        }
        chrome.storage.local.get({ logs: [] }).then(({ logs }) => {
          if (logs?.length) api("/api/agent/logs", { body: { logs: logs.slice(0, 40) } }).catch(() => {});
        }).catch(() => {});
      }
      if (syncRes && typeof syncRes.pendingCount === "number") {
        await updatePending(syncRes.pendingCount);
      }
      if (syncRes?.activeTaskIds && current && !syncRes.activeTaskIds.includes(current.job.id)) {
        await addLog("🧹 Công việc cũ không còn trên máy chủ, tự động giải phóng", "info");
        await finish(current.job.id, { error: "Công việc đã kết thúc trên máy chủ" });
        active = null;
      }
    } catch {}

    // 2. Tự phục hồi (Self-healing): Kiểm tra việc đang chạy xem tab còn sống hay việc đã bị hủy trên web
    let active = current;
    if (active) {
      // A. Tab có còn tồn tại không? (người dùng đóng tab hoặc đóng cửa sổ)
      const tab = active.tabId ? await chrome.tabs.get(active.tabId).catch(() => null) : null;
      if (!tab) {
        await addLog("⚠️ Tab xử lý không còn tồn tại (bạn đã đóng tab), tự động hủy việc cũ", "warn");
        await finish(active.job.id, { error: "Tab đã bị đóng" });
        active = null;
      }
    }

    if (active) {
      // B. Việc trên server có bị người dùng bấm hủy trên web không?
      // Chỉ gửi nhịp tim ("ping"): trước đây gửi status "running" mỗi 4 giây làm mất trạng thái "cần bạn xử lý" và xóa lời nhắn
      const isCancelled = await report(active.job.id, { status: "ping" });
      if (isCancelled) {
        await addLog("🛑 Việc đã bị hủy trên web, tự động chuyển việc tiếp theo", "warn");
        await finish(active.job.id, { error: "Đã bị hủy trên web" });
        active = null;
      }
    }

    if (active) {
      // C. Watchdog nhịp tim: nếu tab bị đơ không gửi tín hiệu quá 2 phút
      const lastActive = active.beat ?? active.startedAt;
      if (Date.now() - lastActive > 2 * 60_000) {
        await addLog("⚠️ Tab ngừng phản hồi quá 2 phút, tự động giải phóng việc", "warn");
        await finish(active.job.id, { error: "Tab ngừng phản hồi quá 2 phút" });
        active = null;
      }
    }

    // Nếu vẫn đang có việc hợp lệ đang chạy trong tab, không nhận việc mới
    if (active) {
      return;
    }

    // Nếu active đã null nhưng status.job vẫn còn sót lại trong storage -> dọn sạch
    const { status = {} } = await chrome.storage.local.get({ status: {} });
    if (status.job) {
      await setStatus({ job: null });
    }

    // 3. Nếu đang rảnh: Nhận việc mới
    const extVer = chrome.runtime.getManifest()?.version || "";
    const { buildId: currentBuild2 = "" } = await chrome.storage.local.get({ buildId: "" });
    const r = await api("/api/agent/claim", {
      body: { kinds: KINDS, version: extVer, buildId: currentBuild2, currentJobId: null },
    });
    if (r?.reload) {
      if (!isReloading) {
        isReloading = true;
        await addLog(`🔄 Cập nhật tiện ích mới (v${r.targetVersion || "mới"}), tự khởi động lại…`, "info");
        const allTabs = await chrome.tabs.query({}).catch(() => []);
        for (const t of allTabs) {
          if (t.url && (t.url.includes("flow.google") || t.url.includes("labs.google"))) {
            chrome.tabs.reload(t.id).catch(() => {});
          }
        }
        setTimeout(() => chrome.runtime.reload(), 300);
      }
      return;
    }
    await showNotifications(r.notifications);
    const pendingCount = r.pendingCount ?? 0;
    await updatePending(pendingCount);
    await setStatus({ connected: true, error: "", pendingCount });
    if (r.job) {
      await startJob(r.job);
    } else {
      await updateBadge();
      scheduleNextPoll(4000);
    }
  } catch (e) {
    await setStatus({ connected: false, error: e instanceof Error ? e.message : String(e) });
    await updateBadge();
    scheduleNextPoll(8000);
  }
}

async function initStartup() {
  const current = await getCurrent();
  if (current?.tabId) {
    const tab = await chrome.tabs.get(current.tabId).catch(() => null);
    if (!tab) {
      await setCurrent(null);
      await setStatus({ job: null });
    }
  } else {
    await setCurrent(null);
    await setStatus({ job: null });
  }
  await poll();
}

chrome.alarms.create("poll", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => (a.name === "poll" || a.name === "poll_wake") && poll());
chrome.runtime.onStartup.addListener(initStartup);
chrome.runtime.onInstalled.addListener(initStartup);

// ---------- Tự động bắt URL video qua Network và Downloads ----------

const capturedUrlsByTab = new Map();
let capturedDownloadUrl = null;

function isLikelyVideoUrl(url, mime = "", filename = "") {
  if (!url || typeof url !== "string") return false;
  if (/sample|intro|tutorial|demo|onboarding|welcome|template/i.test(url || filename)) return false;
  // Bỏ qua tuyệt đối các endpoint API, RPC, telemetry, batch, auth
  if (/(\/api\/|_service|_rpc|batchexecute|\/auth\/|\/log|\/telemetry|\/event|\/session)/i.test(url)) return false;

  if (mime && mime.toLowerCase().startsWith("video/")) return true;
  if (/\.(mp4|webm|mov)(\?|$)/i.test(filename || url)) return true;
  if (/googlevideo\.com/i.test(url)) return true;
  if (/^https:\/\/([a-z0-9-]+\.)?flow-content\.google\/video\//i.test(url)) return true; // địa chỉ video thật của Google Flow
  if (url.startsWith("blob:") && !/\.(jpg|jpeg|png|webp|mp3|wav)$/i.test(filename || "")) return true;
  if (
    /storage\.googleapis\.com/i.test(url) &&
    !/\.(jpg|jpeg|png|webp|gif|svg|ico|json|css|js|html|txt)(\?|$)/i.test(url)
  ) {
    return true;
  }
  if (/googleusercontent\.com/i.test(url) && (/(=m\d+|video|videofx|media)/i.test(url) || /\.(mp4|webm)(\?|$)/i.test(url))) {
    if (!/\.(jpg|jpeg|png|webp|gif|svg|ico|json|css|js|html)(\?|$)/i.test(url)) return true;
  }
  return false;
}

let capturedSunoAuthToken = null;

function isJwtValid(token) {
  if (!token || typeof token !== "string") return false;
  try {
    const raw = token.replace(/^Bearer\s+/i, "").trim();
    const parts = raw.split(".");
    if (parts.length !== 3) return false;
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    return typeof payload.exp === "number" && payload.exp * 1000 > Date.now() + 5000;
  } catch {
    return false;
  }
}

function isLikelyAudioUrl(url, mime = "", filename = "") {
  if (!url || typeof url !== "string") return false;
  if (/sample|intro|tutorial|demo|onboarding|sil-/i.test(url || filename)) return false;
  if (url.includes("/1/clip/") || url.includes("m4a-opus")) return false;
  if (mime && mime.toLowerCase().startsWith("audio/")) return true;
  if (/\.(mp3|m4a|wav)(\?|$)/i.test(filename || url)) return true;
  if (/suno/i.test(url) && /\.(mp3|m4a|wav)/i.test(url)) return true;
  return false;
}

function isValidVideoBytes(bytes) {
  if (!bytes || bytes.byteLength < 50_000) return false;
  const u8 = new Uint8Array(bytes.slice(0, 16));
  const ftyp = u8[4] === 0x66 && u8[5] === 0x74 && u8[6] === 0x79 && u8[7] === 0x70;
  const webm = u8[0] === 0x1a && u8[1] === 0x45 && u8[2] === 0xdf && u8[3] === 0xa3;
  return ftyp || webm;
}

function isValidAudioBytes(bytes) {
  if (!bytes || bytes.byteLength < 32) return false;
  const u8 = new Uint8Array(bytes.slice(0, 16));
  // ID3 (MP3)
  if (u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33) return true;
  // MP3 Sync frame
  if (u8[0] === 0xff && (u8[1] & 0xe0) === 0xe0) return true;
  // RIFF (WAV)
  if (u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46) return true;
  // MP4 / M4A: box 'ftyp'
  if (u8[4] === 0x66 && u8[5] === 0x74 && u8[6] === 0x79 && u8[7] === 0x70) return true;
  // Ogg
  if (u8[0] === 0x4f && u8[1] === 0x67 && u8[2] === 0x67 && u8[3] === 0x53) return true;
  // FLAC
  if (u8[0] === 0x66 && u8[1] === 0x4c && u8[2] === 0x61 && u8[3] === 0x43) return true;
  return false;
}

if (chrome.webRequest?.onBeforeSendHeaders) {
  try {
    chrome.webRequest.onBeforeSendHeaders.addListener(
      (details) => {
        const auth = details.requestHeaders?.find(
          (h) => h.name && h.name.toLowerCase() === "authorization"
        )?.value;
        if (auth && (details.url.includes("suno.com") || details.url.includes("suno.ai"))) {
          if (isJwtValid(auth)) {
            capturedSunoAuthToken = auth;
          }
        }
      },
      { urls: ["https://*.suno.com/*", "https://*.suno.ai/*"] },
      ["requestHeaders"]
    );
  } catch {}
}

if (chrome.webRequest?.onResponseStarted) {
  try {
    chrome.webRequest.onResponseStarted.addListener(
      (details) => {
        if (details.tabId < 0) return;
        const url = details.url;
        if (isLikelyVideoUrl(url) || isLikelyAudioUrl(url)) {
          capturedUrlsByTab.set(details.tabId, { url, time: Date.now() });
        }
      },
      { urls: ["<all_urls>"] }
    );
  } catch {}
}

if (chrome.downloads?.onCreated) {
  try {
    chrome.downloads.onCreated.addListener(async (item) => {
      const url = item.finalUrl || item.url;
      // Tiện ích bấm "Tải xuống" trên Flow chỉ để trang tạo file video; file đã được bắt thẳng trong tab (content/flow-main.js),
      // nên huỷ bản Chrome tự lưu vào thư mục Tải xuống để không đầy máy. Chỉ huỷ file video blob của Flow khi đang chạy việc Flow.
      try {
        const current = await getCurrent();
        if (current?.job?.kind === "google_flow_video" && /^blob:https:\/\/([a-z0-9-]+\.)?(flow\.google(\.com)?|labs\.google)\//i.test(url || "") && (/^video\//i.test(item.mime || "") || /\.mp4$/i.test(item.filename || ""))) {
          capturedDownloadUrl = { url, filename: item.filename, time: Date.now() };
          chrome.downloads.cancel(item.id, () => chrome.downloads.erase({ id: item.id }, () => void chrome.runtime.lastError));
          return;
        }
      } catch {}
      if (
        isLikelyVideoUrl(url, item.mime, item.filename) ||
        isLikelyAudioUrl(url, item.mime, item.filename) ||
        item.mime === "application/octet-stream"
      ) {
        capturedDownloadUrl = { url, filename: item.filename, time: Date.now() };
      }
    });
  } catch {}
}

if (chrome.downloads?.onChanged) {
  try {
    chrome.downloads.onChanged.addListener((delta) => {
      if (delta.filename?.current) {
        const fn = delta.filename.current;
        if (/\.(mp4|webm|mov)$/i.test(fn)) {
          chrome.downloads.search({ id: delta.id }, (items) => {
            if (items && items[0]) {
              const url = items[0].finalUrl || items[0].url;
              capturedDownloadUrl = { url, filename: fn, time: Date.now() };
            }
          });
        }
      }
    });
  } catch {}
}

// ---------- Tin nhắn từ script trong tab, popup và trang cài đặt ----------

const handlers = {
  async say({ jobId, message, status }) {
    const current = await getCurrent();
    if (current) await setCurrent({ ...current, beat: Date.now() });
    if (message) await addLog(message, "info");
    return { cancelled: await report(jobId, { status: status ?? "running", message }) };
  },
  async state({ jobId, set }) {
    const key = `state:${jobId}`;
    if (set) await chrome.storage.local.set({ [key]: set });
    return { state: (await chrome.storage.local.get(key))[key] ?? null };
  },
  async upload({ jobId, name, mime, b64 }) {
    await addLog(`📤 Đang tải lên: ${name}`, "info");
    return await upload(jobId, { name, mime, bytes: b64ToBytes(b64) });
  },
  /** Tải file từ địa chỉ công khai (cdn Suno, googleusercontent, googlevideo, flow.google) rồi gửi về web */
  async fetchUpload({ jobId, url, name, mime }) {
    // Chỉ https tới máy chủ công cộng (không localhost, mạng nội bộ)
    let host = "";
    try {
      const u = new URL(url);
      host = u.hostname;
      if (u.protocol !== "https:") throw new Error();
    } catch {
      throw new Error("Địa chỉ tải không hợp lệ (chỉ nhận https)");
    }
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[)/i.test(host) || !host.includes(".")) {
      throw new Error("Không tải từ địa chỉ nội bộ");
    }
    await addLog(`📥 Đang nạp tệp: ${name}`, "info");
    let res = null;
    let lastErr = null;
    // Thử credentials: "omit" trước để không bị lỗi CORS wildcard trên CDN công khai
    const attempts = [{ credentials: "omit" }, {}, { credentials: "include" }];
    for (const opt of attempts) {
      try {
        const r = await fetch(url, opt);
        if (r && r.ok) {
          res = r;
          break;
        } else if (r) {
          lastErr = new Error(`Máy chủ tải file báo mã lỗi ${r.status}`);
        }
      } catch (err) {
        lastErr = err;
      }
    }

    if (!res) {
      throw new Error(`Không tải được file (${lastErr?.message || "Lỗi mạng Failed to fetch"})`);
    }

    const type = (mime ?? res.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim();
    const bytes = await res.arrayBuffer();

    if (type.startsWith("audio/") || /\.(mp3|m4a|wav)$/i.test(name)) {
      if (!isValidAudioBytes(bytes)) {
        throw new Error("Dữ liệu âm thanh tải về không hợp lệ (stream mã hóa hoặc file lỗi, cần tải file MP3 chính thức)");
      }
    }

    if (type.startsWith("video/") || /\.(mp4|webm|mov)$/i.test(name)) {
      if (!isValidVideoBytes(bytes)) {
        throw new Error("Dữ liệu tải về không phải video (có thể là trang lỗi hoặc ảnh xem trước)");
      }
    }

    return await upload(jobId, { name, mime: type, bytes });
  },
  async getSunoToken() {
    // 1. Thử lấy cookie __session trực tiếp từ Chrome Cookies API (hỗ trợ cả HttpOnly và luôn cập nhật)
    try {
      if (chrome.cookies) {
        const c = await chrome.cookies.get({ url: "https://suno.com", name: "__session" });
        if (c?.value && isJwtValid(c.value)) {
          return { token: c.value };
        }
        const allCookies = await chrome.cookies.getAll({ domain: "suno.com" });
        for (const cookie of allCookies) {
          if (/^__session(_.+)?$/.test(cookie.name) && isJwtValid(cookie.value)) {
            return { token: cookie.value };
          }
        }
      }
    } catch {}

    // 2. Thử captured token từ request headers nếu còn hạn
    if (capturedSunoAuthToken && isJwtValid(capturedSunoAuthToken)) {
      return { token: capturedSunoAuthToken };
    }

    return { token: null };
  },
  async setSunoToken({ token }) {
    if (token && isJwtValid(token)) capturedSunoAuthToken = token;
    return { ok: true };
  },
  async getImageData({ url }) {
    if (!url) return { error: "Không có URL ảnh" };
    try {
      if (url.startsWith("data:")) {
        const match = url.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
          return { mime: match[1], b64: match[2] };
        }
      }
      let fetchUrl = url;
      if (url.startsWith("/")) {
        const { server } = await cfg();
        fetchUrl = (server || "http://localhost:3000").replace(/\/+$/, "") + url;
      }
      const headers = {};
      const { server, token } = await cfg();
      if (server && token) {
        const imageUrl = new URL(fetchUrl);
        if (imageUrl.origin === new URL(server).origin && imageUrl.pathname.startsWith("/api/agent/assets/")) headers.Authorization = `Bearer ${token}`;
      }
      const res = await fetch(fetchUrl, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const mime = (res.headers.get("content-type") || "image/png").split(";")[0].trim();
      const buf = await res.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = "";
      const len = bytes.byteLength;
      const chunk = 8192;
      for (let i = 0; i < len; i += chunk) {
        const sub = bytes.subarray(i, Math.min(i + chunk, len));
        binary += String.fromCharCode.apply(null, sub);
      }
      const b64 = btoa(binary);
      return { mime, b64 };
    } catch (err) {
      return { error: err.message };
    }
  },
  async getCapturedVideo({ tabId, since = 0 } = {}, sender) {
    // 1. ƯU TIÊN SỐ 1: File thực sự được tải xuống qua nút Tải xuống (chrome.downloads), chỉ nhận khi xảy ra SAU lúc bấm tạo
    if (capturedDownloadUrl && capturedDownloadUrl.time >= since && Date.now() - capturedDownloadUrl.time < 10 * 60_000) {
      if (isLikelyVideoUrl(capturedDownloadUrl.url, capturedDownloadUrl.mime, capturedDownloadUrl.filename)) {
        return { url: capturedDownloadUrl.url, filename: capturedDownloadUrl.filename };
      }
    }
    // 2. Tiếp theo mới đến network request của tab (bắt buộc phải là video thật, loại bỏ API/RPC)
    const tid = tabId || sender?.tab?.id;
    if (tid && capturedUrlsByTab.has(tid)) {
      const entry = capturedUrlsByTab.get(tid);
      if (entry.time >= since && Date.now() - entry.time < 10 * 60_000) {
        if (isLikelyVideoUrl(entry.url, entry.mime)) {
          return { url: entry.url };
        }
      }
    }
    return { url: null };
  },
  async getCapturedAudio({ tabId, since = 0 } = {}, sender) {
    if (capturedDownloadUrl && capturedDownloadUrl.time >= since && Date.now() - capturedDownloadUrl.time < 10 * 60_000) {
      if (isLikelyAudioUrl(capturedDownloadUrl.url, capturedDownloadUrl.mime, capturedDownloadUrl.filename)) {
        return { url: capturedDownloadUrl.url, filename: capturedDownloadUrl.filename };
      }
    }
    const tid = tabId || sender?.tab?.id;
    if (tid && capturedUrlsByTab.has(tid)) {
      const entry = capturedUrlsByTab.get(tid);
      if (entry.time >= since && Date.now() - entry.time < 10 * 60_000) {
        if (isLikelyAudioUrl(entry.url, entry.mime)) {
          return { url: entry.url };
        }
      }
    }
    return { url: null };
  },
  async clearCapturedVideo({ tabId } = {}, sender) {
    const tid = tabId || sender?.tab?.id;
    if (tid) capturedUrlsByTab.delete(tid);
    else capturedUrlsByTab.clear();
    capturedDownloadUrl = null;
    return {};
  },
  async done({ jobId, result }, sender) {
    await finish(jobId, { result: result ?? {} }, sender?.tab?.id);
    return {};
  },
  async fail({ jobId, error }, sender) {
    await finish(jobId, { error: error ?? "Lỗi không rõ" }, sender?.tab?.id);
    return {};
  },
  async pollNow() {
    await addLog("⚡ Nhận việc mới ngay lập tức...", "info");
    if (pollTimer) clearTimeout(pollTimer);
    await poll();
    return {};
  },
  async clearLogs() {
    await chrome.storage.local.set({ logs: [] });
    return { ok: true };
  },
  async focusTab({ tabId }) {
    try {
      if (tabId) {
        await chrome.tabs.update(tabId, { active: true });
      } else {
        const current = await getCurrent();
        if (current?.tabId) await chrome.tabs.update(current.tabId, { active: true });
      }
    } catch {}
    return { ok: true };
  },
  async triggerGenerate(data, sender) {
    const tabId = sender?.tab?.id || (await chrome.tabs.query({})).find((t) => t.url && (t.url.includes("flow.google") || t.url.includes("labs.google")))?.id;
    await addLog(`[triggerGenerate] Bắt đầu cho tab ${tabId}, toạ độ=(${data?.x}, ${data?.y})`, "info");
    if (!tabId) throw new Error("Không có tabId để click");
    const target = { tabId };
    await chrome.tabs.update(tabId, { active: true }).catch(() => {});
    await chrome.debugger.detach(target).catch(() => {});
    try {
      await chrome.debugger.attach(target, "1.3");
      await addLog(`[triggerGenerate] Đã attach debugger vào tab ${tabId}`, "info");
    } catch (e) {
      await addLog(`[triggerGenerate] Lỗi attach debugger: ${e?.message}`, "error");
    }
    try {
      await chrome.debugger.sendCommand(target, "Page.enable").catch(() => {});
      await chrome.debugger.sendCommand(target, "Page.bringToFront").catch(() => {});
      await new Promise((r) => setTimeout(r, 120));

      // 1. Gửi phím Enter (không modifiers - phím submit mặc định của Flow) bằng CDP
      await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
        macCharCode: 13,
        key: "Enter",
        code: "Enter",
        text: "\r",
        unmodifiedText: "\r",
      }).catch((e) => addLog(`[triggerGenerate] Lỗi Enter key: ${e?.message}`, "warn"));
      await new Promise((r) => setTimeout(r, 60));
      await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
        type: "keyUp",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
        macCharCode: 13,
        key: "Enter",
        code: "Enter",
      }).catch(() => {});
      await new Promise((r) => setTimeout(r, 100));

      // 2. Bấm chuột trái vào nút tạo bằng toạ độ x, y thật
      if (data?.x != null && data?.y != null) {
        const x = Math.round(data.x);
        const y = Math.round(data.y);
        await addLog(`[triggerGenerate] Gửi CDP click tại (${x}, ${y})`, "info");
        await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x,
          y,
        }).catch((e) => addLog(`[triggerGenerate] Lỗi mouseMoved: ${e?.message}`, "warn"));
        await new Promise((r) => setTimeout(r, 60));
        await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
          type: "mousePressed",
          x,
          y,
          button: "left",
          buttons: 1,
          clickCount: 1,
        }).catch((e) => addLog(`[triggerGenerate] Lỗi mousePressed: ${e?.message}`, "warn"));
        await new Promise((r) => setTimeout(r, 100));
        await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x,
          y,
          button: "left",
          buttons: 0,
          clickCount: 1,
        }).catch((e) => addLog(`[triggerGenerate] Lỗi mouseReleased: ${e?.message}`, "warn"));
        await addLog(`[triggerGenerate] Hoàn tất CDP click tại (${x}, ${y})`, "info");
      }
    } finally {
      await chrome.debugger.detach(target).catch(() => {});
    }
    return { ok: true };
  },
  async clickTrusted(data, sender) {
    return await handlers.triggerGenerate(data, sender);
  },
  async typeAndStart({ text, x, y }, sender) {
    const tabId = sender?.tab?.id || (await chrome.tabs.query({})).find((t) => t.url && (t.url.includes("flow.google") || t.url.includes("labs.google")))?.id;
    if (!tabId) throw new Error("Không có tabId để nhập prompt");
    const target = { tabId };
    await chrome.tabs.update(tabId, { active: true }).catch(() => {});
    await chrome.debugger.detach(target).catch(() => {});
    try {
      await chrome.debugger.attach(target, "1.3");
      await addLog(`[typeAndStart] Debugger attached to tab ${tabId}`, "info");
    } catch (e) {
      await addLog(`[typeAndStart] Attach debugger: ${e?.message}`, "error");
    }

    try {
      await chrome.debugger.sendCommand(target, "Page.enable").catch(() => {});
      await chrome.debugger.sendCommand(target, "Page.bringToFront").catch(() => {});
      await new Promise((r) => setTimeout(r, 120));

      // 1. Focus ô prompt ProseMirror
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const inp = document.querySelector('div.ProseMirror, textarea, [contenteditable="true"]');
          if (inp) {
            inp.focus();
            const sel = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(inp);
            sel.removeAllRanges();
            sel.addRange(range);
          }
        },
      }).catch(() => {});
      await new Promise((r) => setTimeout(r, 100));

      // 2. Xoá nội dung cũ (Ctrl+A -> Backspace) bằng CDP
      await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        windowsVirtualKeyCode: 17,
        nativeVirtualKeyCode: 17,
        modifiers: 2,
        key: "Control",
        code: "ControlLeft",
      }).catch(() => {});
      await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        windowsVirtualKeyCode: 65,
        nativeVirtualKeyCode: 65,
        modifiers: 2,
        key: "a",
        code: "KeyA",
      }).catch(() => {});
      await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
        type: "keyUp",
        windowsVirtualKeyCode: 65,
        modifiers: 2,
        key: "a",
        code: "KeyA",
      }).catch(() => {});
      await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
        type: "keyUp",
        windowsVirtualKeyCode: 17,
        modifiers: 0,
        key: "Control",
        code: "ControlLeft",
      }).catch(() => {});
      await new Promise((r) => setTimeout(r, 50));

      await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        windowsVirtualKeyCode: 8,
        nativeVirtualKeyCode: 8,
        key: "Backspace",
        code: "Backspace",
      }).catch(() => {});
      await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
        type: "keyUp",
        windowsVirtualKeyCode: 8,
        nativeVirtualKeyCode: 8,
        key: "Backspace",
        code: "Backspace",
      }).catch(() => {});
      await new Promise((r) => setTimeout(r, 100));

      // 3. Gõ văn bản prompt vào ProseMirror bằng Input.insertText (CDP native typing)
      await addLog(`[typeAndStart] Gõ ${text?.length || 0} ký tự prompt qua CDP Input.insertText`, "info");
      if (text) {
        await chrome.debugger.sendCommand(target, "Input.insertText", { text }).catch((e) => {
          addLog(`[typeAndStart] Lỗi Input.insertText: ${e?.message}`, "warn");
        });
      }
      await new Promise((r) => setTimeout(r, 400));

      // 4. Lấy toạ độ MỚI NHẤT của nút Start generation sau khi prompt đã được gõ (vì ô prompt giãn nở làm nút dịch chuyển)
      let clickX = x != null ? Math.round(x) : null;
      let clickY = y != null ? Math.round(y) : null;
      try {
        const freshCoords = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const btn = document.querySelector('button[aria-label="Start generation"]') ||
              [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Start generation' || (b.innerText || '').includes('arrow_forward'));
            if (!btn) return null;
            const r = btn.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
              return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
            }
            return null;
          },
        }).then((res) => res?.[0]?.result);
        if (freshCoords?.x && freshCoords?.y) {
          clickX = freshCoords.x;
          clickY = freshCoords.y;
        }
      } catch (e) {
        console.warn("Không lấy được toạ độ mới của nút tạo:", e);
      }

      // 5. Bấm chuột trái vào nút Start generation
      if (clickX != null && clickY != null) {
        await addLog(`[typeAndStart] Click nút tạo tại (${clickX}, ${clickY})`, "info");
        await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: clickX,
          y: clickY,
        }).catch(() => {});
        await new Promise((r) => setTimeout(r, 80));
        await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
          type: "mousePressed",
          x: clickX,
          y: clickY,
          button: "left",
          buttons: 1,
          clickCount: 1,
        }).catch(() => {});
        await new Promise((r) => setTimeout(r, 120));
        await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: clickX,
          y: clickY,
          button: "left",
          buttons: 0,
          clickCount: 1,
        }).catch(() => {});
        await addLog(`[typeAndStart] Hoàn tất click nút tạo`, "info");
      }
    } finally {
      await chrome.debugger.detach(target).catch(() => {});
    }
    return { ok: true };
  },
  async uploadViaCDP({ filePath, x, y }, sender) {
    const tabId = sender?.tab?.id;
    await addLog(`[uploadViaCDP] Bắt đầu cho tab ${tabId}`, "info");
    if (!tabId) throw new Error("Không có tabId để upload");
    const target = { tabId };
    await chrome.debugger.detach(target).catch(() => {});
    try {
      await chrome.debugger.attach(target, "1.3");
      await addLog(`[uploadViaCDP] Đã gắn debugger vào tab ${tabId}`, "info");
    } catch (e) {
      await addLog(`[uploadViaCDP] Lỗi gắn debugger: ${e?.message}`, "error");
      throw new Error(`Lỗi gắn debugger: ${e?.message}`);
    }

    const files = (Array.isArray(filePath) ? filePath : [filePath]).filter(Boolean);
    if (!files.length) throw new Error("Không có đường dẫn tệp để nạp");

    try {
      await chrome.debugger.sendCommand(target, "Page.enable").catch(() => {});
      await chrome.debugger.sendCommand(target, "DOM.enable").catch(() => {});

      // 1. Quét tìm thẻ input[type="file"] trong DOM
      const evalRes = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
        expression: `(() => {
          let fi = document.querySelector('input[type="file"]');
          if (!fi) {
            const allEls = [...document.querySelectorAll('*')];
            for (const el of allEls) {
              if (el.shadowRoot) {
                const sfi = el.shadowRoot.querySelector('input[type="file"]');
                if (sfi) { fi = sfi; break; }
              }
            }
          }
          return fi;
        })()`,
      }).catch(() => null);

      if (evalRes?.result?.objectId) {
        await chrome.debugger.sendCommand(target, "DOM.setFileInputFiles", {
          objectId: evalRes.result.objectId,
          files,
        });
        await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
          objectId: evalRes.result.objectId,
          expression: `function() {
            this.dispatchEvent(new Event('change', { bubbles: true }));
            this.dispatchEvent(new Event('input', { bubbles: true }));
          }`,
          userGesture: true,
        }).catch(() => {});
        await addLog(`📁 Đã nạp ${files.length} tệp qua DOM.setFileInputFiles (tìm thấy sẵn)`, "info");
        return { ok: true, method: "DOM.setFileInputFiles" };
      }

      // 2. Lấy vị trí nút Upload media trực tiếp từ viewport hiện tại
      const btnInfo = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
        expression: `(() => {
          const btns = [...document.querySelectorAll('button, [role="button"]')];
          const btn = btns.find(b => {
            const txt = (b.innerText || b.getAttribute('aria-label') || '').trim().toLowerCase();
            return txt.includes('upload media') || txt.includes('tải lên') || txt === 'upload';
          });
          if (!btn) return null;
          btn.scrollIntoView({ block: 'center', inline: 'center' });
          const r = btn.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height };
        })()`,
        returnByValue: true,
      }).catch(() => null);

      const dynamicPos = btnInfo?.result?.value;
      const clickX = dynamicPos?.x || x || 0;
      const clickY = dynamicPos?.y || y || 0;
      await addLog(`[uploadViaCDP] Tọa độ nút upload: (${Math.round(clickX)}, ${Math.round(clickY)})`, "info");

      // Chuẩn bị bắt chặn hộp thoại File Chooser trước khi bấm nút
      await chrome.debugger.sendCommand(target, "Page.setInterceptFileChooserDialog", { enabled: true });

      let chooserFired = false;
      const chooserPromise = new Promise((resolve) => {
        const timeout = setTimeout(() => {
          chrome.debugger.onEvent.removeListener(onEvent);
          resolve(null);
        }, 6000);

        function onEvent(source, method, params) {
          if (method === "Page.fileChooserOpened") {
            chooserFired = true;
            clearTimeout(timeout);
            chrome.debugger.onEvent.removeListener(onEvent);
            resolve(params);
          }
        }
        chrome.debugger.onEvent.addListener(onEvent);
      });

      // Bấm nút Upload media bằng trusted mouse click và kích hoạt user activation
      if (clickX > 0 && clickY > 0) {
        await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(clickX), y: Math.round(clickY) }).catch(() => {});
        await new Promise((r) => setTimeout(r, 60));
        await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mousePressed", x: Math.round(clickX), y: Math.round(clickY), button: "left", buttons: 1, clickCount: 1 }).catch(() => {});
        await new Promise((r) => setTimeout(r, 100));
        await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mouseReleased", x: Math.round(clickX), y: Math.round(clickY), button: "left", buttons: 0, clickCount: 1 }).catch(() => {});
      }

      await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
        expression: `(() => {
          const btns = [...document.querySelectorAll('button, [role="button"]')];
          const btn = btns.find(b => {
            const txt = (b.innerText || b.getAttribute('aria-label') || '').trim().toLowerCase();
            return txt.includes('upload media') || txt.includes('tải lên') || txt === 'upload';
          });
          if (btn) {
            btn.focus();
            btn.click();
            const touch = btn.querySelector('.mat-mdc-button-touch-target');
            if (touch) touch.click();
          }
        })()`,
        userGesture: true,
      }).catch(() => {});

      const chooserParams = await chooserPromise;
      if (chooserParams) {
        await chrome.debugger.sendCommand(target, "Page.handleFileChooser", {
          action: "accept",
          files,
        });
        await addLog(`📁 Đã nạp ${files.length} tệp qua Page.handleFileChooser`, "info");
        return { ok: true, method: "Page.handleFileChooser" };
      }

      // 3. Sau khi bấm, kiểm tra lại xem có thẻ input[type="file"] mới xuất hiện không
      const evalRes2 = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
        expression: `document.querySelector('input[type="file"]')`,
      }).catch(() => null);

      if (evalRes2?.result?.objectId) {
        await chrome.debugger.sendCommand(target, "DOM.setFileInputFiles", {
          objectId: evalRes2.result.objectId,
          files,
        });
        await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
          objectId: evalRes2.result.objectId,
          expression: `function() {
            this.dispatchEvent(new Event('change', { bubbles: true }));
            this.dispatchEvent(new Event('input', { bubbles: true }));
          }`,
          userGesture: true,
        }).catch(() => {});
        await addLog(`📁 Đã nạp ${files.length} tệp qua DOM.setFileInputFiles (sau click)`, "info");
        return { ok: true, method: "DOM.setFileInputFiles_post_click" };
      }

      // 4. Kích hoạt kéo thả tệp trực tiếp bằng CDP Drag & Drop Event
      await addLog("[uploadViaCDP] Thử nạp qua CDP Drag & Drop…", "info");
      const dropTarget = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
        expression: `(() => {
          const el = document.querySelector('flow-asset-list, flow-drop-target, aside, main, [role="listbox"]') || document.body;
          const r = el.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        })()`,
        returnByValue: true,
      }).catch(() => null);

      const dropX = Math.round(dropTarget?.result?.value?.x || clickX || 400);
      const dropY = Math.round(dropTarget?.result?.value?.y || clickY || 400);

      await chrome.debugger.sendCommand(target, "Input.dispatchDragEvent", {
        type: "dragEnter",
        x: dropX,
        y: dropY,
        data: { files, dragOperationsMask: 1 },
      }).catch(() => {});
      await new Promise((r) => setTimeout(r, 120));
      await chrome.debugger.sendCommand(target, "Input.dispatchDragEvent", {
        type: "dragOver",
        x: dropX,
        y: dropY,
        data: { files, dragOperationsMask: 1 },
      }).catch(() => {});
      await new Promise((r) => setTimeout(r, 120));
      await chrome.debugger.sendCommand(target, "Input.dispatchDragEvent", {
        type: "drop",
        x: dropX,
        y: dropY,
        data: { files, dragOperationsMask: 1 },
      }).catch(() => {});

      await addLog(`📁 Đã nạp ${files.length} tệp qua CDP Drag & Drop`, "info");
      return { ok: true, method: "Input.dispatchDragEvent" };

      await addLog("❌ Flow không mở file chooser và không có thẻ input[type='file']", "error");
      throw new Error("Không thể nạp tệp lên Flow (Flow không mở hộp thoại và không có thẻ input)");
    } finally {
      await chrome.debugger.sendCommand(target, "Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
      await chrome.debugger.detach(target).catch(() => {});
    }
  },
  async clickStartNow() {
    const allTabs = await chrome.tabs.query({}).catch(() => []);
    const flowTab = allTabs.find((t) => t.url && (t.url.includes("flow.google") || t.url.includes("labs.google")));
    if (!flowTab?.id) return { error: "No flow tab" };
    const res = await chrome.scripting.executeScript({
      target: { tabId: flowTab.id },
      func: () => {
        const btn = [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Start generation");
        if (!btn) return { error: "No button" };
        btn.focus();
        btn.click();
        const touch = btn.querySelector(".mat-mdc-button-touch-target");
        if (touch) touch.click();
        return { clicked: true, text: btn.innerText, aria: btn.getAttribute("aria-label") };
      },
    });
    return res?.[0]?.result || res;
  },
  async inspectFlowTab() {
    const allTabs = await chrome.tabs.query({}).catch(() => []);
    const flowTab = allTabs.find((t) => t.url && (t.url.includes("flow.google") || t.url.includes("labs.google")));
    if (!flowTab?.id) return { error: "Không tìm thấy tab Flow", allTabs: allTabs.map((t) => ({ id: t.id, url: t.url, title: t.title })) };
    const res = await chrome.scripting.executeScript({
      target: { tabId: flowTab.id },
      func: () => {
        const tiles = [...document.querySelectorAll('flow-grid-tile-container, main [role="group"], [role="article"], .flow-tile, flow-tile')].map((t, idx) => {
          const v = t.querySelector('video');
          const im = t.querySelector('img');
          return {
            idx,
            tag: t.tagName,
            role: t.getAttribute('role'),
            className: t.className,
            text: (t.innerText || '').slice(0, 150),
            aria: t.getAttribute('aria-label') || '',
            vSrc: v?.src || v?.currentSrc || '',
            iSrc: im?.src || '',
          };
        });
        const promptInput = document.querySelector('textarea, [contenteditable="true"]');
        const startBtn = [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Start generation');
        let clickTest = null;
        if (startBtn) {
          const beforeVal = promptInput ? (promptInput.value || promptInput.innerText || '') : '';
          startBtn.focus();
          startBtn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true, cancelable: true }));
          startBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
          startBtn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, composed: true, cancelable: true }));
          startBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
          startBtn.click();
          const touch = startBtn.querySelector('.mat-mdc-button-touch-target');
          if (touch) touch.click();

          clickTest = {
            found: true,
            disabled: startBtn.disabled,
            ariaDisabled: startBtn.getAttribute('aria-disabled'),
            rect: startBtn.getBoundingClientRect(),
            beforeValLen: beforeVal.length, inputTag: promptInput?.tagName, inputCls: promptInput?.className, inputAttrs: promptInput ? promptInput.getAttributeNames() : [],
          };
        }

        const atPoint = document.elementFromPoint(1067, 716);
        const pointInfo = atPoint ? {
          tag: atPoint.tagName,
          cls: atPoint.className,
          aria: atPoint.getAttribute('aria-label'),
          txt: (atPoint.innerText || atPoint.textContent || '').slice(0, 50),
          btn: !!atPoint.closest('button'),
          btnAria: atPoint.closest('button')?.getAttribute('aria-label'),
        } : null;

        const startBtnInfo = (() => {
          const btn = document.querySelector('button[aria-label="Start generation"]');
          if (!btn) return 'no btn';
          return {
            outerHTML: btn.outerHTML.slice(0, 300),
            parentHTML: btn.parentElement?.outerHTML?.slice(0, 400),
          };
        })();

        return {
          url: location.href,
          tilesCount: tiles.length,
          tiles: tiles.slice(0, 5),
          promptText: promptInput?.value || promptInput?.textContent || '',
          startBtnInfo,
          clickTest,
        };
      },
    }).catch(e => ({ error: e.message }));
    return res?.[0]?.result || res;
  },
  async cancelCurrent() {
    const current = await getCurrent();
    if (current) {
      await addLog("🛑 Bạn đã bấm hủy công việc trên tiện ích", "warn");
      await finish(current.job.id, { error: "Người dùng đã bấm hủy trên tiện ích" });
    } else {
      await setStatus({ job: null });
      await addLog("🧹 Đã làm sạch trạng thái công việc", "info");
    }
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const fn = handlers[msg?.type];
  if (!fn) return false;
  fn.call(handlers, msg, sender).then(sendResponse, (e) => sendResponse({ error: e instanceof Error ? e.message : String(e) }));
  return true;
});
