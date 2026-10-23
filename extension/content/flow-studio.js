// Việc của Video Studio trên Google Flow (kind flow_studio_image / flow_studio_video), do server/agentApi.js giao.
// Giao diện Flow TIẾNG ANH (?hl=en); bộ chọn theo aria-label/role như server/flow.js, đã kiểm chứng trên Flow thật.
// Các bước: mở bảng nguyên liệu -> nhận ra file đã có / ảnh Flow tạo theo tên, chưa có thì tải lên -> thêm vào prompt
// theo đúng thứ tự -> chọn Ảnh (Nano Banana) hoặc Video (Ingredients · Omni · 720p) + tỉ lệ -> điền prompt -> thử bấm
// nút tạo MỘT lần; Flow không nhận thì báo "cần bạn xử lý" để bạn bấm nút → (Flow chỉ nhận cú bấm thật ở nút này)
// -> theo dõi ô kết quả -> tải file về web. Không giả làm người, không đổi dấu vết trình duyệt.
/* global AA, chrome */
(() => {
  if (window.__vsFlowStudio) return;
  window.__vsFlowStudio = true;

  const sleep = AA.sleep;
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

  // ---- Tìm phần tử theo role + tên truy cập (rút gọn của getByRole) ----
  const IMPLICIT = { button: "button", textarea: "textbox", select: "combobox", option: "option", a: "link" };
  const roleOf = (el) => {
    const r = el.getAttribute("role");
    if (r) return r;
    const tag = el.tagName.toLowerCase();
    if (tag === "input") return el.type === "radio" ? "radio" : el.type === "checkbox" ? "checkbox" : el.type === "file" ? null : "textbox";
    if (el.isContentEditable) return "textbox";
    return IMPLICIT[tag] || null;
  };
  // Chữ hiển thị, bỏ nhánh aria-hidden và biểu tượng Material (tên biểu tượng là chữ, lẫn vào tên nút)
  const textOf = (el) => {
    let out = "";
    const walk = (n) => {
      if (n.nodeType === Node.TEXT_NODE) { out += n.nodeValue; return; }
      if (n.nodeType !== Node.ELEMENT_NODE) return;
      if (n.getAttribute("aria-hidden") === "true") return;
      const tag = n.tagName.toLowerCase();
      if (tag === "mat-icon" || tag === "svg" || tag === "style" || tag === "script") return;
      if (n.getAttribute("aria-label")) { out += " " + n.getAttribute("aria-label") + " "; return; }
      for (const c of n.childNodes) walk(c);
    };
    walk(el);
    return clean(out);
  };
  const nameOf = (el) => {
    const byId = el.getAttribute("aria-labelledby");
    if (byId) {
      const t = clean(byId.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" "));
      if (t) return t;
    }
    if (el.getAttribute("aria-label")) return clean(el.getAttribute("aria-label"));
    if (el.labels?.length) return clean([...el.labels].map(textOf).join(" "));
    const wrap = el.closest("label");
    if (wrap && el.tagName === "INPUT") return textOf(wrap);
    return clean(el.getAttribute("placeholder")) || textOf(el);
  };
  const visible = (el) => {
    if (el.tagName === "INPUT" && (el.type === "radio" || el.type === "checkbox")) return true;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const matchName = (name, want) => (want instanceof RegExp ? want.test(name) : name === want);
  const all = (role, want, root = document) =>
    [...root.querySelectorAll("*")].filter((el) => roleOf(el) === role && visible(el) && (want == null || matchName(nameOf(el), want)));
  const one = (role, want, root) => all(role, want, root)[0] || null;
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const oneLoose = (role, name) => (name instanceof RegExp ? one(role, name) : one(role, name) || one(role, new RegExp("(^|\\s)" + escapeRe(name) + "$", "i")));
  const waitFor = async (fn, ms, every = 300) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(every); }
    return null;
  };
  const press = (key, keyCode) => {
    const t = document.activeElement || document.body;
    for (const type of ["keydown", "keyup"]) t.dispatchEvent(new KeyboardEvent(type, { key, code: key, keyCode, which: keyCode, bubbles: true, cancelable: true }));
  };
  const setText = (el, text) => {
    el.focus();
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      AA.setValue(el, text);
    } else {
      AA.setEditable(el, text);
      el.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: text }));
      el.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: text }));
      el.dispatchEvent(new KeyboardEvent("keyup", { key: " ", code: "Space", bubbles: true }));
    }
  };
  const mouseEvents = (target, types) => {
    const r = target.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    for (const type of types) {
      const Ctor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
      target.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: "mouse", isPrimary: true, ...(type.endsWith("down") ? { buttons: 1 } : {}), ...(type === "click" ? { detail: 1 } : {}) }));
    }
  };
  const hover = (el) => { el.scrollIntoView?.({ block: "center" }); mouseEvents(el, ["pointerover", "mouseover", "pointerenter", "mouseenter", "pointermove", "mousemove"]); };
  const click = (el) => {
    let target = el;
    if (el.tagName === "INPUT" && (el.type === "radio" || el.type === "checkbox")) target = el.labels?.[0] || el.closest("label") || el;
    target.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    mouseEvents(target, ["pointerover", "mouseover", "pointerdown", "mousedown"]);
    target.focus?.();
    mouseEvents(target, ["pointerup", "mouseup", "click"]);
  };
  const fullClick = (el) => {
    if (!el) return;
    try {
      el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, composed: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
      el.click();
      const touch = el.querySelector(".mat-mdc-button-touch-target");
      if (touch) touch.click();
    } catch {}
  };

  // ---- Flow ----
  const enUrl = () => { const u = new URL(location.href); u.searchParams.set("hl", "en"); return u.href; };
  const dismissOverlays = async () => {
    const closeBtn = [...document.querySelectorAll('button[aria-label*="close" i], button[aria-label*="dismiss" i]')].find(visible);
    if (closeBtn) {
      try { closeBtn.click(); } catch {}
    }
    press("Escape", 27);
    for (let i = 0; i < 4 && document.querySelector(".cdk-overlay-backdrop-showing, .cdk-overlay-backdrop"); i++) {
      const bd = [...document.querySelectorAll(".cdk-overlay-backdrop")].at(-1);
      if (bd) bd.click(); else press("Escape", 27);
      await sleep(200);
    }
  };
  const openAssetPanel = async () => {
    if (one("textbox", "Search assets")) return;
    await dismissOverlays();
    const btn = one("button", "Add ingredients to the prompt box");
    if (!btn) throw new Error('Không thấy nút "Add ingredients to the prompt box" (chưa ở trong dự án, hoặc Flow không phải tiếng Anh)');
    click(btn);
    if (!(await waitFor(() => one("button", "Upload media") || one("textbox", "Search assets"), 15000))) throw new Error("Bảng nguyên liệu không mở");
  };
  const assetOptions = () => { const list = one("listbox", "Asset list"); return list ? all("option", null, list) : []; };
  const flowKey = (title) => String(title).replace(/…\s*$/, "").trim();

  const clearSearch = async () => {
    const s = one("textbox", "Search assets");
    if (!s) return;
    const cur = (s.value ?? s.textContent ?? "").trim();
    if (!cur) return;
    s.focus();
    const clearBtn = s.parentElement?.querySelector('button, [role="button"], mat-icon, [aria-label*="clear" i]');
    if (clearBtn) click(clearBtn);
    setText(s, "");
    s.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "deleteContentBackward" }));
    s.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, inputType: "deleteContentBackward" }));
    s.dispatchEvent(new KeyboardEvent("keyup", { key: "Backspace", bubbles: true }));
    await sleep(400);
  };

  const findAsset = async (key) => {
    await openAssetPanel();
    await clearSearch();
    const search = one("textbox", "Search assets");
    if (!search) return null;
    setText(search, key);
    await sleep(900);
    const opt = assetOptions().find((o) => {
      const nm = nameOf(o);
      return (nm.startsWith(key) || nm.includes(key)) && !/uploading/i.test(nm);
    }) || null;
    // Quan trọng: nếu không tìm thấy, PHẢI xoá ô tìm kiếm để Flow không kẹt ở "No assets found."
    if (!opt) {
      await clearSearch();
    }
    return opt;
  };

  const ingredientCount = () => all("button", "Ingredient").length;
  const addIngredient = async (key) => {
    const opt = await findAsset(key);
    if (!opt) throw new Error(`Không thấy nguyên liệu "${key}" trong dự án`);
    const n = ingredientCount();
    click(opt);
    const add = await waitFor(() => one("button", "Add to prompt"), 5000);
    if (add) click(add);
    await sleep(600);
    if (ingredientCount() <= n) throw new Error(`Không thêm được "${key}" vào prompt`);
    await clearSearch();
  };

  // Tải 1 file lên Flow: nạp file qua CDP (Page.handleFileChooser) khi bấm nút "Upload media",
  // tự động hoàn toàn mà không mở hộp thoại của hệ điều hành và không cần người dùng can thiệp.
  const uploadItem = async (ctx, item) => {
    await openAssetPanel();
    await clearSearch();
    await sleep(400);
    await ctx.say(`Tải lên Flow: ${item.name}`);

    const upBtn = one("button", "Upload media");
    if (!upBtn) throw new Error('Không thấy nút "Upload media" trong bảng nguyên liệu Flow');
    upBtn.scrollIntoView?.({ block: "center", inline: "center" });
    await sleep(300);
    const r = upBtn.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;

    const absPath = item.path || null;
    let uploaded = false;

    if (absPath) {
      try {
        await ctx.say(`Nạp file ${item.name} vào Flow…`);
        await AA.send({ type: "uploadViaCDP", filePath: absPath, x, y });
        uploaded = true;
      } catch (err) {
        console.warn("uploadViaCDP lỗi, thử dự phòng:", err);
      }
    }

    if (!uploaded) {
      // Dự phòng: thử qua input[type="file"] nếu có, hoặc click Upload media
      const data = await AA.send({ type: "getImageData", url: item.url });
      if (data?.b64) {
        const bytes = Uint8Array.from(atob(data.b64), (c) => c.charCodeAt(0));
        const file = new File([bytes], item.name, { type: data.mime || (item.isVideo ? "video/mp4" : "image/png") });
        const dt = new DataTransfer();
        dt.items.add(file);
        let input = upBtn.parentElement?.querySelector('input[type="file"]') || [...document.querySelectorAll('input[type="file"]')].at(-1);
        if (input) {
          input.files = dt.files;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        } else {
          click(upBtn);
        }
      }
    }

    const key = item.name.replace(/\.[^.]+$/, "");
    const deadline = Date.now() + 180_000;
    let asked = false;
    const startTime = Date.now();
    for (;;) {
      const dialog = all("dialog", /Rights to use/i)[0];
      if (dialog) {
        if (ctx.job.payload.autoAgree) {
          const agree = one("button", "I agree", dialog);
          if (agree) click(agree);
        } else if (!asked) {
          asked = true;
          await ctx.needUser('Flow hỏi "Rights to use this video": bấm "I agree" trong hộp thoại đó (hoặc bật "Tự bấm I agree" trong Cài đặt của web).');
        }
      }
      const failed = [...document.querySelectorAll(`main [role="group"][aria-label*="${key}"]`)].some((t) => /upload failed/i.test(t.innerText));
      if (failed) throw new Error(`Flow báo "upload failed" cho ${item.name}`);

      // 1. Kiểm tra trong danh sách hiện tại
      let opt = assetOptions().find((o) => {
        const nm = nameOf(o);
        return (nm.includes(key) || (item.title && nm.includes(item.title))) && !/uploading/i.test(nm);
      });

      // 2. Sau 6s, nếu danh sách dài thử tìm bằng ô search
      if (!opt && Date.now() - startTime > 6000) {
        opt = await findAsset(key);
      }

      if (opt) break;

      if (Date.now() > deadline) throw new Error(`Quá 3 phút chưa thấy ${item.name} trong thư viện Flow`);
      await ctx.beat(`Đang tải ${item.name} lên Flow…`);
      await sleep(1500);
      if (!one("textbox", "Search assets")) await openAssetPanel().catch(() => {});
    }
    await clearSearch();
  };

  const configure = async (kind, ratio, resolution) => {
    const agent = document.querySelector("button.agent-mode-chip-checked");
    if (agent) { click(agent); await sleep(800); }
    await dismissOverlays();
    const trigger = one("button", "Settings trigger");
    if (!trigger) throw new Error('Không thấy nút "Settings trigger"');
    click(trigger);
    const radio = async (name) => {
      const r = await waitFor(() => oneLoose("radio", name), 5000);
      if (!r) throw new Error(`Không thấy lựa chọn "${name}" (radio đang thấy: ${all("radio", null).map(nameOf).join(" | ") || "không có"})`);
      click(r);
      await sleep(400);
    };
    const pickFamily = async (re) => {
      const fam = one("button", "Select model family");
      if (!fam) throw new Error("Không thấy nút chọn model");
      if (re.test(fam.textContent)) return;
      click(fam);
      const item = await waitFor(() => all("menuitem", re)[0], 5000);
      if (!item) throw new Error("Không thấy model " + re);
      click(item);
      await sleep(400);
    };
    if (kind === "image") { await radio("Image"); await radio(ratio); await pickFamily(/Nano Banana/i); }
    else { await radio("Video"); await radio("Ingredients"); await radio(ratio); await pickFamily(/Omni/); await radio(new RegExp("^" + resolution)); }
    await radio("x1");
    await sleep(300);
    const credits = clean(one("link", /credits/i)?.textContent || [...document.querySelectorAll("a, span")].map((e) => e.textContent).find((t) => /\d+\s*credits/i.test(t)) || "");
    press("Escape", 27);
    await sleep(400);
    await dismissOverlays();
    return credits || "? credits";
  };

  const tiles = () => [...new Set([...document.querySelectorAll('flow-grid-tile-container, main [role="group"]')])];
  const mediaId = (src) => (src || "").split("?")[0].split("/").pop();
  const tileMedia = (t) => t.querySelector("video")?.getAttribute("src") || t.querySelector("img")?.getAttribute("src") || "";
  const isUploadTile = (t) => /^vs-/.test(nameOf(t));
  const FAILED_RE = /couldn.t generate|failed to generate|something went wrong|try again later|violat|unusual activity|^failed\b/im;
  const enabled = (b) => !b.disabled && b.getAttribute("aria-disabled") !== "true" && !b.classList.contains("mat-mdc-button-disabled");
  const promptBox = () => one("textbox", "What do you want to create?");
  const promptText = () => { const b = promptBox(); return b ? (b.value ?? b.textContent ?? "").trim() : ""; };
  const promptButtons = () => {
    let c = promptBox();
    for (let i = 0; i < 8 && c; i++) { c = c.parentElement; const btns = c ? all("button", null, c) : []; if (btns.length >= 2) return btns; }
    return [];
  };
  const findStart = () => {
    const box = promptBox();
    let bar = box?.parentElement;
    for (let i = 0; i < 7 && bar; i++) {
      if (!bar.closest('[role="dialog"], flow-grid-tile-container')) {
        const btns = [...bar.querySelectorAll("button, [role='button']")].filter(visible);
        if (btns.length >= 2) {
          const x1 = btns.find((b) => /^(x\d+|\d+x)$/i.test((b.innerText || b.textContent || "").trim()));
          if (x1 && x1.parentElement) {
            const subBtns = [...x1.parentElement.querySelectorAll("button, [role='button']")].filter(visible);
            const idx = subBtns.indexOf(x1);
            if (idx >= 0 && idx < subBtns.length - 1) return subBtns[idx + 1];
          }
          const arrow = btns.find((b) =>
            /arrow_forward|send|^→$/i.test((b.innerText || b.textContent || "").trim()) ||
            /start creating|start generation|^generate$|^create$|bắt đầu tạo/i.test(b.getAttribute("aria-label") || "")
          );
          if (arrow) return arrow;
          const lastBtn = btns[btns.length - 1];
          if (lastBtn && !/add ingredients|settings trigger|x\d+/i.test(nameOf(lastBtn))) return lastBtn;
        }
      }
      bar = bar.parentElement;
    }
    return [...document.querySelectorAll('button, [role="button"]')]
      .filter(visible)
      .find((b) =>
        !b.closest('flow-grid-tile-container, [role="group"], header, nav, [role="dialog"]') &&
        (/arrow_forward|^→$/i.test((b.innerText || b.textContent || "").trim()) ||
         /start creating|start generation|^generate$|^create$|bắt đầu tạo/i.test(b.getAttribute("aria-label") || ""))
      ) || null;
  };

  // Blob (ảnh/video) do trang tạo khi bấm Tải xuống — bắt bởi content/flow-main.js
  let capturedBlob = null;
  let capturedAt = 0;
  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || !/^flow-(image-)?blob$/.test(e.data.__aa || "") || !(e.data.blob instanceof Blob)) return;
    capturedBlob = e.data.blob;
    capturedAt = Date.now();
  });
  const overlayItems = () => [...document.querySelectorAll(".cdk-overlay-container button, .cdk-overlay-container [role='menuitem']")].filter(visible);
  // Dự phòng khi không đọc được link media: menu của ô -> Download -> 720p / Original size (không bao giờ chọn bản nâng cấp)
  const downloadViaMenu = async (tile) => {
    await dismissOverlays();
    mouseEvents(tile, ["pointerover", "mouseover", "pointerenter", "mouseenter", "pointermove", "mousemove"]);
    await sleep(400);
    const more = [...tile.querySelectorAll("button, [role='button']")].find((el) => !el.disabled && /more options/i.test(el.getAttribute("aria-label") || ""));
    if (!more) return false;
    fullClick(more);
    await sleep(900);
    const dl = overlayItems().find((el) => /^download/i.test(textOf(el)));
    if (!dl) { await dismissOverlays(); return false; }
    mouseEvents(dl, ["pointerover", "mouseover"]);
    await sleep(700);
    const pick = () => overlayItems().find((el) => !el.disabled && (/^720p\b|^1080p\b|original size/i.test(textOf(el)) && !/upscal|upgrade/i.test(textOf(el))));
    let q = pick();
    if (!q) { fullClick(dl); await sleep(900); q = pick(); }
    if (q) fullClick(q);
    await sleep(600);
    await dismissOverlays();
    return true;
  };
  const blobToB64 = (blob) => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(",")[1]); r.onerror = () => reject(new Error("Không đọc được file")); r.readAsDataURL(blob); });

  // Tab vừa mở: app Flow còn đang tải (trình nền giao việc ngay khi content script sẵn sàng, trước khi Flow vẽ xong).
  // Chờ tới khi thấy ô prompt + nút thêm nguyên liệu; trên đường đi: đổi sang ?hl=en nếu không phải tiếng Anh,
  // mở dự án nếu đang ở trang danh sách, nhắc đăng nhập nếu Flow hiện trang giới thiệu.
  const ensureReady = async (ctx) => {
    const ready = () => !!(promptBox() && one("button", "Add ingredients to the prompt box"));
    const start = Date.now();
    let switchedLang = false;
    let openedProject = 0;
    let askedLogin = false;
    let returnedFromEdit = 0;
    await ctx.say("Chờ trang Flow tải xong…");
    while (Date.now() - start < 120_000) {
      // 0. Nếu đang ở trong trình chỉnh sửa video (/edit/), tự động thoát ra canvas dự án
      if (/\/edit\//i.test(location.pathname)) {
        if (Date.now() - returnedFromEdit > 3000) {
          returnedFromEdit = Date.now();
          await ctx.say("Đang trong trình chỉnh sửa video, bấm Done để quay lại canvas…");
          const doneBtn = [...document.querySelectorAll("button, [role='button']")].find((b) =>
            visible(b) && /^(done|xong|back|quay lại)$/i.test((textOf(b) || b.getAttribute("aria-label") || "").trim())
          ) || document.querySelector("header button:first-child, button[aria-label*='back' i]");
          if (doneBtn) {
            fullClick(doneBtn);
            await sleep(1500);
          } else {
            location.href = location.href.replace(/\/edit\/[^?#]+/, "");
            await sleep(3500);
          }
        }
        await sleep(1000);
        continue;
      }

      if (ready()) { await sleep(800); return; }
      const lang = document.documentElement.lang || "";
      if (lang && !/^en/i.test(lang) && !switchedLang) {
        switchedLang = true;
        await ctx.say(`Flow đang hiện ngôn ngữ "${lang}", mở lại với ?hl=en…`);
        location.href = enUrl(); // tab tải lại -> trình nền giao lại việc
        await sleep(30_000);
        continue;
      }
      const onAbout = /\/about\b/.test(location.pathname) || [...document.querySelectorAll("a, button")].some((el) => visible(el) && /^(sign in|log in)$/i.test(textOf(el)));
      if (onAbout && !askedLogin) { askedLogin = true; await ctx.needUser("Đăng nhập Google Flow trong tab này; extension sẽ chạy tiếp khi vào được dự án."); }
      if (!location.pathname.includes("/project/") && Date.now() - start > 6000 && Date.now() - openedProject > 10_000) {
        openedProject = Date.now();
        const link = [...document.querySelectorAll('a[href*="/project/"]')].find(visible);
        if (link) { await ctx.say("Mở dự án Flow…"); link.click(); }
        else { const nb = one("button", /new project/i); if (nb) { await ctx.say("Tạo dự án Flow mới…"); click(nb); } }
      }
      await ctx.beat(askedLogin ? "Chờ bạn đăng nhập Flow…" : "Chờ trang Flow tải xong…", askedLogin ? "needs_user" : "running");
      await sleep(1000);
    }
    throw new Error(`Quá 2 phút trang Flow chưa sẵn sàng (URL ${location.pathname}, lang=${document.documentElement.lang || "?"}): mở tab Flow xem có kẹt "Loading…" hay cần đăng nhập không`);
  };

  // ---- Một việc ----
  const run = async (ctx) => {
    const p = ctx.job.payload;
    const kind = p.kind === "image" ? "image" : "video";
    await ensureReady(ctx);
    const st = (await ctx.getState()) || {};
    const curAttempt = ctx.job.attempts?.length || 1;
    if (st.phase === "submitted" && st.attempt === curAttempt && Date.now() - (st.submitTime || 0) < 15 * 60_000) {
      await ctx.say("Trang tải lại sau khi đã bấm tạo: tiếp tục theo dõi ô kết quả…");
      return await collect(ctx, kind, new Set(st.beforeIds || []), st.credits || "");
    }

    await ctx.say(`Chuẩn bị ${kind === "image" ? "ảnh" : "video"} "${p.label || ""}" trên Flow…`);
    const clear = one("button", "Clear prompt");
    if (clear) { click(clear); await sleep(400); }
    for (const item of p.items || []) {
      let key = null;
      // 1. Thử tìm bằng flowTitle nếu có (ảnh do Flow tạo trước đó)
      if (item.title) {
        const found = await findAsset(flowKey(item.title));
        if (found) {
          key = flowKey(item.title);
          await ctx.say(`Dùng ảnh có sẵn trên Flow: ${key}`);
        }
      }
      // 2. Nếu không có hoặc không tìm thấy trên Flow, tìm bằng mã hash vs-...
      if (!key) {
        const base = item.name.replace(/\.[^.]+$/, "");
        const found = await findAsset(base);
        if (found) {
          key = base;
          await ctx.say(`Đã có trên Flow: ${item.name}`);
        } else {
          await uploadItem(ctx, item);
          key = base;
        }
      }
      await addIngredient(key);
      await ctx.say(`+ nguyên liệu: ${key.slice(0, 50)}`);
    }
    await dismissOverlays();
    const credits = await configure(kind, p.aspect === "16:9" ? "16:9" : "9:16", p.resolution === "360p" ? "360p" : "720p");
    await ctx.say(`Cấu hình: ${kind === "image" ? "Image · Nano Banana" : `Video · Ingredients · Omni · ${p.resolution || "720p"}`} · ${p.aspect} (${credits})`);
    const box = promptBox();
    if (!box) throw new Error('Không thấy ô prompt "What do you want to create?"');
    setText(box, p.prompt);
    const start = await waitFor(() => { const b = findStart(); return b && enabled(b) ? b : null; }, 15000, 500);
    if (!start) throw new Error("Nút tạo vẫn bị khoá sau 15s: Flow chưa nhận prompt hoặc đang xử lý nguyên liệu");

    const beforeIds = new Set(tiles().map((t) => mediaId(tileMedia(t))).filter(Boolean));
    const beforeCount = tiles().length;
    const initialPrompt = p.prompt.trim();

    const accepted = () => {
      // 1. Ô prompt đã được dọn sạch (Flow xoá text khi bắt đầu tạo)
      const currentText = promptText();
      if (initialPrompt.length > 0 && currentText !== initialPrompt && currentText.length < initialPrompt.length / 2) return true;
      // 2. Nút tạo hiện spinner xoay
      const btn = findStart();
      if (btn && btn.querySelector('mat-progress-spinner, mat-spinner, [role="progressbar"], .mat-mdc-progress-spinner')) return true;
      // 3. Có ô trong canvas đang hiển thị phần trăm tạo hoặc trạng thái generating
      const currentTiles = tiles();
      if (currentTiles.some((t) => !isUploadTile(t) && /\d+\s*%|generating|creating|queued/i.test(t.innerText))) return true;
      // 4. Số thẻ tăng lên VÀ có thẻ mới ở vị trí đầu tiên
      if (currentTiles.length > beforeCount && currentTiles[0] && !beforeIds.has(mediaId(tileMedia(currentTiles[0])))) return true;
      return false;
    };

    const triggerStart = async () => {
      // 1. Dọn dẹp dialog thừa nếu có
      await dismissOverlays();
      // 2. Focus ô prompt
      box.focus();
      // 3. Kích hoạt qua world MAIN (Angular Zone.js nhận diện trực tiếp)
      window.postMessage({ __aa: "flow-trigger-start" }, "*");
      // 4. Kích hoạt qua DOM click trong content script và CDP
      const b = findStart();
      if (b) {
        fullClick(b);
        const r = b.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          const x = r.left + r.width / 2;
          const y = r.top + r.height / 2;
          try {
            await AA.send({ type: "clickTrusted", x, y });
          } catch (e) {
            console.warn("clickTrusted CDP cảnh báo:", e);
          }
        }
      } else {
        await AA.send({ type: "clickTrusted" }).catch(() => {});
      }
    };

    // Kích hoạt lần 1
    await triggerStart();

    // Chờ 3.5s, nếu Flow chưa nhận thì thử kích hoạt lại lần 2
    if (!(await waitFor(accepted, 3500, 300))) {
      await triggerStart();
    }

    // Chờ Flow tiếp nhận (server Flow phản hồi mất ~2-8s)
    if (!(await waitFor(accepted, 12000, 400))) {
      await ctx.needUser(`Bấm nút → (Start generation) cạnh ô prompt trên Flow để tạo (${credits}). Mọi thứ đã chuẩn bị sẵn.`);
      const ok = await waitFor(accepted, 15 * 60_000, 500);
      if (!ok) throw new Error("Không thấy bạn bấm nút tạo trong 15 phút");
    }
    await ctx.setState({ phase: "submitted", beforeIds: [...beforeIds], credits, attempt: curAttempt, submitTime: Date.now() });
    await ctx.say("Flow đã nhận lệnh tạo, đang theo dõi ô kết quả…");
    return await collect(ctx, kind, beforeIds, credits);
  };

  // Theo dõi ô kết quả mới nhất (đang chạy %, hoặc media chưa thấy trước đó), rồi tải file về web
  const collect = async (ctx, kind, beforeIds, credits) => {
    const deadline = Date.now() + (kind === "image" ? 10 : 25) * 60_000;
    let last = "";
    let menuTries = 0;
    let lastMenu = 0;
    const startTime = Date.now();
    let sawGenerating = false;

    while (Date.now() < deadline) {
      await sleep(3500);
      await ctx.beat("Đang chờ Flow…");

      // Nếu lọt vào trình chỉnh sửa video (/edit/): tự động bấm Done quay lại canvas
      if (/\/edit\//i.test(location.pathname)) {
        const doneBtn = [...document.querySelectorAll("button, [role='button']")].find((b) =>
          visible(b) && /^(done|xong|back|quay lại)$/i.test((textOf(b) || b.getAttribute("aria-label") || "").trim())
        ) || document.querySelector("header button:first-child, button[aria-label*='back' i]");
        if (doneBtn) {
          fullClick(doneBtn);
          await sleep(2000);
        } else {
          location.href = location.href.replace(/\/edit\/[^?#]+/, "");
          await sleep(3500);
        }
        continue;
      }

      const allTiles = tiles().filter((x) => !isUploadTile(x));

      // 1. Kiểm tra nếu có ô đang generating hoặc chạy %
      const generatingTile = allTiles.find((t) => /\d+\s*%|generating|creating|queued/i.test(t.innerText));
      if (generatingTile) {
        sawGenerating = true;
        const text = generatingTile.innerText.trim();
        const pct = text.match(/\d+\s*%/)?.[0];
        if (pct && pct !== last) {
          last = pct;
          await ctx.say("Đang tạo… " + pct);
        }
        continue;
      }

      // 2. Kiểm tra nếu có ô báo lỗi từ Flow
      const failedTile = allTiles.find((t) => FAILED_RE.test(t.innerText));
      if (failedTile) {
        const text = failedTile.innerText.trim();
        const head = text.split("\n").map((l) => l.trim()).filter((l) => l && !/^(warning|error)$/i.test(l)).slice(0, 2).join(" ");
        throw new Error("Flow báo lỗi: " + head + (/will be refunded/i.test(text) ? " (Flow sẽ hoàn credit)" : ""));
      }

      // 3. Trong 8 giây đầu tiên (nếu chưa từng thấy generating), không vội vàng nhận thẻ cũ
      if (Date.now() - startTime < 8000 && !sawGenerating) {
        continue;
      }

      // 4. Tìm thẻ kết quả mới sinh (thẻ đầu tiên trong grid hoặc thẻ có mediaId chưa có trong beforeIds)
      const t = allTiles.find((x) => {
        const m = tileMedia(x);
        const id = mediaId(m);
        return id && !beforeIds.has(id);
      }) || (sawGenerating ? allTiles[0] : null);

      if (!t) continue;

      const title = nameOf(t);
      const name = `flow-${kind}.${kind === "image" ? "png" : "mp4"}`;

      // 1. Link media (https) -> trình nền tải về (có cookie) và gửi lên web
      let src = kind === "image" ? t.querySelector("img")?.getAttribute("src") : t.querySelector("video")?.getAttribute("src");
      if (kind === "video" && !/^https?:/.test(src || "")) {
        hover(t);
        await sleep(1200);
        src = t.querySelector("video")?.getAttribute("src");
      }
      if (/^https:/.test(src || "")) {
        await ctx.say("Tải kết quả về web…");
        try {
          const saved = await AA.send({ type: "fetchUpload", jobId: ctx.job.id, url: src, name, mime: kind === "image" ? "image/png" : "video/mp4" });
          return { assetId: saved.assetId, title, src, credits };
        } catch (e) {
          await ctx.say("Tải thẳng từ link lỗi (" + e.message + "), thử qua menu Download…");
        }
      }

      // 2. Menu Download của ô -> trang tạo Blob -> gửi lên web
      if (capturedBlob && Date.now() - capturedAt < 60_000) {
        const b64 = await blobToB64(capturedBlob);
        const saved = await AA.send({ type: "upload", jobId: ctx.job.id, name, mime: capturedBlob.type || (kind === "image" ? "image/png" : "video/mp4"), b64 });
        return { assetId: saved.assetId, title, credits };
      }
      if (Date.now() - lastMenu > 15_000) {
        if (menuTries >= 4) throw new Error("Kết quả đã xong nhưng không tải được file sau 4 lần: tải tay trên Flow rồi dùng Thay bằng video từ máy.");
        menuTries++;
        lastMenu = Date.now();
        await ctx.say(`Tải qua menu Download (lần ${menuTries}/4)…`);
        if (!(await downloadViaMenu(t))) await ctx.say('Không mở được menu "More options" của ô kết quả (rê chuột vào ô trên Flow giúp)');
      }
    }
    throw new Error("Quá thời gian chờ, chưa thấy ô kết quả trên Flow");
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "run" || !/^flow_studio_(image|video)$/.test(msg.job?.kind || "")) return false;
    sendResponse({ ok: true });
    if (window.__vsJob === msg.job.id) return false;
    window.__vsJob = msg.job.id;
    const ctx = AA.context(msg.job);
    (async () => {
      try {
        const result = await run(ctx);
        await AA.send({ type: "done", jobId: msg.job.id, result });
      } catch (e) {
        if (e instanceof AA.Cancelled) return AA.send({ type: "fail", jobId: msg.job.id, error: "Đã hủy" }).catch(() => {});
        await AA.send({ type: "fail", jobId: msg.job.id, error: e.message }).catch(() => {});
      }
    })();
    return false;
  });
})();
