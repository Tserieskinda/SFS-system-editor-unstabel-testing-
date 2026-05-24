// ════════════════════════════════════════════════════════════
//  procgen.js  —  Procedural System Generation
// ════════════════════════════════════════════════════════════

// ── State ─────────────────────────────────────────────────────
const PG = {
  // Body type toggles
  types: {
    star:        { label:'Stars',        icon:'⭐', enabled:true,  weight:20, color:'#ffd060' },
    planet:      { label:'Planets',      icon:'🌍', enabled:true,  weight:50, color:'#4488ff' },
    moon:        { label:'Moons',        icon:'🌙', enabled:true,  weight:20, color:'#aaaaaa' },
    asteroid:    { label:'Asteroids',    icon:'☄️', enabled:false, weight:5,  color:'#886644' },
    brown_dwarf: { label:'Brown Dwarfs', icon:'🟤', enabled:false, weight:3,  color:'#cc6622' },
    blackhole:   { label:'Black Holes',  icon:'⚫', enabled:false, weight:2,  color:'#8800ff' },
  },

  // Fine tuning ranges
  tune: {
    bodyCount:    { min:2,   max:12,   val:6,    label:'Body Count' },
    orbitMin:     { min:0.1, max:5,    val:0.3,  label:'Min Orbit (AU)', step:0.1 },
    orbitMax:     { min:1,   max:50,   val:15,   label:'Max Orbit (AU)', step:0.5 },
    radiusScale:  { min:0.1, max:3,    val:1.0,  label:'Radius Scale',   step:0.1 },
    eccentricity: { min:0,   max:0.9,  val:0.15, label:'Max Eccentricity', step:0.05 },
    soiScale:     { min:0.5, max:5,    val:1.0,  label:'SOI Scale',      step:0.1 },
  },

  // Misc options
  misc: {
    autoCenter:       true,
    autoHome:         true,
    randomHeightmaps: false,
    addRings:         true,
    addAtmospheres:   true,
    addMoons:         true,
  },

  // Generated system preview data
  preview: {
    bodies: [],
    center: null,
  },

  // Canvas state
  canvas: {
    pan:   { x:0, y:0 },
    zoom:  1,
    drag:  false,
    lastP: null,
    hovered: null,
    selected: null,
  },
};

const AU = 1.496e11;  // metres per AU

// ── Open / Close ──────────────────────────────────────────────
function openProceduralGen() {
  _utilsDropOpen = false;
  document.getElementById('utils-dropdown').style.display = 'none';
  const modal = document.getElementById('procgen-modal');
  modal.style.display = 'flex';
  pgBuildUI();
  pgInitCanvas();
}

function closeProceduralGen() {
  document.getElementById('procgen-modal').style.display = 'none';
}

// Close on backdrop
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('procgen-modal')?.addEventListener('click', e => {
    if (e.target === document.getElementById('procgen-modal')) closeProceduralGen();
  });
});

// ── Build dynamic UI ──────────────────────────────────────────
function pgBuildUI() {
  pgRenderBodyTypeGrid();
  pgRenderFrequencyControls();
  pgRenderFineTuning();
  pgRenderMiscOptions();
}

function pgRenderBodyTypeGrid() {
  const grid = document.getElementById('pg-body-type-grid');
  if (!grid) return;
  grid.innerHTML = Object.entries(PG.types).map(([key, t]) => `
    <label class="pg-body-btn ${t.enabled ? 'pg-body-btn--on' : ''}" data-type="${key}"
      onclick="pgToggleType('${key}',this)">
      <span class="pg-body-icon">${t.icon}</span>
      <span class="pg-body-label">${t.label}</span>
      <span class="pg-body-check">${t.enabled ? '✓' : ''}</span>
    </label>
  `).join('');
}

function pgToggleType(key, el) {
  PG.types[key].enabled = !PG.types[key].enabled;
  el.classList.toggle('pg-body-btn--on', PG.types[key].enabled);
  el.querySelector('.pg-body-check').textContent = PG.types[key].enabled ? '✓' : '';
  pgRenderFrequencyControls();
  pgDrawCanvas();
}

