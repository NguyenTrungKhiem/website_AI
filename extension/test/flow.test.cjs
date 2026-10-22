// Kiểm thử logic tìm phần tử của content/flow.js trên trang GIẢ LẬP (jsdom, dựng theo mô tả trong mã).
// Không thay thế việc thử trên Google Flow thật. Chạy: cd extension/test && npm install && npm test
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const ROOT = require("node:path").join(__dirname, "..", "content") + "/";

function setup(html) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, { pretendToBeVisual: true, url: "https://flow.google.com/project/1" });
  const { window } = dom;
  // jsdom không có bố cục: giả lập kích thước, đọc vị trí từ thuộc tính data-r="left,top,width,height"
  Object.defineProperty(window.HTMLElement.prototype, "offsetWidth", { get() { return this.hasAttribute("data-hidden") ? 0 : (this.__r()[2]); } });
  Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return this.hasAttribute("data-hidden") ? 0 : (this.__r()[3]); } });
  // jsdom không có innerText: dùng textContent (đủ cho các ca thử)
  Object.defineProperty(window.HTMLElement.prototype, "innerText", { get() { return this.textContent; }, set(v) { this.textContent = v; } });
  window.HTMLElement.prototype.__r = function () { return (this.getAttribute("data-r") || "0,0,40,30").split(",").map(Number); };
  window.HTMLElement.prototype.getBoundingClientRect = function () { const [l, t, w, h] = this.__r(); return { left: l, top: t, width: w, height: h, right: l + w, bottom: t + h, x: l, y: t }; };
  Object.defineProperty(window, "innerWidth", { value: 1400 });
  Object.defineProperty(window, "innerHeight", { value: 900 });
  for (const k of ["window", "document", "HTMLElement", "HTMLAnchorElement", "HTMLTextAreaElement", "HTMLInputElement", "KeyboardEvent", "MouseEvent", "PointerEvent", "InputEvent", "ClipboardEvent", "DragEvent", "Event", "DataTransfer", "File", "getComputedStyle", "Node"]) {
    if (window[k] !== undefined) Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true });
  }
  globalThis.PointerEvent = window.PointerEvent ?? window.MouseEvent;
  globalThis.DragEvent = window.DragEvent ?? window.MouseEvent;
  globalThis.chrome = { runtime: { onMessage: { addListener() {} }, sendMessage: async () => ({}) } };
  for (const m of ["../content/common.js", "../content/flow.js"]) delete require.cache[require.resolve(ROOT + m.replace("../content/", ""))];
  window.__aaFlow = undefined;
  globalThis.AA = require(ROOT + "common.js").AA;
  return { window, flow: require(ROOT + "flow.js") };
}
let failed = 0;
const t = (name, fn) => { try { fn(); console.log("ok   ", name); } catch (e) { failed++; console.log("SAI  ", name, "\n     ", e.message.split("\n")[0]); } };

// ---- 1. Thanh prompt + nút gửi ----
{
  const { window, flow } = setup(`
    <div data-r="100,780,1200,90" class="prompt-bar">
      <textarea data-r="120,790,700,40" placeholder="Bạn muốn tạo gì?"></textarea>
      <div data-r="120,835,800,30" class="row">
        <button data-r="120,835,30,30" aria-label="Thêm">+</button>
        <button data-r="160,835,80,30">Tác nhân</button>
        <button data-r="250,835,150,30">Video - 720p - 8s</button>
        <button data-r="410,835,30,30">x1</button>
        <button data-r="450,835,30,30" id="submit">→</button>
      </div>
    </div>
    <input data-r="20,20,200,30" placeholder="Tìm kiếm" />`);
  t("tìm ô prompt 'Bạn muốn tạo gì?' (không nhầm ô Tìm kiếm)", () => {
    const inp = flow.findPromptInput();
    assert.equal(inp.getAttribute("placeholder"), "Bạn muốn tạo gì?");
  });
  t("nút gửi là nút ngay bên phải 'x1'", () => {
    const inp = flow.findPromptInput();
    assert.equal(flow.findSubmitButton(inp).id, "submit");
  });
}

