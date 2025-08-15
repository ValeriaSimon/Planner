/* main.js — consolidated */

/* -------- Day offset from HTML -------- */
function getPageOffset() {
  const raw = Number(document.body?.dataset?.dayOffset ?? 0);
  return Number.isFinite(raw) ? raw : 0;
}
const DAY_OFFSET = getPageOffset();

/* -------- Date helpers -------- */
const pad2 = (n) => String(n).padStart(2, "0");
function ymd(d) {
  const y = d.getFullYear();
  const m = pad2(d.getMonth() + 1);
  const day = pad2(d.getDate());
  return `${y}-${m}-${day}`;
}
const weekday3 = (i) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][i];
const daysLong = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const monthsShort = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthsLong = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
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
function bulletsStorageKeyFor(key) { if (!key || key === "notes") return GLOBAL_NOTES_KEY; return `${dayKey()}:bullets:${key}`; }
function bulletsStorageKeyForDate(ds, key) { if (!key || key === "notes") return GLOBAL_NOTES_KEY; return `${dayKeyFromDateStr(ds)}:bullets:${key}`; }

/* -------- JSON helpers -------- */
function loadJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) ?? JSON.stringify(fallback)); }
  catch { return fallback; }
}
function saveJSON(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}
// --- Global checklist templates ---
const TPL_KEY = "planner:templates:v1";
const readTemplates = () => loadJSON(TPL_KEY, {});
const saveTemplates = (obj) => saveJSON(TPL_KEY, obj);


const _norm = (s) => (s || "").trim().toLowerCase();

/* -------- File System Access + IndexedDB handle storage -------- */
const hasFS = !!(window.showDirectoryPicker || window.showSaveFilePicker);
const FS_DB = "plannerFS";
const FS_STORE = "handles";
const FS_KEYS = { DIR: "downloadDirHandle" };

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

async function ensureDirHandle() {
  if (!hasFS || !window.showDirectoryPicker) return null;
  let handle = await idb.get(FS_KEYS.DIR);
  try {
    if (handle) {
      const p = await handle.queryPermission({ mode: "readwrite" });
      if (p === "granted") return handle;
      const req = await handle.requestPermission({ mode: "readwrite" });
      if (req === "granted") return handle;
    }
  } catch { }
  try {
    handle = await window.showDirectoryPicker();
    const perm = await handle.requestPermission({ mode: "readwrite" });
    if (perm === "granted") {
      await idb.put(FS_KEYS.DIR, handle);
      return handle;
    }
  } catch { }
  return null;
}
async function writeJSONToDir(dirHandle, filename, obj) {
  try {
    const fh = await dirHandle.getFileHandle(filename, { create: true });
    const w = await fh.createWritable();
    await w.write(JSON.stringify(obj, null, 2));
    await w.close();
    return true;
  } catch { return false; }
}
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
    bullets = {};
    const prefix = `${dayKeyFromDateStr(ds)}:bullets:`;
    Object.keys(localStorage).forEach((k) => {
      if (k.startsWith(prefix)) {
        const listKey = k.slice(prefix.length);
        bullets[listKey] = { type: "bullets", items: loadJSON(k, []) };
      }
    });
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

