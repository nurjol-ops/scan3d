import { h, hasOverlay, closeTopOverlay, toast } from "./util.js";
import { onBackButton, exitApp } from "./native.js";
import * as jobs from "./jobs.js";

const screens = {};
const loaders = {
  library: () => import("./screens/library.js"),
  capture: () => import("./screens/capture.js"),
  review: () => import("./screens/review.js"),
  progress: () => import("./screens/progress.js"),
  model: () => import("./screens/model.js"),
  settings: () => import("./screens/settings.js"),
};

const appEl = document.getElementById("app");
const stack = []; // { name, params, el, cleanup, onBack }

async function mountScreen(name, params) {
  const mod = screens[name] || (screens[name] = await loaders[name]());
  const el = h("main", { class: "screen" });
  const entry = { name, params, el, cleanup: null, onBack: null };
  const ret = mod.mount(el, params || {}, nav);
  if (typeof ret === "function") entry.cleanup = ret;
  else if (ret) { entry.cleanup = ret.cleanup || null; entry.onBack = ret.onBack || null; }
  return entry;
}

function teardown(entry) {
  try { entry.cleanup && entry.cleanup(); } catch (e) { console.error(e); }
  entry.el.remove();
}

export const nav = {
  async push(name, params) {
    const entry = await mountScreen(name, params);
    const prev = stack[stack.length - 1];
    if (prev) prev.el.classList.add("under");
    stack.push(entry);
    appEl.append(entry.el);
  },
  async replace(name, params) {
    const old = stack.pop();
    const entry = await mountScreen(name, params);
    stack.push(entry);
    appEl.append(entry.el);
    if (old) teardown(old);
  },
  back() {
    if (stack.length <= 1) return false;
    teardown(stack.pop());
    const top = stack[stack.length - 1];
    top.el.classList.remove("under");
    return true;
  },
};

function handleBack() {
  if (hasOverlay()) { closeTopOverlay(); return; }
  const top = stack[stack.length - 1];
  if (top && top.onBack && top.onBack()) return;
  if (!nav.back()) exitApp();
}

onBackButton(handleBack);
window.addEventListener("popstate", handleBack);

window.addEventListener("unhandledrejection", (e) => {
  console.error(e.reason);
});

nav.push("library").then(() => jobs.resumeAll());
