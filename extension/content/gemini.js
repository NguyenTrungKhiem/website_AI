// Tạo ảnh bìa và tạo video trên Gemini trong chính tab của bạn.
/* global AA, chrome */
(() => {
  if (window.__aaGemini) return;
  window.__aaGemini = true;

  const INPUT = "div.ql-editor[contenteditable='true'], rich-textarea [contenteditable='true'], [role='textbox'][contenteditable='true']";
  const SEND = "button[aria-label*='Send' i], button[aria-label*='Gửi' i]";
  // Tình huống Gemini có thể chặn việc tạo nội dung (fatal = dừng và báo lý do · user = chờ bạn xử lý trong tab)
  const RULES = [
    { kind: "limit", action: "fatal", re: /(reached|hit|exceeded) .{0,50}(limit|quota|credit)|insufficient credits?|not enough credits?|out of credits?|come back (later|tomorrow)|limit.{0,40}(reset|image|video)|giới hạn|hết lượt|hết tín dụng|không có đủ tín dụng|không đủ tín dụng|hết credit/i },
    { kind: "captcha", action: "user", re: /unusual traffic|captcha|verify it['’]?s you|i['’]?m not a robot|xác minh/i },
    { kind: "consent", action: "user", re: /(terms|privacy).{0,60}(agree|accept)|get started|điều khoản|bắt đầu/i },
    { kind: "refusal", action: "fatal", re: /i can['’]?t (create|generate|make|help)|i['’]?m (unable|not able) to (create|generate)|isn['’]?t something i can|against my (guidelines|policy)|can['’]?t (create|generate) (that|images?|videos?)|tôi không thể (tạo|giúp)|không thể tạo/i },
    { kind: "error", action: "fatal", re: /something went wrong|an error occurred|try again|đã xảy ra lỗi|thử lại/i },
  ];
  const MESSAGE = {
    limit: (raw) => `Gemini báo hết lượt hoặc đạt giới hạn: "${raw}". Hãy thử lại sau.`,
    refusal: (raw) => `Gemini từ chối prompt này: "${raw}". Hãy sửa prompt (bỏ tên người thật, nội dung nhạy cảm) rồi thử lại.`,
    error: (raw) => `Gemini báo lỗi: "${raw}"`,
  };
  const USER_PROMPT = {
    captcha: "Google yêu cầu xác minh. Hãy làm ngay trong tab này, tiện ích sẽ chạy tiếp.",
    consent: "Gemini yêu cầu đồng ý điều khoản. Hãy xử lý ngay trong tab này, tiện ích sẽ chạy tiếp.",
  };
  const lastResponse = () => {
    const all = [...document.querySelectorAll("model-response, message-content, .response-container")];
    const el = all[all.length - 1];
    return el ? AA.text(el).replace(/\s+/g, " ").slice(0, 400) : "";
  };

  /** Quét hộp thoại và câu trả lời mới nhất. */
  async function guard(ctx, { checkResponse = false } = {}) {
    for (let round = 0; round < 40; round++) {
      const items = AA.overlayTexts();
      if (checkResponse) items.push({ el: null, text: lastResponse() });
      const hit = AA.matchRules(RULES, items.filter((i) => i.text));
      if (!hit) return;
      const { rule, item } = hit;
      if (rule.action === "fatal") throw new AA.Blocked((MESSAGE[rule.kind] ?? MESSAGE.error)(item.text.slice(0, 160)));
      await ctx.needUser(USER_PROMPT[rule.kind]);
      const cleared = await AA.waitFor(() => !AA.matchRules([rule], AA.overlayTexts()), { timeoutMs: 15 * 60_000, stepMs: 2500, onTick: () => ctx.beat(USER_PROMPT[rule.kind], "needs_user") });
      if (!cleared) throw new AA.Blocked("Hết thời gian chờ bạn xử lý trên Gemini");
      await ctx.say("Đã xử lý xong, tiếp tục");
    }
  }

  const input = () => [...document.querySelectorAll(INPUT)].find(AA.visible);

  // Ảnh Gemini tạo nằm trong khung trả lời: bỏ ảnh nhỏ (avatar, biểu tượng)
  const bigImages = () =>
    [...document.querySelectorAll("model-response img, message-content img, .response-container img, img")]
      .filter((i) => i.naturalWidth >= 512 && i.naturalHeight >= 512 && !/avatar|profile|logo/i.test(i.src))
      .map((i) => i.currentSrc || i.src);

  // Video Gemini tạo
  const allVideos = () =>
    [...document.querySelectorAll("model-response video, message-content video, .response-container video, video")]
      .map((v) => v.currentSrc || v.src || v.querySelector("source")?.src)
      .filter(Boolean);

  async function ensureInput(ctx) {
    await AA.sleep(2500);
    if (!input()) {
      await ctx.needUser("Hãy đăng nhập Gemini trong tab này. Tiện ích sẽ chạy tiếp khi bạn xong.");
      const ok = await AA.waitFor(() => !!input(), { timeoutMs: 15 * 60_000, stepMs: 2500, onTick: () => ctx.beat("Hãy đăng nhập Gemini trong tab này.", "needs_user") });
      if (!ok) throw new Error("Hết thời gian chờ đăng nhập Gemini");
    }
  }

  function submitInput() {
    const send = [...document.querySelectorAll(SEND)].find(AA.visible);
    if (send) send.click();
    else input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
  }

  async function createImage(ctx) {
    const { prompt, aspect, slot } = ctx.job.payload;
    await ensureInput(ctx);
    await guard(ctx);

    await AA.attachImageReferences(ctx, input);

    const before = new Set(bigImages());
    await ctx.say("Đang gửi prompt cho Gemini");
    const orientation = aspect === "9:16" ? "vertical portrait 9:16 aspect ratio" : "horizontal landscape 16:9 aspect ratio";
    AA.setEditable(input(), `Create an image (${orientation}): ${prompt}`);
    await AA.sleep(700);
    submitInput();

    await ctx.say("Đang chờ Gemini tạo ảnh");
    let src = null;
    const done = await AA.waitFor(
      async () => {
        src = bigImages().find((s) => !before.has(s)) ?? null;
        if (!src) await guard(ctx, { checkResponse: true });
        return !!src;
      },
      { timeoutMs: 4 * 60_000, stepMs: 4000, onTick: () => ctx.beat("Đang chờ Gemini tạo ảnh") },
    );
    if (!done) throw new Error("Gemini không trả về ảnh (có thể từ chối prompt, hết lượt tạo ảnh, hoặc giao diện đã đổi)");
    await AA.sleep(2500);

    const name = `cover-${slot ?? "image"}`;
    // Nếu là blob hoặc data url thì lấy trong tab, ngược lại chuyển thẳng sang background worker tải để tránh lỗi CORS
    let blobData = null;
    if (src.startsWith("blob:") || src.startsWith("data:")) {
      try {
        const res = await fetch(src);
        if (res.ok) blobData = await res.blob();
      } catch {}
    }

    if (blobData) {
      const b64 = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(",")[1]);
        r.onerror = () => reject(new Error("Không đọc được ảnh"));
        r.readAsDataURL(blobData);
      });
      const mime = /^image\/(png|jpeg|webp)$/.test(blobData.type) ? blobData.type : "image/png";
      const saved = await AA.send({ type: "upload", jobId: ctx.job.id, name: `${name}.${mime === "image/jpeg" ? "jpg" : mime.slice(6)}`, mime, b64 });
      return { assetId: saved.assetId };
    }

    const saved = await AA.send({ type: "fetchUpload", jobId: ctx.job.id, url: src, name: `${name}.png`, mime: undefined });
    return { assetId: saved.assetId };
  }

  function collectAllMediaUrls() {
    const urls = new Set();
    for (const v of document.querySelectorAll("video")) {
      if (v.currentSrc) urls.add(v.currentSrc);
      if (v.src) urls.add(v.src);
      for (const s of v.querySelectorAll("source")) if (s.src) urls.add(s.src);
    }
    for (const a of document.querySelectorAll("a[href]")) {
      const h = a.href;
      if (!h) continue;
      if (a.hasAttribute("download") || /\.(mp4|webm|mov)(\?|$)/i.test(h) || /googlevideo|storage\.googleapis|blob:/i.test(h)) {
        urls.add(h);
      }
    }
    return urls;
  }

  async function createVideo(ctx) {
    const { prompt, aspect, sceneOrder } = ctx.job.payload;
    await ensureInput(ctx);
    await guard(ctx);

    const beforeResponses = new Set([...document.querySelectorAll("model-response, message-content, .response-container")]);
    const beforeUrls = collectAllMediaUrls();

    await ctx.say(`Đang gửi prompt video cảnh ${sceneOrder ?? ""} cho Gemini`);
    const orientation = aspect === "9:16" ? "vertical portrait 9:16 aspect ratio" : aspect === "1:1" ? "square 1:1 aspect ratio" : "widescreen 16:9 aspect ratio";
    const videoPrompt = `Create a video (${orientation}, cinematic motion, photorealistic 4K): ${prompt}`;
    AA.setEditable(input(), videoPrompt);
    await AA.sleep(700);
    submitInput();

    const submitTime = Date.now();
    const MIN_WAIT_MS = 15_000; // Tối thiểu 15 giây: Tránh nhầm video của cảnh trước trong đoạn chat!

    await ctx.say("Đang chờ Gemini tạo video (khoảng 1-3 phút)");
    let src = null;
    let videoEl = null;
    const done = await AA.waitFor(
      async () => {
        const elapsed = Date.now() - submitTime;

        // Nếu chưa đủ thời gian tối thiểu: tiếp tục chờ
        if (elapsed < MIN_WAIT_MS) {
          await guard(ctx, { checkResponse: false });
          return false;
        }

        // Tìm thẻ video mới xuất hiện trong câu trả lời mới
        const current = [...document.querySelectorAll("model-response video, message-content video, .response-container video, video")];
        for (let i = current.length - 1; i >= 0; i--) {
          const v = current[i];
          const s = v.currentSrc || v.src || v.querySelector("source")?.src;
          if (s && !beforeUrls.has(s)) {
            videoEl = v;
            src = s;
            return true;
          }
        }

        // Kiểm tra nút tải video nếu thẻ video không trực tiếp lộ src
        const dlLinks = [...document.querySelectorAll("model-response a[href*='.mp4'], model-response a[download], a[download][href*='.mp4']")];
        for (let i = dlLinks.length - 1; i >= 0; i--) {
          const a = dlLinks[i];
          if (a.href && !beforeUrls.has(a.href)) {
            src = a.href;
            return true;
          }
        }

        await guard(ctx, { checkResponse: true });
        return false;
      },
      {
        timeoutMs: 6 * 60_000,
        stepMs: 3000,
        onTick: () => {
          const sec = Math.round((Date.now() - submitTime) / 1000);
          ctx.beat(`Đang chờ Gemini tạo video (${sec}s)…`, "running");
        },
      },
    );

    if (!done || !src) throw new Error("Gemini không trả về video (có thể từ chối prompt, hết lượt, hoặc tài khoản chưa bật tạo video)");
    
    // Nếu thẻ video còn đang tải, đợi thêm chút để buffer sẵn sàng
    if (videoEl && videoEl.readyState < 2) {
      await AA.sleep(2000);
    } else {
      await AA.sleep(1000);
    }

    const name = `scene-${sceneOrder ?? "video"}`;
    await ctx.say("Đang chuẩn bị tải file video…");

    // Chiến lược 1: Thử lấy blob ngay trong tab (thành công 100% với blob: và data:)
    let blobData = null;
    if (src.startsWith("blob:") || src.startsWith("data:")) {
      try {
        const res = await fetch(src);
        if (res.ok) {
          const b = await res.blob();
          if (b && b.size > 1000) {
            blobData = b;
          }
        }
      } catch (e) {
        console.debug("Direct tab fetch error:", e);
      }
    }

    if (blobData) {
      await ctx.say("Đang gửi video về web…");
      const b64 = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(",")[1]);
        r.onerror = () => reject(new Error("Không đọc được video"));
        r.readAsDataURL(blobData);
      });
      const mime = blobData.type && blobData.type.startsWith("video/") ? blobData.type : "video/mp4";
      const saved = await AA.send({ type: "upload", jobId: ctx.job.id, name: `${name}.mp4`, mime, b64 });
      return { assetId: saved.assetId, sceneOrder };
    }

    // Chiến lược 2: Nếu không lấy được trong tab, nhờ background service worker tải
    await ctx.say("Đang tải file video về qua trình nền…");
    const saved = await AA.send({ type: "fetchUpload", jobId: ctx.job.id, url: src, name: `${name}.mp4`, mime: "video/mp4" });
    return { assetId: saved.assetId, sceneOrder };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "run" || (msg.job?.kind !== "gemini_image" && msg.job?.kind !== "gemini_video")) return false;
    sendResponse({ ok: true });
    if (window.__aaJob === msg.job.id) return false;
    window.__aaJob = msg.job.id;
    const ctx = AA.context(msg.job);
    (async () => {
      try {
        const result = msg.job.kind === "gemini_video" ? await createVideo(ctx) : await createImage(ctx);
        await AA.send({ type: "done", jobId: msg.job.id, result });
      } catch (e) {
        if (e instanceof AA.Cancelled) return AA.send({ type: "fail", jobId: msg.job.id, error: "Đã hủy" }).catch(() => {});
        await AA.send({ type: "fail", jobId: msg.job.id, error: e.message }).catch(() => {});
      }
    })();
    return false;
  });

  if (typeof module !== "undefined") module.exports = { RULES, MESSAGE };
})();