async function downloadJSON(filename, obj) {
  const dir = await ensureDirHandle();
  if (dir) {
    const ok = await writeJSONToDir(dir, filename, obj);
    if (!ok) saveViaHref(filename, obj);
  } else {
    saveViaHref(filename, obj);
  }
}
async function pickFileFromRememberedDir() {
  let opts = {
    types: [{ description: "Planner JSON", accept: { "application/json": [".json"] } }],
    multiple: false,
  };
  const dir = await idb.get(FS_KEYS.DIR);
  if (dir && window.showOpenFilePicker) {
    try { opts.startIn = dir; } catch { }
  }
  if (window.showOpenFilePicker) {
    const [h] = await window.showOpenFilePicker(opts);
    return await h.getFile();
  }
  // Fallback
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

/* --- time-card collapse helpers --- */
const TIME_KEYS = ["morning", "daytime", "evening"];
const DEFAULT_END = { morning: 14, daytime: 18, evening: 22 };
const COLLAPSE_SCALE = 0.6;

function cardEndHour(key) {
  const v = getCardBoundary(key, "end");
  return Number.isFinite(v) ? v : DEFAULT_END[key] ?? 24;
}

function renderCardFromStorage(key) {
  const card = document.querySelector(`[data-checklist][data-key="${key}"]`);
  if (!card) return;
  const list = card.querySelector("[data-checklist-list]");
  if (!list) return;
  list.innerHTML = "";
  const dayData = loadJSON(dayKey(), {});
  const entry = dayData[key];
  if (entry?.items?.length) {
    const add = card.__addChecklistItem;
    entry.items.forEach((it) => add && add(it.text, !!it.done, true));
  }
  const smokeCb = card.querySelector('[data-smoke] input[type="checkbox"]');
  if (smokeCb) {
    smokeCb.checked = !!entry?.smoke;
    smokeCb.dispatchEvent(new Event("change"));
  }
}

function applyCollapsedUI(key, collapsed) {
  const card = document.querySelector(`[data-checklist][data-key="${key}"]`);
  if (!card) return;
  const list = card.querySelector("[data-checklist-list]");
  const form = card.querySelector("[data-checklist-form]");
  const smoke = card.querySelector("[data-smoke]");

  if (collapsed) {
    list?.classList.add("hidden");
    form?.classList.add("hidden");
    smoke?.classList.add("hidden");
    card.setAttribute("data-collapsed", "1");
    // visual collapse: keep colors, just scale
    card.style.transformOrigin = "top left";
    card.style.transform = `scale(${COLLAPSE_SCALE})`;
    card.style.transition = "transform 200ms ease";
  } else {
    list?.classList.remove("hidden");
    form?.classList.remove("hidden");
    smoke?.classList.remove("hidden");
    card.removeAttribute("data-collapsed");
    card.style.transform = "";
  }
}

function refreshTomorrowPreviewAfterTodayChange() {
  const todayData = loadJSON(dayKey(0), {}) || {};
  const tKey = dayKey(1);
  const tomorrowData = loadJSON(tKey, {}) || {};
  const prevCarriedMeta = tomorrowData.__carried || {};
  const newCarriedMeta = {};
  let changed = false;

  TIME_KEYS.forEach((key) => {
    const entry = todayData[key];
    if (!entry || entry.type !== "checklist" || !Array.isArray(entry.items)) return;

    const carryMap = new Map();
    entry.items.forEach((it) => { if (!it.done) { const n = _norm(it.text); if (n) carryMap.set(n, it.text); } });
    newCarriedMeta[key] = Array.from(carryMap.keys());

    const existing = (tomorrowData[key] && Array.isArray(tomorrowData[key].items)) ? tomorrowData[key].items : [];
    const prevCarriedSet = new Set((prevCarriedMeta[key] || []).map(_norm));
    const native = existing.filter((it) => !prevCarriedSet.has(_norm(it.text)));

    const nativeSet = new Set(native.map((it) => _norm(it.text)));
    const newCarriedItems = [];
    carryMap.forEach((orig, norm) => { if (!nativeSet.has(norm)) newCarriedItems.push({ text: orig, done: false }); });

    const nextItems = [...newCarriedItems, ...native];
    if (JSON.stringify(existing) !== JSON.stringify(nextItems)) {
      changed = true;
      if (!tomorrowData[key]) tomorrowData[key] = { type: "checklist", items: [], smoke: false };
      tomorrowData[key].items = nextItems;
    }
  });

  if (changed || JSON.stringify(tomorrowData.__carried || {}) !== JSON.stringify(newCarriedMeta)) {
    tomorrowData.__carried = newCarriedMeta;
    saveJSON(tKey, tomorrowData);
  }
}

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
  const h1 = document.getElementById("greeting") || document.querySelector("h1");
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
  document.title = `${weekday3(d.getDay())} ${pad2(d.getDate())}-${monthsShort[d.getMonth()]}`;
  const todayEl = document.getElementById("today");
  if (todayEl) {
    todayEl.textContent =
      `${daysLong[d.getDay()]}, ${d.getDate()}${ord(d.getDate())} of ${monthsLong[d.getMonth()]}`;
  }
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

  const cardKey = root.dataset.key || "card";
  let id = 0;
  let suppressSave = false;

  // --- Templates: use the pre-rendered folder button ---
  const toggleIcon = form.querySelector('button[type="button"] i.fa-folder-open');
  const toggle = toggleIcon ? toggleIcon.closest('button') : null;

  if (toggle) {
    // wrap the toggle so the menu can be absolutely positioned
    const wrap = el("div", "relative");
    toggle.replaceWith(wrap);
    wrap.appendChild(toggle);

    const menu = el("div", "absolute right-0 top-full mt-1 w-64 font-sec bg-neutral border-neutral border-1 rounded-lg shadow-lg hidden z-20");

    wrap.appendChild(menu);

    function applyTemplate(items, preserveDone) {
      const have = new Set(
        [...list.querySelectorAll('[data-role="label"]')]
          .map(n => (n.textContent || "").trim().toLowerCase())
      );
      suppressSave = true;
      (items || []).forEach(it => {
        const text = capFirst(typeof it === "string" ? it : (it?.text || ""));
        if (!text) return;
        const n = text.toLowerCase();
        if (have.has(n)) return;
        addItem(text, preserveDone && !!it?.done);
        have.add(n);
      });
      suppressSave = false;
      snapshotDay();
    }

    function rebuildMenu() {
      const tpls = readTemplates();
      menu.innerHTML = "";
      const names = Object.keys(tpls).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
      names.forEach(name => {
        const b = el("button", "block w-full text-left px-3 pt-4 pb-2 text-white hover:bg-white hover:text-neutral focus:bg-white focus:text-neutral", name);
        b.type = "button";
        b.addEventListener("click", (e) => {
          // Alt/Option or Cmd preserves done-state
          applyTemplate(tpls[name], e.altKey || e.metaKey);
          menu.classList.add("hidden");
          input.focus();
        });
        menu.appendChild(b);
      });
      if (!names.length) menu.classList.add("hidden");
    }

    toggle.addEventListener("click", () => { rebuildMenu(); menu.classList.toggle("hidden"); });
    document.addEventListener("click", (e) => { if (!wrap.contains(e.target)) menu.classList.add("hidden"); });
    toggle.addEventListener("keydown", (e) => { if (e.key === "Escape") menu.classList.add("hidden"); });
    document.addEventListener("templates:changed", rebuildMenu);
  }


  // Save template button (attribute only)
  const saveBtn = root.querySelector("[data-template-save]");
  if (saveBtn) {
    saveBtn.type = "button";
    saveBtn.addEventListener("click", () => {
      const name = (prompt("Template name?") || "").trim();
      if (!name) return;

      const items = [...root.querySelectorAll("[data-checklist-list] > li")].map(li => {
        const label = li.querySelector('[data-role="label"]');
        const cb = li.querySelector('input[type="checkbox"]');
        return { text: (label?.textContent || "").trim(), done: !!cb?.checked };
      }).filter(it => it.text);

      if (!items.length) { alert("No items to save."); return; }

      const store = readTemplates();
      store[name] = items;
      saveTemplates(store);
      document.dispatchEvent(new CustomEvent("templates:changed"));
    });
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    addItemsFrom(input.value);
    input.value = "";
  });

  input.addEventListener("blur", () => { input.value = capFirst(input.value); });

  function addItemsFrom(text) {
    text.split(/[\n,;]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((t) => addItem(capFirst(t)));
  }

  function addItem(labelText, done = false, restoring = false) {
    const itemId = `cb-${cardKey}-${Date.now()}-${id++}`;
    const li = el("li", "flex items-center gap-2 py-3 px-3 group");
    const row = el("label", "flex items-center gap-2 cursor-pointer w-full select-none");
    row.setAttribute("for", itemId);

    const cb = el("input", "sr-only"); cb.type = "checkbox"; cb.id = itemId;

    const box = el("span", "inline-flex items-center justify-center size-6 rounded-full bg-white border-2 border-main transition-colors");
    const icon = svgCheck(); icon.style.opacity = "0"; icon.style.transition = "opacity 150ms"; icon.setAttribute("aria-hidden", "true"); box.appendChild(icon);

    const label = el("span", "flex-1 text-accents font-bold tracking-wide text-xl font-sec decoration-main decoration-2 mt-3", labelText);
    label.setAttribute("data-role", "label");

    const edit = el("button", "px-2 py-1 rounded-md text-accents/80 hover:text-white hover:bg-neutral transition-colors", "✎");
    edit.type = "button"; edit.title = "Edit";

    const del = el("button", "px-2 py-1 rounded-md text-red-400 hover:text-white hover:bg-neutral transition-colors", "✕");
    del.type = "button"; del.title = "Remove";

    const handle = el("span", "ml-1 cursor-grab select-none text-accents/60", "⋮⋮");
    handle.setAttribute("data-handle", "1");
    li.draggable = true;

    cb.addEventListener("change", () => {
      const checked = cb.checked;
      label.classList.toggle("line-through", checked);
      icon.style.opacity = checked ? "1" : "0";
      icon.setAttribute("aria-hidden", checked ? "false" : "true");
      box.classList.toggle("border-main", !checked);
      box.classList.toggle("border-accents", checked);
      if (!suppressSave) snapshotDay();
    });

    edit.addEventListener("click", () => {
      if (label.isContentEditable) return;
      var original = label.textContent;
      label.contentEditable = "true";
      label.style.outline = "none";
      row.removeAttribute("for");
      label.focus(); placeCaretEnd(label);

      function commit() {
        label.textContent = (label.textContent || "").trim();
        if (!label.textContent) { li.remove(); snapshotDay(); cleanup(); return; }
        label.contentEditable = "false";
        row.setAttribute("for", itemId);
        snapshotDay(); cleanup();
      }
      function cancel() {
        label.textContent = original;
        label.contentEditable = "false";
        row.setAttribute("for", itemId);
        cleanup();
      }
      function onKey(e) {
        if (e.key === "Enter") { e.preventDefault(); commit(); }
        if (e.key === "Escape") { e.preventDefault(); cancel(); }
      }
      function cleanup() {
        label.removeEventListener("keydown", onKey);
        label.removeEventListener("blur", commit);
      }
      label.addEventListener("keydown", onKey);
      label.addEventListener("blur", commit);
    });

    del.addEventListener("click", () => { li.remove(); if (!suppressSave) snapshotDay(); });

    li.addEventListener("dragstart", (e) => {
      const t = e.target;
      if (label.isContentEditable || t.closest("button,input,[contenteditable='true']")) { e.preventDefault(); return; }
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
      snapshotDay();
    });
    li.addEventListener("dragend", () => { li.classList.remove("opacity-50"); DRAG_SRC = null; });

    row.append(cb, box, label);
    li.append(handle, row, edit, del);
    list.appendChild(li);

    suppressSave = true;
    cb.checked = !!done;
    cb.dispatchEvent(new Event("change"));
    suppressSave = false;

    if (!restoring) snapshotDay();
  }

  root.__addChecklistItem = (text, done = false, restoring = false) => addItem(text, done, restoring);

  const smoke = root.querySelector("[data-smoke]");
  if (smoke) wireSmoke(smoke);
}

