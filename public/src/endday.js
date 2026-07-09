// End Day: archives today, carries incomplete non-time-card items into
// Tomorrow (a simpler one-shot dedup than carryover.js's live re-sync, since
// the day is now final), downloads/archives both days, advances the base
// date, and redirects to a refreshed Today. Restore imports a backup file.

import { dayKey, getBaseDate, setBaseDate, getPlannerDate, loadLocal, saveJSON } from "./storage.js";
import * as state from "./state.js";
import { norm } from "./parsing.js";
import { getArchiveRootHandle, archiveDay, downloadDayViaHref, setArchiveRootHandle, restoreFromFile } from "./backup.js";
import { pushBaseDateToRemote } from "./firebase-sync.js";

const NAV_DELAY_MS = 350;
let endingDay = false;

export function isEndingDay() { return endingDay; }

function carryKeyOf(item) {
  return `${norm(item?.text || "")}@${String(item?.folder || "")}`;
}

export function ensureEmptyDay(offset = 1) {
  const key = dayKey(offset);
  if (localStorage.getItem(key)) return;
  const empty = {};
  document.querySelectorAll("[data-checklist][data-key]").forEach((card) => {
    empty[card.dataset.key] = { type: "checklist", items: [], smoke: false };
  });
  saveJSON(key, empty);
}

async function onEndDay() {
  if (endingDay) return;
  endingDay = true;

  state.saveNow(); // flush any pending edits before archiving

  const todayKey = dayKey(0);
  const tomorrowKey = dayKey(1);

  ensureEmptyDay(1);
  const todayData = loadLocal(todayKey, {}) || {};
  const tomorrowData = loadLocal(tomorrowKey, {}) || {};
  const carriedMeta = {};

  Object.keys(todayData || {}).forEach((key) => {
    if (state.TIME_KEYS.includes(key)) return;
    const entry = todayData[key];
    if (entry?.type === "checklist" && Array.isArray(entry.items)) {
      const carry = entry.items.filter((it) => !it.done && norm(it.text));
      if (!tomorrowData[key]) tomorrowData[key] = { type: "checklist", items: [], smoke: false };
      const existing = tomorrowData[key].items || [];
      const existingSet = new Set(existing.map(carryKeyOf));
      const newCarry = carry.filter((it) => !existingSet.has(carryKeyOf(it)));
      tomorrowData[key].items = [...newCarry, ...existing];
      if (newCarry.length) carriedMeta[key] = newCarry.map(carryKeyOf);
    }
  });

  tomorrowData.__carried = carriedMeta;
  saveJSON(tomorrowKey, tomorrowData);

  const archiveRoot = await getArchiveRootHandle();
  if (archiveRoot) {
    await archiveDay(archiveRoot, 0);
    await archiveDay(archiveRoot, 1);
  } else {
    // Sequential downloads; give the browser time to dispatch each.
    downloadDayViaHref(0);
    await new Promise(r => setTimeout(r, 200));
    downloadDayViaHref(1);
    await new Promise(r => setTimeout(r, 250));
  }

  setBaseDate(getPlannerDate(1));
  await pushBaseDateToRemote();
  setTimeout(() => { location.href = "./today.html"; }, NAV_DELAY_MS);
}

export function wireEndDay() {
  document.getElementById("endday")?.addEventListener("click", (e) => {
    e.preventDefault();
    onEndDay();
  });
  document.getElementById("set-archive-folder")?.addEventListener("click", (e) => {
    e.preventDefault();
    setArchiveRootHandle();
  });
}

export function wireRestore() {
  document.getElementById("restore")?.addEventListener("click", async (e) => {
    e.preventDefault();
    try {
      const { ds, isCurrentPage } = await restoreFromFile();
      if (isCurrentPage) location.reload();
      else alert(`Restored ${ds}. Switch to that day to view it.`);
    } catch {
      alert("Restore failed. Pick a valid planner JSON.");
    }
  });
}
