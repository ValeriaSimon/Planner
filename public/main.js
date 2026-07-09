/* main.js — consolidated */
(function () {
  "use strict";

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
const DRAWER_KEY = "planner:drawer";
function bulletsKey(key, ds = null) {
  if (!key || key === "notes") return GLOBAL_NOTES_KEY;
  const base = ds ? dayKeyFromDateStr(ds) : dayKey();
  return `${base}:bullets:${key}`;
}


/* -------- JSON helpers -------- */
const REMOTE_CACHE = new Map();
// Order-insensitive stand-in for JSON.stringify equality checks. Firestore's
// SDK does not preserve local object key insertion order when it returns
// doc.data(), so a plain JSON.stringify(a) !== JSON.stringify(b) comparison
// reports "changed" for semantically-identical objects whenever the key
// order differs — which is every single time data round-trips through
// Firestore. That false positive made restoreAll() (and this file's own
// day-doc write patching) fire on nearly every edit's own echo, discarding
// whatever the user was mid-typing/mid-toggling. Confirmed live: comparing
// a freshly-loaded local day object against the same doc re-fetched from
// Firestore produced different JSON.stringify output despite identical data.
function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}

function loadJSON(key, fallback) {
  // Clone on the way out: several call sites (writeUI, wireSmoke, wireClearChecked,
  // ...) load this object, mutate a field in place, then pass the same object to
  // saveJSON(). If we handed back the live REMOTE_CACHE reference, that in-place
  // mutation would happen before saveJSON's own "what changed since last time"
  // diff ever runs, so the diff would always see zero changes and silently skip
  // the write. Cloning keeps the cached snapshot stable until saveJSON replaces it.
  if (REMOTE_CACHE.has(key)) {
    try { return structuredClone(REMOTE_CACHE.get(key)); } catch { return REMOTE_CACHE.get(key); }
  }
  try {
    const raw = localStorage.getItem(key);
    if (raw != null) return JSON.parse(raw);
  } catch { }
  return fallback;
}
async function saveJSON(key, value) {
  const prevCached = REMOTE_CACHE.has(key) ? REMOTE_CACHE.get(key) : undefined;
  REMOTE_CACHE.set(key, value);
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { }

  const FB = window.firebaseServices;
  const u = FB?.auth?.currentUser;
  if (!FB || !u) return;

  const m = String(key).match(/^planner:(\d{4}-\d{2}-\d{2})(?::bullets:(.+))?$/);
  if (key === "planner:notes") {
    await FB.setDoc(FB.doc(FB.db, "users", u.uid, "meta", "notes"), { items: value || [] });
  } else if (key === "planner:countdown") {
    await FB.setDoc(FB.doc(FB.db, "users", u.uid, "meta", "countdown"), value || {});
  } else if (key === "planner:drawer") {
    await FB.setDoc(FB.doc(FB.db, "users", u.uid, "meta", "drawer"), { items: value || [] });
  } else if (m && m[1] && !m[2]) {
    await saveDayDocPatch(FB, u, m[1], prevCached, value);
  } else if (m && m[1] && m[2]) {
    await FB.setDoc(FB.doc(FB.db, "users", u.uid, "days", m[1], "bullets", m[2]), { items: value || [] });
  }
}

// The day doc holds many independently-owned top-level fields (each checklist
// card, __ui, __smokes, __smokeCounted, ...). Both household members share one
// Firestore account from separate devices, so a plain full-document setDoc()
// here would race: whichever device's write reaches the server last silently
// discards every field the other device touched (a collapsed folder, a
// just-toggled checkbox). Instead, patch only the top-level fields that
// actually changed since our last known snapshot, via mergeFields — which
// replaces just those fields and leaves everything else on the server alone.
// Falls back to a full write the first time (no prior snapshot to diff against).
async function saveDayDocPatch(FB, user, ds, prevObj, nextObj) {
  const prev = prevObj || {};
  const next = nextObj || {};
  const patch = {};
  const fields = [];
  Object.keys(next).forEach((k) => {
    if (stableStringify(prev[k]) !== stableStringify(next[k])) { patch[k] = next[k]; fields.push(k); }
  });
  Object.keys(prev).forEach((k) => {
    if (!(k in next)) { patch[k] = FB.deleteField(); fields.push(k); }
  });
  if (!fields.length) return;
  const ref = FB.doc(FB.db, "users", user.uid, "days", ds);
  await FB.setDoc(ref, patch, { mergeFields: fields });
}


// live-fill the cache on sign-in
// Live refresh: when the other signed-in device changes something visible on this page,
// re-render from the freshly-synced data instead of waiting for a manual reload. Guarded so
// it never yanks a list out from under an active edit or an in-progress drag.
function isSafeToRerenderNow() {
  if (DRAG_SRC) return false;
  if (ENDING_DAY) return false;
  if (document.querySelector('[contenteditable="true"]')) return false;
  // A checklist/bullets edit is still debounced and hasn't reached storage yet —
  // rebuilding from storage now would silently discard it. Wait for the flush.
  if (snapshotDay.pending) return false;
  return true;
}
let liveRefreshRetries = 0;
function attemptLiveRefresh() {
  if (!isSafeToRerenderNow()) {
    if (liveRefreshRetries++ < 10) setTimeout(attemptLiveRefresh, 1500);
    return;
  }
  liveRefreshRetries = 0;
  restoreAll();
}
const liveRefreshDebounced = debounce(attemptLiveRefresh, 250);

// "Today" is decided by planner:baseDate, which lives in localStorage per-device (read
// synchronously everywhere, so it can't be an async Firestore round-trip on every call). To
// keep both devices on the same day, it's mirrored to Firestore here: whichever device ends
// the day pushes the new value, and the other device picks it up and reloads onto it.
async function syncBaseDate(user) {
  const FB = window.firebaseServices;
  const ref = FB.doc(FB.db, "users", user.uid, "meta", "baseDate");

  function applyRemote(remoteISO) {
    if (!remoteISO || remoteISO === localStorage.getItem("planner:baseDate")) return;
    localStorage.setItem("planner:baseDate", remoteISO);
    location.reload();
  }

  const snap = await FB.getDoc(ref);
  if (snap.exists() && snap.data()?.value) {
    applyRemote(snap.data().value);
  } else {
    // nothing shared yet -- this device's current value becomes the shared starting point
    const localISO = localStorage.getItem("planner:baseDate");
    if (localISO) await FB.setDoc(ref, { value: localISO });
  }

  FB.onSnapshot(ref, d => applyRemote(d.data()?.value));
}

// Called from onEndDay() right after advancing the local baseDate, so the other device's
// syncBaseDate() listener picks up the new day.
async function pushBaseDateToRemote() {
  const FB = window.firebaseServices;
  const u = FB?.auth?.currentUser;
  if (!FB || !u) return;
  const iso = localStorage.getItem("planner:baseDate");
  if (!iso) return;
  await FB.setDoc(FB.doc(FB.db, "users", u.uid, "meta", "baseDate"), { value: iso });
}

window.startFirebaseSync = function startFirebaseSync(user) {
  const FB = window.firebaseServices;
  if (!FB || !user) return;

  // prevent duplicate listeners across re-inits
  window.__fbUnsubs?.forEach(fn => { try { fn(); } catch { } });
  window.__fbUnsubs = [];

  syncBaseDate(user);

  const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const today = fmt(getPlannerDate(0));
  const tomorrow = fmt(getPlannerDate(1));
  const daysToWatch = [today, tomorrow];
  const currentDS = ymd(getPlannerDate(DAY_OFFSET));

  daysToWatch.forEach(async ds => {
    const dayKeyStr = `planner:${ds}`;
    const isCurrentPageDay = ds === currentDS;
    const ref = FB.doc(FB.db, "users", user.uid, "days", ds);
    const snap = await FB.getDoc(ref);
    REMOTE_CACHE.set(dayKeyStr, snap.exists() ? (snap.data() || {}) : {});

    // store unsubs so repeated inits don't stack listeners
    const unsubDay = FB.onSnapshot(ref, d => {
      const next = d.exists() ? (d.data() || {}) : {};
      const changed = stableStringify(REMOTE_CACHE.get(dayKeyStr)) !== stableStringify(next);
      REMOTE_CACHE.set(dayKeyStr, next);
      if (changed && isCurrentPageDay) liveRefreshDebounced();
    });
    window.__fbUnsubs.push(unsubDay);

    const col = FB.collection(FB.db, "users", user.uid, "days", ds, "bullets");
    const unsubBullets = FB.onSnapshot(col, qs => {
      let changed = false;
      qs.forEach(docSnap => {
        const bulletsKeyStr = `planner:${ds}:bullets:${docSnap.id}`;
        const next = docSnap.data()?.items || [];
        if (stableStringify(REMOTE_CACHE.get(bulletsKeyStr)) !== stableStringify(next)) changed = true;
        REMOTE_CACHE.set(bulletsKeyStr, next);
      });
      if (changed && isCurrentPageDay) liveRefreshDebounced();
    });
    window.__fbUnsubs.push(unsubBullets);
  });

  FB.onSnapshot(FB.doc(FB.db, "users", user.uid, "meta", "notes"), d => {
    const next = d.data()?.items || [];
    const changed = stableStringify(REMOTE_CACHE.get("planner:notes")) !== stableStringify(next);
    REMOTE_CACHE.set("planner:notes", next);
    if (changed) liveRefreshDebounced();
  });
  FB.onSnapshot(FB.doc(FB.db, "users", user.uid, "meta", "countdown"),
    d => REMOTE_CACHE.set("planner:countdown", d.data() || null));
  FB.onSnapshot(FB.doc(FB.db, "users", user.uid, "meta", "drawer"), d => {
    const next = d.data()?.items || [];
    const changed = stableStringify(REMOTE_CACHE.get(DRAWER_KEY)) !== stableStringify(next);
    REMOTE_CACHE.set(DRAWER_KEY, next);
    if (changed) handleDrawerRemoteChange();
  });
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
const BULLET_KEYS = ["food", "notes"];
function readBulletsForDate(ds) {
  const out = {};
  BULLET_KEYS.forEach((key) => {
    const items = loadJSON(bulletsKey(key, ds), []);
    out[key] = { items: Array.isArray(items) ? items : [] };
  });
  return out;
}


// --- Global checklist templates ---
const TPL_KEY = "planner:templates:v1";
const readTemplates = () => loadJSON(TPL_KEY, {});
const saveTemplates = (obj) => saveJSON(TPL_KEY, obj);

// Time cards only: Save current items as a named template; Apply inserts missing
// items from a saved template; Delete removes it. (data-template-save / data-template-menu)
function wireTemplates(card) {
  const cardKey = card.dataset.key;
  if (!TIME_KEYS.includes(cardKey)) return;
  if (card.__wiredTemplates) return;
  card.__wiredTemplates = true;

  const list = card.querySelector("[data-checklist-list]");
  const saveBtn = card.querySelector("[data-template-save]");
  const menuBtn = card.querySelector("[data-template-menu]");
  if (!list) return;

  function currentTexts() {
    return [...list.querySelectorAll("li[data-folder] [data-role='label']")]
      .map((n) => (n.textContent || "").trim())
      .filter(Boolean);
  }

  saveBtn?.addEventListener("click", () => {
    const name = (prompt("Save this list as a template named:") || "").trim();
    if (!name) return;
    const items = currentTexts();
    if (!items.length) { alert("Nothing to save yet."); return; }
    const all = readTemplates();
    all[name] = items;
    saveTemplates(all);
  });

  let menu = null;
  function onDocClick(e) {
    if (menu && !menu.contains(e.target) && e.target !== menuBtn && !menuBtn?.contains(e.target)) closeMenu();
  }
  function closeMenu() {
    menu?.remove();
    menu = null;
    document.removeEventListener("click", onDocClick);
  }

  function applyTemplate(name) {
    const items = readTemplates()[name] || [];
    const existing = new Set(currentTexts().map(_norm));
    const add = card.__addChecklistItem;
    items.forEach((text) => { if (!existing.has(_norm(text))) add && add(capFirst(text), false, false, ""); });
  }

  function deleteTemplate(name) {
    const all = readTemplates();
    delete all[name];
    saveTemplates(all);
  }

  function openMenu() {
    closeMenu();
    const names = Object.keys(readTemplates());
    menu = el("div", "absolute right-0 mt-2 bg-white rounded-lg shadow-xl z-20 min-w-[10rem] py-1 text-left");

    if (!names.length) {
      menu.append(el("div", "px-3 py-2 text-sm text-neutral/60 whitespace-nowrap", "No templates yet"));
    } else {
      names.forEach((name) => {
        const row = el("div", "flex items-center justify-between gap-3 px-3 py-2 hover:bg-neutral/10 whitespace-nowrap");
        const applyBtn = el("button", "text-left flex-1 text-neutral font-sec", name);
        applyBtn.type = "button";
        applyBtn.title = `Apply "${name}"`;
        const delBtn = el("button", "text-red-400 hover:text-red-600", "✕");
        delBtn.type = "button";
        delBtn.title = `Delete "${name}"`;
        applyBtn.addEventListener("click", () => { applyTemplate(name); closeMenu(); });
        delBtn.addEventListener("click", (e) => { e.stopPropagation(); deleteTemplate(name); openMenu(); });
        row.append(applyBtn, delBtn);
        menu.appendChild(row);
      });
    }

    const anchor = menuBtn.parentElement;
    anchor.style.position = "relative";
    anchor.appendChild(menu);
    document.addEventListener("click", onDocClick);
  }

  menuBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (menu) closeMenu(); else openMenu();
  });
}


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
const FS_KEYS = { OPEN_START: "planner:lastOpenStartIn", ARCHIVE_ROOT: "planner:archiveRootDir" };


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
      drawer: readDrawer(),
    },
  };
}

