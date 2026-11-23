// Kiểm thử tính năng Cắt & Ghép nhạc (buildConcatAudioArgs, concatAudioSegments với ffmpeg-static thật, và API /api/audios/concat nếu backend đang chạy).
// Chạy: node scripts/test-audio-edit.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { buildConcatAudioArgs, concatAudioSegments, probe } from '../server/ffmpeg.js';

function runBin(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.slice(-300)))));
  });
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wv-audio-edit-'));

try {
  // 1. Unit tests cho buildConcatAudioArgs
  assert.throws(() => buildConcatAudioArgs([], path.join(tmpDir, 'out.mp3')), /ít nhất 1 đoạn/);
  assert.throws(
    () => buildConcatAudioArgs([{ file: 'a.mp3', start: 5, end: 5 }], path.join(tmpDir, 'out.mp3')),
    /không hợp lệ/
  );

  const singleArgs = buildConcatAudioArgs([{ file: 'a.mp3', start: 5, end: 15 }], 'out1.mp3', { fadeMs: 0 });
  const singleFc = singleArgs[singleArgs.indexOf('-filter_complex') + 1];
  assert.ok(!singleFc.includes('concat='), '1 đoạn không nên dùng filter concat');
  assert.equal(singleArgs[singleArgs.indexOf('-map') + 1], '[a0]');

  const multiArgs = buildConcatAudioArgs(
    [
      { file: 'a.mp3', start: 2, end: 5 },
      { file: 'b.mp3', start: 1, end: 5 },
    ],
    'out2.mp3',
    { fadeMs: 150 }
  );
  const multiFc = multiArgs[multiArgs.indexOf('-filter_complex') + 1];
  assert.ok(multiFc.includes('concat=n=2:v=0:a=1[aout]'), 'Nhiều đoạn phải dùng concat=n=2:v=0:a=1[aout]');
  assert.ok(multiFc.includes('afade=t=in'), 'fadeMs > 0 phải sinh filter afade');
  console.log('✓ Unit test buildConcatAudioArgs OK');

  // 2. Tạo 2 file MP3 thật bằng ffmpeg-static (15s 440Hz và 10s 660Hz)
  const fileA = path.join(tmpDir, 'a-15s.mp3');
  const fileB = path.join(tmpDir, 'b-10s.mp3');
  await runBin(['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=15', '-c:a', 'libmp3lame', '-b:a', '128k', fileA]);
  await runBin(['-y', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=10', '-c:a', 'libmp3lame', '-b:a', '128k', fileB]);

  // Test 1: Cắt bỏ 5s dạo đầu từ bài 15s (fadeMs = 0)
  const outCutIntro = path.join(tmpDir, 'cut-intro.mp3');
  await concatAudioSegments([{ file: fileA, start: 5, end: 15 }], outCutIntro, { fadeMs: 0 });
  const meta1 = await probe(outCutIntro);
  assert.equal(meta1.hasAudio, true);
  assert.ok(meta1.duration >= 9.8 && meta1.duration <= 10.2, `Kỳ vọng ~10s, nhận ${meta1.duration}s`);
  console.log(`✓ FFmpeg cắt bỏ dạo đầu OK (${meta1.duration.toFixed(2)}s)`);

  // Test 2: Cắt giữ 2 đoạn trong cùng 1 bài (2..5s và 8..12s, fadeMs = 150)
  const outMultiSame = path.join(tmpDir, 'cut-multi-same.mp3');
  await concatAudioSegments(
    [
      { file: fileA, start: 2, end: 5 },
      { file: fileA, start: 8, end: 12 },
    ],
    outMultiSame,
    { fadeMs: 150 }
  );
  const meta2 = await probe(outMultiSame);
  assert.equal(meta2.hasAudio, true);
  assert.ok(meta2.duration >= 6.8 && meta2.duration <= 7.2, `Kỳ vọng ~7s, nhận ${meta2.duration}s`);
  console.log(`✓ FFmpeg cắt nhiều đoạn cùng bài OK (${meta2.duration.toFixed(2)}s)`);

  // Test 3: Ghép 2 bài khác nhau (3s bài A + 4s bài B, fadeMs = 150)
  const outTwoFiles = path.join(tmpDir, 'merge-two.mp3');
  await concatAudioSegments(
    [
      { file: fileA, start: 1, end: 4 },
      { file: fileB, start: 2, end: 6 },
    ],
    outTwoFiles,
    { fadeMs: 150 }
  );
  const meta3 = await probe(outTwoFiles);
  assert.equal(meta3.hasAudio, true);
  assert.ok(meta3.duration >= 6.8 && meta3.duration <= 7.2, `Kỳ vọng ~7s, nhận ${meta3.duration}s`);
  console.log(`✓ FFmpeg ghép 2 file khác nhau OK (${meta3.duration.toFixed(2)}s)`);

  // Test 4: Kiểm thử API thật trên http://127.0.0.1:3001 (nếu server đang chạy), dọn sạch file test sau khi xong
  const baseUrl = 'http://127.0.0.1:3001';
  let serverUp = false;
  try {
    const ping = await fetch(`${baseUrl}/api/state`);
    serverUp = ping.ok;
  } catch {}

  if (serverUp) {
    const createdIds = [];
    try {
      const form = new FormData();
      form.append('file', new Blob([fs.readFileSync(fileA)], { type: 'audio/mpeg' }), 'test-suno-intro-15s.mp3');
      const upRes = await fetch(`${baseUrl}/api/audios`, { method: 'POST', body: form });
      assert.equal(upRes.ok, true, `Upload lỗi HTTP ${upRes.status}`);
      const uploaded = await upRes.json();
      createdIds.push(uploaded.id);

      const concatRes = await fetch(`${baseUrl}/api/audios/concat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          segments: [{ audioId: uploaded.id, start: 5, end: 15 }],
          name: 'test-suno-no-intro',
          fadeMs: 150,
        }),
      });
      const concated = await concatRes.json();
      assert.equal(concatRes.ok, true, `Concat lỗi: ${concated?.error || concatRes.status}`);
      createdIds.push(concated.id);

      assert.ok(concated.id, 'Phải có id mới');
      assert.ok(concated.url, 'Phải có url phát lại');
      assert.ok(concated.duration >= 9.8 && concated.duration <= 10.2, `Duration ~10s, nhận ${concated.duration}`);

      const mediaRes = await fetch(`${baseUrl}${concated.url}`);
      assert.equal(mediaRes.ok, true, `Không tải được audio vừa tạo (${concated.url})`);
      console.log(`✓ Live API POST /api/audios/concat OK (${concated.duration.toFixed(2)}s, đã dọn file test)`);
    } finally {
      for (const id of createdIds) {
        await fetch(`${baseUrl}/api/audios/${id}`, { method: 'DELETE' }).catch(() => {});
      }
    }
  } else {
    console.log('ℹ Backend 127.0.0.1:3001 chưa chạy — bỏ qua live API check');
  }

  console.log('\nTẤT CẢ TEST CẮT & GHÉP NHẠC ĐỀU PASS ✓');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
