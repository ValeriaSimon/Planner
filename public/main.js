/* main.js — consolidated */

/* -------- Day offset from HTML -------- */
function getPageOffset() {
  const raw = Number(document.body?.dataset?.dayOffset ?? 0);
  return Number.isFinite(raw) ? raw : 0;
}
const DAY_OFFSET = getPageOffset();
const NAV_DELAY_MS = 350;
let ENDING_DAY = false;


/* -------- Date helpers -------- */
const pad2 = (n) => String(n).padStart(2, "0");
function ymd(d) {
  const y = d.getFullYear();
  const m = pad2(d.getMonth() + 1);
  const day = pad2(d.getDate());
  return `${y}-${m}-${day}`;
}

const ord = (n) => { const v = n % 100; if (v >= 11 && v <= 13) return "th"; switch (n % 10) { case 1: return "st"; case 2: return "nd"; case 3: return "rd"; default: return "th"; } };

/* -------- Storage model (matches your schema) -------- */
// Base day anchor. End day bumps this by one.
function getBaseDate() {
  const s = localStorage.getItem("planner:baseDate");
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}
function setBaseDate(d) {
  const dd = new Date(d);
  dd.setHours(0, 0, 0, 0);
  localStorage.setItem("planner:baseDate", dd.toISOString());
}
function getPlannerDate(offset = 0) {
  let base = getBaseDate();
  if (!base) {
    base = new Date();
    setBaseDate(base);
  }
  const d = new Date(base);
  d.setDate(d.getDate() + offset);
  return d;
}
function dayKey(offset = DAY_OFFSET) {
  return `planner:${ymd(getPlannerDate(offset))}`;
}
function dayKeyFromDateStr(ds) {
  return `planner:${ds}`;
}
const GLOBAL_NOTES_KEY = "planner:notes";
const GLOBAL_COUNTDOWN_KEY = "planner:countdown";
function bulletsKey(key, ds = null) {
  if (!key || key === "notes") return GLOBAL_NOTES_KEY;
  const base = ds ? dayKeyFromDateStr(ds) : dayKey();
  return `${base}:bullets:${key}`;
}


/* -------- JSON helpers -------- */
const REMOTE_CACHE = new Map();
function loadJSON(key, fallback) {
  return REMOTE_CACHE.has(key) ? REMOTE_CACHE.get(key) : fallback;
}
async function saveJSON(key, value) {
  REMOTE_CACHE.set(key, value);
  const FB = window.firebaseServices;
  const u = FB?.auth?.currentUser;
  if (!FB || !u) return;

  const m = String(key).match(/^planner:(\d{4}-\d{2}-\d{2})(?::bullets:(.+))?$/);
  if (key === "planner:notes") {
    await FB.setDoc(FB.doc(FB.db, "users", u.uid, "meta", "notes"), { items: value || [] });
  } else if (key === "planner:countdown") {
    await FB.setDoc(FB.doc(FB.db, "users", u.uid, "meta", "countdown"), value || {});
  } else if (m && m[1] && !m[2]) {
    await FB.setDoc(FB.doc(FB.db, "users", u.uid, "days", m[1]), value || {});
  } else if (m && m[1] && m[2]) {
    await FB.setDoc(FB.doc(FB.db, "users", u.uid, "days", m[1], "bullets", m[2]), { items: value || [] });
  }
}

// live-fill the cache on sign-in
window.startFirebaseSync = function startFirebaseSync(user) {
  const FB = window.firebaseServices;
  if (!FB || !user) return;

  const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const today = fmt(getPlannerDate(0));
  const tomorrow = fmt(getPlannerDate(1));
  const daysToWatch = [today, tomorrow];

  daysToWatch.forEach(async ds => {
    const dayKeyStr = `planner:${ds}`;
    const ref = FB.doc(FB.db, "users", user.uid, "days", ds);
    const snap = await FB.getDoc(ref);
    REMOTE_CACHE.set(dayKeyStr, snap.exists() ? (snap.data() || {}) : {});
    FB.onSnapshot(ref, d => REMOTE_CACHE.set(dayKeyStr, d.exists() ? (d.data() || {}) : {}));

    FB.onSnapshot(FB.collection(FB.db, "users", user.uid, "days", ds, "bullets"), qs => {
      qs.forEach(docSnap => {
        REMOTE_CACHE.set(`planner:${ds}:bullets:${docSnap.id}`, docSnap.data()?.items || []);
      });
    });
  });

  FB.onSnapshot(FB.doc(FB.db, "users", user.uid, "meta", "notes"),
    d => REMOTE_CACHE.set("planner:notes", d.data()?.items || []));
  FB.onSnapshot(FB.doc(FB.db, "users", user.uid, "meta", "countdown"),
    d => REMOTE_CACHE.set("planner:countdown", d.data() || null));
};

// Shallow item-array equality: [{text,done,folder}, ...]
function itemsEqual(a = [], b = []) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ax = a[i] || {}, bx = b[i] || {};
    if (((ax.text || "").trim()) !== ((bx.text || "").trim())) return false;
    if (!!ax.done !== !!bx.done) return false;
    const af = String(ax.folder || ""), bf = String(bx.folder || "");
    if (af !== bf) return false;
  }
  return true;
}

// { key: [normText,...] } equality (order-sensitive per array)
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


// Read bullets for a specific YYYY-MM-DD from storage
function readBulletsForDate(ds) {
  const out = {};
  const prefix = `${dayKeyFromDateStr(ds)}:bullets:`;
  Object.keys(localStorage).forEach((k) => {
    if (k.startsWith(prefix)) {
      const listKey = k.slice(prefix.length);
      out[listKey] = { type: "bullets", items: loadJSON(k, []) };
    }
  });
  return out;
}


// --- Global checklist templates ---
const TPL_KEY = "planner:templates:v1";
const readTemplates = () => loadJSON(TPL_KEY, {});
const saveTemplates = (obj) => saveJSON(TPL_KEY, obj);


const _norm = (s) => (s || "").trim().toLowerCase();

function carryKey(textOrItem, folder = undefined) {
  // why: single source of truth for carry/dedupe identity
  const t = typeof textOrItem === "object" ? textOrItem?.text : textOrItem;
  const f = typeof textOrItem === "object" ? textOrItem?.folder : folder;
  return `${_norm(t || "")}@${String(f || "")}`;
}

/* -------- File System Access + IndexedDB handle storage -------- */
const FS_DB = "plannerFS";
const FS_STORE = "handles";
const FS_KEYS = { OPEN_START: "planner:lastOpenStartIn" };


const idb = {
  put(key, val) {
    return new Promise((res, rej) => {
      const open = indexedDB.open(FS_DB, 1);
      open.onupgradeneeded = () => open.result.createObjectStore(FS_STORE);
      open.onsuccess = () => {
        const tx = open.result.transaction(FS_STORE, "readwrite");
        tx.objectStore(FS_STORE).put(val, key);
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      };
      open.onerror = () => rej(open.error);
    });
  },
  get(key) {
    return new Promise((res, rej) => {
      const open = indexedDB.open(FS_DB, 1);
      open.onupgradeneeded = () => open.result.createObjectStore(FS_STORE);
      open.onsuccess = () => {
        const tx = open.result.transaction(FS_STORE, "readonly");
        const req = tx.objectStore(FS_STORE).get(key);
        req.onsuccess = () => res(req.result || null);
        req.onerror = () => rej(req.error);
      };
      open.onerror = () => rej(open.error);
    });
  },
};


function saveViaHref(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
}

// Build export payload for a given day offset (0=today, 1=tomorrow)
function buildExport(offset) {
  const ds = ymd(getPlannerDate(offset));
  let dayObj, bullets;

  if (offset === DAY_OFFSET) {
    // Export from the current page's DOM
    dayObj = collectChecklistsFromDOM();
    dayObj.__smokes = getSmokesCountFromDOM();
    const stored = loadJSON(dayKey(offset), {}) || {};
    mergeClearedIntoDayObj(dayObj, stored.__clearedDone);
    bullets = collectBulletsFromDOM();
  } else {
    // Export from storage for a non-active day
    dayObj = loadJSON(dayKey(offset), {}) || {};
    bullets = readBulletsForDate(ds);
  }

  return {
    filename: `${ds}-planner.json`,
    payload: {
      version: 2,
      date: ds,
      day: dayObj,
      bullets,
      notes: loadJSON(GLOBAL_NOTES_KEY, []),
    },
  };
}

// Reuse the same download interaction as the buttons
function downloadDayViaHref(offset) {
  const { filename, payload } = buildExport(offset);
  saveViaHref(filename, payload);
}

