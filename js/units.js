// ════════════════════════════════ UNIT CONVERSION ════════════════════════════════
// All distance fields store raw metres internally.
// The unit selector controls display/entry scale.
// Typing "1.5 AU" or "300 km" is parsed on blur and converted to metres.
// Changing the unit selector re-expresses the current metres in the new unit.

const UNIT_TO_M = {
  m:       1,
  km:      1e3,
  Mm:      1e6,
  Gm:      1e9,
  AU:      1.495978707e11,
  ly:      9.4607304725808e15,
  R_earth: 6.371e6,   // Earth radius (~6,371 km)
  R_sun:   6.957e8,   // Sun radius (~695,700 km)
  R_jupiter: 7.1492e7, // Jupiter radius (~71,492 km)
};

// Unstable warning threshold: 700 Megametres
const UNSTABLE_RADIUS_M = 700e6;

// ── Formatting helpers ─────────────────────────────────────────────────────────
function _fmt(v) {
  if (v === 0) return '0';
  const abs = Math.abs(v);
  if (abs >= 1e9)  return v.toExponential(3);
  if (abs >= 1000) return parseFloat(v.toPrecision(6)).toString();
  if (abs >= 1)    return parseFloat(v.toPrecision(5)).toString();
  return parseFloat(v.toPrecision(4)).toString();
}

function _fmtHint(metres, unit) {
  const f = UNIT_TO_M[unit] ?? 1;
  return _fmt(metres / f) + '\u202f' + unit;
}

// Express metres in a given unit for display in the input box
function _metresToDisplay(metres, unit) {
  const f = UNIT_TO_M[unit] ?? 1;
  const v = metres / f;
  // Enough precision to roundtrip losslessly
  if (Math.abs(v) >= 1e9) return parseFloat(v.toPrecision(7)).toString();
  if (Math.abs(v) >= 100) return parseFloat(v.toPrecision(6)).toString();
  return parseFloat(v.toPrecision(7)).toString();
}

// ── Parse "1.5 AU" or "300 km" or "1.5e11" ────────────────────────────────────
function _parseUnitString(str) {
  if (!str) return null;
  const m = str.trim().match(/^([+-]?\d*\.?\d+(?:[eE][+-]?\d+)?)\s*([a-zA-Z_⊕☉°]*)$/);
  if (!m) return null;
  return { value: parseFloat(m[1]), unit: m[2] || null };
}

const _ALIAS = {
  'm': 'm', 'meter': 'm', 'meters': 'm', 'metre': 'm', 'metres': 'm',
  'km': 'km', 'kilometer': 'km', 'kilometre': 'km', 'kilometers': 'km',
  'mm': 'Mm', 'megameter': 'Mm', 'megametre': 'Mm', 'megameters': 'Mm',
  'gm': 'Gm', 'gigameter': 'Gm', 'gigametre': 'Gm', 'gigameters': 'Gm',
  'au': 'AU',
  'ly': 'ly', 'lightyear': 'ly', 'light-year': 'ly', 'lightyears': 'ly',
  'rearth': 'R_earth', 're': 'R_earth', 'r_earth': 'R_earth',
  'rsun': 'R_sun', 'rs': 'R_sun', 'r_sun': 'R_sun',
  'rjupiter': 'R_jupiter', 'rj': 'R_jupiter', 'r_jupiter': 'R_jupiter',
};

function _resolveUnit(raw) {
  if (!raw) return null;
  const lc = raw.toLowerCase().replace(/[⊕☉°]/g, '');
  return _ALIAS[lc] ?? null;
}

// ── Internal state: store metres per input id ──────────────────────────────────
const _distMetres = {};  // { inputId: rawMetres }

// ── Core: set input to display a metres value in the current unit ──────────────
function _applyMetres(inputId, unitSelId, hintId, mode, metres) {
  _distMetres[inputId] = metres;
  const input   = document.getElementById(inputId);
  const unitSel = document.getElementById(unitSelId);
  if (!input) return;
  const unit = unitSel?.value || 'm';
  input.value = metres !== 0 ? _metresToDisplay(metres, unit) : '';
  _updateHint(metres, unitSelId, hintId, mode);
}

