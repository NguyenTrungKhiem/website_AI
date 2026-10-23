import os
import sys
import argparse
import urllib.request
import numpy as np
import cv2
import insightface
from insightface.app import FaceAnalysis

MODEL_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "models")
INSWAPPER_PATH = os.path.join(MODEL_DIR, "inswapper_128.onnx")
INSWAPPER_URL = "https://huggingface.co/ezioruan/inswapper_128.onnx/resolve/main/inswapper_128.onnx"

def ensure_model():
    os.makedirs(MODEL_DIR, exist_ok=True)
    if not os.path.exists(INSWAPPER_PATH) or os.path.getsize(INSWAPPER_PATH) < 500_000_000:
        print(f"[face_swap] Downloading inswapper_128.onnx to {INSWAPPER_PATH}...")
        urllib.request.urlretrieve(INSWAPPER_URL, INSWAPPER_PATH)
        print(f"[face_swap] Download completed: {os.path.getsize(INSWAPPER_PATH)} bytes")
    return INSWAPPER_PATH

_app = None
_swapper = None

def get_app():
    global _app
    if _app is None:
        _app = FaceAnalysis(name='buffalo_l', providers=['CPUExecutionProvider'])
        _app.prepare(ctx_id=0, det_size=(640, 640))
    return _app

def get_swapper():
    global _swapper
    if _swapper is None:
        model_path = ensure_model()
        _swapper = insightface.model_zoo.get_model(model_path, download=False, providers=['CPUExecutionProvider'])
    return _swapper

def swap_face_image(source_img_path, target_img_path, output_path):
    app = get_app()
    swapper = get_swapper()

    source_img = cv2.imread(source_img_path)
    if source_img is None:
        raise ValueError(f"Cannot read source image: {source_img_path}")

    target_img = cv2.imread(target_img_path)
    if target_img is None:
        raise ValueError(f"Cannot read target image: {target_img_path}")

    source_faces = app.get(source_img)
    if not source_faces:
        raise ValueError("No face detected in source model image!")
    # Select the largest face in source
    source_face = max(source_faces, key=lambda f: (f.bbox[2]-f.bbox[0]) * (f.bbox[3]-f.bbox[1]))

    target_faces = app.get(target_img)
    if not target_faces:
        print("[face_swap] Warning: No face detected in target image, saving target as-is.")
        cv2.imwrite(output_path, target_img)
        return output_path

    # Swap all faces or main face
    result = target_img.copy()
    for face in target_faces:
        result = swapper.get(result, face, source_face, paste_back=True)

    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    cv2.imwrite(output_path, result)
    print(f"[face_swap] Saved swapped image to: {output_path}")
    return output_path

def swap_face_video(source_img_path, video_path, output_path):
    app = get_app()
    swapper = get_swapper()

    source_img = cv2.imread(source_img_path)
    if source_img is None:
        raise ValueError(f"Cannot read source image: {source_img_path}")
    source_faces = app.get(source_img)
    if not source_faces:
        raise ValueError("No face detected in source model image!")
    source_face = max(source_faces, key=lambda f: (f.bbox[2]-f.bbox[0]) * (f.bbox[3]-f.bbox[1]))

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise ValueError(f"Cannot open video: {video_path}")

    fps = cap.get(cv2.CAP_PROP_FPS) or 25
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    tmp_out = output_path + ".tmp.mp4"
    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
    out = cv2.VideoWriter(tmp_out, fourcc, fps, (width, height))

    print(f"[face_swap] Processing video {video_path} ({total_frames} frames @ {fps:.1f} fps)...", flush=True)
    frame_idx = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        target_faces = app.get(frame)
        res_frame = frame
        for face in target_faces:
            res_frame = swapper.get(res_frame, face, source_face, paste_back=True)
        out.write(res_frame)
        frame_idx += 1
        if frame_idx % 25 == 0:
            print(f"[face_swap] Progress: {frame_idx}/{total_frames} ({frame_idx/total_frames*100:.1f}%)", flush=True)

    cap.release()
    out.release()

    # Mux audio from original video using ffmpeg
    import subprocess
    cmd = [
        "ffmpeg", "-y",
        "-i", tmp_out,
        "-i", video_path,
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-map", "0:v:0",
        "-map", "1:a:0?",
        "-shortest",
        output_path
    ]
    try:
        subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if os.path.exists(tmp_out):
            os.remove(tmp_out)
    except Exception:
        # Fallback if ffmpeg fails
        if os.path.exists(tmp_out):
            if os.path.exists(output_path):
                os.remove(output_path)
            os.rename(tmp_out, output_path)

    print(f"[face_swap] Video processing finished: {output_path}")
    return output_path

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, help="Path to model face image")
    parser.add_argument("--target", help="Path to target image")
    parser.add_argument("--video", help="Path to target video")
    parser.add_argument("--output", required=True, help="Output path")
    args = parser.parse_args()

    if args.target:
        swap_face_image(args.source, args.target, args.output)
    elif args.video:
        swap_face_video(args.source, args.video, args.output)
    else:
        print("Error: either --target or --video must be specified.")
        sys.exit(1)