async function pickFileFromRememberedDir() {
  let opts = {
    types: [{ description: "Planner JSON", accept: { "application/json": [".json"] } }],
    multiple: false,
    excludeAcceptAllOption: true,
  };

  if (window.showOpenFilePicker) {
    try {
      const last = await idb.get(FS_KEYS.OPEN_START); // may be a File or Directory handle
      if (last?.queryPermission) {
        let p = await last.queryPermission({ mode: "read" });
        if (p === "prompt" && last.requestPermission) p = await last.requestPermission({ mode: "read" });
        if (p === "granted" || p === "prompt") opts.startIn = last;
      }
    } catch { /* ignore stale handle */ }

    try {
      const [h] = await window.showOpenFilePicker(opts);
      try { await idb.put(FS_KEYS.OPEN_START, h); } catch { /* ignore persist failures */ }
      return await h.getFile();
    } catch (err) {
      // Retry once without startIn if the stored handle is no longer valid
      if (opts.startIn) {
        delete opts.startIn;
        const [h] = await window.showOpenFilePicker(opts);
        try { await idb.put(FS_KEYS.OPEN_START, h); } catch { }
        return await h.getFile();
      }
      throw err;
    }
  }

  // Fallback (no File System Access API)
  return new Promise((res, rej) => {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = "application/json";
    inp.onchange = () => res(inp.files[0]);
    inp.onerror = rej;
    inp.click();
  });
}


