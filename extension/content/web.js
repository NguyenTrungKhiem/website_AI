// Content script chạy trên trang AutoAffiliate:
// Khi người dùng bấm tạo việc (tạo bài hát, video cảnh, ảnh bìa...), tiện ích nhận việc tức thì (< 0.1s).
// Script được nạp trên mọi trang https, nên chỉ hoạt động khi địa chỉ trang trùng với web đã cấu hình trong tiện ích.
(() => {
  if (window.__aaWebInjected) return;

  chrome.storage.local.get({ server: "" }).then(({ server }) => {
    let origin = "";
    try {
      origin = new URL(server).origin;
    } catch {
      return;
    }
    if (!origin || location.origin !== origin) return;
    window.__aaWebInjected = true;

    const triggerPoll = () => chrome.runtime.sendMessage({ type: "pollNow" }).catch(() => {});

    // 1. Lắng nghe sự kiện tùy chỉnh phát ra từ giao diện AutoAffiliate
    window.addEventListener("aa-agent-job-created", triggerPoll);

    // 2. Tự động kích hoạt khi người dùng bấm các nút tạo công việc
    document.addEventListener(
      "click",
      (e) => {
        const btn = e.target && e.target.closest ? e.target.closest("button") : null;
        if (!btn) return;
        const txt = (btn.innerText || btn.getAttribute("aria-label") || "").toLowerCase();
        if (/tạo nhạc|tạo video|tạo ảnh|tạo tất cả|gửi cho trình hỗ trợ/.test(txt)) {
          setTimeout(triggerPoll, 600);
          setTimeout(triggerPoll, 2000);
        }
      },
      { passive: true },
    );
  });
})();
