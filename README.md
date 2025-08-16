npx tailwindcss -i ./input.css -o ./public/output.css --watch


(() => {
  const isLocal = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/.test(location.host);
  if (!isLocal) { alert('Abort: not local dev'); return; }
  Object.keys(localStorage).forEach(k => { if (k.startsWith('planner:')) localStorage.removeItem(k); });
  // reload so baseDate is re-seeded to today and DOM rebuilt
  location.reload();
})();
