// Drag-to-reorder within a list, and drag-onto-another-item to re-file into
// that item's folder. One delegated listener set per list (attached once,
// since render.js fully rebuilds the list's children on every change).
// Matches the pre-rewrite behavior: dropping only works onto another item row,
// not directly onto an empty folder's header (there's nothing there to drop on).

let dragSrc = null;

export function isDragging() { return !!dragSrc; }

export function makeSortable(listEl, { onReorder }) {
  listEl.addEventListener("dragstart", (e) => {
    const li = e.target.closest("li[data-item-id]");
    if (!li) { e.preventDefault(); return; }
    const label = li.querySelector('[data-role="label"]');
    if (label?.isContentEditable || e.target.closest("button,input,[contenteditable='true']")) {
      e.preventDefault();
      return;
    }
    dragSrc = li;
    li.classList.add("opacity-50");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", li.dataset.itemId);
  });

  listEl.addEventListener("dragover", (e) => {
    const li = e.target.closest("li[data-item-id]");
    if (!li) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  });

  listEl.addEventListener("drop", (e) => {
    const li = e.target.closest("li[data-item-id]");
    if (!li || !dragSrc || dragSrc === li) return;
    e.preventDefault();

    const items = [...listEl.children];
    const src = items.indexOf(dragSrc);
    const dst = items.indexOf(li);
    if (src < dst) listEl.insertBefore(dragSrc, li.nextSibling); else listEl.insertBefore(dragSrc, li);

    // New folder = whichever header this row now sits under (empty for time
    // cards, which never have folder headers at all).
    let p = dragSrc.previousElementSibling;
    let newFolder = "";
    while (p) {
      if (p.hasAttribute("data-folder-header")) {
        newFolder = p.dataset.folderHeader === "__none" ? "" : p.dataset.folderHeader;
        break;
      }
      p = p.previousElementSibling;
    }

    const orderedIds = [...listEl.querySelectorAll("li[data-item-id]")].map(n => n.dataset.itemId);
    onReorder(dragSrc.dataset.itemId, newFolder, orderedIds);
  });

  listEl.addEventListener("dragend", (e) => {
    const li = e.target.closest("li[data-item-id]");
    li?.classList.remove("opacity-50");
    dragSrc = null;
  });
}
