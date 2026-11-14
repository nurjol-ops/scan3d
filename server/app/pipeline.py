"""Полный пайплайн: фото -> COLMAP (позы камер) -> плотные карты глубины -> TSDF -> меш."""
import glob
import os
import shutil

import cv2
import numpy as np

from . import colmap_io as cio
from . import dense, fusion, meshio
from .colmap_io import Cancelled, PipelineError

PRESETS = {
    "fast": dict(max_frames=36, feat_size=1000, feat_n=4000, depth_side=480, planes=48, grid=96, src=3),
    "normal": dict(max_frames=60, feat_size=1600, feat_n=8000, depth_side=640, planes=64, grid=144, src=4),
    "high": dict(max_frames=80, feat_size=2000, feat_n=10000, depth_side=800, planes=96, grid=208, src=4),
}

# доли общего прогресса для каждого этапа
STAGES = [
    ("features", 0.03, 0.15),
    ("matching", 0.15, 0.30),
    ("mapper", 0.30, 0.50),
    ("undistort", 0.50, 0.55),
    ("depth", 0.55, 0.88),
    ("fusion", 0.88, 0.97),
    ("export", 0.97, 1.00),
]
STAGE_TEXT = {
    "features": "Ищу ключевые точки на фото",
    "matching": "Сопоставляю фото между собой",
    "mapper": "Восстанавливаю положение камер",
    "undistort": "Подготавливаю изображения",
    "depth": "Считаю глубину",
    "fusion": "Собираю 3D-модель",
    "export": "Сохраняю файлы",
}


def _span(name):
    for n, a, b in STAGES:
        if n == name:
            return a, b
    raise KeyError(name)


