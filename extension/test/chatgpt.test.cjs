// Kiểm thử content/chatgpt.js trên trang GIẢ LẬP dựng theo cấu trúc chatgpt.com thật (quan sát 11/10/2026):
// ô nhập ProseMirror trong form[data-chatgpt-composer], nút "Send"/"Stop", ảnh trong [data-testid="generated-image-gallery"].
// Chạy: node chatgpt.test.cjs (npm test chạy cả file này)
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const ROOT = require("node:path").join(__dirname, "..", "content") + "/";

const PAGE = `
<main>
  <div id="thread"></div>
  <form data-chatgpt-composer="" data-composer-placement="home">
    <div contenteditable="true" role="textbox" class="ProseMirror" aria-label="Ask ChatGPT"></div>
    <button type="button" aria-label="Add files and more">+</button>
    <button type="button" aria-label="Select ChatGPT model">Medium</button>
    <button type="button" aria-label="Dictate">mic</button>
    <button type="button" aria-label="Start Voice" id="voice">voice</button>
  </form>
</main>`;

function setup({ oldImage = false } = {}) {
  const dom = new JSDOM(`<!doctype html><body>${PAGE}</body>`, { pretendToBeVisual: true, url: "https://chatgpt.com/" });
  const { window } = dom;
  // jsdom không có bố cục: mọi phần tử coi như hiện, trừ khi có data-hidden
  Object.defineProperty(window.HTMLElement.prototype, "offsetWidth", { get() { return this.hasAttribute("data-hidden") ? 0 : 40; } });
  Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return this.hasAttribute("data-hidden") ? 0 : 30; } });
  Object.defineProperty(window.HTMLElement.prototype, "innerText", { get() { return this.textContent; }, set(v) { this.textContent = v; } });
  Object.defineProperty(window.HTMLImageElement.prototype, "naturalWidth", { get() { return Number(this.getAttribute("data-w") || 0); } });
  for (const k of ["window", "document", "HTMLElement", "KeyboardEvent", "MouseEvent", "Event", "FileReader", "Blob", "getComputedStyle", "Node"]) {
    Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true });
  }
  const sent = [];
  globalThis.chrome = {
    runtime: {
      id: "test",
      onMessage: { addListener() {} },
      sendMessage: async (msg) => {
        sent.push(msg);
        return msg.type === "upload" ? { assetId: "asset-1" } : {};
      },
    },
  };
  // Ảnh tạo xong là blob: trong trang
  globalThis.fetch = async (url) => ({ ok: true, status: 200, blob: async () => new window.Blob([`png-of-${url}`], { type: "image/png" }) });
  for (const m of ["common.js", "chatgpt.js"]) delete require.cache[require.resolve(ROOT + m)];
  window.__aaChatgpt = undefined;
  globalThis.AA = require(ROOT + "common.js").AA;
  const gpt = require(ROOT + "chatgpt.js");
  const doc = window.document;
  const thread = doc.getElementById("thread");
  const addImage = (src) => {
    const g = doc.createElement("div");
    g.setAttribute("data-testid", "generated-image-gallery");
    g.innerHTML = `<button data-testid="generated-image-preview" aria-label="Generated image 1"><img alt="Generated image 1" data-w="1672" src="${src}"></button>`;
    thread.appendChild(g);
  };
  if (oldImage) addImage("blob:https://chatgpt.com/old-image");
  return { window, doc, gpt, sent, thread, addImage };
}

/** Giả lập ChatGPT: có chữ thì hiện nút Send; bấm Send thì xoá ô nhập, hiện Stop, sau đó trả lời (ảnh hoặc chữ) rồi tắt Stop */
function fakeChatGPT(env, { reply }) {
  const { doc, thread } = env;
  const form = doc.querySelector("form");
  const box = form.querySelector(".ProseMirror");
  const submitted = [];
  const sync = () => {
    const has = (box.textContent || "").trim().length > 0;
    let send = form.querySelector('button[aria-label="Send"]');
    if (has && !send && !form.querySelector('button[aria-label="Stop"]')) {
      send = doc.createElement("button");
      send.type = "submit";
      send.setAttribute("aria-label", "Send");
      send.addEventListener("click", () => {
        submitted.push(box.textContent);
        box.textContent = "";
        send.remove();
        const stop = doc.createElement("button");
        stop.setAttribute("aria-label", "Stop");
        form.appendChild(stop);
        setTimeout(() => {
          if (reply.image) env.addImage(reply.image);
          if (reply.text) thread.insertAdjacentHTML("beforeend", `<div class="reply">${reply.text}</div>`);
        }, 400);
        setTimeout(() => stop.remove(), 900);
      });
      form.appendChild(send);
    }
  };
  box.addEventListener("input", sync);
  new env.window.MutationObserver(sync).observe(box, { childList: true, characterData: true, subtree: true });
  return { submitted };
}

