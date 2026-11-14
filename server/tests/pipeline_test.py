"""Проверка склейки пайплайна на синтетической сцене с поддельным COLMAP.
Запуск:  python -I tests/pipeline_test.py   (из папки server)"""
import os
import sys
import tempfile
import threading

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)
import synthetic_test as T  # noqa: E402

tmp = tempfile.mkdtemp()
job = os.path.join(tmp, "job")
os.makedirs(os.path.join(job, "images"))
Rs, ts = [], []
for i in range(24):
    ang = 2 * np.pi * i / 24
    elev = 0.35 + 0.15 * np.sin(3 * ang)
    C = 4.0 * np.array([np.cos(ang) * np.cos(elev), np.sin(elev), np.sin(ang) * np.cos(elev)])
    R, t = T.make_cam(C)
    img, _ = T.render(R, t, ground=True)
    cv2.imwrite(os.path.join(job, "images", f"{i:04d}.jpg"), img, [cv2.IMWRITE_JPEG_QUALITY, 95])
    Rs.append(R); ts.append(t)
rng = np.random.default_rng(0)
q = rng.normal(size=(2500, 3)); q /= np.linalg.norm(q, axis=1, keepdims=True)
gp = np.stack([rng.uniform(-3, 3, 2000), np.full(2000, -1.0), rng.uniform(-3, 3, 2000)], 1)
# в сцене «вверх» не совпадает с осью Y: повернём мир, как это сделал бы COLMAP
a = np.radians(40)
Qw = np.array([[1, 0, 0], [0, np.cos(a), -np.sin(a)], [0, np.sin(a), np.cos(a)]])
Rs = [R @ Qw.T for R in Rs]
np.savez(os.path.join(tmp, "scene.npz"), R=np.array(Rs), t=np.array(ts), K=T.K, W=T.W, H=T.H,
         points=np.vstack([q, gp]) @ Qw.T)

os.environ["FAKE_SCENE"] = os.path.join(tmp, "scene.npz")
os.environ["MIN_IMAGE_SIDE"] = "200"
os.environ["COLMAP_BIN"] = os.path.join(HERE, "fake_colmap.py")
from app import pipeline  # noqa: E402

log = []
res = pipeline.run(job, dict(quality="fast", crop=True),
                   lambda s, f, m: log.append((s, round(f, 2))), threading.Event())
print("результат:", res)
stages = []
for s, _ in log:
    if not stages or stages[-1] != s:
        stages.append(s)
print("этапы:", stages, "прогресс монотонен:", all(b[1] >= a_[1] - 1e-9 for a_, b in zip(log, log[1:])))
glb = os.path.join(job, "out", "model.glb")
print("glb:", os.path.getsize(glb), "байт")

import struct, json  # noqa: E402
b = open(glb, "rb").read()
jl = struct.unpack("<I", b[12:16])[0]
g = json.loads(b[20:20 + jl])
mn, mx = np.array(g["accessors"][1]["min"]), np.array(g["accessors"][1]["max"])
print("габариты (должна быть сфера, max=1):", np.round(mx - mn, 3))
