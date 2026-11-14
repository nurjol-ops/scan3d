// Локальное хранилище на телефоне (IndexedDB): сканы, готовые модели и кадры черновиков.

const DB_NAME = "scan3d";
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("scans")) db.createObjectStore("scans", { keyPath: "id" });
      if (!db.objectStoreNames.contains("blobs")) db.createObjectStore("blobs");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB недоступна"));
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const st = t.objectStore(store);
    let result;
    Promise.resolve(fn(st)).then((r) => { result = r; }).catch(reject);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error("Не удалось записать данные (нет места?)"));
  }));
}

const wrap = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

export async function listScans() {
  const all = await tx("scans", "readonly", (s) => wrap(s.getAll()));
  return all.sort((a, b) => b.created - a.created);
}

export const getScan = (id) => tx("scans", "readonly", (s) => wrap(s.get(id)));
export const putScan = (scan) => tx("scans", "readwrite", (s) => wrap(s.put(scan)));

export async function updateScan(id, patch) {
  const cur = await getScan(id);
  if (!cur) return null;
  const next = { ...cur, ...patch };
  await putScan(next);
  return next;
}

export const putBlob = (key, blob) => tx("blobs", "readwrite", (s) => wrap(s.put(blob, key)));
export const getBlob = (key) => tx("blobs", "readonly", (s) => wrap(s.get(key)));

export async function deleteBlobs(prefix) {
  await tx("blobs", "readwrite", (s) => new Promise((resolve, reject) => {
    const range = IDBKeyRange.bound(prefix, prefix + "￿");
    const req = s.openCursor(range);
    req.onsuccess = () => {
      const c = req.result;
      if (c) { c.delete(); c.continue(); } else resolve();
    };
    req.onerror = () => reject(req.error);
  }));
}

export async function deleteScan(id) {
  await deleteBlobs(id + "/");
  await tx("scans", "readwrite", (s) => wrap(s.delete(id)));
}

// ----- кадры черновика
export async function saveFrames(id, blobs) {
  await deleteBlobs(id + "/f/");
  for (let i = 0; i < blobs.length; i++) await putBlob(`${id}/f/${String(i).padStart(4, "0")}`, blobs[i]);
}

export async function loadFrames(id) {
  const out = [];
  for (let i = 0; i < 400; i++) {
    const b = await getBlob(`${id}/f/${String(i).padStart(4, "0")}`);
    if (!b) break;
    out.push(b);
  }
  return out;
}

export const deleteFrames = (id) => deleteBlobs(id + "/f/");

export async function storageEstimate() {
  try { return await navigator.storage.estimate(); } catch { return null; }
}
