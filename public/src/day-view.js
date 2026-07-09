// Wires every card for a given day offset: checklists/bullets, templates,
// countdown, smoke, folder/card collapse UI, current-time-block highlight,
// and past-time-card auto-collapse. today.js/tomorrow.js call initDayView()
// and then wire whatever's specific to their own page (End Day, drawer, ...).

import { getPlannerDate } from "./storage.js";
import * as state from "./state.js";
import { wireList } from "./list.js";
import { renderCard, updateClearCheckedVisibility } from "./render.js";
import { wireTemplates } from "./templates.js";
import { wireCountdown } from "./countdown.js";
import { wireSmoke, wireSmokePlusButton, reconcileSmokeCounted } from "./smoke.js";
import { syncFromToday } from "./carryover.js";
import { downloadDayViaHref } from "./backup.js";

const DEFAULT_END = { morning: 14, daytime: 18, evening: 22 };

function slugify(s) { return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }
function ensureCardKey(card) {
  let k = card.dataset.key;
  if (!k) {
    const title = card.querySelector("h3,[data-title]")?.textContent?.trim() || "card";
    const idx = Array.from(document.querySelectorAll("[data-checklist]")).indexOf(card);
    k = `card-${idx}-${slugify(title)}`;
    card.dataset.key = k;
  }
  return k;
}

function getCardBoundary(key, which) {
  const card = document.querySelector(`[data-checklist][data-key="${key}"]`);
  if (!card) return null;
  const v = Number(card.dataset[which]);
  return Number.isFinite(v) ? v : null;
}
function cardEndHour(key) {
  const v = getCardBoundary(key, "end");
  return Number.isFinite(v) ? v : DEFAULT_END[key] ?? 24;
}

function applyCollapsedUI(cardKey, collapsed) {
  const card =
    document.querySelector(`[data-checklist][data-key="${cardKey}"]`) ||
    document.querySelector(`[data-bullets][data-key="${cardKey}"]`);
  if (!card) return;

  if (collapsed) card.setAttribute("data-collapsed", "1");
  else card.removeAttribute("data-collapsed");

  const list = card.querySelector("[data-checklist-list],[data-bullets-list]");
  const form = card.querySelector("[data-checklist-form],[data-bullets-form]");
  if (list) list.classList.toggle("hidden", collapsed);
  if (form) form.classList.toggle("hidden", collapsed);

  const icon = card.querySelector("i.collapseCardCaret");
  if (icon) {
    icon.classList.toggle("fa-caret-up", !collapsed);
    icon.classList.toggle("fa-caret-down", collapsed);
  }
  updateClearCheckedVisibility(card);
}

function wireCarets() {
  document.querySelectorAll("[data-checklist],[data-bullets]").forEach((card) => {
    const key = ensureCardKey(card);
    if (!state.TIME_KEYS.includes(key)) {
      applyCollapsedUI(key, state.isManualCollapsed(key));
    }
  });

  document.addEventListener("click", (e) => {
    const icon = e.target.closest("i.collapseCardCaret");
    if (!icon) return;
    const card = icon.closest("[data-checklist],[data-bullets]");
    if (!card) return;
    const key = ensureCardKey(card);
    const next = !card.hasAttribute("data-collapsed");
    state.setManualCollapsed(key, next);
    applyCollapsedUI(key, next);
  });
}

function highlightCurrentBlock(offset) {
  if (offset !== 0) return;
  const hr = new Date().getHours();
  const cards = document.querySelectorAll("[data-checklist][data-start][data-end]");
  cards.forEach((card) => card.classList.remove("scale-105", "z-10", "shadow-xl"));
  const active = [...cards].find((card) => {
    const start = Number(card.dataset.start);
    const end = Number(card.dataset.end);
    return hr >= start && hr < end;
  });
  if (active) active.classList.add("scale-105", "z-10", "shadow-xl");
}

function collapsePastTimeCards(offset) {
  if (offset !== 0) return;
  state.TIME_KEYS.forEach((key) => {
    const shouldCollapse = new Date().getHours() >= cardEndHour(key);
    applyCollapsedUI(key, shouldCollapse || state.isManualCollapsed(key));
  });
}

const ord = (n) => { const v = n % 100; if (v >= 11 && v <= 13) return "th"; switch (n % 10) { case 1: return "st"; case 2: return "nd"; case 3: return "rd"; default: return "th"; } };

function updateGreeting() {
  const h1 = document.getElementById("greeting");
  if (!h1) return;
  const hr = new Date().getHours();
  const MORNING_START = 6;
  const MORNING_END = getCardBoundary("morning", "end") ?? 14;
  const DAYTIME_END = getCardBoundary("daytime", "end") ?? 18;
  let text;
  if (hr >= MORNING_START && hr < MORNING_END) text = "Good morning!";
  else if (hr >= MORNING_END && hr < DAYTIME_END) text = "Hi!";
  else text = "Good evening!";
  h1.textContent = text;
}

function setHeaderAndTitle(offset) {
  const d = getPlannerDate(offset);

  const tParts = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "2-digit", month: "short" }).formatToParts(d);
  const w = tParts.find(p => p.type === "weekday")?.value || "";
  const dd = tParts.find(p => p.type === "day")?.value || "";
  const mon = tParts.find(p => p.type === "month")?.value || "";
  document.title = `${w} ${dd}-${mon}`;

  const hParts = new Intl.DateTimeFormat("en-US", { weekday: "long", day: "numeric", month: "long" }).formatToParts(d);
  const W = hParts.find(p => p.type === "weekday")?.value || "";
  const Dn = Number(hParts.find(p => p.type === "day")?.value || 0);
  const M = hParts.find(p => p.type === "month")?.value || "";
  const todayEl = document.getElementById("today");
  if (todayEl) todayEl.textContent = `${W}, ${Dn}${ord(Dn)} of ${M}`;
}

export function initDayView(offset) {
  state.loadDay(offset);

  const cardRoots = new Map();
  document.querySelectorAll("[data-checklist],[data-bullets]").forEach((root) => {
    const key = ensureCardKey(root);
    cardRoots.set(key, root);
  });
  state.setRenderer((cardKey) => renderCard(cardRoots.get(cardKey)));
  state.setFullRefresh(() => cardRoots.forEach((root) => renderCard(root)));

  setHeaderAndTitle(offset);
  updateGreeting();
  state.migrateUIState();

  if (offset === 1) syncFromToday();

  cardRoots.forEach((root) => {
    const checkable = root.matches("[data-checklist]");
    wireList(root, { checkable });
    if (checkable) {
      wireTemplates(root);
      const smoke = root.querySelector("[data-smoke]");
      if (smoke) wireSmoke(smoke);
    }
  });
  reconcileSmokeCounted();

  document.querySelectorAll("[data-countdown]").forEach(wireCountdown);

  wireCarets();

  // Initial paint of every card's item list from the just-loaded state.
  cardRoots.forEach((root) => renderCard(root));

  collapsePastTimeCards(offset);
  if (offset === 0) setInterval(() => collapsePastTimeCards(offset), 5 * 60 * 1000);

  highlightCurrentBlock(offset);
  if (offset === 0) setInterval(() => highlightCurrentBlock(offset), 5 * 60 * 1000);

  wireSmokePlusButton();

  document.addEventListener("click", (e) => {
    const btn = e.target.closest('[data-action="download"]');
    if (!btn) return;
    e.preventDefault();
    state.saveNow();
    downloadDayViaHref(offset);
  });
}
