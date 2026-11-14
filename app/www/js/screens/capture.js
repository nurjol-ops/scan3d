import { h, icon, toast, confirmDialog, plural } from "../util.js";
import { Camera, CameraError } from "../camera.js";
import { Dome, Orientation, angleBetween } from "../dome.js";
import { getSettings, saveSettings } from "../settings.js";
import { keepAwake } from "../native.js";

const MAX_FRAMES = 90;
const MIN_FRAMES = 12;
const STEP_DEG = 12;

export function mount(root, _p, nav) {
  let mode = getSettings().mode === "manual" ? "manual" : "auto";
  const frames = [];
  let running = false, busy = false, lastTs = 0, lastVec = null, alive = true;
  const sharp = [];
  let warnTimer = 0, startedAt = performance.now();

  const video = h("video", { class: "cam", playsinline: true, muted: true, autoplay: true });
  const counter = h("div", { class: "counter" }, "0 фото");
  const hint = h("div", { class: "hint" }, "Держите предмет в центре кадра");
  const warn = h("div", { class: "warn" });
  const domeCanvas = h("canvas", { class: "dome", width: 132, height: 132, "aria-label": "Покрытие съёмки" });
  const shutter = h("button", { class: "shutter", "aria-label": "Снять" });
  const done = h("button", { class: "done-btn", disabled: true, "aria-label": "Готово" }, icon("check"), h("span", null, "Готово"));
  const torch = h("button", { class: "round-btn", "aria-label": "Фонарик", style: { visibility: "hidden" } }, icon("torch"));
  const flash = h("div", { class: "flash" });
  const seg = h("div", { class: "seg dark", role: "tablist" });
  const frameBadge = h("div", { class: "min-note" });

  const cam = new Camera();
  const orient = new Orientation();
  const dome = new Dome(domeCanvas);

  const setWarn = (text) => {
    warn.textContent = text; warn.classList.add("on");
    clearTimeout(warnTimer); warnTimer = setTimeout(() => warn.classList.remove("on"), 1400);
  };

  function paintMode() {
    seg.replaceChildren(
      h("button", { role: "tab", class: mode === "auto" ? "on" : "", onclick: () => setMode("auto") }, "Авто"),
      h("button", { role: "tab", class: mode === "manual" ? "on" : "", onclick: () => setMode("manual") }, "Вручную"));
    shutter.classList.toggle("auto", mode === "auto");
    shutter.classList.toggle("running", running);
    shutter.replaceChildren(mode === "auto" ? icon(running ? "pause" : "rotate") : "");
    shutter.setAttribute("aria-label", mode === "auto" ? (running ? "Пауза" : "Начать съёмку") : "Снять кадр");
  }
  function setMode(m) { mode = m; running = false; saveSettings({ mode }); paintMode(); }

  function paintCounter() {
    const n = frames.length;
    counter.textContent = `${n} ${plural(n, "фото", "фото", "фото")}`;
    done.disabled = n < MIN_FRAMES;
    frameBadge.textContent = n < MIN_FRAMES ? `Нужно ещё ${MIN_FRAMES - n}` : "";
    hint.textContent = orient.available ? dome.hint(n) : (n < 6 ? "Держите предмет в центре кадра" : "Обходите предмет по кругу, затем снимите сверху");
  }

  async function capture() {
    if (busy || frames.length >= MAX_FRAMES) return;
    busy = true;
    try {
      const r = await cam.grab();
      if (!r) return;
      if (r.resized) { setWarn("Не поворачивайте телефон во время съёмки"); return; }
      frames.push(r);
      if (orient.available) { dome.mark(orient.az, orient.el); lastVec = orient.vec; }
      lastTs = performance.now();
      flash.classList.remove("go"); void flash.offsetWidth; flash.classList.add("go");
      if (navigator.vibrate) navigator.vibrate(12);
      paintCounter();
      if (frames.length >= MAX_FRAMES) { running = false; paintMode(); toast("Достигнут предел кадров"); }
    } finally { busy = false; }
  }

  function tick() {
    if (!alive) return;
    if (orient.available) domeCanvas.classList.remove("off"); else if (performance.now() - startedAt > 2500) domeCanvas.classList.add("off");
    dome.draw(orient.available ? orient.az : null, orient.el);
    if (!running || busy) return;
    const now = performance.now();
    if (now - lastTs < 450) return;
    const sh = cam.sharpness();
    sharp.push(sh); if (sharp.length > 24) sharp.shift();
    if (orient.available) {
      if (orient.rate > 45) { setWarn("Двигайтесь медленнее"); return; }
      if (lastVec && orient.vec && angleBetween(lastVec, orient.vec) < STEP_DEG) return;
    } else if (now - lastTs < 1300) return;
    if (sharp.length >= 6) {
      const sorted = [...sharp].sort((a, b) => a - b);
      const base = sorted[Math.floor(sorted.length * 0.75)];
      if (sh < base * 0.45) { setWarn("Кадр размыт, замрите на секунду"); return; }
    }
    capture();
  }

  shutter.addEventListener("click", () => {
    if (mode === "manual") {
      const sh = cam.sharpness(); sharp.push(sh);
      capture();
    } else { running = !running; if (running) lastTs = 0; paintMode(); }
  });
  done.addEventListener("click", () => {
    if (frames.length < MIN_FRAMES) return;
    nav.replace("review", { frames });
  });
  torch.addEventListener("click", async () => {
    const ok = await cam.setTorch(!cam.torchOn);
    torch.classList.toggle("on", ok && cam.torchOn);
  });

  async function leave() {
    if (frames.length && !(await confirmDialog({ title: "Выйти без сохранения?", text: `Снятые кадры (${frames.length}) будут удалены.`, ok: "Выйти", cancel: "Остаться", danger: true }))) return;
    nav.back();
  }

  root.classList.add("capture");
  root.append(
    video,
    h("div", { class: "guide", "aria-hidden": "true" }),
    flash,
    h("div", { class: "top" },
      h("button", { class: "round-btn", "aria-label": "Закрыть", onclick: leave }, icon("close")),
      counter, torch),
    warn,
    h("div", { class: "bottom" },
      hint,
      h("div", { class: "row" }, domeCanvas, shutter, h("div", { class: "done-col" }, done, frameBadge)),
      seg));
  paintMode(); paintCounter();

  const timer = setInterval(tick, 140);
  keepAwake(true);
  orient.start();
  cam.start(video).then(() => {
    if (!alive) { cam.stop(); return; }
    if (cam.hasTorch) torch.style.visibility = "visible";
  }).catch((e) => {
    root.append(h("div", { class: "cam-error" },
      h("h2", null, "Камера не включилась"),
      h("p", null, e instanceof CameraError ? e.message : String(e.message || e)),
      h("button", { class: "btn primary", onclick: () => nav.back() }, "Назад")));
  });

  const api = {
    onBack: () => { leave(); return true; },
    cleanup() {
      alive = false; clearInterval(timer); orient.stop(); cam.stop(); keepAwake(false);
      root.classList.remove("capture");
    },
  };
  return api;
}
