/* global chrome */
const $ = (id) => document.getElementById(id);

const KIND = {
  suno_create: "🎵 Đang tạo nhạc trên Suno",
  gemini_image: "🖼️ Đang tạo ảnh bìa trên Gemini",
  gemini_video: "🎬 Đang tạo video trên Gemini",
  google_flow_video: "🎬 Đang tạo video trên Google Flow",
  chatgpt_image: "🖼️ Đang tạo ảnh trên ChatGPT",
};

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function render() {
  const data = await chrome.storage.local.get({
    server: "",
    token: "",
    status: {},
    pendingCount: 0,
    logs: [],
    keepActiveTab: true,
    flowAccount: "auto",
    geminiAccount: "auto",
  });

  const verEl = document.querySelector(".badge-ver");
  if (verEl && chrome.runtime?.getManifest) {
    verEl.textContent = `v${chrome.runtime.getManifest().version}`;
  }

  const { server, token, status = {}, pendingCount = 0, logs = [], keepActiveTab = true, flowAccount = "auto", geminiAccount = "auto" } = data;
  const configured = !!server && !!token;
  const hasJob = !!status.job;

  const keepTabEl = $("keep-tab");
  if (keepTabEl) {
    keepTabEl.checked = keepActiveTab !== false;
  }

  // Cấu hình tài khoản Google Flow
  const flowSelect = $("flow-account");
  const flowWrap = $("flow-custom-wrap");
  const flowInput = $("flow-custom-input");
  if (flowSelect && document.activeElement !== flowInput) {
    const knownFlow = ["auto", "u/0", "u/1", "u/2", "u/3", "u/4", "u/5", "u/6"].includes(flowAccount);
    if (knownFlow) {
      flowSelect.value = flowAccount;
      if (flowWrap) flowWrap.style.display = "none";
    } else {
      flowSelect.value = "custom";
      if (flowWrap) flowWrap.style.display = "block";
      if (flowInput) flowInput.value = flowAccount;
    }
  }

  // Cấu hình tài khoản Gemini
  const geminiSelect = $("gemini-account");
  const geminiWrap = $("gemini-custom-wrap");
  const geminiInput = $("gemini-custom-input");
  if (geminiSelect && document.activeElement !== geminiInput) {
    const knownGemini = ["auto", "u/0", "u/1", "u/2", "u/3", "u/4"].includes(geminiAccount);
    if (knownGemini) {
      geminiSelect.value = geminiAccount;
      if (geminiWrap) geminiWrap.style.display = "none";
    } else {
      geminiSelect.value = "custom";
      if (geminiWrap) geminiWrap.style.display = "block";
      if (geminiInput) geminiInput.value = geminiAccount;
    }
  }

  // Dot & State indicator
  if (!configured) {
    $("dot").className = "dot";
    $("state").textContent = "Chưa cấu hình tài khoản";
    $("job-title").textContent = "Chưa kết nối máy chủ";
  } else if (!status.connected) {
    $("dot").className = "dot bad";
    $("state").textContent = "Không thể kết nối máy chủ";
    $("job-title").textContent = status.error || "Mất kết nối";
  } else if (hasJob) {
    $("dot").className = "dot working";
    $("state").textContent = "Đang xử lý công việc...";
    const sceneText = status.job.payload?.sceneOrder !== undefined ? ` (Cảnh ${status.job.payload.sceneOrder})` : "";
    $("job-title").textContent = `${KIND[status.job.kind] ?? "Đang làm việc"}${sceneText}`;
  } else {
    $("dot").className = "dot on";
    $("state").textContent = "Đã kết nối, sẵn sàng";
    $("job-title").textContent = "Sẵn sàng nhận việc mới";
  }

  const cancelBtn = $("cancel-job");
  if (cancelBtn) {
    cancelBtn.style.display = hasJob ? "block" : "none";
  }

  // Pending queue badge
  const pending = Math.max(0, Number(pendingCount) || 0);
  const queueBadge = $("queue-badge");
  if (pending > 0) {
    queueBadge.className = "queue-badge has-pending";
    queueBadge.textContent = `🔥 Có ${pending} công việc đang chờ`;
  } else {
    queueBadge.className = "queue-badge empty";
    queueBadge.textContent = "Hàng đợi: 0 công việc";
  }

  // Error message
  const errEl = $("error");
  const errText = status.error || status.lastError || "";
  if (errText) {
    errEl.style.display = "block";
    errEl.textContent = `Lỗi: ${errText}`;
  } else {
    errEl.style.display = "none";
  }

  // Logs
  const logBox = $("log-box");
  if (!logs || logs.length === 0) {
    logBox.innerHTML = '<div style="color: #64748b; text-align: center; margin-top: 2rem;">Chưa có nhật ký hoạt động</div>';
  } else {
    const html = logs
      .map(
        (l) => `
      <div class="log-item">
        <span class="log-time">[${escapeHtml(l.time)}]</span>
        <span class="log-${escapeHtml(l.level || "info")}">${escapeHtml(l.text)}</span>
      </div>`
      )
      .join("");
    logBox.innerHTML = html;
  }
}

