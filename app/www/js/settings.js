import defaults from "./config.js";

const KEY = "scan3d.settings.v1";
const base = {
  serverUrl: defaults.serverUrl || "",
  apiKey: "",
  quality: "normal",
  crop: true,
  mode: "auto",
};

let cache = null;

export function getSettings() {
  if (cache) return cache;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { /* пусто */ }
  cache = { ...base, ...saved };
  if (!cache.serverUrl) cache.serverUrl = base.serverUrl;
  return cache;
}

export function saveSettings(patch) {
  cache = { ...getSettings(), ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* приватный режим */ }
  return cache;
}

export function normalizeUrl(raw) {
  let u = (raw || "").trim();
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) {
    const local = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u);
    u = (local ? "http://" : "https://") + u;
  }
  return u.replace(/\/+$/, "");
}
