# Planner App — Functional Specification

## 1. Pages and Routing
- **index.html** = Landing / Sign-in.  
  - Shows “Sign in!” header and a Google Sign-in button.  
  - If already signed in → redirects to `today.html`.  
  - If not signed in → stays on `index.html`.

- **today.html** = Main planner for current day.  
  - `data-day-offset="0"`.  
  - Provides daily cards (Morning, Daytime, Evening, Work, Home, Shopping, Food/Menu, Notes).  
  - Includes buttons:  
    - Plan tomorrow (`tomorrow.html`).  
    - End day (archives today, sets tomorrow, triggers downloads).  
    - Download today (exports JSON).  
    - Restore (imports JSON).

- **tomorrow.html** = Planner for next day.  
  - `data-day-offset="1"`.  
  - Similar layout to Today, with “Back to current day” link.

## 2. Authentication
- Firebase Auth + Firestore.  
- On sign-in:  
  - User is redirected to `today.html`.  
  - Firebase sync begins for Today and Tomorrow days, Notes, and Countdown.  
- On sign-out:  
  - User is redirected to `index.html`.

## 3. Data Model
Stored in **localStorage** with Firebase sync:
- `planner:YYYY-MM-DD` → day object:
  - Keys = cards (`morning`, `daytime`, etc.) with `{ type:"checklist", items:[], smoke:bool }`.  
  - `__smokes` = daily smoke count.  
  - `__ui` = UI state (collapsed folders/cards).  
  - `__carried` = carried over items meta.  
  - `__clearedDone` = archive of cleared items.  
- `planner:YYYY-MM-DD:bullets:food` → array of bullet items.  
- `planner:notes` → global notes (array).  
- `planner:countdown` → { target, label }.  

Export format includes `{ version, date, day, bullets, notes }`.

## 4. Core Features

### 4.1 Greeting and Header
- Title = `Wed 05-Oct` style.  
- Header = `Wednesday, 5th of October` style.  
- Greeting = based on time:
  - Morning: “Good morning!”  
  - Afternoon: “Hi!”  
  - Evening: “Good evening!”.

### 4.2 Cards
- **Time-block cards (Morning, Daytime, Evening):**
  - Hours displayed (`data-start`, `data-end`).  
  - Highlight current block (scale up) in Today view. (Functions: `highlightCurrentBlock()`)  
  - Collapse automatically once end time passes. (Functions: `collapsePastTimeCards()`, `cardEndHour()`, `getCardBoundary()`)  
  - No carryover: undone tasks stay on their own block and are never moved to the next block, to tomorrow, or archived by End Day.
- **Other cards (Work, Home, Shopping, Food/Menu, Notes):**
  - Not time-bound.  
  - Manual collapse remembered in UI state. (Functions: `wireCarets()`, `applyCollapsedUI()`, `setManualCollapsed()`, `isManualCollapsed()`)  
- **Checklists:**
  - Each item: checkbox, inline edit, drag-and-drop reorder.  
  - Supports `#tags` → folder grouping with headers. If multiple tags are present, a new item should be created within each folder. (Functions: `parseItemAndTags()`, `normalizeFolderPath()`, `ensureFolderHeader()`, `updateFolderCounts()`, `findDupInFolder()`, submit handler in `wireChecklist()`)  
  - Supports `-folderName` → delete folder command. (Functions: `parseFolderDelete()`, `deleteFolderCommand()`)  
  - While editing, typing `#folder` reroutes the item to that folder. (Functions: edit commit handler in `wireChecklist()`, `moveItemToFolder()`) 
  - “Clear checked” button removes checked tasks and archives them in `__clearedDone`. (Functions: `wireClearButtons()`, `wireClearButton()`; persistence via `snapshotDay()` / `snapshotDayImmediate()`)  
- **Bullets (Food, Notes):**
  - Plain text entries with `#tags` folder support. If multiple tags are present, a new item should be created within each folder. (Functions: `wireBullets()` submit flow, `parseItemAndTags()`, `ensureFolderHeader()`)   
  - Supports `-folderName` → delete folder command. (Functions: `parseFolderDelete()`, `deleteFolderCommand()`)  
  - While editing, typing `#folder` reroutes the item to that folder. (Functions: edit commit handler inside `wireBullets()`, `moveItemToFolder()`) 
  - No checkboxes.

### 4.3 Templates
- Time cards only.  
- “Save template” button stores current list under a name.  
- Folder button shows dropdown of saved templates.  
  - Apply = insert missing tasks.  
  - Delete = remove template.

