// Небольшие помощники: создание DOM, иконки, диалоги, форматирование.

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "html") el.innerHTML = v;
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else if (v === true) el.setAttribute(k, "");
      else el.setAttribute(k, v);
    }
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

const svg = (d, extra = "") =>
  `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${d}</svg>`;

export const icons = {
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  back: svg('<path d="M15 5l-7 7 7 7"/>'),
  settings: svg('<circle cx="12" cy="12" r="3.2"/><path d="M19.4 14.5a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3h0a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5h0a1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8v0a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  more: svg('<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>'),
  share: svg('<path d="M12 4v11M7.5 8.5L12 4l4.5 4.5M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"/>'),
  trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>'),
  torch: svg('<path d="M7 3h10l-2 7v3l-3 8-3-8v-3z"/>'),
  rotate: svg('<path d="M20 12a8 8 0 1 1-2.5-5.8M20 4v4.5h-4.5"/>'),
  cube: svg('<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12L4 7.5M12 12v9"/>'),
  retry: svg('<path d="M4 12a8 8 0 1 0 2.5-5.8M4 4v4.5h4.5"/>'),
  pause: svg('<path d="M8 5v14M16 5v14"/>', 'stroke-width="2.6"'),
};

export function icon(name) {
  const s = document.createElement("span");
  s.className = "ico";
  s.innerHTML = icons[name] || "";
  return s;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MONTHS = ["янв.", "февр.", "марта", "апр.", "мая", "июня", "июля", "авг.", "сент.", "окт.", "нояб.", "дек."];
export function fmtDate(ts) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${hh}:${mm}`;
}

export function fmtSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(bytes > 20 * 1024 * 1024 ? 0 : 1)} МБ`;
}

export function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

let toastTimer = 0;
export function toast(text, kind = "") {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = text;
  el.className = "show " + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ""), kind === "error" ? 5200 : 2600);
}

// ---------------------------------------------------------------- диалоги

const overlays = [];
export function hasOverlay() { return overlays.length > 0; }
export function closeTopOverlay() {
  const top = overlays[overlays.length - 1];
  if (top) { top.close(null); return true; }
  return false;
}

function openOverlay(build) {
  return new Promise((resolve) => {
    const backdrop = h("div", { class: "backdrop" });
    const state = { close: null };
    const close = (value) => {
      const i = overlays.indexOf(state);
      if (i >= 0) overlays.splice(i, 1);
      backdrop.classList.add("out");
      setTimeout(() => backdrop.remove(), 160);
      resolve(value);
    };
    state.close = close;
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(null); });
    build(backdrop, close);
    overlays.push(state);
    document.body.append(backdrop);
  });
}

export function confirmDialog({ title, text, ok = "Да", cancel = "Отмена", danger = false }) {
  return openOverlay((root, close) => {
    root.append(h("div", { class: "dialog", role: "alertdialog" },
      h("h2", null, title),
      text ? h("p", null, text) : null,
      h("div", { class: "dialog-actions" },
        h("button", { class: "btn text", onclick: () => close(false) }, cancel),
        h("button", { class: "btn " + (danger ? "danger" : "primary"), onclick: () => close(true) }, ok))));
  }).then((v) => !!v);
}

export function infoDialog({ title, text, ok = "Понятно" }) {
  return openOverlay((root, close) => {
    root.append(h("div", { class: "dialog", role: "alertdialog" },
      h("h2", null, title), h("p", null, text),
      h("div", { class: "dialog-actions" }, h("button", { class: "btn primary", onclick: () => close(true) }, ok))));
  });
}

export function promptDialog({ title, value = "", ok = "Сохранить", placeholder = "" }) {
  return openOverlay((root, close) => {
    const input = h("input", { type: "text", value, placeholder, maxlength: "60", class: "field" });
    const submit = () => close(input.value.trim() || null);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
    root.append(h("div", { class: "dialog" },
      h("h2", null, title), input,
      h("div", { class: "dialog-actions" },
        h("button", { class: "btn text", onclick: () => close(null) }, "Отмена"),
        h("button", { class: "btn primary", onclick: submit }, ok))));
    setTimeout(() => { input.focus(); input.select(); }, 60);
  });
}

// items: [{label, hint, icon, danger, value}]
export function sheet({ title, items }) {
  return openOverlay((root, close) => {
    root.classList.add("sheet-wrap");
    root.append(h("div", { class: "sheet", role: "menu" },
      title ? h("h2", null, title) : null,
      items.map((it) => h("button", {
        class: "sheet-item" + (it.danger ? " danger" : ""), role: "menuitem",
        onclick: () => close(it.value),
      }, it.icon ? icon(it.icon) : null,
        h("span", { class: "sheet-label" }, h("b", null, it.label), it.hint ? h("small", null, it.hint) : null)))));
  });
}