/* -------- Archive folder (File System Access API, Chromium-only) -------- */
// One-time picked root dir (e.g. "D:\Planner Archive"); End Day writes into <root>/<MonthYear>/.
function monthYearFolderName(d = new Date()) {
  return `${d.toLocaleString("en-US", { month: "long" })}${d.getFullYear()}`;
}

async function getArchiveRootHandle() {
  if (!window.showDirectoryPicker) return null;
  try {
    const handle = await idb.get(FS_KEYS.ARCHIVE_ROOT);
    if (!handle?.queryPermission) return null;
    let perm = await handle.queryPermission({ mode: "readwrite" });
    if (perm === "prompt") perm = await handle.requestPermission({ mode: "readwrite" });
    return perm === "granted" ? handle : null;
  } catch {
    return null;
  }
}

async function setArchiveRootHandle() {
  if (!window.showDirectoryPicker) {
    alert("Your browser doesn't support picking a folder for auto-export (Chrome/Edge only).");
    return;
  }
  try {
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    await idb.put(FS_KEYS.ARCHIVE_ROOT, handle);
    alert(`Archive folder set to "${handle.name}". End Day will now save here automatically.`);
  } catch {
    // user cancelled the picker; nothing to do
  }
}

async function writeJSONToArchive(rootHandle, filename, payload) {
  const monthDir = await rootHandle.getDirectoryHandle(monthYearFolderName(), { create: true });
  const fileHandle = await monthDir.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(JSON.stringify(payload, null, 2));
  await writable.close();
}

