// Danh sách quy trình tự động. Thêm quy trình mới: tạo file cùng cấu trúc với dancing.js rồi đăng ký ở đây.
import dancing from './dancing.js';
import thayTrangPhuc from './thay-trang-phuc.js';
import hatNhep from './hat-nhep.js';
import anhModel from './anh-model.js';
import fashionV2v from './fashion-v2v.js';

export const WORKFLOWS = {
  [dancing.id]: dancing,
  [thayTrangPhuc.id]: thayTrangPhuc,
  [hatNhep.id]: hatNhep,
  [fashionV2v.id]: fashionV2v,
  [anhModel.id]: anhModel,
};

// Mô tả gửi cho giao diện (không gồm hàm run)
export const listWorkflows = () =>
  Object.values(WORKFLOWS).map((w) => ({
    id: w.id,
    name: w.name,
    icon: w.icon,
    description: w.description,
    noVideo: !!w.noVideo, // quy trình chỉ làm ảnh, không cần video gốc / đoạn cắt
    inputs: w.inputs, // input có multiple: true -> chọn nhiều ảnh (mảng id)
    perClipInputs: w.perClipInputs || [], // ảnh riêng cho từng đoạn (vd. trang phục của đoạn đó)
    prompts: w.prompts,
    options: w.options,
    stages: w.stages.map((s) => ({ id: s.id, label: s.label })),
  }));