const ctxFor = (payload, log) => ({
  job: { id: "job-1", kind: "chatgpt_image", payload },
  say: async (m) => log.push(m),
  needUser: async (m) => log.push(`USER: ${m}`),
  beat: async () => {},
});

let failed = 0;
const tests = [];
const t = (name, fn) => tests.push({ name, fn });

t("[ChatGPT thật] tìm ô nhập ProseMirror, chưa có chữ thì không có nút Send", async () => {
  const { gpt } = setup();
  assert.equal(gpt.composer()?.getAttribute("aria-label"), "Ask ChatGPT");
  assert.equal(gpt.sendButton(), null);
  assert.equal(gpt.streaming(), false);
});

t("tạo ảnh: điền prompt kèm khổ 16:9, bấm Send đúng 1 lần, chờ ChatGPT xong rồi gửi ảnh PNG về", async () => {
  const env = setup();
  const fake = fakeChatGPT(env, { reply: { image: "blob:https://chatgpt.com/new-image" } });
  const log = [];
  const result = await env.gpt.createImage(ctxFor({ prompt: "Hanoi Old Quarter at sunset", aspect: "16:9", slot: "nen-playlist-1" }, log));
  assert.deepEqual(result, { assetId: "asset-1" });
  assert.equal(fake.submitted.length, 1, `đã gửi ${fake.submitted.length} lần`);
  assert.match(fake.submitted[0], /^Create an image \(horizontal landscape 16:9 aspect ratio\): Hanoi Old Quarter at sunset$/);
  const up = env.sent.find((m) => m.type === "upload");
  assert.equal(up.mime, "image/png");
  assert.equal(up.name, "chatgpt-nen-playlist-1.png");
  assert.ok(Buffer.from(up.b64, "base64").toString().includes("new-image"), "phải gửi đúng ảnh mới");
});

t("đã có ảnh cũ trong cuộc trò chuyện: chỉ lấy ảnh MỚI, khổ 9:16 ghi đúng 'vertical'", async () => {
  const env = setup({ oldImage: true });
  const fake = fakeChatGPT(env, { reply: { image: "blob:https://chatgpt.com/fresh" } });
  await env.gpt.createImage(ctxFor({ prompt: "lighthouse", aspect: "9:16" }, []));
  assert.match(fake.submitted[0], /vertical portrait 9:16/);
  const up = env.sent.find((m) => m.type === "upload");
  const bytes = Buffer.from(up.b64, "base64").toString();
  assert.ok(bytes.includes("fresh") && !bytes.includes("old-image"), "lấy nhầm ảnh cũ");
});

t("ChatGPT trả lời chữ, không có ảnh (hết lượt): báo lỗi kèm lời ChatGPT, không treo", async () => {
  const env = setup();
  fakeChatGPT(env, { reply: { text: "You've hit the Plus plan limit for image generations. You can create more images in 2 hours." } });
  await assert.rejects(
    env.gpt.createImage(ctxFor({ prompt: "x", aspect: "16:9" }, [])),
    (e) => /ChatGPT không tạo ảnh/.test(e.message) && /hit the Plus plan limit/.test(e.message),
  );
  assert.equal(env.sent.filter((m) => m.type === "upload").length, 0);
});

(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log("ok   ", name);
    } catch (e) {
      failed++;
      console.log("SAI  ", name, "\n     ", e.message.split("\n")[0]);
    }
  }
  console.log(failed ? `\n${failed} ca SAI` : "\ntất cả ca đúng");
  process.exit(failed ? 1 : 0);
})();
