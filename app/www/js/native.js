// Мост к Android (Capacitor): кнопка «Назад», отправка файлов. В обычном браузере работает запасной вариант.

const cap = () => window.Capacitor;
export const isNative = () => !!(cap() && cap().isNativePlatform && cap().isNativePlatform());
const plugin = (name) => (cap() && cap().Plugins ? cap().Plugins[name] : null);

export function onBackButton(handler) {
  const App = plugin("App");
  if (App && App.addListener) App.addListener("backButton", handler);
}

export function exitApp() {
  const App = plugin("App");
  if (App && App.exitApp) App.exitApp();
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

// Открывает системное окно «Поделиться / Сохранить в файлы».
export async function shareFile(blob, filename, title) {
  const Filesystem = plugin("Filesystem"), Share = plugin("Share");
  if (isNative() && Filesystem && Share) {
    const data = await blobToBase64(blob);
    const res = await Filesystem.writeFile({ path: filename, data, directory: "CACHE" });
    await Share.share({ title: title || filename, files: [res.uri], dialogTitle: "Сохранить или отправить" });
    return "shared";
  }
  const file = new File([blob], filename, { type: blob.type || "application/octet-stream" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: title || filename }); return "shared"; } catch (e) { if (e.name === "AbortError") return "cancel"; }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return "downloaded";
}

let wakeLock = null;
export async function keepAwake(on) {
  try {
    if (on && navigator.wakeLock) wakeLock = await navigator.wakeLock.request("screen");
    else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { /* не критично */ }
}
