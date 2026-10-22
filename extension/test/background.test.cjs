// Kiểm tra trình nền (background.js) với Chrome giả lập: mạng chậm làm các lượt hỏi việc chồng lên nhau.
// Chạy: node background.test.cjs  (npm test chạy cả file này)
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert");

const SRC = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Dựng Chrome + máy chủ giả. `delayMs`: thời gian mỗi lần gọi máy chủ. `hang`: gọi máy chủ không bao giờ trả lời. */
function boot({ src = SRC, delayMs = 300, hang = false, jobs = 5 } = {}) {
  const local = { server: "http://web.test", token: "t" };
  const session = {};
  const store = (obj) => ({
    async get(keys) {
      if (keys == null) return { ...obj };
      if (typeof keys === "string") return keys in obj ? { [keys]: obj[keys] } : {};
      if (Array.isArray(keys)) return Object.fromEntries(keys.filter((k) => k in obj).map((k) => [k, obj[k]]));
      return Object.fromEntries(Object.entries(keys).map(([k, d]) => [k, k in obj ? obj[k] : d]));
    },
    async set(o) {
      Object.assign(obj, o);
    },
    async remove(k) {
      for (const key of [].concat(k)) delete obj[key];
    },
  });
  const listeners = {};
  const ev = (name) => ({ addListener: (fn) => (listeners[name] ??= []).push(fn) });
  const tabs = new Map();
  const removed = [];
  let nextTab = 1;
  const calls = { claim: 0, sync: 0, report: 0 };
  let queue = Array.from({ length: jobs }, (_, i) => ({ id: `job-${i + 1}`, kind: "google_flow_video", payload: {} }));

  const chrome = {
    runtime: { id: "x", onStartup: ev("startup"), onInstalled: ev("installed"), onMessage: ev("message"), lastError: undefined },
    storage: { local: store(local), session: store(session) },
    alarms: { create() {}, onAlarm: ev("alarm") },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
    notifications: { create() {}, clear() {}, onClicked: ev("notifClick") },
    downloads: { search: async () => [], erase: async () => {}, cancel: async () => {}, onCreated: ev("dlCreated"), onChanged: ev("dlChanged") },
    webRequest: { onResponseStarted: ev("wrResp"), onBeforeSendHeaders: ev("wrSend") },
    tabs: {
      async create({ url }) {
        const id = nextTab++;
        tabs.set(id, { id, url });
        return { id, url };
      },
      async get(id) {
        if (!tabs.has(id)) throw new Error("No tab");
        return tabs.get(id);
      },
      async update(id) {
        return tabs.get(id);
      },
      async remove(id) {
        if (!tabs.delete(id)) return;
        removed.push(id);
        for (const fn of listeners.tabRemoved ?? []) fn(id);
      },
      async sendMessage() {
        return { ok: true };
      },
      onUpdated: ev("tabUpdated"),
      onRemoved: ev("tabRemoved"),
    },
  };

  async function fakeFetch(url, opts = {}) {
    const body = opts.body ? JSON.parse(opts.body) : {};
    if (hang) {
      await new Promise((_, reject) => opts.signal?.addEventListener("abort", () => reject(opts.signal.reason)));
    }
    await sleep(delayMs);
    let json = {};
    if (url.endsWith("/api/agent/claim")) {
      if (body.syncOnly) {
        calls.sync++;
        json = { job: null, pendingCount: queue.length };
      } else {
        calls.claim++;
        json = { job: queue.shift() ?? null, pendingCount: queue.length };
      }
    } else if (url.includes("/api/agent/jobs/")) {
      calls.report++;
      json = { cancelled: false };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(json) };
  }

  // Hạn chờ thật của tiện ích là 60 giây: trong test rút xuống 1/1000 để chạy nhanh
  const FastAbortSignal = { timeout: (ms) => AbortSignal.timeout(Math.max(1, ms / 1000)) };
  const ctx = vm.createContext({
    chrome,
    fetch: fakeFetch,
    AbortSignal: FastAbortSignal,
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 50_000)),
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    console: { log() {}, warn() {}, error() {} },
    URL,
    atob,
    btoa,
    Blob,
    Date,
    Promise,
    JSON,
    Math,
    Map,
    Set,
    Uint8Array,
    TextDecoder,
    DOMException,
  });
  vm.runInContext(src, ctx, { filename: "background.js" });

  const fire = (name, ...args) => (listeners[name] ?? []).map((fn) => fn(...args));
  const message = (msg, sender = {}) => new Promise((resolve) => fire("message", msg, sender, resolve));
  return { local, session, tabs, removed, calls, fire, message, ctx, listeners };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("Mạng chậm: báo thức + hẹn giờ + nút 'nhận ngay' cùng lúc -> chỉ nhận 1 việc, mở 1 tab", async () => {
  const b = boot({ delayMs: 400 });
  b.fire("alarm", { name: "poll" });
  b.fire("alarm", { name: "poll_wake" });
  b.fire("startup");
  b.message({ type: "pollNow" });
  await sleep(3000);
  assert.strictEqual(b.calls.claim, 1, `đã hỏi nhận việc ${b.calls.claim} lần`);
  assert.strictEqual(b.tabs.size, 1, `đã mở ${b.tabs.size} tab`);
  assert.strictEqual(b.session.current?.job?.id, "job-1");
});

