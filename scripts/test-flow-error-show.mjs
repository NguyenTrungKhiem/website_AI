// Kiểm thử phát hiện lỗi "unusual activity" trên Google Flow + tự bật cửa sổ Chrome khi lỗi (giữ chạy ngầm khi bình thường).
// Thuần, không mở Chrome thật. Chạy: node scripts/test-flow-error-show.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wv-flow-show-'));
process.env.DATA_DIR = DATA_DIR;
process.env.FLOW_NO_SHOW = '1';

const { flowFailure, FLOW_PAGE_ERROR_RE, raiseWindowViaCdp, runFlowWithErrorShow, shouldRelaunchOnDesktop, shouldRecenterBounds, PRIMARY_WINDOW_BOUNDS } = await import('../server/flow.js');

function makeMockCdp(initialState) {
  const calls = [];
  let state = initialState;
  const cdp = {
    async send(method, params) {
      calls.push({ method, params });
      if (method === 'Browser.getWindowForTarget') {
        return { windowId: 42, bounds: { left: -2147, top: -11, width: 1621, height: 1012, windowState: state } };
      }
      if (method === 'Browser.setWindowBounds') {
        state = params?.bounds?.windowState || state;
        return {};
      }
      return {};
    },
    async detach() {
      calls.push({ method: 'detach' });
    },
  };
  let brought = 0;
  const ctx = { async newCDPSession() { return cdp; } };
  const page = { async bringToFront() { brought++; } };
  return { ctx, page, calls, getBrought: () => brought };
}

