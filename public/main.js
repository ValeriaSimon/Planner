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

  const cardKey = root.dataset.key || "card";     // <-- scope
  let id = 0;
  let suppressSave = false;

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    addItemsFrom(input.value);
    input.value = "";
  });

  function addItemsFrom(text) {
    text.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean).forEach((t) => addItem(t));
  }

  function addItem(labelText, done = false, restoring = false) {
    const itemId = `cb-${cardKey}-${Date.now()}-${id++}`;  // <-- unique per card
    const li = el("li", "flex items-center gap-3 py-3 px-3 group");

    const row = el("label", "flex items-center gap-3 cursor-pointer w-full select-none");
    row.setAttribute("for", itemId);

    const cb = el("input", "sr-only");
    cb.type = "checkbox";
    cb.id = itemId;

    const box = el("span", "inline-flex items-center justify-center size-6 rounded-full bg-white border-2 border-main transition-colors");
    const icon = svgCheck();
    icon.style.opacity = "0";
    icon.style.transition = "opacity 150ms";
    icon.setAttribute("data-role", "icon");
    box.appendChild(icon);
    box.setAttribute("data-role", "box");

    const label = el("span", "flex-1 text-accents font-bold tracking-wide text-xl font-sec decoration-main decoration-2 mt-3", labelText);
    label.setAttribute("data-role", "label");

    cb.addEventListener("change", () => {
      const checked = cb.checked;
      label.classList.toggle("line-through", checked);
      icon.style.opacity = checked ? "1" : "0";
      icon.setAttribute("aria-hidden", checked ? "false" : "true");
      box.classList.toggle("border-main", !checked);
      box.classList.toggle("border-accents", checked);
      if (!suppressSave) snapshotDay();
    });

    const del = el("button", "rounded-md px-2 py-1 text-red-400 hover:text-white hover:bg-neutral transition-colors opacity-0 group-hover:opacity-100", "✕");
    del.type = "button";
    del.title = "Remove";
    del.addEventListener("click", () => { li.remove(); if (!suppressSave) snapshotDay(); });

    row.append(cb, box, label);
    li.append(row, del);
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

const smokescount = document.getElementById("smokescount");
const smokescountPlus = document.getElementById("smokescount-plus");
smokescountPlus?.addEventListener("click", () => {
  setSmokesCount(getSmokesCountFromDOM() + 1);
  snapshotDay(); // persist with the day
});

/* -------- Bullets (global Notes vs day-scoped Food, etc.) -------- */
function wireBullets(root) {
  const form = root.querySelector("[data-bullets-form]");
  const input = root.querySelector("[data-bullets-input]");
  const list = root.querySelector("[data-bullets-list]");
  const key = root.dataset.key || "notes";
  if (!form || !input || !list) return;

  // tolerant read/write
  function readItems() {
    const v = loadJSON(bulletsStorageKeyFor(key), []);
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object" && Array.isArray(v.items)) return v.items; // legacy {type:'bullets', items:[]}
    return [];
  }
  function writeItems(items) {
    // always persist as a plain array
    saveJSON(bulletsStorageKeyFor(key), items);
  }
  function currentItems() {
    return [...list.querySelectorAll('[data-role="text"]')].map((el) => ({
      text: (el.textContent || "").trim(),
    }));
  }

  function addItemsFrom(text) {
    text
      .split(/[\n,;]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((t) => addItem(t));
  }

  function addItem(text, restoring = false) {
    const li = el("li", "mt-3");
    const row = el("div", "flex items-center gap-3");

    const txt = el("span", "text-accents font-bold tracking-wide text-xl font-sec");
    txt.textContent = text;
    txt.setAttribute("data-role", "text");

    const del = el(
      "button",
      "ml-auto inline-flex items-center justify-center size-6 rounded-md text-red-400 hover:text-white hover:bg-neutral transition-colors",
      "✕"
    );
    del.type = "button";
    del.title = "Remove";
    del.setAttribute("aria-label", `Remove "${text}"`);
    del.addEventListener("click", () => {
      li.remove();
      writeItems(currentItems());
    });

    row.append(txt, del);
    li.appendChild(row);
    list.appendChild(li);

    if (!restoring) writeItems(currentItems());
  }

  // init
  list.innerHTML = "";
  readItems().forEach((it) => addItem(typeof it === "string" ? it : it.text, true));

  // submit
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    e.stopPropagation();
    addItemsFrom(input.value);
    input.value = "";
    input.focus();
  });

  root.__addBulletItem = (text, restoring = false) => addItem(text, restoring);
}


