// -------- utils: routing & dates --------
function getDayOffsetFromPath() {
  // Support both path (/tomorrow) and hash (#/tomorrow) for static hosting
  const raw = (location.pathname + location.hash).replace(/\/+$/, '');
  if (raw.endsWith('/tomorrow') || raw.endsWith('#/tomorrow')) return 1;
  // treat '/', '/today', or '#/today' as today
  return 0;
}
function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function getPlannerDate(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d;
}
function currentOffset() { return getDayOffsetFromPath(); }
function dayKey(offset = currentOffset()) {
  return `planner:${ymd(getPlannerDate(offset))}`;
}

// -------- constants --------
const GLOBAL_NOTES_KEY = 'planner:notes';

// -------- boot --------
document.addEventListener('DOMContentLoaded', () => {
  // ---- header date ----
  const pageTitle = document.getElementById("page-title");
  const todayEl = document.getElementById("today");
  const d = getPlannerDate(currentOffset());
  const sdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const smonths = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const ord = (n) => {
    const v = n % 100;
    if (v >= 11 && v <= 13) return 'th';
    switch (n % 10) {
      case 1: return 'st';
      case 2: return 'nd';
      case 3: return 'rd';
      default: return 'th';
    }
  };
  pageTitle.textContent = `${sdays[d.getDay()]}, ${d.getDate()} ${smonths[d.getMonth()]}`;
  todayEl.textContent = `${days[d.getDay()]}, ${d.getDate()}${ord(d.getDate())} of ${months[d.getMonth()]}`;

  // ---- wire every card ----
  document.querySelectorAll('[data-checklist]').forEach(wireChecklist);
  document.querySelectorAll('[data-bullets]').forEach(wireBullets);

  // ---- restore saved state ----
  restoreAll();

  // ---- highlight current time block ----
  if (currentOffset() === 0) {
    highlightCurrentBlock();
    const now = new Date();
    const msToNextHour =
      (59 - now.getMinutes()) * 60_000 +
      (60 - now.getSeconds()) * 1000 -
      now.getMilliseconds();
    setTimeout(() => {
      highlightCurrentBlock();
      setInterval(highlightCurrentBlock, 60 * 60 * 1000);
    }, Math.max(0, msToNextHour));
  }

  // ---- download button ----
  document.getElementById('download-today')?.addEventListener('click', () => {
    const payload = {
      day: collectChecklistsFromDOM(),
      notes: loadJSON(GLOBAL_NOTES_KEY, [])
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${ymd(getPlannerDate(currentOffset()))}-planner.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  // ---- pre-create tomorrow once ----
  ensureEmptyDay(1);

  // ---- auto-rollover at midnight ----
  scheduleMidnightRollover();
});

// -------- restore --------
function restoreAll() {
  // day-specific checklists
  const dayData = loadJSON(dayKey(), {});
  document.querySelectorAll('[data-checklist][data-key]').forEach(card => {
    const entry = dayData[card.dataset.key];

    // restore items
    if (entry?.items?.length) {
      const add = card.__addChecklistItem;
      entry.items.forEach(it => add && add(it.text, !!it.done, true));
    }

    // restore smoke state
    const smokeCb = card.querySelector('[data-smoke] input[type="checkbox"]');
    if (smokeCb) {
      smokeCb.checked = !!entry?.smoke;
      smokeCb.dispatchEvent(new Event('change'));
    }
  });

  // global notes (shared across days)
  const notes = loadJSON(GLOBAL_NOTES_KEY, []);
  document.querySelectorAll('[data-bullets][data-key]').forEach(card => {
    const add = card.__addBulletItem;
    notes.forEach(it => add && add(it.text, true));
  });
}

// -------- checklist behavior --------
function wireChecklist(root) {
  const form = root.querySelector('[data-checklist-form]');
  const input = root.querySelector('[data-checklist-input]');
  const list = root.querySelector('[data-checklist-list]');
  if (!form || !input || !list) return;

  let id = 0;
  let suppressSave = false;

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    addItemsFrom(input.value);
    input.value = '';
  });

  function addItemsFrom(text) {
    text.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean).forEach(t => addItem(t));
  }

  function addItem(labelText, done = false, restoring = false) {
    const itemId = `item-${Date.now()}-${id++}`;
    const li = el('li', "flex items-center gap-3 py-3 px-3");

    const row = el('label', "flex items-center gap-3 cursor-pointer w-full select-none");
    row.setAttribute('for', itemId);

    const cb = el('input', "sr-only");
    cb.type = 'checkbox';
    cb.id = itemId;

    const box = el('span', "inline-flex items-center justify-center size-6 rounded-full bg-white border-2 border-main transition-colors");
    const icon = svgCheck();
    icon.style.opacity = "0";
    icon.style.transition = "opacity 150ms";
    icon.setAttribute("aria-hidden", "true");
    box.appendChild(icon);

    const label = el('span', "flex-1 text-accents font-bold tracking-wide text-xl font-sec decoration-main decoration-2 mt-3", labelText);
    label.setAttribute('data-role', 'label');

    cb.addEventListener('change', () => {
      const checked = cb.checked;
      label.classList.toggle('line-through', checked);
      icon.style.opacity = checked ? "1" : "0";
      icon.setAttribute('aria-hidden', checked ? "false" : "true");
      box.classList.toggle('border-main', !checked);
      box.classList.toggle('border-accents', checked);
      if (!suppressSave) snapshotDay();
    });

    const del = el('button', "rounded-md px-2 py-1 text-red-400 hover:text-white hover:bg-neutral transition-colors", '✕');
    del.type = 'button';
    del.title = 'Remove';
    del.addEventListener('click', () => { li.remove(); if (!suppressSave) snapshotDay(); });

    row.append(cb, box, label);
    li.append(row, del);
    list.appendChild(li);

    // apply preset state without immediate save
    suppressSave = true;
    cb.checked = !!done;
    cb.dispatchEvent(new Event('change'));
    suppressSave = false;

    if (!restoring) snapshotDay();
  }

  // expose add for restoreAll()
  root.__addChecklistItem = (text, done = false, restoring = false) => addItem(text, done, restoring);

  // smoke toggle
  const smoke = root.querySelector('[data-smoke]');
  if (smoke) wireSmoke(smoke);
}

