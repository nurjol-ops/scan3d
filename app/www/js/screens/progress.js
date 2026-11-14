import { h, icon, confirmDialog } from "../util.js";
import * as store from "../store.js";
import * as jobs from "../jobs.js";

const STEPS = ["Загрузка фото", "Положение камер", "Глубина", "Сборка модели", "Сохранение на телефон"];

function stepIndex(s) {
  if (s.status === "uploading" || (s.progress || 0) < 0.1) return 0;
  if ((s.progress || 0) >= 0.9) return 4;
  const stage = s.stage || "";
  if (stage === "depth") return 2;
  if (stage === "fusion" || stage === "export") return 3;
  return 1;
}

export function mount(root, params, nav) {
  const id = params.id;
  let alive = true;
  const title = h("h1", { class: "small" }, "Скан");
  const body = h("div", { class: "scroll prog" });
  const dock = h("div", { class: "dock" });

  async function paint(scan) {
    if (!alive || !scan) return;
    title.textContent = scan.name;
    const running = scan.status === "uploading" || scan.status === "processing";
    if (scan.status === "done") { nav.replace("model", { id }); return; }
    const cur = stepIndex(scan);
    const pct = Math.round((scan.progress || 0) * 100);
    body.replaceChildren();
    if (running) {
      body.append(
        h("div", { class: "pct" }, `${pct}`, h("span", null, "%")),
        h("div", { class: "meter" }, h("i", { style: { width: `${pct}%` } })),
        h("p", { class: "msg" }, scan.message || "Обработка"),
        h("ol", { class: "steps" }, STEPS.map((t, i) => h("li", { class: i < cur ? "done" : i === cur ? "cur" : "" }, h("i"), t))),
        h("p", { class: "note" }, "Можно закрыть приложение: обработка идёт на сервере, а результат подхватится при следующем запуске."));
    } else if (scan.status === "error") {
      body.append(h("div", { class: "result err" },
        h("h2", null, "Не получилось собрать модель"),
        h("p", null, scan.error || "Неизвестная ошибка."),
        h("p", { class: "note" }, "Советы: снимайте при ровном свете, без бликов; предмет должен занимать центр кадра; двигайтесь медленно и обходите его с трёх высот.")));
    } else if (scan.status === "cancelled") {
      body.append(h("div", { class: "result" }, h("h2", null, "Обработка отменена"), h("p", null, "Снятые кадры сохранены — можно запустить расчёт заново.")));
    } else {
      body.append(h("div", { class: "result" }, h("h2", null, "Черновик"), h("p", null, "Кадры сохранены на телефоне.")));
    }
    dock.replaceChildren();
    if (running) {
      dock.append(h("button", { class: "btn outline big", onclick: async () => {
        if (await confirmDialog({ title: "Отменить обработку?", text: "Расчёт на сервере остановится.", ok: "Отменить", cancel: "Продолжить", danger: true })) jobs.cancel(id);
      } }, "Отменить"));
    } else {
      const frames = await store.loadFrames(id);
      if (!alive) return;
      if (frames.length >= 8) dock.append(h("button", { class: "btn primary big", onclick: () => jobs.submit(id) }, icon("retry"), "Повторить"));
      dock.append(h("button", { class: "btn text danger-text", onclick: async () => {
        if (await confirmDialog({ title: "Удалить скан?", text: "Кадры будут удалены с телефона.", ok: "Удалить", danger: true })) { await store.deleteScan(id); nav.back(); }
      } }, "Удалить"));
    }
  }

  root.append(
    h("header", { class: "bar-top" },
      h("button", { class: "icon-btn", "aria-label": "Назад", onclick: () => nav.back() }, icon("back")), title),
    body, dock);

  store.getScan(id).then((s) => { if (!s) nav.back(); else paint(s); });
  const unsub = jobs.subscribe((s) => { if (s.id === id) paint(s); });
  return () => { alive = false; unsub(); };
}
