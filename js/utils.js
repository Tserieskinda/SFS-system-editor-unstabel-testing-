// ════════════════════════════════════════════════════════════
//  utils.js  —  UTILS topbar dropdown + Calculator modal
// ════════════════════════════════════════════════════════════

// ── Dropdown ─────────────────────────────────────────────────
let _utilsDropOpen = false;

function toggleUtilsDropdown() {
  _utilsDropOpen = !_utilsDropOpen;
  const dd = document.getElementById('utils-dropdown');
  if (_utilsDropOpen) {
    const btn = document.getElementById('btn-utils');
    const r = btn.getBoundingClientRect();
    dd.style.top   = (r.bottom + 6) + 'px';
    dd.style.right = (window.innerWidth - r.right) + 'px';
    dd.style.left  = 'auto';
  }
  dd.style.display = _utilsDropOpen ? 'block' : 'none';
}

// Close when clicking outside
document.addEventListener('mousedown', e => {
  try {
    const wrap = document.getElementById('utils-dropdown-wrap');
    const dd   = document.getElementById('utils-dropdown');
    if (wrap && !wrap.contains(e.target) && dd && !dd.contains(e.target)) {
      _utilsDropOpen = false;
      dd.style.display = 'none';
    }
  } catch(_){}
}, true);


// ── Calculator modal ─────────────────────────────────────────
// Track which tool panels and sci panel are open
let _calcOpenTool = null;   // 'circ' | 'cloud' | 'hm' | null
let _calcSciOpen  = false;

function openCalculator() {
  _utilsDropOpen = false;
  document.getElementById('utils-dropdown').style.display = 'none';

  _calcPopulateBodies();

  const overlay = document.getElementById('calc-modal-overlay');
  overlay.style.display = 'flex';

  // Open first tool by default if none open
  if (!_calcOpenTool) calcToggleTool('circ', true);
  calcUpdate();
}

function closeCalculator() {
  document.getElementById('calc-modal-overlay').style.display = 'none';
}

// Close on overlay background click
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('calc-modal-overlay')?.addEventListener('click', e => {
    if (e.target === document.getElementById('calc-modal-overlay')) closeCalculator();
  });
});

// Close on ESC
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    const overlay = document.getElementById('calc-modal-overlay');
    if (overlay && overlay.style.display !== 'none') closeCalculator();
  }
});

function _calcPopulateBodies() {
  const sel = document.getElementById('calc-body-sel');
  if (!sel) return;
  const names = Object.keys(typeof bodies !== 'undefined' ? bodies : {});
  if (!names.length) {
    sel.innerHTML = '<option value="">— no bodies loaded —</option>';
    return;
  }
  names.sort((a, b) => {
    const ac = bodies[a]?.isCenter ? -1 : 1;
    const bc = bodies[b]?.isCenter ? -1 : 1;
    if (ac !== bc) return ac - bc;
    return a.localeCompare(b);
  });
  sel.innerHTML = names.map(n =>
    `<option value="${n}">${n}${bodies[n]?.isCenter ? ' ★' : ''}</option>`
  ).join('');
  if (typeof selectedBody !== 'undefined' && selectedBody && bodies[selectedBody]) {
    sel.value = selectedBody;
  }
  calcBodyChanged();
}

function calcBodyChanged() {
  calcUpdate();
}

function _calcGetBodyData() {
  const sel  = document.getElementById('calc-body-sel');
  const name = sel?.value;
  if (!name || typeof bodies === 'undefined' || !bodies[name]) return null;
  const d = bodies[name].data || {};
  const radius_m           = d.BASE_DATA?.radius || 0;
  const cloudStartHeight_m = d.ATMOSPHERE_VISUALS_DATA?.CLOUDS?.startHeight || 0;
  return { name, radius_m, cloudStartHeight_m };
}