/* -------- UI helpers -------- */
function el(tag, className, text) { const n = document.createElement(tag); if (className) n.className = className; if (text != null) n.textContent = text; return n; }
function svgCheck() {
  const ns = "http://www.w3.org/2000/svg";
  const s = document.createElementNS(ns, "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("fill", "none");
  s.setAttribute("stroke", "currentColor");
  s.setAttribute("stroke-width", "3");
  s.setAttribute("stroke-linecap", "round");
  s.setAttribute("stroke-linejoin", "round");
  s.setAttribute("class", "size-4 text-main");
  const p = document.createElementNS(ns, "path");
  p.setAttribute("d", "M5 12l5 5L19 7");
  s.appendChild(p);
  return s;
}
function getCardBoundary(key, which) {
  const card = document.querySelector(`[data-checklist][data-key="${key}"]`);
  if (!card) return null;
  const v = Number(card.dataset[which]);
  return Number.isFinite(v) ? v : null;
}

// Capitalize only first character of the first word
function capFirst(s) {
  s = String(s).trim();
  return s ? s[0].toLocaleUpperCase() + s.slice(1) : s;
}

// Parse "Item text #folderA #folderB/sub". Everything before first "#" is the item.
// Uses normalizeFolderPath for a single source of truth (drops "#unfiled", enforces caps).
function parseItemAndTags(line, { isTimeCard = false } = {}) {
  const s = String(line || "").trim();
  if (!s) return { text: "", folders: [] };
  if (isTimeCard) return { text: s, folders: [] };

  const i = s.indexOf("#");
  if (i < 0) return { text: s, folders: [] };

  const text = s.slice(0, i).trim();

  // delegate all tag cleanup to normalizeFolderPath
  const raw = s.slice(i)
    .split(/(\s+)/)
    .map(x => x.trim())
    .filter(Boolean)
    .filter(x => x.startsWith("#"))
    .map(x => x.replace(/^#+/, ""));

  const tags = raw
    .map(normalizeFolderPath) // may return "" for unfiled
    .filter(Boolean);

  const seen = new Set();
  const folders = tags.filter(t => (seen.has(t) ? false : (seen.add(t), true)));
  return { text, folders };
}


// === Folder rules ===
const FOLDER_MAXLEN = 48;           // full path cap
const ALLOWED_CHARS = /[^a-z0-9 _\-\/]/gi;  // allow letters, digits, space, _ - /
const UNFILED_KEY = "";             // internal key for Unfiled


// Display a single, standalone folder name
function displayFolder(path) {
  if (!path) return "Unfiled";
  const s = String(path).replace(/[-_]+/g, " ").trim();
  return s.split(/\s+/).map(capFirst).join(" ");
}

// normalize a raw tag -> standalone folder (lowercase, spaces->- , allowed charset, cap length)
function normalizeFolderPath(raw) {
  if (!raw) return UNFILED_KEY;
  let s = String(raw).replace(/^#+/, "").replace(ALLOWED_CHARS, " ").trim();
  s = s.replace(/\s+/g, " ").toLowerCase();
  s = s.replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^[-_]+|[-_]+$/g, "");
  if (!s || s === "unfiled") return UNFILED_KEY;
  if (s.length > FOLDER_MAXLEN) s = s.slice(0, FOLDER_MAXLEN);
  return s;
}

/* --- inline edit + reorder helpers --- */
let DRAG_SRC = null;
function placeCaretEnd(el) {
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(false);
  const s = window.getSelection();
  s.removeAllRanges();
  s.addRange(r);
}

// "-folderName" command => delete that folder
function parseFolderDelete(line) {
  const m = String(line || "").trim().match(/^-\s*([a-z0-9 _\-\/]+)\s*$/i);
  return m ? m[1].toLowerCase() : null;
}

// Unified UI state under "__ui"
const UI_STATE_KEY = "__ui";

function readUI() {
  const d = loadJSON(dayKey(), {}) || {};
  return d[UI_STATE_KEY] || {};
}

function writeUI(next) {
  const d = loadJSON(dayKey(), {}) || {};
  d[UI_STATE_KEY] = next || {};
  saveJSON(dayKey(), d);
}

// Back-compat migration of legacy keys → __ui
function migrateUIState() {
  const k = dayKey();
  const d = loadJSON(k, {}) || {};
  let ui = d[UI_STATE_KEY] || {};
  let changed = false;

  ui.folders = ui.folders || {};
  ui.cards = ui.cards || {};
  ui.cards.manual = ui.cards.manual || {};
  ui.cards.auto = ui.cards.auto || {};

  if (d.__foldersCollapsed) {
    for (const [card, map] of Object.entries(d.__foldersCollapsed)) {
      ui.folders[card] = Object.assign({}, ui.folders[card] || {}, map);
    }
    delete d.__foldersCollapsed;
    changed = true;
  }
  if (d.__manualCollapsed) {
    Object.assign(ui.cards.manual, d.__manualCollapsed);
    delete d.__manualCollapsed;
    changed = true;
  }
  if (d.__collapsed) {
    Object.assign(ui.cards.auto, d.__collapsed);
    delete d.__collapsed;
    changed = true;
  }

  if (changed || !d[UI_STATE_KEY]) {
    d[UI_STATE_KEY] = ui;
    saveJSON(k, d);
  }
}

// Folder collapsed helpers (per card)
function getCardFolderState(cardKey) {
  const ui = readUI();
  return (ui.folders && ui.folders[cardKey]) || {};
}

function setCardFolderState(cardKey, next) {
  const ui = readUI();
  ui.folders = ui.folders || {};
  ui.folders[cardKey] = next || {};
  writeUI(ui);
}

// persisted headers per card so empty folders survive refresh
function folderHeadersKey() { return "__folderHeaders"; }

function collectFolderHeadersFromDOM() {
  const out = {};
  document.querySelectorAll("[data-checklist][data-key]").forEach((card) => {
    const key = card.dataset.key;
    const list = card.querySelector("[data-checklist-list]");
    const headers = list
      ? [...list.querySelectorAll('li[data-folder-header]')]
        .map(h => (h.dataset.folderHeader === "__none" ? "" : h.dataset.folderHeader))
        .filter(Boolean) // ignore Unfiled to keep it hidden-until-needed
      : [];
    out[key] = headers;
  });
  return out;
}

// create or return a header <li> for a folder inside a given list
function ensureFolderHeader(list, cardKey, folder) {
  const key = String(folder || "");
  const sel = key ? `[data-folder-header="${key}"]` : `[data-folder-header="__none"]`;
  let header = list.querySelector(sel);
  if (header) return header;

  header = el("li", "mt-4 px-3 py-1 flex items-center justify-between bg-white/70");
  header.setAttribute("data-folder-header", key || "__none");

  const left = el("div", "flex items-center gap-2");
  const caret = el("i", "fa-solid fa-caret-up collapseFolderCaret text-neutral hover:cursor-pointer");
  const name = el("span", "font-sec font-bold text-accents", key ? displayFolder(key) : "Unfiled");
  left.append(caret, name);

  const count = el("span", "text-sm text-accents/60"); count.setAttribute("data-count", "0");
  header.append(left, count);
  list.appendChild(header);

  // apply persisted collapsed state
  const st = getCardFolderState(cardKey);
  if (st[key] === true) {
    caret.classList.remove("fa-caret-up");
    caret.classList.add("fa-caret-down");
    header.setAttribute("data-collapsed", "1");
  }
  return header;
}
function setFolderCollapsed(list, cardKey, folder, collapsed) {
  const key = String(folder || "");
  const header = ensureFolderHeader(list, cardKey, key);
  header.toggleAttribute("data-collapsed", !!collapsed);
  const caret = header.querySelector("i.collapseFolderCaret");
  if (caret) {
    caret.classList.toggle("fa-caret-up", !collapsed);
    caret.classList.toggle("fa-caret-down", !!collapsed);
  }
  // hide/show items in this folder
  [...list.querySelectorAll(`li[data-folder="${key}"]`)]
    .forEach(li => li.classList.toggle("hidden", !!collapsed));

  const st = getCardFolderState(cardKey);
  st[key] = !!collapsed;
  setCardFolderState(cardKey, st);
}
function updateFolderCounts(list) {
  const groups = {};
  [...list.querySelectorAll('li[data-folder]')].forEach(li => {
    const k = li.dataset.folder || "";
    groups[k] = (groups[k] || 0) + 1;
  });

  [...list.querySelectorAll('li[data-folder-header]')].forEach(h => {
    const k = h.dataset.folderHeader === "__none" ? "" : h.dataset.folderHeader;
    h.querySelector('[data-count]')?.replaceChildren(document.createTextNode(groups[k] || 0));
    // Hide Unfiled header if empty; keep others visible even when empty
    if (h.dataset.folderHeader === "__none") {
      h.classList.toggle("hidden", (groups[""] || 0) === 0);
    }
  });
}


function findDupInFolder(list, folderKey, normText) {
  const sel = `li[data-folder="${folderKey}"] [data-role="label"]`;
  return [...list.querySelectorAll(sel)]
    .some(n => _norm((n.textContent || "")) === normText);
}


function ensureUnfiledHeaderIfNeeded(list, cardKey) {
  // only create Unfiled header when actually receiving an item
  return ensureFolderHeader(list, cardKey, UNFILED_KEY);
}

function moveItemToFolder(li, destKey, cardKey, list) {
  const label = li.querySelector('[data-role="label"]');
  const norm = _norm((label?.textContent || "").trim());
  if (li.dataset.folder === destKey) return;

  // dedupe: if same text already in destination, drop the moved one
  if (findDupInFolder(list, destKey, norm)) {
    li.remove();
    updateFolderCounts(list);
    snapshotDay();
    return;
  }

  // ensure destination header exists (non-time cards only)
  const isTimeCard = TIME_KEYS.includes(cardKey);
  if (!isTimeCard) {
    if (destKey === UNFILED_KEY) ensureUnfiledHeaderIfNeeded(list, cardKey);
    else ensureFolderHeader(list, cardKey, destKey);
  }

  li.dataset.folder = destKey;

  // reinsert after that folder's header if present; else append
  const headerSel = destKey ? `[data-folder-header="${destKey}"]` : `[data-folder-header="__none"]`;
  const header = list.querySelector(headerSel);
  // append after last item in destination folder if any
  const destItems = [...list.querySelectorAll(`li[data-folder="${destKey}"]`)];
  const last = destItems.length ? destItems[destItems.length - 1] : null;
  if (last) list.insertBefore(li, last.nextSibling);
  else if (header) list.insertBefore(li, header.nextSibling);
  else list.appendChild(li);

  updateFolderCounts(list);
  snapshotDay();
}

function deleteFolderCommand(list, cardKey, rawPath) {
  const isTimeCard = TIME_KEYS.includes(cardKey);
  if (isTimeCard) return; // time cards don't have folders

  const path = normalizeFolderPath(rawPath);
  const headerSel = path ? `[data-folder-header="${path}"]` : `[data-folder-header="__none"]`;
  const header = list.querySelector(headerSel);

  if (!header) return; // nothing to do

  // special rules for Unfiled
  if (path === UNFILED_KEY) {
    const hasItems = !!list.querySelector('li[data-folder=""]');
    if (hasItems) { alert('Cannot delete "Unfiled" while it has items.'); return; }
    header.remove(); updateFolderCounts(list); snapshotDay(); return;
  }

  // move items to Unfiled (creating header only if needed), then remove header
  const items = [...list.querySelectorAll(`li[data-folder="${path}"]`)];
  if (items.length) ensureUnfiledHeaderIfNeeded(list, cardKey);
  items.forEach(li => moveItemToFolder(li, UNFILED_KEY, cardKey, list));
  header.remove();
  updateFolderCounts(list);
  snapshotDay();
}


/* --- time-card collapse helpers --- */
const TIME_KEYS = ["morning", "daytime", "evening"];
const DEFAULT_END = { morning: 14, daytime: 18, evening: 22 };

// Manual collapse per card via __ui.cards.manual
function getManualMap() {
  const ui = readUI();
  return (ui.cards && ui.cards.manual) || {};
}
function isManualCollapsed(key) {
  return !!getManualMap()[key];
}
function setManualCollapsed(key, val) {
  const ui = readUI();
  ui.cards = ui.cards || {};
  ui.cards.manual = ui.cards.manual || {};
  if (val) ui.cards.manual[key] = true; else delete ui.cards.manual[key];
  writeUI(ui);
}


function cardEndHour(key) {
  const v = getCardBoundary(key, "end");
  return Number.isFinite(v) ? v : DEFAULT_END[key] ?? 24;
}


// Sync tomorrow from today. 
function syncTomorrowFromToday(mode = "time") {
  // precedence: use Today DOM when on Today page, else use stored Today
  const todayFromDOM = (DAY_OFFSET === 0) ? collectChecklistsFromDOM() : null;
  const todayData = todayFromDOM || loadJSON(dayKey(0), {}) || {};

  const tKey = dayKey(1);
  const tomorrowData = loadJSON(tKey, {}) || {};
  const prevCarriedMeta = tomorrowData.__carried || {};
  const newCarriedMeta = {};
  let changed = false;

  const hdrKey = folderHeadersKey();
  const todayHeaders = todayFromDOM ? collectFolderHeadersFromDOM()
    : (todayData[hdrKey] || {});
  const tomHeaders = tomorrowData[hdrKey] || {};
  let headersChanged = false;


  const keys = mode === "all" ? Object.keys(todayData) : TIME_KEYS;

  keys.forEach((key) => {
    const entry = todayData[key];
    if (!entry || entry.type !== "checklist" || !Array.isArray(entry.items)) return;
    const th = todayHeaders[key] || [];
    if (th.length) {
      const existing = tomHeaders[key] || [];
      const merged = Array.from(new Set([...existing, ...th]));
      if (existing.length !== merged.length || existing.some((v, i) => v !== merged[i])) {
        tomHeaders[key] = merged;
        headersChanged = true;
      }
    }
    // carry key = normText@folder
    const carryMap = new Map();
    entry.items.forEach((it) => {
      if (!it.done) {
        const k = carryKey(it);
        if (k !== "@") carryMap.set(k, { text: it.text, folder: String(it.folder || "") });
      }
    });
    newCarriedMeta[key] = Array.from(carryMap.keys());

    const existing = (tomorrowData[key] && Array.isArray(tomorrowData[key].items)) ? tomorrowData[key].items : [];

    // what was carried in the last sync
    const prevArr = prevCarriedMeta[key] || [];
    const prevSet = new Set(prevArr);

    // Fallback bootstrap: if there’s no meta yet, treat any tomorrow item that
    // also exists in today (same text@folder) as “previously carried” so we can
    // remove it when it’s now done.
    if (prevSet.size === 0 && existing.length) {
      const todayAll = new Set((entry.items || []).map(it => carryKey(it)));
      existing.map(it => carryKey(it)).forEach(k => { if (todayAll.has(k)) prevSet.add(k); });
    }

    const prevTextSet = new Set(Array.from(prevSet).map(k => k.split("@")[0]));

    // items already in tomorrow that were NOT previously carried
    const native = existing.filter(it => !prevSet.has(carryKey(it)));
    const nativeTextSet = new Set(native.map(it => _norm(it.text)));

    const newCarriedItems = [];
    carryMap.forEach(({ text, folder }, composite) => {
      const norm = _norm(text);
      const editedPrevCarriedPresent = prevTextSet.has(norm) && nativeTextSet.has(norm);
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

  if (headersChanged) tomorrowData[hdrKey] = tomHeaders;
  if (changed || headersChanged || !carriedMetaEqual(tomorrowData.__carried || {}, newCarriedMeta)) {
    tomorrowData.__carried = newCarriedMeta;
    saveJSON(tKey, tomorrowData);
  }

}



// --- debounced sync trigger
function debounce(fn, ms = 200) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
const syncTomorrowDebounced = debounce((mode) => syncTomorrowFromToday(mode), 200);



function getSmokesCountFromDOM() {
  const el = document.getElementById("smokescount");
  const n = parseInt(el?.textContent || "0", 10);
  return Number.isFinite(n) ? n : 0;
}
function setSmokesCount(n) {
  const el = document.getElementById("smokescount");
  if (el) el.textContent = String(n);
}

/* -------- Greeting + titles -------- */
function updateGreeting() {
  const h1 = document.getElementById("greeting") ;
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
function setHeaderAndTitle() {
  const d = getPlannerDate(DAY_OFFSET);

  // Title: "Wed 05-Oct"
  const tParts = new Intl.DateTimeFormat('en-GB', {
    weekday: 'short', day: '2-digit', month: 'short'
  }).formatToParts(d);
  const w = tParts.find(p => p.type === 'weekday')?.value || '';
  const dd = tParts.find(p => p.type === 'day')?.value || '';
  const mon = tParts.find(p => p.type === 'month')?.value || '';
  document.title = `${w} ${dd}-${mon}`;

  // Header: "Wednesday, 5th of October"
  const hParts = new Intl.DateTimeFormat('en-US', {
    weekday: 'long', day: 'numeric', month: 'long'
  }).formatToParts(d);
  const W = hParts.find(p => p.type === 'weekday')?.value || '';
  const Dn = Number(hParts.find(p => p.type === 'day')?.value || 0);
  const M = hParts.find(p => p.type === 'month')?.value || '';
  const todayEl = document.getElementById('today');
  if (todayEl) todayEl.textContent = `${W}, ${Dn}${ord(Dn)} of ${M}`;
}

function rebuildHeaderFromStorage() {
  setHeaderAndTitle();
  updateGreeting();
  const day = loadJSON(dayKey(DAY_OFFSET), {}) || {};
  const n = Number.isFinite(day.__smokes) ? day.__smokes : 0;
  setSmokesCount(n);
}

/* -------- Highlight current block (today only) -------- */
function highlightCurrentBlock() {
  if (DAY_OFFSET !== 0) return;
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

/* -------- Checklist card wiring (with styled, accessible checkboxes) -------- */
function wireChecklist(root) {
  const form = root.querySelector("[data-checklist-form]");
  const input = root.querySelector("[data-checklist-input]");
  const list = root.querySelector("[data-checklist-list]");
  if (!form || !input || !list) return;
  if (root.__wiredChecklist) return;
  root.__wiredChecklist = true;
  const cardKey = root.dataset.key || "card";
  let id = 0;
  let suppressSave = false;

  // --- Templates: use the pre-rendered folder button ---
  const toggleIcon = form.querySelector('button[type="button"] i.fa-folder-open');
  const toggle = toggleIcon ? toggleIcon.closest('button') : null;

  if (toggle) {
    // wrap the toggle so the menu can be absolutely positioned
    const wrap = el("div", "relative inline-flex items-center my-auto");
    toggle.replaceWith(wrap);
    wrap.appendChild(toggle);

    const menu = el("div", "absolute right-0 top-full mt-1 w-64 font-sec bg-neutral border-neutral border-1 rounded-lg shadow-lg hidden z-20");
    wrap.appendChild(menu);

    function applyTemplate(items, preserveDone) {
      // why: templates only for time cards; treat '#' literally
      if (!TIME_KEYS.includes(cardKey)) return;

      const have = new Set(
        [...list.querySelectorAll('[data-role="label"]')]
          .map(n => (n.textContent || "").trim().toLowerCase())
      );

      suppressSave = true;
      (items || []).forEach(it => {
        const text = capFirst(typeof it === "string" ? it : (it?.text || ""));
        if (!text) return;
        const k = text.toLowerCase();
        if (have.has(k)) return;
        addItem(text, preserveDone && !!it?.done); // no folder arg
        have.add(k);
      });
      suppressSave = false;
      snapshotDay();
    }

    // cleaner: hide with [hidden] so Tailwind enforces display:none !important
    function hasTemplates() { return Object.keys(readTemplates()).length > 0; }
    function updateTemplateToggle() {
      wrap.hidden = !hasTemplates();
      if (wrap.hidden) menu.classList.add("hidden");
    }

    // build rows once per open; delegate clicks
    function rebuildMenu() {
      const tpls = readTemplates();
      menu.innerHTML = "";

      const names = Object.keys(tpls).sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: "base" })
      );

      names.forEach(name => {
        const row = el("div",
          "flex items-center justify-between px-3 pt-4 pb-2 text-white hover:bg-white hover:text-neutral focus:bg-white focus:text-neutral");

        const applyBtn = el("button", "text-left flex-1", name);
        applyBtn.type = "button";
        applyBtn.dataset.action = "tpl-apply";
        applyBtn.dataset.tpl = name;

        const delBtn = el("button",
          "ml-2 px-2 py-1 rounded-md text-red-400 hover:text-red-700 transition-colors");
        delBtn.type = "button";
        delBtn.setAttribute("aria-label", `Delete template ${name}`);
        delBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
        delBtn.dataset.action = "tpl-del";
        delBtn.dataset.tpl = name;

        row.append(applyBtn, delBtn);
        menu.appendChild(row);
      });

      if (!names.length) menu.classList.add("hidden");
      updateTemplateToggle();
    }

    // single delegated handler
    menu.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-action]");
      if (!btn) return;
      const name = btn.dataset.tpl;
      if (btn.dataset.action === "tpl-apply") {
        const tpls = readTemplates();
        applyTemplate(tpls[name], e.altKey || e.metaKey);
        menu.classList.add("hidden");
        input.focus();
      } else if (btn.dataset.action === "tpl-del") {
        if (!confirm(`Delete template "${name}"?`)) return;
        const store = readTemplates();
        delete store[name];
        saveTemplates(store);
        document.dispatchEvent(new CustomEvent("templates:changed"));
      }
    });

    toggle.addEventListener("click", () => { rebuildMenu(); menu.classList.toggle("hidden"); });
    document.addEventListener("click", (e) => { if (!wrap.contains(e.target)) menu.classList.add("hidden"); });
    toggle.addEventListener("keydown", (e) => { if (e.key === "Escape") menu.classList.add("hidden"); });

    document.addEventListener("templates:changed", () => { rebuildMenu(); updateTemplateToggle(); });
    updateTemplateToggle();
  }


  // Save template button (time cards only)
  const saveBtn = root.querySelector("[data-template-save]");
  if (saveBtn) {
    saveBtn.type = "button";
    saveBtn.addEventListener("click", () => {
      if (!TIME_KEYS.includes(cardKey)) { alert("Templates are for time blocks only."); return; } // why: prevent misuse

      const name = (prompt("Template name?") || "").trim();
      if (!name) return;

      const items = [...root.querySelectorAll("[data-checklist-list] > li")].map(li => {
        const label = li.querySelector('[data-role="label"]');
        const cb = li.querySelector('input[type="checkbox"]');
        return { text: (label?.textContent || "").trim(), done: !!cb?.checked };
      }).filter(it => it.text);

      if (!items.length) { alert("No items to save."); return; }

      const store = readTemplates();
      store[name] = items; // no folder field
      saveTemplates(store);
      document.dispatchEvent(new CustomEvent("templates:changed"));
    });
  }

  function addItem(text, done = false, restoring = false, folder = "") {
    const isTimeCard = TIME_KEYS.includes(cardKey);
    const f = isTimeCard ? "" : String(folder || "");

    const li = el("li", "mt-3 flex items-center gap-2 px-3");
    li.setAttribute("data-folder", f);

    const handle = el("span", "ml-1 cursor-grab select-none text-accents/60", "⋮⋮");
    handle.setAttribute("data-handle", "1");
    li.draggable = true;

    const row = el("label", "flex items-center gap-3 flex-1");
    const itemId = `cb-${cardKey}-${id++}`;
    row.setAttribute("for", itemId);

    // Accessible custom checkbox
    const cb = el("input", "sr-only");
    cb.type = "checkbox"; cb.id = itemId;

    const boxWrap = el("span", "relative inline-flex items-center justify-center w-5 h-5");
    const box = el("span", "w-5 h-5 rounded bg-white border-2 border-neutral pointer-events-none");
    box.setAttribute("aria-hidden", "true");
    const icon = svgCheck();
    icon.setAttribute("aria-hidden", "true");
    icon.classList.add("absolute", "opacity-0", "pointer-events-none");
    boxWrap.append(box, icon);

    const labelEl = el("span", "flex-1 text-accents font-bold tracking-wide text-xl font-sec");
    labelEl.textContent = text; labelEl.setAttribute("data-role", "label");

    function syncTick() {
      const checked = cb.checked;
      labelEl.classList.toggle("line-through", checked);
      icon.classList.toggle("opacity-0", !checked);
      icon.classList.toggle("opacity-100", checked);
      icon.setAttribute("aria-hidden", checked ? "false" : "true");
      box.classList.toggle("border-main", !checked);
      box.classList.toggle("border-accents", checked);
    }

    const edit = el("button", "px-2 py-1 rounded-md text-accents/80 hover:text-white hover:bg-neutral transition-colors", "✎");
    edit.type = "button"; edit.title = "Edit";

    const del = el("button", "px-2 py-1 rounded-md text-red-400 hover:text-white hover:bg-neutral transition-colors", "✕");
    del.type = "button"; del.title = `Remove "${text}"`;

    // checkbox react
    cb.addEventListener("change", () => {
      syncTick();
      if (!suppressSave) snapshotDayImmediate();
    });


    // inline edit (disable toggle while editing)
    edit.addEventListener("click", () => {
      if (labelEl.isContentEditable) return;
      const original = labelEl.textContent;
      labelEl.contentEditable = "true";
      labelEl.classList.add("outline-none");
      row.removeAttribute("for"); // clicking label won't toggle
      cb.disabled = true;         // checking disabled while editing
      labelEl.focus(); placeCaretEnd(labelEl);

      function commit() {
        labelEl.textContent = (labelEl.textContent || "").trim();
        if (!labelEl.textContent) { li.remove(); updateFolderCounts(list); snapshotDay(); edit.focus(); cleanup(); return; }
        labelEl.contentEditable = "false";
        row.setAttribute("for", itemId);
        cb.disabled = false;
        snapshotDay();
        edit.focus();
        labelEl.classList.remove("outline-none");
        cleanup();
      }
      function cancel() {
        labelEl.textContent = original;
        labelEl.contentEditable = "false";
        row.setAttribute("for", itemId);
        cb.disabled = false;
        edit.focus();
        labelEl.classList.remove("outline-none");
        cleanup();
      }
      function onKey(e) {
        if (e.key === "Enter") { e.preventDefault(); commit(); }
        if (e.key === "Escape") { e.preventDefault(); cancel(); }
      }
      function cleanup() {
        labelEl.removeEventListener("keydown", onKey);
        labelEl.removeEventListener("blur", commit);
      }
      labelEl.addEventListener("keydown", onKey);
      labelEl.addEventListener("blur", commit);
    });

    del.addEventListener("click", () => {
      li.remove();
      updateFolderCounts(list);
      if (!suppressSave) snapshotDay();
    });

    // DnD (allow cross-folder moves; update folder key and counts)
    li.addEventListener("dragstart", (e) => {
      const t = e.target;
      if (labelEl.isContentEditable || t.closest("button,input,[contenteditable='true']")) { e.preventDefault(); return; }
      DRAG_SRC = li;
      li.classList.add("opacity-50");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", itemId);
    });
    li.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; });
    li.addEventListener("drop", (e) => {
      e.preventDefault();
      if (!DRAG_SRC || DRAG_SRC === li) return;

      const items = [...list.children];
      const src = items.indexOf(DRAG_SRC);
      const dst = items.indexOf(li);
      if (src < dst) list.insertBefore(DRAG_SRC, li.nextSibling);
      else list.insertBefore(DRAG_SRC, li);

      // find new folder by scanning previous headers
      let p = DRAG_SRC.previousElementSibling;
      let newKey = "";
      while (p) {
        if (p.hasAttribute("data-folder-header")) {
          newKey = (p.dataset.folderHeader === "__none") ? "" : p.dataset.folderHeader;
          break;
        }
        p = p.previousElementSibling;
      }
      DRAG_SRC.setAttribute("data-folder", isTimeCard ? "" : newKey);
      updateFolderCounts(list);
      snapshotDay();
    });
    li.addEventListener("dragend", () => { li.classList.remove("opacity-50"); DRAG_SRC = null; });

    row.append(cb, boxWrap, labelEl);
    li.append(handle, row, edit, del);

    let inserted = false;
    if (!isTimeCard) {
      // ensure header for this folder
      ensureFolderHeader(list, cardKey, f);

      // append after the last item in the same folder (preserves order)
      const same = [...list.querySelectorAll(`li[data-folder="${f}"]`)];
      const last = same.length ? same[same.length - 1] : null;
      if (last) { list.insertBefore(li, last.nextSibling); inserted = true; }
      else {
        const header = list.querySelector(f ? `[data-folder-header="${f}"]`
          : `[data-folder-header="__none"]`);
        if (header) { list.insertBefore(li, header.nextSibling); inserted = true; }
      }
    }
    if (!inserted) list.appendChild(li);


    suppressSave = true;
    cb.checked = !!done;
    syncTick();
    suppressSave = false;

    if (!restoring) { updateFolderCounts(list); snapshotDay(); }

    // honor collapsed state on add
    const st = getCardFolderState(cardKey);
    if (!isTimeCard && st[f] === true) li.classList.add("hidden");
  }

  root.__addChecklistItem = (text, done = false, restoring = false, folder = "") =>
    addItem(text, done, restoring, folder);

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const raw = (input.value || "").trim();
    if (!raw) return;

    const parts = raw.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
    const isTimeCard = TIME_KEYS.includes(cardKey);

    // parse all parts first
    const entries = parts.map(line => {
      const del = parseFolderDelete(line);
      const { text, folders } = parseItemAndTags(line, { isTimeCard });
      return { line, del, text, folders };
    });

    // propagate trailing tags (e.g., "a,b,c #work") to earlier items without tags
    if (!isTimeCard) {
      const nonDel = entries.filter(e => !e.del);
      if (nonDel.length > 1) {
        const last = nonDel[nonDel.length - 1];
        if (last.folders.length && nonDel.slice(0, -1).every(e => e.folders.length === 0)) {
          const common = last.folders.slice();
          nonDel.slice(0, -1).forEach(e => { e.folders = common.slice(); });
        }
      }
    }

    // now handle each entry as before
    entries.forEach(({ del, text, folders, line }) => {
      if (isTimeCard) {
        if (text) addItem(capFirst(text), false, false, "");
        return;
      }

      if (del) { deleteFolderCommand(list, cardKey, del); return; }

      const haveFolders = folders && folders.length;
      if (!text) {
        if (haveFolders) {
          folders.forEach(f => ensureFolderHeader(list, cardKey, f));
          updateFolderCounts(list);
          snapshotDay();
        }
        return;
      }

      const norm = _norm(capFirst(text));
      if (haveFolders) {
        folders.forEach(f => { if (!findDupInFolder(list, f, norm)) addItem(capFirst(text), false, false, f); });
      } else {
        if (!findDupInFolder(list, "", norm)) addItem(capFirst(text), false, false, "");
      }
    });
    input.value = "";
  });





  input.addEventListener("blur", () => { input.value = capFirst(input.value); });

  // folder header click: collapse/expand
  list.addEventListener("click", (e) => {
    const header = e.target.closest('li[data-folder-header]');
    if (!header) return;

    const caretIcon = e.target.closest('i.collapseFolderCaret');
    const folderKey = header.dataset.folderHeader === "__none" ? "" : header.dataset.folderHeader;
    const next = !header.hasAttribute("data-collapsed");

    // Alt/Meta on the folder caret → toggle ALL folders in this card
    if (caretIcon && (e.altKey || e.metaKey)) {
      list.querySelectorAll('li[data-folder-header]').forEach(h => {
        const k = h.dataset.folderHeader === "__none" ? "" : h.dataset.folderHeader;
        setFolderCollapsed(list, cardKey, k, next);
      });
      return;
    }

    // Default → toggle just this folder
    setFolderCollapsed(list, cardKey, folderKey, next);
  });

  // Smoke toggle (time cards)
  const smoke = root.querySelector("[data-smoke]");
  if (smoke) wireSmoke(smoke);
}