const smokescountPlus = document.getElementById("smokescount-plus");
smokescountPlus?.addEventListener("click", () => {
  setSmokesCount(getSmokesCountFromDOM() + 1);
  snapshotDay();
});

/* -------- Bullets (global Notes vs day-scoped Food, etc.) -------- */
function wireBullets(root) {
  const form = root.querySelector("[data-bullets-form]");
  const input = root.querySelector("[data-bullets-input]");
  const list = root.querySelector("[data-bullets-list]");
  const key = root.dataset.key || "notes";
  if (!form || !input || !list) return;

  function readItems() {
    const v = loadJSON(bulletsStorageKeyFor(key), []);
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object" && Array.isArray(v.items)) return v.items;
    return [];
  }
  function writeItems(items) {
    saveJSON(bulletsStorageKeyFor(key), items);
  }
  function currentItems() {
    return [...list.querySelectorAll('[data-role="text"]')].map((el) => ({
      text: (el.textContent || "").trim(),
    }));
  }

  function addItemsFrom(text) {
    text.split(/[\n,;]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((t) => addItem(capFirst(t)));
  }

  function addItem(text, restoring = false) {
    const li = el("li", "mt-3 flex items-center gap-2 px-3");
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
      txt.style.outline = "none";
      txt.focus(); placeCaretEnd(txt);

      function commit() {
        txt.textContent = (txt.textContent || "").trim();
        if (!txt.textContent) { li.remove(); writeItems(currentItems()); cleanup(); return; }
        txt.contentEditable = "false";
        writeItems(currentItems());
        cleanup();
      }
      function cancel() { txt.textContent = original; txt.contentEditable = "false"; cleanup(); }
      function onKey(e) { if (e.key === "Enter") { e.preventDefault(); commit(); } if (e.key === "Escape") { e.preventDefault(); cancel(); } }
      function cleanup() { txt.removeEventListener("keydown", onKey); txt.removeEventListener("blur", commit); }

      txt.addEventListener("keydown", onKey);
      txt.addEventListener("blur", commit);
    });

    del.addEventListener("click", () => { li.remove(); writeItems(currentItems()); });

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
    list.appendChild(li);

    if (!restoring) writeItems(currentItems());
  }

  list.innerHTML = "";
  readItems().forEach((it) => addItem(typeof it === "string" ? it : it.text, true));

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    e.stopPropagation();
    addItemsFrom(input.value);
    input.value = "";
    input.focus();
  });

  input.addEventListener("blur", () => { input.value = capFirst(input.value); });

  root.__addBulletItem = (text, restoring = false) => addItem(text, restoring);
}