// ── Public: called from fillSidebar to populate a field ───────────────────────
function setDistInput(inputId, unitSelId, hintId, metres, mode) {
  // Don't overwrite a field the user is actively editing
  if (document.activeElement?.id === inputId) return;
  // Auto-select a sensible default unit if none has been chosen yet
  const unitSel = document.getElementById(unitSelId);
  if (unitSel && unitSel.dataset.userPicked !== '1') {
    unitSel.value = _bestUnit(metres, mode);
  }
  _applyMetres(inputId, unitSelId, hintId, mode, metres ?? 0);
}

// Pick a sensible unit for a given metres value
function _bestUnit(m, mode) {
  const abs = Math.abs(m);
  if (mode === 'sma') {
    if (abs === 0)        return 'AU';
    if (abs < 1e6)        return 'km';
    if (abs < 1e9)        return 'Mm';
    if (abs < 5e12)       return 'AU';
    return 'ly';
  } else {
    // radius
    if (abs < 1e5)        return 'km';
    if (abs < 5e7)        return 'km';
    if (abs < 1e9)        return 'Mm';
    return 'Gm';
  }
}

// ── Public: read metres back out (used by liveSync / buildOrbitData) ──────────
function getDistMetres(inputId) {
  // Prefer stored value; fall back to parsing whatever is in the box as metres
  if (_distMetres[inputId] !== undefined) return _distMetres[inputId];
  return parseFloat(document.getElementById(inputId)?.value) || 0;
}

// ── Event: user typed something in the input box ───────────────────────────────
// oninput — live preview of converted value in hint
function onDistInput(inputId, unitSelId, hintId, mode) {
  const input   = document.getElementById(inputId);
  const unitSel = document.getElementById(unitSelId);
  const raw = input?.value?.trim() || '';

  const parsed = _parseUnitString(raw);
  if (!parsed) return;

  let metres;
  if (parsed.unit) {
    const resolved = _resolveUnit(parsed.unit);
    const factor   = (resolved && UNIT_TO_M[resolved]) ? UNIT_TO_M[resolved]
                   : (UNIT_TO_M[unitSel?.value] ?? 1);
    metres = parsed.value * factor;
  } else {
    const factor = UNIT_TO_M[unitSel?.value] ?? 1;
    metres = parsed.value * factor;
  }
  _distMetres[inputId] = metres;
  _updateHint(metres, unitSelId, hintId, mode);
  if (typeof liveSync === 'function') liveSync();
}

// ── Event: user changed the unit dropdown ─────────────────────────────────────
// Re-express current metres in the new unit
function onUnitChange(inputId, unitSelId, hintId, mode) {
  const unitSel = document.getElementById(unitSelId);
  if (unitSel) unitSel.dataset.userPicked = '1';
  const metres = _distMetres[inputId] ?? (parseFloat(document.getElementById(inputId)?.value) || 0);
  _applyMetres(inputId, unitSelId, hintId, mode, metres);
  if (typeof liveSync === 'function') liveSync();
}

// ── Attach blur parser so "1.5 AU" typed in the box is converted ──────────────
function attachUnitParser(inputId, unitSelId, hintId, mode) {
  const input   = document.getElementById(inputId);
  const unitSel = document.getElementById(unitSelId);
  if (!input) return;

  // Use text input so user can type units inline
  input.type       = 'text';
  input.inputMode  = 'decimal';
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('autocorrect',  'off');
  input.setAttribute('spellcheck',   'false');

  input.addEventListener('blur', () => {
    const raw    = input.value.trim();
    const parsed = _parseUnitString(raw);
    if (!parsed) return;

    let metres;
    if (parsed.unit) {
      const resolved = _resolveUnit(parsed.unit);
      if (resolved && UNIT_TO_M[resolved]) {
        metres = parsed.value * UNIT_TO_M[resolved];
        // Switch the selector to match the typed unit
        if (unitSel) {
          const opt = Array.from(unitSel.options).find(o => o.value === resolved);
          if (opt) { unitSel.value = resolved; unitSel.dataset.userPicked = '1'; }
        }
      } else {
        // Unrecognised unit — treat as current unit
        metres = parsed.value * (UNIT_TO_M[unitSel?.value] ?? 1);
      }
    } else {
      metres = parsed.value * (UNIT_TO_M[unitSel?.value] ?? 1);
    }

    _distMetres[inputId] = metres;
    // Re-display in current unit (strips the typed unit text cleanly)
    const unit = unitSel?.value || 'm';
    input.value = metres !== 0 ? _metresToDisplay(metres, unit) : '';
    _updateHint(metres, unitSelId, hintId, mode);
    if (typeof liveSync === 'function') liveSync();
  });

  // Live hint as user types
  input.addEventListener('input', () => {
    const raw    = input.value.trim();
    const parsed = _parseUnitString(raw);
    if (!parsed) return;
    let metres;
    if (parsed.unit) {
      const resolved = _resolveUnit(parsed.unit);
      const factor   = (resolved && UNIT_TO_M[resolved]) ? UNIT_TO_M[resolved]
                     : (UNIT_TO_M[unitSel?.value] ?? 1);
      metres = parsed.value * factor;
    } else {
      metres = parsed.value * (UNIT_TO_M[unitSel?.value] ?? 1);
    }
    _distMetres[inputId] = metres;
    _updateHint(metres, unitSelId, hintId, mode);
    if (typeof liveSync === 'function') liveSync();
  });
}

