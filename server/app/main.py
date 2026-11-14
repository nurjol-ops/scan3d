"""HTTP API (Starlette). Запуск: uvicorn app.main:app --host 0.0.0.0 --port $PORT"""
import contextlib
import hmac
import os
import shutil
import threading

from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware
from starlette.requests import Request
from starlette.responses import FileResponse, HTMLResponse, JSONResponse, Response
from starlette.routing import Route

from . import jobs
from .pipeline import PRESETS

VERSION = "1.0.0"
API_KEY = os.environ.get("API_KEY", "").strip()
MAX_FRAMES = int(os.environ.get("MAX_FRAMES", "120"))
MAX_FRAME_BYTES = int(os.environ.get("MAX_FRAME_BYTES", str(10 * 1024 * 1024)))

MIME = {"glb": "model/gltf-binary", "ply": "application/octet-stream",
        "stl": "model/stl", "obj": "text/plain"}


def err(message, status=400):
    return JSONResponse({"error": message}, status_code=status)


def authorized(request: Request):
    if not API_KEY:
        return True
    given = request.headers.get("x-api-key") or request.query_params.get("key") or ""
    return hmac.compare_digest(given, API_KEY)


def guard(handler):
    async def wrapper(request: Request):
        if not authorized(request):
            return err("Неверный ключ доступа (API key).", 401)
        return await handler(request)
    return wrapper


def find_job(request):
    job = jobs.get(request.path_params["job_id"])
    return job


async def index(request):
    colmap = shutil.which(os.environ.get("COLMAP_BIN", "colmap")) is not None
    html = f"""<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Scan3D server</title>
<body style="font:16px system-ui;max-width:560px;margin:12vh auto;padding:0 20px;color:#222">
<h1>Scan3D server работает</h1>
<p>Версия {VERSION}. COLMAP: <b>{'найден' if colmap else 'НЕ найден'}</b>. Ключ доступа: <b>{'включён' if API_KEY else 'выключен'}</b>.</p>
<p>Скопируйте адрес этой страницы в настройки приложения Scan3D.</p></body>"""
    return HTMLResponse(html)


async def health(request):
    return JSONResponse({"ok": True})


async def info(request):
    return JSONResponse({
        "name": "scan3d", "version": VERSION,
        "colmap": shutil.which(os.environ.get("COLMAP_BIN", "colmap")) is not None,
        "auth": bool(API_KEY), "max_frames": MAX_FRAMES,
        "presets": {k: dict(max_frames=v["max_frames"]) for k, v in PRESETS.items()},
    })


@guard
async def create_job(request):
    job = jobs.create()
    return JSONResponse(jobs.public(job), status_code=201)


@guard
async def put_frame(request):
    job = find_job(request)
    if not job:
        return err("Задача не найдена.", 404)
    if job["state"] != "uploading":
        return err("Задача уже запущена.", 409)
    try:
        idx = int(request.path_params["index"])
    except ValueError:
        return err("Плохой номер кадра.")
    if idx < 0 or idx >= MAX_FRAMES:
        return err(f"Максимум {MAX_FRAMES} кадров.")
    clen = request.headers.get("content-length")
    if clen and int(clen) > MAX_FRAME_BYTES:
        return err("Файл слишком большой.", 413)
    data = await request.body()
    if len(data) > MAX_FRAME_BYTES:
        return err("Файл слишком большой.", 413)
    if len(data) < 2000 or data[:3] != b"\xff\xd8\xff":
        return err("Ожидается JPEG.")
    jobs.add_frame(job, idx, data)
    return JSONResponse({"frames": job["frames"]})


@guard
async def start_job(request):
    job = find_job(request)
    if not job:
        return err("Задача не найдена.", 404)
    try:
        body = await request.json()
    except Exception:
        body = {}
    quality = body.get("quality", "normal")
    if quality not in PRESETS:
        quality = "normal"
    if job["frames"] < 8:
        return err(f"Загружено {job['frames']} фото, нужно минимум 8.")
    if not jobs.start(job, dict(quality=quality, crop=bool(body.get("crop", True)))):
        return err("Задача уже запущена.", 409)
    return JSONResponse(jobs.public(job))


@guard
async def status(request):
    job = find_job(request)
    if not job:
        return err("Задача не найдена (возможно, сервер перезапускался).", 404)
    return JSONResponse(jobs.public(job))


@guard
async def download(request):
    job = find_job(request)
    if not job:
        return err("Задача не найдена.", 404)
    fmt = request.path_params["fmt"].lower()
    if fmt == "preview.jpg":
        p = jobs._path(job["id"], "out", "preview.jpg")
        if not os.path.exists(p):
            return err("Нет превью.", 404)
        return FileResponse(p, media_type="image/jpeg")
    if fmt not in MIME:
        return err("Формат не поддерживается.", 404)
    p = jobs._path(job["id"], "out", f"model.{fmt}")
    if job["state"] != "done" or not os.path.exists(p):
        return err("Модель ещё не готова.", 404)
    return FileResponse(p, media_type=MIME[fmt], filename=f"scan.{fmt}")


@guard
async def cancel_job(request):
    job = find_job(request)
    if not job:
        return Response(status_code=204)
    jobs.cancel(job["id"])
    return JSONResponse(jobs.public(job))


@guard
async def delete_job(request):
    job = find_job(request)
    if job:
        jobs.delete(job["id"])
    return Response(status_code=204)


@contextlib.asynccontextmanager
async def lifespan(app):
    jobs.load_existing()
    threading.Thread(target=jobs.cleanup_loop, daemon=True).start()
    yield


routes = [
    Route("/", index),
    Route("/health", health),
    Route("/api/info", info),
    Route("/api/jobs", create_job, methods=["POST"]),
    Route("/api/jobs/{job_id}", status, methods=["GET"]),
    Route("/api/jobs/{job_id}", delete_job, methods=["DELETE"]),
    Route("/api/jobs/{job_id}/frames/{index:int}", put_frame, methods=["PUT"]),
    Route("/api/jobs/{job_id}/start", start_job, methods=["POST"]),
    Route("/api/jobs/{job_id}/cancel", cancel_job, methods=["POST"]),
    Route("/api/jobs/{job_id}/files/{fmt}", download, methods=["GET"]),
]

app = Starlette(
    routes=routes,
    lifespan=lifespan,
    middleware=[Middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"],
                           allow_headers=["*"], expose_headers=["Content-Disposition"],
                           max_age=86400)],
)
