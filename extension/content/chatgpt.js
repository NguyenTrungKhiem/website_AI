// Tạo ảnh bằng ChatGPT trong chính tab của bạn (tài khoản ChatGPT đang đăng nhập).
// Bộ chọn dựng theo giao diện chatgpt.com thật (kiểm tra 11/10/2026):
//  - ô nhập: form[data-chatgpt-composer] > div.ProseMirror[contenteditable] (aria-label "Ask ChatGPT")
//  - nút gửi: button[aria-label="Send"] (chỉ hiện khi đã có chữ); đang chạy thì có nút "Stop"
//  - ảnh: [data-testid="generated-image-gallery"] img[alt^="Generated image"], nguồn dạng blob:
/* global AA, chrome */
(() => {
  if (window.__aaChatgpt) return;
  window.__aaChatgpt = true;

  const COMPOSER = 'form[data-chatgpt-composer] div.ProseMirror[contenteditable="true"], #prompt-textarea[contenteditable="true"], div[contenteditable="true"][role="textbox"]';
  const GALLERY_IMG = '[data-testid="generated-image-gallery"] img, img[alt^="Generated image" i]';
  const LOGGED_OUT = /^(log in|sign up|đăng nhập|đăng ký)$/i;
  const CHALLENGE = /verify you are human|xác minh bạn là con người|just a moment/i;

  const composer = () => [...document.querySelectorAll(COMPOSER)].find(AA.visible) ?? null;
  const composerForm = () => composer()?.closest("form") ?? document.querySelector("form[data-chatgpt-composer]");
  const formButtons = () => [...(composerForm()?.querySelectorAll("button") ?? [])];
  const sendButton = () =>
    formButtons().find((b) => !b.disabled && (/^send/i.test(b.getAttribute("aria-label") || "") || b.getAttribute("data-testid") === "send-button")) ?? null;
  /** Đang trả lời: nút "Stop" (hoặc "Stop streaming") thay cho nút gửi */
  const streaming = () => formButtons().some((b) => /^stop/i.test(b.getAttribute("aria-label") || "") || b.getAttribute("data-testid") === "stop-button");
  const loggedOut = () => !composer() && AA.buttons().some((b) => LOGGED_OUT.test(AA.text(b)));
  const generatedImages = () => [...document.querySelectorAll(GALLERY_IMG)].filter((i) => i.src && i.naturalWidth >= 256);

  async function ensureReady(ctx) {
    const ready = await AA.waitFor(() => composer() || loggedOut() || CHALLENGE.test(document.body.innerText || ""), { timeoutMs: 30_000, stepMs: 1000 });
    if (composer()) return;
    if (!ready && !loggedOut()) throw new Error("Không tìm thấy ô nhập của ChatGPT (trang chưa tải xong hoặc giao diện đã đổi). Kiểm tra tab ChatGPT.");
    await ctx.needUser(loggedOut() ? "Hãy đăng nhập ChatGPT trong tab này. Tiện ích sẽ chạy tiếp khi bạn xong." : "ChatGPT yêu cầu xác minh. Hãy làm trong tab này, tiện ích sẽ chạy tiếp.");
    const ok = await AA.waitFor(() => !!composer(), {
      timeoutMs: 15 * 60_000,
      stepMs: 2500,
      onTick: () => ctx.beat("Hãy đăng nhập hoặc xác minh ChatGPT trong tab này.", "needs_user"),
    });
    if (!ok) throw new AA.Blocked("Hết thời gian chờ đăng nhập ChatGPT");
    await ctx.say("Đã sẵn sàng trên ChatGPT");
  }

  /** Lời ChatGPT trả về sau prompt (để báo lý do khi không có ảnh: hết lượt, từ chối nội dung...) */
  function replyAfter(promptHead) {
    const text = (document.querySelector("main")?.innerText || "").replace(/\s+/g, " ");
    const i = text.lastIndexOf(promptHead);
    const tail = i >= 0 ? text.slice(i + promptHead.length) : text.slice(-400);
    return tail.replace(/\b(Edit|Copy|Share|Try again|Read aloud|More actions)\b/g, " ").replace(/\s+/g, " ").trim().slice(-300);
  }

  async function createImage(ctx) {
    const { prompt, aspect, slot } = ctx.job.payload;
    await ensureReady(ctx);

    await AA.attachImageReferences(ctx, composer);

    const before = new Set(generatedImages().map((i) => i.src));
    const orientation = aspect === "9:16" ? "vertical portrait 9:16 aspect ratio" : aspect === "1:1" ? "square 1:1 aspect ratio" : "horizontal landscape 16:9 aspect ratio";
    const text = `Create an image (${orientation}): ${prompt}`;
    await ctx.say("Đang gửi prompt cho ChatGPT");
    const filled = () => (AA.text(composer() ?? document.body) || "").includes(text.slice(0, 30));
    for (let i = 0; i < 2 && !filled(); i++) {
      AA.setEditable(composer(), text);
      await AA.sleep(700);
    }
    if (!filled()) throw new Error("Không điền được prompt vào ô nhập của ChatGPT (giao diện có thể đã đổi). Kiểm tra tab ChatGPT.");

    // Bấm gửi đúng một lần; chỉ thử lại khi ChatGPT chưa nhận (không thấy đang chạy và ô nhập vẫn còn chữ)
    for (let attempt = 0; attempt < 2; attempt++) {
      const send = await AA.waitFor(() => sendButton(), { timeoutMs: 8000, stepMs: 400 });
      if (send) send.click();
      else composer()?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
      const accepted = await AA.waitFor(() => streaming() || !filled(), { timeoutMs: 10_000, stepMs: 500 });
      if (accepted) break;
      if (attempt === 1) throw new Error("Đã bấm gửi nhưng ChatGPT không nhận prompt (nút gửi bị khóa hoặc giao diện đã đổi). Kiểm tra tab ChatGPT.");
    }

    await ctx.say("ChatGPT đang vẽ ảnh");
    // Xong khi: có ảnh mới, ChatGPT đã ngừng trả lời và ảnh không đổi nữa (tránh lấy bản xem trước còn mờ)
    let img = null;
    let lastSrc = "";
    let stableSince = 0;
    let idleSince = 0;
    const done = await AA.waitFor(
      () => {
        if (CHALLENGE.test(document.body.innerText || "")) return "challenge";
        img = generatedImages().find((i) => !before.has(i.src)) ?? null;
        const busy = streaming();
        if (img) {
          if (img.src !== lastSrc) {
            lastSrc = img.src;
            stableSince = Date.now();
          }
          return !busy && Date.now() - stableSince >= 3000 ? "image" : null;
        }
        // Đã ngừng trả lời mà không có ảnh: chờ thêm chút (ảnh đôi khi hiện sau) rồi coi như ChatGPT từ chối/hết lượt
        if (busy) idleSince = 0;
        else if (!idleSince) idleSince = Date.now();
        return idleSince && Date.now() - idleSince > 15_000 ? "no-image" : null;
      },
      {
        timeoutMs: 6 * 60_000,
        stepMs: 1500,
        onTick: () => ctx.beat(/creating image|đang tạo ảnh/i.test(document.body.innerText || "") ? "ChatGPT đang vẽ ảnh" : "Đang chờ ChatGPT"),
      },
    );
    if (done === "challenge") throw new AA.Blocked("ChatGPT yêu cầu xác minh bạn là người thật. Hãy xác minh trong tab ChatGPT rồi tạo lại ảnh.");
    if (done !== "image") {
      const reply = replyAfter(text.slice(0, 60));
      throw new Error(
        done === "no-image" && reply
          ? `ChatGPT không tạo ảnh. ChatGPT trả lời: "${reply}"`
          : "ChatGPT không trả về ảnh sau 6 phút (có thể hết lượt tạo ảnh, từ chối prompt hoặc mạng chậm). Kiểm tra tab ChatGPT.",
      );
    }

    await ctx.say("Đang tải ảnh về hệ thống");
    const res = await fetch(img.src);
    if (!res.ok) throw new Error(`Không đọc được ảnh ChatGPT (${res.status})`);
    const blob = await res.blob();
    const mime = /^image\/(png|jpeg|webp)$/.test(blob.type) ? blob.type : "image/png";
    const b64 = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(",")[1]);
      r.onerror = () => reject(new Error("Không đọc được ảnh"));
      r.readAsDataURL(blob);
    });
    const name = `chatgpt-${slot ?? "image"}.${mime === "image/jpeg" ? "jpg" : mime.slice(6)}`;
    const saved = await AA.send({ type: "upload", jobId: ctx.job.id, name, mime, b64 });
    return { assetId: saved.assetId };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "run" || msg.job?.kind !== "chatgpt_image") return false;
    sendResponse({ ok: true });
    if (window.__aaJob === msg.job.id) return false;
    window.__aaJob = msg.job.id;
    const ctx = AA.context(msg.job);
    (async () => {
      try {
        const result = await createImage(ctx);
        await AA.send({ type: "done", jobId: msg.job.id, result });
      } catch (e) {
        if (e instanceof AA.Cancelled) return AA.send({ type: "fail", jobId: msg.job.id, error: "Đã hủy" }).catch(() => {});
        await AA.send({ type: "fail", jobId: msg.job.id, error: e.message }).catch(() => {});
      }
    })();
    return false;
  });

  if (typeof module !== "undefined") module.exports = { createImage, composer, sendButton, streaming, generatedImages, replyAfter };
})();