function pgRenderFrequencyControls() {
  const container = document.getElementById('pg-freq-controls');
  if (!container) return;
  const enabled = Object.entries(PG.types).filter(([,t]) => t.enabled);
  if (!enabled.length) {
    container.innerHTML = '<div style="font-size:.52rem;color:rgba(150,160,200,.5)">Enable at least one body type above.</div>';
    return;
  }
  // Normalize weights to 100%
  const totalW = enabled.reduce((s,[,t]) => s + t.weight, 0);

  container.innerHTML = enabled.map(([key, t]) => {
    const pct = Math.round((t.weight / totalW) * 100);
    return `
      <div class="pg-freq-row" data-type="${key}">
        <span class="pg-freq-icon">${t.icon}</span>
        <span class="pg-freq-name">${t.label}</span>
        <input type="range" class="pg-freq-slider" min="1" max="100" value="${t.weight}"
          oninput="pgSetWeight('${key}',this.value)"
          style="accent-color:${t.color}">
        <span class="pg-freq-pct" id="pg-pct-${key}">${pct}%</span>
      </div>
    `;
  }).join('');
}

function pgSetWeight(key, val) {
  PG.types[key].weight = parseInt(val);
  // Recalculate all percentages
  const enabled = Object.entries(PG.types).filter(([,t]) => t.enabled);
  const totalW = enabled.reduce((s,[,t]) => s + t.weight, 0);
  enabled.forEach(([k, t]) => {
    const el = document.getElementById(`pg-pct-${k}`);
    if (el) el.textContent = Math.round((t.weight / totalW) * 100) + '%';
  });
}

function pgRenderFineTuning() {
  const container = document.getElementById('pg-fine-tuning');
  if (!container) return;
  container.innerHTML = Object.entries(PG.tune).map(([key, t]) => `
    <div class="pg-tune-row">
      <div class="pg-tune-label">${t.label}</div>
      <div class="pg-tune-controls">
        <input type="range" class="pg-tune-slider" min="${t.min}" max="${t.max}"
          step="${t.step || 1}" value="${t.val}"
          oninput="pgSetTune('${key}',this.value)"
          style="flex:1">
        <span class="pg-tune-val" id="pg-tune-val-${key}">${t.val}</span>
      </div>
    </div>
  `).join('');
}

function pgSetTune(key, val) {
  PG.tune[key].val = parseFloat(val);
  const el = document.getElementById(`pg-tune-val-${key}`);
  if (el) el.textContent = parseFloat(val).toFixed(
    val % 1 === 0 ? 0 : 2
  );
}

function pgRenderMiscOptions() {
  const container = document.getElementById('pg-misc-options');
  if (!container) return;
  const opts = [
    { key:'autoCenter',       label:'Select center after generation' },
    { key:'autoHome',         label:'Select home planet after generation' },
    { key:'randomHeightmaps', label:'Generate random asteroid heightmaps' },
    { key:'addRings',         label:'Allow ring systems on gas giants' },
    { key:'addAtmospheres',   label:'Allow atmosphere generation' },
    { key:'addMoons',         label:'Allow moon generation' },
  ];
  container.innerHTML = opts.map(o => `
    <label class="pg-misc-row">
      <input type="checkbox" ${PG.misc[o.key] ? 'checked' : ''}
        onchange="PG.misc['${o.key}']=this.checked"
        style="accent-color:#64dcb4">
      <span>${o.label}</span>
    </label>
  `).join('');
}