// ── Hint builder ───────────────────────────────────────────────────────────────
function _updateHint(metres, unitSelId, hintId, mode) {
  const hintEl  = document.getElementById(hintId);
  if (!hintEl) return;
  if (!metres) { hintEl.classList.remove('show'); hintEl.textContent = ''; return; }

  const unit  = document.getElementById(unitSelId)?.value || 'm';
  const lines = [];

  if (mode === 'sma') {
    // `metres` is the display value = storedSMA × effectiveScale(currentDiff).
    // To show N/H/R: recover storedSMA by dividing out the current scale,
    // then multiply by each difficulty's effective scale.
    // Per-body smaDifficultyScale replaces global default entirely (mirrors game SmaScale()).
    const _defSMA = { Normal: 1, Hard: 2, Realistic: 20 };
    const _vdk = (typeof viewDiffKey !== 'undefined') ? viewDiffKey : 'Normal';
    const od = (typeof selectedBody !== 'undefined' && selectedBody && typeof bodies !== 'undefined')
               ? bodies[selectedBody]?.data?.ORBIT_DATA : null;
    const _rawSds = od?.smaDifficultyScale || {};
    function _smaScale(dk) {
      const v = _rawSds[dk] ?? _rawSds[dk.toLowerCase()];
      return (v != null) ? v : (_defSMA[dk] ?? 1);
    }
    // Recover stored SMA from the currently-displayed metres
    const currentScale = _smaScale(_vdk);
    const storedSMA = currentScale > 0 ? metres / currentScale : metres;
    const n = storedSMA * _smaScale('Normal');
    const h = storedSMA * _smaScale('Hard');
    const r = storedSMA * _smaScale('Realistic');
    lines.push(
      'N\u202f' + _fmtHint(n, unit) +
      '  H\u202f' + _fmtHint(h, unit) +
      '  R\u202f' + _fmtHint(r, unit)
    );
    // Also show in AU if different unit selected
    if (unit !== 'AU') {
      lines.push(
        'N\u202f' + _fmtHint(n, 'AU') +
        '  H\u202f' + _fmtHint(h, 'AU') +
        '  R\u202f' + _fmtHint(r, 'AU')
      );
    }
  } else {
    // Radius: show conversions in useful units
    const alts = [];
    if (unit !== 'km')      alts.push(_fmtHint(metres, 'km'));
    if (unit !== 'R_earth') alts.push(_fmtHint(metres, 'R_earth') + ' R⊕');
    if (unit !== 'R_sun' && metres > 5e7) alts.push(_fmtHint(metres, 'R_sun') + ' R☉');
    if (unit !== 'R_jupiter' && metres > 1e7) alts.push(_fmtHint(metres, 'R_jupiter') + ' R♃');
    if (alts.length) lines.push(alts.join('  ·  '));
    // Show unstable warning if radius exceeds 700 Mm
    if (metres >= UNSTABLE_RADIUS_M) {
      const inMm  = metres / UNIT_TO_M['Mm'];
      lines.push('⚠ unstable above 700 Mm (' + _fmt(inMm) + '\u202fMm)');
    }
  }

  if (lines.length) {
    hintEl.textContent = lines.join('\n');
    hintEl.classList.add('show');
    // Highlight in amber when unstable-radius warning is present
    if (mode !== 'sma' && metres >= UNSTABLE_RADIUS_M) {
      hintEl.classList.add('warn');
    } else {
      hintEl.classList.remove('warn');
    }
  } else {
    hintEl.classList.remove('show');
    hintEl.classList.remove('warn');
    hintEl.textContent = '';
  }
}