### 4.4 Smoke Breaks
- Each time card has “Smoke break?” toggle.  
- Checked = increments global smoke counter once.  
- Unchecking reduces count if previously counted.  
- Counter is shown at top in Today view. Manual “+” button increments too.

### 4.5 Countdown
- Global countdown card.  
- Two modes:
  - Form: pick datetime + label.  
  - View: live ticking display.  
- Saved in `planner:countdown` (local + Firebase).  
- Reset clears it.

### 4.6 End Day
- Archives today’s tasks.  
- Carries incomplete items to tomorrow, except time-block cards (Morning/Daytime/Evening), which never carry over.  
- Downloads two JSON files sequentially: today and tomorrow.  
- Advances base date in localStorage.  
- Redirects to refreshed Today view.

### 4.7 Restore
- Imports JSON backup.  
- Writes day/bullet/notes data into localStorage + Firebase.  
- If restored date = current view → reloads page.  
- Otherwise alerts user to switch days.

### 4.8 Tomorrow Sync
- Tomorrow view auto-syncs carried tasks from Today, for all cards **except** the time-block cards (Morning/Daytime/Evening), which never carry over.
- Runs on page load (Today and Tomorrow), and after every edit on Today (debounced ~200ms).
- Prevents duplicates by tracking `__carried` keys.

## 5. UI Behavior
- All carets toggle collapse state with persistence.  
- Folder headers show counts and can collapse all with Alt/Meta click.  
- “Unfiled” folder is hidden unless items exist.  
- Drag-and-drop works within and across folders (deduping duplicates).  
- Inline edit with Enter=save, Escape=cancel.  
- “Plan tomorrow” and “Back to current day” links switch offset.  
- Download buttons always snapshot before saving.

## 6. Card Input Commands (typed syntax)
Typed into a card's "Add" field before submitting, or inline while editing an existing item. (Functions: `parseMultilineEntries()`, `parseItemAndTags()`, `parseFolderDelete()`, `normalizeFolderPath()`.)

### Folder cards — Work, Home, Shopping, Food/Menu, Notes
Time cards (Morning/Daytime/Evening) don't support any of this — see below.

- **Add a plain item** — type text, press Add (or Enter). No `#`/`-` syntax needed.
- **Add multiple items at once** — separate with a comma or newline: `Milk, Eggs, Bread` adds three separate items in one submit.
- **File an item into a folder** — append `#folderName`: `Buy a gift #ideas` creates/uses an "Ideas" folder and files the item there.
- **File an item into multiple folders at once** — append more than one tag: `Book flights #travel #work` creates the same item once inside each folder.
- **Share one tag across a batch** — if only the *last* item in a comma/newline batch carries a tag, it's applied to all the untagged ones before it: `Pasta, Tacos, Salad #dinner` files all three under "Dinner". Doesn't trigger if any earlier item already has its own tag.
- **Create an empty folder** — type just the tag with no item text: `#groceries` creates the "Groceries" header with nothing in it yet.
- **Delete a folder** — `-folderName`: removes the folder header and moves any items inside it to Unfiled. `-unfiled` is blocked while Unfiled still has items.
- **Move an existing item to a different folder** — click ✎ to edit, add/change the `#folder` tag in the text, then Enter (or click away) to commit — Escape cancels. Only the first tag found is used to reroute; editing without a `#tag` just updates the text and keeps the current folder.
- **Reorder or re-file by dragging** — drag an item's `⋮⋮` handle to reorder within a folder, or drop it under a different folder's header to re-file it.

### Folder name rules
- Case-insensitive; normalized to lowercase with spaces turned into hyphens (`#Grocery List` → `grocery-list`, displayed as "Grocery List").
- Allowed characters: letters, digits, spaces, `_`, `-`, `/`. Anything else is stripped.
- Max 48 characters.
- The name "unfiled" is reserved — tagging `#unfiled` is the same as leaving an item untagged.

### Time cards — Morning, Daytime, Evening
- Plain text only. `#` and `-` have no special meaning here; folders are disabled entirely on these three cards.

### Collapsing (not typed, but related)
- Click a folder header's caret to collapse/expand just that folder.
- Alt-click (or Cmd/Meta-click) any folder caret to collapse/expand *every* folder on that card at once.
- Click a card's own caret (top-right) to collapse/expand the whole card; non-time cards remember this per day.