// ---- 2. Đóng modal: chỉ bấm nút đóng đúng nhãn, KHÔNG bấm Export/Next/Xuất ----
{
  const { window, flow } = setup(`
    <div role="dialog" data-r="300,200,600,400">
      <button id="export" data-r="310,210,80,30">Export</button>
      <button id="next" data-r="400,210,80,30">Next</button>
      <button id="xuat" data-r="490,210,80,30">Xuất bản</button>
      <button id="close" aria-label="Close" data-r="860,210,30,30">×</button>
    </div>`);
  const clicked = [];
  for (const b of window.document.querySelectorAll("button")) b.addEventListener("click", () => clicked.push(b.id));
  t("closeAllModals chỉ bấm nút đóng", () => {
    return flow.closeAllModals().then(() => assert.deepEqual(clicked, ["close"], `đã bấm: ${clicked.join(",")}`)).catch((e) => { failed++; console.log("SAI   closeAllModals:", e.message); });
  });
}

// ---- 3. Tắt tác nhân: không bấm vào x1, nút gửi, "Tác nhân" khi chưa bật ----
{
  const { window, flow } = setup(`
    <div class="prompt-bar" data-r="100,780,1200,90">
      <textarea data-r="120,790,700,40" placeholder="Bạn muốn tạo gì?"></textarea>
      <button id="plus" data-r="120,835,30,30" aria-label="Thêm">+</button>
      <button id="actor" data-r="160,835,80,30" aria-pressed="false">Tác nhân</button>
      <button id="res" data-r="250,835,150,30">Video - 720p - 8s</button>
      <button id="x1" data-r="410,835,30,30">x1</button>
      <button id="send" data-r="450,835,30,30">→</button>
    </div>`);
  const clicked = [];
  for (const b of window.document.querySelectorAll("button")) b.addEventListener("click", () => clicked.push(b.id));
  t("disableActor không bấm nút nào khi tác nhân đang tắt", () => {
    return flow.disableActorOrIngredient().then(() => assert.deepEqual(clicked, [], `đã bấm: ${clicked.join(",")}`)).catch((e) => { failed++; console.log("SAI   disableActor (tắt):", e.message); });
  });
}
{
  const { window, flow } = setup(`
    <div class="prompt-bar" data-r="100,780,1200,90">
      <textarea data-r="120,790,700,40" placeholder="Bạn muốn tạo gì?"></textarea>
      <button id="actor" data-r="160,835,80,30" aria-pressed="true">Tác nhân</button>
      <button id="x1" data-r="410,835,30,30">x1</button>
      <button id="send" data-r="450,835,30,30">→</button>
    </div>`);
  const clicked = [];
  for (const b of window.document.querySelectorAll("button")) b.addEventListener("click", () => clicked.push(b.id));
  t("disableActor bấm đúng nút Tác nhân đang bật, không bấm x1/gửi", () => {
    return flow.disableActorOrIngredient().then(() => assert.deepEqual(clicked, ["actor"], `đã bấm: ${clicked.join(",")}`)).catch((e) => { failed++; console.log("SAI   disableActor (bật):", e.message); });
  });
}

