// Danh sách quy trình tự động. Thêm quy trình mới: tạo file cùng cấu trúc với dancing.js rồi đăng ký ở đây.
import dancing from './dancing.js';
import thayTrangPhuc from './thay-trang-phuc.js';
import hatNhep from './hat-nhep.js';
import anhModel from './anh-model.js';
import anhModelNam from './anh-model-nam.js';
import fashionV2v from './fashion-v2v.js';
import videoThoiTrang from './video-thoi-trang.js';
import videoThoiTrangKhongVoice from './video-thoi-trang-khong-voice.js';
import videoThoiTrangKhongVoiceNam from './video-thoi-trang-khong-voice-nam.js';
import videoTapGym from './video-tap-gym.js';
import nhacSuno from './nhac-suno.js';
import { db } from '../db.js';

export const WORKFLOWS = {
  [dancing.id]: dancing,
  [thayTrangPhuc.id]: thayTrangPhuc,
  [videoThoiTrang.id]: videoThoiTrang,
  [videoThoiTrangKhongVoice.id]: videoThoiTrangKhongVoice,
  [videoThoiTrangKhongVoiceNam.id]: videoThoiTrangKhongVoiceNam,
  [videoTapGym.id]: videoTapGym,
  [nhacSuno.id]: nhacSuno,
  [hatNhep.id]: hatNhep,
  [fashionV2v.id]: fashionV2v,
  [anhModel.id]: anhModel,
  [anhModelNam.id]: anhModelNam,
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
      sunoMode: !!w.sunoMode, // quy trình Nhạc Suno (chọn MP3 + phân tích Gemini Web ngầm)
      codedInput: w.codedInput || null, // key input mà mỗi ảnh có mã sản phẩm (giao diện hiện ô sửa mã)
      backInput: w.backInput || null, // key inputs chứa ảnh mặt sau theo từng ảnh mặt trước ({ frontId: backId })
      captionModes: !!w.captionModes, // chọn chữ trên video: mã sản phẩm / chữ tuỳ ý / không chữ
      // Ô nhập tên động tác + nút gọi Gemini viết prompt mới từ prompt gốc (vd. Video tập gym): { baseKey, defaultExercise, placeholder }
      promptWriter: w.promptWriter || null,
      // Nhóm tab: các quy trình cùng tab.group gom thành 1 mục menu (tên tab.title), trong trang có nút tab theo tab.label
      tab: w.tab || null,
      // Khối outfit nhiều món (tab Nam): { key, slots: [{ key, label }] } -> inputs[key] = [{ items: { slot: { front, back } }, style, main }]
      outfitSets: w.outfitSets || null,
      // Khối Bộ trang phục (Ảnh model mặc đồ Nữ/Nam): { key, gender, slots, stylePresets }
      modelOutfits: w.modelOutfits || null,
      runLabel: w.runLabel || null, // chữ trên nút chạy (mặc định "▶ Chạy <tên quy trình>")
      inputs: w.inputs, // input có multiple: true -> chọn nhiều ảnh (mảng id); max = số ảnh tối đa
      perClipInputs: w.perClipInputs || [], // ảnh riêng cho từng đoạn (vd. trang phục của đoạn đó)
      prompts: mergedPrompts,
      options: w.options,
      stages: w.stages.map((s) => ({ id: s.id, label: s.label })),
    };
  });