// ── Core Generation ───────────────────────────────────────────
function pgGenerate() {
  const enabled = Object.entries(PG.types).filter(([,t]) => t.enabled);
  if (!enabled.length) {
    pgShowStatus('⚠ Enable at least one body type.', 'warn'); return;
  }

  const count   = PG.tune.bodyCount.val;
  const totalW  = enabled.reduce((s,[,t]) => s + t.weight, 0);

  PG.preview.bodies = [];
  PG.preview.center = null;

  // Pick a center body — always a star if enabled, else first enabled type
  const starEnabled = PG.types.star.enabled;
  const centerType  = starEnabled ? 'star' : enabled[0][0];
  const centerPreset = pgPickPreset(centerType);
  if (!centerPreset) { pgShowStatus('⚠ No presets available. Load a preset pack first.', 'warn'); return; }

  const centerName = NameGen.generate();
  const center = {
    name:     centerName,
    type:     centerType,
    preset:   centerPreset,
    isCenter: true,
    orbitSMA: 0,
    radius:   centerPreset.data.BASE_DATA?.radius || 34817000,
    color:    PG.types[centerType]?.color || '#ffd060',
    icon:     PG.types[centerType]?.icon  || '⭐',
    children: [],
  };
  PG.preview.center = center;
  PG.preview.bodies.push(center);

  // Generate orbiting bodies
  const orbitMin = PG.tune.orbitMin.val * AU;
  const orbitMax = PG.tune.orbitMax.val * AU;
  const bodyBudget = count - 1; // subtract center
  let lastSMA = orbitMin;

  for (let i = 0; i < bodyBudget; i++) {
    // Weighted random pick of type (not star, stars only as center)
    const orbitEnabled = enabled.filter(([k]) => k !== 'star' || !starEnabled);
    const pick = orbitEnabled.length > 0 ? orbitEnabled : enabled;
    const type = pgWeightedPick(pick.map(([k]) => [k, PG.types[k].weight]));
    const preset = pgPickPreset(type);
    if (!preset) continue;

    // Space out orbits
    const spacing = (orbitMax - orbitMin) / Math.max(bodyBudget, 1);
    const jitter  = spacing * 0.4 * (Math.random() - 0.5);
    const sma     = Math.min(orbitMax, Math.max(orbitMin, lastSMA + spacing + jitter));
    lastSMA = sma;

    const ecc = Math.random() * PG.tune.eccentricity.val;
    const dir = Math.random() > 0.1 ? 1 : -1; // 90% prograde

    const name = NameGen.generate();
    const radius = (preset.data.BASE_DATA?.radius || 600000) * PG.tune.radiusScale.val;
    const body = {
      name,
      type,
      preset,
      isCenter:  false,
      parent:    centerName,
      orbitSMA:  sma,
      orbitEcc:  ecc,
      orbitDir:  dir,
      radius,
      color:     PG.types[type]?.color || '#aaaaaa',
      icon:      PG.types[type]?.icon  || '🌍',
      children:  [],
    };

    // Maybe add moons to planets
    if (PG.misc.addMoons && (type === 'planet' || type === 'gasgiant') && Math.random() > 0.5) {
      const moonCount = Math.floor(Math.random() * 3) + 1;
      const moonPresets = pgPickPreset('moon');
      if (moonPresets) {
        for (let m = 0; m < moonCount; m++) {
          const moonSMA = radius * (8 + m * 6 + Math.random() * 4);
          body.children.push({
            name:     NameGen.generate(),
            type:     'moon',
            parent:   name,
            orbitSMA: moonSMA,
            orbitEcc: Math.random() * 0.05,
            orbitDir: 1,
            radius:   (moonPresets.data?.BASE_DATA?.radius || 300000) * 0.3,
            color:    '#999999',
            icon:     '🌙',
            children: [],
          });
        }
      }
    }

    PG.preview.bodies.push(body);
    center.children.push(body);
  }

  pgDrawCanvas();
  pgShowStatus(`✓ Generated ${PG.preview.bodies.length} bodies. Click "Apply to System" to add them.`, 'ok');
}

// ── Preset picking ────────────────────────────────────────────
function pgPickPreset(type) {
  if (typeof buildAllPresets !== 'function') return null;
  const all = buildAllPresets();
  if (!all.length) return null;

  // Filter presets matching the requested type
  const typeMap = {
    star:        ['star'],
    planet:      ['planet','mercurylike','marslike'],
    moon:        ['moon'],
    asteroid:    ['asteroid'],
    gasgiant:    ['gasgiant','ringedgiant'],
    brown_dwarf: ['star'],   // use star presets for brown dwarfs
    blackhole:   ['blackhole'],
  };
  const ids = typeMap[type] || ['planet'];
  const matches = all.filter(p => ids.includes(p.id));
  if (!matches.length) return all[Math.floor(Math.random() * all.length)];
  return matches[Math.floor(Math.random() * matches.length)];
}