// ---- 4. Nhận diện thẻ video mới, không chọn nhầm video cũ ----
{
  const card = (id, src, extra = "", r = "0,0,300,200") => `<div class="card" data-id="${id}" data-r="${r}">${src ? `<video src="${src}"></video>` : ""}<span>${extra}</span></div>`;
  const { window, flow } = setup(`<div id="canvas">${card("a", "https://x/old1.mp4", "10s", "20,100,300,200")}${card("b", "https://x/old2.mp4", "8s", "340,100,300,200")}</div>`);
  const doc = window.document;
  // video.src trong jsdom đã được set bằng thuộc tính
  const before = new Set(flow.getAllCanvasCards().map(flow.cardSignature));
  const beforeUrls = new Set(["https://x/old1.mp4", "https://x/old2.mp4"]);
  t("trước khi có thẻ mới: KHÔNG chọn video cũ", () => {
    const got = flow.findTargetCard("p", before, "", beforeUrls);
    assert.equal(got, null, "đã chọn thẻ " + got?.getAttribute("data-id"));
  });
  // thẻ mới đang tạo (đẩy các thẻ cũ sang phải: vị trí đổi nhưng dấu vết không đổi)
  doc.getElementById("canvas").innerHTML = card("n", "", "34%", "20,100,300,200") + card("a", "https://x/old1.mp4", "10s", "340,100,300,200") + card("b", "https://x/old2.mp4", "8s", "660,100,300,200");
  t("thẻ mới đang render được nhận ra dù thẻ cũ đổi chỗ", () => {
    const got = flow.findTargetCard("p", before, "", beforeUrls);
    assert.equal(got?.getAttribute("data-id"), "n");
    assert.ok(flow.isCardGenerating(got));
  });
  doc.getElementById("canvas").innerHTML = card("n", "https://x/new.mp4", "8s", "20,100,300,200") + card("a", "https://x/old1.mp4", "10s", "340,100,300,200") + card("b", "https://x/old2.mp4", "8s", "660,100,300,200");
  t("thẻ mới render xong được chọn (video mới, không phải cũ)", () => {
    const got = flow.findTargetCard("p", before, "", beforeUrls);
    assert.equal(got?.getAttribute("data-id"), "n");
    assert.ok(!flow.isCardGenerating(got));
  });
  // React vẽ lại: thẻ cũ là phần tử DOM khác hẳn nhưng cùng dấu vết
  doc.getElementById("canvas").innerHTML = card("a", "https://x/old1.mp4", "10s", "20,100,300,200") + card("b", "https://x/old2.mp4", "8s", "340,100,300,200");
  t("thẻ cũ bị vẽ lại thành phần tử mới vẫn KHÔNG bị coi là mới", () => {
    assert.equal(flow.findTargetCard("p", before, "", beforeUrls), null);
  });
}


// ---- 6. Xác nhận Flow đã nhận prompt (tránh bấm gửi nhiều lần) ----
{
  const PROMPT = "Một cô gái review tai nghe bluetooth trong phòng khách sáng";
  const { window, flow } = setup(`<div class="prompt-bar" data-r="100,780,1200,90"><textarea id="t" data-r="120,790,700,40" placeholder="Bạn muốn tạo gì?"></textarea></div><div id="canvas"></div>`);
  const ta = window.document.getElementById("t");
  ta.value = PROMPT;
  t("prompt còn nguyên và chưa có thẻ đang tạo => CHƯA nhận (được phép thử lại)", () => assert.equal(flow.submitRegistered(ta, PROMPT), false));
  ta.value = "";
  t("ô prompt đã trống => đã nhận", () => assert.equal(flow.submitRegistered(ta, PROMPT), true));
  ta.value = PROMPT;
  window.document.getElementById("canvas").innerHTML = '<div class="card" data-id="n" data-r="20,100,300,200"><span>12%</span></div>';
  t("prompt còn nhưng đã có thẻ đang tạo => đã nhận (KHÔNG bấm lại)", () => assert.equal(flow.submitRegistered(ta, PROMPT), true));
}


