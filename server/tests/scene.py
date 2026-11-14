import os, sys
import cv2
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import synthetic_test as T  # noqa: E402


def make_scene(images_dir, scene_path, n=24):
    os.makedirs(images_dir, exist_ok=True)
    Rs, ts = [], []
    for i in range(n):
        ang = 2 * np.pi * i / n
        elev = 0.35 + 0.15 * np.sin(3 * ang)
        C = 4.0 * np.array([np.cos(ang) * np.cos(elev), np.sin(elev), np.sin(ang) * np.cos(elev)])
        R, t = T.make_cam(C)
        img, _ = T.render(R, t, ground=True)
        cv2.imwrite(os.path.join(images_dir, f"{i:04d}.jpg"), img, [cv2.IMWRITE_JPEG_QUALITY, 95])
        Rs.append(R); ts.append(t)
    rng = np.random.default_rng(0)
    q = rng.normal(size=(2500, 3)); q /= np.linalg.norm(q, axis=1, keepdims=True)
    gp = np.stack([rng.uniform(-3, 3, 2000), np.full(2000, -1.0), rng.uniform(-3, 3, 2000)], 1)
    np.savez(scene_path, R=np.array(Rs), t=np.array(ts), K=T.K, W=T.W, H=T.H, points=np.vstack([q, gp]))
