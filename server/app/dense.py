"""Плотные карты глубины на CPU (multi-view plane sweep, ZNCC).

COLMAP на CPU умеет только разреженную реконструкцию (плотная требует CUDA),
поэтому плотную часть делаем сами на OpenCV + numpy.

Соглашение: пиксельные центры в целых координатах (как в OpenCV).
"""
import cv2
import numpy as np


class View:
    def __init__(self, name, img_bgr, K, R, t):
        self.name = name
        self.img = img_bgr                       # uint8 BGR
        self.gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0
        self.h, self.w = self.gray.shape
        self.K = np.asarray(K, dtype=np.float64)
        self.R = np.asarray(R, dtype=np.float64)  # X_cam = R X_world + t
        self.t = np.asarray(t, dtype=np.float64)
        self.C = -self.R.T @ self.t               # центр камеры в мире
        self.depth = None
        self.conf = None

    def rotate_world(self, Q):
        """Поворачивает мировую систему координат: X' = Q X."""
        self.R = self.R @ Q.T
        self.C = Q @ self.C


def view_from_colmap(name, img_bgr, cam, R, t, max_side):
    """cam: dict PINHOLE из COLMAP (fx, fy, cx, cy; центр пикселя в координатах +0.5).
    Размер cam['w'] x cam['h'] может отличаться от размера файла - масштабируем интринсики."""
    fx, fy, cx, cy = cam["params"][:4]
    h, w = img_bgr.shape[:2]
    s = min(1.0, max_side / float(max(h, w)))
    if s < 1.0:
        img_bgr = cv2.resize(img_bgr, (int(round(w * s)), int(round(h * s))), interpolation=cv2.INTER_AREA)
    h2, w2 = img_bgr.shape[:2]
    sx, sy = w2 / float(cam["w"]), h2 / float(cam["h"])
    K = np.array([[fx * sx, 0, cx * sx - 0.5],
                  [0, fy * sy, cy * sy - 0.5],
                  [0, 0, 1.0]])
    return View(name, img_bgr, K, R, t)


def focus_point(views):
    """Точка, ближайшая ко всем оптическим осям камер (центр объекта съёмки)."""
    A = np.zeros((3, 3))
    b = np.zeros(3)
    for v in views:
        d = v.R[2, :]                       # направление взгляда в мире
        P = np.eye(3) - np.outer(d, d)
        A += P
        b += P @ v.C
    return np.linalg.lstsq(A, b, rcond=None)[0]


def world_up(views):
    up = np.zeros(3)
    for v in views:
        up += -v.R[1, :]                    # ось y камеры смотрит вниз
    n = np.linalg.norm(up)
    return up / n if n > 1e-9 else np.array([0, 1.0, 0])


def choose_neighbors(views, focus, max_src=4, min_deg=3.0, max_deg=45.0):
    """Для каждого вида выбирает соседей с подходящим углом между направлениями на объект."""
    dirs = []
    for v in views:
        d = v.C - focus
        dirs.append(d / (np.linalg.norm(d) + 1e-12))
    dirs = np.array(dirs)
    res = []
    for i in range(len(views)):
        cosang = np.clip(dirs @ dirs[i], -1, 1)
        ang = np.degrees(np.arccos(cosang))
        cand = [(a, j) for j, a in enumerate(ang) if j != i and min_deg <= a <= max_deg]
        cand.sort()
        res.append([j for _, j in cand[:max_src]])
    return res


def depth_range(view, points):
    """Диапазон глубин по разреженным точкам, видимым в кадре."""
    Xc = points @ view.R.T + view.t
    z = Xc[:, 2]
    ok = z > 1e-6
    u = view.K[0, 0] * Xc[:, 0] / np.where(ok, z, 1) + view.K[0, 2]
    v = view.K[1, 1] * Xc[:, 1] / np.where(ok, z, 1) + view.K[1, 2]
    ok &= (u >= 0) & (u < view.w) & (v >= 0) & (v < view.h)
    if ok.sum() < 15:
        return None
    zs = z[ok]
    return float(np.percentile(zs, 2)) * 0.85, float(np.percentile(zs, 98)) * 1.15


def _box(a, win):
    return cv2.boxFilter(a, -1, (win, win), normalize=True, borderType=cv2.BORDER_REPLICATE)