async function main() {
  console.log('▶ Test 1: flowFailure() phân tích lỗi "We noticed some unusual activity..."');
  const raw = [
    'warning',
    'Failed',
    'We noticed some unusual activity. Note that browser extensions that modify the page may cause issues. Please visit the Help Center for more information. You have not been charged for this generation.',
  ].join('\n');
  const formatted = flowFailure(raw);
  assert.match(formatted, /^Flow báo lỗi: We noticed some unusual activity\./);
  assert.match(formatted, /You have not been charged for this generation\./);
  assert.match(formatted, /hoạt động bất thường.*Chrome của Flow/);
  console.log('  ✔ giữ nguyên lý do gốc và thêm hướng dẫn tiếng Việt');

  console.log('\n▶ Test 2: FLOW_PAGE_ERROR_RE nhận đúng lỗi & không bắt nhầm trạng thái bình thường');
  assert.equal(FLOW_PAGE_ERROR_RE.test('We noticed some unusual activity. Please visit the Help Center.'), true);
  assert.equal(FLOW_PAGE_ERROR_RE.test('You have not been charged for this generation.'), true);
  assert.equal(FLOW_PAGE_ERROR_RE.test('Please complete the captcha or verify it\'s you'), true);
  assert.equal(FLOW_PAGE_ERROR_RE.test('Generating 45%'), false);
  assert.equal(FLOW_PAGE_ERROR_RE.test('Switch account'), false);
  console.log('  ✔ khớp đúng chuỗi lỗi, bỏ qua trạng thái bình thường');

  console.log('\n▶ Test 3: raiseWindowViaCdp() đưa cửa sổ Chrome từ trạng thái thu nhỏ/ẩn lên trước không đổi màn hình');
  {
    const m = makeMockCdp('minimized');
    const r = await raiseWindowViaCdp(m.ctx, m.page);
    assert.equal(r.previousState, 'minimized');
    const setStates = m.calls.filter((c) => c.method === 'Browser.setWindowBounds').map((c) => c.params.bounds.windowState);
    assert.deepEqual(setStates, ['normal']);
    assert.equal(m.getBrought(), 1);
    assert.ok(m.calls.some((c) => c.method === 'detach'));
  }
  {
    const m = makeMockCdp('normal');
    const r = await raiseWindowViaCdp(m.ctx, m.page);
    assert.equal(r.previousState, 'normal');
    const setStates = m.calls.filter((c) => c.method === 'Browser.setWindowBounds').map((c) => c.params.bounds.windowState);
    assert.deepEqual(setStates, ['minimized', 'normal']);
    assert.equal(m.getBrought(), 1);
  }
  {
    const m = makeMockCdp('maximized');
    const r = await raiseWindowViaCdp(m.ctx, m.page);
    assert.equal(r.previousState, 'maximized');
    const setStates = m.calls.filter((c) => c.method === 'Browser.setWindowBounds').map((c) => c.params.bounds.windowState);
    assert.deepEqual(setStates, ['minimized', 'maximized']);
    assert.equal(m.getBrought(), 1);
  }
  {
    const m = makeMockCdp('fullscreen');
    const r = await raiseWindowViaCdp(m.ctx, m.page);
    assert.equal(r.previousState, 'fullscreen');
    const setStates = m.calls.filter((c) => c.method === 'Browser.setWindowBounds');
    assert.equal(setStates.length, 0);
    assert.equal(m.getBrought(), 1);
  }
  console.log('  ✔ xử lý đúng mọi trạng thái minimized / normal / maximized / fullscreen');

  console.log('\n▶ Test 4: runFlowWithErrorShow() chạy ngầm khi thành công, chỉ bật Chrome khi lỗi thật');
  {
    let shows = [];
    const okRes = await runFlowWithErrorShow(async () => 'done', { show: (arg) => shows.push(arg) });
    assert.equal(okRes, 'done');
    assert.equal(shows.length, 0, 'thành công -> không bật cửa sổ');

    shows = [];
    await assert.rejects(
      () => runFlowWithErrorShow(async () => { throw new Error('unusual activity'); }, { show: (arg) => shows.push(arg) }),
      /unusual activity/,
    );
    assert.equal(shows.length, 1, 'lỗi thật -> tự bật cửa sổ Chrome 1 lần');
    assert.equal(shows[0].reason, 'unusual activity');

    shows = [];
    await assert.rejects(
      () => runFlowWithErrorShow(async () => { throw new Error('cancelled'); }, { isCancelled: () => true, show: (arg) => shows.push(arg) }),
      /cancelled/,
    );
    assert.equal(shows.length, 0, 'người dùng huỷ -> không bật cửa sổ');

    shows = [];
    await assert.rejects(
      () => runFlowWithErrorShow(async () => { throw new Error('dry failure'); }, { dryRun: true, show: (arg) => shows.push(arg) }),
      /dry failure/,
    );
    assert.equal(shows.length, 0, 'dryRun -> không bật cửa sổ');
  }
  console.log('  ✔ chỉ mở Chrome khi Flow báo lỗi thật');

  console.log('\n▶ Test 5: shouldRelaunchOnDesktop & shouldRecenterBounds phát hiện desktop ẩn & toạ độ ngoài màn hình chính');
  assert.equal(shouldRelaunchOnDesktop('not_on_default_desktop'), true);
  assert.equal(shouldRelaunchOnDesktop('activated'), false);
  assert.equal(shouldRelaunchOnDesktop('error'), false);
  assert.equal(shouldRecenterBounds({ left: -2147, top: -11, width: 1621, height: 1012 }), true, 'toạ độ màn hình phụ (-2147) -> đưa về màn chính');
  assert.equal(shouldRecenterBounds({ left: 2050, top: 40, width: 1200, height: 800 }), true);
  assert.equal(shouldRecenterBounds({ left: 120, top: 80, width: 1280, height: 860 }), false, 'đang ở màn chính -> giữ nguyên');
  assert.equal(shouldRecenterBounds(null), false);
  assert.deepEqual(PRIMARY_WINDOW_BOUNDS, { left: 100, top: 60, width: 1320, height: 880 });
  console.log('  ✔ nhận diện đúng trường hợp cần chuyển sang WinSta0\\Default & căn màn hình chính');

  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  console.log('\n🎉 TẤT CẢ 5 BÀI TEST TỰ MỞ FLOW CHROME KHI LỖI ĐÃ VƯỢT QUA!');
}

main().catch((err) => {
  console.error('\n❌ TEST THẤT BẠI:', err);
  process.exit(1);
});
