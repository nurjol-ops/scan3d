"""Сквозной тест HTTP API: настоящий uvicorn + поддельный COLMAP.
Запуск:  python -I tests/api_test.py   (из папки server)"""
import json, os, subprocess, sys, tempfile, time, urllib.request, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
SRV = os.path.dirname(HERE)
sys.path.insert(0, HERE)
from scene import make_scene  # noqa: E402

tmp = tempfile.mkdtemp()
make_scene(os.path.join(tmp, "imgs"), os.path.join(tmp, "scene.npz"))
PORT = 18765
env = dict(os.environ, FAKE_SCENE=os.path.join(tmp, "scene.npz"), COLMAP_BIN=os.path.join(HERE, "fake_colmap.py"),
           MIN_IMAGE_SIDE="200", DATA_DIR=os.path.join(tmp, "data"), API_KEY="secret123", PYTHONPATH=SRV)
srv = subprocess.Popen([sys.executable, "-m", "uvicorn", "app.main:app", "--port", str(PORT), "--log-level", "warning"],
                       cwd=SRV, env=env)
BASE = f"http://127.0.0.1:{PORT}"


def call(method, path, body=None, key="secret123", raw=False):
    req = urllib.request.Request(BASE + path, data=body, method=method)
    if key:
        req.add_header("X-API-Key", key)
    if body is not None and not raw:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            data = r.read()
            return r.status, data
    except urllib.error.HTTPError as e:
        return e.code, e.read()


try:
    for _ in range(60):
        try:
            urllib.request.urlopen(BASE + "/health", timeout=1); break
        except Exception:
            time.sleep(0.5)
    ok = True
    def check(name, cond):
        global ok
        print(("OK  " if cond else "FAIL"), name); ok &= bool(cond)

    s, _ = call("POST", "/api/jobs", key=None); check("без ключа -> 401", s == 401)
    s, b = call("GET", "/api/info"); info = json.loads(b); check("info", s == 200 and info["version"])
    s, b = call("POST", "/api/jobs"); job = json.loads(b); jid = job["id"]; check("создание задачи", s == 201)
    s, _ = call("POST", f"/api/jobs/{jid}/start", b"{}"); check("старт без фото -> 400", s == 400)
    s, _ = call("PUT", f"/api/jobs/{jid}/frames/0", b"not a jpeg" * 300, raw=True); check("не-JPEG отклонён", s == 400)
    for i in range(24):
        data = open(os.path.join(tmp, "imgs", f"{i:04d}.jpg"), "rb").read()
        s, b = call("PUT", f"/api/jobs/{jid}/frames/{i}", data, raw=True)
        assert s == 200, (s, b)
    check("24 кадра загружены", json.loads(b)["frames"] == 24)
    s, b = call("POST", f"/api/jobs/{jid}/start", json.dumps({"quality": "fast"}).encode()); check("старт", s == 200)
    s, _ = call("PUT", f"/api/jobs/{jid}/frames/30", b"\xff\xd8\xff" + b"0" * 3000, raw=True); check("загрузка после старта -> 409", s == 409)
    t0 = time.time(); last = None; progress = []
    while time.time() - t0 < 300:
        s, b = call("GET", f"/api/jobs/{jid}"); st = json.loads(b); progress.append(st["progress"])
        if st["state"] in ("done", "error", "cancelled"):
            break
        time.sleep(1)
    check(f"состояние done (сейчас {st['state']}, {st.get('error')})", st["state"] == "done")
    check("прогресс не убывает", all(b >= a - 1e-9 for a, b in zip(progress, progress[1:])))
    check("files = glb/ply/stl/obj", sorted(st["files"]) == ["glb", "obj", "ply", "stl"])
    for fmt, magic in (("glb", b"glTF"), ("ply", b"ply\n"), ("stl", b"scan3d"), ("obj", b"# scan3d")):
        s, b = call("GET", f"/api/jobs/{jid}/files/{fmt}"); check(f"скачивание {fmt} ({len(b)} B)", s == 200 and b.startswith(magic))
    s, b = call("GET", f"/api/jobs/{jid}/files/preview.jpg"); check("превью", s == 200 and b[:2] == b"\xff\xd8")
    s, _ = call("GET", f"/api/jobs/{jid}/files/xyz"); check("неизвестный формат -> 404", s == 404)

    # отмена
    s, b = call("POST", "/api/jobs"); j2 = json.loads(b)["id"]
    for i in range(10):
        call("PUT", f"/api/jobs/{j2}/frames/{i}", open(os.path.join(tmp, "imgs", f"{i:04d}.jpg"), "rb").read(), raw=True)
    s, _ = call("POST", f"/api/jobs/{j2}/cancel"); s2, b = call("GET", f"/api/jobs/{j2}")
    check("отмена до старта", json.loads(b)["state"] == "cancelled")
    s, _ = call("DELETE", f"/api/jobs/{jid}"); s2, _ = call("GET", f"/api/jobs/{jid}")
    check("удаление", s == 204 and s2 == 404)
    # CORS
    req = urllib.request.Request(BASE + "/api/jobs", method="OPTIONS", headers={
        "Origin": "https://localhost", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "x-api-key,content-type"})
    with urllib.request.urlopen(req) as r:
        check("CORS preflight", r.headers.get("access-control-allow-origin") in ("*", "https://localhost"))
    print("ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ" if ok else "ЕСТЬ ОШИБКИ")
    sys.exit(0 if ok else 1)
finally:
    srv.terminate()