// ---- 7. DỰNG THEO TRANG FLOW THẬT (đọc từ tab Flow ngày 09/10/2026: thanh dưới, thẻ video, menu) ----
{
  const REAL_BAR = `
    <div class="bar" data-r="440,780,620,50">
      <div contenteditable="true" data-r="460,785,560,40"></div>
      <button data-r="459,789,32,32" aria-label="Thêm thành phần vào ô nhập câu lệnh">add</button>
      <button data-r="501,791,79,28">Tác nhân</button>
      <button data-r="839,789,164,32" aria-label="Điều kiện kích hoạt cài đặt">Video · 720p · 8 giây crop_9_16</button>
      <button id="go" data-r="1007,789,32,32" aria-label="Bắt đầu tạo">arrow_forward</button>
    </div>`;
  const videoTile = (id, poster, title, r) => `<div class="container" data-id="${id}" data-r="${r}"><img class="img" src="${poster}"><div><mat-icon role="img">play_circle</mat-icon></div><flow-video-hotbar data-r="256,84,157,36"><button aria-label="Yêu thích">favorite</button><button aria-label="Tuỳ chọn khác">more_vert</button></flow-video-hotbar><flow-tile-hover-footer><div role="button">play_circle ${title}</div></flow-tile-hover-footer></div>`;
  const imageTile = (r) => `<div class="container" data-id="ref" data-r="${r}"><img class="img" src="https://flow.google.com/asb/ref1"><span>product-reference.png</span></div>`;

  {
    const { flow } = setup(REAL_BAR);
    t("[Flow thật] nút gửi = nút 'Bắt đầu tạo' (không có x1)", () => {
      const inp = flow.findPromptInput();
      assert.equal(flow.findSubmitButton(inp).getAttribute("aria-label"), "Bắt đầu tạo");
    });
  }
  {
    const { window, flow } = setup(`<div id="c">${videoTile("v1", "https://flow.google.com/asb/p1", "Adjustable hand gripper", "248,76,173,308")}${imageTile("440,76,173,308")}</div>`);
    const [v, i] = window.document.querySelectorAll(".container");
    t("[Flow thật] thẻ video có hotbar/play_circle là video", () => assert.equal(flow.isVideoCard(v), true));
    t("[Flow thật] thẻ ảnh tham chiếu KHÔNG phải video (không bị tải nhầm như product-reference.png)", () => assert.equal(flow.isVideoCard(i), false));
    const before = new Set(flow.getAllCanvasCards().map(flow.cardSignature));
    t("[Flow thật] chưa có thẻ mới: không chọn video cũ hay ảnh tham chiếu", () => assert.equal(flow.findTargetCard("p", before, "", new Set()), null));
    window.document.getElementById("c").innerHTML = `<div class="container" data-id="gen" data-r="248,76,173,308"><span>39%</span><span>VISUAL</span></div>` + videoTile("v1", "https://flow.google.com/asb/p1", "Adjustable hand gripper", "440,76,173,308") + imageTile("632,76,173,308");
    t("[Flow thật] thẻ đang tạo (39%) được nhận ra là thẻ mục tiêu", () => assert.equal(flow.findTargetCard("p", before, "", new Set())?.getAttribute("data-id"), "gen"));
    window.document.getElementById("c").innerHTML = videoTile("new", "https://flow.google.com/asb/NEWPOSTER", "Kìm bóp tay quảng cáo", "248,76,173,308") + videoTile("v1", "https://flow.google.com/asb/p1", "Adjustable hand gripper", "440,76,173,308") + imageTile("632,76,173,308");
    t("[Flow thật] video mới xong được chọn, không chọn video cũ/ảnh", () => assert.equal(flow.findTargetCard("p", before, "", new Set())?.getAttribute("data-id"), "new"));
  }
  {
    const { window, flow } = setup(`<button id="a">download Tải xuống</button><button id="b">arrow_forward</button><button id="c">Video · 720p · 8 giây crop_9_16</button><button id="d">content_copy Sao chép</button>`);
    const txt = (id) => flow.cleanText(window.document.getElementById(id));
    t("[Flow thật] bỏ tên biểu tượng đứng đầu nhãn menu", () => {
      assert.equal(txt("a"), "Tải xuống");
      assert.ok(/^(tải xuống|download)/i.test(txt("a")));
      assert.equal(txt("d"), "Sao chép");
      assert.equal(txt("b"), "arrow_forward");
      assert.equal(txt("c"), "Video · 720p · 8 giây crop_9_16");
    });
  }
}