// ── Wire up all distance fields after DOM is ready ────────────────────────────
function initUnitInputs() {
  [
    ['or-sma',   'or-sma-unit',   'or-sma-hint',   'sma'],
    ['b-radius', 'b-radius-unit', 'b-radius-hint',  'radius'],
    ['rng-sr',   'rng-sr-unit',   'rng-sr-hint',    'radius'],
    ['rng-er',   'rng-er-unit',   'rng-er-hint',    'radius'],
  ].forEach(([a, b, c, d]) => attachUnitParser(a, b, c, d));
  attachPeriodParser('or-period', 'or-period-unit', 'or-period-hint');
}

// ════════════════════════════════ ORBITAL PERIOD ══════════════════════════════
// Orbital period = 2π × √(a³ / GM_parent)
// GM_parent = parent.gravity × parent.radius²  (both at chosen difficulty)
// Difficulty is read from the live viewDiffKey / viewDifficulty globals set by
// the viewport toggle — the same values used by effectiveSMA() / getRadiusDifficultyMult().
//
// The field is two-way:
//   SMA → Period  : recomputed whenever SMA or parent changes  (updatePeriodFromSMA)
//   Period → SMA  : user types a period; SMA is back-calculated (updateSMAFromPeriod)

const TIME_TO_S = {
  s:   1,
  min: 60,
  h:   3600,
  d:   86400,
  y:   365.25 * 86400,
};

const _TIME_ALIAS = {
  's': 's', 'sec': 's', 'second': 's', 'seconds': 's',
  'min': 'min', 'minute': 'min', 'minutes': 'min',
  'h': 'h', 'hr': 'h', 'hour': 'h', 'hours': 'h',
  'd': 'd', 'day': 'd', 'days': 'd',
  'y': 'y', 'yr': 'y', 'year': 'y', 'years': 'y',
};

// Stored period in seconds
let _periodSeconds = null;   // null = not yet computed / no valid parent

function _resolveTimeUnit(raw) {
  if (!raw) return null;
  return _TIME_ALIAS[raw.toLowerCase().trim()] ?? null;
}

function _bestTimeUnit(s) {
  if (s == null || !isFinite(s) || s <= 0) return 'h';
  if (s <  120)          return 's';
  if (s <  7200)         return 'min';
  if (s <  172800)       return 'h';
  if (s <  63115200)     return 'd';
  return 'y';
}

function _fmtTime(s, unit) {
  const v = s / TIME_TO_S[unit];
  if (Math.abs(v) >= 1e6) return parseFloat(v.toPrecision(5)).toString();
  if (Math.abs(v) >= 100) return parseFloat(v.toPrecision(6)).toString();
  return parseFloat(v.toPrecision(7)).toString();
}

// Compute GM of the parent body at the current difficulty, returns null if unknown
function _parentGM() {
  // Requires sidebar globals: selectedBody, bodies, viewDiffKey, viewDifficulty
  if (typeof selectedBody === 'undefined' || !selectedBody) return null;
  if (typeof bodies === 'undefined') return null;
  const b = bodies[selectedBody];
  if (!b) return null;
  const parentName = b.data?.ORBIT_DATA?.parent;
  if (!parentName) return null;
  const pb = bodies[parentName];
  if (!pb) return null;
  const pbd = pb.data?.BASE_DATA || {};

  // gravity (m/s² at surface) and radius (m) — both may have difficulty scales
  let g = pbd.gravity || 0;
  let r = pbd.radius  || 0;

  // Apply difficulty scaling to parent radius
  if (typeof getRadiusDifficultyMult === 'function') {
    r = r * getRadiusDifficultyMult(pbd);
  } else {
    // Fallback manual lookup mirroring getRadiusDifficultyMult
    const vdk = (typeof viewDiffKey !== 'undefined') ? viewDiffKey : 'Normal';
    const rs = pbd.radiusDifficultyScale;
    const rm = (rs && rs[vdk] != null) ? rs[vdk] : 1;
    r = r * rm;
  }

  // gravity is surface gravity — it already is in m/s² per unit radius²
  // GM = g × r²
  if (r <= 0 || g <= 0) return null;
  return g * r * r;
}