// ── New: toggle tool panel (accordion-style) ──────────────────
function calcToggleTool(tool, forceOpen) {
  const isOpen = _calcOpenTool === tool;
  const shouldOpen = forceOpen !== undefined ? forceOpen : !isOpen;

  // Close all panels first
  ['circ', 'cloud', 'hm'].forEach(t => {
    const panel = document.getElementById('calc-panel-' + t);
    const arrow = document.getElementById('calc-arrow-' + t);
    const item  = document.getElementById('calc-tool-' + t);
    if (panel) panel.style.display = 'none';
    if (arrow) arrow.style.transform = '';
    if (item)  item.classList.remove('calc-tool-open');
  });

  if (shouldOpen) {
    _calcOpenTool = tool;
    const panel = document.getElementById('calc-panel-' + tool);
    const arrow = document.getElementById('calc-arrow-' + tool);
    const item  = document.getElementById('calc-tool-' + tool);
    if (panel) panel.style.display = 'block';
    if (arrow) arrow.style.transform = 'rotate(90deg)';
    if (item)  item.classList.add('calc-tool-open');
    calcUpdate();
  } else {
    _calcOpenTool = null;
  }
}

// ── Legacy tab API shim (keep compat if anything still calls it) ─
function calcSetTab(tab) {
  calcToggleTool(tab, true);
}

// ── Scientific calculator toggle ──────────────────────────────
function calcToggleSci() {
  _calcSciOpen = !_calcSciOpen;
  const panel   = document.getElementById('calc-sci-panel');
  const chevron = document.getElementById('calc-sci-chevron');
  if (panel)   panel.style.display = _calcSciOpen ? 'block' : 'none';
  if (chevron) chevron.style.transform = _calcSciOpen ? 'rotate(90deg)' : '';
}

// ── Scientific calculator logic ───────────────────────────────
let _sciExpr    = '';
let _sciResult  = null;
let _sciNewNum  = false;  // after = was pressed, fresh input clears

function _sciRender() {
  const disp = document.getElementById('calc-sci-display');
  const expr = document.getElementById('calc-sci-expr');
  if (disp) disp.textContent = _sciExpr || '0';
  if (expr) expr.textContent = '';
}

function sciInsert(ch) {
  if (_sciNewNum && /[\d.]/.test(ch)) { _sciExpr = ''; }
  _sciNewNum = false;
  _sciExpr += ch;
  _sciRender();
}

function sciConst(c) {
  const val = c === 'Math.PI' ? Math.PI : Math.E;
  if (_sciNewNum) { _sciExpr = ''; }
  _sciNewNum = false;
  _sciExpr += val.toString();
  _sciRender();
}

function sciDel() {
  _sciNewNum = false;
  _sciExpr = _sciExpr.slice(0, -1);
  _sciRender();
}

function sciClear() {
  _sciExpr = '';
  _sciResult = null;
  _sciNewNum = false;
  const disp = document.getElementById('calc-sci-display');
  const expr = document.getElementById('calc-sci-expr');
  if (disp) disp.textContent = '0';
  if (expr) expr.textContent = '';
}

function sciFunc(fn) {
  // If there's already an expression, wrap it; otherwise start fresh
  const src = _sciExpr || '0';
  const num = parseFloat(src);

  const wrapFns = {
    sin:   () => `sin(${src})`,
    cos:   () => `cos(${src})`,
    tan:   () => `tan(${src})`,
    log:   () => `log(${src})`,
    ln:    () => `ln(${src})`,
    sqrt:  () => `√(${src})`,
    abs:   () => `|${src}|`,
    floor: () => `⌊${src}⌋`,
    pow2:  () => `(${src})²`,
    pow3:  () => `(${src})³`,
    inv:   () => `1/(${src})`,
  };

  const exprLabel = document.getElementById('calc-sci-expr');
  if (exprLabel) exprLabel.textContent = wrapFns[fn] ? wrapFns[fn]() : src;

  let result;
  try {
    switch(fn) {
      case 'sin':   result = Math.sin(num); break;
      case 'cos':   result = Math.cos(num); break;
      case 'tan':   result = Math.tan(num); break;
      case 'log':   result = Math.log10(num); break;
      case 'ln':    result = Math.log(num); break;
      case 'sqrt':  result = Math.sqrt(num); break;
      case 'abs':   result = Math.abs(num); break;
      case 'floor': result = Math.floor(num); break;
      case 'pow2':  result = Math.pow(num, 2); break;
      case 'pow3':  result = Math.pow(num, 3); break;
      case 'inv':   result = 1 / num; break;
      default:      result = NaN;
    }
    _sciExpr   = isFinite(result) ? _sciPretty(result) : 'Error';
    _sciResult = result;
    _sciNewNum = true;
  } catch(err) {
    _sciExpr = 'Error';
  }
  const disp = document.getElementById('calc-sci-display');
  if (disp) disp.textContent = _sciExpr;
}

