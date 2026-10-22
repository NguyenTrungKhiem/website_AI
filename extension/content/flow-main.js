// Chạy trong "thế giới" của chính trang Flow (world: MAIN) để thấy được những gì script của trang làm.
// Script trong tiện ích (isolated world) KHÔNG thấy được lời gọi của trang tới URL.createObjectURL hay thẻ <a>.click(),
// nên các "hook" trước đây đặt trong flow.js không bao giờ chạy. Ở đây ta chỉ ghi nhận các Blob video lớn mà trang tạo ra
// (thường là file mp4 ngay trước khi tải xuống) rồi chuyển cho script tiện ích qua window.postMessage.
(() => {
  if (window.__aaMainHook) return;
  window.__aaMainHook = true;
  const original = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    try {
      if (obj instanceof Blob && obj.size > 50_000 && (/^video\//i.test(obj.type) || obj.type === "" || obj.type === "application/octet-stream")) {
        window.postMessage({ __aa: "flow-blob", blob: obj, size: obj.size, type: obj.type }, "*");
      }
      // Ảnh tải xuống (Video Studio: bối cảnh, bảng mặt 360°, keyframe) cho content/flow-studio.js
      if (obj instanceof Blob && obj.size > 20_000 && /^image\//i.test(obj.type)) {
        window.postMessage({ __aa: "flow-image-blob", blob: obj, size: obj.size, type: obj.type }, "*");
      }
    } catch {
      /* không ảnh hưởng trang */
    }
    return original.apply(this, arguments);
  };

  // Trợ giúp bấm nút tạo từ chính world MAIN
  window.addEventListener("message", (e) => {
    if (e.source !== window || e.data?.__aa !== "flow-trigger-start") return;
    try {
      const btn = document.querySelector('button[aria-label="Start generation"]') ||
                  document.querySelector('button.generate-icon-button') ||
                  document.querySelector('form button[type="submit"]');
      if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') {
        btn.click();
        const touch = btn.querySelector('.mat-mdc-button-touch-target');
        if (touch) touch.click();
      }
      const form = btn?.closest('form') || document.querySelector('form');
      if (form) {
        if (typeof form.requestSubmit === 'function') form.requestSubmit();
        else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      }
    } catch {}
  });
})();
