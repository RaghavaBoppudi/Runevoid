// 1-bit scrollbars drawn by the page.
//
// Browsers only partly allow styling their own scrollbars: Safari and Firefox ignore most of it, and
// macOS swaps in overlay scrollbars depending on a system setting. So each scrolling pane keeps its
// native scrolling (wheel, trackpad momentum, keyboard, find-in-page) but hides the native bar, and
// this script draws a classic one beside it and keeps the two in sync:
//
//   [▲]  arrow button: scrolls 40px, repeats while held
//   ░░░  track: a press pages towards the pointer, repeating while held
//   [ ]  thumb: drag to scroll; its size shows how much of the pane is visible
//   [▼]  arrow button
//
// Sizes and positions are whole pixels. At either end the thumb's 2px edge overlaps the arrow
// button's edge, so the two never draw a doubled 4px line.
//
// Text areas grow to fit their text instead of scrolling, so the page has no inner scrollbars.
(() => {
  'use strict';

  const HOSTS = '.scroller, .stack .view-root, .draft-body';
  const STEP = 40;            // px per arrow press
  const PAGE = 0.9;           // fraction of the visible height per track press
  const REPEAT_DELAY = 350;   // ms before a held press starts repeating
  const REPEAT_EVERY = 50;    // ms between repeats
  const MIN_THUMB = 28;       // px, including its 2px top and bottom edges
  const EDGE = 2;             // px, the line width shared by thumb and buttons

  const states = new Map();   // host element -> state

  // ── Building and removing ──────────────────────────────────────────────

  function attach(host) {
    if (states.has(host) || !host.parentElement) return;
    const bar = document.createElement('div');
    bar.className = 'sbar';
    bar.setAttribute('aria-hidden', 'true');
    bar.innerHTML = '<div class="sbar-btn up" data-click></div>'
      + '<div class="sbar-track" data-click><div class="sbar-thumb"></div></div>'
      + '<div class="sbar-btn down" data-click></div>';
    host.classList.add('sb-host');
    host.parentElement.classList.add('sb-parent');
    host.after(bar);

    const s = {
      host, bar,
      up: bar.children[0], track: bar.children[1], down: bar.children[2],
      thumb: bar.querySelector('.sbar-thumb'),
      size: 0, travel: 0, max: 0, frame: 0,
    };
    s.onScroll = () => schedule(s);
    host.addEventListener('scroll', s.onScroll, { passive: true });

    // The host's own size, and its content's size (which sets scrollHeight).
    s.resize = new ResizeObserver(() => schedule(s));
    s.resize.observe(host);
    for (const child of host.children) s.resize.observe(child);
    s.mutate = new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) if (n.parentElement === host && n instanceof Element) s.resize.observe(n);
      schedule(s);
    });
    s.mutate.observe(host, { childList: true, subtree: true, attributes: true, characterData: true });

    hold(s.up, () => scrollByPx(s, -STEP));
    hold(s.down, () => scrollByPx(s, STEP));
    pageOnTrack(s);
    dragThumb(s);

    states.set(host, s);
    update(s);
  }

  function detach(s) {
    cancelAnimationFrame(s.frame);
    s.host.removeEventListener('scroll', s.onScroll);
    s.resize.disconnect();
    s.mutate.disconnect();
    s.bar.remove();
    states.delete(s.host);
  }

  // ── Drawing ────────────────────────────────────────────────────────────

  function schedule(s) {
    if (s.frame) return;
    s.frame = requestAnimationFrame(() => { s.frame = 0; update(s); });
  }

  function update(s) {
    const { host, bar, thumb, track } = s;
    const shown = host.isConnected && host.getClientRects().length > 0 && host.offsetHeight > 0;
    bar.hidden = !shown;
    if (!shown) return;
    for (const t of host.querySelectorAll('textarea[data-fit="later"]')) fit(t);

    bar.style.top = `${host.offsetTop}px`;
    bar.style.left = `${host.offsetLeft + host.offsetWidth}px`;
    bar.style.height = `${host.offsetHeight}px`;

    const trackH = track.clientHeight;
    const { scrollHeight, clientHeight, scrollTop } = host;
    s.max = scrollHeight - clientHeight;
    const scrollable = s.max > 0 && trackH > MIN_THUMB;
    bar.classList.toggle('idle', !scrollable);
    thumb.hidden = !scrollable;
    if (!scrollable) return;

    // The thumb may overlap each button's edge, so it travels over trackH + 2 * EDGE.
    const span = trackH + 2 * EDGE;
    s.size = Math.max(MIN_THUMB, Math.round(span * clientHeight / scrollHeight));
    s.travel = span - s.size;
    const y = Math.round(s.travel * Math.min(1, Math.max(0, scrollTop / s.max))) - EDGE;
    thumb.style.height = `${s.size}px`;
    thumb.style.transform = `translateY(${y}px)`;
  }

  // ── Input ──────────────────────────────────────────────────────────────

  function scrollByPx(s, dy) {
    s.host.scrollTop += dy;
  }

  // Run `action` on press, then repeat it while the press is held (like a key or classic arrow).
  // `keepGoing`, if given, is checked before each repeat with the latest pointer event.
  function hold(el, action, keepGoing) {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      el.classList.add('pressed');
      let last = e;
      let timer = 0;
      const tick = () => {
        if (keepGoing && !keepGoing(last)) return;
        action(last);
        timer = setTimeout(tick, REPEAT_EVERY);
      };
      action(e);
      timer = setTimeout(tick, REPEAT_DELAY);
      const move = (ev) => { last = ev; };
      const end = () => {
        clearTimeout(timer);
        el.classList.remove('pressed');
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', end);
        el.removeEventListener('pointercancel', end);
        el.removeEventListener('lostpointercapture', end);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', end);
      el.addEventListener('lostpointercapture', end);
    });
  }

  // A press on the track (not the thumb) pages towards the pointer until the thumb reaches it.
  function pageOnTrack(s) {
    const direction = (e) => {
      const r = s.thumb.getBoundingClientRect();
      return e.clientY < r.top ? -1 : e.clientY > r.bottom ? 1 : 0;
    };
    let dir = 0;
    hold(s.track, (e) => {
      if (e.type === 'pointerdown') dir = direction(e);
      if (dir) scrollByPx(s, dir * Math.round(s.host.clientHeight * PAGE));
    }, (e) => dir !== 0 && direction(e) === dir);
  }

  function dragThumb(s) {
    s.thumb.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();   // a press on the thumb is a drag, not a track press
      s.thumb.setPointerCapture(e.pointerId);
      s.bar.classList.add('dragging');
      const startY = e.clientY;
      const startTop = s.host.scrollTop;
      const move = (ev) => {
        if (s.travel > 0) s.host.scrollTop = startTop + (ev.clientY - startY) * s.max / s.travel;
      };
      const end = () => {
        s.bar.classList.remove('dragging');
        s.thumb.removeEventListener('pointermove', move);
        s.thumb.removeEventListener('pointerup', end);
        s.thumb.removeEventListener('pointercancel', end);
        s.thumb.removeEventListener('lostpointercapture', end);
      };
      s.thumb.addEventListener('pointermove', move);
      s.thumb.addEventListener('pointerup', end);
      s.thumb.addEventListener('pointercancel', end);
      s.thumb.addEventListener('lostpointercapture', end);
    });
  }

  // ── Text areas grow with their text ────────────────────────────────────

  function fit(t) {
    // Hidden (closed pane or <details>): measure when shown. Attributes change only when their value
    // does, so the pane's change watcher is not re-triggered on every frame.
    if (!t.getClientRects().length) { if (t.dataset.fit !== 'later') t.dataset.fit = 'later'; return; }
    if (t.dataset.fit) delete t.dataset.fit;
    const host = t.closest('.sb-host');
    const keep = host ? host.scrollTop : 0;   // collapsing to "auto" for a moment must not move the page
    t.style.height = 'auto';
    t.style.height = `${t.scrollHeight}px`;
    if (host) host.scrollTop = keep;
  }
  document.addEventListener('input', (e) => {
    if (e.target instanceof HTMLTextAreaElement) fit(e.target);
  });

  // ── Finding panes, including ones added later (a draft opening in Review) ──

  function scan(root) {
    if (!(root instanceof Element)) return;
    if (root.matches(HOSTS)) attach(root);
    for (const el of root.querySelectorAll(HOSTS)) attach(el);
    if (root instanceof HTMLTextAreaElement) fit(root);
    for (const t of root.querySelectorAll('textarea')) fit(t);
  }

  new MutationObserver((records) => {
    for (const r of records) {
      for (const n of r.addedNodes) scan(n);
      if (r.removedNodes.length) for (const s of [...states.values()]) if (!s.host.isConnected) detach(s);
    }
  }).observe(document.body, { childList: true, subtree: true });

  scan(document.body);
  // Web fonts change line heights after first layout.
  if (document.fonts) document.fonts.ready.then(() => {
    for (const t of document.querySelectorAll('textarea')) fit(t);
    for (const s of states.values()) schedule(s);
  });
})();