/* -------- Bullets (global Notes vs day-scoped Food, etc.) -------- */
function wireBullets(root) {
  const form = root.querySelector("[data-bullets-form]");
  const input = root.querySelector("[data-bullets-input]");
  const list = root.querySelector("[data-bullets-list]");
  const key = root.dataset.key || "notes";
  if (!form || !input || !list) return;
  if (root.__wiredBullets) return;
  root.__wiredBullets = true;
  list.addEventListener("click", (e) => {
    const header = e.target.closest('li[data-folder-header]');
    if (!header) return;

    const caretIcon = e.target.closest('i.collapseFolderCaret');
    const folderKey = header.dataset.folderHeader === "__none" ? "" : header.dataset.folderHeader;
    const next = !header.hasAttribute("data-collapsed");

    if (caretIcon && (e.altKey || e.metaKey)) {
      list.querySelectorAll('li[data-folder-header]').forEach(h => {
        const k = h.dataset.folderHeader === "__none" ? "" : h.dataset.folderHeader;
        setFolderCollapsed(list, key, k, next);
      });
      return;
    }

    setFolderCollapsed(list, key, folderKey, next);
  });



  function readItems() {
    const v = loadJSON(bulletsKey(key), []);
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object" && Array.isArray(v.items)) return v.items;
    return [];
  }
  function writeItems(items) {
    saveJSON(bulletsKey(key), items);
  }
  function currentItems() {
    return [...list.querySelectorAll('li[data-folder]')].map((li) => ({
      text: (li.querySelector('[data-role="text"]')?.textContent || "").trim(),
      folder: li.dataset.folder || ""
    }));
  }


  // submit text -> create headers and items using "item #tag/sub #tag2" syntax
  function addItemsFrom(text) {
    const parts = text.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
    const entries = parts.map(line => {
      const del = parseFolderDelete(line);
      const { text: body, folders } = parseItemAndTags(line);
      return { del, body, folders };
    });

    // propagate trailing tags to earlier items without tags
    const nonDel = entries.filter(e => !e.del);
    if (nonDel.length > 1) {
      const last = nonDel[nonDel.length - 1];
      if (last.folders.length && nonDel.slice(0, -1).every(e => e.folders.length === 0)) {
        const common = last.folders.slice();
        nonDel.slice(0, -1).forEach(e => { e.folders = common.slice(); });
      }
    }

    entries.forEach(({ del, body, folders }) => {
      if (del) {
        deleteFolderCommand(list, key, del);
        writeItems(currentItems());
        return;
      }

      const haveFolders = folders && folders.length;
      if (!body) {
        if (haveFolders) {
          folders.forEach(f => ensureFolderHeader(list, key, f));
          updateFolderCounts(list);
          snapshotDay();
          writeItems(currentItems());
        }
        return;
      }

      const t = capFirst(body);
      if (haveFolders) folders.forEach(f => addItem(t, false, f));
      else addItem(t, false, "");
    });

  }

  function addItem(text, restoring = false, folder = "") {
    const f = String(folder || "");
    ensureFolderHeader(list, key, f);

    const li = el("li", "mt-3 flex items-center gap-2 px-3");
    li.setAttribute("data-folder", f);

    const txt = el("span", "flex-1 text-accents font-bold tracking-wide text-xl font-sec");
    txt.textContent = text;
    txt.setAttribute("data-role", "text");

    const edit = el("button", "px-2 py-1 rounded-md text-accents/80 hover:text-white hover:bg-neutral transition-colors", "✎");
    edit.type = "button"; edit.title = "Edit";

    const del = el("button", "px-2 py-1 rounded-md text-red-400 hover:text-white hover:bg-neutral transition-colors", "✕");
    del.type = "button"; del.title = "Remove"; del.setAttribute("aria-label", `Remove "${text}"`);

    const handle = el("span", "ml-1 cursor-grab select-none text-accents/60", "⋮⋮");
    handle.setAttribute("data-handle", "1");
    li.draggable = true;

    edit.addEventListener("click", () => {
      if (txt.isContentEditable) return;
      const original = txt.textContent;
      txt.contentEditable = "true";
      txt.classList.add("outline-none");
      txt.focus(); placeCaretEnd(txt);

      function commit() {
        txt.textContent = (txt.textContent || "").trim();
        if (!txt.textContent) { li.remove(); updateFolderCounts(list); writeItems(currentItems()); edit.focus(); cleanup(); return; }
        txt.contentEditable = "false";
        writeItems(currentItems());
        edit.focus();
        txt.classList.remove("outline-none");
        cleanup();
      }
      function cancel() {
        txt.textContent = original; txt.contentEditable = "false"; edit.focus();
        txt.classList.remove("outline-none");
        cleanup();
      }
      function onKey(e) { if (e.key === "Enter") { e.preventDefault(); commit(); } if (e.key === "Escape") { e.preventDefault(); cancel(); } }
      function cleanup() { txt.removeEventListener("keydown", onKey); txt.removeEventListener("blur", commit); }

      txt.addEventListener("keydown", onKey);
      txt.addEventListener("blur", commit);
    });

    del.addEventListener("click", () => { li.remove(); updateFolderCounts(list); writeItems(currentItems()); });


    li.addEventListener("dragstart", (e) => {
      const t = e.target;
      if (txt.isContentEditable || t.closest("button,input,[contenteditable='true']")) { e.preventDefault(); return; }
      DRAG_SRC = li;
      li.classList.add("opacity-50");
      e.dataTransfer.effectAllowed = "move";
    });
    li.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; });
    li.addEventListener("drop", (e) => {
      e.preventDefault();
      if (!DRAG_SRC || DRAG_SRC === li) return;
      const items = [...list.children];
      const src = items.indexOf(DRAG_SRC);
      const dst = items.indexOf(li);
      if (src < dst) list.insertBefore(DRAG_SRC, li.nextSibling); else list.insertBefore(DRAG_SRC, li);
      writeItems(currentItems());
    });
    li.addEventListener("dragend", () => { li.classList.remove("opacity-50"); DRAG_SRC = null; });

    li.append(handle, txt, edit, del);

    ensureFolderHeader(list, key, f);
    const same = [...list.querySelectorAll(`li[data-folder="${f}"]`)];
    const last = same.length ? same[same.length - 1] : null;
    if (last) list.insertBefore(li, last.nextSibling);
    else {
      const header = list.querySelector(f ? `[data-folder-header="${f}"]`
        : `[data-folder-header="__none"]`);
      if (header) list.insertBefore(li, header.nextSibling);
      else list.appendChild(li);
    }

    if (!restoring) { updateFolderCounts(list); writeItems(currentItems()); }

    // honor collapsed state on add
    const st = getCardFolderState(key);
    if (st[f] === true) li.classList.add("hidden");
  }

  list.innerHTML = "";
  (readItems() || []).forEach(it =>
    addItem(typeof it === "string" ? it : (it.text || ""), true,
      typeof it === "object" ? (it.folder || "") : ""));
  updateFolderCounts(list);

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const raw = (input.value || "").trim();
    if (!raw) return;
    addItemsFrom(raw);
    input.value = "";
  });

  input.addEventListener("blur", () => { input.value = capFirst(input.value); });

  root.__addBulletItem = (text, restoring = false) => addItem(text, restoring);
}