// Compute period (seconds) from stored SMA metres + current difficulty.
// Uses the same logic as effectiveSMA() in viewport.js so periods always
// agree with the visual orbit display.
// _DEF_SMA_SCALE: Normal=1, Hard=2, Realistic=20 (files store Normal-mode SMA).
// Per-body smaDifficultyScale replaces the default entirely when present.
const _DEF_SMA_SCALE_UNITS = { Normal: 1, Hard: 2, Realistic: 20 };
function _effectiveSMAForPeriod(smaMetres) {
  const vdk = (typeof viewDiffKey !== 'undefined') ? viewDiffKey : 'Normal';
  const od  = (typeof selectedBody !== 'undefined' && selectedBody && typeof bodies !== 'undefined')
              ? bodies[selectedBody]?.data?.ORBIT_DATA : null;
  const scale  = od?.smaDifficultyScale;
  const mult   = (scale && scale[vdk] != null) ? scale[vdk] : (_DEF_SMA_SCALE_UNITS[vdk] ?? 1);
  return smaMetres * mult;
}
function _periodFromSMA(smaMetres) {
  const GM = _parentGM();
  if (GM == null || GM <= 0) return null;
  const a = _effectiveSMAForPeriod(smaMetres);
  if (a <= 0) return null;
  return 2 * Math.PI * Math.sqrt((a * a * a) / GM);
}

// Compute SMA (metres) from a period (seconds), un-scaling difficulty.
// Inverse of _periodFromSMA — uses the same _effectiveSMAForPeriod multiplier.
function _smaFromPeriod(periodS) {
  const GM = _parentGM();
  if (GM == null || GM <= 0) return null;
  if (periodS <= 0) return null;

  // a_eff = (T / 2π)^(2/3) × GM^(1/3)
  const ratio = periodS / (2 * Math.PI);
  const a_eff = Math.pow(ratio * ratio * GM, 1/3);

  // Recover stored SMA by dividing out the same difficulty multiplier used in _periodFromSMA.
  const vdk    = (typeof viewDiffKey !== 'undefined') ? viewDiffKey : 'Normal';
  const od     = (typeof selectedBody !== 'undefined' && selectedBody && typeof bodies !== 'undefined')
                 ? bodies[selectedBody]?.data?.ORBIT_DATA : null;
  const scale  = od?.smaDifficultyScale;
  const mult   = (scale && scale[vdk] != null) ? scale[vdk] : (_DEF_SMA_SCALE_UNITS[vdk] ?? 1);
  if (mult <= 0) return a_eff;
  return a_eff / mult;
}

// Update the period display from the current SMA — called after SMA changes
function updatePeriodFromSMA() {
  const inputId   = 'or-period';
  const unitSelId = 'or-period-unit';
  const hintId    = 'or-period-hint';

  // Don't clobber if user is editing the period box right now
  if (document.activeElement?.id === inputId) return;

  // getDistMetres('or-sma') is the display value (storedSMA × currentDiffScale).
  // _periodFromSMA expects storedSMA and applies the scale internally, so recover it first.
  const _dispSma   = (typeof getDistMetres === 'function') ? getDistMetres('or-sma') : 0;
  const _vdkP      = (typeof viewDiffKey !== 'undefined') ? viewDiffKey : 'Normal';
  const _odP       = (typeof selectedBody !== 'undefined' && selectedBody && typeof bodies !== 'undefined')
                     ? bodies[selectedBody]?.data?.ORBIT_DATA : null;
  const _sdsP      = _odP?.smaDifficultyScale || {};
  const _scP       = (_sdsP[_vdkP] != null) ? _sdsP[_vdkP] : (_DEF_SMA_SCALE_UNITS[_vdkP] ?? 1);
  const smaMetres  = (_scP > 0 && _dispSma > 0) ? _dispSma / _scP : _dispSma;
  const T = _periodFromSMA(smaMetres);
  _periodSeconds = T;

  const input   = document.getElementById(inputId);
  const unitSel = document.getElementById(unitSelId);
  const hintEl  = document.getElementById(hintId);
  if (!input) return;

  if (T == null || !isFinite(T) || T <= 0) {
    input.value       = '';
    if (unitSel && unitSel.dataset.userPicked !== '1') unitSel.value = 'h';
    if (hintEl) { hintEl.textContent = ''; hintEl.classList.remove('show'); }
    return;
  }

  if (unitSel && unitSel.dataset.userPicked !== '1') unitSel.value = _bestTimeUnit(T);
  const unit = unitSel?.value || 'h';
  input.value = _fmtTime(T, unit);
  _updatePeriodHint(T, unitSelId, hintId);
}

