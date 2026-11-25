// Runevoid dashboard icons, imported by src/ui.js.
//
// Ligne claire line drawings on a 24-unit grid, drawn at 16px (sidebar, buttons, rows) or 32px (hero cards,
// desk icons). Drawing rules, so the set reads as one family:
//   - one even line weight, set in CSS (non-scaling, so 16px and 32px icons share it), round caps and joins;
//   - live area 3–21, centred on 12, so icons line up with text and each other;
//   - every closed shape is outlined; at most one flat colour fill per icon, named by class:
//       f-o accent orange · f-s pale sky · f-g sage · f-m mustard · f-p paper (an opaque body, no colour);
//     the colours come from the theme tokens in public/runevoid.css, so dark mode follows;
//   - no shading, gradients or hatching.
// Each icon is a fragment of SVG markup inside <svg class="i">; strokes take currentcolor.

const SHAPES = {
  overview: '<rect class="f-o" x="4" y="4" width="7" height="7" rx="1.5"/><rect class="f-p" x="13" y="4" width="7" height="7" rx="1.5"/>'
    + '<rect class="f-p" x="4" y="13" width="7" height="7" rx="1.5"/><rect class="f-s" x="13" y="13" width="7" height="7" rx="1.5"/>',
  review: '<rect class="f-p" x="5" y="4.5" width="14" height="16.5" rx="2"/><rect class="f-o" x="9" y="3" width="6" height="3.5" rx="1"/>'
    + '<path d="M8.5 13.5l2.5 2.5 4.5-5"/>',
  manual: '<path class="f-p" d="M6 3h8l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v4h4M11.5 10.5v6M8.5 13.5h6"/>',
  sent: '<path class="f-s" d="M3.5 11.5L20.5 4l-5 16.5-4-6.5z"/><path d="M11.5 14L20.5 4"/>',
  vendors: '<path class="f-p" d="M5 20.5V6.5L12 4v16.5M12 9l7 2.5v9"/><path d="M3.5 20.5h17M8 9h.01M8 12.5h.01M8 16h.01M15.5 14h.01M15.5 17h.01"/>',
  scraped: '<rect class="f-p" x="4" y="4.5" width="16" height="15" rx="2"/><rect class="f-m" x="7" y="8" width="5" height="4"/>'
    + '<path d="M14.5 8.5H17M14.5 11.5H17M7 15.5h10"/>',
  logs: '<circle class="f-p" cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/>',
  health: '<path d="M3.5 20.5h17"/><rect class="f-g" x="5.5" y="12" width="3" height="6"/><rect class="f-m" x="10.5" y="8" width="3" height="10"/>'
    + '<rect class="f-o" x="15.5" y="4.5" width="3" height="13.5"/>',
  search: '<circle class="f-p" cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/>',
  send: '<path class="f-o" d="M3.5 11.5L20.5 4l-5 16.5-4-6.5z"/><path d="M11.5 14L20.5 4"/>',
  eye: '<path class="f-p" d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle class="f-s" cx="12" cy="12" r="3"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4v4h-4"/>',
  mail: '<rect class="f-p" x="3" y="5.5" width="18" height="13" rx="2"/><path class="f-s" d="M3.5 7l8.5 6 8.5-6"/>',
  lock: '<path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/><rect class="f-m" x="5" y="10.5" width="14" height="10" rx="2"/><path d="M12 14.5v2"/>',
  block: '<circle class="f-p" cx="12" cy="12" r="8.5"/><path d="M6 6l12 12"/>',
  folder: '<path class="f-s" d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2h9A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/>',
  sun: '<circle class="f-m" cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  moon: '<path class="f-m" d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/>',
  soundOn: '<path class="f-p" d="M3.5 9.5H7L12 5v14l-5-4.5H3.5z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  soundOff: '<path class="f-p" d="M3.5 9.5H7L12 5v14l-5-4.5H3.5z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>',
};

export const icon = (name, cls = '') =>
  `<svg class="i${cls ? ` ${cls}` : ''}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${SHAPES[name] ?? ''}</svg>`;