function wireCard(root) {
  if (root.matches("[data-checklist]")) { wireChecklist(root); return; }
  if (root.matches("[data-bullets]")) { wireBullets(root); return; }
}

/* -------- Smoke toggle -------- */
function wireSmoke(container) {
  const cb = container.querySelector('input[type="checkbox"]');
  const box = container.querySelector('[data-role="box"]');
  const icon = container.querySelector('[data-role="icon"]');
  const label = container.querySelector('[data-role="label"]');
  if (!cb || !box || !icon || !label) return;

  // only inject a new SVG if the holder is NOT already an <svg>
  if (!(icon instanceof SVGElement) && !icon.querySelector('svg')) {
    const svg = svgCheck();
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('pointer-events-none');
    icon.appendChild(svg);
  }
  // ensure inline opacity can't win
  icon.style.opacity = '';

  const card = container.closest('[data-checklist][data-key]');
  const cardKey = card?.dataset.key;

  const syncSmoke = () => {
    const checked = cb.checked;
    label.classList.toggle("line-through", checked);
    icon.classList.toggle("opacity-0", !checked);
    icon.classList.toggle("opacity-100", checked);
    icon.setAttribute("aria-hidden", checked ? "false" : "true");
    box.classList.toggle("border-main", !checked);
    box.classList.toggle("border-accents", checked);
  };

  // initial paint
  syncSmoke();

  cb.addEventListener("change", () => {
    syncSmoke();
    if (cardKey) {
      const k = dayKey();
      const day = loadJSON(k, {}) || {};
      const counted = day.__smokeCounted || {};
      const wasCounted = !!counted[cardKey];
      if (cb.checked && !wasCounted) { setSmokesCount(getSmokesCountFromDOM() + 1); counted[cardKey] = true; }
      else if (!cb.checked && wasCounted) { setSmokesCount(Math.max(0, getSmokesCountFromDOM() - 1)); counted[cardKey] = false; }
      day.__smokeCounted = counted;
      saveJSON(k, day);
    }
    snapshotDay();
  });
}


