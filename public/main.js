// ---- Day offset comes from HTML (data-day-offset) ----
function getPageOffset() {
  const raw = Number(document.body?.dataset?.dayOffset ?? 0);
  return Number.isFinite(raw) ? raw : 0;
}
const DAY_OFFSET = getPageOffset();

// ---- Date helpers ----
function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
const pad2 = (n) => String(n).padStart(2, "0");
const weekday2 = (i) => ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"][i];

// Persisted "base day" that today's planner is anchored to.
// When you press End day! we bump this by one day.
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
  // Use base date if set; otherwise default to today (and store it)
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

const GLOBAL_NOTES_KEY = "planner:notes";
const GLOBAL_COUNTDOWN_KEY = "planner:countdown";

function bulletsStorageKeyFor(key) {
  // "notes" stays global (shared across days), others are day-scoped (no rollover)
  if (!key || key === "notes") return GLOBAL_NOTES_KEY;
  return `${dayKey()}:bullets:${key}`;
}

document.addEventListener("DOMContentLoaded", () => {
  // ---- header + tab titles ----
  const h2 = document.querySelector("header h2");
  const d = getPlannerDate(DAY_OFFSET);

  // helpers for title
  const weekday3 = (i) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][i];
  const monthsShort = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  // Tab title: "ddd DD-mmm"
  document.title = `${weekday3(d.getDay())} ${pad2(d.getDate())}-${monthsShort[d.getMonth()]}`;

  // H2 prefix + long date text
  const label = DAY_OFFSET === 0 ? "Today" : DAY_OFFSET === 1 ? "Tomorrow" : `In ${DAY_OFFSET} days`;
  if (h2) {
    h2.innerHTML = `${label} is <span id="today"></span>`;
  }

  const todayEl = document.getElementById("today");
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const ord = (n) => {
    const v = n % 100;
    if (v >= 11 && v <= 13) return "th";
    switch (n % 10) {
      case 1: return "st";
      case 2: return "nd";
      case 3: return "rd";
      default: return "th";
    }
  };
  if (todayEl) {
    todayEl.textContent = `${days[d.getDay()]}, ${d.getDate()}${ord(
      d.getDate()
    )} of ${months[d.getMonth()]}`;
  }

  updateGreeting();

  // ---- wire cards ----
  document.querySelectorAll("[data-checklist]").forEach(wireChecklist);
  document.querySelectorAll("[data-bullets]").forEach(wireBullets);
  document.querySelectorAll("[data-countdown]").forEach(wireCountdown);


  // Ensure tomorrow view shows today's unfinished items
  prefillTomorrowFromToday();

  // ---- restore saved state ----
  restoreAll();

  // ---- "End day!" manual rollover ----
  document.getElementById("endday")?.addEventListener("click", () => {
    // Keys relative to the current base day (before we advance it)
    const todayKey = dayKey(0);
    const tomorrowKey = dayKey(1);

    // Ensure tomorrow exists
    ensureEmptyDay(1);

    // Carry unfinished checklist items to tomorrow
    const todayData = loadJSON(todayKey, {}) || {};
    const tomorrowData = loadJSON(tomorrowKey, {}) || {};

    // ✨ Track which items we carried over (by normalized text)
    const carriedMeta = {};

    Object.keys(todayData || {}).forEach((key) => {
      const entry = todayData[key];
      if (entry?.type === "checklist" && Array.isArray(entry.items)) {
        const carry = entry.items.filter((it) => !it.done);

        if (!tomorrowData[key]) {
          tomorrowData[key] = { type: "checklist", items: [], smoke: false };
        }

        // Prepend carry-overs so they appear first tomorrow
        tomorrowData[key].items = [...carry, ...(tomorrowData[key].items || [])];

        // Record what we carried for pruning later in the tomorrow view
        if (carry.length) {
          carriedMeta[key] = carry
            .map((it) => _norm(it.text))
            .filter(Boolean);
        }
      }
    });

    // Save the metadata so the tomorrow page can prune carried items
    // if you later check them off "today".
    tomorrowData.__carried = carriedMeta;

    saveJSON(tomorrowKey, tomorrowData);

    // Advance the base day by one and reload the page
    const newBase = getPlannerDate(1);
    setBaseDate(newBase);
    location.reload();
  });


  // ---- download button ----
  document.getElementById("download-today")?.addEventListener("click", () => {
    const payload = {
      day: collectChecklistsFromDOM(),
      bullets: collectBulletsFromDOM(),
      notes: loadJSON(GLOBAL_NOTES_KEY, []), // global notes unchanged
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${ymd(getPlannerDate(DAY_OFFSET))}-planner.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  // ---- pre-create tomorrow only when viewing "today" ----
  if (DAY_OFFSET === 0) ensureEmptyDay(1);
});

// ---- Restore from storage ----
function restoreAll() {
  const dayData = loadJSON(dayKey(), {});
  document
    .querySelectorAll("[data-checklist][data-key]")
    .forEach((card) => {
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

  // global notes shared across pages
  const notes = loadJSON(GLOBAL_NOTES_KEY, []);
  document.querySelectorAll("[data-bullets][data-key]").forEach((card) => {
    const add = card.__addBulletItem;
    notes.forEach((it) => add && add(it.text, true));
  });
}

/** Checklist card */
function wireChecklist(root) {
  const form = root.querySelector("[data-checklist-form]");
  const input = root.querySelector("[data-checklist-input]");
  const list = root.querySelector("[data-checklist-list]");
  if (!form || !input || !list) return;

  let id = 0;
  let suppressSave = false;

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    addItemsFrom(input.value);
    input.value = "";
  });

  function addItemsFrom(text) {
    text
      .split(/[\n,;]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((t) => addItem(t));
  }

  function addItem(labelText, done = false, restoring = false) {
    const itemId = `item-${Date.now()}-${id++}`;
    const li = el("li", "flex items-center gap-3 py-3 px-3");

    const row = el("label", "flex items-center gap-3 cursor-pointer w-full select-none");
    row.setAttribute("for", itemId);

    const cb = el("input", "sr-only");
    cb.type = "checkbox";
    cb.id = itemId;

    const box = el(
      "span",
      "inline-flex items-center justify-center size-6 rounded-full bg-white border-2 border-main transition-colors"
    );
    const icon = svgCheck();
    icon.style.opacity = "0";
    icon.style.transition = "opacity 150ms";
    icon.setAttribute("aria-hidden", "true");
    box.appendChild(icon);

    const label = el(
      "span",
      "flex-1 text-accents font-bold tracking-wide text-xl font-sec decoration-main decoration-2 mt-3",
      labelText
    );
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

    const del = el(
      "button",
      "rounded-md px-2 py-1 text-red-400 hover:text-white hover:bg-neutral transition-colors",
      "✕"
    );
    del.type = "button";
    del.title = "Remove";
    del.addEventListener("click", () => {
      li.remove();
      if (!suppressSave) snapshotDay();
    });

    row.append(cb, box, label);
    li.append(row, del);
    list.appendChild(li);

    // preset state without immediate save
    suppressSave = true;
    cb.checked = !!done;
    cb.dispatchEvent(new Event("change"));
    suppressSave = false;

    if (!restoring) snapshotDay();
  }

  root.__addChecklistItem = (text, done = false, restoring = false) =>
    addItem(text, done, restoring);

  const smoke = root.querySelector("[data-smoke]");
  if (smoke) wireSmoke(smoke);
}

/** Notes (shared) */
function wireBullets(root) {
  const form = root.querySelector("[data-bullets-form]");
  const input = root.querySelector("[data-bullets-input]");
  const list = root.querySelector("[data-bullets-list]");
  const key = root.dataset.key || "notes";
  if (!form || !input || !list) return;

  function read() {
    return loadJSON(bulletsStorageKeyFor(key), []);
  }
  function write(items) {
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
      write(currentItems());
    });

    row.append(txt, del);
    li.appendChild(row);
    list.appendChild(li);

    if (!restoring) write(currentItems());
  }

  // init from storage
  list.innerHTML = "";
  read().forEach((it) => addItem(it.text, true));

  // submit handler
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    addItemsFrom(input.value);
    input.value = "";
  });

  // still expose if you ever want to use it from elsewhere
  root.__addBulletItem = (text, restoring = false) => addItem(text, restoring);
}

