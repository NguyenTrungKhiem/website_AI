// Hàm dùng chung cho script chạy trong tab Suno/Gemini. Không đọc hay gửi mật khẩu; chỉ thao tác trên trang.
/* global chrome */
var AA = (() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  class Cancelled extends Error {}

  const visible = (el) => !!el && !!(el.offsetWidth || el.offsetHeight) && getComputedStyle(el).visibility !== "hidden";
  const text = (el) => (el.innerText || el.textContent || "").trim();

  const send = (msg) => {
    if (!chrome.runtime?.id) {
      return Promise.reject(new Error("Tiện ích đã được tải lại. Vui lòng tải lại trang (F5)."));
    }
    return chrome.runtime.sendMessage(msg).then((r) => {
      if (r && r.error) throw new Error(r.error);
      return r ?? {};
    });
  };

  /** Gắn ngữ cảnh một việc: báo tiến độ (có nhịp tim), nhận biết việc bị hủy trên web. */
  function context(job) {
    let last = 0;
    const report = async (message, status) => {
      last = Date.now();
      const r = await send({ type: "say", jobId: job.id, message, status });
      if (r.cancelled) throw new Cancelled("Việc đã bị hủy trên web");
    };
    return {
      job,
      say: (m) => report(m, "running"),
      needUser: (m) => {
        send({ type: "focusTab" }).catch(() => {});
        return report(m, "needs_user");
      },
      /** Gọi khi chờ lâu: gửi nhịp tim mỗi ~10 giây và kiểm tra hủy */
      beat: async (m = "Đang chờ…", status = "running") => {
        if (Date.now() - last > 10_000) await report(m, status);
      },
      getState: () => send({ type: "state", jobId: job.id }).then((r) => r.state),
      setState: (set) => send({ type: "state", jobId: job.id, set }),
    };
  }

  async function waitFor(check, { timeoutMs, stepMs = 1500, onTick }) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const v = await check();
      if (v) return v;
      if (onTick) await onTick();
      await sleep(stepMs);
    }
    return null;
  }

  /** Đặt giá trị cho ô nhập do React quản lý: dùng setter gốc rồi bắn sự kiện input */
  function setValue(el, value) {
    el.focus();
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /** Nhập văn bản vào ô contenteditable (Gemini) - chạy được cả khi tab ẩn ngầm */
  function setEditable(el, value) {
    el.focus();
    let success = false;
    try {
      document.execCommand("selectAll", false);
      success = document.execCommand("insertText", false, value);
    } catch {}

    const cur = (el.innerText || el.textContent || "").trim();
    if (!success || (!cur.includes(value.slice(0, 20)) && value.length > 0)) {
      try {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        selection.removeAllRanges();
        selection.addRange(range);
        document.execCommand("insertText", false, value);
      } catch {}

      if (!(el.innerText || el.textContent || "").includes(value.slice(0, 20))) {
        el.textContent = value;
      }
    }
    el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  }

  const buttons = () => [...document.querySelectorAll("button, [role='button'], [role='tab'], [role='switch']")].filter(visible);
  const findButton = (re) => buttons().find((b) => re.test(text(b)) || re.test(b.getAttribute("aria-label") || ""));

  /** Phân loại ô nhập theo nhãn/placeholder; dùng thứ tự khi nhãn không rõ */
  function classify(fields) {
    const label = (f) => [f.placeholder, f.aria, f.name, f.label].filter(Boolean).join(" ");
    const pick = (re) => fields.find((f) => re.test(label(f)));
    const out = { lyrics: pick(/lyric|lời/i), style: pick(/style|genre|tag|phong cách|thể loại/i), title: pick(/title|tên bài|tên/i) };
    const areas = fields.filter((f) => f.tag === "textarea" && f !== out.lyrics && f !== out.style);
    if (!out.lyrics && !out.style && fields.filter((f) => f.tag === "textarea").length >= 2) {
      const ta = fields.filter((f) => f.tag === "textarea");
      out.lyrics = ta[0];
      out.style = ta[1];
    } else {
      out.lyrics ??= areas[0];
      out.style ??= fields.filter((f) => f.tag === "textarea" && f !== out.lyrics)[0];
    }
    out.title ??= fields.filter((f) => f.tag === "input" && f !== out.title).pop();
    return out;
  }

  function fieldInfo(el) {
    const labelled = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    return {
      el,
      tag: el.tagName.toLowerCase(),
      placeholder: el.getAttribute("placeholder") || "",
      aria: el.getAttribute("aria-label") || "",
      name: el.getAttribute("name") || "",
      label: labelled ? text(labelled) : (el.closest("label") ? text(el.closest("label")) : ""),
    };
  }
  const textFields = () => [...document.querySelectorAll("textarea, input[type='text'], input:not([type])")].filter(visible).map(fieldInfo);

  /** Cấu trúc trang hiện tại để chỉnh bộ chọn khi giao diện đổi (dán cho người hỗ trợ). Không có nội dung người dùng nhập. */
  function dump() {
    const d = (e) => ({ tag: e.tagName.toLowerCase(), type: e.getAttribute("type"), placeholder: e.getAttribute("placeholder"), aria: e.getAttribute("aria-label"), role: e.getAttribute("role"), text: text(e).slice(0, 50) });
    return {
      url: location.href,
      fields: [...document.querySelectorAll("textarea, input, [contenteditable='true'], [role='textbox']")].filter(visible).map(d),
      buttons: buttons().slice(0, 100).map(d),
      songLinks: [...document.querySelectorAll("a[href*='/song/']")].slice(0, 10).map((a) => a.getAttribute("href")),
      audioSrc: (document.querySelector("audio")?.currentSrc || "").replace(/([?&](token|sig|signature|key)=)[^&]+/gi, "$1…").slice(0, 200),
    };
  }

  /** Lỗi do tình huống chặn không thể vượt qua (hết lượt, nội dung bị từ chối...): dừng việc và báo rõ lý do. */
  class Blocked extends Error {}

  /** Chữ của các hộp thoại, thông báo đang hiện (popup, toast, cảnh báo, tooltip, popover). */
  function overlayTexts() {
    const sel = "[role='dialog'], [aria-modal='true'], [role='alertdialog'], [role='alert'], [role='status'], [role='tooltip'], [role='banner'], [class*='toast' i], [class*='modal' i], [class*='snackbar' i], [class*='popover' i], [class*='tooltip' i], [class*='banner' i], [class*='callout' i], [data-sonner-toast]";
    return [...document.querySelectorAll(sel)].filter(visible).map((el) => ({ el, text: text(el).replace(/\s+/g, " ").slice(0, 600) })).filter((x) => x.text);
  }

  /** Tìm luật đầu tiên khớp với chữ hiện có. rules: [{ kind, re, action: 'fatal' | 'user' | 'wait' | 'dismiss', message }] */
  function matchRules(rules, items) {
    for (const rule of rules) {
      const hit = items.find((i) => rule.re.test(i.text));
      if (hit) return { rule, item: hit };
    }
    return null;
  }

  /** Đóng hộp thoại không quan trọng (quảng cáo, giới thiệu) bằng nút đóng của nó. Không bấm gì khác. */
  function dismiss(el) {
    const close = [...el.querySelectorAll("button, [role='button']")].find((b) => visible(b) && /^(close|dismiss|skip|no thanks|not now|maybe later|got it|×|x|✕)$/i.test(text(b) || b.getAttribute("aria-label") || ""));
    if (close) close.click();
    return !!close;
  }

  /** Attach identity references before generating Cine Studio frames. Never silently omit them. */
  async function attachImageReferences(ctx, getComposer) {
    const urls = ctx.job.payload?.referenceImages;
    if (!Array.isArray(urls) || !urls.length) return;
    const files = [];
    for (let i = 0; i < urls.length; i++) {
      const data = await send({ type: "getImageData", url: urls[i] });
      if (!data?.b64) throw new Error("Không tải được ảnh nhận diện nhân vật");
      const bytes = Uint8Array.from(atob(data.b64), (c) => c.charCodeAt(0));
      files.push(new File([bytes], `cine-reference-${i + 1}.png`, { type: data.mime || "image/png" }));
    }
    await ctx.say(`Đang gắn ${files.length} ảnh nhận diện nhân vật`);
    const inp = getComposer();
    const container = inp?.closest("form") || inp?.parentElement?.parentElement || document.body;
    const count = () => container.querySelectorAll("img, [data-testid*='attachment'], button[aria-label*='Remove'], button[aria-label*='Xóa']").length;
    const before = count();
    const dt = new DataTransfer();
    files.forEach((file) => dt.items.add(file));
    const upload = [...document.querySelectorAll("input[type='file']")].find((el) => !el.accept || /image|png|jpg|jpeg/i.test(el.accept));
    if (upload) { upload.files = dt.files; upload.dispatchEvent(new Event("change", { bubbles: true })); }
    else { inp?.focus(); inp?.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt })); }
    const ready = await waitFor(() => count() >= before + files.length, { timeoutMs: 20000, stepMs: 500, onTick: () => ctx.beat("Đang tải ảnh tham chiếu") });
    if (!ready) {
      await ctx.needUser("Chưa xác nhận đủ ảnh tham chiếu. Dán các ảnh nhân vật vào ô nhập trong Chrome; extension chỉ tiếp tục khi nhận đủ ảnh.");
      const manual = await waitFor(() => count() >= before + files.length, { timeoutMs: 180000, stepMs: 1000, onTick: () => ctx.beat("Chờ ảnh tham chiếu nhân vật", "needs_user") });
      if (!manual) throw new Error("Chưa nhận đủ ảnh tham chiếu; đã dừng để tránh tạo sai nhân vật");
    }
  }

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg?.type === "dump") sendResponse({ ...dump(), overlays: overlayTexts().map((o) => o.text.slice(0, 200)) });
    return false;
  });

  return { attachImageReferences, Blocked, overlayTexts, matchRules, dismiss, sleep, Cancelled, visible, text, send, context, waitFor, setValue, setEditable, buttons, findButton, classify, textFields, dump };
})();

if (typeof module !== "undefined") module.exports = { AA };
