// Per-card "Smoke break?" toggle + the global counter shown on Today.
// Each checked card counts once (dedup via __smokeCounted); unchecking a
// previously-counted card decrements it.

import * as state from "./state.js";
import { svgCheck } from "./dom.js";

function getCountEl() { return document.getElementById("smokescount"); }

export function getSmokesCount() {
  const n = parseInt(getCountEl()?.textContent || "0", 10);
  return Number.isFinite(n) ? n : 0;
}
export function setSmokesCount(n) {
  const el = getCountEl();
  if (el) el.textContent = String(n);
}

// Re-derive __smokeCounted from each card's own `smoke` flag and refresh the
// on-screen counter from __smokes. Run once at boot so a freshly loaded or
// restored day starts from a consistent dedup map.
export function reconcileSmokeCounted() {
  const day = state.getDay();
  const counted = {};
  Object.keys(day).forEach((k) => {
    if (day[k] && typeof day[k].smoke === "boolean") counted[k] = day[k].smoke;
  });
  state.mutateMeta((d) => { d.__smokeCounted = counted; });
  const n = Number.isFinite(day.__smokes) ? day.__smokes : 0;
  setSmokesCount(n);
}

export function wireSmoke(container) {
  const cb = container.querySelector('input[type="checkbox"]');
  const box = container.querySelector('[data-role="box"]');
  const icon = container.querySelector('[data-role="icon"]');
  const label = container.querySelector('[data-role="label"]');
  if (!cb || !box || !icon || !label) return;

  if (!(icon instanceof SVGElement) && !icon.querySelector("svg")) {
    const svg = svgCheck();
    svg.setAttribute("aria-hidden", "true");
    svg.classList.add("pointer-events-none");
    icon.appendChild(svg);
  }
  icon.style.opacity = "";

  const card = container.closest("[data-checklist][data-key]");
  const cardKey = card?.dataset.key;

  function paint(checked) {
    label.classList.toggle("line-through", checked);
    icon.classList.toggle("opacity-0", !checked);
    icon.classList.toggle("opacity-100", checked);
    icon.setAttribute("aria-hidden", checked ? "false" : "true");
    box.classList.toggle("border-main", !checked);
    box.classList.toggle("border-accents", checked);
  }

  const initialChecked = !!state.getCard(cardKey)?.smoke;
  cb.checked = initialChecked;
  paint(initialChecked);

  cb.addEventListener("change", () => {
    paint(cb.checked);
    if (!cardKey) return;
    state.mutateMeta((day) => {
      const cardData = day[cardKey] || (day[cardKey] = { type: "checklist", items: [], smoke: false });
      cardData.smoke = cb.checked;
      const counted = day.__smokeCounted || (day.__smokeCounted = {});
      const wasCounted = !!counted[cardKey];
      if (cb.checked && !wasCounted) { setSmokesCount(getSmokesCount() + 1); counted[cardKey] = true; }
      else if (!cb.checked && wasCounted) { setSmokesCount(Math.max(0, getSmokesCount() - 1)); counted[cardKey] = false; }
      day.__smokes = getSmokesCount();
    });
  });
}

export function wireSmokePlusButton() {
  document.getElementById("smokescount-plus")?.addEventListener("click", () => {
    setSmokesCount(getSmokesCount() + 1);
    state.mutateMeta((day) => { day.__smokes = getSmokesCount(); });
  });
}
