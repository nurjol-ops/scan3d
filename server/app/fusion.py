"""TSDF-слияние карт глубины -> меш (marching cubes) -> очистка/сглаживание."""
import numpy as np
from scipy import ndimage, sparse
from scipy.sparse import csgraph
from skimage import measure

from .dense import focus_point


def object_bbox(points, views, crop=True, pad=0.12):
    """Ограничивающий бокс объекта по разреженным точкам.
    Фон (стол, комната) отсекается: берём точки рядом с точкой, куда смотрят камеры."""
    pts = np.asarray(points, dtype=np.float64)
    if crop and len(views) > 0:
        f = focus_point(views)
        d = np.linalg.norm(pts - f, axis=1)
        keep = d < 1.8 * np.median(d)
        if keep.sum() >= 20:
            pts = pts[keep]
    lo = np.percentile(pts, 1, axis=0)
    hi = np.percentile(pts, 99, axis=0)
    ext = hi - lo
    padv = ext * pad + 1e-6
    return lo - padv, hi + padv


def fit_support_plane(points, up, focus, tol, iters=500, min_frac=0.12, max_tilt_deg=25.0, seed=1):
    """Ищет горизонтальную опорную плоскость (стол/пол) под объектом.
    Возвращает (n, d): плоскость n·x = d, n направлена вверх; или None."""
    pts = np.asarray(points, dtype=np.float64)
    n_pts = len(pts)
    if n_pts < 60:
        return None
    rng = np.random.default_rng(seed)
    cos_t = np.cos(np.radians(max_tilt_deg))
    best_cnt, best = 0, None
    for _ in range(iters):
        p0, p1, p2 = pts[rng.choice(n_pts, 3, replace=False)]
        nr = np.cross(p1 - p0, p2 - p0)
        ln = np.linalg.norm(nr)
        if ln < 1e-12:
            continue
        nr /= ln
        if nr @ up < 0:
            nr = -nr
        if nr @ up < cos_t:
            continue
        dd = nr @ p0
        cnt = int((np.abs(pts @ nr - dd) < tol).sum())
        if cnt > best_cnt:
            best_cnt, best = cnt, (nr, dd)
    if best is None or best_cnt < min_frac * n_pts:
        return None
    nr, dd = best
    inl = pts[np.abs(pts @ nr - dd) < tol]
    c = inl.mean(axis=0)
    nr2 = np.linalg.svd(inl - c)[2][-1]
    if nr2 @ up < 0:
        nr2 = -nr2
    if nr2 @ up >= cos_t:
        nr, dd = nr2, nr2 @ c
    if nr @ focus - dd <= 0:              # объект должен находиться над плоскостью
        return None
    return nr, float(dd)


