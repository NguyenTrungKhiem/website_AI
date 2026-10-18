// Danh sách quy trình tự động. Thêm quy trình mới: tạo file cùng cấu trúc với dancing.js rồi đăng ký ở đây.
import dancing from './dancing.js';

export const WORKFLOWS = { [dancing.id]: dancing };

// Mô tả gửi cho giao diện (không gồm hàm run)
export const listWorkflows = () =>
  Object.values(WORKFLOWS).map((w) => ({
    id: w.id,
    name: w.name,
    icon: w.icon,
    description: w.description,
    inputs: w.inputs,
    prompts: w.prompts,
    options: w.options,
    stages: w.stages.map((s) => ({ id: s.id, label: s.label })),
  }));