def run(job_dir, params, report, cancel):
    """report(stage, fraction_0_1, text). Возвращает dict с информацией о результате."""
    quality = params.get("quality", "normal")
    cfg = dict(PRESETS.get(quality, PRESETS["normal"]))
    crop = bool(params.get("crop", True))

    img_dir = os.path.join(job_dir, "images")
    work = os.path.join(job_dir, "work")
    out = os.path.join(job_dir, "out")
    shutil.rmtree(work, ignore_errors=True)
    os.makedirs(work, exist_ok=True)
    os.makedirs(out, exist_ok=True)

    def stage(name, frac=0.0, text=None):
        a, b = _span(name)
        report(name, a + (b - a) * max(0.0, min(1.0, frac)), text or STAGE_TEXT[name])

    def check():
        if cancel.is_set():
            raise Cancelled()

    # ------------------------------------------------------------ входные кадры
    files = sorted(glob.glob(os.path.join(img_dir, "*.jpg")))
    if len(files) < 8:
        raise PipelineError(f"Мало фото: {len(files)}. Нужно минимум 8, лучше 30-60 по кругу.")
    if len(files) > cfg["max_frames"]:
        idx = np.linspace(0, len(files) - 1, cfg["max_frames"]).round().astype(int)
        keep = set(int(i) for i in idx)
        for i, fpath in enumerate(files):
            if i not in keep:
                os.remove(fpath)
        files = sorted(glob.glob(os.path.join(img_dir, "*.jpg")))

    sample = cv2.imread(files[0])
    if sample is None:
        raise PipelineError("Не удалось прочитать фото. Файлы повреждены.")
    min_side = int(os.environ.get("MIN_IMAGE_SIDE", "480"))
    if max(sample.shape[:2]) < min_side:
        raise PipelineError(f"Фото слишком маленькие (меньше {min_side} px). Увеличьте разрешение камеры.")

    fs = cio.flag_style()
    db = os.path.join(work, "database.db")
    ext, mat = fs["ext"], fs["match"]

    # ------------------------------------------------------------ COLMAP
    def line_cb(stage_name, n_total):
        state = {"n": 0}

        def cb(line):
            check()
            if "Processed file" in line or "Matching block" in line or "Registering image" in line \
                    or "Processing image" in line or "Elapsed time" in line:
                state["n"] += 1
                stage(stage_name, min(0.98, state["n"] / max(1, n_total)))
        return cb

    n = len(files)
    stage("features")
    cio.run_colmap(["feature_extractor", "--database_path", db, "--image_path", img_dir,
                    "--ImageReader.single_camera", 1, "--ImageReader.camera_model", "SIMPLE_RADIAL",
                    f"--{ext}.use_gpu", 0, f"--{ext}.max_image_size", cfg["feat_size"],
                    "--SiftExtraction.max_num_features", cfg["feat_n"]],
                   cancel, line_cb("features", n))
    check()

    stage("matching")
    cio.run_colmap(["exhaustive_matcher", "--database_path", db, f"--{mat}.use_gpu", 0],
                   cancel, line_cb("matching", max(1, n // 4)))
    check()

    stage("mapper")
    sparse = os.path.join(work, "sparse")
    os.makedirs(sparse, exist_ok=True)
    cio.run_colmap(["mapper", "--database_path", db, "--image_path", img_dir,
                    "--output_path", sparse, "--Mapper.num_threads", os.environ.get("COLMAP_THREADS", "2")],
                   cancel, line_cb("mapper", n))
    check()

    models = [d for d in sorted(glob.glob(os.path.join(sparse, "*"))) if os.path.isdir(d)]
    if not models:
        raise PipelineError(
            "Не удалось определить положение камер. Снимайте объект с перекрытием кадров, "
            "при хорошем освещении, на текстурном фоне; избегайте блестящих и прозрачных предметов.")
    best = max(models, key=lambda d: os.path.getsize(os.path.join(d, "images.bin"))
               if os.path.exists(os.path.join(d, "images.bin")) else 0)

    stage("undistort")
    dense_dir = os.path.join(work, "dense")
    cio.run_colmap(["image_undistorter", "--image_path", img_dir, "--input_path", best,
                    "--output_path", dense_dir, "--output_type", "COLMAP",
                    "--max_image_size", cfg["depth_side"]], cancel)
    check()
    sp = os.path.join(dense_dir, "sparse")
    if not os.path.exists(os.path.join(sp, "cameras.bin")) and os.path.exists(os.path.join(sp, "0", "cameras.bin")):
        sp = os.path.join(sp, "0")
    txt = os.path.join(work, "txt")
    os.makedirs(txt, exist_ok=True)
    cio.run_colmap(["model_converter", "--input_path", sp, "--output_path", txt, "--output_type", "TXT"], cancel)

    cams = cio.read_cameras_txt(os.path.join(txt, "cameras.txt"))
    imgs = cio.read_images_txt(os.path.join(txt, "images.txt"))
    pts, _ = cio.read_points3d_txt(os.path.join(txt, "points3D.txt"))
    if len(imgs) < 6:
        raise PipelineError(
            f"Камеры определились только на {len(imgs)} фото из {n}. Снимите заново: медленнее, "
            "с большим перекрытием, без размытия и блеска.")
    if len(pts) < 100:
        raise PipelineError("Слишком мало точек для 3D. Нужен текстурный объект и хорошее освещение.")

    # ------------------------------------------------------------ плотные карты глубины
    views = []
    for im in imgs:
        cam = cams[im["cam"]]
        if cam["model"] not in ("PINHOLE", "SIMPLE_PINHOLE"):
            raise PipelineError(f"Неожиданная модель камеры {cam['model']} после undistort.")
        if cam["model"] == "SIMPLE_PINHOLE":
            f_, cx, cy = cam["params"]
            cam = dict(cam, params=[f_, f_, cx, cy])
        path = os.path.join(dense_dir, "images", im["name"])
        img = cv2.imread(path)
        if img is None:
            continue
        views.append(dense.view_from_colmap(im["name"], img, cam, im["R"], im["t"], cfg["depth_side"]))
    if len(views) < 6:
        raise PipelineError("Не удалось прочитать подготовленные изображения.")

    # выравниваем сцену так, чтобы «верх» был вдоль +Y
    up = dense.world_up(views)
    Q = fusion.rotation_between(up, np.array([0.0, 1.0, 0.0]))
    for v in views:
        v.rotate_world(Q)
    pts = pts @ Q.T

    stage("depth")

    def depth_progress(i, total):
        check()
        stage("depth", i / float(total), f"Считаю глубину: кадр {i} из {total}")

    try:
        done = dense.estimate_depths(views, pts, progress=depth_progress, cancel=cancel,
                                     planes=cfg["planes"], max_src=cfg["src"])
    except RuntimeError as e:
        if "cancelled" in str(e):
            raise Cancelled()
        raise
    check()
    if done < 4:
        raise PipelineError("Не удалось посчитать глубину: кадры слишком далеко друг от друга по углу.")

    # ------------------------------------------------------------ слияние
    stage("fusion", 0.0)
    focus = dense.focus_point(views)
    up_vec = np.array([0.0, 1.0, 0.0])
    diag = np.linalg.norm(pts.max(axis=0) - pts.min(axis=0))
    plane = fusion.fit_support_plane(pts, up_vec, focus, tol=0.012 * diag)
    use_pts = pts
    if plane is not None and crop:
        above = pts[(pts @ plane[0] - plane[1]) > 0.012 * diag]
        if len(above) >= 60:
            use_pts = above
    lo, hi = fusion.object_bbox(use_pts, views, crop=crop)
    vol = fusion.Volume(lo, hi, cfg["grid"])
    for i, v in enumerate(views):
        check()
        vol.integrate(v)
        stage("fusion", 0.8 * (i + 1) / len(views), f"Собираю 3D-модель: кадр {i + 1} из {len(views)}")
    if plane is not None and crop:
        vol.cut_below(plane[0], plane[1], 2.0 * vol.voxel)
    res = vol.extract_mesh()
    if res is None:
        raise PipelineError("Не удалось построить модель: слишком мало перекрывающихся данных. "
                            "Снимите объект с большего числа ракурсов.")
    verts, faces, cols = res
    verts, faces, cols = fusion.prune_unsupported(verts, faces, cols, views, tol=1.5 * vol.voxel)
    verts, faces, cols = fusion.keep_large_components(verts, faces, cols, ratio=0.1)
    verts = fusion.smooth(verts, faces)
    faces = fusion.orient_outward(verts, faces)
    if len(faces) < 200:
        raise PipelineError("Получилась слишком маленькая модель. Попробуйте снять заново ближе к объекту.")

    # центрируем, нормируем размер (наибольший габарит = 1)
    bb_lo, bb_hi = verts.min(axis=0), verts.max(axis=0)
    center = (bb_lo + bb_hi) / 2.0
    scale = 1.0 / float((bb_hi - bb_lo).max())
    verts = ((verts - center) * scale).astype(np.float32)
    faces = faces.astype(np.int64)

    # ------------------------------------------------------------ экспорт
    stage("export", 0.0)
    meshio.write_glb(os.path.join(out, "model.glb"), verts, faces, cols)
    stage("export", 0.4)
    meshio.write_ply(os.path.join(out, "model.ply"), verts, faces, cols)
    meshio.write_stl(os.path.join(out, "model.stl"), verts, faces)
    meshio.write_obj(os.path.join(out, "model.obj"), verts, faces, cols)

    thumb_src = cv2.imread(files[len(files) // 2])
    if thumb_src is not None:
        s = 360.0 / max(thumb_src.shape[:2])
        th = cv2.resize(thumb_src, (int(thumb_src.shape[1] * s), int(thumb_src.shape[0] * s)),
                        interpolation=cv2.INTER_AREA)
        cv2.imwrite(os.path.join(out, "preview.jpg"), th, [cv2.IMWRITE_JPEG_QUALITY, 82])

    shutil.rmtree(work, ignore_errors=True)
    shutil.rmtree(img_dir, ignore_errors=True)
    return dict(vertices=int(len(verts)), faces=int(len(faces)), cameras=int(len(views)),
                photos=int(n), quality=quality)
