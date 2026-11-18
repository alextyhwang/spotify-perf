// NAME: spotify-perf
// AUTHOR: Alex Hwang
// DESCRIPTION: Make the Spotify desktop client lighter: pause background animations, stop the player bar's per-second repaint and relayout, and slow Spicy Lyrics' position polling while no lyrics are on screen.
// VERSION: 0.1.0
// LICENSE: MIT
(() => {
  'use strict';
  if (window.SpotifyPerf) return;

  const VERSION = '0.1.0';
  const FEATURES = {
    backgroundAnimations: {label: 'Pause animations in background', default: true},
    playerBar: {label: 'Lightweight player bar', default: true},
    lyricsSync: {label: 'Idle Spicy Lyrics sync', default: true},
  };
  const storage = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch { /* settings stay in memory */ } },
  };
  // The background-animation key is shared with the Spicy Lyrics performance-fork companion,
  // so a saved choice carries over when switching to this extension.
  const keyFor = id => id === 'backgroundAnimations'
    ? 'spotify-performance:pause-background-animations'
    : `spotify-perf:${id}`;
  const enabled = {};
  for (const id of Object.keys(FEATURES)) {
    const saved = storage.get(keyFor(id));
    enabled[id] = saved === null ? FEATURES[id].default : saved !== 'false';
  }
  const listeners = {};

  // ─── 1. Background animations ────────────────────────────────────────────────────────────────
  // Pauses Web Animations and CSS keyframes while Spotify is hidden or another app has focus.
  // Audio, timers and requestAnimationFrame are untouched. Shares its global with the Spicy Lyrics
  // performance-fork companion: whichever loads first runs, the other steps aside.
  let animations = null;
  if (!window._spotify_background_performance) animations = (() => {
    const CLASS = 'spotify-performance-background';
    const nativeAnimate = Element.prototype.animate;
    const paused = new Map();
    let blockedAnimations = 0;
    const on = () => enabled.backgroundAnimations;
    const active = () => !on() || (document.visibilityState === 'visible' && document.hasFocus());
    const connected = a => a.effect?.target?.isConnected !== false;
    // Spicy Lyrics runs its own frame loop and PiP lifecycle for these.
    const lyricsOwned = a => !!a.effect?.target?.closest?.('#SpicyLyricsPage, #SpicyLyricsNPVCard');
    const mainOwned = a => a.effect?.target?.ownerDocument === document && !lyricsOwned(a);
    const cssOwned = a => (typeof window.CSSAnimation === 'function' && a instanceof window.CSSAnimation)
      || (typeof window.CSSTransition === 'function' && a instanceof window.CSSTransition);

    function release(a, resume = false) {
      const state = paused.get(a);
      paused.delete(a);
      if (!state) return;
      try {
        // Do not replace a method changed by the owner while the animation was inactive.
        if (a.pause === state.wrapper) {
          if (state.descriptor) Object.defineProperty(a, 'pause', state.descriptor);
          else delete a.pause;
        }
      } catch { /* Native animation state remains usable even if a property is locked. */ }
      // Explicit owner pause calls use release(a) and therefore never resume playback.
      if (resume) {
        try { if (a.playState === 'paused') a.play(); } catch { /* isolate failures */ }
      }
    }
    function prune() {
      for (const a of paused.keys()) {
        if (!connected(a) || !mainOwned(a) || a.playState === 'idle' || a.playState === 'finished') release(a, true);
      }
    }
    function pause(a) {
      // CSS keeps ownership of CSS animations/transitions; the background class handles keyframes.
      if (!connected(a) || !mainOwned(a) || cssOwned(a) || a.playState !== 'running' || paused.has(a)) return;
      const originalPause = a.pause;
      const descriptor = Object.getOwnPropertyDescriptor(a, 'pause');
      const state = {descriptor, wrapper: null};
      state.wrapper = function (...args) {
        // An explicit owner pause supersedes the temporary background pause.
        if (this === a) release(a);
        return Reflect.apply(originalPause, this, args);
      };
      try {
        Reflect.apply(originalPause, a, []);
        Object.defineProperty(a, 'pause', {configurable: true, writable: true, value: state.wrapper});
        paused.set(a, state);
        blockedAnimations++;
      } catch {
        // A successful native animate() must never throw because of this guard.
        try { if (a.playState === 'paused') a.play(); } catch { /* best effort */ }
      }
    }
    const style = document.createElement('style');
    style.id = 'spotify-perf-background';
    style.textContent = `html.${CLASS} *, html.${CLASS} *::before, html.${CLASS} *::after {
      animation-play-state: paused !important;
    }`;
    document.head.appendChild(style);
    function sync() {
      prune();
      if (active()) {
        document.documentElement.classList.remove(CLASS);
        for (const a of paused.keys()) release(a, true);
      } else {
        for (const a of document.getAnimations()) pause(a);
        document.documentElement.classList.add(CLASS);
      }
    }
    Element.prototype.animate = function (...args) {
      const a = Reflect.apply(nativeAnimate, this, args);
      if (on() && this.ownerDocument === document) {
        try { prune(); if (!active()) pause(a); } catch { /* keep native return semantics */ }
      }
      return a;
    };
    window.addEventListener('focus', sync);
    window.addEventListener('blur', sync);
    document.addEventListener('visibilitychange', sync);
    // A blur during startup is never delivered, which left Spotify in foreground mode while another
    // app had focus. Reconcile every 5 s, only acting when the state disagrees.
    window.setInterval?.(() => {
      const background = document.documentElement.classList.contains(CLASS);
      if (on() && background === active()) sync();
    }, 5000);
    const status = () => ({version: VERSION, enabled: on(), active: active(), pausedAnimations: paused.size, blockedAnimations});
    // Compatibility global: the fork companion checks it and steps aside.
    window._spotify_background_performance = {
      status,
      setEnabled(value) { window.SpotifyPerf.set('backgroundAnimations', value); },
    };
    listeners.backgroundAnimations = sync;
    sync();
    return {status};
  })();

  // ─── 2. Player bar ───────────────────────────────────────────────────────────────────────────
  // - The progress fill restarts a 1 s transform transition every second, which kept the renderer
  //   and GPU repainting nonstop even in the background. Without it the bar steps once per second
  //   (a few pixels), which is not noticeable.
  // - Each per-second tick of the bar and time labels made Chromium re-lay out the whole app
  //   (~5,700 layout objects, ~18 ms). Strict containment makes the playback bar its own layout
  //   boundary, so the tick only lays out the bar.
  const playerBarStyle = document.createElement('style');
  playerBarStyle.id = 'spotify-perf-player-bar';
  playerBarStyle.textContent = `[data-testid=playback-progressbar] * { transition: none !important; }
  .playback-bar { contain: strict; height: 14px; }
  [data-testid=playback-position], [data-testid=playback-duration] { contain: layout paint; }`;
  document.head.appendChild(playerBarStyle);
  const syncPlayerBar = () => { playerBarStyle.disabled = !enabled.playerBar; };
  listeners.playerBar = syncPlayerBar;
  syncPlayerBar();

  // ─── 3. Spicy Lyrics position sync ───────────────────────────────────────────────────────────
  // Spicy Lyrics polls Spotify's playback position every frame (setTimeout of 1000/60 ms), forever,
  // even with no lyrics on screen. Each poll is an IPC round trip to the main process: ~5% renderer
  // and ~2% main-process CPU. While no lyrics are visible, stretch only that timer to 1 s. Lyrics
  // extrapolate between polls, and per-frame polling resumes on the next poll once lyrics show.
  // No-op without Spicy Lyrics.
  const FRAME_MS = 1000 / 60;
  const IDLE_MS = 1000;
  let stretchedPolls = 0;
  const lyricsVisible = () => {
    if (window.documentPictureInPicture?.window) return true; // popup lyrics
    return document.visibilityState === 'visible' && document.hasFocus()
      && !!document.getElementById('SpicyLyricsPage');
  };
  const nativeSetTimeout = window.setTimeout;
  if (typeof nativeSetTimeout === 'function') {
    window.setTimeout = function (handler, delay, ...args) {
      if (enabled.lyricsSync && typeof delay === 'number' && Math.abs(delay - FRAME_MS) < 0.001) {
        try {
          if (!lyricsVisible() && /spicy-lyrics/i.test(new Error().stack || '')) {
            delay = IDLE_MS;
            stretchedPolls++;
          }
        } catch { /* never break a timer */ }
      }
      return Reflect.apply(nativeSetTimeout, this, [handler, delay, ...args]);
    };
  }

  // ─── API and menu ────────────────────────────────────────────────────────────────────────────
  window.SpotifyPerf = {
    version: VERSION,
    features: Object.keys(FEATURES),
    isEnabled: id => !!enabled[id],
    set(id, value) {
      if (!(id in FEATURES)) throw new Error(`spotify-perf: unknown feature "${id}"`);
      enabled[id] = !!value;
      storage.set(keyFor(id), String(enabled[id]));
      listeners[id]?.();
    },
    status: () => ({
      version: VERSION,
      enabled: {...enabled},
      backgroundAnimations: animations ? animations.status() : 'handled by the Spicy Lyrics fork companion',
      lyricsVisible: lyricsVisible(),
      stretchedPolls,
    }),
  };

  let attempts = 0;
  function registerMenu() {
    const Menu = window.Spicetify?.Menu;
    if (!Menu?.Item) {
      if (++attempts < 30) window.setTimeout(registerMenu, 100);
      return;
    }
    const items = Object.entries(FEATURES)
      .filter(([id]) => id !== 'backgroundAnimations' || animations)
      .map(([id, f]) => new Menu.Item(f.label, enabled[id], self => {
        window.SpotifyPerf.set(id, !enabled[id]);
        self.isEnabled = enabled[id];
      }));
    if (Menu.SubMenu) new Menu.SubMenu('spotify-perf', items).register();
    else items.forEach(item => item.register());
  }
  registerMenu();
})();