/* -------- Caret UI helper (shared) -------- */
function applyCollapsedUI(key, collapsed) {
  const card =
    document.querySelector(`[data-checklist][data-key="${key}"]`) ||
    document.querySelector(`[data-bullets][data-key="${key}"]`);
  if (!card) return;

  if (collapsed) card.setAttribute("data-collapsed", "1");
  else card.removeAttribute("data-collapsed");

  // toggle main content
  const list = card.querySelector("[data-checklist-list],[data-bullets-list]");
  const form = card.querySelector("[data-checklist-form],[data-bullets-form]");
  if (list) list.classList.toggle("hidden", collapsed);
  if (form) form.classList.toggle("hidden", collapsed);

  // flip caret icon
  const icon = card.querySelector("i.collapseCardCaret");
  if (icon) {
    icon.classList.toggle("fa-caret-up", !collapsed);
    icon.classList.toggle("fa-caret-down", collapsed);
  }
}


/* -------- Clear Checked buttons: independent wiring -------- */
function wireClearButtons() {
  document.querySelectorAll("[data-clear-checked]").forEach(wireClearButton);
}

function wireClearButton(btn) {
  const card = btn.closest("[data-checklist][data-key]");
  if (!card) return;
  const list = card.querySelector("[data-checklist-list]");

  const update = () => {
    if (card.hasAttribute("data-collapsed")) { btn.classList.add("hidden"); return; }
    const anyChecked = !!list?.querySelector('input[type="checkbox"]:checked');
    btn.classList.toggle("hidden", !anyChecked);
  };

  // initial state
  update();

  // listen for checkbox changes
  if (list) {
    list.addEventListener("change", (e) => {
      if (e.target && e.target.matches('input[type="checkbox"]')) update();
    });
    // observe add/remove of items
    const mo = new MutationObserver(update);
    mo.observe(list, { childList: true, subtree: true });
  }

  // observe collapse state on the card
  const co = new MutationObserver(update);
  co.observe(card, { attributes: true, attributeFilter: ["data-collapsed"] });
}