function pgWeightedPick(pairs) {
  // pairs: [[key, weight], ...]
  const total = pairs.reduce((s,[,w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [k, w] of pairs) { r -= w; if (r <= 0) return k; }
  return pairs[pairs.length - 1][0];
}

// ── Apply to system ───────────────────────────────────────────
function pgApply() {
  if (!PG.preview.center) { pgShowStatus('⚠ Generate a system first.', 'warn'); return; }

  // Warn if system already has bodies
  const existingBodies = Object.keys(typeof bodies !== 'undefined' ? bodies : {});
  if (existingBodies.length > 0) {
    if (!confirm(`This will ADD ${PG.preview.bodies.length} bodies to your existing system. Continue?`)) return;
  }

  if (typeof pushUndo === 'function') pushUndo();

  const center = PG.preview.center;

  // Add center body
  const hasCenterAlready = existingBodies.some(n => bodies[n]?.isCenter);
  if (!hasCenterAlready) {
    const cd = JSON.parse(JSON.stringify(center.preset.data));
    delete cd.ORBIT_DATA;
    const _meta = typeof inferPresetMeta === 'function' ? inferPresetMeta(center.name, cd) : {};
    bodies[center.name] = {
      data: cd,
      preset: _meta.id || 'star',
      isCenter: true,
      color: _meta.color || center.color,
      glow:  _meta.glow  || center.color,
      icon:  _meta.icon  || center.icon,
    };
    document.getElementById('empty-state')?.classList.add('gone');
  }

  // Add orbiting bodies
  for (const body of PG.preview.bodies) {
    if (body.isCenter) continue;
    _pgAddBody(body, center.name);

    // Add moons
    for (const moon of body.children) {
      _pgAddBody(moon, body.name);
    }
  }

  if (typeof drawViewport   === 'function') drawViewport();
  if (typeof updateStatusBar=== 'function') updateStatusBar();

  // Auto-select center
  if (PG.misc.autoCenter && typeof selectBody === 'function') {
    selectBody(center.name);
  }

  pgShowStatus(`✓ ${PG.preview.bodies.length} bodies added to system!`, 'ok');
  setTimeout(closeProceduralGen, 1200);
}

function _pgAddBody(body, parentName) {
  let name = body.name;
  // Ensure unique name
  let suffix = 2;
  while (bodies[name]) { name = body.name + '_' + (suffix++); }

  const bd = JSON.parse(JSON.stringify(body.preset?.data || {}));
  if (bd.BASE_DATA) {
    bd.BASE_DATA.radius = body.radius;
    bd.BASE_DATA.gravity = bd.BASE_DATA.gravity || 9.8;
  }
  bd.ORBIT_DATA = {
    parent:        parentName,
    semiMajorAxis: body.orbitSMA,
    SMA:           body.orbitSMA,
    E:             body.orbitEcc || 0,
    direction:     body.orbitDir || 1,
  };

  // Apply rings/atmosphere options
  if (!PG.misc.addRings)       delete bd.RINGS_DATA;
  if (!PG.misc.addAtmospheres) { delete bd.ATMOSPHERE_PHYSICS_DATA; delete bd.ATMOSPHERE_VISUALS_DATA; }

  const _meta = typeof inferPresetMeta === 'function' ? inferPresetMeta(name, bd) : {};
  bodies[name] = {
    data:   bd,
    preset: _meta.id || body.type,
    isCenter: false,
    color: _meta.color || body.color,
    glow:  _meta.glow  || body.color,
    icon:  _meta.icon  || body.icon,
  };
}

function pgClear() {
  PG.preview.bodies = [];
  PG.preview.center = null;
  PG.canvas.selected = null;
  PG.canvas.hovered  = null;
  pgDrawCanvas();
  pgShowStatus('', '');
}

function pgShowStatus(msg, type) {
  const el = document.getElementById('pg-status');
  if (!el) return;
  el.textContent  = msg;
  el.style.color  = type === 'ok'   ? 'rgba(100,220,180,.9)'
                  : type === 'warn' ? 'rgba(255,180,80,.9)'
                  :                   'rgba(150,160,200,.5)';
  el.style.display = msg ? 'block' : 'none';
}

// ── Canvas Map View ───────────────────────────────────────────
let _pgCanvasInitDone = false;

function pgInitCanvas() {
  const cv = document.getElementById('pg-canvas');
  if (!cv || _pgCanvasInitDone) { pgDrawCanvas(); return; }
  _pgCanvasInitDone = true;

  const state = PG.canvas;

  // Mouse
  cv.addEventListener('mousedown', e => {
    state.drag = true;
    state.lastP = { x:e.clientX, y:e.clientY };
    e.preventDefault();
  });
  window.addEventListener('mousemove', e => {
    if (!state.drag) {
      // Hover detection
      _pgHitTest(cv, e.clientX, e.clientY);
      return;
    }
    state.pan.x += e.clientX - state.lastP.x;
    state.pan.y += e.clientY - state.lastP.y;
    state.lastP = { x:e.clientX, y:e.clientY };
    pgDrawCanvas();
  });
  window.addEventListener('mouseup', e => {
    if (state.drag) {
      state.drag = false;
      _pgHitTestClick(cv, e.clientX, e.clientY);
    }
  });

  // Touch
  let _lastTouch = null;
  let _pinchDist = null;
  cv.addEventListener('touchstart', e => {
    e.preventDefault();
    if (e.touches.length === 1) {
      state.drag = true;
      state.lastP = { x:e.touches[0].clientX, y:e.touches[0].clientY };
      _lastTouch = state.lastP;
      _pinchDist = null;
    } else if (e.touches.length === 2) {
      state.drag = false;
      _pinchDist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
    }
  }, { passive:false });
  cv.addEventListener('touchmove', e => {
    e.preventDefault();
    if (e.touches.length === 2 && _pinchDist) {
      const d = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      const factor = d / _pinchDist;
      state.zoom = Math.max(0.05, Math.min(8, state.zoom * factor));
      _pinchDist = d;
      pgDrawCanvas();
    } else if (e.touches.length === 1 && state.drag) {
      state.pan.x += e.touches[0].clientX - state.lastP.x;
      state.pan.y += e.touches[0].clientY - state.lastP.y;
      state.lastP = { x:e.touches[0].clientX, y:e.touches[0].clientY };
      pgDrawCanvas();
    }
  }, { passive:false });
  cv.addEventListener('touchend', e => {
    if (e.touches.length === 0) { state.drag = false; _pinchDist = null; }
  });

  // Scroll zoom
  cv.addEventListener('wheel', e => {
    e.preventDefault();
    const rect  = cv.getBoundingClientRect();
    const mx    = e.clientX - rect.left - cv.width/2  - state.pan.x;
    const my    = e.clientY - rect.top  - cv.height/2 - state.pan.y;
    const factor = e.deltaY < 0 ? 1.12 : 0.89;
    const newZ   = Math.max(0.05, Math.min(8, state.zoom * factor));
    state.pan.x -= mx * (newZ - state.zoom);
    state.pan.y -= my * (newZ - state.zoom);
    state.zoom   = newZ;
    pgDrawCanvas();
  }, { passive:false });

  pgDrawCanvas();
}

function pgResizeCanvas() {
  const cv = document.getElementById('pg-canvas');
  if (!cv) return;
  const wrap = cv.parentElement;
  if (!wrap) return;
  const dpr = window.devicePixelRatio || 1;
  const w = wrap.clientWidth, h = wrap.clientHeight;
  if (cv.width !== Math.round(w*dpr) || cv.height !== Math.round(h*dpr)) {
    cv.width  = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    cv.style.width  = w + 'px';
    cv.style.height = h + 'px';
  }
}

// ── Canvas rendering ──────────────────────────────────────────
function pgDrawCanvas() {
  const cv = document.getElementById('pg-canvas');
  if (!cv) return;
  pgResizeCanvas();

  const ctx   = cv.getContext('2d');
  const dpr   = window.devicePixelRatio || 1;
  const W     = cv.width, H = cv.height;
  const state = PG.canvas;

  ctx.clearRect(0, 0, W, H);

  // Background
  ctx.fillStyle = '#020408';
  ctx.fillRect(0, 0, W, H);

  // Starfield
  pgDrawStarfield(ctx, W, H);

  // Grid
  pgDrawGrid(ctx, W, H, state);

  if (!PG.preview.center) {
    // Empty state
    ctx.save();
    ctx.globalAlpha = 0.3;
    ctx.font = `bold ${Math.round(14*dpr)}px 'JetBrains Mono', monospace`;
    ctx.fillStyle = '#4466aa';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Generate a system to see the map', W/2, H/2);
    ctx.restore();
    return;
  }

  // Transform: center + pan + zoom
  ctx.save();
  ctx.translate(W/2 + state.pan.x * dpr, H/2 + state.pan.y * dpr);
  ctx.scale(state.zoom * dpr, state.zoom * dpr);

  // Draw orbit rings for orbiting bodies
  for (const body of PG.preview.bodies) {
    if (body.isCenter) continue;
    pgDrawOrbit(ctx, body);
  }

  // Draw moon orbits
  for (const body of PG.preview.bodies) {
    for (const moon of body.children) {
      pgDrawOrbit(ctx, moon, body);
    }
  }

  // Draw bodies
  for (const body of PG.preview.bodies) {
    pgDrawBody(ctx, body, null, state, dpr);
    // Draw moons
    for (const moon of body.children) {
      pgDrawBody(ctx, moon, body, state, dpr);
    }
  }

  ctx.restore();

  // Tooltip for hovered body
  if (state.hovered) {
    pgDrawTooltip(ctx, state.hovered, W, H, dpr);
  }

  // Legend
  pgDrawLegend(ctx, W, H, dpr);
}

function pgDrawStarfield(ctx, W, H) {
  // Simple deterministic starfield
  const seed = 12345;
  ctx.save();
  for (let i = 0; i < 120; i++) {
    const rx = ((seed * (i*7+1)) % W + W) % W;
    const ry = ((seed * (i*13+3)) % H + H) % H;
    const rs = 0.5 + (i % 3) * 0.4;
    const ra = 0.1 + (i % 5) * 0.12;
    ctx.globalAlpha = ra;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(rx % W, ry % H, rs, 0, Math.PI*2);
    ctx.fill();
  }
  ctx.restore();
}

function pgDrawGrid(ctx, W, H, state) {
  const dpr = window.devicePixelRatio || 1;
  const cx  = W/2 + state.pan.x * dpr;
  const cy  = H/2 + state.pan.y * dpr;
  const AU_px = 60 * state.zoom * dpr;

  ctx.save();
  ctx.strokeStyle = 'rgba(50,80,130,.18)';
  ctx.lineWidth   = 1;
  ctx.setLineDash([3, 6]);

  // AU rings
  for (let r = 1; r <= 20; r++) {
    const rpx = r * AU_px;
    if (rpx > W * 1.5) break;
    ctx.beginPath();
    ctx.arc(cx, cy, rpx, 0, Math.PI*2);
    ctx.stroke();

    // AU labels
    if (rpx > 20 && rpx < W * 0.8) {
      ctx.save();
      ctx.font = `${Math.round(9*dpr)}px 'JetBrains Mono', monospace`;
      ctx.fillStyle = 'rgba(60,100,160,.4)';
      ctx.textAlign = 'left';
      ctx.globalAlpha = 0.7;
      ctx.fillText(`${r}AU`, cx + rpx + 4*dpr, cy - 4*dpr);
      ctx.restore();
    }
  }
  ctx.setLineDash([]);
  ctx.restore();
}

function pgGetBodyScreenPos(body, parentBody) {
  const AU_px = 60;
  if (body.isCenter) return { x:0, y:0 };
  let angle = body._angle || 0;
  const r = (body.orbitSMA / AU) * AU_px;
  const px = parentBody ? ((parentBody.orbitSMA / AU) * AU_px * Math.cos(parentBody._angle || 0)) : 0;
  const py = parentBody ? ((parentBody.orbitSMA / AU) * AU_px * Math.sin(parentBody._angle || 0)) : 0;
  return {
    x: px + r * Math.cos(angle),
    y: py + r * Math.sin(angle),
  };
}

// Assign random angles on generation (stored per-body)
function pgAssignAngles() {
  for (const body of PG.preview.bodies) {
    if (!body._angle) body._angle = Math.random() * Math.PI * 2;
    for (const moon of body.children) {
      if (!moon._angle) moon._angle = Math.random() * Math.PI * 2;
    }
  }
}

function pgDrawOrbit(ctx, body, parentBody) {
  const AU_px = 60;
  const r = (body.orbitSMA / AU) * AU_px;
  let ox = 0, oy = 0;
  if (parentBody) {
    ox = (parentBody.orbitSMA / AU) * AU_px * Math.cos(parentBody._angle || 0);
    oy = (parentBody.orbitSMA / AU) * AU_px * Math.sin(parentBody._angle || 0);
  }
  ctx.save();
  ctx.strokeStyle = parentBody ? 'rgba(100,150,200,.12)' : 'rgba(100,180,255,.18)';
  ctx.lineWidth   = parentBody ? 0.5 : 1;
  ctx.setLineDash(parentBody ? [2,4] : []);
  ctx.beginPath();
  ctx.arc(ox, oy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

function pgDrawBody(ctx, body, parentBody, state, dpr) {
  const AU_px = 60;
  const pos = pgGetBodyScreenPos(body, parentBody);
  const isSelected = state.selected?.name === body.name;
  const isHovered  = state.hovered?.name  === body.name;

  // Visual radius (log-scaled so tiny moons still show)
  const minR = body.isCenter ? 12 : (parentBody ? 3 : 5);
  const visR = Math.max(minR, Math.log10(Math.max(body.radius, 1000) / 1e5) * 6 + minR);

  // Glow
  if (body.isCenter || body.type === 'star') {
    const grad = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, visR * 3);
    grad.addColorStop(0,   body.color + 'cc');
    grad.addColorStop(0.4, body.color + '44');
    grad.addColorStop(1,   body.color + '00');
    ctx.save(); ctx.globalAlpha = 0.5;
    ctx.beginPath(); ctx.arc(pos.x, pos.y, visR*3, 0, Math.PI*2);
    ctx.fillStyle = grad; ctx.fill();
    ctx.restore();
  }

  // Body circle
  ctx.save();
  const grad2 = ctx.createRadialGradient(pos.x - visR*0.3, pos.y - visR*0.3, 0, pos.x, pos.y, visR);
  grad2.addColorStop(0, _pgLighten(body.color, 0.5));
  grad2.addColorStop(1, body.color);
  ctx.fillStyle = grad2;
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, visR, 0, Math.PI*2);
  ctx.fill();

  // Selection ring
  if (isSelected || isHovered) {
    ctx.strokeStyle = isSelected ? 'rgba(255,255,100,.9)' : 'rgba(100,220,180,.7)';
    ctx.lineWidth   = isSelected ? 2 : 1.5;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, visR + 3, 0, Math.PI*2);
    ctx.stroke();
  }
  ctx.restore();

  // Name label
  if (!parentBody || isHovered || isSelected) {
    ctx.save();
    const fontSize = body.isCenter ? 9 : 7;
    ctx.font      = `${fontSize}px 'JetBrains Mono', monospace`;
    ctx.fillStyle = isSelected ? 'rgba(255,255,140,.95)' : 'rgba(180,200,255,.7)';
    ctx.textAlign = 'center';
    ctx.fillText(body.name, pos.x, pos.y + visR + 10);
    ctx.restore();
  }

  // Store screen position for hit testing
  body._screenX = pos.x;
  body._screenY = pos.y;
  body._screenR = visR;
}

function pgDrawTooltip(ctx, body, W, H, dpr) {
  const state = PG.canvas;
  if (!body._screenX) return;

  const sx = W/2 + (state.pan.x + body._screenX * state.zoom) * dpr;
  const sy = H/2 + (state.pan.y + body._screenY * state.zoom) * dpr;

  const lines = [
    body.name,
    `Type: ${body.type}`,
    body.isCenter ? 'System Center' : `Orbit: ${(body.orbitSMA/AU).toFixed(2)} AU`,
    `Radius: ${_pgFmtNum(body.radius)} m`,
  ];
  if (body.children.length) lines.push(`Moons: ${body.children.length}`);

  const pad = 10*dpr, lh = 14*dpr;
  const tw  = 130*dpr;
  const th  = lines.length * lh + pad*2;
  let tx = sx + 14*dpr, ty = sy - th/2;
  tx = Math.max(8*dpr, Math.min(tx, W - tw - 8*dpr));
  ty = Math.max(8*dpr, Math.min(ty, H - th - 8*dpr));

  ctx.save();
  ctx.fillStyle   = 'rgba(4,8,20,.92)';
  ctx.strokeStyle = 'rgba(100,220,180,.35)';
  ctx.lineWidth   = 1;
  ctx.beginPath();
  ctx.roundRect(tx, ty, tw, th, 4*dpr);
  ctx.fill(); ctx.stroke();

  ctx.font      = `bold ${Math.round(8*dpr)}px 'JetBrains Mono', monospace`;
  ctx.fillStyle = 'rgba(100,220,180,.9)';
  ctx.textAlign = 'left';
  ctx.fillText(lines[0], tx+pad, ty+pad+8*dpr);

  ctx.font      = `${Math.round(7*dpr)}px 'JetBrains Mono', monospace`;
  ctx.fillStyle = 'rgba(180,200,255,.7)';
  for (let i = 1; i < lines.length; i++) {
    ctx.fillText(lines[i], tx+pad, ty+pad + (i+1)*lh);
  }
  ctx.restore();
}

function pgDrawLegend(ctx, W, H, dpr) {
  const enabled = Object.entries(PG.types).filter(([,t]) => t.enabled);
  if (!enabled.length) return;

  const pad  = 10*dpr, lh = 14*dpr;
  const bx   = 10*dpr, by = H - (enabled.length * lh + pad*2) - 10*dpr;
  const bw   = 100*dpr, bh = enabled.length * lh + pad*2;

  ctx.save();
  ctx.globalAlpha = 0.75;
  ctx.fillStyle   = 'rgba(2,6,16,.8)';
  ctx.strokeStyle = 'rgba(60,80,130,.4)';
  ctx.lineWidth   = 1;
  ctx.beginPath();
  ctx.roundRect(bx, by, bw, bh, 4*dpr);
  ctx.fill(); ctx.stroke();

  ctx.font = `${Math.round(7*dpr)}px 'JetBrains Mono', monospace`;
  enabled.forEach(([, t], i) => {
    const y = by + pad + (i+0.8) * lh;
    ctx.fillStyle = t.color;
    ctx.beginPath();
    ctx.arc(bx + pad + 5*dpr, y, 4*dpr, 0, Math.PI*2);
    ctx.fill();
    ctx.fillStyle = 'rgba(180,200,255,.7)';
    ctx.textAlign = 'left';
    ctx.fillText(t.label, bx + pad + 14*dpr, y + 3*dpr);
  });
  ctx.restore();
}

// ── Hit testing ───────────────────────────────────────────────
function _pgHitTest(cv, clientX, clientY) {
  const rect  = cv.getBoundingClientRect();
  const dpr   = window.devicePixelRatio || 1;
  const state = PG.canvas;
  const mx = (clientX - rect.left - rect.width/2  - state.pan.x) / state.zoom;
  const my = (clientY - rect.top  - rect.height/2 - state.pan.y) / state.zoom;

  let found = null;
  for (const body of PG.preview.bodies) {
    if (body._screenX === undefined) continue;
    const dx = mx - body._screenX, dy = my - body._screenY;
    if (Math.sqrt(dx*dx+dy*dy) <= body._screenR + 6) { found = body; break; }
    for (const moon of body.children) {
      if (moon._screenX === undefined) continue;
      const dx2 = mx - moon._screenX, dy2 = my - moon._screenY;
      if (Math.sqrt(dx2*dx2+dy2*dy2) <= moon._screenR + 6) { found = moon; break; }
    }
    if (found) break;
  }

  if (state.hovered?.name !== found?.name) {
    state.hovered = found;
    cv.style.cursor = found ? 'pointer' : 'grab';
    pgDrawCanvas();
  }
}

function _pgHitTestClick(cv, clientX, clientY) {
  const rect  = cv.getBoundingClientRect();
  const state = PG.canvas;
  const mx = (clientX - rect.left - rect.width/2  - state.pan.x) / state.zoom;
  const my = (clientY - rect.top  - rect.height/2 - state.pan.y) / state.zoom;

  let found = null;
  for (const body of PG.preview.bodies) {
    if (body._screenX === undefined) continue;
    const dx = mx - body._screenX, dy = my - body._screenY;
    if (Math.sqrt(dx*dx+dy*dy) <= body._screenR + 6) { found = body; break; }
    for (const moon of body.children) {
      if (moon._screenX === undefined) continue;
      const dx2 = mx - moon._screenX, dy2 = my - moon._screenY;
      if (Math.sqrt(dx2*dx2+dy2*dy2) <= moon._screenR + 6) { found = moon; break; }
    }
    if (found) break;
  }
  state.selected = found;
  pgDrawCanvas();
  if (found) pgShowBodyInfo(found);
}

function pgShowBodyInfo(body) {
  const el = document.getElementById('pg-body-info');
  if (!el) return;
  const lines = [
    `<b>${body.icon} ${body.name}</b>`,
    `Type: ${body.type}`,
    body.isCenter ? 'System center' : `Orbit: ${(body.orbitSMA/AU).toFixed(2)} AU`,
    `Radius: ${_pgFmtNum(body.radius)} m`,
    body.children.length ? `Moons: ${body.children.length}` : '',
    `Preset: ${body.preset?.name || '—'}`,
  ].filter(Boolean);
  el.innerHTML = lines.join('<br>');
  el.style.display = 'block';
}

// ── Helpers ───────────────────────────────────────────────────
function _pgLighten(hex, amt) {
  try {
    const n = parseInt(hex.replace('#',''), 16);
    const r = Math.min(255, (n>>16) + Math.round(255*amt));
    const g = Math.min(255, ((n>>8)&0xff) + Math.round(255*amt));
    const b = Math.min(255, (n&0xff) + Math.round(255*amt));
    return `rgb(${r},${g},${b})`;
  } catch(e) { return hex; }
}

function _pgFmtNum(n) {
  if (n >= 1e9) return (n/1e9).toFixed(1)+'B';
  if (n >= 1e6) return (n/1e6).toFixed(1)+'M';
  if (n >= 1e3) return (n/1e3).toFixed(1)+'K';
  return Math.round(n).toString();
}

// Assign angles when bodies are generated
const _origPgGenerate = pgGenerate;
// Patch to assign angles after generation
window.pgGenerate = function() {
  _origPgGenerate();
  pgAssignAngles();
  pgDrawCanvas();
};
