import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeFolderPath, displayFolder, parseItemAndTags, parseFolderDelete, parseEntries, capFirst } from "./parsing.js";

test("normalizeFolderPath: case, spaces, char stripping, length cap", () => {
  assert.equal(normalizeFolderPath("Grocery List"), "grocery-list");
  assert.equal(normalizeFolderPath("Ideas!!"), "ideas");
  assert.equal(normalizeFolderPath(""), "");
  assert.equal(normalizeFolderPath("unfiled"), "");
  assert.equal(normalizeFolderPath("UnFiled"), "");
  assert.equal(normalizeFolderPath("a".repeat(60)).length, 48);
});

test("displayFolder: title-cases hyphenated keys, Unfiled for empty", () => {
  assert.equal(displayFolder("grocery-list"), "Grocery List");
  assert.equal(displayFolder(""), "Unfiled");
});

test("parseItemAndTags: single and multi-tag filing", () => {
  assert.deepEqual(parseItemAndTags("Buy a gift #ideas"), { text: "Buy a gift", folders: ["ideas"] });
  assert.deepEqual(parseItemAndTags("Book flights #travel #work"), { text: "Book flights", folders: ["travel", "work"] });
  assert.deepEqual(parseItemAndTags("Plain item"), { text: "Plain item", folders: [] });
  assert.deepEqual(parseItemAndTags("#groceries"), { text: "", folders: ["groceries"] });
});

test("parseItemAndTags: dedupes repeated tags", () => {
  assert.deepEqual(parseItemAndTags("Milk #shopping #shopping"), { text: "Milk", folders: ["shopping"] });
});

test("parseItemAndTags: time cards ignore # entirely", () => {
  assert.deepEqual(parseItemAndTags("Call mom #family", { isTimeCard: true }), { text: "Call mom #family", folders: [] });
});

test("parseFolderDelete: recognizes -folderName, rejects everything else", () => {
  assert.equal(parseFolderDelete("-groceries"), "groceries");
  assert.equal(parseFolderDelete("- Grocery List"), "grocery list");
  assert.equal(parseFolderDelete("groceries"), null);
  assert.equal(parseFolderDelete("Buy milk #groceries"), null);
});

test("parseEntries: newline/semicolon separated, no comma splitting", () => {
  const entries = parseEntries("Milk, Eggs, Bread");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].text, "Milk, Eggs, Bread");

  const bySemicolon = parseEntries("Milk;Eggs;Bread");
  assert.equal(bySemicolon.length, 3);
  assert.deepEqual(bySemicolon.map(e => e.text), ["Milk", "Eggs", "Bread"]);
});

test("parseEntries: trailing tag applies to whole batch when others are untagged", () => {
  const r = parseEntries("Pasta\nTacos\nSalad #dinner");
  assert.deepEqual(r.map(e => e.folders), [["dinner"], ["dinner"], ["dinner"]]);
});

test("parseEntries: trailing tag does NOT apply if an earlier entry already has its own tag", () => {
  const r = parseEntries("Pasta #lunch\nTacos\nSalad #dinner");
  assert.deepEqual(r.map(e => e.folders), [["lunch"], [], ["dinner"]]);
});

test("parseEntries: folder-delete commands are flagged, not treated as items", () => {
  const r = parseEntries("-groceries\nMilk");
  assert.equal(r[0].del, "groceries");
  assert.equal(r[1].del, null);
  assert.equal(r[1].text, "Milk");
});

test("capFirst: only first character of first word", () => {
  assert.equal(capFirst("buy milk"), "Buy milk");
  assert.equal(capFirst(""), "");
  assert.equal(capFirst("  already Capped"), "Already Capped");
});
