// Запускается в GitHub Actions после `npx cap add android`:
// добавляет разрешения камеры, иконку и подставляет адрес сервера по умолчанию.
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const android = path.join(root, "android");
const manifestPath = path.join(android, "app/src/main/AndroidManifest.xml");

let m = fs.readFileSync(manifestPath, "utf8");
const perms = [
  '<uses-permission android:name="android.permission.CAMERA" />',
  '<uses-permission android:name="android.permission.INTERNET" />',
  '<uses-permission android:name="android.permission.VIBRATE" />',
  '<uses-feature android:name="android.hardware.camera" android:required="false" />',
  '<uses-feature android:name="android.hardware.sensor.compass" android:required="false" />',
];
for (const p of perms) {
  const name = p.match(/android:name="([^"]+)"/)[1];
  if (!m.includes(`"${name}"`)) m = m.replace("</manifest>", `    ${p}\n</manifest>`);
}
if (!m.includes("usesCleartextTraffic")) m = m.replace("<application", '<application\n        android:usesCleartextTraffic="true"');
// портретная ориентация для экрана съёмки (одинаковый размер кадров)
if (!m.includes("screenOrientation")) m = m.replace(/(<activity\b)/, '$1\n            android:screenOrientation="portrait"');
fs.writeFileSync(manifestPath, m);
console.log("AndroidManifest.xml обновлён");

// иконки
const resSrc = path.join(root, "resources/android/res");
const resDst = path.join(android, "app/src/main/res");
const copyDir = (src, dst) => {
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) { fs.mkdirSync(d, { recursive: true }); copyDir(s, d); } else fs.copyFileSync(s, d);
  }
};
if (fs.existsSync(resSrc)) { copyDir(resSrc, resDst); console.log("Иконки скопированы"); }

// адрес сервера по умолчанию из переменной репозитория SERVER_URL
const url = (process.env.SERVER_URL || "").trim();
if (url) {
  const cfg = path.join(root, "www/js/config.js");
  fs.writeFileSync(cfg, `export default {\n  serverUrl: ${JSON.stringify(url)},\n};\n`);
  console.log("Адрес сервера по умолчанию:", url);
}
