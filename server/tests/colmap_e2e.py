"""Сквозной тест с НАСТОЯЩИМ COLMAP (запускается в Docker-образе в GitHub Actions).
Рендерит текстурированную сферу на столе с 36 ракурсов (две высоты), прогоняет весь пайплайн
и проверяет, что получилась модель, похожая на сферу.

Запуск в контейнере:  python tests/colmap_e2e.py"""
import os
import sys
import tempfile
import threading
import time

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)
import synthetic_test as T  # noqa: E402

W, H = 800, 600
F = 0.9 * W
T.W, T.H, T.F = W, H, F
T.K = np.array([[F, 0, W / 2 - 0.5], [0, F, H / 2 - 0.5], [0, 0, 1.0]])


def hash3(i, j, k, seed):
    v = np.sin(i * 12.9898 + j * 78.233 + k * 37.719 + seed * 4.1) * 43758.5453
    return v - np.floor(v)


def texture(p):
    """Пятнистая текстура: случайный цвет в ячейках двух масштабов + плавный градиент."""
    out = np.zeros(p.shape[:-1] + (3,))
    for scale, wgt in ((9.0, 0.55), (23.0, 0.45)):
        q = np.floor(p * scale)
        for c in range(3):
            out[..., c] += wgt * hash3(q[..., 0], q[..., 1], q[..., 2], c + scale)
    return np.clip(0.15 + 0.85 * out, 0, 1)


T.texture = texture


def main():
    tmp = tempfile.mkdtemp()
    img_dir = os.path.join(tmp, "job", "images")
    os.makedirs(img_dir)
    i = 0
    for elev in (0.3, 0.75):
        for k in range(18):
            ang = 2 * np.pi * k / 18 + elev
            C = 3.6 * np.array([np.cos(ang) * np.cos(elev), np.sin(elev), np.sin(ang) * np.cos(elev)])
            R, t = T.make_cam(C)
            img, _ = T.render(R, t, ground=True)
            cv2.imwrite(os.path.join(img_dir, f"{i:04d}.jpg"), img, [cv2.IMWRITE_JPEG_QUALITY, 92])
            i += 1
    print(f"сгенерировано {i} кадров {W}x{H}")
    if "--render-only" in sys.argv:
        print(img_dir)
        return

    from app import pipeline
    t0 = time.time()
    last = {"s": None}

    def report(stage, frac, text):
        if stage != last["s"]:
            print(f"[{time.time() - t0:6.1f}s] {stage}: {text}", flush=True)
            last["s"] = stage

    res = pipeline.run(os.path.join(tmp, "job"), {"quality": "fast", "crop": True}, report, threading.Event())
    print("результат:", res, f"за {time.time() - t0:.0f} с")
    assert res["cameras"] >= 30, "COLMAP зарегистрировал слишком мало камер"
    assert res["faces"] > 2000, "слишком маленькая модель"

    # грубая проверка формы: в нормированных координатах модель должна быть «шаром»
    import struct, json
    b = open(os.path.join(tmp, "job", "out", "model.glb"), "rb").read()
    jl = struct.unpack("<I", b[12:16])[0]
    g = json.loads(b[20:20 + jl])
    ext = np.array(g["accessors"][1]["max"]) - np.array(g["accessors"][1]["min"])
    print("габариты модели:", np.round(ext, 3))
    assert ext.min() > 0.6, "модель сплющена, похоже на неудачу реконструкции"
    print("COLMAP E2E: OK")


if __name__ == "__main__":
    main()
