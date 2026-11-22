// Light/dark theme toggle for the dashboard.
//
// Light is the default. Choosing dark sets <html data-theme="dark"> and stores "dark" in localStorage
// under "rv-theme"; a one-line script in each page's <head> reapplies it before the first paint, so a
// dark page never flashes light. Buttons marked data-theme-toggle switch it and report the state
// through aria-pressed (pressed = dark).
(() => {
  'use strict';

  const STORE_KEY = 'rv-theme';
  const root = document.documentElement;
  const isDark = () => root.dataset.theme === 'dark';

  function sync() {
    for (const b of document.querySelectorAll('[data-theme-toggle]')) {
      b.setAttribute('aria-pressed', String(isDark()));
      b.title = isDark() ? 'Switch to light theme' : 'Switch to dark theme';
    }
  }

  function set(dark) {
    if (dark) root.dataset.theme = 'dark';
    else delete root.dataset.theme;
    try {
      if (dark) localStorage.setItem(STORE_KEY, 'dark');
      else localStorage.removeItem(STORE_KEY);
    } catch { /* storage blocked: applies to this page only */ }
    sync();
  }

  document.addEventListener('click', (e) => {
    const b = e.target instanceof Element ? e.target.closest('[data-theme-toggle]') : null;
    if (b) set(!isDark());
  });

  // Another tab changed the theme: follow it.
  addEventListener('storage', (e) => {
    if (e.key === STORE_KEY) {
      if (e.newValue === 'dark') root.dataset.theme = 'dark';
      else delete root.dataset.theme;
      sync();
    }
  });

  sync();   // the toggle sits above this script in the page, so it exists already
})();