// ---- 8. Tải bằng menu thẻ: đúng chuỗi Tuỳ chọn khác → Tải xuống → 720p, KHÔNG mở thẻ, KHÔNG chọn 1080p/4K/Nâng cấp ----
{
  const { window, flow } = setup(`<div id="host"></div><div class="cdk-overlay-container" id="ov" data-r="0,0,1400,900"></div>
    <div class="container" id="card" data-id="v" data-r="248,76,173,308"><flow-video-hotbar data-r="256,84,157,36"><button id="fav" aria-label="Yêu thích" data-r="260,88,28,28">favorite</button><button id="more" aria-label="Tuỳ chọn khác" data-r="381,88,28,28">more_vert</button></flow-video-hotbar></div>`);
  const doc = window.document;
  const clicked = [];
  const mk = (id, text, extra = "") => `<button id="${id}" data-r="500,200,200,30" ${extra}>${text}</button>`;
  doc.getElementById("card").addEventListener("click", (e) => { if (e.target.id === "card") clicked.push("CARD(mở thẻ)"); });
  doc.getElementById("more").addEventListener("click", () => {
    doc.getElementById("ov").innerHTML = `<div class="cdk-overlay-pane" data-r="480,100,240,400">${mk("m-fav", "favorite Yêu thích")}${mk("m-dl", "download Tải xuống")}${mk("m-trash", "delete Chuyển vào thùng rác")}</div>`;
    for (const b of doc.querySelectorAll("#ov button")) b.addEventListener("click", () => clicked.push(b.id));
    doc.getElementById("m-dl").addEventListener("mouseenter", () => {
      doc.getElementById("ov").insertAdjacentHTML("beforeend", `<div class="cdk-overlay-pane" data-r="730,100,240,300">${mk("q-gif", "270p Ảnh GIF động")}${mk("q-720", "720p Kích thước gốc")}${mk("q-1080", "1080p Đã tăng độ phân giải")}${mk("q-4k", "4K Đã tăng độ phân giải", "disabled")}<a id="q-up" data-r="740,300,100,30" href="#">Nâng cấp</a></div>`);
      for (const b of doc.querySelectorAll("#ov .cdk-overlay-pane:last-child button")) b.addEventListener("click", () => clicked.push(b.id));
    });
  });
  const run = flow.downloadViaMenu(doc.getElementById("card"));
  t("[Flow thật] downloadViaMenu bấm đúng: Tuỳ chọn khác → Tải xuống → 720p, không đụng gì khác", () => {
    return run.then((ok) => {
      assert.equal(ok, true);
      const seq = clicked.join(">");
      assert.ok(seq.includes("q-720"), "phải bấm 720p: " + seq);
      assert.ok(!/q-1080|q-4k|q-gif|q-up|m-trash|m-fav|CARD/.test(seq), "bấm nhầm: " + seq);
    }).catch((e) => { failed++; console.log("SAI   downloadViaMenu:", e.message); });
  });
}


