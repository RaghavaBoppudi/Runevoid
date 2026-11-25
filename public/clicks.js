// Dashboard sounds, synthesised with the Web Audio API (no audio files). Two families that never share a sound:
//
//   Pointer: an early-Macintosh UI tick. A short square-wave pulse rendered through the original Mac's audio path:
//            sample-and-hold at 22,254.5 Hz, 8-bit quantisation, then a gentle low-pass for the small built-in
//            speaker. Every press plays the same buffer, so a control sounds identical each time.
//
//   Keyboard: a recorded mechanical keystroke (public/sounds/key-down.wav and key-up.wav: one recording split
//            into press and release, so the release plays when the key actually comes up). Each press gets a
//            small random pitch (±3%) and level (±1.5 dB) change, and Space and the large keys play lower, as
//            their longer caps do. Until the recording has loaded, or if it can't be, a synthesised model plays:
//            each key-down is a faint housing tick as the stem starts to travel, then the
//            bottom-out 8–13 ms later: a bright keycap impact, a band of "thock" from the case cavity and two damped
//            case resonances. Key-up is the lighter clack of the stem springing back to the top housing.
//            Space and the large keys (Enter, Backspace, Shift, Tab, Caps Lock) are deeper and carry stabiliser
//            rattle. Each class has several renders with slightly different physics; presses rotate through them
//            at random (never the same one twice running), because identical keystrokes sound machine-gunned.
//
// Every buffer starts at zero amplitude and ends with a raised-cosine fade, so playback can't pop.
// The sounds are prepared while the page is idle after loading (AudioBuffers don't need a running AudioContext),
// so a press only has to start playback: preparing them inside the first press used to stall it for ~40 ms on
// every page. The AudioContext itself is created on the first pointer or key press (browsers block audio before
// a user gesture). The synthesised keyboard is only rendered if the recording can't be loaded.
// The on/off choice is kept in localStorage under "rv-sound".
(() => {
  'use strict';

  const STORE_KEY = 'rv-sound';
  const PRESSABLE = 'button, a[href], summary, select, label, input[type="checkbox"], input[type="radio"], [role="button"], [data-click], .item, .row.click';
  const BIG_KEYS = new Set(['Enter', 'NumpadEnter', 'Backspace', 'ShiftLeft', 'ShiftRight', 'Tab', 'CapsLock']);
  const VARIANTS = 6;
  // Recorded keystroke. URLs carry a content hash (set by src/ui.js) so a replaced file is fetched fresh.
  const script = document.currentScript;
  const SAMPLE_URLS = {
    down: script?.dataset.keyDown || '/static/sounds/key-down.wav',
    up: script?.dataset.keyUp || '/static/sounds/key-up.wav',
  };
  // Playback rate per key class: centre and random spread.
  const KEY_PITCH = { alpha: [1, 0.03], big: [0.94, 0.02], space: [0.88, 0.02] };

  // ── Keyboard recipes. Times in seconds, frequencies in Hz. ───────────────────────────────────────────────────
  const KEYS = {
    alpha: { bottomAt: [0.008, 0.011], level: 0.75,
             impact: [2200, 1.3, 0.0012], thock: [560, 2.2, 0.006, 0.8], cases: [[210, 0.018, 0.5], [980, 0.004, 0.3]], rattle: [] },
    big:   { bottomAt: [0.009, 0.012], level: 0.85,
             impact: [1750, 1.2, 0.0014], thock: [430, 2.0, 0.008, 0.9], cases: [[170, 0.024, 0.6], [820, 0.005, 0.3]], rattle: [0.003] },
    space: { bottomAt: [0.010, 0.013], level: 0.95,
             impact: [1400, 1.1, 0.0016], thock: [340, 1.8, 0.010, 1.0], cases: [[135, 0.032, 0.7], [690, 0.006, 0.3]], rattle: [0.0025, 0.006] },
  };
  const KEY_UP = {
    alpha: { level: 0.42, slap: [3000, 1.5, 0.0008], cases: [[1200, 0.003, 0.25], [330, 0.008, 0.2]] },
    big:   { level: 0.5,  slap: [2500, 1.4, 0.001],  cases: [[1000, 0.0035, 0.25], [260, 0.012, 0.25]] },
    space: { level: 0.55, slap: [2100, 1.3, 0.0012], cases: [[850, 0.004, 0.25], [200, 0.016, 0.3]] },
  };

  let enabled = true;
  try { enabled = localStorage.getItem(STORE_KEY) !== 'off'; } catch { /* storage blocked: default on */ }

  const RATE = 48000;   // sample rate the buffers are rendered at; playback resamples if the device differs
  let ctx = null;
  let out = null;
  const bank = {};      // name -> AudioBuffer[]
  let pressed = false;
  let samples = null;   // { down, up } AudioBuffers once decoded
  let synthKeys = false;
  const last = {};

  const makeBuffer = (n) => new AudioBuffer({ numberOfChannels: 1, length: n, sampleRate: RATE });

  // Deterministic PRNG (mulberry32), so renders are stable between page loads.
  function prng(seed) {
    return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // RBJ band-pass biquad (constant 0 dB peak gain), applied in place.
  function bandpass(x, f, q, rate) {
    const w = 2 * Math.PI * f / rate;
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha;
    const b0 = alpha / a0, b2 = -alpha / a0, a1 = -2 * Math.cos(w) / a0, a2 = (1 - alpha) / a0;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const y = b0 * x[i] + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x[i]; y2 = y1; y1 = y;
      x[i] = y;
    }
    return x;
  }

  // A decaying noise burst through a band-pass, starting at `at`.
  function burst(n, rate, rand, at, [f, q, tau], gain) {
    const x = new Float32Array(n);
    const start = Math.round(at * rate);
    for (let i = start; i < n; i++) x[i] = (rand() * 2 - 1) * Math.exp(-(i - start) / rate / tau);
    bandpass(x, f, q, rate);
    for (let i = 0; i < n; i++) x[i] *= gain;
    return x;
  }

  // Zero-start ramp, raised-cosine tail, then scale the peak to `level`.
  function finish(data, rate, level) {
    const n = data.length;
    const attack = Math.max(1, Math.round(0.00025 * rate));
    const fade = Math.round(0.004 * rate);
    let peak = 0;
    for (let i = 0; i < n; i++) {
      if (i < attack) data[i] *= i / attack;
      if (i >= n - fade) data[i] *= 0.5 * (1 + Math.cos(Math.PI * (i - (n - fade)) / fade));
      peak = Math.max(peak, Math.abs(data[i]));
    }
    const scale = peak > 0 ? level * 0.5 / peak : 0;
    for (let i = 0; i < n; i++) data[i] *= scale;
  }

  const jitter = (rand, v, amount) => v * (1 + (rand() * 2 - 1) * amount);

  function renderKeyDown(r, seed) {
    const rand = prng(seed);
    const rate = RATE;
    const n = Math.ceil(0.075 * rate);
    const buffer = makeBuffer(n);
    const data = buffer.getChannelData(0);
    const at = r.bottomAt[0] + rand() * (r.bottomAt[1] - r.bottomAt[0]);

    const layers = [
      burst(n, rate, rand, 0, [5200, 0.9, 0.0004], 0.12),                                       // stem leaves the housing
      burst(n, rate, rand, at, [jitter(rand, r.impact[0], 0.06), r.impact[1], r.impact[2]], 1),  // keycap hits bottom
      burst(n, rate, rand, at, [jitter(rand, r.thock[0], 0.05), r.thock[1], r.thock[2]], r.thock[3]), // case cavity
      ...r.rattle.map((dt) => burst(n, rate, rand, at + dt, [3200, 1.5, 0.0006], 0.22)),          // stabiliser wire
    ];
    const cases = r.cases.map(([f, tau, g]) => [2 * Math.PI * jitter(rand, f, 0.04), tau, g]);
    for (let i = 0; i < n; i++) {
      let v = 0;
      for (const l of layers) v += l[i];
      const tb = i / rate - at;
      if (tb >= 0) for (const [w, tau, g] of cases) v += Math.sin(w * tb) * Math.exp(-tb / tau) * g;
      data[i] = v;
    }
    finish(data, rate, jitter(rand, r.level, 0.08));
    return buffer;
  }

  function renderKeyUp(r, seed) {
    const rand = prng(seed);
    const rate = RATE;
    const n = Math.ceil(0.045 * rate);
    const buffer = makeBuffer(n);
    const data = buffer.getChannelData(0);
    const slap = burst(n, rate, rand, 0, [jitter(rand, r.slap[0], 0.06), r.slap[1], r.slap[2]], 0.7);
    const cases = r.cases.map(([f, tau, g]) => [2 * Math.PI * jitter(rand, f, 0.04), tau, g]);
    for (let i = 0; i < n; i++) {
      const t = i / rate;
      let v = slap[i];
      for (const [w, tau, g] of cases) v += Math.sin(w * t) * Math.exp(-t / tau) * g;
      data[i] = v;
    }
    finish(data, rate, jitter(rand, r.level, 0.08));
    return buffer;
  }

  // Early-Mac UI tick: square pulse plus a short body, through 22.25 kHz / 8-bit and a small-speaker low-pass.
  function renderTick({ length, freq, tau, body, level }) {
    const rate = RATE;
    const n = Math.ceil(length * rate);
    const buffer = makeBuffer(n);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < n; i++) {
      const t = i / rate;
      let v = Math.sign(Math.sin(2 * Math.PI * freq * t)) * Math.exp(-t / tau) * 0.6;
      if (body) v += Math.sin(2 * Math.PI * body[0] * t) * Math.exp(-t / body[1]) * 0.4;
      data[i] = v;
    }
    // Sample-and-hold at the original Macintosh rate, quantised to 8 bits.
    const hold = rate / 22254.5;
    let held = 0;
    for (let i = 0, next = 0; i < n; i++) {
      if (i >= next) { held = Math.round(data[i] * 127) / 127; next += hold; }
      data[i] = held;
    }
    // One-pole low-pass at ~5 kHz: the built-in speaker.
    const a = Math.exp(-2 * Math.PI * 5000 / rate);
    let y = 0;
    for (let i = 0; i < n; i++) { y = (1 - a) * data[i] + a * y; data[i] = y; }
    finish(data, rate, level);
    return buffer;
  }

  // UI ticks: two short buffers, cheap enough to make on demand if a press comes before the idle preparation.
  function prepareTicks() {
    if (bank.down) return;
    bank.down = [renderTick({ length: 0.03, freq: 1050, tau: 0.0022, body: [520, 0.006], level: 0.7 })];
    bank.up = [renderTick({ length: 0.02, freq: 1600, tau: 0.0012, body: null, level: 0.4 })];
  }

  // Fallback keyboard, only when the recording is unavailable: six renders per key class.
  function prepareSynthKeys() {
    if (synthKeys) return;
    synthKeys = true;
    let seed = 1;
    for (const kind of Object.keys(KEYS)) {
      bank[`${kind}Down`] = Array.from({ length: VARIANTS }, () => renderKeyDown(KEYS[kind], seed++ * 7919));
      bank[`${kind}Up`] = Array.from({ length: VARIANTS }, () => renderKeyUp(KEY_UP[kind], seed++ * 7919));
    }
  }

  async function loadSamples() {
    try {
      // An offline context decodes without a user gesture and without opening the audio device.
      const decoder = new OfflineAudioContext(1, 1, RATE);
      const decode = async (url) => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${url}: ${res.status}`);
        return decoder.decodeAudioData(await res.arrayBuffer());
      };
      const [down, up] = await Promise.all([decode(SAMPLE_URLS.down), decode(SAMPLE_URLS.up)]);
      samples = { down, up };
    } catch {
      idle(prepareSynthKeys);   // keep a synthesised keyboard
    }
  }

  const idle = (fn) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 1500 }) : setTimeout(fn, 200));
  if (typeof AudioBuffer === 'function' && typeof OfflineAudioContext === 'function') idle(() => { prepareTicks(); loadSamples(); });

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
    prepareTicks();
    return true;
  }

  function playKey(kind, phase) {
    if (!enabled || !ensureAudio()) return;
    if (!samples) { prepareSynthKeys(); play(`${kind}${phase === 'down' ? 'Down' : 'Up'}`); return; }
    const [centre, spread] = KEY_PITCH[kind];
    const source = ctx.createBufferSource();
    source.buffer = samples[phase];
    source.playbackRate.value = centre * (1 + (Math.random() * 2 - 1) * spread);
    const gain = ctx.createGain();
    gain.gain.value = 10 ** (((Math.random() * 2 - 1) * 1.5) / 20);
    source.connect(gain).connect(out);
    source.onended = () => { source.disconnect(); gain.disconnect(); };
    source.start();
  }

  function play(name) {
    if (!enabled || !ensureAudio()) return;
    const set = bank[name];
    let i = 0;
    if (set.length > 1) {
      i = Math.floor(Math.random() * (set.length - 1));
      if (i >= (last[name] ?? -1)) i += 1;   // any render but the previous one
      last[name] = i;
    }
    const source = ctx.createBufferSource();
    source.buffer = set[i];
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

  const keyKind = (code) => (code === 'Space' ? 'space' : BIG_KEYS.has(code) ? 'big' : 'alpha');
  addEventListener('keydown', (e) => {
    if (e.repeat || e.isComposing) return;
    playKey(keyKind(e.code), 'down');
  }, { capture: true });
  addEventListener('keyup', (e) => {
    if (e.isComposing) return;
    playKey(keyKind(e.code), 'up');
  }, { capture: true });

  // Title-bar toggle: <button data-sound-toggle aria-pressed="true|false">.
  function syncToggles() {
    for (const b of document.querySelectorAll('[data-sound-toggle]')) {
      b.setAttribute('aria-pressed', String(enabled));
      b.title = enabled ? 'Turn sounds off' : 'Turn sounds on';
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