$("poll").onclick = async () => {
  $("poll").textContent = "⏳ Đang kiểm tra...";
  $("poll").disabled = true;
  try {
    await chrome.runtime.sendMessage({ type: "pollNow" });
  } catch {}
  setTimeout(() => {
    $("poll").textContent = "⚡ Nhận việc ngay";
    $("poll").disabled = false;
    render();
  }, 1000);
};

$("clear-logs").onclick = async () => {
  await chrome.storage.local.set({ logs: [] });
  render();
};

const cancelJobBtn = $("cancel-job");
if (cancelJobBtn) {
  cancelJobBtn.onclick = async () => {
    cancelJobBtn.textContent = "⏳ Đang hủy...";
    cancelJobBtn.disabled = true;
    try {
      await chrome.runtime.sendMessage({ type: "cancelCurrent" });
    } catch {}
    setTimeout(() => {
      cancelJobBtn.textContent = "✕ Hủy việc";
      cancelJobBtn.disabled = false;
      render();
    }, 600);
  };
}

const keepTabInput = $("keep-tab");
if (keepTabInput) {
  keepTabInput.onchange = async (e) => {
    await chrome.storage.local.set({ keepActiveTab: e.target.checked });
  };
}

const flowSelectEl = $("flow-account");
const flowCustomWrapEl = $("flow-custom-wrap");
const flowCustomInputEl = $("flow-custom-input");
if (flowSelectEl) {
  flowSelectEl.onchange = async (e) => {
    const val = e.target.value;
    if (val === "custom") {
      flowCustomWrapEl.style.display = "block";
      flowCustomInputEl?.focus();
    } else {
      flowCustomWrapEl.style.display = "none";
      await chrome.storage.local.set({ flowAccount: val });
    }
  };
}
if (flowCustomInputEl) {
  flowCustomInputEl.onchange = async (e) => {
    const val = e.target.value.trim() || "auto";
    await chrome.storage.local.set({ flowAccount: val });
  };
}

const geminiSelectEl = $("gemini-account");
const geminiCustomWrapEl = $("gemini-custom-wrap");
const geminiCustomInputEl = $("gemini-custom-input");
if (geminiSelectEl) {
  geminiSelectEl.onchange = async (e) => {
    const val = e.target.value;
    if (val === "custom") {
      geminiCustomWrapEl.style.display = "block";
      geminiCustomInputEl?.focus();
    } else {
      geminiCustomWrapEl.style.display = "none";
      await chrome.storage.local.set({ geminiAccount: val });
    }
  };
}
if (geminiCustomInputEl) {
  geminiCustomInputEl.onchange = async (e) => {
    const val = e.target.value.trim() || "auto";
    await chrome.storage.local.set({ geminiAccount: val });
  };
}

$("options").onclick = () => chrome.runtime.openOptionsPage();

$("dump").onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    $("hint").textContent = "Không tìm thấy tab đang kích hoạt.";
    return;
  }
  try {
    const info = await chrome.tabs.sendMessage(tab.id, { type: "dump" });
    const text = JSON.stringify(info, null, 2);
    $("out").style.display = "block";
    $("out").value = text;
    await navigator.clipboard.writeText(text).catch(() => {});
    $("hint").textContent = "Đã chép vào clipboard. Dán cho người hỗ trợ để kiểm tra bộ chọn.";
  } catch {
    $("hint").textContent = "Chỉ dùng được khi tab đang mở là suno.com, gemini.google.com hoặc flow.google (tải lại trang nếu vừa cài tiện ích).";
  }
};

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local") {
    render();
  }
});

render();
setInterval(render, 2000);
