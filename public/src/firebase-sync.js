// Mirrors local writes to Firestore (field-level patches on the day doc, so
// two devices editing different fields around the same time never clobber
// each other) and applies incoming remote changes back to local state.
//
// Local always wins until proven stale: an incoming day-doc snapshot is only
// applied if its __lastModified is newer than our own — otherwise it's either
// our own write echoing back, or a snapshot that raced an edit we made a
// moment ago. This is what closes the original race (an edit within ~2s of
// page load could vanish when the initial snapshot arrived and blindly
// overwrote local state).

import {
  doc, setDoc, getDoc, onSnapshot, collection, deleteField,
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";
import { auth, db } from "./firebase-init.js";
import * as state from "./state.js";
import { isDragging } from "./dragdrop.js";
import { isEndingDay } from "./endday.js";
import { handleDrawerRemoteChange } from "./drawer.js";
import {
  dayKey, GLOBAL_NOTES_KEY, GLOBAL_COUNTDOWN_KEY, DRAWER_KEY,
  getPlannerDate, ymd,
  onSave, seedCache, peekCache, stableStringify, debounce,
} from "./storage.js";

// --- Push: mirror every local save to Firestore ---

onSave(async (key, prevValue, nextValue) => {
  const u = auth.currentUser;
  if (!u) return;

  const m = String(key).match(/^planner:(\d{4}-\d{2}-\d{2})(?::bullets:(.+))?$/);
  if (key === GLOBAL_NOTES_KEY) {
    await setDoc(doc(db, "users", u.uid, "meta", "notes"), { items: nextValue || [] });
  } else if (key === GLOBAL_COUNTDOWN_KEY) {
    await setDoc(doc(db, "users", u.uid, "meta", "countdown"), nextValue || {});
  } else if (key === DRAWER_KEY) {
    await setDoc(doc(db, "users", u.uid, "meta", "drawer"), { items: nextValue || [] });
  } else if (m && m[1] && !m[2]) {
    await saveDayDocPatch(u, m[1], prevValue, nextValue);
  } else if (m && m[1] && m[2]) {
    await setDoc(doc(db, "users", u.uid, "days", m[1], "bullets", m[2]), { items: nextValue || [] });
  }
});

// The day doc holds many independently-owned top-level fields (each
// checklist card, __ui, __smokes, ...). Both household members share one
// Firestore account from separate devices, so a full-document setDoc() here
// would race: whichever device's write reaches the server last would discard
// every field the other device touched. Patch only the fields that actually
// changed via mergeFields, leaving everything else on the server alone.
async function saveDayDocPatch(user, ds, prevObj, nextObj) {
  const prev = prevObj || {};
  const next = nextObj || {};
  const patch = {};
  const fields = [];
  Object.keys(next).forEach((k) => {
    if (stableStringify(prev[k]) !== stableStringify(next[k])) { patch[k] = next[k]; fields.push(k); }
  });
  Object.keys(prev).forEach((k) => {
    if (!(k in next)) { patch[k] = deleteField(); fields.push(k); }
  });
  if (!fields.length) return;
  const ref = doc(db, "users", user.uid, "days", ds);
  await setDoc(ref, patch, { mergeFields: fields });
}

// --- Pull: live refresh, guarded so it never yanks the UI from under an
// active edit, drag, or an edit still debounced and not yet saved ---

function isSafeToRerenderNow() {
  if (isDragging()) return false;
  if (isEndingDay()) return false;
  if (document.querySelector('[contenteditable="true"]')) return false;
  if (state.isSaveDayPending()) return false;
  return true;
}
let liveRefreshRetries = 0;
function attemptLiveRefresh() {
  if (!isSafeToRerenderNow()) {
    if (liveRefreshRetries++ < 10) setTimeout(attemptLiveRefresh, 1500);
    return;
  }
  liveRefreshRetries = 0;

  // Whatever triggered this (day doc, bullets, or notes change), only ever
  // adopt the cached day-doc value if it's actually newer than our current
  // local state — otherwise a stale getDoc()/onSnapshot payload (e.g. our own
  // recent write not yet visible server-side) would clobber a fresher local
  // edit instead of just being ignored.
  const cachedDay = peekCache(dayKey(state.getOffset()));
  const localModified = state.getDay()?.__lastModified || 0;
  const remoteModified = cachedDay?.__lastModified || 0;
  if (cachedDay && remoteModified > localModified) {
    state.replaceDay(cachedDay);
  }
  state.reloadBulletCards();
  state.triggerFullRefresh();
}
const liveRefreshDebounced = debounce(attemptLiveRefresh, 250);

// "Today" is decided by planner:baseDate, per-device in localStorage. Mirror
// it to Firestore so whichever device ends the day pushes the new value, and
// the other device picks it up and reloads onto it.
async function syncBaseDate(user) {
  const ref = doc(db, "users", user.uid, "meta", "baseDate");

  function applyRemote(remoteISO) {
    if (!remoteISO || remoteISO === localStorage.getItem("planner:baseDate")) return;
    localStorage.setItem("planner:baseDate", remoteISO);
    location.reload();
  }

  const snap = await getDoc(ref);
  if (snap.exists() && snap.data()?.value) {
    applyRemote(snap.data().value);
  } else {
    const localISO = localStorage.getItem("planner:baseDate");
    if (localISO) await setDoc(ref, { value: localISO });
  }

  onSnapshot(ref, d => applyRemote(d.data()?.value));
}

// Called right after End Day advances the local baseDate, so the other
// device's syncBaseDate() listener picks up the new day.
export async function pushBaseDateToRemote() {
  const u = auth.currentUser;
  if (!u) return;
  const iso = localStorage.getItem("planner:baseDate");
  if (!iso) return;
  await setDoc(doc(db, "users", u.uid, "meta", "baseDate"), { value: iso });
}

export function startFirebaseSync(user) {
  // prevent duplicate listeners across re-inits
  window.__fbUnsubs?.forEach(fn => { try { fn(); } catch { } });
  window.__fbUnsubs = [];

  syncBaseDate(user);

  const today = ymd(getPlannerDate(0));
  const tomorrow = ymd(getPlannerDate(1));
  const daysToWatch = [today, tomorrow];
  const currentDS = ymd(getPlannerDate(state.getOffset()));

  daysToWatch.forEach(async (ds) => {
    const dayKeyStr = `planner:${ds}`;
    const isCurrentPageDay = ds === currentDS;
    const ref = doc(db, "users", user.uid, "days", ds);
    const snap = await getDoc(ref);
    seedCache(dayKeyStr, snap.exists() ? (snap.data() || {}) : {});

    const unsubDay = onSnapshot(ref, (d) => {
      const next = d.exists() ? (d.data() || {}) : {};
      const changed = stableStringify(peekCache(dayKeyStr)) !== stableStringify(next);
      seedCache(dayKeyStr, next);
      if (!changed || !isCurrentPageDay) return;

      // Only accept if it isn't older than what we already have locally —
      // otherwise this is our own write echoing back, or a snapshot that
      // raced an edit we just made.
      const localModified = state.getDay()?.__lastModified || 0;
      const remoteModified = next.__lastModified || 0;
      if (remoteModified < localModified) return;
      liveRefreshDebounced();
    });
    window.__fbUnsubs.push(unsubDay);

    const col = collection(db, "users", user.uid, "days", ds, "bullets");
    const unsubBullets = onSnapshot(col, (qs) => {
      let changed = false;
      qs.forEach((docSnap) => {
        const bulletsKeyStr = `planner:${ds}:bullets:${docSnap.id}`;
        const next = docSnap.data()?.items || [];
        if (stableStringify(peekCache(bulletsKeyStr)) !== stableStringify(next)) changed = true;
        seedCache(bulletsKeyStr, next);
      });
      if (changed && isCurrentPageDay) liveRefreshDebounced();
    });
    window.__fbUnsubs.push(unsubBullets);
  });

  onSnapshot(doc(db, "users", user.uid, "meta", "notes"), (d) => {
    const next = d.data()?.items || [];
    const changed = stableStringify(peekCache(GLOBAL_NOTES_KEY)) !== stableStringify(next);
    seedCache(GLOBAL_NOTES_KEY, next);
    if (changed) liveRefreshDebounced();
  });
  onSnapshot(doc(db, "users", user.uid, "meta", "countdown"),
    (d) => seedCache(GLOBAL_COUNTDOWN_KEY, d.data() || null));
  onSnapshot(doc(db, "users", user.uid, "meta", "drawer"), (d) => {
    const next = d.data()?.items || [];
    const changed = stableStringify(peekCache(DRAWER_KEY)) !== stableStringify(next);
    seedCache(DRAWER_KEY, next);
    if (changed) handleDrawerRemoteChange();
  });
}
