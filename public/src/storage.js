// localStorage keys, date/day-key builders, and a debounced save queue.
// Firebase push is not done here — storage.js only knows about localStorage;
// firebase-sync.js subscribes via onSave() to mirror writes to Firestore.

export const pad2 = (n) => String(n).padStart(2, "0");
export function ymd(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// Base day anchor. End Day bumps this by one.
export function getBaseDate() {
  const s = localStorage.getItem("planner:baseDate");
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}
export function setBaseDate(d) {
  const dd = new Date(d);
  dd.setHours(0, 0, 0, 0);
  localStorage.setItem("planner:baseDate", dd.toISOString());
}
export function getPlannerDate(offset = 0) {
  let base = getBaseDate();
  if (!base) {
    base = new Date();
    setBaseDate(base);
  }
  const d = new Date(base);
  d.setDate(d.getDate() + offset);
  return d;
}
export function dayKey(offset = 0) {
  return `planner:${ymd(getPlannerDate(offset))}`;
}
export function dayKeyFromDateStr(ds) {
  return `planner:${ds}`;
}

export const GLOBAL_NOTES_KEY = "planner:notes";
export const GLOBAL_COUNTDOWN_KEY = "planner:countdown";
export const DRAWER_KEY = "planner:drawer";
export const TEMPLATES_KEY = "planner:templates:v1";

export function bulletsKey(key, ds = null) {
  if (!key || key === "notes") return GLOBAL_NOTES_KEY;
  const base = ds ? dayKeyFromDateStr(ds) : dayKey();
  return `${base}:bullets:${key}`;
}

// Order-insensitive stand-in for JSON.stringify equality. Firestore's SDK does
// not preserve key insertion order when it returns doc.data(), so a plain
// JSON.stringify(a) !== JSON.stringify(b) reports "changed" for semantically
// identical objects whenever key order differs — which is every time data
// round-trips through Firestore.
export function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}

// key -> last known value (local or remote), so loadJSON reflects an in-flight
// save immediately instead of racing the debounce/localStorage round trip.
const cache = new Map();

export function loadJSON(key, fallback) {
  if (cache.has(key)) {
    try { return structuredClone(cache.get(key)); } catch { return cache.get(key); }
  }
  return loadLocal(key, fallback);
}

// Reads localStorage directly, bypassing the cache. Use this for "the other
// day" (not the page's own actively-managed state) — e.g. carry-over reading
// Today while the page is Tomorrow, or End Day reading both. The cache can
// hold a Firestore snapshot seeded after page load that hasn't caught up with
// a very recent local write yet; going through the cache there risks reading
// (and then persisting) stale data over a fresher local edit.
export function loadLocal(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw != null) return JSON.parse(raw);
  } catch { }
  return fallback;
}

const subscribers = [];
// Register a callback(key, prevValue, nextValue) fired after every saveJSON.
// Used by firebase-sync.js to mirror local writes to Firestore.
export function onSave(callback) {
  subscribers.push(callback);
}

export function saveJSON(key, value) {
  const prev = cache.has(key) ? cache.get(key) : loadJSON(key, undefined);
  cache.set(key, value);
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { }
  subscribers.forEach(fn => { try { fn(key, prev, value); } catch (err) { console.error(err); } });
}

// Seed the cache from a remote source (e.g. a Firestore snapshot) without
// treating it as a local write — no localStorage write, no onSave notify.
export function seedCache(key, value) {
  cache.set(key, value);
}
export function peekCache(key) {
  return cache.has(key) ? cache.get(key) : undefined;
}

export function debounce(fn, ms = 300) {
  let t;
  const wrapped = (...a) => {
    clearTimeout(t);
    wrapped.pending = true;
    t = setTimeout(() => { wrapped.pending = false; fn(...a); }, ms);
  };
  wrapped.pending = false;
  wrapped.flush = (...a) => { clearTimeout(t); wrapped.pending = false; fn(...a); };
  return wrapped;
}

// Per-key debounced save queue: any module can call scheduleSave(key, value)
// without owning its own timer. isSavePending(key) lets callers (the Firebase
// live-refresh guard) avoid clobbering an edit that hasn't flushed yet.
const timers = new Map();
const pendingKeys = new Set();

export function scheduleSave(key, value, ms = 300) {
  cache.set(key, value);
  clearTimeout(timers.get(key));
  pendingKeys.add(key);
  const t = setTimeout(() => {
    timers.delete(key);
    pendingKeys.delete(key);
    saveJSON(key, value);
  }, ms);
  timers.set(key, t);
}
export function saveNow(key, value) {
  clearTimeout(timers.get(key));
  timers.delete(key);
  pendingKeys.delete(key);
  saveJSON(key, value);
}
export function isSavePending(key) {
  return pendingKeys.has(key);
}