test("Đối chứng: bản cũ (không khoá lượt hỏi việc) nhận nhiều việc cùng lúc -> test phát hiện được lỗi", async () => {
  const old = SRC.replace(/function poll\(\) \{[\s\S]*?\n\}\n/, "const poll = () => pollOnce();\n");
  assert.notStrictEqual(old, SRC, "không tạo được bản đối chứng");
  const b = boot({ src: old, delayMs: 400 });
  b.fire("alarm", { name: "poll" });
  b.fire("alarm", { name: "poll_wake" });
  b.fire("startup");
  b.message({ type: "pollNow" });
  await sleep(3000);
  assert.ok(b.calls.claim > 1 && b.tabs.size > 1, `bản cũ lẽ ra phải nhận nhiều việc (nhận ${b.calls.claim}, mở ${b.tabs.size} tab)`);
});

test("Đang có việc: hỏi việc tiếp chỉ gửi nhịp tim, không nhận thêm", async () => {
  const b = boot({ delayMs: 50 });
  await b.fire("alarm", { name: "poll" })[0];
  assert.strictEqual(b.calls.claim, 1);
  await b.fire("alarm", { name: "poll" })[0];
  await b.fire("alarm", { name: "poll" })[0];
  assert.strictEqual(b.calls.claim, 1, "không được nhận thêm khi đang bận");
  assert.strictEqual(b.tabs.size, 1);
});

test("Việc A xong chỉ đóng tab của A, không đóng nhầm tab của việc B đang chạy", async () => {
  const b = boot({ delayMs: 10 });
  // Giả lập trạng thái lỗi cũ để lại: việc B là việc hiện tại ở tab 2, việc A (mồ côi) vẫn chạy ở tab 1
  b.tabs.set(1, { id: 1 });
  b.tabs.set(2, { id: 2 });
  b.session.current = { job: { id: "B", kind: "google_flow_video", payload: {} }, tabId: 2, startedAt: Date.now() };
  await b.message({ type: "done", jobId: "A", result: {} }, { tab: { id: 1 } });
  assert.deepStrictEqual(b.removed, [1], `đã đóng tab ${JSON.stringify(b.removed)}`);
  assert.strictEqual(b.session.current?.job?.id, "B", "việc B phải giữ nguyên");
  await b.message({ type: "done", jobId: "B", result: {} }, { tab: { id: 2 } });
  assert.deepStrictEqual(b.removed, [1, 2]);
  assert.strictEqual(b.session.current, undefined);
});

test("Máy chủ không trả lời: lượt hỏi việc tự dừng theo hạn chờ, báo lỗi rõ và không khoá mãi", async () => {
  const b = boot({ hang: true });
  await Promise.race([b.fire("alarm", { name: "poll" })[0], sleep(5000).then(() => assert.fail("lượt hỏi việc bị treo"))]);
  assert.match(b.local.status?.error ?? "", /không trả lời/);
  // Lượt sau vẫn chạy được (khoá đã nhả)
  await Promise.race([b.fire("alarm", { name: "poll" })[0], sleep(5000).then(() => assert.fail("khoá không được nhả"))]);
});

(async () => {
  let fail = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`ok    ${t.name}`);
    } catch (e) {
      fail++;
      console.log(`LỖI  ${t.name}\n      ${e.message}`);
    }
  }
  console.log(fail ? `\n${fail} ca lỗi` : "\ntất cả ca đúng");
  process.exit(fail ? 1 : 0);
})();
