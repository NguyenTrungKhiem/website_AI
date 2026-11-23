// Kiểm thử module Nhạc Suno (sunoAnalyzer.js, geminiWeb.js, ffmpeg cutAudioSlice/delayMs, workflow nhac-suno end-to-end với mock).
// Chạy: node scripts/test-suno-workflow.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { chromium } from 'playwright-core';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wv-suno-test-'));
process.env.DATA_DIR = DATA_DIR;

const { db, DIRS, save, updateSettings } = await import('../server/db.js');
assert.equal(path.resolve(DIRS.audio), path.resolve(DATA_DIR, 'audio'), 'Test PHẢI chạy trong DATA_DIR tạm, cấm đụng data/ thật');
const { chromePath } = await import('../server/flow.js');
const { cutAudioSlice, mergeVideos, probe } = await import('../server/ffmpeg.js');
const { runGeminiWebPrompt } = await import('../server/geminiWeb.js');
const { extractJsonBlock, normalizeSunoTimeline, buildSunoVideoPrompt, analyzeSunoAudioWithWeb } = await import('../server/sunoAnalyzer.js');
const { _setSunoWebRunnerForTest } = await import('../server/workflows/nhac-suno.js');
const { createRun } = await import('../server/workflows/runner.js');

function runBin(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.slice(-300)))));
  });
}

const SAMPLE_TIMELINE = [
  { from: 0, to: 1, hasVoice: false, lyric: '', vocalIntensity: 'silent', mouthGuide: 'mouth closed', action: 'holds microphone below chin' },
  { from: 1, to: 2, hasVoice: true, lyric: 'Đêm nay ánh đèn', vocalIntensity: 'soft', mouthGuide: 'gentle rounded lips', action: 'lifts chin slightly' },
  { from: 2, to: 3, hasVoice: true, lyric: 'sân khấu sáng rực', vocalIntensity: 'medium', mouthGuide: 'clear open vowel motion', action: 'sways gently with mic' },
  { from: 3, to: 4, hasVoice: true, lyric: 'anh vẫn đứng đây', vocalIntensity: 'medium', mouthGuide: 'crisp consonant lip closure', action: 'free hand gestures softly' },
  { from: 4, to: 5, hasVoice: true, lyric: 'chờ em dưới mưa', vocalIntensity: 'belting', mouthGuide: 'wide sustained open mouth', action: 'leans into spotlight' },
  { from: 5, to: 6, hasVoice: false, lyric: '[Silent]', vocalIntensity: 'silent', mouthGuide: 'calm breath', action: 'smiles warmly holding mic' },
  { from: 6, to: 7, hasVoice: true, lyric: 'cùng hát vang lên', vocalIntensity: 'belting', mouthGuide: 'wide joyful singing mouth', action: 'raises free hand toward crowd' },
  { from: 7, to: 8, hasVoice: true, lyric: 'giai điệu yêu thương', vocalIntensity: 'medium', mouthGuide: 'smooth jaw rhythm', action: 'glances subtly to side' },
  { from: 8, to: 9, hasVoice: true, lyric: 'mãi không phai nhòa', vocalIntensity: 'soft', mouthGuide: 'gentle closing vowel', action: 'lowers free hand gently' },
  { from: 9, to: 10, hasVoice: false, lyric: '', vocalIntensity: 'silent', mouthGuide: 'closed-lip smile', action: 'holds final poised frame' },
];

const SAMPLE_JSON = {
  songMeta: { language: 'vi', tempoBpm: 96, mood: 'emotional pop ballad', vocalGender: 'female', genre: 'V-Pop' },
  cameraStyle: 'Medium close-up from waist up at 15-degree angle with ultra-smooth push-in, no cuts.',
  stageLighting: 'Warm golden rim light and cool blue haze matching @Image2 concert crowd.',
  timeline: SAMPLE_TIMELINE,
};