/* -------- Smoke toggle -------- */
function wireSmoke(container) {
  const cb = container.querySelector('input[type="checkbox"]');
  const box = container.querySelector('[data-role="box"]');
  const icon = container.querySelector('[data-role="icon"]');
  const label = container.querySelector('[data-role="label"]');
  if (!cb || !box || !icon || !label) return;

  const card = container.closest('[data-checklist][data-key]');
  const cardKey = card?.dataset.key;

  cb.addEventListener("change", () => {
    const checked = cb.checked;

    label.classList.toggle("line-through", checked);
    icon.style.opacity = checked ? "1" : "0";
    icon.setAttribute("aria-hidden", checked ? "false" : "true");
    box.classList.toggle("border-main", !checked);
    box.classList.toggle("border-accents", checked);

    if (cardKey) {
      const k = dayKey();
      const day = loadJSON(k, {}) || {};
      const counted = day.__smokeCounted || {};
      const wasCounted = !!counted[cardKey];

      if (checked && !wasCounted) {
        setSmokesCount(getSmokesCountFromDOM() + 1);
        counted[cardKey] = true;
      } else if (!checked && wasCounted) {
        setSmokesCount(Math.max(0, getSmokesCountFromDOM() - 1));
        counted[cardKey] = false;
      }

      day.__smokeCounted = counted;
      saveJSON(k, day);
    }

    snapshotDay();
  });
}

