// ════════════════════════════════════════════════════════════════════
//  SFX  —  UI sound effects
//  Sounds auto-load from assets/ on startup via Web Audio API.
//  All functions are patched non-destructively (original still runs).
// ════════════════════════════════════════════════════════════════════

const SFX = (() => {

  // ── Audio context (created on first user gesture to satisfy browsers) ──
  let _ctx = null;
  function _getCtx() {
    if (!_ctx) _ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (_ctx.state === 'suspended') _ctx.resume();
    return _ctx;
  }

  // ── Buffer store ──
  const _bufs = {};
  const _FILES = {
    click:    'assets/Click.wav',
    select:   'assets/Select.wav',
    positive: 'assets/Positive.wav',
    warning:  'assets/Warning.mp3',
  };

  // Load all files in parallel, silently ignore missing/blocked ones
  async function _loadAll() {
    await Promise.allSettled(
      Object.entries(_FILES).map(async ([key, path]) => {
        try {
          const res = await fetch(path);
          if (!res.ok) return;
          const ab  = await res.arrayBuffer();
          const ctx = _getCtx();
          _bufs[key] = await ctx.decodeAudioData(ab);
        } catch (_) { /* graceful — no sound if file missing */ }
      })
    );
  }

  // ── Playback ──
  function play(key, opts = {}) {
    const buf = _bufs[key];
    if (!buf) return;
    try {
      const ctx  = _getCtx();
      const src  = ctx.createBufferSource();
      src.buffer = buf;
      const gain = ctx.createGain();
      gain.gain.value = opts.volume ?? 1.0;
      src.connect(gain);
      gain.connect(ctx.destination);
      src.start(0);
    } catch (_) {}
  }

  // Public aliases
  const click    = () => play('click');
  const select   = () => play('select');
  const positive = () => play('positive');
  const warning  = () => play('warning');

  // ── Function patcher ──────────────────────────────────────────────
  // Wraps a global function so sfxFn() fires BEFORE the original.
  function patch(name, sfxFn) {
    const original = window[name];
    if (typeof original !== 'function') return;
    window[name] = function (...args) {
      try { sfxFn(); } catch (_) {}
      return original.apply(this, args);
    };
  }

  // ── Wire up after all scripts have loaded ─────────────────────────
  function _wire() {

    // ── CLICK  (navigation, toggles, dropdowns, tab switches, closes)
    patch('goStart',                click);
    patch('goOpen',                 click);
    patch('goFeatured',             click);
    patch('goCreateTextures',       click);
    patch('goCreateTexturesBack',   click);
    patch('toggleToolsDropdown',    click);
    patch('toggleEnvDropdown',      click);
    patch('toggleTerrainDetailDrop',click);
    patch('openBodySearch',         click);
    patch('closeBodySearch',        click);
    patch('closePreset',            click);
    patch('closeSidebar',           click);
    patch('openAppSettings',        click);
    patch('openSysSettings',        click);
    patch('openAssets',             click);
    patch('openPlanetComparison',   click);
    patch('openAsteroidsMenu',      click);
    patch('closeAsteroidsMenu',     click);
    patch('switchAsteroidTab',      click);
    patch('cycleDifficulty',        click);
    patch('toggleHighResSurface',   click);
    patch('toggleLockSidebar',      click);
    patch('enterDragOrbitMode',     click);
    patch('exitDragOrbitMode',      click);
    patch('prsSetTab',              click);
    patch('switchTab',              click);
    patch('undoAction',             click);
    patch('closeClearAll',          click);
    patch('zoomToBody',             click);

    // ── SELECT  (choosing items, previewing presets, body interactions)
    patch('openPreset',             select);
    patch('addBodyPrompt',          select);
    patch('replaceBodyPrompt',      select);
    patch('loadZipFromUrl',         select);

    // ── POSITIVE  (create, confirm, export, save)
    patch('goNew',                  positive);
    patch('goNewFromOpen',          positive);
    patch('confirmPreset',          positive);
    patch('exportSystem',           positive);
    patch('importFeatured',         positive);
    patch('addFogKey',              positive);
    patch('fxRandomizeSeed',        positive);   // asteroid tools
    patch('astFxRandomize',         positive);
    patch('astGenerate',            positive);
    patch('astDownload',            positive);
    patch('astExportTxt',           positive);

    // ── WARNING  (delete, clear, danger)
    patch('confirmClearAll',        warning);
    patch('clearAll',               warning);
    patch('confirmDeleteBody',      warning);
    patch('astClearCanvas',         warning);
    patch('astClearTrace',          click);
    patch('astTogglePan',           click);
    patch('astApplyRes',            click);

    // ── Toggle elements (tog divs, env buttons) via event delegation ──
    // These don't have named functions — we catch them via bubbling.
    document.addEventListener('click', e => {
      const t = e.target;
      // .tog toggles
      if (t.classList.contains('tog')) { click(); return; }
      // env surface buttons in toolbar  (env-btn-*)
      if (t.id && t.id.startsWith('env-btn-')) { click(); return; }
      // preset-modal item cards
      if (t.closest && t.closest('.prs-item')) { select(); return; }
    }, true); // capture phase so we hear it even if stopPropagation is used
  }

  // ── Bootstrap ─────────────────────────────────────────────────────
  // Load sounds immediately; wire patches once DOM is ready.
  _loadAll();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _wire);
  } else {
    _wire();
  }

  // Expose for inline use in the asteroid panel buttons
  return { click, select, positive, warning, play };
})();