function makeFakeGeminiContext({ login = false, responseJson = SAMPLE_JSON } = {}) {
  const cdpCalls = [];
  let submitted = false;
  const makeLoc = (kind) => ({
    async count() {
      if (kind === 'editor') return login ? 0 : 1;
      if (kind === 'switcher') return 1;
      if (kind === 'menu') return 2;
      if (kind === 'upload') return 1;
      if (kind === 'send') return 1;
      if (kind === 'resp') return submitted ? 1 : 0;
      if (kind === 'signin') return login ? 1 : 0;
      return 0;
    },
    nth(i) {
      return {
        async isVisible() { return kind !== 'editor' || !login; },
        async isEnabled() { return true; },
        async innerText() {
          if (kind === 'switcher') return 'Fast';
          if (kind === 'menu') return i === 0 ? 'Fast' : 'Neon';
          return '';
        },
        async click() { if (kind === 'send') submitted = true; },
        async fill() {},
        async evaluate() { return 50; },
      };
    },
    first() { return this.nth(0); },
    last() { return { async setInputFiles() {} }; },
    async isVisible() { return !login; },
    async isEnabled() { return true; },
    async click() { if (kind === 'send') submitted = true; },
    async fill() {},
    async evaluate() { return 50; },
    async innerText() { return kind === 'switcher' ? 'Fast' : ''; },
  });

  const page = {
    _url: 'about:blank',
    url() { return this._url; },
    isClosed() { return false; },
    async bringToFront() { cdpCalls.push('bringToFront'); },
    async goto(u) { this._url = login ? 'https://accounts.google.com/v3/signin' : u; },
    async waitForLoadState() {},
    async waitForEvent() { return { async setFiles() {} }; },
    keyboard: { async insertText() {}, async press() {} },
    locator(sel) {
      if (sel.includes('accounts.google.com')) return makeLoc('signin');
      if (sel.includes('bard-mode')) return makeLoc('switcher');
      if (sel.includes('upload')) return makeLoc('upload');
      if (sel.includes('Send')) return makeLoc('send');
      if (sel.includes('model-response')) return makeLoc('resp');
      if (sel.includes('cdk-overlay')) return makeLoc('menu');
      return makeLoc('editor');
    },
    async evaluate(fn) {
      const s = String(fn);
      if (s.includes('document.body?.innerText?.includes')) return true;
      if (s.includes('stopSel')) return { hasNew: submitted, generating: false, text: '```json\n' + JSON.stringify(responseJson) + '\n```', codes: [JSON.stringify(responseJson)] };
      return 100;
    },
  };

  const ctx = {
    pages: () => [page],
    async newPage() { return page; },
    async newCDPSession() {
      return {
        async send(method, params) {
          cdpCalls.push({ method, params });
          return { windowId: 77 };
        },
        async detach() {},
      };
    },
  };

  return { ctx, cdpCalls };
}