// Update SMA from a typed period value — called on period input/blur
function updateSMAFromPeriod() {
  const inputId   = 'or-period';
  const unitSelId = 'or-period-unit';
  const hintId    = 'or-period-hint';

  const input   = document.getElementById(inputId);
  const unitSel = document.getElementById(unitSelId);
  if (!input) return;

  const raw    = input.value.trim();
  const parsed = _parseUnitString(raw);
  if (!parsed) return;

  let periodS;
  if (parsed.unit) {
    const resolved = _resolveTimeUnit(parsed.unit);
    periodS = parsed.value * (resolved ? TIME_TO_S[resolved] : (TIME_TO_S[unitSel?.value] ?? 1));
    if (resolved && unitSel) {
      const opt = Array.from(unitSel.options).find(o => o.value === resolved);
      if (opt) { unitSel.value = resolved; unitSel.dataset.userPicked = '1'; }
    }
  } else {
    periodS = parsed.value * (TIME_TO_S[unitSel?.value] ?? 1);
  }

  _periodSeconds = periodS;

  // Back-calculate SMA
  const newSMA = _smaFromPeriod(periodS);
  if (newSMA != null && isFinite(newSMA) && newSMA > 0) {
    // Write to SMA field
    if (typeof _distMetres !== 'undefined') _distMetres['or-sma'] = newSMA;
    const smaInput   = document.getElementById('or-sma');
    const smaUnitSel = document.getElementById('or-sma-unit');
    const smaHintEl  = document.getElementById('or-sma-hint');
    if (smaInput) {
      const smaUnit = smaUnitSel?.value || 'AU';
      smaInput.value = _metresToDisplay(newSMA, smaUnit);
      if (typeof _updateHint === 'function') _updateHint(newSMA, 'or-sma-unit', 'or-sma-hint', 'sma');
    }
    if (typeof liveSync === 'function') liveSync();
  }

  _updatePeriodHint(periodS, unitSelId, hintId);
}

