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

  // Trợ giúp bấm nút tạo từ chính world MAIN (nơi Angular Zone.js bắt sự kiện gốc)
  window.addEventListener("message", (e) => {
    if (e.source !== window || e.data?.__aa !== "flow-trigger-start") return;
    try {
      const candidates = [...document.querySelectorAll('button, [role="button"]')].filter((b) => {
        const r = b.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && !b.disabled && b.getAttribute("aria-disabled") !== "true";
      });
      const btn = candidates.find((b) =>
        !b.closest('flow-grid-tile-container, [role="group"], header, nav, [role="dialog"]') &&
        (/arrow_forward|^→$/i.test((b.innerText || b.textContent || "").trim()) ||
         /start creating|start generation|^generate$|^create$|bắt đầu tạo/i.test(b.getAttribute("aria-label") || ""))
      );
      if (btn) {
        btn.focus?.();
        btn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true, cancelable: true }));
        btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        btn.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, composed: true, cancelable: true }));
        btn.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
        btn.click();
        const touch = btn.querySelector(".mat-mdc-button-touch-target");
        if (touch) touch.click();
      }
    } catch {}
  });
})();
