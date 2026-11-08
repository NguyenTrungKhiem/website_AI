// Lịch sử prompt gốc của từng quy trình: mỗi lần "Lưu lại prompt gốc" (hoặc rollback / khôi phục mặc định),
// prompt đang dùng được chép ra file data/prompt-versions/<quy trình>/<bước>/version_old_<dd-mm-yyyy_hh-mm-ss>.txt
// trước khi bị thay. Người dùng chọn 1 file trong danh sách để quay lại (rollback).
import fs from 'node:fs';
import path from 'node:path';
import { db, save, DATA_DIR } from './db.js';
import { WORKFLOWS } from './workflows/index.js';

const ROOT = path.join(DATA_DIR, 'prompt-versions');
const safe = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '_');
const dirOf = (wfId, key) => path.join(ROOT, safe(wfId), safe(key));
const pad = (n) => String(n).padStart(2, '0');

// Tên file: version_old_dd-mm-yyyy_hh-mm-ss.txt (Windows không cho "/" và ":" trong tên file)
function stamp(d = new Date()) {
  return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}
// Nhãn hiển thị: dd/mm/yyyy hh:mm:ss
function labelOf(file) {
  const m = file.match(/version_old_(\d{2})-(\d{2})-(\d{4})_(\d{2})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}/${m[2]}/${m[3]} ${m[4]}:${m[5]}:${m[6]}` : file;
}

// Prompt đang dùng thật sự của 1 bước: bản đã lưu trong Cài đặt, không có thì bản mặc định trong mã
export function currentPrompt(wfId, key) {
  const saved = (db.settings.workflows?.[wfId]?.prompts?.[key] || '').trim();
  return saved || WORKFLOWS[wfId]?.prompts?.[key]?.text || '';
}

// Chép prompt ra file phiên bản (không ghi file rỗng); trả về tên file hoặc null
export function archivePrompt(wfId, key, text, when = new Date()) {
  const t = (text || '').trim();
  if (!t) return null;
  const dir = dirOf(wfId, key);
  fs.mkdirSync(dir, { recursive: true });
  let file = `version_old_${stamp(when)}.txt`;
  for (let i = 2; fs.existsSync(path.join(dir, file)); i++) file = `version_old_${stamp(when)}_${i}.txt`; // 2 lần lưu trong cùng 1 giây
  fs.writeFileSync(path.join(dir, file), t, 'utf8');
  return file;
}

export function listPromptVersions(wfId, key) {
  const dir = dirOf(wfId, key);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^version_old_.*\.txt$/.test(f))
    .sort()
    .reverse() // mới nhất trước
    .map((file) => {
      const text = fs.readFileSync(path.join(dir, file), 'utf8');
      return { file, label: labelOf(file), preview: text.replace(/\s+/g, ' ').slice(0, 80), length: text.length };
    });
}

export function readPromptVersion(wfId, key, file) {
  if (!/^version_old_[\w-]+\.txt$/.test(file)) throw new Error('Tên phiên bản không hợp lệ');
  const p = path.join(dirOf(wfId, key), file);
  if (!fs.existsSync(p)) throw new Error('Không tìm thấy phiên bản ' + labelOf(file));
  return fs.readFileSync(p, 'utf8');
}

/**
 * Đặt prompt gốc mới cho các bước của 1 quy trình (thay cả bản đang dùng trong hệ thống):
 * mỗi bước đổi nội dung thì prompt cũ được lưu ra file phiên bản trước. `prompts` là toàn bộ các bước
 * đã sửa: thiếu / rỗng = quay về mặc định trong mã. Trả về danh sách bước đã đổi.
 */
export function setWorkflowPrompts(wfId, prompts = {}) {
  const wf = WORKFLOWS[wfId];
  if (!wf) throw new Error('Không có quy trình ' + wfId);
  const next = {};
  const changed = [];
  const when = new Date();
  for (const key of Object.keys(wf.prompts)) {
    const factory = wf.prompts[key].text;
    const old = currentPrompt(wfId, key);
    let text = (prompts[key] || '').trim();
    if (text === factory.trim()) text = ''; // giống mặc định thì không lưu riêng
    const effective = text || factory;
    if (effective.trim() !== old.trim()) { archivePrompt(wfId, key, old, when); changed.push(key); }
    if (text) next[key] = text;
  }
  db.settings.workflows ||= {};
  db.settings.workflows[wfId] = { ...(db.settings.workflows[wfId] || {}), prompts: next };
  save();
  return changed;
}

// Quay lại 1 phiên bản cũ: prompt hiện tại được lưu thành phiên bản mới rồi thay bằng nội dung file
export function rollbackPrompt(wfId, key, file) {
  const text = readPromptVersion(wfId, key, file);
  const prompts = { ...(db.settings.workflows?.[wfId]?.prompts || {}), [key]: text };
  setWorkflowPrompts(wfId, prompts);
  return text;
}