/* -------- Carets: one place, all cards (checklist + bullets) -------- */
function wireCarets() {
  // Ensure every card has a caret and apply manual state for non-time cards.
  document.querySelectorAll("[data-checklist],[data-bullets]").forEach((card) => {
    const key = ensureCardKey(card);
    if (!TIME_KEYS.includes(key)) {
      // restore manual collapsed state on load
      applyCollapsedUI(key, isManualCollapsed(key));
    }
    // ensure a caret exists
    let icon = card.querySelector("i.collapseCardCaret");
    if (!icon) {
      const holder = el("div", "text-right");
      const btn = el("button", "");
      btn.type = "button";
      // add collapseCardCaret to the created icon
      icon = el("i", "fa-solid fa-caret-up collapseCardCaret text-neutral scale-250 hover:cursor-pointer");
      btn.appendChild(icon);
      holder.appendChild(btn);
      const header = card.querySelector(".flex.justify-between");
      if (header) header.before(holder); else card.prepend(holder);
    }
  });

  // Single delegated click handler for all carets on the page.
  document.addEventListener("click", (e) => {
    const icon = e.target.closest("i.collapseCardCaret");
    if (!icon) return;

    const card = icon.closest("[data-checklist],[data-bullets]");
    if (!card) return;

    const key = ensureCardKey(card);
    const next = !card.hasAttribute("data-collapsed");
    setManualCollapsed(key, next);
    applyCollapsedUI(key, next);
  });

}

/* -------- Restore current page from storage to DOM -------- */
function restoreAll() {
  const dayData = loadJSON(dayKey(), {});
  const sc = Number(dayData.__smokes);
  if (Number.isFinite(sc)) setSmokesCount(sc);

  // restore persisted empty-folder headers map
  const headersMap = dayData[folderHeadersKey()] || {};

  document.querySelectorAll("[data-checklist][data-key]").forEach((card) => {
    const key = card.dataset.key;
    const list = card.querySelector("[data-checklist-list]");

    // 1) restore empty headers first so items can slot under them
    (headersMap[key] || []).forEach(h => ensureFolderHeader(list, key, h));

    // 2) restore items
    const entry = dayData[key];
    if (entry?.items?.length) {
      const add = card.__addChecklistItem;
      entry.items.forEach((it) => add && add(it.text, !!it.done, true, it.folder || ""));
      if (list) updateFolderCounts(list);
    }

    // 3) restore per-card smoke toggle
    const smokeCb = card.querySelector('[data-smoke] input[type="checkbox"]');
    if (smokeCb) {
      smokeCb.checked = !!entry?.smoke;
      smokeCb.dispatchEvent(new Event("change"));
    }
  });
}


/* -------- DOM -> objects -------- */
function collectChecklistsFromDOM() {
  const data = {};
  document.querySelectorAll("[data-checklist][data-key]").forEach((card) => {
    const key = card.dataset.key;
    const items = [...card.querySelectorAll("[data-checklist-list] > li[data-folder]")].map((li) => {
      const label = li.querySelector('[data-role="label"]');
      const cb = li.querySelector('input[type="checkbox"]');
      return {
        text: (label?.textContent || "").trim(),
        done: !!(cb && cb.checked),
        folder: li.dataset.folder || ""
      };
    });

    const smokeCb = card.querySelector('[data-smoke] input[type="checkbox"]');
    data[key] = { type: "checklist", items, smoke: !!(smokeCb && smokeCb.checked) };
  });
  return data;
}
function collectBulletsFromDOM() {
  const out = {};
  document.querySelectorAll("[data-bullets][data-key]").forEach((card) => {
    const key = card.dataset.key;
    if (key === "notes") return;
    const items = [...card.querySelectorAll('[data-bullets-list] li[data-folder]')].map((li) => ({
      text: (li.querySelector('[data-role="text"]')?.textContent || "").trim(),
      folder: li.dataset.folder || ""
    }));

    out[key] = { type: "bullets", items };
  });
  return out;
}

/* -------- Snapshot helpers -------- */
// trailing debounce to reduce localStorage churn
function snapshotDayImmediate() {
  const key = dayKey();
  const prev = loadJSON(key, {}) || {};
  const next = collectChecklistsFromDOM();
  next[folderHeadersKey()] = collectFolderHeadersFromDOM();
  next.__smokes = getSmokesCountFromDOM();
  // preserve meta fields
  if (prev.__carried) next.__carried = prev.__carried;
  if (prev.__smokeCounted) next.__smokeCounted = prev.__smokeCounted;
  if (prev.__clearedDone) next.__clearedDone = prev.__clearedDone;
  saveJSON(key, next);

  saveJSON(key, next);

  // Only Today drives auto-syncs
  if (DAY_OFFSET === 0) {
    const prevHdrs = prev[folderHeadersKey()] || {};
    const nextHdrs = next[folderHeadersKey()] || {};
    const headersChanged = JSON.stringify(prevHdrs) !== JSON.stringify(nextHdrs);

    if (headersChanged) {
      // Propagate new/removed empty folder headers immediately across all cards
      syncTomorrowFromToday("all");
    } else {
      // Keep frequent edits light: carry only time-blocks
      syncTomorrowDebounced("time");
    }
  }

}


// Replace direct saves with a debounced wrapper
const snapshotDay = debounce(() => snapshotDayImmediate(), 300);


/* -------- Ensure blank tomorrow exists (today view) -------- */
function ensureEmptyDay(offset = 1) {
  const key = dayKey(offset);
  if (localStorage.getItem(key)) return;
  const empty = {};
  document.querySelectorAll("[data-checklist][data-key]").forEach((card) => {
    empty[card.dataset.key] = { type: "checklist", items: [], smoke: false };
  });
  saveJSON(key, empty);
}

/* -------- Countdown (global) -------- */
function wireCountdown(root) {
  const form = root.querySelector('[data-countdown-form]');
  const view = root.querySelector('[data-countdown-view]');
  const titleEl = root.querySelector('[data-countdown-title]');
  const display = root.querySelector('[data-countdown-display]');
  display?.setAttribute('aria-live', 'polite');
  const labelIn = root.querySelector('[data-countdown-label]');
  const whenIn = root.querySelector('[data-countdown-when]');
  const startBtn = root.querySelector('[data-countdown-start]');
  const resetBtn = root.querySelector('[data-countdown-reset]');

  if (!display || !form || !view) return;

  root.querySelectorAll('[data-open-picker]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (whenIn && typeof whenIn.showPicker === 'function') whenIn.showPicker();
      else whenIn?.focus();
    });
  });

  function readSaved() { return loadJSON(GLOBAL_COUNTDOWN_KEY, null); }
  function writeSaved(v) { saveJSON(GLOBAL_COUNTDOWN_KEY, v); }

  function showForm() { form.classList.remove('hidden'); view.classList.add('hidden'); root.classList.add('is-form'); root.classList.remove('is-view'); }
  function showView() { form.classList.add('hidden'); view.classList.remove('hidden'); root.classList.add('is-view'); root.classList.remove('is-form'); }

  function pad(n) { return String(n).padStart(2, '0'); }
  function formatDuration(ms) { let s = Math.max(0, Math.floor(ms / 1000)); const d = Math.floor(s / 86400); s -= d * 86400; const h = Math.floor(s / 3600); s -= h * 3600; const m = Math.floor(s / 60); s -= m * 60; return (d > 0 ? `${d} D ` : '') + `${pad(h)}:${pad(m)}:${pad(s)}`; }
  function toLocalDatetimeValue(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }

  function update() {
    const saved = readSaved();
    if (!saved) { showForm(); return; }
    const label = (saved.label || '').trim();
    if (label) { titleEl.textContent = label; titleEl.classList.remove('hidden'); }
    else { titleEl.textContent = ''; titleEl.classList.add('hidden'); }
    const ms = saved.target - Date.now();
    display.textContent = ms <= 0 ? 'Done!' : formatDuration(ms);
    showView();
  }

  function startTick() {
    if (root.__cdTimer) clearInterval(root.__cdTimer);
    update();
    root.__cdTimer = setInterval(update, 1000);
  }

  const saved = readSaved();
  if (saved) {
    if (labelIn) labelIn.value = saved.label || '';
    if (whenIn) whenIn.value = toLocalDatetimeValue(new Date(saved.target));
    startTick();
  } else {
    showForm();
    if (labelIn) labelIn.value = '';
    if (whenIn) whenIn.value = '';
  }

  startBtn?.addEventListener('click', () => {
    const label = (labelIn?.value || '').trim();
    const when = whenIn?.value;
    if (!when) { alert('Pick a target date & time'); return; }
    const target = new Date(when).getTime();
    writeSaved({ target, label });
    startTick();
  });

  resetBtn?.addEventListener('click', () => {
    localStorage.removeItem(GLOBAL_COUNTDOWN_KEY);
    if (root.__cdTimer) clearInterval(root.__cdTimer);
    if (labelIn) labelIn.value = '';
    if (whenIn) whenIn.value = '';
    titleEl.textContent = '';
    showForm();
  });
}

