import { h, icon, fmtDate, toast, plural, infoDialog, confirmDialog } from "../util.js";
import * as store from "../store.js";
import * as jobs from "../jobs.js";
import { getSettings, saveSettings } from "../settings.js";

const QUALITY = {
  fast: { label: "Быстро", text: "Меньше деталей, быстрее и легче для сервера. В расчёт идёт до 36 кадров.", cap: 36 },
  normal: { label: "Обычное", text: "Хороший баланс деталей и времени. В расчёт идёт до 60 кадров.", cap: 60 },
  high: { label: "Высокое", text: "Больше деталей, дольше. Нужен сервер с 4 ГБ памяти и больше. До 80 кадров.", cap: 80 },
};

export function mount(root, params, nav) {
  const frames = params.frames.map((f) => ({ ...f, off: false }));
  const s = getSettings();
  let quality = QUALITY[s.quality] ? s.quality : "normal";
  let crop = s.crop !== false;
  let saving = false;

  const grid = h("div", { class: "frames" });
  const qSeg = h("div", { class: "seg", role: "radiogroup" });
  const qText = h("p", { class: "q-text" });
  const note = h("p", { class: "note" });
  const create = h("button", { class: "btn primary big" }, "Создать модель");

  const used = () => frames.filter((f) => !f.off);

  function paint() {
    const n = used().length;
    grid.replaceChildren(...frames.map((f, i) => h("button", {
      class: "frame" + (f.off ? " off" : ""), "aria-label": `Кадр ${i + 1}${f.off ? ", убран" : ""}`, "aria-pressed": String(f.off),
      onclick: () => { f.off = !f.off; paint(); },
    }, h("img", { src: f.thumb, alt: "" }))));
    qSeg.replaceChildren(...Object.entries(QUALITY).map(([k, v]) => h("button", {
      role: "radio", "aria-checked": String(k === quality), class: k === quality ? "on" : "",
      onclick: () => { quality = k; saveSettings({ quality }); paint(); },
    }, v.label)));
    qText.textContent = QUALITY[quality].text;
    const cap = QUALITY[quality].cap;
    note.textContent = n > cap ? `Из ${n} кадров сервер равномерно выберет ${cap}.` : "";
    create.disabled = n < 8 || saving;
    create.textContent = saving ? "Сохраняю кадры…" : "Создать модель";
    summary.textContent = `${n} ${plural(n, "кадр", "кадра", "кадров")} из ${frames.length}`;
  }

  const summary = h("div", { class: "summary" });

  create.addEventListener("click", async () => {
    if (saving) return;
    const list = used();
    if (list.length < 8) return;
    saving = true; paint();
    try {
      const id = store.newId();
      await store.putScan({
        id, name: `Скан ${fmtDate(Date.now())}`, created: Date.now(), status: "draft", frames: list.length,
        quality, crop, progress: 0, message: "", error: null, jobId: null,
      });
      await store.saveFrames(id, list.map((f) => f.blob));
      saveSettings({ quality, crop });
      jobs.submit(id);
      nav.replace("progress", { id }, { clearTo: "library" });
    } catch (e) {
      saving = false; paint();
      infoDialog({ title: "Не удалось сохранить кадры", text: e && e.name === "QuotaExceededError" ? "На телефоне не хватает места." : String(e.message || e) });
    }
  });

  const cropRow = h("label", { class: "switch-row" },
    h("span", null, h("b", null, "Убрать стол и фон"), h("small", null, "Оставит только сам предмет. Выключите, если нужна вся сцена.")),
    h("input", { type: "checkbox", checked: crop, onchange: (e) => { crop = e.target.checked; } }));

  root.append(
    h("header", { class: "bar-top" },
      h("button", { class: "icon-btn", "aria-label": "Назад", onclick: () => back() }, icon("back")),
      h("h1", { class: "small" }, "Проверьте кадры")),
    h("div", { class: "scroll review" },
      h("p", { class: "lead" }, "Нажмите на размытый или лишний кадр, чтобы убрать его."),
      grid, summary,
      h("h2", { class: "sec" }, "Качество"),
      qSeg, qText, note, cropRow),
    h("div", { class: "dock" }, create));
  paint();

  async function back() {
    if (await confirmDialog({ title: "Вернуться к съёмке?", text: "Снятые кадры не сохранятся.", ok: "Выйти", cancel: "Остаться", danger: true })) nav.back();
  }
  return { onBack: () => { back(); return true; } };
}
