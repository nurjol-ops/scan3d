import { h, icon, toast, infoDialog } from "../util.js";
import { getSettings, saveSettings, normalizeUrl } from "../settings.js";
import { api } from "../api.js";
import * as store from "../store.js";
import { fmtSize } from "../util.js";

export function mount(root, _p, nav) {
  const s = getSettings();
  const url = h("input", { class: "field", type: "url", inputmode: "url", autocomplete: "off", autocapitalize: "off", spellcheck: "false",
    placeholder: "https://scan3d-server.onrender.com", value: s.serverUrl });
  const key = h("input", { class: "field", type: "password", autocomplete: "off", placeholder: "Если на сервере задан API_KEY", value: s.apiKey });
  const result = h("div", { class: "test-result", role: "status" });
  const test = h("button", { class: "btn outline" }, "Проверить сервер");
  const storage = h("p", { class: "note" });

  const persist = () => saveSettings({ serverUrl: normalizeUrl(url.value), apiKey: key.value.trim() });
  url.addEventListener("change", persist);
  key.addEventListener("change", persist);
  url.addEventListener("blur", () => { url.value = normalizeUrl(url.value); persist(); });

  test.addEventListener("click", async () => {
    persist();
    if (!normalizeUrl(url.value)) { result.className = "test-result bad"; result.textContent = "Введите адрес сервера."; return; }
    test.disabled = true; result.className = "test-result"; result.textContent = "Проверяю… Если сервер спал, это займёт до минуты.";
    try {
      const info = await api.info();
      const parts = [`Сервер работает, версия ${info.version}.`];
      if (!info.colmap) { result.className = "test-result bad"; parts.push("Но COLMAP на сервере не найден — модели не соберутся."); }
      else result.className = "test-result good";
      if (info.auth) parts.push("Нужен ключ доступа.");
      result.textContent = parts.join(" ");
    } catch (e) { result.className = "test-result bad"; result.textContent = e.message; }
    test.disabled = false;
  });

  store.storageEstimate().then((e) => { if (e && e.usage != null) storage.textContent = `Занято на телефоне: ${fmtSize(e.usage)}.`; });

  root.append(
    h("header", { class: "bar-top" },
      h("button", { class: "icon-btn", "aria-label": "Назад", onclick: () => { persist(); nav.back(); } }, icon("back")),
      h("h1", { class: "small" }, "Настройки")),
    h("div", { class: "scroll settings" },
      h("h2", { class: "sec first" }, "Сервер"),
      h("label", { class: "lbl" }, "Адрес", url),
      h("label", { class: "lbl" }, "Ключ доступа", key),
      test, result,
      h("p", { class: "note" }, "Адрес выдаёт Render после деплоя, например https://scan3d-server.onrender.com. На бесплатных и недорогих планах сервер засыпает, поэтому первое подключение занимает до минуты."),
      h("h2", { class: "sec" }, "Съёмка"),
      h("div", { class: "lbl" }, "Режим по умолчанию",
        h("div", { class: "seg" },
          ...[["auto", "Авто"], ["manual", "Вручную"]].map(([k, t]) => h("button", {
            class: getSettings().mode === k ? "on" : "", onclick: (e) => {
              saveSettings({ mode: k });
              e.target.parentElement.querySelectorAll("button").forEach((b) => b.classList.remove("on"));
              e.target.classList.add("on");
            } }, t)))),
      h("h2", { class: "sec" }, "О приложении"),
      h("p", { class: "note" }, "Scan3D 1.0. Фотограмметрия: положение камер считает COLMAP, глубину и сетку — ваш сервер. Модели и фото хранятся только на телефоне и на вашем сервере."),
      storage));
}
