// Tự động tạo video trên Google Flow (flow.google.com / labs.google) trong tab của bạn.
/* global AA, chrome */
(() => {
  if (window.__aaFlow) return;
  window.__aaFlow = true;

  const INPUT_SEL = "textarea, [contenteditable='true'], [contenteditable='plaintext-only'], rich-textarea [contenteditable='true'], [role='textbox'], input[type='text']:not([type='hidden'])";
  const SEND_SEL = "button, [role='button']";

  const RULES = [
    {
      kind: "limit",
      action: "fatal",
      re: /(reached|hit|exceeded) .{0,50}(limit|quota|credit)|insufficient credits?|not enough credits?|out of credits?|no credits left|come back (later|tomorrow)|hết credit|hết lượt|không có đủ tín dụng|không đủ tín dụng|đã hết tín dụng|hết tín dụng|nâng cấp để có thêm tín dụng/i,
    },
    { kind: "captcha", action: "user", re: /unusual traffic|captcha|verify it['’]?s you|i['’]?m not a robot|xác minh/i },
    { kind: "consent", action: "user", re: /(terms|privacy).{0,60}(agree|accept)|get started|điều khoản|bắt đầu/i },
    { kind: "refusal", action: "fatal", re: /cannot generate|against .{0,30}(guidelines|policy)|content violation|safety filter|từ chối|vi phạm chính sách/i },
    { kind: "error", action: "fatal", re: /generation failed|something went wrong|an error occurred|đã xảy ra lỗi|thử lại/i },
  ];

  const MESSAGE = {
    limit: (raw) => `Google Flow báo hết tín dụng: "${raw}". Hãy nạp thêm tín dụng AI hoặc đổi tài khoản khác.`,
    refusal: (raw) => `Google Flow từ chối prompt video này: "${raw}". Hãy điều chỉnh prompt và thử lại.`,
    error: (raw) => `Google Flow báo lỗi: "${raw}"`,
  };

  const USER_PROMPT = {
    captcha: "Google yêu cầu xác minh captcha. Hãy làm ngay trong tab này, tiện ích sẽ chạy tiếp.",
    consent: "Google Flow yêu cầu đồng ý điều khoản. Hãy xử lý ngay trong tab này, tiện ích sẽ chạy tiếp.",
  };

  // Nhãn của nút đóng/xóa phải khớp NGUYÊN CHỮ. Trước đây regex /...|x/ khớp mọi nhãn có chữ "x" (vd "Export", "x1", "Next")
  // nên đóng modal hay gỡ chip có thể bấm nhầm các nút khác trên thanh prompt.
  const CLOSE_LABEL = /^(close|đóng|cancel|hủy|bỏ qua|dismiss|×|✕|x)$/i;
  const REMOVE_LABEL = /^(xóa|remove|clear|deselect|bỏ chọn|đóng|close|×|✕|x)$/i;
  const labelsOf = (el) => [el.getAttribute?.("aria-label"), el.title, el.innerText].map((s) => (s || "").trim()).filter(Boolean);
  const hasLabel = (el, re) => labelsOf(el).some((l) => re.test(l));
  const isCloseButton = (el) => hasLabel(el, CLOSE_LABEL);

  // Flow dùng font biểu tượng Material: innerText của nút/mục menu bắt đầu bằng TÊN biểu tượng ("download Tải xuống",
  // "arrow_forward", "play_circle Tên video"). Khớp theo chữ phải bỏ phần đó, nếu không /^tải xuống/ không bao giờ khớp.
  const ICON_PREFIX = /^[a-z][a-z0-9_]*\s+(?=\S)/;
  const cleanText = (el) => (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").replace(ICON_PREFIX, "");

  /** Kiểm tra trạng thái hết tín dụng trên Google Flow (bao gồm popover, tooltip, banner cảnh báo) */
  function checkCredits() {
    // 1. Quét các phần tử popover, tooltip, banner, alert trên toàn trang
    const candidateEls = [
      ...document.querySelectorAll(
        "[role='tooltip'], [role='dialog'], [role='alert'], [role='banner'], [class*='popover' i], [class*='tooltip' i], [class*='banner' i], [class*='callout' i]"
      ),
    ].filter(AA.visible);

    for (const el of candidateEls) {
      const txt = AA.text(el);
      if (
        /không có đủ tín dụng|không đủ tín dụng|đã hết tín dụng|hết tín dụng|nâng cấp để có thêm tín dụng|insufficient credits?|not enough credits?|out of credits?/i.test(
          txt
        )
      ) {
        return txt.slice(0, 160);
      }
    }

    // 2. Quét vùng thanh prompt bar (nút submit hoặc nút báo lỗi màu cam có icon chấm than '!')
    const promptBar = document.querySelector("[class*='prompt' i], form, footer") || document.body;
    const warningElements = [
      ...promptBar.querySelectorAll("button, [role='button'], [class*='error' i], [class*='warning' i], [class*='credit' i]"),
    ].filter(AA.visible);

    for (const el of warningElements) {
      const fullText = [el.innerText, el.getAttribute("aria-label"), el.title].filter(Boolean).join(" ");
      if (
        /không có đủ tín dụng|không đủ tín dụng|hết tín dụng|insufficient credits?|not enough credits?|out of credits?/i.test(
          fullText
        )
      ) {
        return fullText.slice(0, 160);
      }
    }

    return null;
  }

  /** Tự động đóng các modal chào mừng / hướng dẫn nếu có */
  function dismissOverlays() {
    const overlays = AA.overlayTexts();
    for (const item of overlays) {
      if (item.el) {
        AA.dismiss(item.el);
      }
    }
    const dismissBtns = [...document.querySelectorAll("button, [role='button']")].filter(AA.visible);
    const gotIt = dismissBtns.find((b) =>
      /^(got it|dismiss|close|tiếp tục|bỏ qua|đã hiểu|bắt đầu|next|skip)$/i.test((b.innerText || b.getAttribute("aria-label") || "").trim())
    );
    if (gotIt) gotIt.click();
  }

  /** Đóng tất cả các modal, dialog thư viện thành phần hoặc popover đang mở */
  async function closeAllModals() {
    // 1. Nếu có nút "Thêm vào câu lệnh", bấm để hoàn tất chèn ảnh đã chọn vào prompt
    const addPromptBtn = [...document.querySelectorAll("button, [role='button']")].find((b) =>
      AA.visible(b) && /thêm vào câu lệnh|add to prompt/i.test((b.innerText || b.getAttribute("aria-label") || "").trim())
    );
    if (addPromptBtn) {
      fullClick(addPromptBtn);
      await AA.sleep(500);
    }

    // 2. Tìm tất cả các hộp thoại/dialog đang hiển thị trên trang và bấm nút đóng (× / Close)
    const dialogs = [...document.querySelectorAll("[role='dialog'], [aria-modal='true'], [class*='modal' i], [class*='dialog' i], [class*='picker' i]")].filter(AA.visible);
    for (const d of dialogs) {
      const closeBtn = [...d.querySelectorAll("button, [role='button']")].find((b) => AA.visible(b) && isCloseButton(b));
      if (closeBtn) {
        fullClick(closeBtn);
        await AA.sleep(200);
      }
    }

    // 3. Dispatch phím Escape để đóng triệt để mọi popup/overlay
    try {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true }));
      document.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true }));
    } catch {}

    await AA.sleep(300);
  }

  /** Quét hộp thoại và cảnh báo hiện thời */
  async function guard(ctx) {
    const creditErr = checkCredits();
    if (creditErr) {
      throw new AA.Blocked(`Google Flow báo hết tín dụng: "${creditErr}". Hãy nạp thêm tín dụng AI hoặc nâng cấp tài khoản.`);
    }

    for (let round = 0; round < 30; round++) {
      const items = AA.overlayTexts();
      const hit = AA.matchRules(RULES, items.filter((i) => i.text));
      if (!hit) return;
      const { rule, item } = hit;
      if (rule.action === "fatal") throw new AA.Blocked((MESSAGE[rule.kind] ?? MESSAGE.error)(item.text.slice(0, 160)));
      await ctx.needUser(USER_PROMPT[rule.kind]);
      const cleared = await AA.waitFor(() => !AA.matchRules([rule], AA.overlayTexts()), {
        timeoutMs: 15 * 60_000,
        stepMs: 2500,
        onTick: () => ctx.beat(USER_PROMPT[rule.kind], "needs_user"),
      });
      if (!cleared) throw new AA.Blocked("Hết thời gian chờ bạn xử lý trên Google Flow");
      await ctx.say("Đã xử lý xong, tiếp tục");
    }
  }

  /** Tìm chính xác ô nhập prompt ở thanh công cụ dưới đáy trang ("Bạn muốn tạo gì?") */
  function findPromptInput() {
    const all = [...document.querySelectorAll(INPUT_SEL)].filter(AA.visible);
    if (all.length === 0) return null;

    // 1. Lọc bỏ các ô nằm trong dialog / modal tìm kiếm thành phần hoặc sidebar phiên tác nhân
    const nonModal = all.filter((el) => {
      if (el.closest("[role='dialog'], [aria-modal='true'], [class*='modal' i], [class*='dialog' i], [class*='picker' i], [class*='library' i]")) {
        return false;
      }
      // Bỏ qua hoàn toàn ô nhập nằm trong sidebar phiên tác nhân (Phiên không có tiêu đề)
      const containerText = (el.closest("aside, [role='complementary'], [class*='sidebar' i], [class*='panel' i], div")?.innerText || "").toLowerCase();
      if (containerText.includes("phiên không có tiêu đề") || containerText.includes("untitled session")) {
        return false;
      }
      const p = (el.getAttribute("placeholder") || "").toLowerCase();
      if (/tìm kiếm|search|filter/i.test(p)) {
        return false;
      }
      return true;
    });

    const candidates = nonModal.length > 0 ? nonModal : all;

    // 2. Ưu tiên cao nhất: Ô có placeholder khớp "Bạn muốn tạo gì?" hoặc "What do you want to create?"
    const matched = candidates.find((el) => {
      const hint = [
        el.getAttribute("placeholder"),
        el.getAttribute("aria-label"),
        el.getAttribute("name"),
        el.getAttribute("data-testid"),
        el.id,
      ].filter(Boolean).join(" ").toLowerCase();
      return /bạn muốn tạo gì|what do you want to create|tạo gì|describe|imagine|prompt/i.test(hint);
    });
    if (matched) return matched;

    // 3. Ưu tiên ô textarea hoặc contenteditable nằm ở nửa dưới màn hình
    const bottomCandidates = candidates.filter((el) => el.getBoundingClientRect().top > window.innerHeight * 0.4);
    const textareas = bottomCandidates.filter((el) => el.tagName.toLowerCase() === "textarea" || el.getAttribute("contenteditable") === "true");
    if (textareas.length > 0) {
      textareas.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
      return textareas[0];
    }

    if (bottomCandidates.length > 0) return bottomCandidates[bottomCandidates.length - 1];
    return candidates[candidates.length - 1];
  }

  /** Tìm nút gửi/tạo video (nút tròn chứa mũi tên → ở góc dưới bên phải thanh prompt) */
  function findSubmitButton(inp) {
    // 0. Giao diện Flow hiện tại (đã kiểm tra trên trang thật): thanh dưới là [+][Tác nhân][Video · 720p · 8 giây][→ "Bắt đầu tạo"], không có nút x1
    const direct = [...document.querySelectorAll("button, [role='button']")].find(
      (b) => AA.visible(b) && !b.disabled && (/^(bắt đầu tạo|start creating|generate|create)$/i.test((b.getAttribute("aria-label") || "").trim()) || /^arrow_forward$/.test((b.innerText || "").trim())),
    );
    if (direct) return direct;
    const lockedReal = [...document.querySelectorAll("button, [role='button']")].find((b) => AA.visible(b) && /^(bắt đầu tạo|start creating)$/i.test((b.getAttribute("aria-label") || "").trim()));
    if (lockedReal) return null; // nút gửi thật đang khoá (prompt chưa vào ô): không bấm nút nào khác

    // 1. Xác định container chứa prompt (hộp thoại prompt hoặc toàn màn hình)
    const promptContainer = inp?.closest("[role='dialog'], [aria-modal='true'], [class*='modal' i], [class*='dialog' i], form, footer, [class*='prompt' i]") || inp?.parentElement?.parentElement?.parentElement || document.body;
    const localBtns = [...promptContainer.querySelectorAll("button, [role='button']")].filter(AA.visible).filter((b) => !b.disabled);

    // 2. TÌM THEO VỊ TRÍ KẾ BÊN NÚT 'x1' (Đặc trưng duy nhất của thanh điều khiển Google Flow)
    // Cấu trúc thanh đáy: [ + ] [ Tác nhân ] [ Video - 720p - 8s ] [ x1 ] [ → ]
    const x1Btn = localBtns.find((b) => /^(x\d+|\d+x)$/i.test((b.innerText || "").trim()));
    if (x1Btn && x1Btn.parentElement) {
      const barBtns = [...x1Btn.parentElement.querySelectorAll("button, [role='button']")].filter(AA.visible).filter((b) => !b.disabled);
      const xIdx = barBtns.indexOf(x1Btn);
      if (xIdx >= 0 && xIdx < barBtns.length - 1) {
        return barBtns[xIdx + 1]; // Nút ngay bên phải x1 chính là nút mũi tên →
      }
    }

    // 3. LỌC BỎ CÁC NÚT KHÔNG PHẢI SUBMIT
    const candidates = localBtns.filter((b) => {
      const txt = (b.innerText || "").trim().toLowerCase();
      const aria = (b.getAttribute("aria-label") || b.title || "").toLowerCase();
      // Bỏ nút đóng (x)
      if (/close|đóng|✕|×/i.test(aria) || /close|đóng|✕|×/i.test(txt)) return false;
      // Bỏ nút '+'
      if (txt === "+" || /thêm|add/i.test(aria)) return false;
      // Bỏ nút 'Tác nhân'
      if (/tác nhân|actor|character|agent/i.test(txt)) return false;
      // Bỏ nút thông số video (720p, 8s, 10s...)
      if (/720p|1080p|giây|\b\d+s\b/i.test(txt)) return false;
      // Bỏ nút x1
      if (/^x\d+$/i.test(txt)) return false;
      return true;
    });

    // 3.1: Ưu tiên nút có SVG mũi tên hoặc chứa nhãn generate/tạo/gửi/submit/→
    const arrowOrSubmit = candidates.find((b) => {
      const txt = (b.innerText || "").trim();
      const aria = (b.getAttribute("aria-label") || b.title || "").toLowerCase();
      if (txt === "→" || /tạo|generate|submit|send|gửi/i.test(aria)) return true;
      const svg = b.querySelector("svg");
      if (svg) {
        const path = (svg.innerHTML || "").toLowerCase();
        if (/arrow|forward|send|m12|m5|polygon/i.test(path)) return true;
      }
      return false;
    });
    if (arrowOrSubmit) return arrowOrSubmit;

    // 3.2: Lấy nút có tọa độ (left + top) lớn nhất trong container (nút ở góc DƯỚI - PHẢI)
    if (candidates.length > 0) {
      candidates.sort((a, b) => {
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        return (rb.left + rb.top) - (ra.left + ra.top);
      });
      return candidates[0];
    }

    // 4. Fallback toàn trang: tìm nút ở góc dưới bên phải
    const allBtns = [...document.querySelectorAll("button, [role='button']")].filter(AA.visible).filter((b) => !b.disabled);
    const bottomCandidates = allBtns.filter((b) => b.getBoundingClientRect().top > window.innerHeight * 0.4);
    if (bottomCandidates.length > 0) {
      bottomCandidates.sort((a, b) => {
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        return (rb.left + rb.top) - (ra.left + ra.top);
      });
      return bottomCandidates[0];
    }

    return null;
  }

  /** Thu thập toàn bộ địa chỉ video và link tải ĐANG CÓ trên trang trước khi bấm tạo */
  function collectAllMediaUrls() {
    const urls = new Set();
    // 1. Toàn bộ thẻ video và source
    for (const v of document.querySelectorAll("video")) {
      if (v.currentSrc) urls.add(v.currentSrc);
      if (v.src) urls.add(v.src);
      for (const s of v.querySelectorAll("source")) {
        if (s.src) urls.add(s.src);
      }
    }
    // 2. Toàn bộ link tải hoặc link video có sẵn
    for (const a of document.querySelectorAll("a[href]")) {
      const h = a.href;
      if (!h) continue;
      if (
        a.hasAttribute("download") ||
        /\.(mp4|webm|mov)(\?|$)/i.test(h) ||
        /googlevideo\.com|storage\.googleapis\.com|videofx|blob:/i.test(h)
      ) {
        urls.add(h);
      }
    }
    // 3. Toàn bộ tài nguyên mạng hiện tại
    try {
      const entries = performance.getEntriesByType("resource");
      for (const e of entries) {
        if (e.name) urls.add(e.name);
      }
    } catch {}
    return urls;
  }

  /** Tắt hoặc bỏ chọn 'Tác nhân' (Agent / Co-pilot chat) để tạo video trực tiếp trên canvas */
  async function disableActorOrIngredient() {
    // 1. Nếu sidebar phiên tác nhân ("Phiên không có tiêu đề" / Agent Chat) đang mở, đóng nó ngay
    const agentHeader = [...document.querySelectorAll("h1, h2, h3, h4, span, div")].find((el) =>
      AA.visible(el) && /phiên không có tiêu đề|untitled session/i.test(el.innerText || "")
    );
    if (agentHeader) {
      const panel = agentHeader.closest("aside, [role='complementary'], div") || agentHeader.parentElement?.parentElement;
      if (panel) {
        const closeBtn = [...panel.querySelectorAll("button, [role='button']")].find((b) => AA.visible(b) && (isCloseButton(b) || (b.querySelector("svg") && !b.innerText.trim() && b.getBoundingClientRect().top < 120)));
        if (closeBtn) {
          fullClick(closeBtn);
          await AA.sleep(500);
        }
      }
    }

    // 2. Tìm các nút xóa chip tác nhân đang gắn trong thanh nhập (dấu × hoặc nút remove)
    const promptBar = document.querySelector("[class*='prompt' i], form, footer") || document.body;
    // Chỉ gỡ chip tác nhân bằng nút xóa/đóng đúng nhãn, và chỉ trong chip nhắc tới tác nhân (không đụng vào nút "Tác nhân" hay các nút khác)
    const chips = [...promptBar.querySelectorAll("[class*='chip' i], [class*='tag' i], [class*='token' i], [class*='pill' i]")].filter(AA.visible);
    for (const chip of chips) {
      if (!/tác nhân|character|actor|agent/i.test(chip.innerText || "")) continue;
      const remove = [...chip.querySelectorAll("button, [role='button']")].find((b) => AA.visible(b) && hasLabel(b, REMOVE_LABEL));
      if (remove) {
        try { fullClick(remove); } catch {}
      }
    }

    // 3. Tìm nút "Tác nhân" nếu đang ở trạng thái active / pressed / selected hoặc bất kỳ nút Tác nhân nào
    const actorBtns = [...document.querySelectorAll("button, [role='button'], [role='tab']")].filter((b) =>
      AA.visible(b) && /^(tác nhân|actor|character|characters|agent)$/i.test((b.innerText || b.getAttribute("aria-label") || "").trim())
    );

    for (const actorBtn of actorBtns) {
      const isSelected = actorBtn.getAttribute("aria-pressed") === "true" ||
                         actorBtn.getAttribute("aria-selected") === "true" ||
                         actorBtn.classList.contains("active") ||
                         actorBtn.classList.contains("selected") ||
                         actorBtn.getAttribute("data-state") === "on";
      if (isSelected) {
        fullClick(actorBtn);
        await AA.sleep(300);
      }
    }
  }

  /** Tìm nút '+' trên thanh prompt để đính kèm ảnh tham chiếu */
  function findPromptPlusButton(inp) {
    const promptContainer = inp?.closest("form, [class*='prompt' i], [class*='dialog' i], div") || document.body;
    const buttons = [...promptContainer.querySelectorAll("button, [role='button']")].filter(AA.visible);

    // 1. Tìm nút nằm ngay trước nút 'Tác nhân' (Actor)
    const actorBtn = buttons.find((b) =>
      /tác nhân|actor|character|agent/i.test((b.innerText || b.getAttribute("aria-label") || "").trim())
    );
    if (actorBtn && actorBtn.parentElement) {
      const parentBtns = [...actorBtn.parentElement.querySelectorAll("button, [role='button']")].filter(AA.visible);
      const aIdx = parentBtns.indexOf(actorBtn);
      if (aIdx > 0) {
        return parentBtns[aIdx - 1];
      }
    }

    // 2. Tìm nút có text là "+" hoặc aria-label chứa "Thêm"
    const plusBtn = buttons.find((b) => {
      const txt = (b.innerText || "").trim();
      const aria = (b.getAttribute("aria-label") || b.title || "").toLowerCase();
      return txt === "+" || /thêm|add/i.test(aria) || b.querySelector("svg path[d*='19 13'], svg path[d*='12 5'], svg polygon");
    });
    if (plusBtn) return plusBtn;

    return null;
  }

  /** Số ảnh/thẻ đính kèm đang nằm trong thanh prompt (để biết một cách đính kèm đã thành công chưa) */
  /** Khung ô prompt chứa cả ảnh đính kèm và nút gửi (trên Flow thật là div.base-prompt-box) */
  function promptBoxOf(inp) {
    let box = inp;
    for (let i = 0; box && i < 8; i++, box = box.parentElement) {
      if (box.querySelector?.("button[aria-label='Bắt đầu tạo'], button[aria-label='Start creating']")) return box;
    }
    return inp?.closest("[class*='prompt-box' i], form") || inp?.parentElement?.parentElement?.parentElement || document.body;
  }

  /** Ô prompt đang có trên trang. Flow VẼ LẠI ô prompt sau khi gắn ảnh: ô cũ bị gỡ khỏi trang, phải tìm lại. */
  const livePromptInput = (inp) => (inp && document.contains(inp) ? inp : findPromptInput());

  /** Số ảnh đính kèm trong khung prompt: mỗi ảnh là một <img> trong div.base-prompt-box (đã kiểm tra trên Flow thật). */
  /** Số ảnh đính kèm trong khung prompt. Flow thật: mỗi ảnh là một <flow-ingredient-chip>; lúc đang tải lên nó chưa có <img>. */
  function attachmentCount(inp) {
    const scope = promptBoxOf(livePromptInput(inp)); // trước đây tìm sai vùng nên luôn đếm được 0
    const chips = scope.querySelectorAll("flow-ingredient-chip");
    if (chips.length > 0) return chips.length;
    return [...scope.querySelectorAll("img")].filter((el) => AA.visible(el) && !el.closest("[role='dialog'], [role='menu']")).length;
  }

  /** Đính kèm ảnh tham chiếu (ảnh nhân vật / sản phẩm) trực tiếp vào thanh câu lệnh (prompt) */
  async function attachReferenceImages(ctx, { characterImageUrl, productImageUrl, referenceImages = [], strictReferences = false, inp }) {
    const rawImages = referenceImages.map((url, i) => ({ url, label: `ảnh phân cảnh ${i + 1}`, filename: `cine-reference-${i + 1}` }));
    if (characterImageUrl) rawImages.push({ url: characterImageUrl, label: "ảnh chân dung người review" });
    if (productImageUrl) rawImages.push({ url: productImageUrl, label: "ảnh sản phẩm tham chiếu" });

    // Lọc trùng lặp
    const images = [];
    const seen = new Set();
    for (const img of rawImages) {
      if (img.url && !seen.has(img.url)) {
        seen.add(img.url);
        images.push(img);
      }
    }

    if (images.length === 0) return;

    await ctx.say(`Đang gắn ${images.length} ảnh tham chiếu vào câu lệnh (prompt)…`);

    for (let idx = 0; idx < images.length; idx++) {
      const item = images[idx];
      // Mỗi ảnh gắn xong, Flow VẼ LẠI ô prompt: ô cũ bị gỡ khỏi trang. Phải lấy ô đang có, nếu không ảnh thứ hai
      // (thường là ảnh sản phẩm, gắn sau ảnh chân dung) bị đưa vào ô không còn trên trang và không được gắn.
      inp = livePromptInput(inp);
      try {
        await ctx.say(`Đang gắn ${item.label} (${idx + 1}/${images.length}) vào prompt…`);
        const imgData = await AA.send({ type: "getImageData", url: item.url });
        if (!imgData || !imgData.b64) {
          console.warn(`Không lấy được dữ liệu ảnh cho ${item.label}:`, imgData?.error);
          if (strictReferences) throw new Error("Không tải được ảnh phân cảnh");
          continue;
        }

        const bin = atob(imgData.b64);
        const len = bin.length;
        const u8 = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
          u8[i] = bin.charCodeAt(i);
        }
        const ext = imgData.mime === "image/jpeg" ? "jpg" : "png";
        const filename = item.filename ? `${item.filename}.${ext}` : item.label.includes("người") ? `reviewer-portrait.${ext}` : `product-reference.${ext}`;
        const file = new File([u8], filename, { type: imgData.mime || "image/png" });

        // Thử lần lượt từng cách và DỪNG khi ảnh đã vào thanh prompt (trước đây chạy cả 3 cách nên ảnh bị đính kèm trùng)
        const attachedBefore = attachmentCount(inp);
        const attached = () => attachmentCount(inp) > attachedBefore;

        // PHƯƠNG THỨC 1: BẤM NÚT '+' TRÊN THANH PROMPT ĐỂ MỞ MENU / HỘP THOẠI ĐÍNH KÈM ẢNH
        const plusBtn = findPromptPlusButton(inp);
        if (plusBtn) {
          fullClick(plusBtn);
          await AA.sleep(600);

          // 1.1 Tìm tùy chọn 'Tải lên' (Upload) trong menu vừa bật ra nếu có
          const menuItems = [...document.querySelectorAll("[role='menuitem'], button, [role='option'], span, div")].filter(AA.visible);
          const uploadOpt = menuItems.find((m) => {
            const t = (m.innerText || m.getAttribute("aria-label") || "").toLowerCase().trim();
            return /^(tải lên|upload|tải ảnh lên|chọn tệp|từ máy|device|computer|file)$/i.test(t) || /tải lên|upload/i.test(t);
          });
          if (uploadOpt) {
            fullClick(uploadOpt);
            await AA.sleep(400);
          }

          // 1.2 Gán file vào input[type='file'] vừa xuất hiện trong modal/menu
          const modalInputs = [...document.querySelectorAll("input[type='file']")];
          let uploadedViaInput = false;
          for (const fi of modalInputs) {
            try {
              const dt = new DataTransfer();
              dt.items.add(file);
              fi.files = dt.files;
              fi.dispatchEvent(new Event("input", { bubbles: true }));
              fi.dispatchEvent(new Event("change", { bubbles: true }));
              uploadedViaInput = true;
              break;
            } catch {}
          }
          await AA.sleep(1000);

          // 1.3 Nếu modal có hiển thị danh sách thẻ ảnh nguyên liệu (asset picker), bấm chọn ảnh vừa tải / ảnh có sẵn
          // Đã tải file lên thì KHÔNG bấm thẻ đầu tiên (có thể là ảnh khác trong thư viện)
          const assetCards = uploadedViaInput ? [] : [...document.querySelectorAll("[role='dialog'] [class*='card' i], [role='dialog'] [class*='item' i], [role='dialog'] img")].filter(AA.visible);
          if (assetCards.length > 0) {
            fullClick(assetCards[0]);
            await AA.sleep(400);
          }

          // 1.4 BẤM NÚT 'Thêm vào câu lệnh' (Add to prompt)
          const insertBtns = [...document.querySelectorAll("button, [role='button']")].filter(AA.visible);
          const insertBtn = insertBtns.find((b) => {
            const t = (b.innerText || b.getAttribute("aria-label") || "").toLowerCase().trim();
            return /thêm vào câu lệnh|add to prompt|chèn vào|thêm vào prompt|insert|áp dụng|chọn/i.test(t);
          });
          if (insertBtn) {
            fullClick(insertBtn);
            await AA.sleep(600);
          }
        }

        await closeAllModals();
        await AA.sleep(300);

        inp = livePromptInput(inp); // cách 1 có thể đã làm Flow vẽ lại ô prompt
        // PHƯƠNG THỨC 2: DÁN (PASTE) TRỰC TIẾP VÀO Ô PROMPT (Cách thông dụng nhất trên Google AI)
        if (inp && !attached()) {
          try {
            inp.focus();
            const dt = new DataTransfer();
            dt.items.add(file);
            const pasteEvt = new ClipboardEvent("paste", {
              bubbles: true,
              cancelable: true,
              clipboardData: dt,
            });
            inp.dispatchEvent(pasteEvt);
            await AA.sleep(600);
          } catch {}
        }

        // PHƯƠNG THỨC 3: KÉO THẢ (DRAG & DROP) VÀO KHUNG NHẬP PROMPT
        if (!attached()) try {
          const dropTarget = inp?.closest("form, [class*='prompt' i]") || inp || document.body;
          const dt = new DataTransfer();
          dt.items.add(file);
          dropTarget.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: dt }));
          dropTarget.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
          dropTarget.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
          await AA.sleep(600);
        } catch {}

        await closeAllModals();
        await AA.sleep(500);

        if (attached()) await ctx.say(`Đã gắn ${item.label} vào câu lệnh.`);
        else if (strictReferences) throw new Error(`Không xác nhận được ${item.label} đã đính kèm. Hãy kiểm tra Flow và thử lại.`);
        else await ctx.say(`Không xác nhận được ${item.label} đã đính kèm, vẫn tiếp tục tạo video.`);
      } catch (err) {
        if (strictReferences) throw err;
        console.warn(`Lỗi nạp ${item.label}:`, err);
      }
    }
    // Đảm bảo đóng tất cả modal sau khi nạp xong toàn bộ ảnh
    await closeAllModals();
  }

  const promptText = (el) => (el.value || el.innerText || el.textContent || "").trim();
  /** Thẻ ẢNH (vd ảnh tham chiếu vừa tải lên, cũng hiện %): không phải video */
  const isImageTile = (card) => {
    const icons = [...card.querySelectorAll("mat-icon")].map((i) => (i.textContent || "").trim());
    return !card.querySelector("flow-video-hotbar") && !icons.includes("play_circle") && (icons.includes("image") || /product-reference|reviewer-portrait|\.(png|jpe?g|webp)\b/i.test(card.innerText || ""));
  };
  // Chỉ tính thẻ VIDEO đang tạo: ảnh tham chiếu đang tải lên cũng hiện "46%" (đã thấy trên Flow thật) và từng bị tính nhầm
  const anyCardGenerating = () => getAllCanvasCards().some((c) => isCardGenerating(c) && !isImageTile(c));

  /** Flow đã nhận prompt khi ô nhập đã trống/đổi nội dung, hoặc đã có thẻ đang tạo */
  function submitRegistered(inp, prompt) {
    // Đọc ô ĐANG có trên trang: nếu đọc ô cũ (đã bị gỡ sau khi gắn ảnh) sẽ luôn thấy prompt còn nguyên
    // và tưởng chưa gửi, rồi bấm gửi thêm lần nữa (thêm video, tốn tín dụng).
    const live = livePromptInput(inp);
    const cur = live ? promptText(live) : "";
    const head = String(prompt).trim().slice(0, 20);
    return cur.length < 10 || !cur.includes(head) || anyCardGenerating();
  }

  /** Kiểm tra byte đầu: MP4/MOV có "ftyp" ở byte 4-7, WebM bắt đầu bằng 1A 45 DF A3. Tối thiểu 50KB. */
  async function looksLikeVideo(blob) {
    if (!blob || blob.size < 50_000) return false;
    const u8 = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
    const ftyp = u8[4] === 0x66 && u8[5] === 0x74 && u8[6] === 0x79 && u8[7] === 0x70;
    const webm = u8[0] === 0x1a && u8[1] === 0x45 && u8[2] === 0xdf && u8[3] === 0xa3;
    return ftyp || webm;
  }

  function fullClick(el) {
    if (!el) return;
    try {
      el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, composed: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
      el.click();
    } catch {}
  }

  function clickAt(x, y) {
    if (x <= 0 || y <= 0 || x >= window.innerWidth || y >= window.innerHeight) return null;
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    const opts = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      view: window,
    };
    try {
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new MouseEvent("mousedown", opts));
      el.dispatchEvent(new PointerEvent("pointerup", opts));
      el.dispatchEvent(new MouseEvent("mouseup", opts));
      el.click();
    } catch {}
    return el;
  }

  function simulateHover(el) {
    if (!el) return;
    try {
      el.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true }));
      el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
      el.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
      el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      el.dispatchEvent(new PointerEvent("pointermove", { bubbles: true }));
      el.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    } catch {}
  }

  function pressSpace(target) {
    const el = target || document.activeElement || document.body;
    try {
      const opts = { key: " ", code: "Space", keyCode: 32, which: 32, bubbles: true, cancelable: true };
      el.dispatchEvent(new KeyboardEvent("keydown", opts));
      el.dispatchEvent(new KeyboardEvent("keypress", opts));
      el.dispatchEvent(new KeyboardEvent("keyup", opts));
    } catch {}
  }

  function pressEnter(target) {
    const el = target || document.activeElement || document.body;
    try {
      const opts = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
      el.dispatchEvent(new KeyboardEvent("keydown", opts));
      el.dispatchEvent(new KeyboardEvent("keypress", opts));
      el.dispatchEvent(new KeyboardEvent("keyup", opts));
    } catch {}
  }

  function findCardContainer(el) {
    if (!el) return null;
    let cur = el;
    for (let i = 0; cur && i < 10; i++, cur = cur.parentElement) {
      if (!cur || cur === document.body) break;
      const r = cur.getBoundingClientRect();
      if (r.width >= 120 && r.height >= 80 && r.width < window.innerWidth * 0.9 && r.height < window.innerHeight * 0.9) {
        if (cur.querySelector("img, canvas, video, svg")) {
          return cur;
        }
      }
    }
    return el;
  }

  function isSampleOrTutorial(el) {
    if (!el) return false;
    // Chỉ xét cấu trúc (class/id/data-testid), KHÔNG xét chữ hiển thị: danh sách chữ cũ có "giày đá bóng", "demo", "intro"...
    // nên video sản phẩm thật của người dùng (vd "Giày đá bóng Vapor 16") bị coi là video mẫu và không bao giờ được nhận.
    // Video mẫu có sẵn trong dự án đã bị loại nhờ so sánh với thời điểm trước khi bấm tạo.
    let cur = el;
    for (let i = 0; cur && i < 6; i++, cur = cur.parentElement) {
      const parentTxt = [typeof cur.className === "string" ? cur.className : "", cur.id, cur.getAttribute?.("data-testid")].filter(Boolean).join(" ").toLowerCase();
      if (/tutorial|sample|template|intro|example|demo|guide|welcome|featured|onboarding/i.test(parentTxt)) {
        return true;
      }
    }
    return false;
  }

  let lastCapturedBlob = null;
  let lastCapturedAt = 0;
  // Blob video do trang Flow tạo ra (từ content/flow-main.js chạy trong world MAIN)
  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || e.data.__aa !== "flow-blob" || !(e.data.blob instanceof Blob)) return;
    lastCapturedBlob = e.data.blob;
    lastCapturedAt = Date.now();
  });
  let lastTriggeredDownloadUrl = null;

  function isDemoVideoUrl(url) {
    if (!url || typeof url !== "string") return false;
    // Chỉ xét các đoạn đường dẫn ngắn: mã video ngẫu nhiên dài có thể tình cờ chứa "tea", "demo"... và bị loại nhầm
    try {
      return new URL(url).pathname.split("/").some((seg) => seg.length < 30 && /sample|intro|tutorial|demo|onboarding|welcome|template/i.test(seg));
    } catch {
      return false;
    }
  }

  /** Kiểm tra một URL có thực sự là tệp video hợp lệ không (loại bỏ tuyệt đối các API, RPC, webpage) */
  function isValidVideoSource(url) {
    if (!url || typeof url !== "string") return false;
    const clean = url.trim().toLowerCase();
    if (clean.length < 5) return false;
    if (clean.startsWith("javascript:") || clean.startsWith("#") || clean.startsWith("mailto:") || clean.startsWith("about:")) return false;
    // Bỏ qua các URL trang web, router path hoặc API endpoints
    if (/(\/api\/|_service|_rpc|batchexecute|\/projects?\/|\/session|\/auth\/|\/log|\/telemetry|\/event)/i.test(clean)) return false;
    if (isDemoVideoUrl(clean)) return false;

    // 1. Blob URL
    if (clean.startsWith("blob:")) return true;

    // 2. Video file extension trực tiếp (.mp4, .webm, .mov)
    if (/\.(mp4|webm|mov)(\?|$)/i.test(clean)) return true;

    // 3. Known video CDNs
    // Flow phát/tải video từ flow-content.google/video/<id>?... (đọc từ Flow thật). Thiếu dòng này thì video đang phát ở trình
    // chỉnh sửa vẫn bị loại và tiện ích chờ mãi dù video đã xong.
    if (/^https:\/\/([a-z0-9-]+\.)?flow-content\.google\/video\//i.test(clean)) return true;
    if (/googlevideo\.com/i.test(clean)) return true;
    if (/storage\.googleapis\.com/i.test(clean) && !/\.(jpg|jpeg|png|webp|gif|svg|ico|json|css|js|html|txt)(\?|$)/i.test(clean)) return true;
    if (/googleusercontent\.com/i.test(clean) && (/(=m\d+|video|videofx|media)/i.test(clean) || /\.(mp4|webm)(\?|$)/i.test(clean))) {
      if (!/\.(jpg|jpeg|png|webp|gif|svg|ico|json|css|js|html)(\?|$)/i.test(clean)) return true;
    }

    return false;
  }

  // Hook HTMLAnchorElement.prototype.click và window.open để bắt link download động được tạo ngầm bằng script
  try {
    const origAnchorClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      const href = this.href || this.getAttribute("href");
      if (isValidVideoSource(href)) {
        lastTriggeredDownloadUrl = href;
        if (href.startsWith("blob:")) {
          fetch(href)
            .then((r) => r.blob())
            .then((b) => {
              if (b && b.size > 1000) lastCapturedBlob = b;
            })
            .catch(() => {});
        }
      }
      return origAnchorClick.apply(this, arguments);
    };
  } catch {}

  try {
    const origWindowOpen = window.open;
    window.open = function (url) {
      if (isValidVideoSource(url)) {
        lastTriggeredDownloadUrl = url;
      }
      return origWindowOpen.apply(this, arguments);
    };
  } catch {}

  window.addEventListener(
    "click",
    (e) => {
      const a = e.target && e.target.closest ? e.target.closest("a") : null;
      if (a && a.href && isValidVideoSource(a.href)) {
        lastTriggeredDownloadUrl = a.href;
      }
    },
    true
  );

  /** Xác định xem một phần tử Card có phải là Card Video không (có nút Play ▶, thời lượng 10s hoặc thẻ video) */
  function isVideoCard(card) {
    if (!card) return false;
    if (isSampleOrTutorial(card)) return false;
    const txt = (card.innerText || card.getAttribute("aria-label") || "").toLowerCase();
    // Loại trừ các thẻ ảnh mẫu tham chiếu
    if (txt.includes("product-reference") || txt.includes("reviewer-portrait")) return false;
    if (card.querySelector("video")) return true;
    // Giao diện Flow thật: thẻ video có <flow-video-hotbar> và biểu tượng play_circle; thẻ ảnh (ảnh tham chiếu) thì không
    if (card.querySelector("flow-video-hotbar") || [...card.querySelectorAll("mat-icon")].some((i) => /^(play_circle|videocam|movie)$/i.test((i.textContent || "").trim()))) return true;

    // 1. Thẻ video thường có nhãn thời lượng (ví dụ: 10s, 8s, 0:10...)
    if (/\b(10s|8s|5s|6s|7s|9s|12s|15s|0:0[5-9]|0:[1-5]\d)\b/i.test(txt)) {
      return true;
    }

    // 2. Kiểm tra icon hoặc nút Play (Material Symbols play_arrow, SVG path hoặc aria-label)
    const hasPlay = [...card.querySelectorAll("button, [role='button'], div, span, svg, path")].some((el) => {
      const aria = [el.getAttribute("aria-label"), el.title, el.className, el.innerText].filter(Boolean).join(" ").toLowerCase();
      if (/play|phát|preview|play_arrow|xem trước/i.test(aria)) return true;
      if (el.tagName && el.tagName.toLowerCase() === "path") {
        const d = el.getAttribute("d") || "";
        if (/M8\s*5|M8\s*6|v14l11|v12l10|16\s*9|8\s*5v14/i.test(d)) return true;
      }
      if (el.querySelector && el.querySelector("polygon, path[d*='M8 5'], path[d*='v14']")) return true;
      return false;
    });
    if (hasPlay) return true;

    // Không còn nhánh "thẻ có ảnh là video": nó khiến ảnh tham chiếu hoặc thẻ cũ bị coi là video mới.
    return false;
  }

  /** Dấu vết ổn định của một thẻ (không phụ thuộc vị trí, vì thẻ mới đẩy các thẻ cũ đi chỗ khác) */
  function cardSignature(card) {
    const media = card.querySelector("video, img, source");
    const src = media ? media.currentSrc || media.src || media.getAttribute("src") || "" : "";
    const id = card.getAttribute("data-node-id") || card.getAttribute("data-id") || card.getAttribute("data-testid") || (card.tagName.toLowerCase() === "flow-grid-tile-container" && src ? card.getAttribute("aria-label") || "" : "");
    return `${id}|${src.slice(0, 200)}|${id || src ? "" : (card.innerText || "").trim().slice(0, 40)}`;
  }

  /** Nguồn media của thẻ (video hoặc ảnh poster) */
  function cardMediaSrc(card) {
    const v = card.querySelector("video");
    return v ? v.currentSrc || v.src || v.querySelector("source")?.src || "" : "";
  }

  async function probeDuration(url) {
    if (!isValidVideoSource(url)) return null;
    return new Promise((resolve) => {
      const v = document.createElement("video");
      v.preload = "metadata";
      v.muted = true;
      v.src = url;
      const to = setTimeout(() => {
        try { v.src = ""; } catch {}
        resolve(null);
      }, 3500);
      v.onloadedmetadata = () => {
        clearTimeout(to);
        const d = Number(v.duration);
        try { v.src = ""; } catch {}
        if (isNaN(d) || !isFinite(d)) {
          resolve(null);
        } else {
          resolve(d);
        }
      };
      v.onerror = () => {
        clearTimeout(to);
        resolve(null);
      };
    });
  }

  /** Kiểm tra xem một Card có đang trong trạng thái render/tạo video không */
  function isCardGenerating(card) {
    if (!card) return false;
    // 1. Quét phần tử thanh tiến độ, spinner, loading, skeleton, shimmer
    const spin = card.querySelector("[role='progressbar'], [class*='progress' i], [class*='spin' i], [class*='loading' i], [class*='skeleton' i], [class*='shimmer' i]");
    if (spin && AA.visible(spin)) return true;

    // 2. Quét văn bản thể hiện tiến độ (14%, generating, visual...)
    const txt = (card.innerText || "").toLowerCase();
    // Dùng \s?% thay cho \b: sau dấu % không có ranh giới từ nên "34%" từng không bao giờ được nhận ra là đang tiến hành
    if (/\b\d{1,3}\s?%|generating|đang tạo|rendering|processing|đang xử lý/i.test(txt)) {
      return true;
    }

    return false;
  }

  /** Quét toàn bộ các Card trên Canvas Google Flow một cách toàn diện */
  function getAllCanvasCards() {
    // Flow thật: mỗi thẻ trong lưới là một <flow-grid-tile-container> (nhãn = tên video/tên file). Dùng đúng phần tử này.
    // Cách quét chung bên dưới từng gom cả khung cuộn chứa TOÀN BỘ lưới thành "một thẻ", nên chỉ cần một thẻ nào đó hiện "13%"
    // là cả lưới bị coi là "đang tạo".
    const tiles = [...document.querySelectorAll("flow-grid-tile-container")].filter(AA.visible);
    if (tiles.length > 0) return tiles;

    const cardSet = new Set();

    // 0. Chính xác: mỗi thẻ có <flow-video-hotbar> hoặc <flow-tile-hover-footer> (đọc từ trang Flow thật)
    for (const h of document.querySelectorAll("flow-video-hotbar, flow-tile-hover-footer")) {
      const c = h.closest(".container") || h.parentElement?.parentElement;
      if (c && AA.visible(c)) cardSet.add(c);
    }

    // 1. Theo các bộ chọn chuẩn của card/node trên canvas
    const standard = document.querySelectorAll(
      "[class*='card' i], [data-node-id], [class*='node' i], [data-testid*='card' i], [data-id], [role='gridcell'], [role='listitem'], [role='article'], [class*='item' i], [class*='tile' i], [class*='asset' i]"
    );
    for (const el of standard) {
      if (AA.visible(el) && !isSampleOrTutorial(el)) {
        const c = findCardContainer(el);
        if (c && AA.visible(c)) cardSet.add(c);
        else cardSet.add(el);
      }
    }

    // 2. Tìm theo phần tử hiển thị thời lượng (duration: 10s, 8s...) hoặc icon Play
    const durationEls = [...document.querySelectorAll("span, div, p, label")].filter((el) => {
      if (!AA.visible(el) || isSampleOrTutorial(el)) return false;
      const t = (el.innerText || "").trim();
      return /^\b(10s|8s|5s|6s|7s|9s|12s|15s|0:\d{2})\b$/i.test(t);
    });
    for (const el of durationEls) {
      const c = findCardContainer(el);
      if (c && AA.visible(c) && !isSampleOrTutorial(c)) {
        cardSet.add(c);
      }
    }

    // 3. Tìm theo các phần tử có kích thước thẻ card trực quan trên canvas
    const allDivs = document.querySelectorAll("div, section, article");
    for (const el of allDivs) {
      if (!AA.visible(el) || isSampleOrTutorial(el)) continue;
      if (el.closest("[role='dialog'], [role='menu'], header, nav, aside, footer")) continue;
      const r = el.getBoundingClientRect();
      if (r.width >= 120 && r.width <= 500 && r.height >= 100 && r.height <= 700) {
        if (el.querySelector("canvas, img, video, svg") && (el.innerText || "").length > 0) {
          if (!el.parentElement || !cardSet.has(el.parentElement)) {
            cardSet.add(el);
          }
        }
      }
    }

    return [...cardSet];
  }

  /** Tìm Card liên quan đến prompt trên canvas Google Flow */
  function findTargetCard(prompt, beforeSigs, productTitle, beforeUrls) {
    const allCards = getAllCanvasCards().filter((c) => !isSampleOrTutorial(c));

    // 1. ƯU TIÊN SỐ 1: Card MỚI TINH (dấu vết chưa có trước khi bấm tạo). So bằng dấu vết, không so phần tử DOM,
    // vì React vẽ lại phần tử và hai cách quét thẻ khác nhau từng khiến cả thẻ cũ bị coi là mới (tải nhầm video cũ).
    if (beforeSigs && beforeSigs.size > 0) {
      const brandNewCards = allCards.filter((c) => !beforeSigs.has(cardSignature(c)));
      if (brandNewCards.length > 0) {
        // Ưu tiên card đang tạo hoặc card video
        const rendering = brandNewCards.find((c) => isCardGenerating(c) && !isImageTile(c));
        if (rendering) return rendering;
        const video = brandNewCards.find((c) => isVideoCard(c));
        if (video) return video;
        // (không còn trả "thẻ mới đầu tiên bất kỳ": nó từng là thẻ ảnh tham chiếu hoặc phần tử giao diện)
      }
    }

    // 2. ƯU TIÊN SỐ 2: Card đang RENDER trên canvas (tiến độ %, spinner, VISUAL...)
    const activeGen = allCards.find((c) => isCardGenerating(c) && !isImageTile(c));
    if (activeGen) return activeGen;

    // (Đã bỏ cách tìm theo tên sản phẩm: dự án thường có nhiều video cùng sản phẩm, nó từng chọn nhầm video cũ.)

    // 4. Chỉ nhận thẻ video có nguồn video CHƯA từng thấy trước khi bấm tạo. Không còn đoán theo "thẻ ở góc trên trái":
    // cách đó từng chọn nhầm video cũ khi thẻ mới chưa kịp hiện.
    const fresh = allCards.filter((c) => {
      if (!isVideoCard(c) || isCardGenerating(c)) return false;
      const src = cardMediaSrc(c);
      return !!src && !(beforeUrls && beforeUrls.has(src));
    });
    if (fresh.length === 1) return fresh[0];

    return null;
  }

  function extractVideoFromDom(beforeUrls) {
    // 1. Quét thẻ <video> (TUYỆT ĐỐI BỎ QUA video nằm trong thư viện thành phần)
    for (const v of document.querySelectorAll("video")) {
      if (v.closest("[class*='picker' i], [class*='library' i]")) {
        continue;
      }
      if (isSampleOrTutorial(v)) continue;
      const s = v.currentSrc || v.src || v.querySelector("source")?.src;
      if (s && !beforeUrls.has(s) && isValidVideoSource(s)) {
        return s;
      }
    }
    // 2. Quét thẻ <a> có link tải video thật
    const dlLinks = [...document.querySelectorAll("a[download], a[href*='.mp4'], a[href*='googlevideo'], a[href*='storage.googleapis.com'], a[href*='videofx']")];
    for (let i = dlLinks.length - 1; i >= 0; i--) {
      const a = dlLinks[i];
      if (isSampleOrTutorial(a)) continue;
      if (a.href && !beforeUrls.has(a.href) && isValidVideoSource(a.href)) return a.href;
    }
    return null;
  }

  function tryReturnToCanvas() {
    const doneBtn = [...document.querySelectorAll("button, [role='button']")].find((b) =>
      AA.visible(b) && /^(xong|done|back|quay lại|hoàn tất)$/i.test((b.innerText || b.getAttribute("aria-label") || "").trim())
    );
    if (doneBtn) {
      fullClick(doneBtn);
      return true;
    }
    const backBtn = document.querySelector("button[aria-label*='back' i], button[aria-label*='quay lại' i], header button:first-child");
    if (backBtn && AA.visible(backBtn)) {
      fullClick(backBtn);
      return true;
    }
    return false;
  }

  /** Địa chỉ video đang nằm trong trình phát/chỉnh sửa (bỏ video đã thấy trước khi bấm tạo) */
  function playerVideoSrc(beforeUrls) {
    return [...document.querySelectorAll("video")]
      .filter((v) => AA.visible(v) && !isSampleOrTutorial(v))
      .map((v) => v.currentSrc || v.src || v.querySelector("source")?.src || "")
      .find((u) => u && !(beforeUrls && beforeUrls.has(u)) && isValidVideoSource(u));
  }

  /** Mở thẻ video để xem (Flow chuyển sang trang /edit/ có <video>). Bấm một lần vào biểu tượng play hoặc ảnh thẻ. */
  function openCard(card) {
    const icon = [...card.querySelectorAll("mat-icon")].find((i) => /^play_circle$/i.test((i.textContent || "").trim()));
    const target = icon?.closest("div") || icon || card.querySelector("img, .img") || card;
    fullClick(target);
  }

  /**
   * Đóng mọi menu đang mở mà không bấm vào mục nào. Trên Flow, phím Escape gửi vào document KHÔNG đóng được menu
   * (đã thử trên trang thật); bấm vào lớp nền (.cdk-overlay-backdrop) thì đóng được.
   */
  async function closeMenus() {
    for (let i = 0; i < 3; i++) {
      if (![...document.querySelectorAll(".cdk-overlay-pane")].some(AA.visible)) return;
      const backdrops = [...document.querySelectorAll(".cdk-overlay-backdrop")];
      if (backdrops.length) backdrops[backdrops.length - 1].click();
      else {
        const panel = document.querySelector(".cdk-overlay-pane [role='menu'], .cdk-overlay-pane .mat-mdc-menu-panel") || document.activeElement || document;
        panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true }));
      }
      await AA.sleep(350);
    }
  }

  /**
   * Tải video về bằng chính menu của thẻ: "Tuỳ chọn khác" → "Tải xuống" → "720p Kích thước gốc".
   * (Đã kiểm tra trên Flow thật: bấm mục này khiến trang tải file từ flow-content.google, tạo Blob video/mp4 rồi bấm thẻ <a download>;
   * script content/flow-main.js bắt Blob đó.) Trả về true nếu đã bấm được mục tải.
   * KHÔNG bao giờ chọn 1080p/4K ("Đã tăng độ phân giải": có thể tốn tín dụng) hay "Nâng cấp", và KHÔNG mở thẻ/trình chỉnh sửa.
   */
  async function downloadViaMenu(card) {
    await closeMenus(); // còn menu mở từ trước thì bấm "Tuỳ chọn khác" sẽ ĐÓNG menu thay vì mở
    simulateHover(card);
    await AA.sleep(200);
    // Nút này chỉ hiện khi chuột THẬT rê vào thẻ (CSS :hover), rê chuột giả không làm nó hiện.
    // Vì vậy không lọc theo "đang hiện": nút vẫn nằm trong trang và bấm được (đã thử trên Flow thật).
    const more = [...card.querySelectorAll("button, [role='button']")].find((el) => !el.disabled && /tu[ỳy] chọn khác|more options/i.test(el.getAttribute("aria-label") || ""));
    if (!more) return false;
    fullClick(more);
    await AA.sleep(1000);

    const dl = overlayItems().find((el) => /^(tải xuống|download)/i.test(cleanText(el)));
    if (!dl) {
      await closeMenus();
      return false;
    }
    simulateHover(dl);
    await AA.sleep(800);
    let q = pickQuality();
    if (!q) {
      fullClick(dl);
      await AA.sleep(900);
      q = pickQuality();
    }
    if (!q) {
      await closeMenus();
      return false;
    }
    fullClick(q);
    await AA.sleep(600);
    await closeMenus(); // không để menu mở lại trên trang
    return true;
  }

  const overlayItems = () => [...document.querySelectorAll(".cdk-overlay-container button, .cdk-overlay-container [role='menuitem']")].filter(AA.visible);
  /** Mục "720p Kích thước gốc" trong menu độ phân giải. Không bao giờ chọn bản "Đã tăng độ phân giải" (1080p/4K) hay "Nâng cấp". */
  function pickQuality() {
    const items = overlayItems();
    return (
      items.find((el) => !el.disabled && /^720p\b/i.test(cleanText(el))) ||
      items.find((el) => !el.disabled && /kích thước gốc|original size/i.test(cleanText(el)) && !/nâng cấp|upgrade|tăng độ phân giải|upscal/i.test(cleanText(el)))
    );
  }

  /**
   * Ở trình chỉnh sửa (/edit/): nút "Tải nội dung nghe nhìn xuống" → "720p Kích thước gốc".
   * Đã kiểm tra trên Flow thật: trang tạo Blob video/mp4 (~2,4 MB) gần như ngay lập tức.
   * Trả về "clicked", hoặc "unavailable" nếu nút chưa có/đang khoá (video còn đang tạo).
   */
  async function editorDownload() {
    await closeMenus();
    const btn = [...document.querySelectorAll("button, [role='button']")].find((b) => /tải nội dung nghe nhìn xuống|download media/i.test(b.getAttribute("aria-label") || ""));
    if (!btn || btn.disabled) return "unavailable";
    fullClick(btn);
    await AA.sleep(900);
    const q = pickQuality();
    if (!q) {
      await closeMenus();
      return "unavailable";
    }
    fullClick(q);
    await AA.sleep(600);
    await closeMenus();
    return "clicked";
  }

  /** Tự động mở dự án đầu tiên hoặc bấm Tạo dự án mới */
  function tryOpenFirstProject() {
    dismissOverlays();

    // 1. Tìm các link dự án trực tiếp (href chứa /project/ hoặc /p/)
    const projectLinks = [
      ...document.querySelectorAll("a[href*='/project/'], a[href*='/projects/'], a[href*='/flow/project/'], a[href*='/p/']")
    ].filter(AA.visible);

    if (projectLinks.length > 0) {
      projectLinks[0].click();
      return true;
    }

    // 2. Tìm thẻ dự án dạng card / item trong giao diện
    const projectCards = [
      ...document.querySelectorAll(
        "[data-project-id], [data-testid*='project' i], [class*='project-card' i], [class*='projectCard' i], [class*='ProjectCard' i], [role='button'][aria-label*='project' i], [role='link'][aria-label*='project' i]"
      )
    ].filter(AA.visible);

    if (projectCards.length > 0) {
      projectCards[0].click();
      return true;
    }

    // 3. Tìm các card trong grid/list dự án gần đây (Recent projects / Projects)
    const recentHeading = [...document.querySelectorAll("h1, h2, h3, h4, span, div")].find((el) =>
      AA.visible(el) && /recent projects|dự án gần đây|my projects|dự án của tôi|all projects/i.test(el.innerText || "")
    );
    if (recentHeading) {
      const container = recentHeading.closest("section") || recentHeading.closest("div") || document.body;
      const candidate = [...container.querySelectorAll("a, [role='button'], div[tabindex='0']")].find((el) =>
        AA.visible(el) && el !== recentHeading && !/new project|create project|tạo dự án|dự án mới/i.test(el.innerText || "")
      );
      if (candidate) {
        candidate.click();
        return true;
      }
    }

    // 4. Nếu không có dự án cũ nào, bấm nút "New project" / "Tạo dự án mới" để vào workspace
    const newProjBtn = [...document.querySelectorAll("button, a, [role='button']")].find((el) => {
      if (!AA.visible(el)) return false;
      const txt = [el.innerText, el.getAttribute("aria-label"), el.title].filter(Boolean).join(" ").trim();
      return /new project|create project|dự án mới|tạo dự án|start a new project|\+ new|\+ tạo/i.test(txt);
    });
    if (newProjBtn) {
      newProjBtn.click();
      return true;
    }

    return false;
  }

  async function ensureReady(ctx) {
    await AA.sleep(2000);
    dismissOverlays();

    let inp = findPromptInput();
    if (inp) return inp;

    // Chưa thấy ô nhập: tự động mở dự án đầu tiên
    await ctx.say("Đang tự động mở dự án đầu tiên trên Google Flow…");
    const opened = tryOpenFirstProject();
    if (opened) {
      await AA.sleep(3000);
      dismissOverlays();
      inp = findPromptInput();
      if (inp) return inp;
    }

    // Kiểm tra xem trang có yêu cầu đăng nhập không
    const loginBtn = [...document.querySelectorAll("a, button")].find((el) =>
      AA.visible(el) && /^(sign in|log in|đăng nhập)$/i.test((el.innerText || "").trim())
    );
    if (loginBtn) {
      await ctx.needUser("Hãy đăng nhập Google Flow trong tab này. Tiện ích sẽ chạy tiếp khi bạn xong.");
    }

    // Vòng lặp chờ vào workspace, cứ mỗi 3s thử mở dự án nếu vẫn ở trang danh sách
    let attempts = 0;
    const ok = await AA.waitFor(
      async () => {
        dismissOverlays();
        const found = findPromptInput();
        if (found) return found;

        attempts++;
        if (attempts % 2 === 0) {
          tryOpenFirstProject();
        }
        return null;
      },
      {
        timeoutMs: 10 * 60_000,
        stepMs: 2500,
        onTick: () => ctx.beat("Đang tự động mở dự án trên Google Flow…", "running"),
      }
    );

    if (!ok) throw new Error("Không thể mở dự án hoặc tìm thấy ô nhập prompt trên Google Flow");
    return ok;
  }

  async function setPrompt(el, val) {
    if (!el) return false;
    el.focus();
    fullClick(el);
    await AA.sleep(200);

    // 1. Textarea hoặc Input thông thường
    if (el.tagName.toLowerCase() === "textarea" || el.tagName.toLowerCase() === "input") {
      try {
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value").set.call(el, val);
      } catch {
        el.value = val;
      }
    }

    // 2. Contenteditable (rich-textarea trong Google Flow)
    try {
      document.execCommand("selectAll", false, null);
      document.execCommand("delete", false, null);
      document.execCommand("insertText", false, val);
    } catch {}

    // 3. Fallback textContent
    const cur = (el.value || el.innerText || el.textContent || "").trim();
    if (!cur.includes(val.slice(0, 20))) {
      if ("value" in el) {
        el.value = val;
      } else {
        el.innerText = val;
        el.textContent = val;
      }
    }

    // 4. Bắn sự kiện input
    try {
      el.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, composed: true, data: val, inputType: "insertText" }));
      el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, data: val, inputType: "insertText" }));
      el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    } catch {}

    await AA.sleep(300);

    // 5. Thử ClipboardEvent paste nếu độ dài chưa đạt
    const checkText = (el.value || el.innerText || el.textContent || "").trim();
    if (checkText.length < 10) {
      try {
        const dt = new DataTransfer();
        dt.setData("text/plain", val);
        el.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt }));
      } catch {}
    }

    return true;
  }

  /**
   * Chờ video mới xong rồi lấy file, KHÔNG gửi lại prompt. Cách lấy file (đều đã thử trên Flow thật, ra Blob video/mp4):
   *  1-2. Menu của thẻ mới: "Tuỳ chọn khác" → "Tải xuống" → "720p Kích thước gốc".
   *  3-4. Nếu chưa có: mở thẻ sang trình chỉnh sửa, bấm "Tải nội dung nghe nhìn xuống" → 720p.
   * File được bắt ngay khi trang tạo Blob (content/flow-main.js) hoặc qua sự kiện tải của Chrome. Mỗi lần thử cách nhau 20 giây.
   * (Trình chỉnh sửa vẽ video lên <canvas>, không có thẻ <video> để đọc.)
   */
  async function waitForVideo(ctx, { prompt, productTitle, beforeUrls, beforeSigs, submitTime, minWaitMs = 25_000, timeoutMs = 8 * 60_000 }) {
    let src = null;
    let attempts = 0;
    let lastAttempt = 0;
    let lastBack = 0;
    await ctx.say("Đang chờ Google Flow tạo video (khoảng 1-3 phút)…");

    const done = await AA.waitFor(
      async () => {
        await guard(ctx); // hết credit / bị từ chối / lỗi
        if (Date.now() - submitTime < minWaitMs) return false;

        // 1. File video do trang tạo ra sau lúc bấm tạo (bắt bởi content/flow-main.js)
        if (lastCapturedBlob && lastCapturedAt >= submitTime - 5000) {
          if (await looksLikeVideo(lastCapturedBlob)) {
            src = "captured-blob";
            return true;
          }
          lastCapturedBlob = null;
        }
        // 2. Sự kiện tải của Chrome: blob: lấy ngay trong tab (blob chưa bị thu hồi), https: để trình nền tải
        const fromBg = await AA.send({ type: "getCapturedVideo", since: submitTime - 5000 }).catch(() => null);
        if (fromBg?.url && !beforeUrls.has(fromBg.url)) {
          if (/^blob:/i.test(fromBg.url)) {
            try {
              const res = await fetch(fromBg.url);
              const blob = res.ok ? await res.blob() : null;
              if (blob && (await looksLikeVideo(blob))) {
                lastCapturedBlob = blob;
                lastCapturedAt = Date.now();
                src = "captured-blob";
                return true;
              }
            } catch {
              /* blob đã bị thu hồi */
            }
          } else if (/^https:\/\//i.test(fromBg.url) && isValidVideoSource(fromBg.url)) {
            src = fromBg.url;
            return true;
          }
        }

        // Đợi kết quả của lần bấm trước (thực tế file có trong chưa tới 1 giây)
        if (Date.now() - lastAttempt < 20_000) return false;

        // 3. Đang ở trình chỉnh sửa: dùng nút tải của trình chỉnh sửa
        if (/\/edit\//.test(location.pathname)) {
          const r = await editorDownload();
          if (r === "clicked") {
            attempts++;
            lastAttempt = Date.now();
            await ctx.say(`Đang tải video từ trình chỉnh sửa (lần ${attempts}/4)…`);
          } else if (Date.now() - lastBack > 10_000) {
            lastBack = Date.now();
            tryReturnToCanvas();
          }
          if (attempts >= 4 && Date.now() - lastAttempt >= 20_000) throw new Error("Video đã xong nhưng bấm tải 4 lần không nhận được file. Hãy tải thủ công trên Flow rồi tải lên Kho.");
          return false;
        }

        // 4. Ở canvas: thẻ mới, đã xong (không còn %)
        const card = findTargetCard(prompt, beforeSigs, productTitle, beforeUrls);
        if (!card || isCardGenerating(card)) return false;
        if (attempts >= 4) throw new Error("Video đã xong nhưng bấm tải 4 lần không nhận được file. Hãy tải thủ công trên Flow rồi tải lên Kho.");
        attempts++;
        lastAttempt = Date.now();
        if (attempts <= 2) {
          await ctx.say(`Video đã tạo xong, đang tải về (lần ${attempts}/4)…`);
          if (!(await downloadViaMenu(card))) lastAttempt = Date.now() - 12_000; // không mở được menu: thử lại sớm
        } else {
          await ctx.say(`Đang mở video để tải từ trình chỉnh sửa (lần ${attempts}/4)…`);
          attempts--; // lần đếm thật nằm ở bước bấm tải trong trình chỉnh sửa
          openCard(card);
          lastAttempt = Date.now() - 14_000;
        }
        return false;
      },
      {
        timeoutMs,
        stepMs: 2500,
        onTick: () => ctx.beat(`Đang chờ Google Flow tạo video (${Math.round((Date.now() - submitTime) / 1000)}s)…`, "running"),
      },
    );

    if (!done || !src) {
      const cards = getAllCanvasCards();
      const diag = `thẻ: ${cards.length}, đang tạo: ${cards.filter(isCardGenerating).length}, đã bấm tải: ${attempts} lần, trang: ${/\/edit\//.test(location.pathname) ? "trình chỉnh sửa" : "dự án"}`;
      throw new Error(`Google Flow không trả về video sau ${Math.round(timeoutMs / 60_000)} phút (${diag}). Có thể hết credit, prompt bị từ chối, hoặc video xong nhưng không lấy được file.`);
    }
    return src;
  }

  const flowSettingLabel = el => [el.innerText || el.textContent, el.getAttribute("aria-label"), el.getAttribute("title")].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  const flowTenSeconds = text => /(?:^|[^\d])10\s*(?:seconds?|secs?|s|giây)(?=$|[\s·•,;()\-/])/i.test(text);
  const flowSelected = el => el.getAttribute("aria-selected") === "true" || el.getAttribute("aria-checked") === "true" || el.getAttribute("aria-pressed") === "true" || ["checked", "on"].includes(el.getAttribute("data-state")) || el.checked === true;
  function flowGenerationControls() {
    return [...document.querySelectorAll("button,[role='button'],[role='option'],[role='radio'],[role='menuitem'],[role='combobox'],[role='switch'],[role='checkbox'],select")].filter(el => {
      if (!AA.visible(el) || el.disabled || el.getAttribute("aria-disabled") === "true") return false;
      if (el.closest("flow-grid-tile-container,flow-ingredient-chip")) return false;
      // This is the gallery gear menu from the reported screenshot, not generation settings.
      const menu = el.closest("[role='menu'],[role='dialog'],[role='listbox']");
      if (menu && /view mode|chế độ xem/i.test(menu.innerText || menu.textContent || "") && /grid size|kích thước lưới/i.test(menu.innerText || menu.textContent || "")) return false;
      return !/âm thanh khi di chuột|trả về video không có âm thanh|hover audio|return.*without.*audio|grid size|kích thước lưới|chế độ xem/i.test(flowSettingLabel(el));
    });
  }
  function flowVideoSettingsTrigger() {
    const input = findPromptInput();
    const candidates = flowGenerationControls().filter(el => {
      if (el.tagName === "BUTTON" && el.type === "submit" && el.form) return false;
      if (el.closest("[role='menu'],[role='listbox']") || ["option", "radio", "menuitem", "switch", "checkbox"].includes(el.getAttribute("role"))) return false;
      const text = flowSettingLabel(el);
      // Never use the generic settings/tune gear: Flow uses it for gallery preferences.
      return /\bvideo\b.*(?:\d{3,4}p|\d+\s*(?:s\b|giây))|\b(?:veo|omni)\b|video settings|generation settings|prompt settings|cài đặt (?:video|tạo video|câu lệnh)/i.test(text);
    });
    if (input) {
      const rect = input.getBoundingClientRect();
      candidates.sort((a,b) => {
        const ar=a.getBoundingClientRect(), br=b.getBoundingClientRect();
        return Math.abs(ar.top-rect.bottom)-Math.abs(br.top-rect.bottom);
      });
    }
    return candidates[0] || null;
  }
  function flowDurationOption(el) {
    if (!flowTenSeconds(flowSettingLabel(el))) return false;
    return ["option","radio","menuitem"].includes(el.getAttribute("role")) || el.hasAttribute("aria-pressed") || (el.tagName === "BUTTON" && /^10\s*(?:seconds?|secs?|s|giây)$/i.test((el.innerText || el.textContent || "").trim()) && !el.hasAttribute("aria-haspopup"));
  }
  function flowDurationConfirmed() {
    return flowGenerationControls().some(el => {
      if (el.tagName === "SELECT") return [...el.selectedOptions].some(o => flowTenSeconds(o.textContent || o.value));
      if (!flowTenSeconds(flowSettingLabel(el))) return false;
      if (flowSelected(el)) return true;
      // Seeing an unselected "10s" option in an open list does not prove it is applied.
      if (el.closest("[role='menu'],[role='listbox'],[role='dialog']") || ["option", "radio", "menuitem"].includes(el.getAttribute("role"))) return false;
      return el.getAttribute("aria-haspopup") != null || el.getAttribute("role") === "combobox" || /\bvideo\b|\bveo\b|\bomni\b/i.test(flowSettingLabel(el));
    });
  }
  async function configureTurboFlow(ctx) {
    const click = async el => { if (el) { fullClick(el); await AA.sleep(450); } };
    // Dismiss an already-open gallery popover without changing its grid/audio preferences.
    const viewMenu = [...document.querySelectorAll("[role='menu'],[role='dialog']")].find(el => AA.visible(el) && /chế độ xem|view mode/i.test(el.textContent || "") && /kích thước lưới|grid size/i.test(el.textContent || ""));
    if (viewMenu) {
      const target = document.activeElement || document.body;
      target.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape",code:"Escape",bubbles:true}));
      target.dispatchEvent(new KeyboardEvent("keyup", {key:"Escape",code:"Escape",bubbles:true}));
      await AA.sleep(250);
    }
    for (let attempt=0; attempt<3 && !flowDurationConfirmed(); attempt++) {
      const trigger = flowVideoSettingsTrigger();
      if (!trigger) break;
      await click(trigger);
      let omni = flowGenerationControls().find(el => /\bomni\b/i.test(flowSettingLabel(el)) && ["option","radio","menuitem"].includes(el.getAttribute("role")));
      if (!omni) {
        const model = flowGenerationControls().find(el => /\bveo\b|model|mô hình/i.test(flowSettingLabel(el)) && !["option","radio","menuitem"].includes(el.getAttribute("role")));
        if (model && model !== trigger) await click(model);
        omni = flowGenerationControls().find(el => /\bomni\b/i.test(flowSettingLabel(el)) && ["option","radio","menuitem"].includes(el.getAttribute("role")));
      }
      if (omni && !flowSelected(omni)) await click(omni);
      const nativeDuration = flowGenerationControls().find(el => el.tagName === "SELECT" && [...el.options].some(o => flowTenSeconds(o.textContent || o.value)));
      if (nativeDuration) {
        const option=[...nativeDuration.options].find(o=>flowTenSeconds(o.textContent || o.value));
        nativeDuration.value=option.value;
        nativeDuration.dispatchEvent(new Event("input",{bubbles:true}));
        nativeDuration.dispatchEvent(new Event("change",{bubbles:true}));
        await AA.sleep(450);
      } else {
        let duration=flowGenerationControls().find(el=>flowDurationOption(el));
        if (!duration) {
          const durationMenu=flowGenerationControls().find(el=>/duration|thời lượng|^\s*[468]\s*(?:s|giây)\s*$/i.test(flowSettingLabel(el)) && !["option","radio","menuitem"].includes(el.getAttribute("role"))) || flowVideoSettingsTrigger();
          await click(durationMenu);
          duration=flowGenerationControls().find(el=>flowDurationOption(el));
        }
        if (duration && !flowSelected(duration)) await click(duration);
      }
    }
    if (!flowDurationConfirmed()) {
      const observed = flowVideoSettingsTrigger();
      const state = observed ? `Thiết lập đang thấy: ${flowSettingLabel(observed).slice(0,160)}.` : "Không tìm thấy thanh cài đặt tạo video cạnh ô prompt.";
      await ctx.needUser(`Turbo: ${state} Mở cài đặt VIDEO cạnh ô nhập prompt (không phải bánh răng Chế độ xem góc trên), chọn Gemini Omni và 10s. Veo 3.1 với 3 ảnh chỉ hỗ trợ 8s. Extension sẽ tiếp tục khi xác nhận được 10s.`);
      const ready=await AA.waitFor(flowDurationConfirmed,{timeoutMs:180000,stepMs:1500,onTick:()=>ctx.beat("Chờ chọn Gemini Omni · 10s tại thanh tạo video cạnh ô prompt", "needs_user")});
      if (!ready) throw new Error(`Chưa xác nhận được clip 10 giây. ${state} Chọn Gemini Omni · 10s ở thanh tạo video, rồi chạy tiếp Turbo.`);
    }
    const audioOff=flowGenerationControls().find(el=> /^(?:audio|generate audio|âm thanh|tạo âm thanh)(?:\s|$)/i.test(flowSettingLabel(el)) && ["switch","checkbox"].includes(el.getAttribute("role")) && !flowSelected(el));
    if (audioOff) await click(audioOff);
    await closeAllModals();
  }

  /** Chuẩn bị (prompt, ảnh tham chiếu) và gửi ĐÚNG MỘT lần. Trả về mốc trước/sau để nhận ra video mới. */
  async function prepareAndSubmit(ctx) {
    const { prompt, aspect, characterImageUrl, productImageUrl, productTitle, sceneOrder, referenceImages, strictReferences } = ctx.job.payload;
    const titleLabel = productTitle ? `cho "${productTitle}"` : (sceneOrder !== undefined ? `cho cảnh ${sceneOrder}` : "");
    await ctx.say(`Bắt đầu chuẩn bị video ${titleLabel} trên Google Flow…`);
    await ensureReady(ctx);
    await guard(ctx);

    // Đảm bảo đóng hết modal trước khi chuẩn bị
    await closeAllModals();
    dismissOverlays();

    // Nếu có tùy chọn chuyển tab sang chế độ Video (Text-to-Video)
    const videoTab = [...document.querySelectorAll("[role='tab'], [role='radio'], button")].find((b) =>
      AA.visible(b) && /^(video|text to video|t2v)$/i.test((b.innerText || b.getAttribute("aria-label") || "").trim())
    );
    if (videoTab && videoTab.getAttribute("aria-selected") !== "true" && videoTab.getAttribute("aria-checked") !== "true") {
      videoTab.click();
      await AA.sleep(600);
    }

    if (ctx.job.payload.autoConfigure) await configureTurboFlow(ctx);

    // Chọn tỷ lệ khung hình nếu có
    if (aspect) {
      const aspectBtns = [...document.querySelectorAll("button, [role='radio'], [role='option'], [role='tab']")].filter(AA.visible);
      const targetAspect = aspectBtns.find((b) => {
        const txt = [b.innerText, b.getAttribute("aria-label"), b.getAttribute("title")].filter(Boolean).join(" ");
        return txt.includes(aspect) || (aspect === "16:9" && /landscape|ngang/i.test(txt)) || (aspect === "9:16" && /portrait|dọc/i.test(txt));
      });
      if (targetAspect && !targetAspect.getAttribute("aria-checked") && !targetAspect.getAttribute("aria-selected")) {
        targetAspect.click();
        await AA.sleep(400);
      }
    }

    // 1. BẮT BUỘC: LUÔN TẮT TÁC NHÂN (AGENT) ĐỂ TẠO VIDEO TRỰC TIẾP TRÊN CANVAS, KHÔNG NHẢY VÀO PHIÊN CHAT
    await ctx.say("Đang tắt tác nhân (Agent) và đóng phiên chat…");
    await disableActorOrIngredient();
    await AA.sleep(500);

    // 2. Tìm ô nhập prompt sau khi tắt tác nhân
    let inp = findPromptInput();
    if (!inp) throw new Error("Không tìm thấy ô nhập prompt 'Bạn muốn tạo gì?' trên Google Flow");

    // 3. Nhập nội dung câu lệnh (prompt) vào ô
    await ctx.say(`Đang nhập prompt cho ${productTitle || "video"}…`);
    await setPrompt(inp, prompt);
    await AA.sleep(500);

    // KIỂM TRA BẮT BUỘC: ĐẢM BẢO PROMPT ĐÃ ĐƯỢC NHẬP THẬT SỰ
    let entered = (inp.value || inp.innerText || inp.textContent || "").trim();
    if (entered.length < 10) {
      inp.focus();
      fullClick(inp);
      await AA.sleep(200);
      await setPrompt(inp, prompt);
      await AA.sleep(400);
      entered = (inp.value || inp.innerText || inp.textContent || "").trim();
    }

    if (entered.length < 10) {
      throw new Error("Không thể nhập nội dung vào ô prompt 'Bạn muốn tạo gì?'. Vui lòng kiểm tra tab Google Flow.");
    }

    // 4. ĐÍNH KÈM ẢNH THAM CHIẾU (ẢNH SẢN PHẨM / NHÂN VẬT) TRỰC TIẾP VÀO THANH PROMPT ĐANG MỞ
    if (characterImageUrl || productImageUrl || referenceImages?.length) {
      await attachReferenceImages(ctx, { characterImageUrl, productImageUrl, referenceImages, strictReferences, inp });
      // Flow vẽ lại ô prompt sau khi gắn ảnh (đã thấy trên trang thật): lấy lại ô mới, kiểm tra prompt còn nguyên
      inp = livePromptInput(inp);
      if (!inp) throw new Error("Mất ô nhập prompt sau khi gắn ảnh tham chiếu. Kiểm tra tab Google Flow.");
      if (!promptText(inp).includes(String(prompt).trim().slice(0, 20))) {
        await setPrompt(inp, prompt);
        await AA.sleep(400);
        if (!promptText(inp).includes(String(prompt).trim().slice(0, 20))) throw new Error("Prompt bị xoá sau khi gắn ảnh tham chiếu và không nhập lại được. Kiểm tra tab Google Flow.");
      }
      await AA.sleep(800);
    }

    // Lưu danh sách thẻ và video TRƯỚC KHI BẤM NÚT TẠO
    // (Bất kỳ thẻ nào xuất hiện sau thời điểm này đều là thẻ video mới tạo)
    await AA.send({ type: "clearCapturedVideo" }).catch(() => {});
    lastCapturedBlob = null; // chỉ nhận blob phát sinh SAU lúc bấm tạo, không dùng blob cũ còn sót
    lastCapturedAt = 0;
    const beforeUrls = collectAllMediaUrls();
    // Chụp dấu vết bằng CÙNG hàm quét mà bước tìm thẻ dùng, để so sánh trước/sau nhất quán
    const beforeSigs = new Set(getAllCanvasCards().map(cardSignature));

    await ctx.say("Đang bấm nút gửi tạo video trên Google Flow (mũi tên →)…");
    const submit = findSubmitButton(inp);
    if (!submit) {
      throw new Error("Không tìm thấy nút gửi tạo video (mũi tên →) trên Google Flow");
    }

    // Bấm gửi ĐÚNG MỘT lần. Trước đây bấm tới 3 lần liên tiếp rồi bấm lại trong vòng chờ, có thể sinh nhiều video và tốn tín dụng.
    // Chỉ bấm lại khi chắc chắn Flow chưa nhận (prompt vẫn còn nguyên trong ô và chưa có thẻ nào đang tạo), tối đa 2 lần thử lại.
    fullClick(submit);
    let registered = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      await AA.sleep(2200);
      await guard(ctx);
      if (submitRegistered(inp, prompt)) {
        registered = true;
        break;
      }
      if (attempt < 2) {
        const again = findSubmitButton(inp);
        if (again) fullClick(again);
      }
    }
    if (!registered) throw new Error("Đã bấm gửi nhưng Google Flow không nhận prompt (nút gửi bị khóa hoặc giao diện đã đổi). Kiểm tra tab Flow.");

    // Kiểm tra ngay sau khi gửi xem có bị chặn vì hết tín dụng không
    await guard(ctx);

    return { beforeUrls, beforeSigs, submitTime: Date.now() };
  }

  async function createFlowVideo(ctx) {
    const { prompt, sceneOrder, productTitle } = ctx.job.payload;
    const resume = (await ctx.getState()) ?? {};
    let beforeUrls;
    let beforeSigs;
    let submitTime;
    if (resume.phase === "submitted") {
      // Trang vừa tải lại sau khi ĐÃ gửi: tuyệt đối không gửi lại (sẽ sinh video thứ hai), chỉ chờ kết quả
      beforeUrls = new Set(resume.beforeUrls ?? []);
      beforeSigs = new Set(resume.beforeSigs ?? []);
      submitTime = resume.submitTime ?? Date.now();
      await ctx.say("Tiếp tục chờ video đã gửi trước đó…");
    } else {
      ({ beforeUrls, beforeSigs, submitTime } = await prepareAndSubmit(ctx));
      await ctx.setState({ phase: "submitted", submitTime, beforeUrls: [...beforeUrls].slice(-600), beforeSigs: [...beforeSigs] });
    }
    const src = await waitForVideo(ctx, { prompt, productTitle, beforeUrls, beforeSigs, submitTime });
    await AA.sleep(2000);

    const name = `flow-scene-${sceneOrder ?? "video"}`;
    await ctx.say("Đang chuẩn bị tải file video Google Flow…");

    // Ưu tiên cao nhất: Nếu đã bắt được Blob trực tiếp từ hook download/player trong tab
    let blobData = lastCapturedBlob && lastCapturedBlob.size > 1000 && lastCapturedAt >= submitTime - 5000 ? lastCapturedBlob : null;

    // Chiến lược 1: Thử lấy blob ngay trong tab (blob:, data: hoặc http/https có cookie đăng nhập)
    if (!blobData && src) {
      try {
        if (src.startsWith("blob:") || src.startsWith("data:")) {
          const res = await fetch(src);
          if (res.ok) {
            const b = await res.blob();
            if (b && b.size > 1000) blobData = b;
          }
        } else {
          let res = await fetch(src, { credentials: "omit" }).catch(() => null);
          if (!res || !res.ok) {
            res = await fetch(src).catch(() => null);
          }
          if (res && res.ok) {
            const b = await res.blob();
            if (b && b.size > 1000) blobData = b;
          }
        }
      } catch (e) {
        console.debug("Direct tab fetch error on Flow:", e);
      }
    }

    // Chỉ nhận dữ liệu thật sự là video: tránh gửi trang HTML lỗi, ảnh xem trước hay phản hồi API lên web
    if (blobData && !(await looksLikeVideo(blobData))) {
      console.debug("Dữ liệu bắt được không phải video, bỏ qua", blobData.type, blobData.size);
      blobData = null;
    }

    if (blobData) {
      await ctx.say("Đang gửi video từ Google Flow về web…");
      const b64 = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(",")[1]);
        r.onerror = () => reject(new Error("Không đọc được video từ Google Flow"));
        r.readAsDataURL(blobData);
      });
      const mime = blobData.type && blobData.type.startsWith("video/") ? blobData.type : "video/mp4";
      const saved = await AA.send({ type: "upload", jobId: ctx.job.id, name: `${name}.mp4`, mime, b64 });
      return { assetId: saved.assetId, sceneOrder };
    }

    // Chiến lược 2: Nhờ background service worker tải (chỉ làm được với địa chỉ https; blob:/MediaSource thì không)
    if (!/^https:\/\//i.test(src)) {
      throw new Error(`Đã thấy video nhưng ở dạng "${src.split(":")[0]}:" nên không đọc được từ trình nền. Hãy bấm "Tải xuống" thủ công trên Flow rồi tải video lên Kho. (Gửi cho người hỗ trợ ảnh cấu trúc trang để làm cách tải tự động.)`);
    }
    await ctx.say("Đang tải file video Google Flow về qua trình nền…");
    const saved = await AA.send({ type: "fetchUpload", jobId: ctx.job.id, url: src, name: `${name}.mp4`, mime: "video/mp4" });
    return { assetId: saved.assetId, sceneOrder };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "run" || msg.job?.kind !== "google_flow_video") return false;
    sendResponse({ ok: true });
    if (window.__aaJob === msg.job.id) return false;
    window.__aaJob = msg.job.id;
    const ctx = AA.context(msg.job);
    (async () => {
      try {
        const result = await createFlowVideo(ctx);
        await AA.send({ type: "done", jobId: msg.job.id, result });
      } catch (e) {
        if (e instanceof AA.Cancelled) return AA.send({ type: "fail", jobId: msg.job.id, error: "Đã hủy" }).catch(() => {});
        await AA.send({ type: "fail", jobId: msg.job.id, error: e.message }).catch(() => {});
      }
    })();
    return false;
  });

  // Chỉ để kiểm thử bằng Node (trong trình duyệt không có `module`)
  if (typeof module !== "undefined") {
    module.exports = { flowVideoSettingsTrigger, flowDurationConfirmed, configureTurboFlow, isImageTile, promptBoxOf, livePromptInput, attachReferenceImages, setPrompt, waitForVideo, editorDownload, capturedBlob: () => lastCapturedBlob, playerVideoSrc, openCard, tryReturnToCanvas, downloadViaMenu, cleanText, submitRegistered, attachmentCount, closeAllModals, disableActorOrIngredient, findPromptInput, findSubmitButton, getAllCanvasCards, cardSignature, findTargetCard, isVideoCard, isCardGenerating, looksLikeVideo, isValidVideoSource };
  }
})();