/* -------- Tomorrow preview persistence (+auto-dedupe) -------- */
function prefillTomorrowFromToday() {
  if (DAY_OFFSET !== 1) return;
  const todayData = loadJSON(dayKey(0), {}) || {};
  const tKey = dayKey(1);
  const tomorrowData = loadJSON(tKey, {}) || {};
  const prevCarriedMeta = tomorrowData.__carried || {};
  const newCarriedMeta = {};
  let changed = false;

  Object.keys(todayData).forEach((key) => {
    const entry = todayData[key];
    if (!entry || entry.type !== "checklist" || !Array.isArray(entry.items)) return;

    const carryMap = new Map();
    entry.items.forEach((it) => { if (!it.done) { const n = _norm(it.text); if (n) carryMap.set(n, it.text); } });
    newCarriedMeta[key] = Array.from(carryMap.keys());

    const existing = (tomorrowData[key] && Array.isArray(tomorrowData[key].items)) ? tomorrowData[key].items : [];
    const prevCarriedSet = new Set((prevCarriedMeta[key] || []).map(_norm));
    const native = existing.filter((it) => !prevCarriedSet.has(_norm(it.text)));

    const nativeSet = new Set(native.map((it) => _norm(it.text)));
    const newCarriedItems = [];
    carryMap.forEach((orig, norm) => { if (!nativeSet.has(norm)) newCarriedItems.push({ text: orig, done: false }); });

    const nextItems = [...newCarriedItems, ...native];
    if (JSON.stringify(existing) !== JSON.stringify(nextItems)) {
      changed = true;
      if (!tomorrowData[key]) tomorrowData[key] = { type: "checklist", items: [], smoke: false };
      tomorrowData[key].items = nextItems;
    }
  });

  if (changed || JSON.stringify(tomorrowData.__carried || {}) !== JSON.stringify(newCarriedMeta)) {
    tomorrowData.__carried = newCarriedMeta;
    saveJSON(tKey, tomorrowData);
  }
}