class Volume:
    def cut_below(self, n, d, margin):
        """Убирает (помечает ненаблюдаемыми) всё, что лежит ниже опорной плоскости + margin."""
        n = np.asarray(n, dtype=np.float64)
        c0 = float(self.origin @ n - d)
        ai = (self.voxel * n[0]) * np.arange(self.dims[0])
        aj = (self.voxel * n[1]) * np.arange(self.dims[1])
        ak = (self.voxel * n[2]) * np.arange(self.dims[2])
        for i0 in range(0, self.dims[0], 16):
            sl = slice(i0, min(self.dims[0], i0 + 16))
            s = c0 + ai[sl, None, None] + aj[None, :, None] + ak[None, None, :]
            self.w[sl][s < margin] = 0
            self.tsdf[sl][s < margin] = 1

    # (остальные методы класса ниже)
    def __init__(self, lo, hi, grid):
        ext = hi - lo
        self.voxel = float(ext.max() / grid)
        self.dims = tuple(int(np.ceil(e / self.voxel)) + 1 for e in ext)
        self.origin = lo.astype(np.float64)
        self.tsdf = np.ones(self.dims, np.float16)
        self.w = np.zeros(self.dims, np.float16)
        self.color = np.zeros(self.dims + (3,), np.float16)
        self.trunc = 3.0 * self.voxel

    def integrate(self, view, chunk=250_000):
        nx, ny, nz = self.dims
        rows = max(1, chunk // (ny * nz))
        K, R, t = view.K, view.R, view.t
        depth, conf = view.depth, view.conf
        img = view.img[..., ::-1]               # BGR -> RGB
        h, w = depth.shape
        gy, gz = np.meshgrid(np.arange(ny), np.arange(nz), indexing="ij")
        gy = gy.reshape(-1).astype(np.float64)
        gz = gz.reshape(-1).astype(np.float64)
        for x0 in range(0, nx, rows):
            x1 = min(nx, x0 + rows)
            gx = np.repeat(np.arange(x0, x1, dtype=np.float64), ny * nz)
            P = np.stack([gx, np.tile(gy, x1 - x0), np.tile(gz, x1 - x0)], axis=1)
            P = P * self.voxel + self.origin
            Xc = P @ R.T + t
            z = Xc[:, 2]
            ok = z > 1e-3
            zs = np.where(ok, z, 1.0)
            u = np.rint(K[0, 0] * Xc[:, 0] / zs + K[0, 2]).astype(np.int64)
            v = np.rint(K[1, 1] * Xc[:, 1] / zs + K[1, 2]).astype(np.int64)
            ok &= (u >= 0) & (u < w) & (v >= 0) & (v < h)
            if not ok.any():
                continue
            sel = np.nonzero(ok)[0]
            us, vs = u[sel], v[sel]
            d = depth[vs, us]
            cf = conf[vs, us]
            good = d > 0
            if not good.any():
                continue
            sel, us, vs, d, cf = sel[good], us[good], vs[good], d[good], cf[good]
            zc = z[sel]
            ray = np.linalg.norm(Xc[sel], axis=1) / zc
            sdf = (d - zc) * ray
            keep = sdf >= -self.trunc
            if not keep.any():
                continue
            sel, us, vs, sdf, cf = sel[keep], us[keep], vs[keep], sdf[keep], cf[keep]
            obs = np.clip(sdf / self.trunc, -1.0, 1.0)
            wn = cf.astype(np.float64)

            ix = gx[sel].astype(np.int64)
            iy = np.tile(gy, x1 - x0)[sel].astype(np.int64)
            iz = np.tile(gz, x1 - x0)[sel].astype(np.int64)

            w_old = self.w[ix, iy, iz].astype(np.float64)
            t_old = self.tsdf[ix, iy, iz].astype(np.float64)
            w_new = w_old + wn
            self.tsdf[ix, iy, iz] = ((t_old * w_old + obs * wn) / w_new).astype(np.float16)
            self.w[ix, iy, iz] = np.minimum(w_new, 60.0).astype(np.float16)

            near = np.abs(sdf) < self.trunc
            if near.any():
                ixn, iyn, izn = ix[near], iy[near], iz[near]
                rgb = img[vs[near], us[near]].astype(np.float64)
                wo, wnn = w_old[near], wn[near]
                c_old = self.color[ixn, iyn, izn].astype(np.float64)
                c_new = (c_old * wo[:, None] + rgb * wnn[:, None]) / (wo + wnn)[:, None]
                self.color[ixn, iyn, izn] = c_new.astype(np.float16)

    def extract_mesh(self, min_weight=1.2):
        observed = self.w >= min_weight
        if observed.sum() < 100:
            return None
        # skimage проверяет в mask только один угол ячейки; нам нужно, чтобы ВСЕ 8 углов
        # были наблюдаемыми, иначе на границе «видно / не видно» появляются
        # внутренние поверхности с нормалями внутрь.
        cube = np.ones(tuple(d - 1 for d in observed.shape), dtype=bool)
        for dx in (0, 1):
            for dy in (0, 1):
                for dz in (0, 1):
                    cube &= observed[dx:observed.shape[0] - 1 + dx,
                                     dy:observed.shape[1] - 1 + dy,
                                     dz:observed.shape[2] - 1 + dz]
        mask = np.zeros(observed.shape, dtype=bool)
        mask[:-1, :-1, :-1] = cube
        if not mask.any():
            return None
        vol = self.tsdf.astype(np.float32)
        try:
            verts, faces, _, _ = measure.marching_cubes(vol, level=0.0, mask=mask,
                                                       allow_degenerate=False)
        except (ValueError, RuntimeError):
            return None
        if len(faces) < 50:
            return None
        # цвет вершин: трилинейная интерполяция цветового объёма
        coords = verts.T
        cols = np.empty((len(verts), 3), np.float32)
        for ch in range(3):
            cols[:, ch] = ndimage.map_coordinates(self.color[..., ch].astype(np.float32),
                                                  coords, order=1, mode="nearest")
        colors = np.clip(cols, 0, 255).astype(np.uint8)
        world = verts * self.voxel + self.origin
        return world.astype(np.float64), faces.astype(np.int64), colors


# --------------------------------------------------------------- очистка меша

def _compact(v, f, c):
    used = np.unique(f)
    remap = -np.ones(len(v), np.int64)
    remap[used] = np.arange(len(used))
    return v[used], remap[f], c[used]


def keep_large_components(v, f, c, ratio=0.15):
    n = len(v)
    a = np.concatenate([f[:, 0], f[:, 1], f[:, 2]])
    b = np.concatenate([f[:, 1], f[:, 2], f[:, 0]])
    adj = sparse.coo_matrix((np.ones(len(a), np.int8), (a, b)), shape=(n, n))
    ncomp, label = csgraph.connected_components(adj, directed=False)
    fl = label[f[:, 0]]
    counts = np.bincount(fl, minlength=ncomp)
    big = counts.max()
    keep_labels = counts >= ratio * big
    fkeep = keep_labels[fl]
    return _compact(v, f[fkeep], c)


def smooth(v, f, iters=8, lam=0.5, mu=-0.53):
    """Сглаживание Taubin (почти без усадки)."""
    n = len(v)
    a = np.concatenate([f[:, 0], f[:, 1], f[:, 2]])
    b = np.concatenate([f[:, 1], f[:, 2], f[:, 0]])
    A = sparse.coo_matrix((np.ones(len(a)), (a, b)), shape=(n, n)).tocsr()
    A = ((A + A.T) > 0).astype(np.float64)
    deg = np.asarray(A.sum(axis=1)).ravel()
    deg[deg == 0] = 1.0
    M = sparse.diags(1.0 / deg) @ A
    x = v.astype(np.float64).copy()
    for _ in range(iters):
        x += lam * (M @ x - x)
        x += mu * (M @ x - x)
    return x


def orient_outward(v, f):
    """Делает нормали наружу для замкнутых/почти замкнутых мешей (по знаку объёма)."""
    tri = v[f] - v.mean(axis=0)
    vol = np.einsum("ij,ij->i", tri[:, 0], np.cross(tri[:, 1], tri[:, 2])).sum()
    if vol < 0:
        f = f[:, ::-1].copy()
    return f


def rotation_between(a, b):
    a = a / np.linalg.norm(a)
    b = b / np.linalg.norm(b)
    c = float(a @ b)
    if c > 1 - 1e-9:
        return np.eye(3)
    if c < -1 + 1e-9:
        axis = np.cross(a, [1.0, 0, 0])
        if np.linalg.norm(axis) < 1e-6:
            axis = np.cross(a, [0, 1.0, 0])
        axis /= np.linalg.norm(axis)
        K = np.array([[0, -axis[2], axis[1]], [axis[2], 0, -axis[0]], [-axis[1], axis[0], 0]])
        return np.eye(3) + 2 * K @ K
    vx = np.cross(a, b)
    s = np.linalg.norm(vx)
    K = np.array([[0, -vx[2], vx[1]], [vx[2], 0, -vx[0]], [-vx[1], vx[0], 0]])
    return np.eye(3) + K + K @ K * ((1 - c) / (s * s))


def prune_unsupported(v, f, c, views, tol, min_views=2):
    """Удаляет вершины, которые не подтверждены картами глубины хотя бы в min_views кадрах
    (точка в кадре должна лежать на глубине из карты глубины с допуском tol).
    Убирает «внутренние оболочки» и плавающий мусор, возникающие при слиянии."""
    sup = np.zeros(len(v), np.int32)
    for s in views:
        Xs = v @ s.R.T + s.t
        z = Xs[:, 2]
        ok = z > 1e-6
        zs = np.where(ok, z, 1.0)
        u = np.rint(s.K[0, 0] * Xs[:, 0] / zs + s.K[0, 2]).astype(np.int64)
        w_ = np.rint(s.K[1, 1] * Xs[:, 1] / zs + s.K[1, 2]).astype(np.int64)
        ok &= (u >= 0) & (u < s.w) & (w_ >= 0) & (w_ < s.h)
        d = np.zeros(len(v))
        d[ok] = s.depth[w_[ok], u[ok]]
        # допуск считаем по лучу, а не по z
        sup += (ok & (d > 0) & (np.abs(d - z) < tol)).astype(np.int32)
    good = sup >= min_views
    fkeep = good[f].sum(axis=1) >= 2
    if fkeep.sum() < 50:
        return v, f, c
    return _compact(v, f[fkeep], c)
