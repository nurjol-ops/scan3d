// Весь путь скана: загрузка кадров -> обработка на сервере -> скачивание результата.
// Состояние хранится в IndexedDB, поэтому приложение можно закрыть и вернуться позже.

import { api, ApiError } from "./api.js";
import * as store from "./store.js";
import { sleep } from "./util.js";

const active = new Map();   // scanId -> AbortController
const listeners = new Set();

export const isActive = (id) => active.has(id);

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function update(id, patch) {
  const scan = await store.updateScan(id, patch);
  if (scan) listeners.forEach((fn) => { try { fn(scan); } catch { /* слушатель сломан */ } });
  return scan;
}

const FORMATS = ["glb", "ply", "stl", "obj"];

async function waitForServer(id, signal) {
  await update(id, { status: "uploading", message: "Подключаюсь к серверу", progress: 0.01, error: null });
  await api.wake((sec) => update(id, { message: `Сервер просыпается… ${sec} с`, progress: 0.01 }));
  if (signal.aborted) throw new ApiError("Отменено");
}

async function upload(id, frames, signal) {
  const job = await api.createJob();
  await update(id, { jobId: job.id });
  let done = 0, next = 0, failure = null;
  const worker = async () => {
    while (!failure && next < frames.length && !signal.aborted) {
      const i = next++;
      try {
        await api.uploadFrame(job.id, i, frames[i], signal);
        done++;
        await update(id, { message: `Загружаю фото: ${done} из ${frames.length}`, progress: 0.02 + 0.08 * (done / frames.length) });
      } catch (e) { failure = e; }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  if (signal.aborted) throw new ApiError("Отменено");
  if (failure) throw failure;
  return job.id;
}

async function poll(id, jobId, signal) {
  let offlineSince = 0;
  for (;;) {
    if (signal.aborted) throw new ApiError("Отменено");
    let st;
    try {
      st = await api.status(jobId, signal);
      offlineSince = 0;
    } catch (e) {
      if (signal.aborted) throw new ApiError("Отменено");
      if (e.status === 404) throw new ApiError("Сервер потерял задачу (возможно, перезапускался). Запустите скан заново.");
      if (!e.network) throw e;
      if (!offlineSince) offlineSince = Date.now();
      if (Date.now() - offlineSince > 15 * 60 * 1000) throw new ApiError("Нет связи с сервером больше 15 минут.");
      await update(id, { message: "Нет связи, жду…" });
      await sleep(4000);
      continue;
    }
    if (st.state === "error") throw new ApiError(st.error || "Ошибка обработки на сервере.");
    if (st.state === "cancelled") throw new ApiError("Отменено");
    if (st.state === "done") return st;
    let msg = st.message || "Обработка";
    if (st.state === "queued") msg = st.queue_position > 0 ? `В очереди: впереди ${st.queue_position}` : "Ожидание сервера";
    await update(id, { status: "processing", message: msg, progress: 0.1 + 0.8 * (st.progress || 0), stage: st.stage });
    await sleep(2000);
  }
}

async function fetchResults(id, jobId, serverResult, signal) {
  const span = [0.9, 0.99];
  const total = FORMATS.length + 1;
  let n = 0;
  const bump = (frac, label) => update(id, {
    status: "processing", message: label, progress: span[0] + (span[1] - span[0]) * ((n + frac) / total),
  });
  const files = {};
  const preview = await api.download(jobId, "preview.jpg", null, signal).catch(() => null);
  if (preview) await store.putBlob(`${id}/thumb`, preview);
  n++;
  for (const fmt of FORMATS) {
    await bump(0, `Скачиваю модель (${fmt.toUpperCase()})`);
    const blob = await api.download(jobId, fmt, (f) => bump(f, `Скачиваю модель (${fmt.toUpperCase()})`), signal);
    await store.putBlob(`${id}/model.${fmt}`, blob);
    files[fmt] = blob.size;
    n++;
    if (fmt === "glb") await update(id, { files: { ...files }, stats: serverResult, modelReady: true });
  }
  return files;
}

function friendly(e) {
  if (!e) return "Неизвестная ошибка";
  if (e.name === "QuotaExceededError") return "На телефоне не хватает места для модели.";
  return e.message || String(e);
}

async function run(id, mode) {
  const ctl = new AbortController();
  active.set(id, ctl);
  try {
    let scan = await store.getScan(id);
    let jobId = scan.jobId;
    if (mode === "fresh") {
      const frames = await store.loadFrames(id);
      if (frames.length < 8) throw new ApiError("Кадры не сохранились. Снимите заново.");
      await waitForServer(id, ctl.signal);
      jobId = await upload(id, frames, ctl.signal);
      await update(id, { message: "Запускаю обработку", progress: 0.1 });
      scan = await store.getScan(id);
      await api.start(jobId, { quality: scan.quality, crop: scan.crop });
    } else {
      await update(id, { status: "processing", message: "Проверяю состояние…" });
    }
    const result = await poll(id, jobId, ctl.signal);
    const files = await fetchResults(id, jobId, result.result || {}, ctl.signal);
    await update(id, { status: "done", progress: 1, message: "Готово", files, stats: result.result || {}, error: null });
    await store.deleteFrames(id);
    api.remove(jobId);
  } catch (e) {
    const scan = await store.getScan(id);
    if (ctl.signal.aborted || (e instanceof ApiError && e.message === "Отменено")) {
      await update(id, { status: "cancelled", message: "Отменено", error: null });
    } else {
      await update(id, { status: "error", message: "Ошибка", error: friendly(e) });
    }
    if (scan && scan.jobId && !(e && e.status === 404)) { /* задача остаётся на сервере до очистки по TTL */ }
  } finally {
    active.delete(id);
  }
}

export function submit(id) { if (!active.has(id)) run(id, "fresh"); }
export function resume(id) { if (!active.has(id)) run(id, "resume"); }

export async function cancel(id) {
  const ctl = active.get(id);
  const scan = await store.getScan(id);
  if (scan && scan.jobId) api.cancel(scan.jobId);
  if (ctl) ctl.abort();
}

// При запуске приложения: незавершённые задачи продолжаем опрашивать или помечаем прерванными.
export async function resumeAll() {
  const scans = await store.listScans();
  for (const s of scans) {
    if (active.has(s.id)) continue;
    if (s.status === "processing" && s.jobId) resume(s.id);
    else if (s.status === "uploading") {
      await update(s.id, { status: "error", message: "Ошибка", error: "Загрузка прервалась. Нажмите «Повторить»." });
    }
  }
}
