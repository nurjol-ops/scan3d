#!/usr/bin/env python3
"""Поддельный COLMAP для проверки «склейки» пайплайна без настоящего COLMAP.
Читает сцену из $FAKE_SCENE (npz: R, t, K, W, H, points) и пишет файлы в формате COLMAP."""
import os
import shutil
import sys

import numpy as np

cmd = sys.argv[1] if len(sys.argv) > 1 else ""
args = sys.argv[2:]


def arg(name, default=None):
    return args[args.index(name) + 1] if name in args else default


def rot_to_q(R):
    # стандартное преобразование матрица -> кватернион (w, x, y, z)
    t = np.trace(R)
    if t > 0:
        s = np.sqrt(t + 1) * 2
        return [0.25 * s, (R[2, 1] - R[1, 2]) / s, (R[0, 2] - R[2, 0]) / s, (R[1, 0] - R[0, 1]) / s]
    i = np.argmax(np.diag(R))
    j, k = (i + 1) % 3, (i + 2) % 3
    s = np.sqrt(R[i, i] - R[j, j] - R[k, k] + 1) * 2
    q = [0, 0, 0, 0]
    q[0] = (R[k, j] - R[j, k]) / s
    q[1 + i] = 0.25 * s
    q[1 + j] = (R[j, i] + R[i, j]) / s
    q[1 + k] = (R[k, i] + R[i, k]) / s
    return q


if cmd == "feature_extractor" and "-h" in args:
    print("  --SiftExtraction.use_gpu\n  --SiftExtraction.max_image_size")
elif cmd in ("feature_extractor", "exhaustive_matcher"):
    print("Processed file [1/1]")
elif cmd == "mapper":
    out = os.path.join(arg("--output_path"), "0")
    os.makedirs(out, exist_ok=True)
    for n in ("cameras.bin", "images.bin", "points3D.bin"):
        open(os.path.join(out, n), "wb").write(b"x" * 100)
    print("Registering image #1 (1)")
elif cmd == "image_undistorter":
    out = arg("--output_path")
    os.makedirs(os.path.join(out, "images"), exist_ok=True)
    os.makedirs(os.path.join(out, "sparse"), exist_ok=True)
    src = arg("--image_path")
    for f in sorted(os.listdir(src)):
        shutil.copy(os.path.join(src, f), os.path.join(out, "images", f))
    open(os.path.join(out, "sparse", "cameras.bin"), "wb").write(b"x" * 10)
elif cmd == "model_converter":
    sc = np.load(os.environ["FAKE_SCENE"])
    out = arg("--output_path")
    os.makedirs(out, exist_ok=True)
    K, W, H = sc["K"], int(sc["W"]), int(sc["H"])
    with open(os.path.join(out, "cameras.txt"), "w") as fh:
        fh.write("# Camera list\n")
        fh.write(f"1 PINHOLE {W} {H} {K[0,0]} {K[1,1]} {K[0,2] + 0.5} {K[1,2] + 0.5}\n")
    names = sorted(os.listdir(os.path.join(os.path.dirname(arg('--input_path')), "images")))
    with open(os.path.join(out, "images.txt"), "w") as fh:
        fh.write("# Image list\n")
        for i, name in enumerate(names):
            q = rot_to_q(sc["R"][i]); t = sc["t"][i]
            fh.write(f"{i+1} {q[0]} {q[1]} {q[2]} {q[3]} {t[0]} {t[1]} {t[2]} 1 {name}\n")
            fh.write("10.0 20.0 1\n")
    with open(os.path.join(out, "points3D.txt"), "w") as fh:
        fh.write("# 3D point list\n")
        for i, p in enumerate(sc["points"]):
            fh.write(f"{i+1} {p[0]} {p[1]} {p[2]} 128 128 128 0.5 1 1 2 2 3 3\n")
else:
    print("fake colmap: unknown command", cmd, file=sys.stderr)
    sys.exit(2)
