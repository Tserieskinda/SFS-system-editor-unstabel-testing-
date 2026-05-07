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
let _calcTab = 'circ';

function openCalculator() {
  // Close utils dropdown
  _utilsDropOpen = false;
  document.getElementById('utils-dropdown').style.display = 'none';

  // Populate body selector from current system
  _calcPopulateBodies();

  const overlay = document.getElementById('calc-modal-overlay');
  overlay.style.display = 'flex';

  calcSetTab(_calcTab);
  calcUpdate();
}

function closeCalculator() {
  document.getElementById('calc-modal-overlay').style.display = 'none';
}

// Close on overlay background click (deferred so DOM is ready)
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
  // Sort: center first, then alphabetical
  names.sort((a, b) => {
    const ac = bodies[a]?.isCenter ? -1 : 1;
    const bc = bodies[b]?.isCenter ? -1 : 1;
    if (ac !== bc) return ac - bc;
    return a.localeCompare(b);
  });
  sel.innerHTML = names.map(n =>
    `<option value="${n}">${n}${bodies[n]?.isCenter ? ' ★' : ''}</option>`
  ).join('');
  // Auto-select selectedBody if open
  if (typeof selectedBody !== 'undefined' && selectedBody && bodies[selectedBody]) {
    sel.value = selectedBody;
  }
  calcBodyChanged();
}

function calcBodyChanged() {
  calcUpdate();
}

// Returns { radius_m, cloudStartHeight_m, name } for selected body, or null
function _calcGetBodyData() {
  const sel  = document.getElementById('calc-body-sel');
  const name = sel?.value;
  if (!name || typeof bodies === 'undefined' || !bodies[name]) return null;
  const d = bodies[name].data || {};
  const radius_m           = d.BASE_DATA?.radius || 0;
  const cloudStartHeight_m = d.ATMOSPHERE_VISUALS_DATA?.CLOUDS?.startHeight || 0;
  return { name, radius_m, cloudStartHeight_m };
}

function calcSetTab(tab) {
  _calcTab = tab;
  ['circ', 'cloud', 'hm'].forEach(t => {
    const panel = document.getElementById('calc-panel-' + t);
    const btn   = document.getElementById('calc-tab-'   + t);
    if (panel) panel.style.display = t === tab ? 'block' : 'none';
    if (btn) {
      btn.classList.toggle('calc-tab-active', t === tab);
    }
  });
  calcUpdate();
}

// Format metres — always outputs raw metres only
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

  // Body info strip
  if (info) {
    info.style.display = '';
    infoR.textContent  = `r = ${_fmtMetres(radius_m)}`;
    infoC.textContent  = cloudStartHeight_m > 0
      ? `cloudStartHeight = ${_fmtMetres(cloudStartHeight_m)}`
      : 'No cloud layer defined';
  }

  // ── Circumference ──────────────────────────────────────
  const circ = 2 * Math.PI * radius_m;
  document.getElementById('calc-res-circ').textContent = _fmtMetres(circ);

  // ── Cloud width ────────────────────────────────────────
  const cloudN = Math.max(1, parseInt(document.getElementById('calc-cloud-n')?.value) || 8);
  const cloudNote = document.getElementById('calc-cloud-sh-note');
  if (cloudStartHeight_m > 0) {
    const cloudCirc  = 2 * Math.PI * (radius_m + cloudStartHeight_m);
    const cloudWidth = cloudCirc / cloudN;
    document.getElementById('calc-res-cloud').textContent = _fmtMetres(cloudWidth);
    if (cloudNote) cloudNote.textContent = `cloudStartHeight = ${_fmtMetres(cloudStartHeight_m)}`;
  } else {
    // Fallback: use surface circumference with a note
    const cloudWidth = circ / cloudN;
    document.getElementById('calc-res-cloud').textContent = _fmtMetres(cloudWidth) + '  (no cloud layer — using surface r)';
    if (cloudNote) cloudNote.textContent = 'No CLOUDS.startHeight found for this body';
  }

  // ── Heightmap width ────────────────────────────────────
  const hmN    = Math.max(1, parseInt(document.getElementById('calc-hm-n')?.value) || 1024);
  const hmWidth = circ / hmN;
  document.getElementById('calc-res-hm').textContent = _fmtMetres(hmWidth);
}
