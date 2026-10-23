// Chạy trong "thế giới" của chính trang Flow (world: MAIN) để thấy được những gì script của trang làm.
// Script trong tiện ích (isolated world) KHÔNG thấy được lời gọi của trang tới URL.createObjectURL hay thẻ <a>.click(),
// nên các "hook" trước đây đặt trong flow.js không bao giờ chạy. Ở đây ta chỉ ghi nhận các Blob video lớn mà trang tạo ra
// (thường là file mp4 ngay trước khi tải xuống) rồi chuyển cho script tiện ích qua window.postMessage.
(() => {
  if (window.__aaMainHook) return;
  window.__aaMainHook = true;

  // ---------- 1. Bắt Blob tải xuống (Video & Ảnh) ----------
  const originalCreateObjectURL = URL.createObjectURL;
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
    return originalCreateObjectURL.apply(this, arguments);
  };

  // ---------- 2. Bắt chặn và nạp tệp tự động khi bấm "Upload media" (Zero manual dialog) ----------
  let pendingUploadFiles = [];
  let pendingClearTimer = null;

  // A. Hook File System Access API (window.showOpenFilePicker)
  if (typeof window.showOpenFilePicker === "function") {
    const origShowOpenFilePicker = window.showOpenFilePicker;
    window.showOpenFilePicker = async function (options) {
      if (pendingUploadFiles.length > 0) {
        const filesToReturn = [...pendingUploadFiles];
        pendingUploadFiles = [];
        if (pendingClearTimer) clearTimeout(pendingClearTimer);
        console.log("[AA MAIN] Intercepted showOpenFilePicker with staged files:", filesToReturn.map((f) => f.name));
        return filesToReturn.map((file) => ({
          kind: "file",
          name: file.name,
          getFile: async () => file,
          createWritable: async () => { throw new Error("Read-only"); },
        }));
      }
      return origShowOpenFilePicker.apply(this, arguments);
    };
  }

  // B. Hook HTMLInputElement.prototype.click cho <input type="file">
  const origInputClick = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function () {
    if (this.type === "file" && pendingUploadFiles.length > 0) {
      console.log("[AA MAIN] Intercepted input[type='file'].click with staged files:", pendingUploadFiles.map((f) => f.name));
      try {
        const dt = new DataTransfer();
        for (const f of pendingUploadFiles) dt.items.add(f);
        this.files = dt.files;
        this.dispatchEvent(new Event("input", { bubbles: true }));
        this.dispatchEvent(new Event("change", { bubbles: true }));
      } catch (err) {
        console.warn("[AA MAIN] Error assigning files to input:", err);
      }
      pendingUploadFiles = [];
      if (pendingClearTimer) clearTimeout(pendingClearTimer);
      return;
    }
    return origInputClick.apply(this, arguments);
  };

  // C. Lắng nghe tin nhắn từ content script (flow-studio.js)
  window.addEventListener("message", (e) => {
    if (e.source !== window) return;

    // Chuẩn bị tệp để tự động nạp khi bấm Upload media
    if (e.data?.__aa === "flow-stage-upload" && Array.isArray(e.data.files)) {
      try {
        pendingUploadFiles = e.data.files.map((item) => {
          const bin = atob(item.b64);
          const len = bin.length;
          const u8 = new Uint8Array(len);
          for (let i = 0; i < len; i++) u8[i] = bin.charCodeAt(i);
          return new File([u8], item.name, { type: item.mime || "image/png" });
        });
        if (pendingClearTimer) clearTimeout(pendingClearTimer);
        pendingClearTimer = setTimeout(() => { pendingUploadFiles = []; }, 15_000);
        console.log("[AA MAIN] Staged files for upload:", pendingUploadFiles.map((f) => f.name));
        window.postMessage({ __aa: "flow-stage-upload-ready", count: pendingUploadFiles.length }, "*");
      } catch (err) {
        console.error("[AA MAIN] Error staging upload files:", err);
      }
      return;
    }

    // Trợ giúp bấm nút tạo từ chính world MAIN (nơi Angular Zone.js bắt sự kiện gốc)
    if (e.data?.__aa === "flow-trigger-start") {
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
      return;
    }
  });
})();