/** Smoke toggle */
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
    snapshotDay(); // persist smoke state
  });
}

/** Highlight current block (only for today) */
function highlightCurrentBlock() {
  const hr = new Date().getHours();
  const cards = document.querySelectorAll("[data-checklist][data-start][data-end]");
  cards.forEach((card) =>
    card.classList.remove("scale-105", "z-10", "shadow-xl")
  );
  const active = [...cards].find((card) => {
    const start = Number(card.dataset.start);
    const end = Number(card.dataset.end);
    return hr >= start && hr < end;
  });
  if (active) active.classList.add("scale-105", "z-10", "shadow-xl");
}

// ---- helpers ----
function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}
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

// ---- storage helpers ----
function loadJSON(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) ?? JSON.stringify(fallback));
  } catch {
    return fallback;
  }
}
function saveJSON(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

const _norm = (s) => (s || "").trim().toLowerCase();

function prefillTomorrowFromToday() {
  if (DAY_OFFSET !== 1) return; // only when viewing "tomorrow"

  const todayData = loadJSON(dayKey(0), {}) || {};
  const tomorrowKey = dayKey(1);
  const tomorrowData = loadJSON(tomorrowKey, {}) || {};

  const prevCarriedMeta = tomorrowData.__carried || {};
  const newCarriedMeta = {};
  let changed = false;

  Object.keys(todayData).forEach((key) => {
    const entry = todayData[key];
    if (!entry || entry.type !== "checklist" || !Array.isArray(entry.items)) return;

    // Map normalized text -> original text for today's *unchecked* items
    const carryMap = new Map();
    entry.items.forEach((it) => {
      if (!it.done) {
        const norm = _norm(it.text);
        if (norm) carryMap.set(norm, it.text);
      }
    });
    newCarriedMeta[key] = Array.from(carryMap.keys());

    const existing = (tomorrowData[key] && Array.isArray(tomorrowData[key].items))
      ? tomorrowData[key].items
      : [];

    // Items that were previously carried (by text), so we can drop/refresh them
    const prevCarriedSet = new Set((prevCarriedMeta[key] || []).map(_norm));

    // Keep only items that were *not* previously carried (i.e., native tomorrow tasks)
    const native = existing.filter((it) => !prevCarriedSet.has(_norm(it.text)));

    // Avoid duplicates vs natives
    const nativeSet = new Set(native.map((it) => _norm(it.text)));
    const newCarriedItems = [];
    carryMap.forEach((orig, norm) => {
      if (!nativeSet.has(norm)) newCarriedItems.push({ text: orig, done: false });
    });

    const nextItems = [...newCarriedItems, ...native];

    if (JSON.stringify(existing) !== JSON.stringify(nextItems)) {
      changed = true;
      if (!tomorrowData[key]) tomorrowData[key] = { type: "checklist", items: [], smoke: false };
      tomorrowData[key].items = nextItems;
    }
  });

  if (changed || JSON.stringify(tomorrowData.__carried || {}) !== JSON.stringify(newCarriedMeta)) {
    tomorrowData.__carried = newCarriedMeta; // record which texts are carry-overs
    saveJSON(tomorrowKey, tomorrowData);
  }
}


// DOM -> objects
function collectChecklistsFromDOM() {
  const data = {};
  document
    .querySelectorAll("[data-checklist][data-key]")
    .forEach((card) => {
      const key = card.dataset.key;
      const items = [...card.querySelectorAll("[data-checklist-list] > li")].map(
        (li) => {
          const label = li.querySelector('[data-role="label"]');
          const cb = li.querySelector('input[type="checkbox"]');
          return {
            text: (label?.textContent || "").trim(),
            done: !!(cb && cb.checked),
          };
        }
      );
      const smokeCb = card.querySelector('[data-smoke] input[type="checkbox"]');
      data[key] = {
        type: "checklist",
        items,
        smoke: !!(smokeCb && smokeCb.checked),
      };
    });
  return data;
}
function collectBulletsFromDOM() {
  const out = {};
  document.querySelectorAll("[data-bullets][data-key]").forEach((card) => {
    const key = card.dataset.key;
    if (key === "notes") return; // notes are global; handled separately
    const items = [
      ...card.querySelectorAll('[data-bullets-list] [data-role="text"]'),
    ].map((el) => ({ text: (el.textContent || "").trim() }));
    out[key] = { type: "bullets", items };
  });
  return out;
}

// save helpers
function snapshotDay() {
  const key = dayKey();
  const prev = loadJSON(key, {}) || {};
  const next = collectChecklistsFromDOM();

  // preserve day-level metadata (e.g., carry-over tracking)
  if (prev.__carried) next.__carried = prev.__carried;

  saveJSON(key, next);
}


// create blank lists for tomorrow if missing
function ensureEmptyDay(offset = 1) {
  const key = dayKey(offset);
  if (localStorage.getItem(key)) return;
  const empty = {};
  document.querySelectorAll("[data-checklist][data-key]").forEach((card) => {
    empty[card.dataset.key] = { type: "checklist", items: [], smoke: false };
  });
  saveJSON(key, empty);
}

// ---- countdown ----
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

  // Font Awesome calendar icon -> open native picker
  root.querySelectorAll('[data-open-picker]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (whenIn && typeof whenIn.showPicker === 'function') whenIn.showPicker();
      else whenIn?.focus();
    });
  });

  function readSaved() { return loadJSON(GLOBAL_COUNTDOWN_KEY, null); }
  function writeSaved(v) { saveJSON(GLOBAL_COUNTDOWN_KEY, v); }

  function showForm() {
    form.classList.remove('hidden');
    view.classList.add('hidden');
    root.classList.add('is-form');
    root.classList.remove('is-view');
  }
  function showView() {
    form.classList.add('hidden');
    view.classList.remove('hidden');
    root.classList.add('is-view');
    root.classList.remove('is-form');
  }

  function update() {
    const saved = readSaved();
    if (!saved) { showForm(); return; }

    const label = (saved.label || '').trim();
    if (label) {
      titleEl.textContent = label;
      titleEl.classList.remove('hidden');
    } else {
      titleEl.textContent = '';
      titleEl.classList.add('hidden');
    }

    const ms = saved.target - Date.now();
    display.textContent = ms <= 0 ? 'Done!' : formatDuration(ms);
    showView();
  }

  function startTick() {
    if (root.__cdTimer) clearInterval(root.__cdTimer);
    update();
    root.__cdTimer = setInterval(update, 1000);
  }

  // Restore on load
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
    const target = new Date(when).getTime(); // local time
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

function pad(n) { return String(n).padStart(2, '0'); }
function formatDuration(ms) {
  let s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  return (d > 0 ? `${d}d ` : '') + `${pad(h)}:${pad(m)}:${pad(s)}`;
}
function toLocalDatetimeValue(d) {
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const mi = pad(d.getMinutes());
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}
