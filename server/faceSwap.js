import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const SCRIPT_PATH = path.resolve('scripts/face_swap.py');

/**
 * Hoán đổi khuôn mặt trên ảnh đơn (Keyframe).
 * @param {string} sourceModelPath - Đường dẫn ảnh chân dung model
 * @param {string} targetImagePath - Đường dẫn ảnh khung hình đích (frame từ video)
 * @param {string} outputPath - Đường dẫn lưu ảnh kết quả
 * @returns {Promise<string>}
 */
export function swapFaceImage(sourceModelPath, targetImagePath, outputPath) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(sourceModelPath)) return reject(new Error(`Không tìm thấy ảnh model: ${sourceModelPath}`));
    if (!fs.existsSync(targetImagePath)) return reject(new Error(`Không tìm thấy ảnh đích: ${targetImagePath}`));

    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const proc = spawn('python', [
      SCRIPT_PATH,
      '--source', path.resolve(sourceModelPath),
      '--target', path.resolve(targetImagePath),
      '--output', path.resolve(outputPath),
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputPath)) {
        resolve(outputPath);
      } else {
        reject(new Error(`Face swap image thất bại (code ${code}): ${stderr || stdout}`));
      }
    });

    proc.on('error', (err) => reject(err));
  });
}

/**
 * Hoán đổi khuôn mặt trên toàn bộ video (từng khung hình).
 * @param {string} sourceModelPath - Đường dẫn ảnh chân dung model
 * @param {string} targetVideoPath - Đường dẫn video đích
 * @param {string} outputPath - Đường dẫn lưu video kết quả
 * @param {Function} [onProgress] - Callback báo tiến độ (percentage 0-100, message)
 * @returns {Promise<string>}
 */
export function swapFaceVideo(sourceModelPath, targetVideoPath, outputPath, onProgress) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(sourceModelPath)) return reject(new Error(`Không tìm thấy ảnh model: ${sourceModelPath}`));
    if (!fs.existsSync(targetVideoPath)) return reject(new Error(`Không tìm thấy video đích: ${targetVideoPath}`));

    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const proc = spawn('python', [
      SCRIPT_PATH,
      '--source', path.resolve(sourceModelPath),
      '--video', path.resolve(targetVideoPath),
      '--output', path.resolve(outputPath),
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => {
      const str = d.toString();
      stdout += str;
      const m = str.match(/Progress:\s+(\d+)\/(\d+)\s+\(([\d.]+)%\)/);
      if (m && onProgress) {
        onProgress(parseFloat(m[3]), `Đang ghép mặt: ${m[1]}/${m[2]} khung hình (${m[3]}%)`);
      }
    });

    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputPath)) {
        resolve(outputPath);
      } else {
        reject(new Error(`Face swap video thất bại (code ${code}): ${stderr || stdout}`));
      }
    });

    proc.on('error', (err) => reject(err));
  });
}
