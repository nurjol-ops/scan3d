import { getSettings, normalizeUrl } from "./settings.js";
import { sleep } from "./util.js";

export class ApiError extends Error {
  constructor(message, { status = 0, network = false } = {}) {
    super(message);
    this.status = status;
    this.network = network;
  }
}

function baseUrl() {
  const u = normalizeUrl(getSettings().serverUrl);
  if (!u) throw new ApiError("Адрес сервера не указан. Откройте настройки.");
  return u;
}

async function request(path, { method = "GET", body, headers = {}, timeout = 30000, signal, json = true } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort("timeout"), timeout);
  if (signal) {
    if (signal.aborted) ctl.abort("aborted");
    signal.addEventListener("abort", () => ctl.abort("aborted"), { once: true });
  }
  const h = { ...headers };
  const key = getSettings().apiKey;
  if (key) h["X-API-Key"] = key;
  let res;
  try {
    res = await fetch(baseUrl() + path, { method, body, headers: h, signal: ctl.signal });
  } catch (e) {
    if (ctl.signal.reason === "aborted") throw new ApiError("Отменено", { network: false });
    if (ctl.signal.reason === "timeout") throw new ApiError("Сервер не отвечает. Попробуйте ещё раз.", { network: true });
    if (e instanceof ApiError) throw e;
    throw new ApiError("Нет связи с сервером. Проверьте адрес и интернет.", { network: true });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let msg = "";
    try { msg = (await res.json()).error || ""; } catch { /* не JSON */ }
    if (res.status === 401) msg = "Неверный ключ доступа. Проверьте его в настройках.";
    if (!msg) msg = res.status >= 500 ? "Ошибка на сервере. Попробуйте позже." : `Ошибка ${res.status}`;
    throw new ApiError(msg, { status: res.status, network: res.status >= 502 && res.status <= 504 });
  }
  return json ? res.json() : res;
}

export const api = {
  // Render на бесплатном и недорогих планах засыпает; первый запрос может идти до минуты.
  async wake(onWaiting) {
    const t0 = Date.now();
    for (let attempt = 0; ; attempt++) {
      try {
        return await request("/api/info", { timeout: 20000 });
      } catch (e) {
        if (!e.network || Date.now() - t0 > 120000) throw e;
        onWaiting && onWaiting(Math.round((Date.now() - t0) / 1000));
        await sleep(2000);
      }
    }
  },
  info: () => request("/api/info", { timeout: 90000 }),
  createJob: () => request("/api/jobs", { method: "POST" }),
  start: (id, opts) => request(`/api/jobs/${id}/start`, {
    method: "POST", body: JSON.stringify(opts), headers: { "Content-Type": "application/json" } }),
  status: (id, signal) => request(`/api/jobs/${id}`, { signal, timeout: 20000 }),
  cancel: (id) => request(`/api/jobs/${id}/cancel`, { method: "POST" }).catch(() => null),
  remove: (id) => request(`/api/jobs/${id}`, { method: "DELETE", json: false }).catch(() => null),

  async uploadFrame(id, index, blob, signal) {
    let last;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return await request(`/api/jobs/${id}/frames/${index}`, {
          method: "PUT", body: blob, headers: { "Content-Type": "image/jpeg" }, timeout: 90000, signal });
      } catch (e) {
        last = e;
        if (!e.network || signal?.aborted) throw e;
        await sleep(1000 * (attempt + 1));
      }
    }
    throw last;
  },

  async download(id, fmt, onProgress, signal) {
    const res = await request(`/api/jobs/${id}/files/${fmt}`, { json: false, timeout: 180000, signal });
    const total = Number(res.headers.get("content-length")) || 0;
    if (!res.body || !res.body.getReader || !onProgress) return res.blob();
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      if (total) onProgress(got / total);
    }
    return new Blob(chunks, { type: res.headers.get("content-type") || "application/octet-stream" });
  },
};
