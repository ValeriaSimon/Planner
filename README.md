# Planner

A personal daily/tomorrow planner. Next.js only handles routing (`next.config.mjs` rewrites) and a keepalive
ping (`pages/keepalive.js`); the actual app is static HTML/JS served from `public/` (`index.html` = sign-in,
`today.html` / `tomorrow.html` = the planner views, `main.js` = all the DOM wiring). State lives in
localStorage, synced to Firebase Auth + Firestore when signed in. Tailwind v4 compiles `input.css` -> `public/output.css`.

See [planner-spec.md](planner-spec.md) for the full functional spec.

## Dev

Run this in a separate terminal while working on styles (watches `input.css` and rebuilds `public/output.css`):

```
npx tailwindcss -i ./input.css -o ./public/output.css --watch
```

Then `npm run dev` to run the Next.js dev server.

## Reset local planner data (paste in browser console, localhost only)

```js
(() => {
  const isLocal = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/.test(location.host);
  if (!isLocal) { alert('Abort: not local dev'); return; }
  Object.keys(localStorage).forEach(k => { if (k.startsWith('planner:')) localStorage.removeItem(k); });
  // reload so baseDate is re-seeded to today and DOM rebuilt
  location.reload();
})();
```
