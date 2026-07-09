// Time-card-only checklist templates: save the current list under a name,
// apply inserts any missing items, delete removes the saved template.

import * as state from "./state.js";
import { TEMPLATES_KEY, loadJSON, saveJSON } from "./storage.js";
import { el } from "./dom.js";
import { capFirst, norm } from "./parsing.js";

const readTemplates = () => loadJSON(TEMPLATES_KEY, {});
const saveTemplates = (obj) => saveJSON(TEMPLATES_KEY, obj);

export function wireTemplates(card) {
  const cardKey = card.dataset.key;
  if (!state.TIME_KEYS.includes(cardKey)) return;
  if (card.__wiredTemplates) return;
  card.__wiredTemplates = true;

  const saveBtn = card.querySelector("[data-template-save]");
  const menuBtn = card.querySelector("[data-template-menu]");
  if (!menuBtn) return;

  function currentTexts() {
    return (state.getCard(cardKey)?.items || []).map(it => it.text).filter(Boolean);
  }

  saveBtn?.addEventListener("click", () => {
    const name = (prompt("Save this list as a template named:") || "").trim();
    if (!name) return;
    const items = currentTexts();
    if (!items.length) { alert("Nothing to save yet."); return; }
    const all = readTemplates();
    all[name] = items;
    saveTemplates(all);
  });

  let menu = null;
  function onDocClick(e) {
    if (menu && !menu.contains(e.target) && e.target !== menuBtn && !menuBtn?.contains(e.target)) closeMenu();
  }
  function closeMenu() {
    menu?.remove();
    menu = null;
    document.removeEventListener("click", onDocClick);
  }

  function applyTemplate(name) {
    const items = readTemplates()[name] || [];
    const existing = new Set(currentTexts().map(norm));
    const toAdd = items.filter(text => !existing.has(norm(text)));
    if (!toAdd.length) return;
    state.mutate(cardKey, (cardData) => {
      cardData.items = cardData.items || [];
      toAdd.forEach(text => cardData.items.push({ text: capFirst(text), done: false, folder: "" }));
    });
  }

  function deleteTemplate(name) {
    const all = readTemplates();
    delete all[name];
    saveTemplates(all);
  }

  function openMenu() {
    closeMenu();
    const names = Object.keys(readTemplates());
    menu = el("div", "absolute right-0 mt-2 bg-white rounded-lg shadow-xl z-20 min-w-[10rem] py-1 text-left");

    if (!names.length) {
      menu.append(el("div", "px-3 py-2 text-sm text-neutral/60 whitespace-nowrap", "No templates yet"));
    } else {
      names.forEach((name) => {
        const row = el("div", "flex items-center justify-between gap-3 px-3 py-2 hover:bg-neutral/10 whitespace-nowrap");
        const applyBtn = el("button", "text-left flex-1 text-neutral font-sec", name);
        applyBtn.type = "button";
        applyBtn.title = `Apply "${name}"`;
        const delBtn = el("button", "text-red-400 hover:text-red-600", "✕");
        delBtn.type = "button";
        delBtn.title = `Delete "${name}"`;
        applyBtn.addEventListener("click", () => { applyTemplate(name); closeMenu(); });
        delBtn.addEventListener("click", (e) => { e.stopPropagation(); deleteTemplate(name); openMenu(); });
        row.append(applyBtn, delBtn);
        menu.appendChild(row);
      });
    }

    const anchor = menuBtn.parentElement;
    anchor.style.position = "relative";
    anchor.appendChild(menu);
    document.addEventListener("click", onDocClick);
  }

  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (menu) closeMenu(); else openMenu();
  });
}
