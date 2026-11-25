// Classic pop-up menus for <select class> inside .popup, in place of the menu the operating system
// draws when a select opens.
//
// The <select> stays the real control: it holds the value, takes focus, submits with forms and
// fires the usual input/change events, so page code needs no changes. This script only stops the
// native menu from opening and shows a themed list instead:
//   mouse: press the select to open, click an item to choose; a press outside closes
//   keys:  Space, Return, ↑ or ↓ on the select opens; ↑ ↓ Home End move, Return or Space choose,
//          Esc or Tab closes; typing a letter jumps to the next item starting with it
// The open list is a listbox with aria-activedescendant, so screen readers follow the highlight.
(() => {
  'use strict';

  const OPEN_KEYS = new Set([' ', 'Enter', 'ArrowDown', 'ArrowUp']);
  let current = null;   // { select, menu, items, active }
  let seq = 0;

  const isPopupSelect = (el) => el instanceof HTMLSelectElement && !el.multiple && el.closest('.popup') !== null;

  function openMenu(select) {
    if (select.disabled || current) return;
    const menu = document.createElement('div');
    menu.className = 'menu';
    menu.id = `rv-menu-${++seq}`;
    menu.setAttribute('role', 'listbox');
    menu.tabIndex = -1;
    const label = select.getAttribute('aria-label') || select.closest('.row')?.querySelector('label')?.textContent;
    if (label) menu.setAttribute('aria-label', label);

    const items = [];
    for (const [i, option] of [...select.options].entries()) {
      const item = document.createElement('div');
      item.className = 'menu-item';
      item.id = `${menu.id}-${i}`;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(option.selected));
      if (option.disabled) item.setAttribute('aria-disabled', 'true');
      item.textContent = option.label || option.text;
      item.dataset.index = String(i);
      menu.append(item);
      items.push(item);
    }
    // Inside a modal dialog the rest of the page is inert, so the menu must live in the dialog.
    (select.closest('dialog') || document.body).append(menu);
    current = { select, menu, items, active: -1 };

    place(select, menu);
    select.setAttribute('aria-expanded', 'true');
    select.setAttribute('aria-controls', menu.id);
    setActive(select.selectedIndex >= 0 && enabled(items[select.selectedIndex]) ? select.selectedIndex : edge(false));
    menu.focus({ preventScroll: true });

    menu.addEventListener('pointermove', (e) => {
      const item = e.target instanceof Element ? e.target.closest('.menu-item') : null;
      if (item && enabled(item)) setActive(Number(item.dataset.index));
    });
    menu.addEventListener('click', (e) => {
      const item = e.target instanceof Element ? e.target.closest('.menu-item') : null;
      if (item && enabled(item)) choose(Number(item.dataset.index));
    });
    menu.addEventListener('keydown', onMenuKey);
    menu.addEventListener('focusout', (e) => { if (!menu.contains(e.relatedTarget)) closeMenu(false); });
  }

  // Below the select, left edges aligned and at least as wide; above it if there is no room below.
  function place(select, menu) {
    const r = select.getBoundingClientRect();
    menu.style.minWidth = `${Math.round(r.width)}px`;
    menu.style.left = `${Math.round(r.left)}px`;
    const gap = 4;
    const h = menu.offsetHeight;
    const below = Math.round(r.bottom) + gap;
    const top = below + h <= window.innerHeight - 8 ? below : Math.max(8, Math.round(r.top) - gap - h);
    menu.style.top = `${top}px`;
    const overflowRight = menu.getBoundingClientRect().right - (window.innerWidth - 8);
    if (overflowRight > 0) menu.style.left = `${Math.max(8, Math.round(r.left - overflowRight))}px`;
  }

  const enabled = (item) => item.getAttribute('aria-disabled') !== 'true';

  // Index of the first (or, fromEnd, the last) item that can be chosen; -1 if none can.
  function edge(fromEnd) {
    const { items } = current;
    if (fromEnd) { for (let i = items.length - 1; i >= 0; i--) if (enabled(items[i])) return i; }
    else { for (let i = 0; i < items.length; i++) if (enabled(items[i])) return i; }
    return -1;
  }

  function setActive(i) {
    const c = current;
    if (!c || i < 0) return;
    if (c.active >= 0) c.items[c.active].classList.remove('active');
    c.active = i;
    const item = c.items[i];
    item.classList.add('active');
    c.menu.setAttribute('aria-activedescendant', item.id);
    item.scrollIntoView({ block: 'nearest' });
  }

  function step(dir) {
    const { items, active } = current;
    for (let k = 1; k <= items.length; k++) {
      const i = active + dir * k;
      if (i < 0 || i >= items.length) return;
      if (enabled(items[i])) { setActive(i); return; }
    }
  }

  function typeAhead(ch) {
    const { items, active } = current;
    const needle = ch.toLowerCase();
    for (let k = 1; k <= items.length; k++) {
      const i = (active + k) % items.length;
      if (enabled(items[i]) && items[i].textContent.trim().toLowerCase().startsWith(needle)) { setActive(i); return; }
    }
  }

  function onMenuKey(e) {
    switch (e.key) {
      case 'ArrowDown': step(1); break;
      case 'ArrowUp': step(-1); break;
      case 'Home': setActive(edge(false)); break;
      case 'End': setActive(edge(true)); break;
      case 'Enter': case ' ': choose(current.active); break;
      case 'Escape': closeMenu(true); break;
      case 'Tab': closeMenu(true); return;   // let focus move on from the select
      default:
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) typeAhead(e.key);
        else return;
    }
    e.preventDefault();
    e.stopPropagation();   // page shortcuts (j/k/a/s in Review) must not fire while a menu is open
  }

  function choose(i) {
    const { select } = current;
    const changed = i >= 0 && select.selectedIndex !== i;
    closeMenu(true);
    if (changed) {
      select.selectedIndex = i;
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function closeMenu(refocus) {
    const c = current;
    if (!c) return;
    current = null;
    c.select.setAttribute('aria-expanded', 'false');
    c.select.removeAttribute('aria-controls');
    c.menu.remove();
    if (refocus) c.select.focus({ preventScroll: true });
  }

  // Open on press. preventDefault keeps the operating system's menu from appearing.
  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (current && !current.menu.contains(e.target)) {
      const same = e.target === current.select;
      closeMenu(same);
      if (same) { e.preventDefault(); return; }
    }
    if (isPopupSelect(e.target)) {
      e.preventDefault();
      e.target.focus({ preventScroll: true });
      openMenu(e.target);
    }
  }, true);

  document.addEventListener('keydown', (e) => {
    if (!isPopupSelect(e.target) || current) return;
    if (OPEN_KEYS.has(e.key) && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      openMenu(e.target);
    }
  }, true);

  // The menu is placed in viewport coordinates, so it closes if the page under it moves.
  addEventListener('resize', () => closeMenu(false));
  document.addEventListener('scroll', (e) => { if (current && !current.menu.contains(e.target)) closeMenu(false); }, true);

  // Selects start collapsed for assistive technology.
  for (const s of document.querySelectorAll('.popup select')) s.setAttribute('aria-expanded', 'false');
})();
