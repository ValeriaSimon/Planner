// The day's data (source of truth) plus the day-scoped/global bullet buckets
// shown on the same page. No DOM code here — render.js reads this to draw the
// page; every write goes through mutate()/mutateBullets()/mutateMeta().

import {
  dayKey, bulletsKey, getPlannerDate, ymd,
  loadJSON, scheduleSave, saveNow as storageSaveNow, isSavePending,
} from "./storage.js";

export const TIME_KEYS = ["morning", "daytime", "evening"];
const FOLDER_HEADERS_KEY = "__folderHeaders";

let offset = 0;
let day = {};
const bulletCards = new Map(); // cardKey -> { key, items }
let renderCard = null; // (cardKey) => void, injected by day-view.js
let fullRefresh = null; // () => void, injected by day-view.js

export function setRenderer(fn) { renderCard = fn; }
export function setFullRefresh(fn) { fullRefresh = fn; }
export function triggerFullRefresh() { fullRefresh?.(); }

export function loadDay(dayOffset) {
  offset = dayOffset;
  day = loadJSON(dayKey(offset), {}) || {};
  bulletCards.clear();
  return day;
}

export function getDay() { return day; }
export function getOffset() { return offset; }
export function getCard(cardKey) { return day[cardKey]; }

export function registerChecklistCard(cardKey) {
  if (!day[cardKey]) day[cardKey] = { type: "checklist", items: [], smoke: false };
  return day[cardKey];
}

// --- UI state (__ui): folder collapse + manual whole-card collapse ---

export function getFolderCollapsed(cardKey, folderKey) {
  const ui = day.__ui || {};
  return !!(ui.folders && ui.folders[cardKey] && ui.folders[cardKey][String(folderKey)]);
}
export function setFolderCollapsed(cardKey, folderKey, collapsed) {
  mutateMeta(d => {
    d.__ui = d.__ui || {};
    d.__ui.folders = d.__ui.folders || {};
    d.__ui.folders[cardKey] = d.__ui.folders[cardKey] || {};
    d.__ui.folders[cardKey][String(folderKey)] = !!collapsed;
  });
}
export function isManualCollapsed(cardKey) {
  return !!(day.__ui && day.__ui.cards && day.__ui.cards.manual && day.__ui.cards.manual[cardKey]);
}
export function setManualCollapsed(cardKey, val) {
  mutateMeta(d => {
    d.__ui = d.__ui || {};
    d.__ui.cards = d.__ui.cards || {};
    d.__ui.cards.manual = d.__ui.cards.manual || {};
    if (val) d.__ui.cards.manual[cardKey] = true; else delete d.__ui.cards.manual[cardKey];
  });
}

// Back-compat migration of legacy top-level keys -> __ui (same shape as the
// pre-rewrite app, so old localStorage/Firestore day docs load unchanged).
export function migrateUIState() {
  let changed = false;
  const ui = day.__ui || {};
  ui.folders = ui.folders || {};
  ui.cards = ui.cards || {};
  ui.cards.manual = ui.cards.manual || {};
  ui.cards.auto = ui.cards.auto || {};

  if (day.__foldersCollapsed) {
    for (const [card, map] of Object.entries(day.__foldersCollapsed)) {
      ui.folders[card] = Object.assign({}, ui.folders[card] || {}, map);
    }
    delete day.__foldersCollapsed;
    changed = true;
  }
  if (day.__manualCollapsed) {
    Object.assign(ui.cards.manual, day.__manualCollapsed);
    delete day.__manualCollapsed;
    changed = true;
  }
  if (day.__collapsed) {
    Object.assign(ui.cards.auto, day.__collapsed);
    delete day.__collapsed;
    changed = true;
  }

  if (changed || !day.__ui) {
    day.__ui = ui;
    scheduleSave(dayKey(offset), day);
  }
}

export function getCardFolders(cardKey) {
  return (day[FOLDER_HEADERS_KEY] && day[FOLDER_HEADERS_KEY][cardKey]) || [];
}
function ensureCardFolder(cardKey, folderKey) {
  const headers = day[FOLDER_HEADERS_KEY] || (day[FOLDER_HEADERS_KEY] = {});
  const list = headers[cardKey] || (headers[cardKey] = []);
  if (!list.includes(folderKey)) list.push(folderKey);
}
function removeCardFolder(cardKey, folderKey) {
  const headers = day[FOLDER_HEADERS_KEY];
  if (headers?.[cardKey]) headers[cardKey] = headers[cardKey].filter(f => f !== folderKey);
}

// Mutate one checklist card. fn(card, helpers) where helpers let the caller
// register/remove a persisted (possibly-empty) folder header for this card.
export function mutate(cardKey, fn) {
  const card = day[cardKey] || registerChecklistCard(cardKey);
  fn(card, {
    ensureFolder: (f) => ensureCardFolder(cardKey, f),
    removeFolder: (f) => removeCardFolder(cardKey, f),
  });
  day.__lastModified = Date.now();
  renderCard?.(cardKey);
  scheduleSave(dayKey(offset), day);
}

// Mutate day-level metadata (e.g. __ui, __smokes, __smokeCounted, __clearedDone)
// that isn't owned by one card and doesn't need a list re-render.
export function mutateMeta(fn) {
  fn(day);
  day.__lastModified = Date.now();
  scheduleSave(dayKey(offset), day);
}

// Replace the whole day object: End Day promotion, Restore, or accepting a
// newer remote snapshot. Caller is responsible for re-rendering after.
export function replaceDay(nextDay) {
  day = nextDay || {};
}

// --- Bullets (Food: day-scoped: Notes: global) ---

export function registerBulletCard(cardKey) {
  if (bulletCards.has(cardKey)) return bulletCards.get(cardKey);
  const ds = ymd(getPlannerDate(offset));
  const key = bulletsKey(cardKey, ds);
  const items = loadJSON(key, []);
  const entry = { key, items: Array.isArray(items) ? items : [] };
  bulletCards.set(cardKey, entry);
  return entry;
}

export function getBulletItems(cardKey) {
  return (bulletCards.get(cardKey) || registerBulletCard(cardKey)).items;
}

export function mutateBullets(cardKey, fn) {
  const entry = bulletCards.get(cardKey) || registerBulletCard(cardKey);
  fn(entry.items);
  renderCard?.(cardKey);
  scheduleSave(entry.key, entry.items);
}

// Re-read every registered bullet card from storage/cache (used after
// accepting a remote snapshot, before a full re-render).
export function reloadBulletCards() {
  bulletCards.forEach((entry) => {
    const items = loadJSON(entry.key, []);
    entry.items = Array.isArray(items) ? items : [];
  });
}

// --- Immediate flush (End Day, Download, page unload) ---

export function saveNow() {
  storageSaveNow(dayKey(offset), day);
  bulletCards.forEach(entry => storageSaveNow(entry.key, entry.items));
}

export function isSaveDayPending() {
  if (isSavePending(dayKey(offset))) return true;
  for (const entry of bulletCards.values()) {
    if (isSavePending(entry.key)) return true;
  }
  return false;
}