/* -------- Restore current page from storage to DOM -------- */
function restoreAll() {
  const dayData = loadJSON(dayKey(), {});
  const sc = Number(dayData.__smokes);
  if (Number.isFinite(sc)) setSmokesCount(sc);
  document.querySelectorAll("[data-checklist][data-key]").forEach((card) => {
    const entry = dayData[card.dataset.key];
    if (entry?.items?.length) {
      const add = card.__addChecklistItem;
      entry.items.forEach((it) => add && add(it.text, !!it.done, true));
    }
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
    const items = [...card.querySelectorAll("[data-checklist-list] > li")].map((li) => {
      const label = li.querySelector('[data-role="label"]');
      const cb = li.querySelector('input[type="checkbox"]');
      return { text: (label?.textContent || "").trim(), done: !!(cb && cb.checked) };
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
    const items = [...card.querySelectorAll('[data-bullets-list] [data-role="text"]')]
      .map((el) => ({ text: (el.textContent || "").trim() }));
    out[key] = { type: "bullets", items };
  });
  return out;
}

/* -------- Snapshot helpers -------- */
function snapshotDay() {
  const key = dayKey();
  const prev = loadJSON(key, {}) || {};
  const next = collectChecklistsFromDOM();
  next.__smokes = getSmokesCountFromDOM();
  if (prev.__carried) next.__carried = prev.__carried;
  if (prev.__smokeCounted) next.__smokeCounted = prev.__smokeCounted;
  if (prev.__clearedDone) next.__clearedDone = prev.__clearedDone;
  saveJSON(key, next);
}

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
  data.__collapsed = data.__collapsed || {};
  let moved = false;

  for (let i = 0; i < TIME_KEYS.length; i++) {
    const fromKey = TIME_KEYS[i];
    const toKey = TIME_KEYS[i + 1]; // undefined for evening
    const shouldCollapse = new Date().getHours() >= cardEndHour(fromKey);

    applyCollapsedUI(fromKey, shouldCollapse);

    if (shouldCollapse && !data.__collapsed[fromKey] && toKey) {
      const from = (data[fromKey]?.items) ? data[fromKey] : (data[fromKey] = { type: "checklist", items: [], smoke: false });
      const to = (data[toKey]?.items) ? data[toKey] : (data[toKey] = { type: "checklist", items: [], smoke: false });

      const carry = (from.items || []).filter((it) => !it.done);
      const keep = (from.items || []).filter((it) => it.done);

      to.items = [...carry, ...(to.items || [])]; // prepend
      from.items = keep;

      data.__collapsed[fromKey] = true;
      moved = true;
    }
  }

  if (moved) {
    saveJSON(key, data);
    TIME_KEYS.forEach(renderCardFromStorage);
    refreshTomorrowPreviewAfterTodayChange();
  }
}

// --- Clear-checked (Work/Home/Shopping, Today only) ---
// --- Clear-checked (Work/Home/Shopping, Today only) ---
// Stores cleared done items under day.__clearedDone[cardKey] = [text,...]
function wireClearChecked() {
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-clear-checked]");
    if (!btn) return;

    if (DAY_OFFSET !== 0) return; // only on Today

    const card = btn.closest("[data-checklist][data-key]");
    const key = card?.dataset.key;
    if (!card || !["work", "home", "shopping"].includes(key)) return;

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
      const k = dayKey();
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


/* -------- Boot -------- */
document.addEventListener("DOMContentLoaded", () => {
  setHeaderAndTitle();
  updateGreeting();

  document.querySelectorAll("[data-checklist]").forEach(wireChecklist);
  document.querySelectorAll("[data-bullets]").forEach(wireBullets);
  document.querySelectorAll("[data-countdown]").forEach(wireCountdown);

  wireClearChecked();
  prefillTomorrowFromToday();
  restoreAll();
  collapsePastTimeCards();
  setInterval(collapsePastTimeCards, 5 * 60 * 1000); // every 5 minutes

  if (DAY_OFFSET === 0) ensureEmptyDay(1);
  highlightCurrentBlock();
  setInterval(highlightCurrentBlock, 5 * 60 * 1000);

  // Download the current view's day (works on today and on tomorrow.html)
  document.getElementById("download-today")?.addEventListener("click", () => {
    downloadDayViaHref(DAY_OFFSET);
  });



  // Restore from JSON (opens remembered folder if supported)
  document.getElementById("restore")?.addEventListener("click", async () => {
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
          saveJSON(bulletsStorageKeyForDate(ds, k), items);
        });
      }
      if (Array.isArray(data.notes)) saveJSON(GLOBAL_NOTES_KEY, data.notes);

      const currentDS = ymd(getPlannerDate(DAY_OFFSET));
      if (ds === currentDS) location.reload();
      else alert(`Restored ${ds}. Switch to that day to view it.`);
    } catch {
      alert("Restore failed. Pick a valid planner JSON.");
    }
  });

  // End day
  document.getElementById("endday")?.addEventListener("click", async () => {
    const todayKey = dayKey(0);
    const tomorrowKey = dayKey(1);

    ensureEmptyDay(1);

    const todayData = loadJSON(todayKey, {}) || {};
    const tomorrowData = loadJSON(tomorrowKey, {}) || {};
    const carriedMeta = {};

    Object.keys(todayData || {}).forEach((key) => {
      const entry = todayData[key];
      if (entry?.type === "checklist" && Array.isArray(entry.items)) {
        const carry = entry.items.filter((it) => !it.done);
        if (!tomorrowData[key]) {
          tomorrowData[key] = { type: "checklist", items: [], smoke: false };
        }
        tomorrowData[key].items = [...carry, ...(tomorrowData[key].items || [])];
        if (carry.length) {
          carriedMeta[key] = carry.map((it) => _norm(it.text)).filter(Boolean);
        }
      }
    });
    tomorrowData.__carried = carriedMeta;
    saveJSON(tomorrowKey, tomorrowData);

    const dsToday = ymd(getPlannerDate(0));
    const dsTomorrow = ymd(getPlannerDate(1));
    const dayToday = collectChecklistsFromDOM();
    dayToday.__smokes = getSmokesCountFromDOM();
    const storedToday = loadJSON(todayKey, {}) || {};
    mergeClearedIntoDayObj(dayToday, storedToday.__clearedDone);

    const payloadToday = {
      version: 2,
      date: dsToday,
      day: dayToday,
      bullets: collectBulletsFromDOM(),
      notes: loadJSON(GLOBAL_NOTES_KEY, []),
    };
    const tomorrowBullets = {};
    Object.keys(localStorage).forEach((k) => {
      const m = k.match(/^planner:\d{4}-\d{2}-\d{2}:bullets:(.+)$/);
      if (m && k.startsWith(dayKeyFromDateStr(dsTomorrow))) {
        const listKey = m[1];
        tomorrowBullets[listKey] = { type: "bullets", items: loadJSON(k, []) };
      }
    });
    const payloadTomorrow = { version: 2, date: dsTomorrow, day: loadJSON(tomorrowKey, {}), bullets: tomorrowBullets, notes: loadJSON(GLOBAL_NOTES_KEY, []) };

    await downloadJSON(`${dsToday}-planner.json`, payloadToday);
    await downloadJSON(`${dsTomorrow}-planner.json`, payloadTomorrow);

    const newBase = getPlannerDate(1);
    setBaseDate(newBase);
    location.href = "./index.html";
  });
});