function wireBullets(root) {
  const form = root.querySelector('[data-bullets-form]');
  const input = root.querySelector('[data-bullets-input]');
  const list = root.querySelector('[data-bullets-list]');
  if (!form || !input || !list) return;

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    addItemsFrom(input.value);
    input.value = '';
  });

  function addItemsFrom(text) {
    text.split(/[\n,;]+/)
      .map(s => s.trim())
      .filter(Boolean)
      .forEach(t => addItem(t));
  }

  function addItem(text, restoring = false) {
    const li = el('li', "mt-3");
    const row = el('div', "flex items-center gap-3");

    const txt = el('span', "text-accents font-bold tracking-wide text-xl font-sec");
    txt.textContent = text;
    txt.setAttribute('data-role', 'text');

    const del = el(
      'button',
      "ml-auto inline-flex items-center justify-center size-6 rounded-md text-red-400 hover:text-white hover:bg-neutral transition-colors",
      '✕'
    );
    del.type = 'button';
    del.title = 'Remove';
    del.setAttribute('aria-label', `Remove "${text}"`);
    del.addEventListener('click', () => { li.remove(); snapshotNotes(); });

    row.append(txt, del);
    li.appendChild(row);
    list.appendChild(li);

    if (!restoring) snapshotNotes();
  }

  root.__addBulletItem = (text, restoring = false) => addItem(text, restoring);
}

// -------- smoke behavior --------
function wireSmoke(container) {
  const cb = container.querySelector('input[type="checkbox"]');
  const box = container.querySelector('[data-role="box"]');
  const icon = container.querySelector('[data-role="icon"]');
  const label = container.querySelector('[data-role="label"]');
  if (!cb || !box || !icon || !label) return;

  cb.addEventListener('change', () => {
    const checked = cb.checked;
    label.classList.toggle('line-through', checked);
    icon.style.opacity = checked ? '1' : '0';
    icon.setAttribute('aria-hidden', checked ? 'false' : 'true');
    box.classList.toggle('border-main', !checked);
    box.classList.toggle('border-accents', checked);
    snapshotDay(); // persist smoke state with the rest of the card
  });
}

// -------- highlight current time block --------
function highlightCurrentBlock() {
  const hr = new Date().getHours();
  const cards = document.querySelectorAll('[data-checklist][data-start][data-end]');

  // reset
  cards.forEach(card => {
    card.classList.remove('scale-105', 'z-10', 'shadow-xl');
  });

  // find active: start <= hr < end
  const active = [...cards].find(card => {
    const start = Number(card.dataset.start);
    const end = Number(card.dataset.end);
    return hr >= start && hr < end;
  });

  if (active) active.classList.add('scale-105', 'z-10', 'shadow-xl');
}

// -------- helpers --------
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

// -------- storage --------
function loadJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) ?? JSON.stringify(fallback)); }
  catch { return fallback; }
}
function saveJSON(key, value) { localStorage.setItem(key, JSON.stringify(value)); }

// DOM -> objects
function collectChecklistsFromDOM() {
  const data = {};
  document.querySelectorAll('[data-checklist][data-key]').forEach(card => {
    const key = card.dataset.key;
    const items = [...card.querySelectorAll('[data-checklist-list] > li')].map(li => {
      const label = li.querySelector('[data-role="label"]');
      const cb = li.querySelector('input[type="checkbox"]');
      return { text: (label?.textContent || '').trim(), done: !!(cb && cb.checked) };
    });
    const smokeCb = card.querySelector('[data-smoke] input[type="checkbox"]');
    data[key] = { type: 'checklist', items, smoke: !!(smokeCb && smokeCb.checked) };
  });
  return data;
}
function collectNotesFromDOM() {
  return [...document.querySelectorAll('[data-bullets-list] > li')].map(li => {
    const txt = li.querySelector('[data-role="text"]');
    return { text: (txt?.textContent || '').trim() };
  });
}

// save helpers
function snapshotDay()   { saveJSON(dayKey(), collectChecklistsFromDOM()); }
function snapshotNotes() { saveJSON(GLOBAL_NOTES_KEY, collectNotesFromDOM()); }

// create blank lists for tomorrow once
function ensureEmptyDay(offset = 1) {
  const key = dayKey(offset);
  if (localStorage.getItem(key)) return;
  const empty = {};
  document.querySelectorAll('[data-checklist][data-key]').forEach(card => {
    empty[card.dataset.key] = { type: 'checklist', items: [], smoke: false };
  });
  saveJSON(key, empty);
}

// auto-rollover at midnight (local time)
function scheduleMidnightRollover() {
  const now = new Date();
  const next = new Date(now); next.setHours(24, 0, 0, 0);
  setTimeout(() => {
    ensureEmptyDay(1); // pre-create tomorrow for the new date
    location.reload(); // refresh header/highlight and load new dayKey
  }, next - now);
}
