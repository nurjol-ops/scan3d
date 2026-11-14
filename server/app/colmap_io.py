"""Запуск COLMAP (CLI) и разбор его текстовых моделей."""
import collections
import os
import re
import subprocess
import threading
import time

import numpy as np

COLMAP = os.environ.get("COLMAP_BIN", "colmap")


class PipelineError(Exception):
    """Ошибка, текст которой можно показать пользователю."""


class Cancelled(Exception):
    pass


class OutOfMemory(PipelineError):
    pass


_flag_style = None


def flag_style():
    """В COLMAP >= 3.11 часть флагов переименована (SiftExtraction -> FeatureExtraction).
    Определяем по справке, какой вариант установлен."""
    global _flag_style
    if _flag_style is not None:
        return _flag_style
    try:
        out = subprocess.run([COLMAP, "feature_extractor", "-h"], capture_output=True,
                             text=True, timeout=60, errors="replace")
        text = (out.stdout or "") + (out.stderr or "")
    except FileNotFoundError:
        raise PipelineError("На сервере не найден COLMAP. Проверьте Dockerfile.")
    except Exception:
        text = ""
    new = "FeatureExtraction.use_gpu" in text
    _flag_style = {
        "ext": "FeatureExtraction" if new else "SiftExtraction",
        "match": "FeatureMatching" if new else "SiftMatching",
    }
    return _flag_style


def colmap_env():
    env = dict(os.environ)
    env.setdefault("QT_QPA_PLATFORM", "offscreen")
    env.setdefault("OMP_NUM_THREADS", env.get("COLMAP_THREADS", "2"))
    return env


def run_colmap(args, cancel, on_line=None):
    """Запускает COLMAP, построчно читает вывод. Бросает исключения при ошибке/отмене."""
    cmd = [COLMAP] + [str(a) for a in args]
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, errors="replace", env=colmap_env())
    except FileNotFoundError:
        raise PipelineError("На сервере не найден COLMAP. Проверьте Dockerfile.")

    done = threading.Event()

    def watcher():
        while not done.is_set():
            if cancel.is_set():
                try:
                    proc.kill()
                except Exception:
                    pass
                return
            time.sleep(0.5)

    threading.Thread(target=watcher, daemon=True).start()
    tail = collections.deque(maxlen=30)
    try:
        for line in proc.stdout:
            line = line.rstrip()
            if line:
                tail.append(line)
                if on_line:
                    try:
                        on_line(line)
                    except Exception:
                        pass
        rc = proc.wait()
    finally:
        done.set()
    if cancel.is_set():
        raise Cancelled()
    if rc != 0:
        if rc in (-9, 137):
            raise OutOfMemory("Серверу не хватило памяти при работе COLMAP.")
        raise PipelineError(f"COLMAP ({args[0]}) завершился с ошибкой {rc}: " + " | ".join(list(tail)[-6:]))
    return list(tail)


# ---------------------------------------------------------------- разбор моделей

def qvec_to_rot(q):
    w, x, y, z = q
    return np.array([
        [1 - 2 * y * y - 2 * z * z, 2 * x * y - 2 * w * z, 2 * x * z + 2 * w * y],
        [2 * x * y + 2 * w * z, 1 - 2 * x * x - 2 * z * z, 2 * y * z - 2 * w * x],
        [2 * x * z - 2 * w * y, 2 * y * z + 2 * w * x, 1 - 2 * x * x - 2 * y * y],
    ])


def read_cameras_txt(path):
    cams = {}
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            p = line.split()
            cams[int(p[0])] = dict(model=p[1], w=int(p[2]), h=int(p[3]),
                                   params=[float(x) for x in p[4:]])
    return cams


def read_images_txt(path):
    """Возвращает список dict(id, R, t, cam, name) в порядке файла."""
    with open(path) as fh:
        lines = [l.rstrip("\n") for l in fh if not l.startswith("#")]
    out = []
    # строки идут парами: заголовок изображения + (возможно пустая) строка 2D-точек
    for i in range(0, len(lines) - 1, 2):
        p = lines[i].split()
        if len(p) < 10:
            continue
        q = [float(x) for x in p[1:5]]
        t = np.array([float(x) for x in p[5:8]])
        out.append(dict(id=int(p[0]), R=qvec_to_rot(q), t=t, cam=int(p[8]), name=" ".join(p[9:])))
    return out


def read_points3d_txt(path, min_track=3, max_err=2.0):
    xyz, rgb = [], []
    with open(path) as fh:
        for line in fh:
            if not line.strip() or line.startswith("#"):
                continue
            p = line.split()
            track = (len(p) - 8) // 2
            if track < min_track or float(p[7]) > max_err:
                continue
            xyz.append([float(p[1]), float(p[2]), float(p[3])])
            rgb.append([int(p[4]), int(p[5]), int(p[6])])
    return np.array(xyz, dtype=np.float64).reshape(-1, 3), np.array(rgb, dtype=np.uint8).reshape(-1, 3)
