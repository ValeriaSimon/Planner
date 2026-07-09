// Runs once when tomorrow.html loads: pulls incomplete non-time-card items
// from Today into Tomorrow. Dedup is via a __carried key set (per card, a list
// of "normalizedText@folder" composites) so re-visiting Tomorrow doesn't
// duplicate an already-carried item, and finishing/deleting it back on Today
// removes it from Tomorrow on the next sync. If the user has since edited a
// carried item on Tomorrow (retagged its folder, etc.), that edit is respected
// instead of being duplicated back in.

import { dayKey, loadLocal } from "./storage.js";
import * as state from "./state.js";
import { norm } from "./parsing.js";

const FOLDER_HEADERS_KEY = "__folderHeaders";

function carryKey(item) {
  return `${norm(item?.text || "")}@${String(item?.folder || "")}`;
}
function itemsEqual(a = [], b = []) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ax = a[i] || {}, bx = b[i] || {};
    if ((ax.text || "").trim() !== (bx.text || "").trim()) return false;
    if (!!ax.done !== !!bx.done) return false;
    if (String(ax.folder || "") !== String(bx.folder || "")) return false;
  }
  return true;
}
function carriedMetaEqual(a = {}, b = {}) {
  const ak = Object.keys(a), bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!(k in b)) return false;
    const av = a[k] || [], bv = b[k] || [];
    if (av.length !== bv.length) return false;
    for (let i = 0; i < av.length; i++) if (av[i] !== bv[i]) return false;
  }
  return true;
}

export function syncFromToday() {
  const todayData = loadLocal(dayKey(0), {}) || {};
  const tomorrowData = state.getDay(); // live reference; mutated in place below
  const prevCarriedMeta = tomorrowData.__carried || {};
  const newCarriedMeta = {};
  let changed = false;

  const todayHeaders = todayData[FOLDER_HEADERS_KEY] || {};
  const tomHeaders = tomorrowData[FOLDER_HEADERS_KEY] || {};
  let headersChanged = false;

  const keys = Object.keys(todayData).filter((k) => !state.TIME_KEYS.includes(k));

  keys.forEach((key) => {
    const entry = todayData[key];
    if (!entry || entry.type !== "checklist" || !Array.isArray(entry.items)) return;

    const th = todayHeaders[key] || [];
    if (th.length) {
      const existingHeaders = tomHeaders[key] || [];
      const merged = Array.from(new Set([...existingHeaders, ...th]));
      if (existingHeaders.length !== merged.length || existingHeaders.some((v, i) => v !== merged[i])) {
        tomHeaders[key] = merged;
        headersChanged = true;
      }
    }

    const carryMap = new Map();
    entry.items.forEach((it) => {
      if (!it.done) {
        const k = carryKey(it);
        if (k !== "@") carryMap.set(k, { text: it.text, folder: String(it.folder || "") });
      }
    });
    newCarriedMeta[key] = Array.from(carryMap.keys());

    const existing = (tomorrowData[key] && Array.isArray(tomorrowData[key].items)) ? tomorrowData[key].items : [];
    const prevArr = prevCarriedMeta[key] || [];
    const prevSet = new Set(prevArr);

    // Bootstrap fallback: no meta yet, but Tomorrow already has items matching
    // Today's (same text@folder) — treat them as previously carried so they
    // can be dropped once done, instead of being duplicated forever.
    if (prevSet.size === 0 && existing.length) {
      const todayAll = new Set(entry.items.map(carryKey));
      existing.map(carryKey).forEach(k => { if (todayAll.has(k)) prevSet.add(k); });
    }

    const prevTextSet = new Set(Array.from(prevSet).map(k => k.split("@")[0]));
    const native = existing.filter(it => !prevSet.has(carryKey(it)));
    const nativeTextSet = new Set(native.map(it => norm(it.text)));

    const newCarriedItems = [];
    carryMap.forEach(({ text, folder }, composite) => {
      const n = norm(text);
      const editedPrevCarriedPresent = prevTextSet.has(n) && nativeTextSet.has(n);
      const exactNative = native.some(it => carryKey(it) === composite);
      if (!editedPrevCarriedPresent && !exactNative) {
        newCarriedItems.push({ text, done: false, folder });
      }
    });

    const nextItems = [...newCarriedItems, ...native];
    if (!itemsEqual(existing, nextItems)) {
      changed = true;
      if (!tomorrowData[key]) tomorrowData[key] = { type: "checklist", items: [], smoke: false };
      tomorrowData[key].items = nextItems;
    }
  });

  if (headersChanged) tomorrowData[FOLDER_HEADERS_KEY] = tomHeaders;

  if (changed || headersChanged || !carriedMetaEqual(tomorrowData.__carried || {}, newCarriedMeta)) {
    tomorrowData.__carried = newCarriedMeta;
    tomorrowData.__lastModified = Date.now();
    state.saveNow();
  }
}