function collapsePastTimeCards() {
  if (DAY_OFFSET !== 0) return; // only on Today
  const key = dayKey(0);
  const data = loadJSON(key, {}) || {};
  const ui = (data.__ui = data.__ui || { folders: {}, cards: { manual: {}, auto: {} } });
  ui.cards.manual = ui.cards.manual || {};
  ui.cards.auto = ui.cards.auto || {};
  let moved = false;

  for (let i = 0; i < TIME_KEYS.length; i++) {
    const fromKey = TIME_KEYS[i];
    const toKey = TIME_KEYS[i + 1];
    const manual = !!ui.cards.manual[fromKey];
    const shouldCollapse = new Date().getHours() >= cardEndHour(fromKey);
    applyCollapsedUI(fromKey, shouldCollapse || manual);

    if (shouldCollapse && !ui.cards.auto[fromKey] && toKey) {
      const from = (data[fromKey]?.items) ? data[fromKey] : (data[fromKey] = { type: "checklist", items: [], smoke: false });
      const to = (data[toKey]?.items) ? data[toKey] : (data[toKey] = { type: "checklist", items: [], smoke: false });

      const carry = (from.items || []).filter((it) => !it.done);
      const keep = (from.items || []).filter((it) => it.done);

      to.items = [...carry, ...(to.items || [])];
      from.items = keep;

      ui.cards.auto[fromKey] = true;
      moved = true;
    }
  }
  if (moved) saveJSON(key, data);
}

// Stores cleared done items under day.__clearedDone[cardKey] = [text,...]
function wireClearChecked() {
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-clear-checked]");
    if (!btn) return;

    const card = btn.closest("[data-checklist][data-key]");
    const key = card?.dataset.key;
    if (!card || !key) return;

    const list = card.querySelector("[data-checklist-list]");
    if (!list) return;

    // collect checked items' labels
    const texts = [];
    [...list.querySelectorAll("li")].forEach((li) => {
      const cb = li.querySelector('input[type="checkbox"]');
      if (cb?.checked) {
        const label = li.querySelector('[data-role="label"]');
        const txt = (label?.textContent || "").trim();
        if (txt) texts.push(txt);
      }
    });

    // archive them (do this before removing from DOM)
    if (texts.length) {
      const k = dayKey(DAY_OFFSET); // why: archive on the active page's day
      const day = loadJSON(k, {}) || {};
      const arch = day.__clearedDone || {};
      arch[key] = [...(arch[key] || []), ...texts];
      day.__clearedDone = arch;
      saveJSON(k, day);
    }

    // now remove from DOM
    [...list.querySelectorAll("li")].forEach((li) => {
      const cb = li.querySelector('input[type="checkbox"]');
      if (cb?.checked) li.remove();
    });

    snapshotDay();
  });
}

// Merge archived cleared-done items into a dayObj (for JSON export only)
function mergeClearedIntoDayObj(dayObj, arch) {
  if (!arch) return dayObj;
  Object.keys(arch).forEach((key) => {
    const cleared = arch[key] || [];
    if (!cleared.length) return;
    if (!dayObj[key]) dayObj[key] = { type: "checklist", items: [], smoke: false };

    const have = new Set((dayObj[key].items || []).map((it) => _norm(it.text)));
    cleared.forEach((t) => {
      const text = typeof t === "string" ? t : (t?.text || "");
      const n = _norm(text);
      if (text && !have.has(n)) dayObj[key].items.push({ text, done: true });
    });
  });
  return dayObj;
}

async function onRestore() {
  try {
    const file = await pickFileFromRememberedDir();
    const text = await file.text();
    const data = JSON.parse(text);

    const ds = data.date || (file.name.match(/^(\d{4}-\d{2}-\d{2})-planner\.json$/)?.[1]) || ymd(getPlannerDate(DAY_OFFSET));
    const dKey = dayKeyFromDateStr(ds);

    if (data.day && typeof data.day === "object") saveJSON(dKey, data.day);
    if (data.bullets && typeof data.bullets === "object") {
      Object.keys(data.bullets).forEach((k) => {
        const entry = data.bullets[k];
        const items = Array.isArray(entry?.items) ? entry.items : [];
        saveJSON(bulletsKey(k, ds), items);
      });
    }
    if (Array.isArray(data.notes)) saveJSON(GLOBAL_NOTES_KEY, data.notes);

    const currentDS = ymd(getPlannerDate(DAY_OFFSET));
    if (ds === currentDS) location.reload();
    else alert(`Restored ${ds}. Switch to that day to view it.`);
  } catch {
    alert("Restore failed. Pick a valid planner JSON.");
  }
}

async function onEndDay() {
  if (ENDING_DAY) return;        // one-shot guard
  ENDING_DAY = true;

  snapshotDayImmediate(); // ensure latest edits are persisted

  const todayKey = dayKey(0);
  const tomorrowKey = dayKey(1);

  ensureEmptyDay(1);
  const todayData = loadJSON(todayKey, {}) || {};
  const tomorrowData = loadJSON(tomorrowKey, {}) || {};
  const carriedMeta = {};

  Object.keys(todayData || {}).forEach((key) => {
    const entry = todayData[key];
    if (entry?.type === "checklist" && Array.isArray(entry.items)) {
      const carry = entry.items.filter((it) => !it.done && _norm(it.text));
      if (!tomorrowData[key]) tomorrowData[key] = { type: "checklist", items: [], smoke: false };

      const existing = tomorrowData[key].items || [];
      const existingSet = new Set(existing.map((it) => carryKey(it)));
      const newCarry = carry.filter((it) => !existingSet.has(carryKey(it)));

      tomorrowData[key].items = [...newCarry, ...existing];
      if (newCarry.length) carriedMeta[key] = newCarry.map((it) => carryKey(it));
    }
  });

  tomorrowData.__carried = carriedMeta;
  saveJSON(tomorrowKey, tomorrowData);

  // Sequential downloads; give the browser time to dispatch each
  downloadDayViaHref(0);
  await new Promise(r => setTimeout(r, 200));
  downloadDayViaHref(1);
  await new Promise(r => setTimeout(r, 250));

  setBaseDate(getPlannerDate(1));
  setTimeout(() => { location.href = "./today.html"; }, NAV_DELAY_MS);
}




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

/* -------- Boot -------- */
document.addEventListener("DOMContentLoaded", () => {
  rebuildHeaderFromStorage();
  migrateUIState();
  document.querySelectorAll("[data-checklist],[data-bullets]").forEach(wireCard);
  document.querySelectorAll("[data-countdown]").forEach(wireCountdown);
  wireCarets();

  wireClearButtons();
  wireClearChecked();
  if (DAY_OFFSET === 1) syncTomorrowFromToday("all");
  restoreAll();
  if (DAY_OFFSET === 0) syncTomorrowFromToday("all");
  collapsePastTimeCards();
  setInterval(collapsePastTimeCards, 5 * 60 * 1000);

  if (DAY_OFFSET === 0) ensureEmptyDay(1);
  highlightCurrentBlock();
  setInterval(highlightCurrentBlock, 5 * 60 * 1000);

  document.getElementById("smokescount-plus")?.addEventListener("click", () => {
    setSmokesCount(getSmokesCountFromDOM() + 1);
    snapshotDay();
  });

  // Single handler for page-level actions only
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    e.preventDefault();
    const act = btn.dataset.action;
    if (act === "download") { snapshotDayImmediate(); downloadDayViaHref(DAY_OFFSET); }
    else if (act === "restore") onRestore();
    else if (act === "endday") onEndDay();
  });

});


