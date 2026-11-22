// Mechanical switch sounds for the dashboard, synthesised with the Web Audio API (no audio files).
//
// Each sound is rendered once into an AudioBuffer from a small physical-ish model: a short bright
// transient (the leaf/click jacket), two damped resonances (switch housing and plate), and for a
// key-down a second, duller transient a few milliseconds later (the stem bottoming out).
// Every press of a kind plays the same buffer at the same pitch and level, so a control sounds
// identical each time it is used.
//
// Every buffer starts at zero amplitude and ends with a raised-cosine fade, so playback can't pop.
// The AudioContext is created on the first pointer or key press (browsers block audio before a user
// gesture). The on/off choice is kept in localStorage under "rv-sound".
(() => {
  'use strict';

  const STORE_KEY = 'rv-sound';
  const PRESSABLE = 'button, a[href], summary, select, label, input[type="checkbox"], input[type="radio"], [role="button"], [data-click], .item, .row.click';
  const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn', 'FnLock', 'Hyper', 'Super', 'OS']);

  // Sound recipes. Times in seconds, frequencies in Hz.
  const RECIPES = {
    // Pointer press on a button: crisp actuation click, then the bottom-out.
    down: { length: 0.075, level: 0.9, click: 1, clickTau: 0.0009, ring: [[2350, 0.0045, 0.55], [3900, 0.0028, 0.35]],
            body: [[210, 0.016, 0.5], [470, 0.009, 0.35]], bottom: { at: 0.0065, gain: 0.55, tau: 0.0012 } },
    // Release: lighter and higher, no bottom-out.
    up:   { length: 0.05, level: 0.5, click: 0.8, clickTau: 0.0007, ring: [[2900, 0.0035, 0.5], [4600, 0.002, 0.3]],
            body: [[300, 0.008, 0.25]], bottom: null },
    // Typing: like a press but tighter, so fast typing stays clean.
    key:  { length: 0.06, level: 0.6, click: 1, clickTau: 0.0008, ring: [[2600, 0.0038, 0.5], [4200, 0.0024, 0.3]],
            body: [[240, 0.012, 0.45], [520, 0.007, 0.3]], bottom: { at: 0.005, gain: 0.45, tau: 0.001 } },
    keyup: { length: 0.04, level: 0.3, click: 0.7, clickTau: 0.0006, ring: [[3100, 0.003, 0.45]],
            body: [[330, 0.006, 0.2]], bottom: null },
  };

  let enabled = true;
  try { enabled = localStorage.getItem(STORE_KEY) !== 'off'; } catch { /* storage blocked: default on */ }

  let ctx = null;
  let out = null;
  let bank = null;
  let pressed = false;

  // Deterministic PRNG (mulberry32), so variants are stable between page loads.
  function prng(seed) {
    return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function render(recipe, seed) {
    const rand = prng(seed);   // noise source only; the same seed always gives the same samples
    const rate = ctx.sampleRate;
    const n = Math.ceil(recipe.length * rate);
    const buffer = ctx.createBuffer(1, n, rate);
    const data = buffer.getChannelData(0);

    const ring = recipe.ring.map(([f, tau, g]) => [2 * Math.PI * f, tau, g]);
    const body = recipe.body.map(([f, tau, g]) => [2 * Math.PI * f, tau, g]);
    const bottomAt = recipe.bottom ? recipe.bottom.at : 0;

    // First-difference of white noise = a bright, zero-mean transient.
    let prevNoise = 0;
    const click = (t, tau, gain) => {
      const noise = rand() * 2 - 1;
      const bright = noise - prevNoise;
      prevNoise = noise;
      return t < 0 ? 0 : bright * gain * Math.exp(-t / tau);
    };

    const attack = Math.max(1, Math.round(0.00025 * rate));   // 0.25 ms ramp: no step at t = 0
    const fade = Math.round(0.004 * rate);                       // 4 ms raised-cosine tail

    let peak = 0;
    for (let i = 0; i < n; i++) {
      const t = i / rate;
      let v = click(t, recipe.clickTau, recipe.click);
      for (const [w, tau, g] of ring) v += Math.sin(w * t) * Math.exp(-t / tau) * g;
      for (const [w, tau, g] of body) v += Math.sin(w * t) * Math.exp(-t / tau) * g;
      if (recipe.bottom && t >= bottomAt) {
        const tb = t - bottomAt;
        v += (rand() * 2 - 1) * recipe.bottom.gain * Math.exp(-tb / recipe.bottom.tau);
        v += Math.sin(2 * Math.PI * 160 * tb) * 0.35 * recipe.bottom.gain * Math.exp(-tb / 0.01);
      }
      if (i < attack) v *= i / attack;
      if (i >= n - fade) v *= 0.5 * (1 + Math.cos(Math.PI * (i - (n - fade)) / fade));
      data[i] = v;
      peak = Math.max(peak, Math.abs(v));
    }
    const scale = peak > 0 ? recipe.level * 0.5 / peak : 0;
    for (let i = 0; i < n; i++) data[i] *= scale;
    return buffer;
  }

  function ensureAudio() {
    if (ctx) {
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return true;
    }
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return false;
    try {
      ctx = new AudioCtx({ latencyHint: 'interactive' });
    } catch {
      return false;
    }
    out = ctx.createGain();
    out.gain.value = 0.8;
    out.connect(ctx.destination);
    bank = {};
    let seed = 1;
    for (const [name, recipe] of Object.entries(RECIPES)) bank[name] = render(recipe, seed++ * 7919);
    return true;
  }

  function play(name) {
    if (!enabled || !ensureAudio()) return;
    const source = ctx.createBufferSource();
    source.buffer = bank[name];
    source.connect(out);
    source.onended = () => source.disconnect();
    source.start();
  }

  function pressable(target) {
    const el = target instanceof Element ? target.closest(PRESSABLE) : null;
    if (!el || el.matches(':disabled, [aria-disabled="true"]')) return null;
    return el;
  }

  addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !e.isPrimary) return;
    if (!pressable(e.target)) return;
    pressed = true;
    play('down');
  }, { capture: true, passive: true });

  const release = () => {
    if (!pressed) return;
    pressed = false;
    play('up');
  };
  addEventListener('pointerup', release, { capture: true, passive: true });
  addEventListener('pointercancel', () => { pressed = false; }, { capture: true, passive: true });

  addEventListener('keydown', (e) => {
    if (e.repeat || e.isComposing || MODIFIERS.has(e.key)) return;
    play('key');
  }, { capture: true });
  addEventListener('keyup', (e) => {
    if (e.isComposing || MODIFIERS.has(e.key)) return;
    play('keyup');
  }, { capture: true });

  // Title-bar toggle: <button data-sound-toggle aria-pressed="true|false">.
  function syncToggles() {
    for (const b of document.querySelectorAll('[data-sound-toggle]')) {
      b.setAttribute('aria-pressed', String(enabled));
      b.title = enabled ? 'Turn click sounds off' : 'Turn click sounds on';
    }
  }
  document.addEventListener('click', (e) => {
    const b = e.target instanceof Element ? e.target.closest('[data-sound-toggle]') : null;
    if (!b) return;
    enabled = !enabled;
    try { localStorage.setItem(STORE_KEY, enabled ? 'on' : 'off'); } catch { /* not persisted */ }
    syncToggles();
    if (enabled) play('up');
  });
  syncToggles();   // the toggle sits above this script in the page, so it exists already
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', syncToggles, { once: true });
})();