// ---- 9. Cấu trúc lưới & ô prompt của Flow thật (đọc ngày 09/10/2026): <flow-grid-tile-container>, <flow-ingredient-chip> ----
{
  const tile = (label, inner, r) => `<flow-grid-tile-container aria-label="${label}" data-r="${r}">${inner}</flow-grid-tile-container>`;
  const videoInner = (poster) => `<div class="container"><img src="${poster}"><mat-icon>play_circle</mat-icon><flow-video-hotbar><button aria-label="Tuỳ chọn khác">more_vert</button></flow-video-hotbar></div>`;
  const { window, flow } = setup(`
    <div class="cdk-virtual-scroll-viewport" data-r="0,0,1400,900"><div id="grid" data-r="0,0,1400,900">
      ${tile("Hand gripper adjusting", videoInner("https://flow.google.com/asb/A"), "20,80,170,300")}
      ${tile("product-reference.png", '<mat-icon>image</mat-icon><span>13%</span>', "200,80,170,300")}
      ${tile("Giày đá bóng Vapor 16 Elite", videoInner("https://flow.google.com/asb/B"), "380,80,170,300")}
    </div></div>
    <div class="base-prompt-box" data-r="300,700,700,150"><div><div><div class="prompt-input"><div contenteditable="true" data-r="320,760,600,30">abc</div></div></div></div>
      <flow-ingredient-chip data-r="320,710,50,50"><div class="flow-image-ingredient-chip"><button aria-label="Thành phần">cancel</button></div></flow-ingredient-chip>
      <button aria-label="Bắt đầu tạo" data-r="980,800,32,32">arrow_forward</button></div>`);
  const cards = flow.getAllCanvasCards();
  t("[Flow thật] chỉ lấy đúng các <flow-grid-tile-container>, không gom cả khung cuộn", () => assert.equal(cards.length, 3));
  t("[Flow thật] ảnh đang tải lên (13%) là thẻ ảnh, không phải video đang tạo", () => {
    const up = cards[1];
    assert.equal(flow.isImageTile(up), true);
    assert.equal(flow.isVideoCard(up), false);
  });
  t("[Flow thật] video 'Giày đá bóng' là video (không bị coi là mẫu)", () => assert.equal(flow.isVideoCard(cards[2]), true));
  t("[Flow thật] đếm ảnh đính kèm theo <flow-ingredient-chip> (kể cả lúc chưa có <img>)", () => {
    assert.equal(flow.attachmentCount(window.document.querySelector("[contenteditable]")), 1);
  });
}

// ---- 5. Nhận diện nguồn video / byte video ----
t("isValidVideoSource", () => {
  assert.ok(flow0().isValidVideoSource("https://storage.googleapis.com/bucket/abc.mp4?x=1"));
  assert.ok(flow0().isValidVideoSource("blob:https://flow.google.com/1234"));
  assert.ok(!flow0().isValidVideoSource("https://flow.google.com/api/trpc/video.list"));
  assert.ok(!flow0().isValidVideoSource("https://x/intro_tutorial.mp4"));
  assert.ok(!flow0().isValidVideoSource("https://storage.googleapis.com/bucket/poster.jpg"));
  // Địa chỉ video thật của Flow (đọc từ trang thật). Trước đây bị loại nên video đang phát vẫn không được nhận.
  assert.ok(flow0().isValidVideoSource("https://flow-content.google/video/AbC123xyz?Expires=1&Signature=abc"));
  assert.ok(!flow0().isValidVideoSource("https://flow-content.google/image/AbC123xyz"));
});
function flow0() { return setup("<div></div>").flow; }
(async () => {
  const f = flow0();
  const mk = (bytes, size = 60_000) => { const u = new Uint8Array(size); u.set(bytes); return new (require("node:buffer").Blob)([u]); };
  const ok = [
    ["mp4 (ftyp)", mk([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]), true],
    ["webm", mk([0x1a, 0x45, 0xdf, 0xa3]), true],
    ["trang HTML", mk([0x3c, 0x21, 0x64, 0x6f]), false],
    ["quá nhỏ", mk([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70], 1000), false],
  ];
  for (const [name, blob, want] of ok) {
    const got = await f.looksLikeVideo(blob);
    if (got === want) console.log("ok   ", "looksLikeVideo:", name); else { failed++; console.log("SAI  ", "looksLikeVideo:", name, got); }
  }
  console.log(failed ? `\n${failed} ca sai` : "\ntất cả ca đúng");
  process.exit(failed ? 1 : 0);
})();
