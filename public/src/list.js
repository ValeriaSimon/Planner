// Shared checklist + bullets wiring. Checklists have checkboxes and persisted
// empty-folder headers; bullets have neither. Everything else — folder
// filing/deletion, inline edit, drag reorder, "Clear checked" — is identical,
// so both are driven by the same wireList(root, { checkable }).

import * as state from "./state.js";
import { parseEntries, parseItemAndTags, normalizeFolderPath, capFirst, norm } from "./parsing.js";
import { placeCaretEnd } from "./dom.js";
import { renderCard } from "./render.js";
import { makeSortable } from "./dragdrop.js";

export function wireList(root, { checkable }) {
  if (root.__wiredList) return;
  root.__wiredList = true;

  const cardKey = root.dataset.key;
  const form = root.querySelector(checkable ? "[data-checklist-form]" : "[data-bullets-form]");
  const input = root.querySelector(checkable ? "[data-checklist-input]" : "[data-bullets-input]");
  const list = root.querySelector(checkable ? "[data-checklist-list]" : "[data-bullets-list]");
  if (!cardKey || !form || !input || !list) return;

  const isTimeCard = state.TIME_KEYS.includes(cardKey);

  if (checkable) state.registerChecklistCard(cardKey);
  else state.registerBulletCard(cardKey);

  function getItems() {
    return checkable ? (state.getCard(cardKey)?.items || []) : state.getBulletItems(cardKey);
  }

  // fn(items, { ensureFolder, removeFolder }) — ensureFolder/removeFolder are
  // no-ops for bullets, which have no persisted empty-folder registry.
  function mutateItems(fn) {
    if (checkable) {
      state.mutate(cardKey, (card, helpers) => {
        card.items = card.items || [];
        fn(card.items, helpers);
      });
    } else {
      state.mutateBullets(cardKey, (items) => {
        fn(items, { ensureFolder() {}, removeFolder() {} });
      });
    }
  }

  function findDup(folder, normText) {
    return getItems().some(it => (it.folder || "") === folder && norm(it.text) === normText);
  }

  function addItem(text, folder = "") {
    mutateItems((items, { ensureFolder }) => {
      items.push(checkable ? { text, done: false, folder } : { text, folder });
      if (!isTimeCard) ensureFolder(folder);
    });
  }

  function removeItem(itemId) {
    mutateItems((items) => {
      const idx = items.findIndex(it => it.id === itemId);
      if (idx >= 0) items.splice(idx, 1);
    });
  }

  function deleteFolderCommand(rawPath) {
    if (isTimeCard) return;
    const path = normalizeFolderPath(rawPath);

    if (path === "") {
      const hasItems = getItems().some(it => (it.folder || "") === "");
      if (hasItems) { alert('Cannot delete "Unfiled" while it has items.'); return; }
      mutateItems((items, { removeFolder }) => removeFolder(""));
      return;
    }

    const exists = checkable
      ? state.getCardFolders(cardKey).includes(path) || getItems().some(it => (it.folder || "") === path)
      : getItems().some(it => (it.folder || "") === path);
    if (!exists) return;

    mutateItems((items, { removeFolder }) => {
      const keptTexts = new Set(items.filter(it => (it.folder || "") === "").map(it => norm(it.text)));
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if ((it.folder || "") !== path) continue;
        const n = norm(it.text);
        if (keptTexts.has(n)) items.splice(i, 1);
        else { it.folder = ""; keptTexts.add(n); }
      }
      removeFolder(path);
    });
  }

  function submitEntry({ del, text, folders }) {
    if (isTimeCard) { if (text) addItem(capFirst(text), ""); return; }
    if (del) { deleteFolderCommand(del); return; }

    const haveFolders = folders && folders.length;
    if (!text) {
      if (haveFolders) mutateItems((items, { ensureFolder }) => folders.forEach(f => ensureFolder(f)));
      return;
    }

    const normText = norm(capFirst(text));
    if (haveFolders) {
      folders.forEach(f => { if (!findDup(f, normText)) addItem(capFirst(text), f); });
    } else if (!findDup("", normText)) {
      addItem(capFirst(text), "");
    }
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const raw = (input.value || "").trim();
    if (!raw) return;
    parseEntries(raw, { isTimeCard }).forEach(submitEntry);
    input.value = "";
  });

  input.addEventListener("blur", () => { input.value = capFirst(input.value); });

  // --- Inline edit ---

  function startInlineEdit(li, editBtn) {
    const labelEl = li.querySelector('[data-role="label"]');
    if (!labelEl || labelEl.isContentEditable) return;
    const rowLabel = checkable ? li.querySelector("label") : null;
    const cb = checkable ? li.querySelector('input[data-role="checkbox"]') : null;
    const itemId = li.dataset.itemId;
    const original = labelEl.textContent;

    labelEl.contentEditable = "true";
    labelEl.classList.add("outline-none");
    if (checkable) { rowLabel?.removeAttribute("for"); if (cb) cb.disabled = true; }
    labelEl.focus();
    placeCaretEnd(labelEl);

    function cleanup() {
      labelEl.removeEventListener("keydown", onKey);
      labelEl.removeEventListener("blur", commit);
    }

    // cleanup() runs first: committing triggers a full re-render that removes
    // this li (and, if it was focused, synchronously fires blur on labelEl) —
    // without detaching the listeners first, that blur would re-enter commit().
    function commit() {
      cleanup();
      const text = (labelEl.textContent || "").trim();
      if (!text) { removeItem(itemId); return; }

      const parsed = parseItemAndTags(text, { isTimeCard });
      const newText = capFirst(parsed.text || "");
      const destFolder = (!isTimeCard && parsed.folders && parsed.folders.length) ? parsed.folders[0] : null;

      mutateItems((items, { ensureFolder }) => {
        const item = items.find(it => it.id === itemId);
        if (!item) return;
        item.text = newText;
        if (destFolder !== null && String(item.folder || "") !== String(destFolder)) {
          const normText = norm(newText);
          const dupIdx = items.findIndex(it => it.id !== itemId && (it.folder || "") === destFolder && norm(it.text) === normText);
          if (dupIdx >= 0) {
            const selfIdx = items.findIndex(it => it.id === itemId);
            if (selfIdx >= 0) items.splice(selfIdx, 1);
          } else {
            item.folder = destFolder;
            ensureFolder(destFolder);
          }
        }
      });

      root.querySelector(`[data-role="edit"]`)?.focus();
    }
    function cancel() {
      cleanup();
      labelEl.textContent = original;
      labelEl.contentEditable = "false";
      labelEl.classList.remove("outline-none");
      if (checkable) { rowLabel?.setAttribute("for", `cb-${itemId}`); if (cb) cb.disabled = false; }
      editBtn.focus();
    }
    function onKey(e) {
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      if (e.key === "Escape") { e.preventDefault(); cancel(); }
    }
    labelEl.addEventListener("keydown", onKey);
    labelEl.addEventListener("blur", commit);
  }

  // --- Delegated clicks: folder-header collapse, edit, delete ---

  list.addEventListener("click", (e) => {
    const header = e.target.closest("li[data-folder-header]");
    if (header) {
      const caretIcon = e.target.closest("i.collapseFolderCaret");
      const folderKey = header.dataset.folderHeader === "__none" ? "" : header.dataset.folderHeader;
      const next = !header.hasAttribute("data-collapsed");
      if (caretIcon && (e.altKey || e.metaKey)) {
        [...list.querySelectorAll("li[data-folder-header]")].forEach(h => {
          const k = h.dataset.folderHeader === "__none" ? "" : h.dataset.folderHeader;
          state.setFolderCollapsed(cardKey, k, next);
        });
      } else {
        state.setFolderCollapsed(cardKey, folderKey, next);
      }
      renderCard(root);
      return;
    }

    const delBtn = e.target.closest('[data-role="delete"]');
    if (delBtn) {
      const li = delBtn.closest("li[data-item-id]");
      if (li) removeItem(li.dataset.itemId);
      return;
    }

    const editBtn = e.target.closest('[data-role="edit"]');
    if (editBtn) {
      const li = editBtn.closest("li[data-item-id]");
      if (li) startInlineEdit(li, editBtn);
      return;
    }
  });

  // --- Checkbox toggle (checklist only) ---

  if (checkable) {
    list.addEventListener("change", (e) => {
      const cb = e.target.closest('input[data-role="checkbox"]');
      if (!cb) return;
      const li = cb.closest("li[data-item-id]");
      const itemId = li?.dataset.itemId;
      state.mutate(cardKey, (card) => {
        const item = (card.items || []).find(it => it.id === itemId);
        if (item) item.done = cb.checked;
      });
    });
  }

  // --- Drag reorder ---

  makeSortable(list, {
    onReorder(movedId, newFolder, orderedIds) {
      mutateItems((items, { ensureFolder }) => {
        const byId = new Map(items.map(it => [it.id, it]));
        const moved = byId.get(movedId);
        if (moved) {
          moved.folder = isTimeCard ? "" : newFolder;
          if (!isTimeCard) ensureFolder(moved.folder);
        }
        const reordered = orderedIds.map(id => byId.get(id)).filter(Boolean);
        items.length = 0;
        items.push(...reordered);
      });
    },
  });

  // --- Clear checked (checklist cards only; button is absent on time cards) ---

  if (checkable) {
    const clearBtn = root.querySelector("[data-clear-checked]");
    clearBtn?.addEventListener("click", () => {
      const texts = getItems().filter(it => it.done).map(it => it.text).filter(Boolean);
      if (texts.length) {
        state.mutateMeta((d) => {
          const arch = d.__clearedDone || (d.__clearedDone = {});
          arch[cardKey] = [...(arch[cardKey] || []), ...texts];
        });
      }
      state.mutate(cardKey, (card) => {
        card.items = (card.items || []).filter(it => !it.done);
      });
    });
  }
}
