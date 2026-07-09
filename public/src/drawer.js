// Today-only deferred/recurring item queue: stash an item now, land it on a
// target date. Lands via state.mutate()/mutateBullets() directly rather than
// reaching into card internals.

import { DRAWER_KEY, loadJSON, saveJSON, getPlannerDate, ymd } from "./storage.js";
import * as state from "./state.js";
import { parseItemAndTags, normalizeFolderPath, displayFolder, capFirst } from "./parsing.js";
import { el } from "./dom.js";

function readDrawer() { return loadJSON(DRAWER_KEY, []); }
function writeDrawer(items) { saveJSON(DRAWER_KEY, items); }
function drawerId() { return `drw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`; }

// Reserved tags (#am/#mid/#pm) plus every non-time card's own key/title become
// aliases for its data-key. Time cards are only reachable via am/mid/pm, since
// a drawer item has no "current card" context to infer a folder tag from.
function buildCardAliasMap() {
  const map = new Map([["am", "morning"], ["mid", "daytime"], ["pm", "evening"]]);
  document.querySelectorAll("[data-checklist][data-key],[data-bullets][data-key]").forEach(card => {
    const key = card.dataset.key;
    if (!key || state.TIME_KEYS.includes(key)) return;
    map.set(normalizeFolderPath(key), key);
    const titleText = (card.querySelector("h3")?.firstChild?.textContent || "").trim();
    const slug = normalizeFolderPath(titleText);
    if (slug) map.set(slug, key);
  });
  return map;
}

// The first tag that resolves via the alias map becomes the destination card;
// if that card supports folders, the next tag (if any) is the sub-folder.
function resolveDrawerTarget(raw, aliasMap) {
  const { text, folders } = parseItemAndTags(raw, { isTimeCard: false });
  let cardKey = null, folder = "";
  for (const tag of folders) {
    if (!cardKey) {
      const resolved = aliasMap.get(tag);
      if (resolved) { cardKey = resolved; continue; }
    } else if (!state.TIME_KEYS.includes(cardKey) && !folder) {
      folder = tag;
    }
  }
  return { text: capFirst(text), cardKey, folder };
}

function advanceDateOnce(ds, repeat) {
  const d = new Date(ds + "T00:00:00");
  if (repeat === "daily") d.setDate(d.getDate() + 1);
  else if (repeat === "weekly") d.setDate(d.getDate() + 7);
  else if (repeat === "monthly") d.setMonth(d.getMonth() + 1);
  else if (repeat === "yearly") d.setFullYear(d.getFullYear() + 1);
  return ymd(d);
}
// Loop until strictly past the landing date: a recurring item lands once per
// catch-up and jumps straight to its next future occurrence.
function fastForwardTargetDate(targetDate, repeat, ds) {
  let next = targetDate, guard = 0;
  while (next <= ds && guard++ < 10000) next = advanceDateOnce(next, repeat);
  return next;
}

// Returns false if neither a checklist nor bullets card with this key exists
// (e.g. a stale cardKey from a past HTML edit) — the item is left in the
// drawer to retry on the next load.
function landItem(item) {
  const isBullets = !!document.querySelector(`[data-bullets][data-key="${item.cardKey}"]`);
  const isChecklist = !isBullets && !!document.querySelector(`[data-checklist][data-key="${item.cardKey}"]`);
  if (isBullets) {
    state.mutateBullets(item.cardKey, (items) => { items.push({ text: item.text, folder: item.folder || "" }); });
    return true;
  }
  if (isChecklist) {
    state.mutate(item.cardKey, (card, { ensureFolder }) => {
      card.items = card.items || [];
      card.items.push({ text: item.text, done: false, folder: item.folder || "" });
      if (item.folder) ensureFolder(item.folder);
    });
    return true;
  }
  return false;
}

// On-or-before catch-up: an item lands the first time today's date reaches or
// passes its target date. Non-recurring items are dropped once landed;
// recurring items stay, fast-forwarded past today.
export function processDrawerForDate(ds) {
  const items = readDrawer();
  if (!items.length) return;
  const remaining = [];
  let changed = false;
  items.forEach(item => {
    const due = item.targetDate <= ds && item.lastLandedDate !== ds;
    if (!due) { remaining.push(item); return; }
    if (!landItem(item)) { remaining.push(item); return; }
    changed = true;
    if (item.repeat && item.repeat !== "none") {
      item.lastLandedDate = ds;
      item.targetDate = fastForwardTargetDate(item.targetDate, item.repeat, ds);
      remaining.push(item);
    }
  });
  if (changed) writeDrawer(remaining);
}

