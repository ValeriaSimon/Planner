// Global countdown card: form mode (pick datetime + label) vs. live-ticking
// view mode. Saved under one global key, shared across Today/Tomorrow.

import { GLOBAL_COUNTDOWN_KEY, loadJSON, saveJSON, pad2 } from "./storage.js";

export function wireCountdown(root) {
  const form = root.querySelector("[data-countdown-form]");
  const view = root.querySelector("[data-countdown-view]");
  const titleEl = root.querySelector("[data-countdown-title]");
  const display = root.querySelector("[data-countdown-display]");
  display?.setAttribute("aria-live", "polite");
  const labelIn = root.querySelector("[data-countdown-label]");
  const whenIn = root.querySelector("[data-countdown-when]");
  const startBtn = root.querySelector("[data-countdown-start]");
  const resetBtn = root.querySelector("[data-countdown-reset]");

  if (!display || !form || !view) return;

  root.querySelectorAll("[data-open-picker]").forEach(btn => {
    btn.addEventListener("click", () => {
      if (whenIn && typeof whenIn.showPicker === "function") whenIn.showPicker();
      else whenIn?.focus();
    });
  });

  function readSaved() { return loadJSON(GLOBAL_COUNTDOWN_KEY, null); }
  function writeSaved(v) { saveJSON(GLOBAL_COUNTDOWN_KEY, v); }

  function showForm() { form.classList.remove("hidden"); view.classList.add("hidden"); root.classList.add("is-form"); root.classList.remove("is-view"); }
  function showView() { form.classList.add("hidden"); view.classList.remove("hidden"); root.classList.add("is-view"); root.classList.remove("is-form"); }

  function formatDuration(ms) {
    let s = Math.max(0, Math.floor(ms / 1000));
    const d = Math.floor(s / 86400); s -= d * 86400;
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60); s -= m * 60;
    return (d > 0 ? `${d} D ` : "") + `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
  }
  function toLocalDatetimeValue(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  function update() {
    const saved = readSaved();
    if (!saved) { showForm(); return; }
    const label = (saved.label || "").trim();
    if (label) { titleEl.textContent = label; titleEl.classList.remove("hidden"); }
    else { titleEl.textContent = ""; titleEl.classList.add("hidden"); }
    const ms = saved.target - Date.now();
    display.textContent = ms <= 0 ? "Done!" : formatDuration(ms);
    showView();
  }

  function startTick() {
    if (root.__cdTimer) clearInterval(root.__cdTimer);
    update();
    root.__cdTimer = setInterval(update, 1000);
  }

  const saved = readSaved();
  if (saved) {
    if (labelIn) labelIn.value = saved.label || "";
    if (whenIn) whenIn.value = toLocalDatetimeValue(new Date(saved.target));
    startTick();
  } else {
    showForm();
    if (labelIn) labelIn.value = "";
    if (whenIn) whenIn.value = "";
  }

  startBtn?.addEventListener("click", () => {
    const label = (labelIn?.value || "").trim();
    const when = whenIn?.value;
    if (!when) { alert("Pick a target date & time"); return; }
    const target = new Date(when).getTime();
    writeSaved({ target, label });
    startTick();
  });

  resetBtn?.addEventListener("click", () => {
    localStorage.removeItem(GLOBAL_COUNTDOWN_KEY);
    if (root.__cdTimer) clearInterval(root.__cdTimer);
    if (labelIn) labelIn.value = "";
    if (whenIn) whenIn.value = "";
    titleEl.textContent = "";
    showForm();
  });
}