/* -------- Smoke toggle -------- */
function wireSmoke(container) {
  const cb = container.querySelector('input[type="checkbox"]');
  const box = container.querySelector('[data-role="box"]');
  const icon = container.querySelector('[data-role="icon"]');
  const label = container.querySelector('[data-role="label"]');
  if (!cb || !box || !icon || !label) return;
  cb.addEventListener("change", () => {
    const checked = cb.checked;
    label.classList.toggle("line-through", checked);
    icon.style.opacity = checked ? "1" : "0";
    icon.setAttribute("aria-hidden", checked ? "false" : "true");
    box.classList.toggle("border-main", !checked);
    box.classList.toggle("border-accents", checked);
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
  next.__smokes = getSmokesCountFromDOM();     // <- add counter
  if (prev.__carried) next.__carried = prev.__carried;
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
  function formatDuration(ms) { let s = Math.max(0, Math.floor(ms / 1000)); const d = Math.floor(s / 86400); s -= d * 86400; const h = Math.floor(s / 3600); s -= h * 3600; const m = Math.floor(s / 60); s -= m * 60; return (d > 0 ? `${d}d ` : '') + `${pad(h)}:${pad(m)}:${pad(s)}`; }
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

/* -------- Boot -------- */
document.addEventListener("DOMContentLoaded", () => {
  setHeaderAndTitle();
  updateGreeting();

  document.querySelectorAll("[data-checklist]").forEach(wireChecklist);
  document.querySelectorAll("[data-bullets]").forEach(wireBullets);
  document.querySelectorAll("[data-countdown]").forEach(wireCountdown);

  prefillTomorrowFromToday();
  restoreAll();

  if (DAY_OFFSET === 0) ensureEmptyDay(1);
  highlightCurrentBlock();
  setInterval(highlightCurrentBlock, 5 * 60 * 1000);

  // Download today (DOM snapshot)
  document.getElementById("download-today")?.addEventListener("click", async () => {
    const ds = ymd(getPlannerDate(DAY_OFFSET));
    const dayObj = collectChecklistsFromDOM();
    dayObj.__smokes = getSmokesCountFromDOM();   // <- add
    const payload = {
      version: 2,
      date: ds,
      day: dayObj,
      bullets: collectBulletsFromDOM(),
      notes: loadJSON(GLOBAL_NOTES_KEY, []),
    };
    await downloadJSON(`${ds}-planner.json`, payload);
  });


  // Restore from JSON (opens remembered folder if supported)
  document.getElementById("restore")?.addEventListener("click", async () => {
    try {
      const file = await pickFileFromRememberedDir();
      const text = await file.text();
      const data = JSON.parse(text);

      // Accept v1/v2 shapes
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

  // End day: carry unfinished, auto-download today & tomorrow, advance base day
  document.getElementById("endday")?.addEventListener("click", async () => {
    const todayKey = dayKey(0);
    const tomorrowKey = dayKey(1);

    // Ensure tomorrow exists
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
        // Prepend carry-overs
        tomorrowData[key].items = [...carry, ...(tomorrowData[key].items || [])];
        if (carry.length) {
          carriedMeta[key] = carry.map((it) => _norm(it.text)).filter(Boolean);
        }
      }
    });
    tomorrowData.__carried = carriedMeta;
    saveJSON(tomorrowKey, tomorrowData);

    // Build downloads from DOM snapshot to capture unsaved edits
    const dsToday = ymd(getPlannerDate(0));
    const dsTomorrow = ymd(getPlannerDate(1));
    const dayToday = collectChecklistsFromDOM();
    dayToday.__smokes = getSmokesCountFromDOM();
    const payloadToday = {
      version: 2,
      date: dsToday,
      day: dayToday,
      bullets: collectBulletsFromDOM(),
      notes: loadJSON(GLOBAL_NOTES_KEY, []),
    };
    // Tomorrow payload from storage (no DOM yet)
    const tomorrowBullets = {}; // day-scoped bullets (e.g., food)
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

    // Advance base day and reload to Today
    const newBase = getPlannerDate(1);
    setBaseDate(newBase);
    location.href = "./index.html";
  });
});