export function refreshDrawerBadge() {
  const n = readDrawer().length;
  document.querySelectorAll("[data-drawer-badge]").forEach(b => { b.textContent = String(n); });
}

// Live-sync the drawer badge/list when the partner's device changes it remotely.
export function handleDrawerRemoteChange() {
  refreshDrawerBadge();
  const overlay = document.querySelector("[data-drawer-overlay]");
  if (overlay && !overlay.classList.contains("hidden")) {
    renderDrawerList(overlay.querySelector("[data-drawer-list]"));
  }
}

function renderDrawerList(list) {
  if (!list) return;
  list.innerHTML = "";
  const items = readDrawer().slice().sort((a, b) => a.targetDate < b.targetDate ? -1 : a.targetDate > b.targetDate ? 1 : 0);
  items.forEach(item => {
    const li = el("li", "flex justify-between items-center gap-3");
    const left = el("div", "flex flex-col");
    const label = el("span", "text-neutral font-sec", item.text);
    const meta = el("span", "text-neutral/60 font-sec text-sm",
      `${item.targetDate} · ${displayFolder(item.cardKey)}${item.folder ? ` / ${displayFolder(item.folder)}` : ""}${item.repeat && item.repeat !== "none" ? ` · ${capFirst(item.repeat)}` : ""}`);
    left.append(label, meta);
    const del = el("button", "text-red-500 hover:text-red-900");
    del.type = "button";
    del.appendChild(el("i", "fa-solid fa-trash"));
    del.addEventListener("click", () => {
      writeDrawer(readDrawer().filter(it => it.id !== item.id));
      renderDrawerList(list);
      refreshDrawerBadge();
    });
    li.append(left, del);
    list.appendChild(li);
  });
}

export function wireDrawerModal() {
  const overlay = document.querySelector("[data-drawer-overlay]");
  if (!overlay) return;

  const aliasMap = buildCardAliasMap();
  const form = overlay.querySelector("[data-drawer-form]");
  const textIn = overlay.querySelector("[data-drawer-text]");
  const dateIn = overlay.querySelector("[data-drawer-date]");
  const errorEl = overlay.querySelector("[data-drawer-error]");
  const repeatToggle = overlay.querySelector("[data-drawer-repeat-toggle]");
  const repeatSelect = overlay.querySelector("[data-drawer-repeat-select]");
  const list = overlay.querySelector("[data-drawer-list]");

  function openOverlay() { renderDrawerList(list); overlay.classList.remove("hidden"); textIn?.focus(); }
  function closeOverlay() { overlay.classList.add("hidden"); }

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay || e.target.closest("[data-drawer-close]")) closeOverlay();
  });

  repeatToggle?.addEventListener("change", () => {
    repeatSelect?.classList.toggle("hidden", !repeatToggle.checked);
  });

  overlay.querySelectorAll("[data-open-picker]").forEach(btn => {
    btn.addEventListener("click", () => {
      if (dateIn && typeof dateIn.showPicker === "function") dateIn.showPicker();
      else dateIn?.focus();
    });
  });

  form?.addEventListener("submit", (e) => {
    e.preventDefault();
    const raw = (textIn?.value || "").trim();
    const targetDate = dateIn?.value || "";
    const { text, cardKey, folder } = resolveDrawerTarget(raw, aliasMap);

    if (!targetDate || !text || !cardKey) {
      if (errorEl) {
        errorEl.textContent = !targetDate
          ? "Pick a target date."
          : (!text ? "Type something to stash." : "Add a destination tag (e.g. #am, #shopping).");
        errorEl.classList.remove("hidden");
      }
      return;
    }
    errorEl?.classList.add("hidden");

    const item = {
      id: drawerId(), rawText: raw, text, cardKey, folder,
      targetDate, targetTime: null,
      repeat: repeatToggle?.checked ? (repeatSelect?.value || "daily") : "none",
      lastLandedDate: null,
      createdAt: new Date().toISOString(),
    };
    writeDrawer([...readDrawer(), item]);

    form.reset();
    repeatSelect?.classList.add("hidden");
    processDrawerForDate(ymd(getPlannerDate(state.getOffset())));
    renderDrawerList(list);
    refreshDrawerBadge();
  });

  document.querySelectorAll("[data-drawer-open-list]").forEach(trigger => {
    trigger.addEventListener("click", openOverlay);
  });

  refreshDrawerBadge();
}