def plane_sweep(ref, srcs, dmin, dmax, planes=64, win=5, min_conf=0.55):
    """Возвращает (depth, conf) для опорного вида. depth=0 там, где результат ненадёжен."""
    h, w = ref.h, ref.w
    rg = ref.gray
    mr = _box(rg, win)
    vr = np.maximum(_box(rg * rg, win) - mr * mr, 0)

    inv = np.linspace(1.0 / dmax, 1.0 / dmin, planes)   # равномерно по обратной глубине
    depths = 1.0 / inv
    Kinv = np.linalg.inv(ref.K)
    vol = np.empty((planes, h, w), np.float32)
    flags = cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP

    rel = []
    for s in srcs:
        Rr = s.R @ ref.R.T
        tr = s.t - Rr @ ref.t
        rel.append((Rr, tr))
    n = np.array([[0.0, 0.0, 1.0]])

    for di, d in enumerate(depths):
        costs = []
        for s, (Rr, tr) in zip(srcs, rel):
            H = s.K @ (Rr + (tr.reshape(3, 1) @ n) / d) @ Kinv
            # граница заполняется -1: так по одному каналу получаем и яркость, и маску валидности
            wg = cv2.warpPerspective(s.gray, H, (w, h), flags=flags,
                                     borderMode=cv2.BORDER_CONSTANT, borderValue=-1.0)
            wm = (wg >= 0).astype(np.float32)
            wg = np.maximum(wg, 0.0)
            mw = _box(wg, win)
            vw = np.maximum(_box(wg * wg, win) - mw * mw, 0)
            cov = _box(rg * wg, win) - mr * mw
            ncc = cov / np.sqrt(vr * vw + 1e-7)
            cost = 1.0 - np.clip(ncc, -1, 1)
            cost[_box(wm, win) < 0.98] = 2.0       # окно выходит за пределы второго кадра
            costs.append(cost)
        c = np.sort(np.stack(costs, 0), axis=0)
        k = 1 if len(srcs) == 1 else 2             # берём лучшие 2 (устойчиво к перекрытиям)
        vol[di] = c[:k].mean(axis=0)

    idx = np.argmin(vol, axis=0)
    best = np.take_along_axis(vol, idx[None], 0)[0]
    # субплоскостное уточнение параболой
    i0 = np.clip(idx - 1, 0, planes - 1)
    i2 = np.clip(idx + 1, 0, planes - 1)
    c0 = np.take_along_axis(vol, i0[None], 0)[0]
    c2 = np.take_along_axis(vol, i2[None], 0)[0]
    den = c0 - 2 * best + c2
    safe = np.where(np.abs(den) > 1e-6, den, 1.0)
    off = np.where(np.abs(den) > 1e-6, 0.5 * (c0 - c2) / safe, 0.0)
    off = np.clip(off, -0.5, 0.5)
    step = (inv[-1] - inv[0]) / (planes - 1)
    inv_d = inv[idx] + off * step
    depth = (1.0 / np.maximum(inv_d, 1e-9)).astype(np.float32)

    conf = (1.0 - best).astype(np.float32)
    valid = (conf > min_conf) & (vr > 4e-5) & (idx > 0) & (idx < planes - 1)
    # отсекаем одиночные пиксели
    valid = cv2.morphologyEx(valid.astype(np.uint8), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8)).astype(bool)
    dm = cv2.medianBlur(depth, 5)
    valid &= np.abs(dm - depth) < 0.03 * dm          # убираем выбросы относительно медианы
    depth = np.where(valid, dm, 0).astype(np.float32)
    conf = np.where(valid, np.clip(conf, 0, 1), 0).astype(np.float32)
    return depth, conf


