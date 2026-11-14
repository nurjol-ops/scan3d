import { h, icon, fmtDate, plural, toast, sheet, confirmDialog, promptDialog, infoDialog } from "../util.js";
import * as store from "../store.js";
import * as jobs from "../jobs.js";
import { getSettings } from "../settings.js";

export async function startNewScan(nav) {
  if (!getSettings().serverUrl) {
    const go = await confirmDialog({
      title: "Сначала подключите сервер",
      text: "Модель собирается на вашем сервере. Укажите его адрес в настройках — это нужно сделать один раз.",
      ok: "Открыть настройки", cancel: "Позже",
    });
    if (go) nav.push("settings");
    return;
  }
  nav.push("capture");
}

function statusText(s) {
  switch (s.status) {
    case "done": return s.stats && s.stats.faces ? `${Math.round(s.stats.faces / 1000)} тыс. граней` : "Готово";
    case "uploading": case "processing": return s.message || "Обработка";
    case "error": return "Ошибка";
    case "cancelled": return "Отменено";
    default: return `Черновик, ${s.frames} ${plural(s.frames, "фото", "фото", "фото")}`;
  }
}

export function mount(root, _p, nav) {
  const urls = [];
  const grid = h("div", { class: "grid" });
  const body = h("div", { class: "scroll" });
  let alive = true, timer = 0;
  const fab = h("div", { class: "fab-wrap", hidden: true },
    h("button", { class: "btn primary fab", onclick: () => startNewScan(nav) }, icon("plus"), "Новый скан"));

  const render = async () => {
    const scans = await store.listScans();
    if (!alive) return;
    urls.splice(0).forEach((u) => URL.revokeObjectURL(u));
    grid.replaceChildren();
    body.replaceChildren();
    fab.hidden = !scans.length;
    if (!scans.length) {
      body.append(h("div", { class: "empty" },
        h("div", { class: "empty-art", html: '<svg viewBox="0 0 120 120" aria-hidden="true"><ellipse cx="60" cy="88" rx="44" ry="14" fill="none" stroke="currentColor" stroke-width="2" opacity=".35"/><ellipse cx="60" cy="88" rx="30" ry="8" fill="none" stroke="currentColor" stroke-width="2" opacity=".55"/><path d="M60 22l26 15v30L60 82 34 67V37z" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"/><path d="M60 52l26-15M60 52L34 37M60 52v30" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"/></svg>' }),
        h("h2", null, "Здесь будут ваши модели"),
        h("p", null, "Положите предмет на стол с узором или текстом, обойдите его по кругу и снимите 30–60 кадров. Сервер соберёт из них 3D-модель."),
        h("button", { class: "btn primary big", onclick: () => startNewScan(nav) }, icon("plus"), "Снять первый предмет")));
      return;
    }
    for (const s of scans) {
      const thumbBlob = await store.getBlob(`${s.id}/thumb`);
      if (!alive) return;
      let img = null;
      if (thumbBlob) { const u = URL.createObjectURL(thumbBlob); urls.push(u); img = h("img", { src: u, alt: "", loading: "lazy" }); }
      const busy = s.status === "uploading" || s.status === "processing";
      const tile = h("div", { class: "tile " + s.status },
        h("button", { class: "tile-main", "aria-label": s.name, onclick: () => nav.push(s.status === "done" ? "model" : "progress", { id: s.id }) },
          h("div", { class: "thumb" }, img || icon("cube"),
            busy ? h("div", { class: "bar" }, h("i", { style: { width: `${Math.round((s.progress || 0) * 100)}%` } })) : null),
          h("div", { class: "tile-name" }, s.name),
          h("div", { class: "tile-meta" }, fmtDate(s.created), h("br"), h("span", { class: "st-" + s.status }, statusText(s)))),
        h("button", { class: "tile-more", "aria-label": "Действия", onclick: () => actions(s) }, icon("more")));
      grid.append(tile);
    }
    body.append(grid);
  };

  async function actions(s) {
    const pick = await sheet({ title: s.name, items: [
      { label: "Переименовать", icon: "settings", value: "rename" },
      { label: "Удалить", icon: "trash", danger: true, value: "delete" },
    ] });
    if (pick === "rename") {
      const name = await promptDialog({ title: "Название скана", value: s.name });
      if (name) { await store.updateScan(s.id, { name }); render(); }
    } else if (pick === "delete") {
      if (await confirmDialog({ title: "Удалить скан?", text: "Модель и фото будут удалены с телефона.", ok: "Удалить", danger: true })) {
        if (jobs.isActive(s.id)) await jobs.cancel(s.id);
        await store.deleteScan(s.id);
        render();
      }
    }
  }

  root.append(
    h("header", { class: "bar-top" },
      h("h1", null, "Мои сканы"),
      h("button", { class: "icon-btn", "aria-label": "Настройки", onclick: () => nav.push("settings") }, icon("settings"))),
    body,
    fab);

  render();
  const unsub = jobs.subscribe(() => { clearTimeout(timer); timer = setTimeout(render, 700); });
  return () => { alive = false; unsub(); clearTimeout(timer); urls.forEach((u) => URL.revokeObjectURL(u)); };
}
