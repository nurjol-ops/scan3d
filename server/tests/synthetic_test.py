"""Проверка плотной реконструкции на синтетической сцене (без COLMAP).

Рендерим текстурированную сферу (радиус 1) с 24 камер по кругу, прогоняем
оценку глубины -> TSDF -> меш и сравниваем радиус вершин с эталоном.

Запуск:  python -I tests/synthetic_test.py   (из папки server)
"""
import os
import sys
import time

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from app import dense, fusion, meshio  # noqa: E402

W, H, F = 320, 240, 300.0
K = np.array([[F, 0, W / 2 - 0.5], [0, F, H / 2 - 0.5], [0, 0, 1.0]])


def texture(p):
    x, y, z = p[..., 0], p[..., 1], p[..., 2]
    r = 0.5 + 0.5 * np.sin(9 * x + 3 * np.sin(6 * y + 2 * z))
    g = 0.5 + 0.5 * np.sin(8 * y + 4 * np.sin(5 * z + x))
    b = 0.5 + 0.5 * np.sin(10 * z + 3 * np.sin(7 * x + y))
    fine = 0.15 * np.sin(31 * x + 17 * y) * np.sin(23 * z)
    return np.clip(np.stack([r, g, b], -1) + fine[..., None], 0, 1)


def make_cam(C, target=np.zeros(3), up=np.array([0, 1.0, 0])):
    z = target - C
    z /= np.linalg.norm(z)
    y = -(up - (up @ z) * z)
    y /= np.linalg.norm(y)
    x = np.cross(y, z)
    R = np.stack([x, y, z])
    return R, -R @ C


def render(R, t, ground=False):
    C = -R.T @ t
    u, v = np.meshgrid(np.arange(W), np.arange(H))
    dc = np.stack([(u - K[0, 2]) / F, (v - K[1, 2]) / F, np.ones_like(u, float)], -1)
    d = dc @ R                                  # направления в мире (z-глубина = параметр луча)
    a = (d * d).sum(-1)
    b = d @ C
    c = C @ C - 1.0
    disc = b * b - a * c
    hit = disc > 0
    s = np.where(hit, (-b - np.sqrt(np.maximum(disc, 0))) / a, np.inf)
    s[s <= 0] = np.inf
    img = np.full((H, W, 3), 0.35)
    depth = np.full((H, W), np.inf)
    if ground:                                  # плоскость y = -1
        with np.errstate(divide="ignore", invalid="ignore"):
            sg = (-1.0 - C[1]) / d[..., 1]
        sg = np.where((sg > 0) & np.isfinite(sg), sg, np.inf)
        pg = C + d * sg[..., None]
        gimg = texture(pg * 1.3)
        m = np.isfinite(sg)
        img[m] = gimg[m]
        depth[m] = sg[m]
    m = np.isfinite(s) & (s < depth)
    p = C + d * np.where(m, s, 0)[..., None]
    img[m] = texture(p)[m]
    depth[m] = s[m]
    return (img * 255).astype(np.uint8)[..., ::-1].copy(), depth


def main(ground=False):
    views = []
    n = 24
    for i in range(n):
        ang = 2 * np.pi * i / n
        elev = 0.35 + 0.15 * np.sin(3 * ang)
        C = 4.0 * np.array([np.cos(ang) * np.cos(elev), np.sin(elev), np.sin(ang) * np.cos(elev)])
        R, t = make_cam(C)
        img, _ = render(R, t, ground)
        views.append(dense.View(f"{i:03d}", img, K, R, t))

    rng = np.random.default_rng(0)
    q = rng.normal(size=(4000, 3))
    pts = q / np.linalg.norm(q, axis=1, keepdims=True)
    if ground:
        gp = np.stack([rng.uniform(-3, 3, 3000), np.full(3000, -1.0), rng.uniform(-3, 3, 3000)], 1)
        pts = np.vstack([pts, gp])

    t0 = time.time()
    dense.estimate_depths(views, pts, planes=64)
    t1 = time.time()
    # качество глубины на пикселях сферы
    errs, cover = [], []
    for v in views[:6]:
        _, gt = render(v.R, v.t, ground)
        m = np.isfinite(gt) & (gt < 5) & (v.depth > 0)
        sphere = np.isfinite(gt)
        cover.append(m.sum() / max(1, sphere.sum()))
        errs.append(np.abs(v.depth[m] - gt[m]))
    errs = np.concatenate(errs)
    print(f"глубина: {t1 - t0:.1f}s, покрытие {np.mean(cover):.2f}, "
          f"медианная ошибка {np.median(errs):.4f}, p90 {np.percentile(errs, 90):.4f}")

    lo, hi = fusion.object_bbox(pts, views)
    print("bbox", np.round(lo, 2), np.round(hi, 2))
    vol = fusion.Volume(lo, hi, 128)
    focus = dense.focus_point(views)
    up = dense.world_up(views)
    print("up", np.round(up, 2), "focus", np.round(focus, 2))
    plane = fusion.fit_support_plane(pts, up, focus, tol=0.03)
    print("опорная плоскость:", None if plane is None else (np.round(plane[0], 2), round(plane[1], 3)))
    t2 = time.time()
    for v in views:
        vol.integrate(v)
    if plane is not None:
        vol.cut_below(plane[0], plane[1], 2.0 * vol.voxel)
    print(f"TSDF: {time.time() - t2:.1f}s, dims={vol.dims}")
    res = vol.extract_mesh()
    assert res is not None, "mesh is None"
    verts, faces, cols = res
    verts, faces, cols = fusion.keep_large_components(verts, faces, cols)
    verts = fusion.smooth(verts, faces)
    faces = fusion.orient_outward(verts, faces)
    r = np.linalg.norm(verts, axis=1)
    print(f"меш: {len(verts)} вершин, {len(faces)} граней")
    print(f"радиус: среднее {r.mean():.3f}, медиана {np.median(r):.3f}, std {r.std():.3f}, min {r.min():.3f}, max {r.max():.3f}")
    for fmt, fn in (("glb", meshio.write_glb), ("ply", meshio.write_ply),
                    ("stl", meshio.write_stl), ("obj", meshio.write_obj)):
        p = f"/tmp/synthetic_out.{fmt}"
        fn(p, verts.astype(np.float32), faces, cols)
        print(fmt, os.path.getsize(p), "bytes")
    return r


if __name__ == "__main__":
    main(ground=("--ground" in sys.argv))
