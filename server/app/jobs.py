"""Хранилище задач на диске + одна рабочая очередь (COLMAP тяжёлый, параллелить не стоит)."""
import json
import os
import shutil
import threading
import time
import traceback
import uuid

from . import pipeline
from .colmap_io import Cancelled, OutOfMemory, PipelineError

DATA_DIR = os.environ.get("DATA_DIR", "/tmp/scan3d-data")
JOB_TTL_HOURS = float(os.environ.get("JOB_TTL_HOURS", "24"))
MAX_CONCURRENT = int(os.environ.get("MAX_CONCURRENT", "1"))

_lock = threading.RLock()
_jobs = {}          # id -> dict
_cancel = {}        # id -> threading.Event
_slots = threading.Semaphore(MAX_CONCURRENT)
_queue = []         # id в порядке постановки


def _path(job_id, *parts):
    return os.path.join(DATA_DIR, job_id, *parts)


def _save(job):
    try:
        tmp = _path(job["id"], "job.json.tmp")
        with open(tmp, "w") as fh:
            json.dump(job, fh)
        os.replace(tmp, _path(job["id"], "job.json"))
    except Exception:
        pass


def load_existing():
    os.makedirs(DATA_DIR, exist_ok=True)
    for name in os.listdir(DATA_DIR):
        p = _path(name, "job.json")
        if os.path.exists(p):
            try:
                with open(p) as fh:
                    job = json.load(fh)
                if job.get("state") in ("running", "queued", "uploading"):
                    # процесс был перезапущен посреди работы
                    job["state"] = "error"
                    job["error"] = "Сервер перезапустился во время обработки. Запустите съёмку заново."
                _jobs[job["id"]] = job
            except Exception:
                pass


def create():
    job_id = uuid.uuid4().hex[:12]
    os.makedirs(_path(job_id, "images"), exist_ok=True)
    job = dict(id=job_id, state="uploading", stage="upload", progress=0.0,
               message="Загрузка фото", frames=0, created=time.time(), updated=time.time(),
               params={}, error=None, result=None)
    with _lock:
        _jobs[job_id] = job
        _cancel[job_id] = threading.Event()
    _save(job)
    return job


def get(job_id):
    with _lock:
        return _jobs.get(job_id)


def public(job):
    out = {k: job.get(k) for k in ("id", "state", "stage", "progress", "message", "frames",
                                    "error", "result", "params")}
    with _lock:
        if job["state"] == "queued" and job["id"] in _queue:
            out["queue_position"] = _queue.index(job["id"])
    out["files"] = [f for f in ("glb", "ply", "stl", "obj")
                    if job["state"] == "done" and os.path.exists(_path(job["id"], "out", f"model.{f}"))]
    return out


def add_frame(job, index, data):
    p = _path(job["id"], "images", f"{index:04d}.jpg")
    with open(p, "wb") as fh:
        fh.write(data)
    with _lock:
        job["frames"] = len([n for n in os.listdir(_path(job["id"], "images")) if n.endswith(".jpg")])
        job["updated"] = time.time()


def start(job, params):
    with _lock:
        if job["state"] not in ("uploading",):
            return False
        job["params"] = params
        job["state"] = "queued"
        job["stage"] = "queued"
        job["message"] = "В очереди"
        job["progress"] = 0.02
        _queue.append(job["id"])
    _save(job)
    threading.Thread(target=_worker, args=(job["id"],), daemon=True).start()
    return True


def cancel(job_id):
    ev = _cancel.get(job_id)
    if ev:
        ev.set()
    job = get(job_id)
    if job and job["state"] in ("uploading", "queued"):
        with _lock:
            job["state"] = "cancelled"
            job["message"] = "Отменено"
            if job_id in _queue:
                _queue.remove(job_id)
        _save(job)


def delete(job_id):
    cancel(job_id)
    with _lock:
        _jobs.pop(job_id, None)
        _cancel.pop(job_id, None)
    shutil.rmtree(_path(job_id), ignore_errors=True)


def _set(job, **kw):
    with _lock:
        job.update(kw)
        job["updated"] = time.time()


def _worker(job_id):
    job = _jobs[job_id]
    ev = _cancel[job_id]
    _slots.acquire()
    try:
        with _lock:
            if job_id in _queue:
                _queue.remove(job_id)
        if ev.is_set() or job["state"] == "cancelled":
            _set(job, state="cancelled", message="Отменено")
            return
        _set(job, state="running", stage="features", message="Запуск обработки", progress=0.03)

        last = {"t": 0.0}

        def report(stage, frac, text):
            _set(job, stage=stage, progress=round(float(frac), 4), message=text)
            now = time.time()
            if now - last["t"] > 5:
                last["t"] = now
                _save(job)

        try:
            result = pipeline.run(_path(job_id), job["params"], report, ev)
            _set(job, state="done", stage="done", progress=1.0, message="Готово", result=result)
        except Cancelled:
            _set(job, state="cancelled", message="Отменено")
        except OutOfMemory as e:
            _set(job, state="error", error=str(e) + " Выберите качество «Быстро» или меньше фото.",
                 message="Ошибка")
        except PipelineError as e:
            _set(job, state="error", error=str(e), message="Ошибка")
        except MemoryError:
            _set(job, state="error", message="Ошибка",
                 error="Серверу не хватило памяти. Выберите качество «Быстро» или меньше фото.")
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            _set(job, state="error", message="Ошибка", error=f"Внутренняя ошибка сервера: {e}")
        _save(job)
    finally:
        _slots.release()


def cleanup_loop():
    while True:
        time.sleep(600)
        cutoff = time.time() - JOB_TTL_HOURS * 3600
        with _lock:
            old = [j["id"] for j in _jobs.values()
                   if j["updated"] < cutoff and j["state"] not in ("running", "queued")]
        for job_id in old:
            delete(job_id)