// Export a day into the archive folder; falls back to the normal blob download on any failure.
async function archiveDay(rootHandle, offset) {
  const { filename, payload } = buildExport(offset);
  try {
    await writeJSONToArchive(rootHandle, filename, payload);
  } catch (err) {
    console.warn("Archive write failed, falling back to download:", err);
    saveViaHref(filename, payload);
  }
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
const ALLOWED_CHARS = /[^a-z0-9 _\-\/']/gi;  // allow letters, digits, space, _ - / '
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
  const m = String(line || "").trim().match(/^-\s*([a-z0-9 _\-\/']+)\s*$/i);
  return m ? m[1].toLowerCase() : null;
}

// Split a submitted line/comma/newline blob into { del, text, folders } entries.
// If only the last entry carries tags, those tags apply to all the untagged entries before it.
function parseMultilineEntries(raw, { isTimeCard = false } = {}) {
  const parts = String(raw || "").split(/[\n;]+/).map(s => s.trim()).filter(Boolean);
  const entries = parts.map(line => {
    const del = parseFolderDelete(line);
    const { text, folders } = parseItemAndTags(line, { isTimeCard });
    return { line, del, text, folders };
  });

  if (!isTimeCard) {
    const nonDel = entries.filter(e => !e.del);
    if (nonDel.length > 1) {
      const last = nonDel[nonDel.length - 1];
      if ((last.folders?.length || 0) && nonDel.slice(0, -1).every(e => (e.folders?.length || 0) === 0)) {
        const common = last.folders.slice();
        nonDel.slice(0, -1).forEach(e => { e.folders = common.slice(); });
      }
    }
  }
  return entries;
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

// Non-time checklist cards only: sink checked items to the bottom of their own
// folder group, float unchecked ones back above the first checked item in that group.
function moveItemByCheckedState(li, cardKey, list) {
  if (TIME_KEYS.includes(cardKey)) return;
  const folder = li.dataset.folder || "";
  const mates = [...list.querySelectorAll(`li[data-folder="${folder}"]`)].filter((n) => n !== li);
  const checked = !!li.querySelector('input[type="checkbox"]')?.checked;

  if (checked) {
    const last = mates.length ? mates[mates.length - 1] : null;
    if (last) list.insertBefore(li, last.nextSibling);
  } else {
    const firstCheckedMate = mates.find((n) => n.querySelector('input[type="checkbox"]')?.checked);
    if (firstCheckedMate) {
      list.insertBefore(li, firstCheckedMate);
    } else {
      const last = mates.length ? mates[mates.length - 1] : null;
      if (last) list.insertBefore(li, last.nextSibling);
    }
  }
}

// Ensure a folder header exists (skipped for time cards, which have no folders/headers),
// then place `li` after the last other item already in that folder group, or after the
// header if the group was otherwise empty, or at the end of the list as a last resort.
// Always excludes `li` itself from the "last match" search, so this is safe whether `li` is
// a brand-new node not yet in `list`, or an existing node already inside it (being moved).
function insertIntoFolderGroup(list, li, folderKey, cardKey) {
  const isTimeCard = TIME_KEYS.includes(cardKey);
  if (!isTimeCard) ensureFolderHeader(list, cardKey, folderKey);

  const mates = [...list.querySelectorAll(`li[data-folder="${folderKey}"]`)].filter((n) => n !== li);
  const last = mates.length ? mates[mates.length - 1] : null;
  if (last) { list.insertBefore(li, last.nextSibling); return; }

  if (!isTimeCard) {
    const header = list.querySelector(folderKey ? `[data-folder-header="${folderKey}"]` : `[data-folder-header="__none"]`);
    if (header) { list.insertBefore(li, header.nextSibling); return; }
  }

  list.appendChild(li);
}

function moveItemToFolder(li, destKey, cardKey, list, onSave = snapshotDay) {
  const label = li.querySelector('[data-role="label"]');
  const norm = _norm((label?.textContent || "").trim());
  if (li.dataset.folder === destKey) return;

  // dedupe: if same text already in destination, drop the moved one
  if (findDupInFolder(list, destKey, norm)) {
    li.remove();
    updateFolderCounts(list);
    onSave();
    return;
  }

  li.dataset.folder = destKey;
  insertIntoFolderGroup(list, li, destKey, cardKey);

  updateFolderCounts(list);
  onSave();
}

function deleteFolderCommand(list, cardKey, rawPath, onSave = snapshotDay) {
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
    header.remove(); updateFolderCounts(list); onSave(); return;
  }

  // move items to Unfiled (creating header only if needed), then remove header
  const items = [...list.querySelectorAll(`li[data-folder="${path}"]`)];
  if (items.length) ensureUnfiledHeaderIfNeeded(list, cardKey);
  items.forEach(li => moveItemToFolder(li, UNFILED_KEY, cardKey, list, () => {})); // final onSave below persists once
  header.remove();
  updateFolderCounts(list);
  onSave();
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


// Sync tomorrow from today. Time-block cards (morning/daytime/evening) never carry over.
function syncTomorrowFromToday() {
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


  const keys = Object.keys(todayData).filter((k) => !TIME_KEYS.includes(k));

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
  let t;
  const wrapped = (...a) => {
    clearTimeout(t);
    wrapped.pending = true;
    t = setTimeout(() => { wrapped.pending = false; fn(...a); }, ms);
  };
  wrapped.pending = false;
  return wrapped;
}
const syncTomorrowDebounced = debounce(() => syncTomorrowFromToday(), 200);



function getSmokesCountFromDOM() {
  const countEl = document.getElementById("smokescount");
  const n = parseInt(countEl?.textContent || "0", 10);
  return Number.isFinite(n) ? n : 0;
}
function setSmokesCount(n) {
  const countEl = document.getElementById("smokescount");
  if (countEl) countEl.textContent = String(n);
}

/* -------- Greeting + titles -------- */
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

/* -------- Shared row behavior (checklist items + bullets share these) -------- */

// Drag-to-reorder within a list, and drag-across-folder-headers to re-file.
// Identical for checklist and bullet rows; only the post-move save differs.
function wireRowDragReorder(li, labelEl, list, { itemId, isTimeCard = false, onMoved }) {
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
    if (src < dst) list.insertBefore(DRAG_SRC, li.nextSibling); else list.insertBefore(DRAG_SRC, li);

    // compute new folder by scanning previous headers
    let p = DRAG_SRC.previousElementSibling; let newKey = "";
    while (p) {
      if (p.hasAttribute("data-folder-header")) { newKey = (p.dataset.folderHeader === "__none") ? "" : p.dataset.folderHeader; break; }
      p = p.previousElementSibling;
    }
    DRAG_SRC.setAttribute("data-folder", isTimeCard ? "" : newKey);
    onMoved();
  });
  li.addEventListener("dragend", () => { li.classList.remove("opacity-50"); DRAG_SRC = null; });
}

// Click-to-edit commit/cancel/keydown, shared by checklist and bullet rows. Commit re-parses
// "#folder" tags out of the edited text and reroutes via moveItemToFolder when they change.
// onEditStart/onEditEnd let checklist rows disable their checkbox + label `for` while editing;
// bullets (no checkbox) simply omit them.
// Card/list/isTimeCard are resolved fresh from the DOM at commit time rather than passed in:
// the row may have been dragged into a different card since it was wired (e.g. Beba -> Morning).
function wireRowInlineEdit(li, labelEl, edit, { onEditStart, onEditEnd, save, moveOnSave }) {
  edit.addEventListener("click", () => {
    if (labelEl.isContentEditable) return;
    const original = labelEl.textContent;
    labelEl.contentEditable = "true";
    labelEl.classList.add("outline-none");
    onEditStart?.();
    labelEl.focus(); placeCaretEnd(labelEl);

    function commit() {
      labelEl.textContent = (labelEl.textContent || "").trim();
      if (!labelEl.textContent) { li.remove(); save(false); edit.focus(); cleanup(); return; }

      const curCard = li.closest("[data-checklist],[data-bullets]");
      const curCardKey = curCard?.dataset.key || "";
      const curList = li.closest("[data-checklist-list],[data-bullets-list]");
      const curIsTimeCard = TIME_KEYS.includes(curCardKey);

      const parsed = parseItemAndTags(labelEl.textContent, { isTimeCard: curIsTimeCard });
      labelEl.textContent = capFirst(parsed.text || "");
      // Only reroute when a folder tag is explicitly present; otherwise keep existing folder
      if (!curIsTimeCard && curList && parsed.folders && parsed.folders.length) {
        const dest = parsed.folders[0];
        if (String(li.dataset.folder || "") !== String(dest)) {
          moveItemToFolder(li, dest, curCardKey, curList, moveOnSave);
        }
      }
      labelEl.contentEditable = "false";
      onEditEnd?.();
      save(false);
      edit.focus();
      labelEl.classList.remove("outline-none");
      cleanup();
    }
    function cancel() {
      labelEl.textContent = original;
      labelEl.contentEditable = "false";
      onEditEnd?.();
      edit.focus();
      labelEl.classList.remove("outline-none");
      cleanup();
    }
    function onKey(e) { if (e.key === "Enter") { e.preventDefault(); commit(); } if (e.key === "Escape") { e.preventDefault(); cancel(); } }
    function cleanup() { labelEl.removeEventListener("keydown", onKey); labelEl.removeEventListener("blur", commit); }
    labelEl.addEventListener("keydown", onKey);
    labelEl.addEventListener("blur", commit);
  });
}

// Shared "process a submitted add-form blob" flow for checklist and bullets: splits into
// entries, handles "-folder" deletes and folder-only (no text) lines, dedupes against
// existing items per destination folder, and fans an item out across multiple tags.
// `addItem(text, folder)` is a 2-arg adapter each caller provides over its own addItem shape.
function processEntries(raw, { list, cardKey, isTimeCard = false, addItem, save, deleteOnSave }) {
  const entries = parseMultilineEntries(raw, { isTimeCard });

  entries.forEach(({ del, text, folders }) => {
    if (isTimeCard) { if (text) addItem(capFirst(text), ""); return; }
    if (del) { deleteFolderCommand(list, cardKey, del, deleteOnSave); return; }

    const haveFolders = folders && folders.length;
    if (!text) {
      if (haveFolders) { folders.forEach(f => ensureFolderHeader(list, cardKey, f)); save(false); }
      return;
    }

    const norm = _norm(capFirst(text));
    if (haveFolders) {
      folders.forEach(f => { if (!findDupInFolder(list, f, norm)) addItem(capFirst(text), f); });
    } else {
      if (!findDupInFolder(list, "", norm)) addItem(capFirst(text), "");
    }
  });
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

  function syncCountsAndSave(immediate = false) {
    updateFolderCounts(list);
    if (immediate) snapshotDayImmediate(); else snapshotDay();
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

    cb.addEventListener("change", () => {
      syncTick();
      // Re-resolve card/list from the DOM rather than the closure: the row may have been
      // dragged into a different card since it was created (e.g. Beba -> Morning), and the
      // closure's own `cardKey`/`list`/`isTimeCard` would otherwise still point at its origin.
      const curCard = li.closest("[data-checklist][data-key]");
      const curCardKey = curCard?.dataset.key ?? cardKey;
      const curList = li.closest("[data-checklist-list]") ?? list;
      const curIsTimeCard = TIME_KEYS.includes(curCardKey);
      if (!curIsTimeCard) {
        li.classList.toggle("opacity-30", cb.checked);
        moveItemByCheckedState(li, curCardKey, curList);
      }
      if (!suppressSave) snapshotDay();
    });

    wireRowInlineEdit(li, labelEl, edit, {
      onEditStart: () => { row.removeAttribute("for"); cb.disabled = true; },
      onEditEnd: () => { row.setAttribute("for", itemId); cb.disabled = false; },
      save: syncCountsAndSave,
    });

    del.addEventListener("click", () => { li.remove(); syncCountsAndSave(false); });

    wireRowDragReorder(li, labelEl, list, { itemId, isTimeCard, onMoved: () => syncCountsAndSave(false) });

    row.append(cb, boxWrap, labelEl);
    li.append(handle, row, edit, del);

    insertIntoFolderGroup(list, li, f, cardKey);

    suppressSave = true;
    cb.checked = !!done; syncTick();
    if (!isTimeCard) {
      li.classList.toggle("opacity-30", cb.checked);
      moveItemByCheckedState(li, cardKey, list);
    }
    suppressSave = false;

    if (!restoring) syncCountsAndSave(false);

    const st = getCardFolderState(cardKey);
    if (!isTimeCard && st[f] === true) li.classList.add("hidden");
  }

  root.__addChecklistItem = (text, done = false, restoring = false, folder = "") => addItem(text, done, restoring, folder);

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const raw = (input.value || "").trim();
    if (!raw) return;

    processEntries(raw, {
      list, cardKey, isTimeCard: TIME_KEYS.includes(cardKey),
      addItem: (text, folder) => addItem(text, false, false, folder),
      save: syncCountsAndSave,
    });
    input.value = "";
  });

  input.addEventListener("blur", () => { input.value = capFirst(input.value); });

  list.addEventListener("click", (e) => {
    const header = e.target.closest('li[data-folder-header]');
    if (!header) return;
    const caretIcon = e.target.closest('i.collapseFolderCaret');
    const folderKey = header.dataset.folderHeader === "__none" ? "" : header.dataset.folderHeader;
    const next = !header.hasAttribute("data-collapsed");
    if (caretIcon && (e.altKey || e.metaKey)) {
      list.querySelectorAll('li[data-folder-header]').forEach(h => {
        const k = h.dataset.folderHeader === "__none" ? "" : h.dataset.folderHeader;
        setFolderCollapsed(list, cardKey, k, next);
      });
      return;
    }
    setFolderCollapsed(list, cardKey, folderKey, next);
  });

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
  let id = 0;

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

  function writeItems(items) {
    saveJSON(bulletsKey(key), items);
  }
  function currentItems() {
    return [...list.querySelectorAll('li[data-folder]')].map((li) => ({
      text: (li.querySelector('[data-role="label"]')?.textContent || "").trim(),
      folder: li.dataset.folder || ""
    }));
  }
  const persistDebounced = debounce(() => writeItems(currentItems()), 300);
  function persist(immediate = false) {
    updateFolderCounts(list);
    if (immediate) writeItems(currentItems()); else persistDebounced();
  }

  function addItem(text, restoring = false, folder = "") {
    const f = String(folder || "");
    const li = el("li", "mt-3 flex items-center gap-2 px-3");
    li.setAttribute("data-folder", f);
    li.draggable = true;

    const handle = el("span", "ml-1 cursor-grab select-none text-accents/60", "⋮⋮");
    handle.setAttribute("data-handle", "1");

    const labelEl = el("span", "flex-1 text-accents font-bold tracking-wide text-xl font-sec");
    labelEl.textContent = text;
    labelEl.setAttribute("data-role", "label");

    const itemId = `bl-${key}-${id++}`;

    const edit = el("button", "px-2 py-1 rounded-md text-accents/80 hover:text-white hover:bg-neutral transition-colors", "✎");
    edit.type = "button"; edit.title = "Edit";

    const del = el("button", "px-2 py-1 rounded-md text-red-400 hover:text-white hover:bg-neutral transition-colors", "✕");
    del.type = "button"; del.title = `Remove "${text}"`;

    wireRowInlineEdit(li, labelEl, edit, {
      save: persist,
      moveOnSave: () => persist(false),
    });

    del.addEventListener("click", () => { li.remove(); persist(false); });

    wireRowDragReorder(li, labelEl, list, { itemId, onMoved: () => persist(false) });

    li.append(handle, labelEl, edit, del);

    insertIntoFolderGroup(list, li, f, key);

    if (!restoring) persist(false);

    const st = getCardFolderState(key);
    if (st[f] === true) li.classList.add("hidden");
  }

  // submit text -> create headers and items using "item #tag/sub #tag2" syntax
  function addItemsFrom(raw) {
    processEntries(raw, {
      list, cardKey: key,
      addItem: (text, folder) => addItem(text, false, folder),
      save: persist,
      deleteOnSave: () => persist(false),
    });
  }

  list.innerHTML = "";
  updateFolderCounts(list);

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const raw = (input.value || "").trim();
    if (!raw) return;
    addItemsFrom(raw);
    input.value = "";
  });

  input.addEventListener("blur", () => { input.value = capFirst(input.value); });

  root.__addBulletItem = (text, restoring = false, folder = "") => addItem(text, restoring, folder);
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

  // Rebuild the smoke-counted dedup map from the current smoke flags before
  // the per-card loop below dispatches "change" on each smoke checkbox.
  // Otherwise wireSmoke's handler treats already-counted cards as uncounted
  // (e.g. a restored backup with no/stale __smokeCounted) and re-increments
  // the counter we just set from __smokes above.
  //
  // Only persist when it actually differs from what's stored: restoreAll()
  // runs on every live-refresh (i.e. on nearly every edit's own Firestore
  // echo), so an unconditional save here would turn a read-only render pass
  // into a constant stream of full-document writes racing against whatever
  // the user is doing at that moment (e.g. stomping a just-toggled checkbox
  // or a just-collapsed folder a moment later).
  const smokeCounted = {};
  Object.keys(dayData).forEach((k) => {
    if (dayData[k] && typeof dayData[k].smoke === "boolean") smokeCounted[k] = dayData[k].smoke;
  });
  if (stableStringify(dayData.__smokeCounted || {}) !== stableStringify(smokeCounted)) {
    dayData.__smokeCounted = smokeCounted;
    saveJSON(dayKey(), dayData);
  }

  // restore persisted empty-folder headers map
  const headersMap = dayData[folderHeadersKey()] || {};

  document.querySelectorAll("[data-checklist][data-key]").forEach((card) => {
    const key = card.dataset.key;
    const list = card.querySelector("[data-checklist-list]");

    // CLEAR existing items to avoid duplicates on repeated restores
    if (list) list.innerHTML = "";

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

  document.querySelectorAll("[data-bullets][data-key]").forEach((card) => {
    const key = card.dataset.key;
    const list = card.querySelector("[data-bullets-list]");
    if (list) list.innerHTML = "";

    const items = loadJSON(bulletsKey(key), []);
    const add = card.__addBulletItem;
    (Array.isArray(items) ? items : []).forEach((it) => add && add(it.text, true, it.folder || ""));
    if (list) updateFolderCounts(list);
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
  const data = {};
  document.querySelectorAll("[data-bullets][data-key]").forEach((card) => {
    const key = card.dataset.key;
    const items = [...card.querySelectorAll("[data-bullets-list] > li[data-folder]")].map((li) => ({
      text: (li.querySelector('[data-role="label"]')?.textContent || "").trim(),
      folder: li.dataset.folder || ""
    }));
    data[key] = { items };
  });
  return data;
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
  if (prev[UI_STATE_KEY]) next[UI_STATE_KEY] = prev[UI_STATE_KEY];
  saveJSON(key, next);

  // Only Today drives auto-syncs
  if (DAY_OFFSET === 0) syncTomorrowDebounced();
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

/* -------- Drawer (global backlog: stash now, land on a target date) -------- */
function readDrawer() { return loadJSON(DRAWER_KEY, []); }
function writeDrawer(items) { saveJSON(DRAWER_KEY, items); }
function drawerId() { return `drw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`; }

// Reserved tags (#am/#mid/#pm) plus every non-time card's own key/title become aliases for
// its data-key. Time cards are ONLY reachable via the reserved am/mid/pm tags, never their
// literal key, since a drawer item has no "current card" context to infer a folder tag from.
function buildCardAliasMap() {
  const map = new Map([["am", "morning"], ["mid", "daytime"], ["pm", "evening"]]);
  document.querySelectorAll("[data-checklist][data-key],[data-bullets][data-key]").forEach(card => {
    const key = card.dataset.key;
    if (!key || TIME_KEYS.includes(key)) return;
    map.set(normalizeFolderPath(key), key);
    const titleText = (card.querySelector("h3")?.firstChild?.textContent || "").trim();
    const slug = normalizeFolderPath(titleText);
    if (slug) map.set(slug, key);
  });
  return map;
}

// The first tag that resolves via the alias map becomes the destination card; if that card
// supports folders, the next tag (if any) becomes the sub-folder. Anything beyond is ignored.
function resolveDrawerTarget(raw, aliasMap) {
  const { text, folders } = parseItemAndTags(raw, { isTimeCard: false });
  let cardKey = null, folder = "";
  for (const tag of folders) {
    if (!cardKey) {
      const resolved = aliasMap.get(tag);
      if (resolved) { cardKey = resolved; continue; }
    } else if (!TIME_KEYS.includes(cardKey) && !folder) {
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
// Loop until strictly past the landing date: no matter how many cycles were missed, a
// recurring item lands once per catch-up and jumps straight to its next future occurrence.
function fastForwardTargetDate(targetDate, repeat, ds) {
  let next = targetDate, guard = 0;
  while (next <= ds && guard++ < 10000) next = advanceDateOnce(next, repeat);
  return next;
}

function isBulletsCardKey(cardKey) {
  return !!document.querySelector(`[data-bullets][data-key="${cardKey}"]`);
}

// Drawer is only ever surfaced on today.html, so the target card is always already rendered.
// Appends via the card's exposed add-item hook (goes through the normal save/debounce path).
// Returns false if the card isn't found, e.g. a stale cardKey from a past HTML edit.
function landItem(item) {
  const isBullets = isBulletsCardKey(item.cardKey);
  const sel = isBullets ? `[data-bullets][data-key="${item.cardKey}"]` : `[data-checklist][data-key="${item.cardKey}"]`;
  const card = document.querySelector(sel);
  if (isBullets && card?.__addBulletItem) { card.__addBulletItem(item.text, false, item.folder); return true; }
  if (!isBullets && card?.__addChecklistItem) { card.__addChecklistItem(item.text, false, false, item.folder); return true; }
  return false;
}

// On-or-before catch-up: an item lands the first time today's date reaches or passes its
// target date. Non-recurring items are dropped from the drawer once landed; recurring items
// stay, with targetDate fast-forwarded past `ds`. Items whose card can't be found (landItem
// returns false) are left in the drawer to retry on the next load, rather than silently lost.
function processDrawerForDate(ds) {
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

function refreshDrawerBadge() {
  const n = readDrawer().length;
  document.querySelectorAll("[data-drawer-badge]").forEach(b => { b.textContent = String(n); });
}

// Live-sync the drawer badge/list when the partner's device changes it remotely.
function handleDrawerRemoteChange() {
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

function wireDrawerModal() {
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
    processDrawerForDate(ymd(getPlannerDate(DAY_OFFSET)));
    renderDrawerList(list);
    refreshDrawerBadge();
  });

  document.querySelectorAll("[data-drawer-open-list]").forEach(trigger => {
    trigger.addEventListener("click", openOverlay);
  });

  refreshDrawerBadge();
}

function collapsePastTimeCards() {
  if (DAY_OFFSET !== 0) return; // only on Today
  const manual = getManualMap();
  TIME_KEYS.forEach((key) => {
    const shouldCollapse = new Date().getHours() >= cardEndHour(key);
    applyCollapsedUI(key, shouldCollapse || !!manual[key]);
  });
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

    updateFolderCounts(list);
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

    const tasks = [];
    if (data.day && typeof data.day === "object") tasks.push(saveJSON(dKey, data.day));

    if (data.bullets && typeof data.bullets === "object") {
      Object.keys(data.bullets).forEach((k) => {
        const entry = data.bullets[k];
        const items = Array.isArray(entry?.items) ? entry.items : [];
        tasks.push(saveJSON(bulletsKey(k, ds), items));
      });
    }

    if (Array.isArray(data.notes)) tasks.push(saveJSON(GLOBAL_NOTES_KEY, data.notes));

    await Promise.all(tasks);

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
    if (TIME_KEYS.includes(key)) return; // time cards never carry over
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

  const archiveRoot = await getArchiveRootHandle();
  if (archiveRoot) {
    await archiveDay(archiveRoot, 0);
    await archiveDay(archiveRoot, 1);
  } else {
    // Sequential downloads; give the browser time to dispatch each
    downloadDayViaHref(0);
    await new Promise(r => setTimeout(r, 200));
    downloadDayViaHref(1);
    await new Promise(r => setTimeout(r, 250));
  }

  setBaseDate(getPlannerDate(1));
  await pushBaseDateToRemote();
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
  document.querySelectorAll("[data-checklist][data-key]").forEach(wireTemplates);
  document.querySelectorAll("[data-countdown]").forEach(wireCountdown);
  wireCarets();

  wireClearButtons();
  wireClearChecked();
  if (DAY_OFFSET === 1) syncTomorrowFromToday();
  restoreAll();
  if (DAY_OFFSET === 0) syncTomorrowFromToday();

  // Drawer only lives on today.html: it's a today-only backlog, never surfaced on tomorrow.html.
  if (DAY_OFFSET === 0) {
    wireDrawerModal();
    processDrawerForDate(ymd(getPlannerDate(0)));
    refreshDrawerBadge();
  }

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
    else if (act === "set-archive-folder") setArchiveRootHandle();
  });

});

})();


