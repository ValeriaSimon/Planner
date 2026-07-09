// Export/import of the same {version, date, day, bullets, notes, drawer} JSON
// shape as the pre-rewrite app, plus the optional File System Access archive
// folder (Chromium-only; falls back to a plain download everywhere else).

import {
  dayKey, dayKeyFromDateStr, bulletsKey, GLOBAL_NOTES_KEY, DRAWER_KEY,
  getPlannerDate, ymd, loadJSON, loadLocal, saveJSON,
} from "./storage.js";
import * as state from "./state.js";
import { norm } from "./parsing.js";

const BULLET_KEYS = ["food", "notes"];

function readBulletsForDate(ds) {
  const out = {};
  BULLET_KEYS.forEach((key) => {
    const items = loadLocal(bulletsKey(key, ds), []);
    out[key] = { items: Array.isArray(items) ? items : [] };
  });
  return out;
}

// Re-materializes archived "Clear checked" items into the export as done:true
// entries, so a downloaded backup shows full history, not just active items.
function mergeClearedIntoDayObj(dayObj, arch) {
  if (!arch) return dayObj;
  Object.keys(arch).forEach((key) => {
    const cleared = arch[key] || [];
    if (!cleared.length) return;
    if (!dayObj[key]) dayObj[key] = { type: "checklist", items: [], smoke: false };
    const have = new Set((dayObj[key].items || []).map((it) => norm(it.text)));
    cleared.forEach((t) => {
      const text = typeof t === "string" ? t : (t?.text || "");
      const n = norm(text);
      if (text && !have.has(n)) dayObj[key].items.push({ text, done: true });
    });
  });
  return dayObj;
}

export function buildExport(offset) {
  const ds = ymd(getPlannerDate(offset));
  const isCurrentPage = offset === state.getOffset();

  let dayObj, bullets;
  if (isCurrentPage) {
    dayObj = JSON.parse(JSON.stringify(state.getDay()));
    bullets = {};
    BULLET_KEYS.forEach(key => { bullets[key] = { items: state.getBulletItems(key) }; });
  } else {
    dayObj = loadLocal(dayKey(offset), {}) || {};
    bullets = readBulletsForDate(ds);
  }
  mergeClearedIntoDayObj(dayObj, dayObj.__clearedDone);

  return {
    filename: `${ds}-planner.json`,
    payload: {
      version: 2,
      date: ds,
      day: dayObj,
      bullets,
      notes: loadJSON(GLOBAL_NOTES_KEY, []),
      drawer: loadJSON(DRAWER_KEY, []),
    },
  };
}

export function saveViaHref(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
}

export function downloadDayViaHref(offset) {
  const { filename, payload } = buildExport(offset);
  saveViaHref(filename, payload);
}

// --- Archive folder (File System Access API, Chromium-only) ---

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

function monthYearFolderName(d = new Date()) {
  return `${d.toLocaleString("en-US", { month: "long" })}${d.getFullYear()}`;
}

export async function getArchiveRootHandle() {
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

export async function setArchiveRootHandle() {
  if (!window.showDirectoryPicker) {
    alert("Your browser doesn't support picking a folder for auto-export (Chrome/Edge only).");
    return;
  }
  try {
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    await idb.put(FS_KEYS.ARCHIVE_ROOT, handle);
    alert(`Archive folder set to "${handle.name}". End Day will now save here automatically.`);
  } catch {
    // user cancelled the picker
  }
}

async function writeJSONToArchive(rootHandle, filename, payload) {
  const monthDir = await rootHandle.getDirectoryHandle(monthYearFolderName(), { create: true });
  const fileHandle = await monthDir.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(JSON.stringify(payload, null, 2));
  await writable.close();
}

export async function archiveDay(rootHandle, offset) {
  const { filename, payload } = buildExport(offset);
  try {
    await writeJSONToArchive(rootHandle, filename, payload);
  } catch (err) {
    console.warn("Archive write failed, falling back to download:", err);
    saveViaHref(filename, payload);
  }
}

async function pickFileFromRememberedDir() {
  const opts = {
    types: [{ description: "Planner JSON", accept: { "application/json": [".json"] } }],
    multiple: false,
    excludeAcceptAllOption: true,
  };

  if (window.showOpenFilePicker) {
    try {
      const last = await idb.get(FS_KEYS.OPEN_START);
      if (last?.queryPermission) {
        let p = await last.queryPermission({ mode: "read" });
        if (p === "prompt" && last.requestPermission) p = await last.requestPermission({ mode: "read" });
        if (p === "granted" || p === "prompt") opts.startIn = last;
      }
    } catch { /* ignore stale handle */ }

    try {
      const [h] = await window.showOpenFilePicker(opts);
      try { await idb.put(FS_KEYS.OPEN_START, h); } catch { }
      return await h.getFile();
    } catch (err) {
      if (opts.startIn) {
        delete opts.startIn;
        const [h] = await window.showOpenFilePicker(opts);
        try { await idb.put(FS_KEYS.OPEN_START, h); } catch { }
        return await h.getFile();
      }
      throw err;
    }
  }

  return new Promise((res, rej) => {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = "application/json";
    inp.onchange = () => res(inp.files[0]);
    inp.onerror = rej;
    inp.click();
  });
}

// Reads a chosen backup file and writes it into storage. Returns
// { ds, isCurrentPage } on success so the caller can decide whether to reload.
export async function restoreFromFile() {
  const file = await pickFileFromRememberedDir();
  const text = await file.text();
  const data = JSON.parse(text);

  const ds = data.date || (file.name.match(/^(\d{4}-\d{2}-\d{2})-planner\.json$/)?.[1]) || ymd(getPlannerDate(state.getOffset()));
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

  const currentDS = ymd(getPlannerDate(state.getOffset()));
  const isCurrentPage = ds === currentDS;

  if (isCurrentPage) {
    // Restoring today's backup can leave tomorrow's carried-over items stale;
    // wipe tomorrow so the next carry-over sync rebuilds it fresh from what
    // was just restored.
    const tomorrowDS = ymd(getPlannerDate(1));
    saveJSON(dayKeyFromDateStr(tomorrowDS), {});
    saveJSON(bulletsKey("food", tomorrowDS), []);
  }

  return { ds, isCurrentPage };
}
