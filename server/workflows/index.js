// Danh sách quy trình tự động. Thêm quy trình mới: tạo file cùng cấu trúc với dancing.js rồi đăng ký ở đây.
import dancing from './dancing.js';
import thayTrangPhuc from './thay-trang-phuc.js';
import hatNhep from './hat-nhep.js';
import anhModel from './anh-model.js';
import fashionV2v from './fashion-v2v.js';
import videoThoiTrang from './video-thoi-trang.js';
import videoThoiTrangKhongVoice from './video-thoi-trang-khong-voice.js';
import { db } from '../db.js';

export const WORKFLOWS = {
  [dancing.id]: dancing,
  [thayTrangPhuc.id]: thayTrangPhuc,
  [videoThoiTrang.id]: videoThoiTrang,
  [videoThoiTrangKhongVoice.id]: videoThoiTrangKhongVoice,
  [hatNhep.id]: hatNhep,
  [fashionV2v.id]: fashionV2v,
  [anhModel.id]: anhModel,
};

// Mô tả gửi cho giao diện (không gồm hàm run)
export const listWorkflows = () =>
  Object.values(WORKFLOWS).map((w) => {
    const saved = db.settings?.workflows?.[w.id]?.prompts || {};
    const mergedPrompts = {};
    for (const [k, p] of Object.entries(w.prompts || {})) {
      mergedPrompts[k] = {
        ...p,
        text: (saved[k] || '').trim() || p.text,
        factoryText: p.text,
        isCustom: !!(saved[k] && saved[k].trim() && saved[k].trim() !== p.text.trim()),
      };
    }
    return {
      id: w.id,
      name: w.name,
      icon: w.icon,
      description: w.description,
      noVideo: !!w.noVideo, // quy trình chỉ làm ảnh, không cần video gốc / đoạn cắt
      codedInput: w.codedInput || null, // key input mà mỗi ảnh có mã sản phẩm (giao diện hiện ô sửa mã)
      backInput: w.backInput || null, // key inputs chứa ảnh mặt sau theo từng ảnh mặt trước ({ frontId: backId })
      captionModes: !!w.captionModes, // chọn chữ trên video: mã sản phẩm / chữ tuỳ ý / không chữ
      inputs: w.inputs, // input có multiple: true -> chọn nhiều ảnh (mảng id); max = số ảnh tối đa
      perClipInputs: w.perClipInputs || [], // ảnh riêng cho từng đoạn (vd. trang phục của đoạn đó)
      prompts: mergedPrompts,
      options: w.options,
      stages: w.stages.map((s) => ({ id: s.id, label: s.label })),
    };
  });