async function main() {
  console.log('--- KIỂM THỬ MODULE NHẠC SUNO (16:9 · 10s · Gemini Web ngầm) ---\n');

  console.log('▶ Test 1: extractJsonBlock & normalizeSunoTimeline');
  const wrapped = `Tôi đã nghe xong file MP3:\n\`\`\`json\n{"foo":1}\n\`\`\`\nKịch bản chính thức:\n\`\`\`json\n${JSON.stringify(SAMPLE_JSON)}\n\`\`\``;
  const extracted = extractJsonBlock(wrapped);
  assert.equal(extracted.timeline.length, 10);
  const norm = normalizeSunoTimeline(extracted.timeline, 10);
  assert.equal(norm.length, 10);
  assert.equal(norm[0].from, 0);
  assert.equal(norm[0].hasVoice, false);
  assert.equal(norm[5].hasVoice, false, '[Silent] phải ép thành im lặng');
  assert.equal(norm[9].to, 10);
  assert.throws(() => extractJsonBlock('không có json'), /Không đọc được JSON/);
  assert.throws(() => normalizeSunoTimeline([{ from: 0, to: 5, lyric: 'a' }], 10), /quá ít mốc/);
  const wrappedWithCurly = `Lưu ý {chú thích nhịp 0-10s} ở ngoài:\n\`\`\`json\n${JSON.stringify(SAMPLE_JSON)}\n\`\`\`\nVà {ghi chú cuối}.`;
  const extractedCurly = extractJsonBlock(wrappedWithCurly);
  assert.equal(extractedCurly.timeline.length, 10, 'Phải tách đúng JSON kể cả khi có {ngoặc nhọn} ngoài lề');
  const fromCodeBlock = extractJsonBlock('Gemini đã nói {nội dung nhiễu}', [JSON.stringify(SAMPLE_JSON)]);
  assert.equal(fromCodeBlock.timeline.length, 10, 'Phải ưu tiên parse từ codeBlocks sạch');
  console.log('  ✔ extractJsonBlock chọn block chứa timeline, miễn nhiễm {ngoặc} ngoài lề & ưu tiên codeBlocks');

  console.log('\n▶ Test 2: buildSunoVideoPrompt — 16:9, @Image1, @Image2, không che miệng');
  const built = buildSunoVideoPrompt({
    timeline: norm,
    songMeta: SAMPLE_JSON.songMeta,
    cameraStyle: SAMPLE_JSON.cameraStyle,
    stageLighting: SAMPLE_JSON.stageLighting,
    aspectRatio: '16:9',
    durationSec: 10,
    micType: 'handheld',
  });
  assert.match(built, /widescreen 16:9/);
  assert.match(built, /@Image1/);
  assert.match(built, /@Image2/);
  assert.match(built, /0\.0-1\.0s:.*Voice: \[Silent\]/);
  assert.match(built, /1\.0-2\.0s:.*Voice: "Đêm nay ánh đèn"/);
  assert.match(built, /never obscures the lips|never let the microphone/i);
  const standBuilt = buildSunoVideoPrompt({ timeline: norm, micType: 'stand', aspectRatio: '9:16', durationSec: 10 });
  assert.match(standBuilt, /vertical 9:16/);
  assert.match(standBuilt, /mounted on a stand/);
  const maleBuilt = buildSunoVideoPrompt({ timeline: norm, songMeta: { ...SAMPLE_JSON.songMeta, vocalGender: 'male' }, aspectRatio: '16:9', durationSec: 10 });
  assert.match(maleBuilt, /He holds a wireless stage handheld microphone.*from his chin/);
  console.log('  ✔ dựng prompt chuẩn Omni Flash 16:9 & 9:16, giữ @Image1/@Image2 & quy tắc không che môi');

  console.log('\n▶ Test 3: FFmpeg cutAudioSlice (10.0s) + mergeVideos thay tiếng AI bằng MP3 gốc (+ delayMs)');
  const tmpWork = path.join(DATA_DIR, 'media-test');
  fs.mkdirSync(tmpWork, { recursive: true });
  const song15s = path.join(tmpWork, 'suno-15s.mp3');
  const slice10s = path.join(tmpWork, 'slice-10s.mp3');
  const dummyVid = path.join(tmpWork, 'omni-2s.mp4');
  const merged0 = path.join(tmpWork, 'merged-0.mp4');
  const mergedDelay = path.join(tmpWork, 'merged-delay.mp4');
  // Tạo MP3 15s (sine 440Hz) và video 2s 1280x720 có tiếng nền 880Hz (để xác nhận sau khi ghép chỉ còn nhạc Suno)
  await runBin(['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=15', '-c:a', 'libmp3lame', '-b:a', '128k', song15s]);
  await runBin(['-y', '-f', 'lavfi', '-i', 'color=c=black:s=1280x720:d=2:r=30', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', dummyVid]);

  await cutAudioSlice(song15s, slice10s, 3.0, 10);
  const sliceMeta = await probe(slice10s);
  assert.equal(sliceMeta.hasAudio, true);
  assert.ok(sliceMeta.duration >= 9.8 && sliceMeta.duration <= 10.2, `lát MP3 phải đúng ~10s (thực tế ${sliceMeta.duration})`);

  await mergeVideos({
    segments: [{ file: dummyVid }],
    width: 1280,
    height: 720,
    audio: { file: song15s, offset: 3.0, delayMs: 0 },
    dest: merged0,
    removeWatermark: true,
    keepOriginalAudio: false,
  });
  await mergeVideos({
    segments: [{ file: dummyVid }],
    width: 1280,
    height: 720,
    audio: { file: song15s, offset: 3.0, delayMs: 250 },
    dest: mergedDelay,
    removeWatermark: true,
    keepOriginalAudio: false,
  });
  const m0 = await probe(merged0);
  const mDelay = await probe(mergedDelay);
  assert.equal(m0.hasAudio, true);
  assert.equal(m0.width, 1280);
  assert.equal(m0.height, 720);
  assert.equal(mDelay.hasAudio, true);
  console.log(`  ✔ cutAudioSlice = ${sliceMeta.duration.toFixed(2)}s; mergeVideos thay tiếng AI thành công (1280×720, có audio)`);

  console.log('\n▶ Test 4: runGeminiWebPrompt (ẩn mặc định, tự bung Chrome ONLY khi lỗi)');
  const okGem = makeFakeGeminiContext({ login: false });
  const okRes = await runGeminiWebPrompt({
    filePath: slice10s,
    prompt: 'Phân tích thử',
    modelName: 'Neon',
    thinkingLevel: 'Trung bình',
    context: okGem.ctx,
    showOnError: true,
  });
  assert.ok(okRes.rawText.includes('Đêm nay ánh đèn'));
  assert.ok(!okGem.cdpCalls.some((c) => c?.params?.bounds?.windowState === 'normal'), 'thành công thì KHÔNG được bung cửa sổ Chrome');

  const errGem = makeFakeGeminiContext({ login: true });
  await assert.rejects(
    () => runGeminiWebPrompt({ filePath: slice10s, prompt: 'Phân tích thử', context: errGem.ctx, showOnError: true }),
    /Chưa đăng nhập Google/,
  );
  assert.ok(errGem.cdpCalls.some((c) => c?.params?.bounds?.windowState === 'normal'), 'lỗi đăng nhập PHẢI bung cửa sổ Chrome lên để người dùng xử lý');
  console.log('  ✔ thành công chạy ngầm hoàn toàn; lỗi tự bung Chrome lên màn hình');

  console.log('\n▶ Test 5: analyzeSunoAudioWithWeb + chạy end-to-end workflow nhac-suno (engine mock)');
  const analyzed = await analyzeSunoAudioWithWeb({
    audioPath: song15s,
    startSec: 2,
    durationSec: 10,
    lyricsHint: 'Đêm nay ánh đèn',
    aspectRatio: '16:9',
    runWeb: async ({ filePath, modelName, thinkingLevel }) => {
      assert.ok(fs.existsSync(filePath), 'file MP3 cắt 10s phải được tạo trước khi gọi Gemini Web');
      assert.equal(modelName, 'Neon');
      assert.equal(thinkingLevel, 'Trung bình');
      return { rawText: '```json\n' + JSON.stringify(SAMPLE_JSON) + '\n```', selectedModel: 'Neon' };
    },
  });
  assert.equal(analyzed.timeline.length, 10);
  assert.match(analyzed.videoPrompt, /widescreen 16:9/);

  // Chạy toàn bộ quy trình nhac-suno: analyze -> video (mock) -> merge (ghép MP3 gốc)
  const modelImg = path.join(DIRS.assets, 'singer.png');
  const stageImg = path.join(DIRS.assets, 'stage.png');
  await runBin(['-y', '-f', 'lavfi', '-i', 'color=c=skyblue:s=640x360:d=0.1', '-frames:v', '1', modelImg]);
  await runBin(['-y', '-f', 'lavfi', '-i', 'color=c=navy:s=640x360:d=0.1', '-frames:v', '1', stageImg]);
  const audioAssetPath = path.join(DIRS.audio, 'suno-track.mp3');
  fs.copyFileSync(song15s, audioAssetPath);

  db.assets.push(
    { id: 'singer1', kind: 'model', name: 'Ca sĩ nữ', path: modelImg, createdAt: Date.now() },
    { id: 'stage1', kind: 'background', name: 'Sân khấu concert', path: stageImg, createdAt: Date.now() },
  );
  db.audios.push({ id: 'audio1', sourceId: null, name: 'Bai-hat-Suno.mp3', path: audioAssetPath, duration: 15, createdAt: Date.now() });
  updateSettings({ engine: 'mock', flowVideoAudio: 'mute' }); // dù Cài đặt để mute, nhac-suno phải ép flowVideoAudio = sound

  _setSunoWebRunnerForTest(async () => ({
    rawText: '```json\n' + JSON.stringify(SAMPLE_JSON) + '\n```',
    selectedModel: 'Neon',
  }));

  const runObj = createRun({
    workflowId: 'nhac-suno',
    inputs: { model: 'singer1', background: 'stage1' },
    options: {
      audioId: 'audio1',
      audioStartSec: 2,
      syncOffsetMs: 100,
      aspectRatio: '16:9',
      duration: '10s',
      micType: 'handheld',
      geminiWebModel: 'Neon',
      geminiThinkingLevel: 'Trung bình',
      reviewScript: false,
      removeWatermark: true,
    },
  });

  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline && runObj.status === 'running') {
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.equal(runObj.status, 'done', `Quy trình phải xong (thực tế: ${runObj.status}, lỗi: ${runObj.error})`);
  assert.equal(runObj.stages.analyze.status, 'done');
  assert.equal(runObj.stages.review.status, 'skipped');
  assert.equal(runObj.stages.video.status, 'done');
  assert.equal(runObj.stages.merge.status, 'done');

  const vidJob = db.jobs.find((j) => j.id === runObj.stages._jobs['video:part1']);
  assert.equal(vidJob.meta.aspectRatio, '16:9');
  assert.equal(vidJob.meta.flowDuration, '10s');
  assert.equal(vidJob.meta.flowVideoAudio, 'sound');
  assert.deepEqual(vidJob.imagePaths, [modelImg, stageImg]);

  const mergeRec = db.merges.find((m) => m.id === runObj.stages.merge.mergeId);
  assert.equal(mergeRec.audioId, 'audio1');
  assert.equal(mergeRec.audioMode, 'continuous');
  assert.equal(mergeRec.offset, 2);
  assert.equal(mergeRec.delayMs, 100);
  assert.equal(mergeRec.keepOriginalAudio, false);
  const finalMeta = await probe(mergeRec.outputPath);
  assert.equal(finalMeta.hasAudio, true);
  console.log('  ✔ quy trình nhac-suno hoàn tất 3 bước (analyze -> video -> merge), giữ đúng MP3 Suno gốc & metadata 16:9 10s');

  _setSunoWebRunnerForTest(null);
  save();

  console.log('\n▶ Test 6: DOM Playwright thật có sidebar "Gửi .../Tải lên.../Dừng..." đứng trước input-area-v2');
  const exe = chromePath();
  const realBrowser = await chromium.launch({
    executablePath: exe || undefined,
    channel: exe ? undefined : 'chrome',
    headless: true,
  });
  try {
    const realPage = await realBrowser.newPage({ viewport: { width: 1280, height: 800 } });
    const sampleStr = JSON.stringify(SAMPLE_JSON);
    await realPage.setContent(`
      <!doctype html>
      <html>
      <body style="margin:0;display:flex;font-family:sans-serif">
        <bard-sidenav style="width:260px;height:100vh;display:block;position:relative">
          <div style="position:relative;padding:8px">
            <a id="sb-link" href="/app/a3768dacbd3de201" aria-label="Gửi 100 triệu Vietcombank làm thẻ Priority" style="display:flex;align-items:center;position:relative;height:40px">
              <span>Gửi 100 triệu Vietcombank...</span>
              <button id="sb-send" type="button" aria-label="Lựa chọn khác cho Gửi 100 triệu Vietcombank làm thẻ Priority" style="width:28px;height:28px">⋮</button>
              <span id="sb-cover" style="position:absolute;inset:0;z-index:5"></span>
            </a>
            <button id="sb-upload" type="button" aria-label="Lựa chọn khác cho Tải lên bảng lương" style="width:28px;height:28px">⋮</button>
            <button id="sb-stop" type="button" aria-label="Dừng hợp đồng cũ ngay" style="width:28px;height:28px">!</button>
          </div>
        </bard-sidenav>
        <main style="flex:1;padding:24px">
          <div id="responses"></div>
          <input-container style="display:block;position:relative">
            <button id="fab-down" type="button" class="back-to-bottom-fab" aria-label="Cuộn xuống dưới cùng" style="width:32px;height:32px">
              <mat-icon fonticon="arrow_upward"></mat-icon>
            </button>
            <div id="chip" style="min-height:20px"></div>
            <input type="file" id="hidden-file" style="display:none" />
            <input-area-v2 style="display:block;border:1px solid #ccc;padding:12px">
              <div class="input-area">
                <rich-textarea>
                  <div class="ql-editor textarea" contenteditable="true" role="textbox" style="min-height:48px;width:400px;border:1px solid #999"></div>
                </rich-textarea>
                <div style="display:flex;gap:8px;margin-top:8px">
                  <button id="real-upload" type="button" aria-label="Nội dung tải lên và công cụ" style="width:36px;height:36px">
                    <mat-icon fonticon="plus"></mat-icon>
                  </button>
                  <button id="real-mode" type="button" data-test-id="bard-mode-menu-button" class="input-area-switch" style="height:36px;padding:0 12px">Neon</button>
                  <button id="real-send" type="button" aria-label="Gửi tin nhắn" style="width:36px;height:36px">
                    <mat-icon fonticon="arrow_upward"></mat-icon>
                  </button>
                </div>
              </div>
            </input-area-v2>
          </input-container>
        </main>
        <script>
          window.__metrics = { sbClicks: 0, fabClicks: 0, uploadClicks: 0, sendClicks: 0 };
          for (const id of ['sb-link', 'sb-send', 'sb-cover', 'sb-upload', 'sb-stop']) {
            document.getElementById(id).addEventListener('click', (e) => { e.preventDefault(); window.__metrics.sbClicks++; });
          }
          document.getElementById('fab-down').addEventListener('click', () => { window.__metrics.fabClicks++; });
          document.getElementById('real-upload').addEventListener('click', () => {
            window.__metrics.uploadClicks++;
            document.getElementById('hidden-file').click();
          });
          document.getElementById('hidden-file').addEventListener('change', (e) => {
            const f = e.target.files?.[0];
            if (f) document.getElementById('chip').textContent = f.name;
          });
          document.getElementById('real-send').addEventListener('click', () => {
            window.__metrics.sendClicks++;
            const mr = document.createElement('model-response');
            const pre = document.createElement('pre');
            const code = document.createElement('code');
            code.textContent = ${JSON.stringify(sampleStr)};
            pre.appendChild(code);
            mr.appendChild(pre);
            document.getElementById('responses').appendChild(mr);
          });
        </script>
      </body>
      </html>
    `);

    realPage.goto = async () => {};
    realPage.waitForLoadState = async () => {};
    const domCtx = {
      pages: () => [realPage],
      newPage: async () => realPage,
      newCDPSession: async () => ({ send: async () => ({ windowId: 99 }), detach: async () => {} }),
    };

    const domRes = await runGeminiWebPrompt({
      filePath: slice10s,
      prompt: 'Phân tích thử tránh bấm nhầm sidebar',
      modelName: 'Neon',
      thinkingLevel: '',
      context: domCtx,
      showOnError: false,
      timeoutMs: 15_000,
    });
    assert.ok(domRes.rawText.includes('Đêm nay ánh đèn'));
    const m = await realPage.evaluate(() => window.__metrics);
    assert.equal(m.sbClicks, 0, 'Không được bấm bất kỳ nút nào trong sidebar');
    assert.equal(m.fabClicks, 0, 'Không được bấm nhầm nút back-to-bottom-fab');
    assert.equal(m.uploadClicks, 1, 'Phải bấm đúng nút upload trong input-area-v2');
    assert.equal(m.sendClicks, 1, 'Phải bấm đúng nút Gửi tin nhắn trong input-area-v2');
    console.log('  ✔ Đã chọn đúng nút Tải lên & Gửi tin nhắn trong <input-area-v2>, bỏ qua sidebar & nút cuộn xuống');

    console.log('\n▶ Test 7: Neon trả chữ "Gemini đã nói" -> JSON nửa chừng (2.8s) -> JSON hoàn chỉnh + actions (5.2s)');
    const p7 = await realBrowser.newPage({ viewport: { width: 1280, height: 800 } });
    await p7.setContent(`
      <!doctype html>
      <html>
      <body style="margin:0;padding:24px;font-family:sans-serif">
        <div id="responses"></div>
        <input-area-v2 style="display:block;border:1px solid #ccc;padding:12px">
          <div class="input-area">
            <rich-textarea>
              <div class="ql-editor textarea" contenteditable="true" role="textbox" style="min-height:48px;width:400px"></div>
            </rich-textarea>
            <input type="file" id="hidden-file-7" style="display:none" />
            <div id="chip-7"></div>
            <button id="up-7" type="button" aria-label="Nội dung tải lên và công cụ" style="width:36px;height:36px">
              <mat-icon fonticon="plus"></mat-icon>
            </button>
            <button id="mode-7" type="button" data-test-id="bard-mode-menu-button" class="input-area-switch" style="height:36px">Neon</button>
            <button id="send-7" type="button" aria-label="Gửi tin nhắn" style="width:36px;height:36px">
              <mat-icon fonticon="arrow_upward"></mat-icon>
            </button>
          </div>
        </input-area-v2>
        <script>
          document.getElementById('up-7').addEventListener('click', () => document.getElementById('hidden-file-7').click());
          document.getElementById('hidden-file-7').addEventListener('change', (e) => {
            const f = e.target.files?.[0];
            if (f) document.getElementById('chip-7').textContent = f.name;
          });
          document.getElementById('send-7').addEventListener('click', () => {
            const mr = document.createElement('model-response');
            mr.textContent = 'Gemini đã nói';
            document.getElementById('responses').appendChild(mr);

            setTimeout(() => {
              mr.textContent = 'Gemini đã nói\\nJSON\\n{\\n  "songMeta": {"language": "vi"';
            }, 2800);

            setTimeout(() => {
              mr.textContent = '';
              const label = document.createElement('div');
              label.textContent = 'Gemini đã nói\\nJSON';
              const cb = document.createElement('code-block');
              const pre = document.createElement('pre');
              const code = document.createElement('code');
              code.textContent = ${JSON.stringify(sampleStr)};
              pre.appendChild(code);
              cb.appendChild(pre);
              const acts = document.createElement('message-actions');
              const b1 = document.createElement('button');
              b1.setAttribute('aria-label', 'Sao chép');
              b1.textContent = 'Copy';
              b1.style.width = '24px';
              b1.style.height = '24px';
              const b2 = document.createElement('button');
              b2.setAttribute('aria-label', 'Câu trả lời tốt');
              b2.textContent = 'Like';
              b2.style.width = '24px';
              b2.style.height = '24px';
              acts.appendChild(b1);
              acts.appendChild(b2);
              mr.appendChild(label);
              mr.appendChild(cb);
              mr.appendChild(acts);
            }, 5200);
          });
        </script>
      </body>
      </html>
    `);
    p7.goto = async () => {};
    p7.waitForLoadState = async () => {};
    const ctx7 = {
      pages: () => [p7],
      newPage: async () => p7,
      newCDPSession: async () => ({ send: async () => ({ windowId: 100 }), detach: async () => {} }),
    };

    const t0 = Date.now();
    const res7 = await runGeminiWebPrompt({
      filePath: slice10s,
      prompt: 'Test chờ Neon trả xong JSON hoàn chỉnh',
      modelName: 'Neon',
      thinkingLevel: '',
      context: ctx7,
      showOnError: false,
      expectJson: true,
      timeoutMs: 18_000,
    });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 5000, `Không được thoát sớm trước khi JSON hoàn chỉnh (elapsed=${elapsed}ms)`);
    assert.ok(res7.codeBlocks.length >= 1, 'Phải gom được codeBlocks');
    const parsed7 = extractJsonBlock(res7.rawText, res7.codeBlocks);
    assert.equal(parsed7.timeline.length, 10, 'Phải parse đủ 10 mốc từ JSON cuối cùng');
    console.log(`  ✔ Không thoát sớm ở ${elapsed}ms, đọc đủ 10 mốc timeline khi Neon trả xong JSON`);
  } finally {
    await realBrowser.close();
  }

  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  console.log('\n🎉 TẤT CẢ 7 BÀI TEST MODULE NHẠC SUNO ĐÃ VƯỢT QUA!');
}

Promise.resolve()
  .then(main)
  .catch((err) => {
    console.error('\n❌ TEST THẤT BẠI:', err);
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    process.exit(1);
  });