function sciEval() {
  try {
    // Replace display operators and power operator before eval
    let expr = _sciExpr
      .replace(/×/g, '*')
      .replace(/÷/g, '/')
      .replace(/−/g, '-')
      .replace(/\^/g, '**');

    const exprLabel = document.getElementById('calc-sci-expr');
    if (exprLabel) exprLabel.textContent = _sciExpr + ' =';

    // Safe eval via Function constructor
    // eslint-disable-next-line no-new-func
    const result = Function('"use strict"; return (' + expr + ')')();
    _sciResult = result;
    _sciExpr   = isFinite(result) ? _sciPretty(result) : 'Error';
    _sciNewNum = true;
  } catch(e) {
    _sciExpr = 'Error';
    _sciNewNum = true;
  }
  const disp = document.getElementById('calc-sci-display');
  if (disp) disp.textContent = _sciExpr;
}

function _sciPretty(n) {
  if (!isFinite(n)) return 'Error';
  // Show up to 10 sig figs, strip trailing zeros
  const s = parseFloat(n.toPrecision(10)).toString();
  return s;
}

// Format metres
function _fmtMetres(m) {
  if (!isFinite(m) || m <= 0) return '—';
  return `${parseFloat(m.toFixed(7))} m`;
}

function calcUpdate() {
  const bd = _calcGetBodyData();
  const info   = document.getElementById('calc-body-info');
  const infoR  = document.getElementById('calc-info-r');
  const infoC  = document.getElementById('calc-info-cloud');

  if (!bd || bd.radius_m <= 0) {
    if (info) info.style.display = 'none';
    document.getElementById('calc-res-circ').textContent  = '—';
    document.getElementById('calc-res-cloud').textContent = '—';
    document.getElementById('calc-res-hm').textContent    = '—';
    return;
  }

  const { radius_m, cloudStartHeight_m } = bd;

  if (info) {
    info.style.display = '';
    infoR.textContent  = `r = ${_fmtMetres(radius_m)}`;
    infoC.textContent  = cloudStartHeight_m > 0
      ? `cloudStartHeight = ${_fmtMetres(cloudStartHeight_m)}`
      : 'No cloud layer defined';
  }

  // Circumference
  const circ = 2 * Math.PI * radius_m;
  document.getElementById('calc-res-circ').textContent = _fmtMetres(circ);

  // Cloud width
  const cloudN = Math.max(1, parseInt(document.getElementById('calc-cloud-n')?.value) || 8);
  const cloudNote = document.getElementById('calc-cloud-sh-note');
  if (cloudStartHeight_m > 0) {
    const cloudCirc  = 2 * Math.PI * (radius_m + cloudStartHeight_m);
    const cloudWidth = cloudCirc / cloudN;
    document.getElementById('calc-res-cloud').textContent = _fmtMetres(cloudWidth);
    if (cloudNote) cloudNote.textContent = `cloudStartHeight = ${_fmtMetres(cloudStartHeight_m)}`;
  } else {
    const cloudWidth = circ / cloudN;
    document.getElementById('calc-res-cloud').textContent = _fmtMetres(cloudWidth) + '  (no cloud layer — using surface r)';
    if (cloudNote) cloudNote.textContent = 'No CLOUDS.startHeight found for this body';
  }

  // Heightmap width
  const hmN    = Math.max(1, parseInt(document.getElementById('calc-hm-n')?.value) || 1024);
  const hmWidth = circ / hmN;
  document.getElementById('calc-res-hm').textContent = _fmtMetres(hmWidth);
}
