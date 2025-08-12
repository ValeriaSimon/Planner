// main.js
document.addEventListener('DOMContentLoaded', () => {
  // ---- header date ----
  const pageTitle = document.getElementById("page-title");
  const todayEl = document.getElementById("today");
  const d = new Date();
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

  // ---- wire every checklist card ----
  document.querySelectorAll('[data-checklist]').forEach(wireChecklist);
  document.querySelectorAll('[data-bullets]').forEach(wireBullets);

  restoreAll();

  // ---- highlight current time block ----
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

  // Download button
  document.getElementById('download-today')?.addEventListener('click', () => {
    const data = collectDataFromDOM();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${TODAY_KEY.replace('planner:', '')}-planner.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
});

function restoreAll() {
  const saved = loadToday();
  // checklists
  document.querySelectorAll('[data-checklist][data-key]').forEach(card => {
    const key = card.dataset.key;
    const entry = saved[key];
    if (!entry || !Array.isArray(entry.items)) return;
    const add = card.__addChecklistItem; // we'll set this below
    if (!add) return;
    let restoring = true;
    entry.items.forEach(it => add(it.text, !!it.done, restoring));
  });

  // bullets
  document.querySelectorAll('[data-bullets][data-key]').forEach(card => {
    const key = card.dataset.key;
    const entry = saved[key];
    if (!entry || !Array.isArray(entry.items)) return;
    const add = card.__addBulletItem; // we'll set this below
    if (!add) return;
    let restoring = true;
    entry.items.forEach(it => add(it.text, restoring));
  });
}

/** Attach behavior to a single card */
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

    const label = el('span', "flex-1 text-accents font-bold  tracking-wide text-xl font-sec decoration-main decoration-2 mt-3", labelText);
    label.setAttribute('data-role', 'label'); // <-- tag for persistence

    cb.addEventListener('change', () => {
      const checked = cb.checked;
      label.classList.toggle('line-through', checked);
      icon.style.opacity = checked ? "1" : "0";
      icon.setAttribute('aria-hidden', checked ? "false" : "true");
      box.classList.toggle('border-main', !checked);
      box.classList.toggle('border-accents', checked);
      if (!suppressSave) snapshotAndSave();
    });

    const del = el('button', "rounded-md px-2 py-1 text-red-400 hover:text-white hover:bg-neutral transition-colors transition", '✕');
    del.type = 'button';
    del.title = 'Remove';
    del.addEventListener('click', () => { li.remove(); if (!suppressSave) snapshotAndSave(); });

    row.append(cb, box, label);
    li.append(row, del);
    list.appendChild(li);

    // apply preset state
    suppressSave = true;
    cb.checked = !!done;
    cb.dispatchEvent(new Event('change'));
    suppressSave = false;

    if (!restoring) snapshotAndSave();
  }

  // expose add for restoreAll()
  root.__addChecklistItem = (text, done = false, restoring = false) => addItem(text, done, restoring);

  const smoke = root.querySelector('[data-smoke]');
  if (smoke) wireSmoke(smoke);
}
function wireBullets(root) {
  const form  = root.querySelector('[data-bullets-form]');
  const input = root.querySelector('[data-bullets-input]');
  const list  = root.querySelector('[data-bullets-list]');
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

  // allow restore flag to avoid double-saves while rebuilding
  function addItem(text, restoring = false) {
    const li  = el('li', "mt-3");
    const row = el('div', "flex items-center gap-3");

    const txt = el('span', "text-accents font-bold tracking-wide text-xl font-sec");
    txt.textContent = text;
    txt.setAttribute('data-role','text'); // ✅ tag for persistence

    const del = el(
      'button',
      "ml-auto inline-flex items-center justify-center size-6 rounded-md " +
      "text-red-400 hover:text-white hover:bg-neutral transition-colors",
      '✕'
    );
    del.type  = 'button';
    del.title = 'Remove';
    del.setAttribute('aria-label', `Remove "${text}"`);
    del.addEventListener('click', () => { li.remove(); snapshotAndSave(); });

    row.append(txt, del);
    li.appendChild(row);
    list.appendChild(li);

    if (!restoring) snapshotAndSave(); // ✅ save after add
  }

  // ✅ expose for restoreAll()
  root.__addBulletItem = (text, restoring = false) => addItem(text, restoring);
}



/** Smoke toggle wiring (no duplicate ids) */
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
  });

}
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

  if (active) {
    // gentle pop without affecting layout flow (transform doesn't reflow)
    active.classList.add('scale-105', 'z-10', 'shadow-xl');
  }
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

// ---- daily storage helpers ----
const TODAY_KEY = (() => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `planner:${y}-${m}-${day}`;
})();

function loadToday() {
  try { return JSON.parse(localStorage.getItem(TODAY_KEY) || '{}'); }
  catch { return {}; }
}

function saveToday(obj) {
  localStorage.setItem(TODAY_KEY, JSON.stringify(obj));
}

// Walk the DOM and build the whole-day snapshot
function collectDataFromDOM() {
  const data = {};

  // checklists
  document.querySelectorAll('[data-checklist][data-key]').forEach(card => {
    const key = card.dataset.key;
    const items = [...card.querySelectorAll('[data-checklist-list] > li')].map(li => {
      const label = li.querySelector('[data-role="label"]');
      const cb = li.querySelector('input[type="checkbox"]');
      return { text: (label?.textContent || '').trim(), done: !!(cb && cb.checked) };
    });
    data[key] = { type: 'checklist', items };
  });

  // bullets
  document.querySelectorAll('[data-bullets][data-key]').forEach(card => {
    const key = card.dataset.key;
    const items = [...card.querySelectorAll('[data-bullets-list] > li')].map(li => {
      const txt = li.querySelector('[data-role="text"]');
      return { text: (txt?.textContent || '').trim() };
    });
    data[key] = { type: 'bullets', items };
  });

  return data;
}

function snapshotAndSave() {
  saveToday(collectDataFromDOM());
}


