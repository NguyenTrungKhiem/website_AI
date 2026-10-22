/* global chrome */
const $ = (id) => document.getElementById(id);
const msg = (text, cls) => {
  $("msg").textContent = text;
  $("msg").className = cls ?? "";
};

chrome.storage.local.get({ server: "", token: "", flowAccount: "auto", geminiAccount: "auto" }).then(({ server, token, flowAccount, geminiAccount }) => {
  $("server").value = server;
  $("token").value = token;
  $("flowAccount").value = flowAccount || "auto";
  $("geminiAccount").value = geminiAccount || "auto";
});

async function applyOriginRule(serverOrigin) {
  if (!chrome.declarativeNetRequest?.updateDynamicRules) return;
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
              { header: "origin", operation: "set", value: serverOrigin },
              { header: "referer", operation: "set", value: `${serverOrigin}/` },
            ],
          },
          condition: {
            urlFilter: `${serverOrigin}/*`,
            resourceTypes: ["xmlhttprequest"],
          },
        },
      ],
    });
  } catch (e) {
    console.warn("declarativeNetRequest error:", e);
  }
}

$("save").addEventListener("click", async () => {
  const token = $("token").value.trim();
  const flowAccount = $("flowAccount").value.trim() || "auto";
  const geminiAccount = $("geminiAccount").value.trim() || "auto";
  let origin;
  try {
    const u = new URL($("server").value.trim());
    if (!/^https?:$/.test(u.protocol)) throw new Error();
    origin = u.origin;
  } catch {
    return msg("Địa chỉ web không hợp lệ", "err");
  }
  if (!/^aa_[A-Za-z0-9_-]{20,80}$/.test(token)) return msg("Token phải bắt đầu bằng aa_", "err");

  // Cho phép tiện ích gọi tới web của bạn (cần thao tác bấm của người dùng)
  const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
  if (!granted) return msg("Bạn cần cho phép tiện ích truy cập địa chỉ web này", "err");

  // Ghi đè Origin và Referer thành URL hợp lệ để tránh bị tường lửa (WAF/Oneshield) chặn lỗi 400
  await applyOriginRule(origin);

  try {
    const res = await fetch(`${origin}/api/agent/ping`, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return msg(json.error ?? `Máy chủ trả lỗi ${res.status}`, "err");
    await chrome.storage.local.set({ server: origin, token, flowAccount, geminiAccount });
    chrome.runtime.sendMessage({ type: "pollNow" });
    msg(`Đã kết nối với tên "${json.name}". Tiện ích sẽ tự nhận việc từ web.`, "ok");
  } catch (e) {
    msg(`Không kết nối được tới ${origin}: ${e.message}`, "err");
  }
});
