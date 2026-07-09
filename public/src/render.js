// Rebuilds one card's <ul> from state on every change (no diffing). list.js
// wires all behavior via delegated listeners on the card root, so a full
// rebuild here never has to reattach per-item handlers.

import { TIME_KEYS, getCard, getCardFolders, getBulletItems, getFolderCollapsed } from "./state.js";
import { displayFolder } from "./parsing.js";
import { el, svgCheck } from "./dom.js";

let seq = 0;
function genId() { return `i${Date.now().toString(36)}${(seq++).toString(36)}`; }

function ensureIds(items) {
  items.forEach(it => { if (!it.id) it.id = genId(); });
}

export function renderCard(root) {
  if (!root) return;
  const checkable = root.matches("[data-checklist]");
  const cardKey = root.dataset.key;
  const list = root.querySelector(checkable ? "[data-checklist-list]" : "[data-bullets-list]");
  if (!cardKey || !list) return;

  const isTimeCard = TIME_KEYS.includes(cardKey);
  const items = checkable ? (getCard(cardKey)?.items || []) : getBulletItems(cardKey);
  ensureIds(items);

  list.innerHTML = "";

  if (isTimeCard) {
    items.forEach(item => list.appendChild(buildRow(item, { checkable, cardKey, folder: "" })));
    updateClearCheckedVisibility(root);
    return;
  }

  // Folder order: persisted registry first (checklist cards only — bullets have
  // no persisted empty-folder registry, matching the pre-rewrite app), then any
  // folder discovered in items that isn't registered yet, in first-seen order.
  const order = checkable ? getCardFolders(cardKey).slice() : [];
  items.forEach(it => {
    const f = it.folder || "";
    if (!order.includes(f)) order.push(f);
  });
  if (!order.includes("")) order.push("");

  order.forEach(folderKey => {
    const inFolder = items.filter(it => (it.folder || "") === folderKey);
    const header = buildFolderHeader(cardKey, folderKey, inFolder.length);
    if (folderKey === "" && inFolder.length === 0) header.classList.add("hidden");
    list.appendChild(header);

    const collapsed = getFolderCollapsed(cardKey, folderKey);
    // Non-time checklist cards sink checked items to the bottom of their own
    // folder group; bullets have no checked state; time cards never reach here.
    const ordered = checkable
      ? [...inFolder.filter(it => !it.done), ...inFolder.filter(it => it.done)]
      : inFolder;
    ordered.forEach(item => {
      const row = buildRow(item, { checkable, cardKey, folder: folderKey });
      if (collapsed) row.classList.add("hidden");
      list.appendChild(row);
    });
  });

  updateClearCheckedVisibility(root);
}

// Shown only when the card is expanded and has at least one checked item.
// Called from renderCard (item list changed) and from the card-collapse
// toggle in day-view.js (collapse state changed, item list didn't).
export function updateClearCheckedVisibility(root) {
  const btn = root.querySelector("[data-clear-checked]");
  if (!btn) return;
  const list = root.querySelector("[data-checklist-list]");
  const collapsed = root.hasAttribute("data-collapsed");
  const anyChecked = !collapsed && !!list?.querySelector('input[data-role="checkbox"]:checked');
  btn.classList.toggle("hidden", !anyChecked);
}

function buildFolderHeader(cardKey, folderKey, count) {
  const header = el("li", "mt-4 px-3 py-1 flex items-center justify-between bg-white/70");
  header.setAttribute("data-folder-header", folderKey || "__none");

  const left = el("div", "flex items-center gap-2");
  const caret = el("i", "fa-solid fa-caret-up collapseFolderCaret text-neutral hover:cursor-pointer");
  const name = el("span", "font-sec font-bold text-accents", folderKey ? displayFolder(folderKey) : "Unfiled");
  left.append(caret, name);

  const countEl = el("span", "text-sm text-accents/60", String(count));
  countEl.setAttribute("data-count", "1");
  header.append(left, countEl);

  if (getFolderCollapsed(cardKey, folderKey)) {
    caret.classList.remove("fa-caret-up");
    caret.classList.add("fa-caret-down");
    header.setAttribute("data-collapsed", "1");
  }
  return header;
}

function buildRow(item, { checkable, cardKey, folder }) {
  const li = el("li", "mt-3 flex items-center gap-2 px-3");
  li.dataset.folder = folder;
  li.dataset.itemId = item.id;
  li.draggable = true;

  const handle = el("span", "ml-1 cursor-grab select-none text-accents/60", "⋮⋮");
  handle.setAttribute("data-handle", "1");

  const labelEl = el("span", "flex-1 text-accents font-bold tracking-wide text-xl font-sec", item.text);
  labelEl.setAttribute("data-role", "label");

  const edit = el("button", "px-2 py-1 rounded-md text-accents/80 hover:text-white hover:bg-neutral transition-colors", "✎");
  edit.type = "button"; edit.title = "Edit"; edit.setAttribute("data-role", "edit");

  const del = el("button", "px-2 py-1 rounded-md text-red-400 hover:text-white hover:bg-neutral transition-colors", "✕");
  del.type = "button"; del.title = `Remove "${item.text}"`; del.setAttribute("data-role", "delete");

  if (checkable) {
    const row = el("label", "flex items-center gap-3 flex-1");
    const inputId = `cb-${item.id}`;
    row.setAttribute("for", inputId);

    const cb = el("input", "sr-only");
    cb.type = "checkbox";
    cb.id = inputId;
    cb.checked = !!item.done;
    cb.setAttribute("data-role", "checkbox");

    const boxWrap = el("span", "relative inline-flex items-center justify-center w-5 h-5");
    const box = el("span", "w-5 h-5 rounded bg-white border-2 border-neutral pointer-events-none");
    box.setAttribute("aria-hidden", "true");
    box.classList.toggle("border-main", !item.done);
    box.classList.toggle("border-accents", !!item.done);

    const icon = svgCheck();
    icon.setAttribute("aria-hidden", item.done ? "false" : "true");
    icon.classList.add("absolute", "pointer-events-none");
    icon.classList.toggle("opacity-0", !item.done);
    icon.classList.toggle("opacity-100", !!item.done);
    boxWrap.append(box, icon);

    labelEl.classList.toggle("line-through", !!item.done);

    row.append(cb, boxWrap, labelEl);
    li.append(handle, row, edit, del);

    if (!TIME_KEYS.includes(cardKey) && item.done) li.classList.add("opacity-30");
  } else {
    li.append(handle, labelEl, edit, del);
  }

  return li;
}
