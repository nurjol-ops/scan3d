import { h, icon, toast, sheet, confirmDialog, promptDialog, fmtSize, infoDialog } from "../util.js";
import * as store from "../store.js";
import { Viewer, parseGLB } from "../viewer.js";
import { shareFile } from "../native.js";

const FORMATS = [
  { id: "glb", label: "GLB", hint: "С цветом. Для просмотра, Blender, AR" },
  { id: "obj", label: "OBJ", hint: "С цветом вершин. Blender, MeshLab" },
  { id: "ply", label: "PLY", hint: "С цветом вершин. MeshLab, CloudCompare" },
  { id: "stl", label: "STL", hint: "Без цвета. Для 3D-печати" },
];

const safeName = (s) => (s || "scan").replace(/[^\p{L}\p{N}_-]+/gu, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "scan";

export function mount(root, params, nav) {
  const id = params.id;
  let scan = null, viewer = null, alive = true;
  const canvas = h("canvas", { class: "gl", "aria-label": "3D-модель" });
  const title = h("button", { class: "title-btn", onclick: rename }, "Скан");
  const info = h("div", { class: "model-info" });
  const modes = h("div", { class: "seg", role: "radiogroup" });
  const spin = h("button", { class: "icon-btn tool", "aria-label": "Вращать", "aria-pressed": "false" }, icon("rotate"));
  let mode = "color", rotating = false;

  function paintModes() {
    modes.replaceChildren(...[["color", "Цвет"], ["clay", "Глина"], ["wire", "Сетка"]].map(([k, t]) => h("button", {
      role: "radio", "aria-checked": String(k === mode), class: k === mode ? "on" : "",
      onclick: () => { mode = k; viewer && viewer.setMode(k); paintModes(); },
    }, t)));
  }

  async function rename() {
    const name = await promptDialog({ title: "Название скана", value: scan.name });
    if (name) { scan = await store.updateScan(id, { name }); title.textContent = name; }
  }

  async function exportMenu() {
    const items = FORMATS.filter((f) => scan.files && scan.files[f.id]).map((f) => ({
      label: `${f.label}, ${fmtSize(scan.files[f.id])}`, hint: f.hint, icon: "share", value: f.id }));
    if (!items.length) { toast("Файлы не найдены"); return; }
    const fmt = await sheet({ title: "Поделиться или сохранить", items });
    if (!fmt) return;
    try {
      const blob = await store.getBlob(`${id}/model.${fmt}`);
      if (!blob) throw new Error("Файл не найден на телефоне");
      const res = await shareFile(blob, `${safeName(scan.name)}.${fmt}`, scan.name);
      if (res === "downloaded") toast("Файл сохранён в «Загрузки»");
    } catch (e) { toast(e.message || "Не удалось отправить файл", "error"); }
  }

  async function remove() {
    if (await confirmDialog({ title: "Удалить скан?", text: "Модель будет удалена с телефона.", ok: "Удалить", danger: true })) {
      await store.deleteScan(id); nav.back();
    }
  }

  spin.addEventListener("click", () => {
    rotating = !rotating; spin.setAttribute("aria-pressed", String(rotating)); spin.classList.toggle("on", rotating);
    viewer && viewer.setAutoRotate(rotating);
  });

  root.classList.add("model");
  root.append(
    canvas,
    h("header", { class: "bar-top float" },
      h("button", { class: "icon-btn", "aria-label": "Назад", onclick: () => nav.back() }, icon("back")),
      title,
      h("button", { class: "icon-btn", "aria-label": "Удалить", onclick: remove }, icon("trash"))),
    h("div", { class: "model-dock" }, info,
      h("div", { class: "tools" }, modes, spin,
        h("button", { class: "btn primary", onclick: exportMenu }, icon("share"), "Экспорт"))));
  paintModes();

  (async () => {
    scan = await store.getScan(id);
    if (!scan) { nav.back(); return; }
    title.textContent = scan.name;
    const st = scan.stats || {};
    info.textContent = st.faces ? `${st.vertices.toLocaleString("ru-RU")} вершин, ${st.faces.toLocaleString("ru-RU")} граней` : "";
    try {
      const blob = await store.getBlob(`${id}/model.glb`);
      if (!blob) throw new Error("Файл модели не найден на телефоне.");
      const mesh = parseGLB(await blob.arrayBuffer());
      if (!alive) return;
      viewer = new Viewer(canvas);
      viewer.setMesh(mesh);
      if (!scan.modelThumb) {
        requestAnimationFrame(async () => {
          if (!alive) return;
          try {
            const thumb = await viewer.snapshot(360);
            if (thumb) { await store.putBlob(`${id}/thumb`, thumb); await store.updateScan(id, { modelThumb: true }); }
          } catch { /* превью необязательно */ }
        });
      }
    } catch (e) {
      info.textContent = "";
      root.append(h("div", { class: "cam-error" }, h("h2", null, "Не удалось открыть модель"), h("p", null, e.message || String(e)),
        h("button", { class: "btn primary", onclick: () => nav.back() }, "Назад")));
    }
  })();

  return { cleanup() { alive = false; viewer && viewer.destroy(); root.classList.remove("model"); } };
}