def consistency_filter(views, nbrs, rel_tol=0.02, min_agree=2):
    """Оставляет только те пиксели глубины, которые согласуются с соседними видами:
    точка, перенесённая в соседний кадр, должна иметь там ту же глубину (в пределах rel_tol).
    Убирает выбросы у силуэтов, которые иначе «прорезают» объект при слиянии."""
    new_depth = []
    for i, v in enumerate(views):
        d_ref = v.depth
        if d_ref is None or not nbrs[i]:
            new_depth.append(np.zeros_like(d_ref) if d_ref is not None else None)
            continue
        ys, xs = np.nonzero(d_ref > 0)
        if len(ys) == 0:
            new_depth.append(d_ref)
            continue
        d = d_ref[ys, xs].astype(np.float64)
        Xc = np.stack([(xs - v.K[0, 2]) / v.K[0, 0] * d,
                       (ys - v.K[1, 2]) / v.K[1, 1] * d, d], axis=1)
        Xw = (Xc - v.t) @ v.R
        agree = np.zeros(len(d), np.int32)
        for j in nbrs[i]:
            s = views[j]
            Xs = Xw @ s.R.T + s.t
            z = Xs[:, 2]
            ok = z > 1e-6
            zs = np.where(ok, z, 1.0)
            u = np.rint(s.K[0, 0] * Xs[:, 0] / zs + s.K[0, 2]).astype(np.int64)
            w_ = np.rint(s.K[1, 1] * Xs[:, 1] / zs + s.K[1, 2]).astype(np.int64)
            ok &= (u >= 0) & (u < s.w) & (w_ >= 0) & (w_ < s.h)
            ds = np.zeros(len(d))
            ds[ok] = s.depth[w_[ok], u[ok]]
            agree += (ok & (ds > 0) & (np.abs(ds - z) < rel_tol * z)).astype(np.int32)
        keep = agree >= min(min_agree, len(nbrs[i]))
        out = np.zeros_like(d_ref)
        out[ys[keep], xs[keep]] = d_ref[ys[keep], xs[keep]]
        new_depth.append(out)
    for v, nd in zip(views, new_depth):
        if nd is not None:
            v.depth = nd
            v.conf = np.where(nd > 0, v.conf, 0).astype(np.float32)


def grazing_weight(view, min_cos=0.3):
    """Вес пикселя по углу между поверхностью и лучом (из градиента глубины).
    На скользящих углах (край силуэта) глубина по ближайшему пикселю ненадёжна."""
    d = view.depth.astype(np.float64)
    valid = d > 0
    # пиксель годен, только если все 8 соседей тоже имеют глубину (иначе это край)
    inner = cv2.erode(valid.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool)
    dz = np.where(valid, d, np.nan)
    gx = np.zeros_like(d)
    gy = np.zeros_like(d)
    gx[:, 1:-1] = (dz[:, 2:] - dz[:, :-2]) / 2.0
    gy[1:-1, :] = (dz[2:, :] - dz[:-2, :]) / 2.0
    with np.errstate(invalid="ignore", divide="ignore"):
        scale = view.K[0, 0] / np.where(valid, d, 1.0)
        tan2 = (gx * gx + gy * gy) * scale * scale
        cos = 1.0 / np.sqrt(1.0 + np.nan_to_num(tan2, nan=1e6))
    ok = inner & (cos >= min_cos)
    view.depth = np.where(ok, view.depth, 0).astype(np.float32)
    view.conf = np.where(ok, view.conf * (cos ** 2), 0).astype(np.float32)


def estimate_depths(views, points, progress=None, cancel=None, planes=64, max_src=4):
    """Считает карты глубины для всех видов. Записывает view.depth / view.conf."""
    focus = focus_point(views)
    nbrs = choose_neighbors(views, focus, max_src=max_src)
    # запасной диапазон глубин, если в кадре мало разреженных точек
    dist = np.array([np.linalg.norm(v.C - focus) for v in views])
    ok_count = 0
    for i, v in enumerate(views):
        if cancel is not None and cancel.is_set():
            raise RuntimeError("cancelled")
        rng = depth_range(v, points)
        if rng is None:
            r = float(np.median(dist))
            rng = (r * 0.4, r * 1.6)
        if not nbrs[i]:
            v.depth = np.zeros((v.h, v.w), np.float32)
            v.conf = np.zeros((v.h, v.w), np.float32)
        else:
            v.depth, v.conf = plane_sweep(v, [views[j] for j in nbrs[i]], rng[0], rng[1], planes=planes)
            ok_count += 1
        if progress:
            progress(i + 1, len(views))
    consistency_filter(views, nbrs)
    for v in views:
        if v.depth is not None:
            grazing_weight(v)
    return ok_count