function _updatePeriodHint(periodS, unitSelId, hintId) {
  const hintEl = document.getElementById(hintId);
  if (!hintEl || !periodS || !isFinite(periodS)) {
    if (hintEl) { hintEl.textContent = ''; hintEl.classList.remove('show'); }
    return;
  }
  const unit   = document.getElementById(unitSelId)?.value || 'h';
  const lines  = [];

  // Show conversions in other units
  const alts = [];
  if (unit !== 's'   && periodS < 7200)          alts.push(_fmtTime(periodS, 's')   + '\u202fs');
  if (unit !== 'min' && periodS < 172800)         alts.push(_fmtTime(periodS, 'min') + '\u202fmin');
  if (unit !== 'h'   && periodS >= 60)            alts.push(_fmtTime(periodS, 'h')   + '\u202fh');
  if (unit !== 'd'   && periodS >= 3600)          alts.push(_fmtTime(periodS, 'd')   + '\u202fd');
  if (unit !== 'y'   && periodS >= 86400 * 30)    alts.push(_fmtTime(periodS, 'y')   + '\u202fy');
  if (alts.length) lines.push(alts.slice(0, 3).join('  ·  '));

  // Show per-difficulty periods
  const GM = _parentGM();
  if (GM != null && GM > 0) {
    // getDistMetres('or-sma') returns display value = storedSMA × currentDiffScale.
    // Recover storedSMA first, then apply each difficulty's scale for correct N/H/R periods.
    const displayMetres = (typeof getDistMetres === 'function') ? getDistMetres('or-sma') : 0;
    const vdk = (typeof viewDiffKey !== 'undefined') ? viewDiffKey : 'Normal';
    const od  = (typeof selectedBody !== 'undefined' && selectedBody && typeof bodies !== 'undefined')
                ? bodies[selectedBody]?.data?.ORBIT_DATA : null;
    if (od && displayMetres > 0) {
      const _rsd = od.smaDifficultyScale || {};
      function _sc(dk) { const v = _rsd[dk] ?? _rsd[dk.toLowerCase()]; return (v != null) ? v : (_DEF_SMA_SCALE_UNITS[dk] ?? 1); }
      const storedSMA = (_sc(vdk) > 0) ? displayMetres / _sc(vdk) : displayMetres;
      const diffs = ['Normal', 'Hard', 'Realistic'];
      const labels = ['N', 'H', 'R'];
      const parts = diffs.map((dk, i) => {
        const a_eff = storedSMA * _sc(dk);
        if (a_eff <= 0) return null;
        const T_diff = 2 * Math.PI * Math.sqrt((a_eff * a_eff * a_eff) / GM);
        return labels[i] + ' ' + _fmtTime(T_diff, unit) + ' ' + unit;
      }).filter(Boolean);
      if (parts.length) lines.push(parts.join('  '));
    }
  }

  if (lines.length) {
    hintEl.textContent = lines.join('\n');
    hintEl.classList.add('show');
  } else {
    hintEl.textContent = '';
    hintEl.classList.remove('show');
  }
}

// Attach blur/input/unit-change handlers to the period field
function attachPeriodParser(inputId, unitSelId, hintId) {
  const input   = document.getElementById(inputId);
  const unitSel = document.getElementById(unitSelId);
  if (!input) return;

  input.type       = 'text';
  input.inputMode  = 'decimal';
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('autocorrect',  'off');
  input.setAttribute('spellcheck',   'false');

  input.addEventListener('blur', () => {
    updateSMAFromPeriod();
    // Re-display cleanly
    const T = _periodSeconds;
    if (T != null && isFinite(T) && T > 0) {
      const unit = unitSel?.value || 'h';
      input.value = _fmtTime(T, unit);
    }
  });

  input.addEventListener('input', () => {
    const raw    = input.value.trim();
    const parsed = _parseUnitString(raw);
    if (!parsed) return;
    let periodS;
    if (parsed.unit) {
      const resolved = _resolveTimeUnit(parsed.unit);
      periodS = parsed.value * (resolved ? TIME_TO_S[resolved] : (TIME_TO_S[unitSel?.value] ?? 1));
    } else {
      periodS = parsed.value * (TIME_TO_S[unitSel?.value] ?? 1);
    }
    _periodSeconds = periodS;
    _updatePeriodHint(periodS, unitSelId, hintId);
    // Live back-calculate SMA while typing
    const newSMA = _smaFromPeriod(periodS);
    if (newSMA != null && isFinite(newSMA) && newSMA > 0) {
      if (typeof _distMetres !== 'undefined') _distMetres['or-sma'] = newSMA;
      const smaInput   = document.getElementById('or-sma');
      const smaUnitSel = document.getElementById('or-sma-unit');
      if (smaInput) {
        smaInput.value = _metresToDisplay(newSMA, smaUnitSel?.value || 'AU');
        if (typeof _updateHint === 'function') _updateHint(newSMA, 'or-sma-unit', 'or-sma-hint', 'sma');
      }
      if (typeof liveSync === 'function') liveSync();
    }
  });

  if (unitSel) {
    unitSel.addEventListener('change', () => {
      unitSel.dataset.userPicked = '1';
      const T = _periodSeconds;
      if (T != null && isFinite(T) && T > 0) {
        input.value = _fmtTime(T, unitSel.value);
        _updatePeriodHint(T, unitSelId, hintId);
      }
    });
  }
}
