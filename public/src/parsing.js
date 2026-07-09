// Pure text rules for checklist/bullet entry parsing and folder naming.
// No DOM, no storage — everything here is data in, data out.

const FOLDER_MAXLEN = 48;
const ALLOWED_CHARS = /[^a-z0-9 _\-\/']/gi;

export const norm = (s) => (s || "").trim().toLowerCase();

// Capitalize only the first character of the first word.
export function capFirst(s) {
  s = String(s).trim();
  return s ? s[0].toLocaleUpperCase() + s.slice(1) : s;
}

// Normalize a raw "#tag" -> a folder key: lowercase, spaces/junk -> hyphens,
// capped length. "" (and "unfiled") both mean Unfiled.
export function normalizeFolderPath(raw) {
  if (!raw) return "";
  let s = String(raw).replace(/^#+/, "").replace(ALLOWED_CHARS, " ").trim();
  s = s.replace(/\s+/g, " ").toLowerCase();
  s = s.replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^[-_]+|[-_]+$/g, "");
  if (!s || s === "unfiled") return "";
  if (s.length > FOLDER_MAXLEN) s = s.slice(0, FOLDER_MAXLEN);
  return s;
}

// Display a folder key as a title: hyphens -> spaces, each word capitalized.
export function displayFolder(path) {
  if (!path) return "Unfiled";
  const s = String(path).replace(/[-_]+/g, " ").trim();
  return s.split(/\s+/).map(capFirst).join(" ");
}

// Parse "Item text #folderA #folderB/sub". Everything before the first "#" is
// the item text. Tags are deduped and normalized; "#unfiled" resolves to no tag.
export function parseItemAndTags(line, { isTimeCard = false } = {}) {
  const s = String(line || "").trim();
  if (!s) return { text: "", folders: [] };
  if (isTimeCard) return { text: s, folders: [] };

  const i = s.indexOf("#");
  if (i < 0) return { text: s, folders: [] };

  const text = s.slice(0, i).trim();

  const raw = s.slice(i)
    .split(/(\s+)/)
    .map(x => x.trim())
    .filter(Boolean)
    .filter(x => x.startsWith("#"))
    .map(x => x.replace(/^#+/, ""));

  const tags = raw.map(normalizeFolderPath).filter(Boolean);

  const seen = new Set();
  const folders = tags.filter(t => (seen.has(t) ? false : (seen.add(t), true)));
  return { text, folders };
}

// "-folderName" command => delete that folder.
export function parseFolderDelete(line) {
  const m = String(line || "").trim().match(/^-\s*([a-z0-9 _\-\/']+)\s*$/i);
  return m ? m[1].toLowerCase() : null;
}

// Split a submitted line/comma/newline blob into { del, text, folders } entries.
// If only the last entry carries tags, those tags apply to all the untagged
// entries before it.
export function parseEntries(raw, { isTimeCard = false } = {}) {
  const parts = String(raw || "").split(/[\n;]+/).map(s => s.trim()).filter(Boolean);
  const entries = parts.map(line => {
    const del = parseFolderDelete(line);
    const { text, folders } = parseItemAndTags(line, { isTimeCard });
    return { del, text, folders };
  });

  if (!isTimeCard) {
    const nonDel = entries.filter(e => !e.del);
    if (nonDel.length > 1) {
      const last = nonDel[nonDel.length - 1];
      if ((last.folders?.length || 0) && nonDel.slice(0, -1).every(e => (e.folders?.length || 0) === 0)) {
        const common = last.folders.slice();
        nonDel.slice(0, -1).forEach(e => { e.folders = common.slice(); });
      }
    }
  }
  return entries;
}
