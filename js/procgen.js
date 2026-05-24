// ════════════════════════════════════════════════════════════
//  procgen.js  —  Procedural System Generation
// ════════════════════════════════════════════════════════════

const AU = 1.496e11;

const PG = {
  types: {
    star:        { label:'Stars',        icon:'⭐', enabled:true,  weight:20, color:'#ffd060' },
    planet:      { label:'Planets',      icon:'🌍', enabled:true,  weight:55, color:'#4488ff' },
    moon:        { label:'Moons',        icon:'🌙', enabled:true,  weight:18, color:'#aaaaaa' },
    asteroid:    { label:'Asteroids',    icon:'☄️', enabled:false, weight:5,  color:'#886644' },
    brown_dwarf: { label:'Brown Dwarfs', icon:'🟤', enabled:false, weight:3,  color:'#cc6622' },
    blackhole:   { label:'Black Holes',  icon:'⚫', enabled:false, weight:2,  color:'#8800ff' },
  },
  tune: {
    bodyCount:    { min:2,  max:16,  val:6,    step:1,    label:'Body Count' },
    orbitMin:     { min:0.1,max:5,   val:0.3,  step:0.1,  label:'Min Orbit (AU)' },
    orbitMax:     { min:1,  max:60,  val:15,   step:1,    label:'Max Orbit (AU)' },
    radiusScale:  { min:0.1,max:3,   val:1.0,  step:0.1,  label:'Radius Scale' },
    eccentricity: { min:0,  max:0.9, val:0.15, step:0.05, label:'Max Eccentricity' },
  },
  misc: {
    addMoons:       true,
    addRings:       true,
    addAtmospheres: true,
  },
  preview: { bodies:[], center:null },
  canvas:  { pan:{x:0,y:0}, zoom:1, drag:false, lastP:null, hovered:null, selected:null },
};

// ── Open / Close ──────────────────────────────────────────────
function openProceduralGen() {
  _utilsDropOpen = false;
  document.getElementById('utils-dropdown').style.display = 'none';
  document.getElementById('procgen-modal').style.display = 'flex';
  pgBuildUI();
  // rAF x2: first frame triggers layout, second reads correct clientHeight
  requestAnimationFrame(() => requestAnimationFrame(() => {
    pgInitCanvas();
    pgDrawCanvas();
  }));
}
function closeProceduralGen() {
  document.getElementById('procgen-modal').style.display = 'none';
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('procgen-modal')?.addEventListener('click', e => {
    if (e.target === document.getElementById('procgen-modal')) closeProceduralGen();
  });
});

// ── Build UI ──────────────────────────────────────────────────
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
    <div class="pg-body-row">
      <label class="pg-body-btn ${t.enabled?'pg-body-btn--on':''}" data-type="${key}"
        onclick="pgToggleType('${key}',this)">
        <span class="pg-body-icon">${t.icon}</span>
        <span class="pg-body-label">${t.label}</span>
        <span class="pg-body-check">${t.enabled?'✓':''}</span>
      </label>
    </div>`).join('');
}

function pgToggleType(key, el) {
  PG.types[key].enabled = !PG.types[key].enabled;
  el.classList.toggle('pg-body-btn--on', PG.types[key].enabled);
  el.querySelector('.pg-body-check').textContent = PG.types[key].enabled ? '✓' : '';
  pgRenderFrequencyControls();
}

function pgRenderFrequencyControls() {
  const container = document.getElementById('pg-freq-controls');
  if (!container) return;
  const enabled = Object.entries(PG.types).filter(([,t]) => t.enabled);
  if (!enabled.length) {
    container.innerHTML = '<div style="font-size:.6rem;color:rgba(150,160,200,.5)">Enable a body type above.</div>';
    return;
  }
  const totalW = enabled.reduce((s,[,t]) => s+t.weight, 0);
  container.innerHTML = enabled.map(([key,t]) => {
    const pct = Math.round((t.weight/totalW)*100);
    return `<div class="pg-freq-row">
      <span class="pg-freq-icon">${t.icon}</span>
      <span class="pg-freq-name">${t.label}</span>
      <input type="range" class="pg-freq-slider" min="1" max="100" value="${t.weight}"
        oninput="pgSetWeight('${key}',this.value)" style="accent-color:${t.color}">
      <span class="pg-freq-pct" id="pg-pct-${key}">${pct}%</span>
    </div>`;
  }).join('');
}

function pgSetWeight(key, val) {
  PG.types[key].weight = parseInt(val);
  const enabled = Object.entries(PG.types).filter(([,t])=>t.enabled);
  const totalW  = enabled.reduce((s,[,t])=>s+t.weight,0);
  enabled.forEach(([k,t]) => {
    const el = document.getElementById(`pg-pct-${k}`);
    if (el) el.textContent = Math.round((t.weight/totalW)*100)+'%';
  });
}

function pgRenderFineTuning() {
  const container = document.getElementById('pg-fine-tuning');
  if (!container) return;
  container.innerHTML = Object.entries(PG.tune).map(([key,t]) => `
    <div>
      <div class="pg-tune-label">${t.label}</div>
      <div class="pg-tune-controls">
        <input type="range" class="pg-tune-slider"
          min="${t.min}" max="${t.max}" step="${t.step}" value="${t.val}"
          oninput="pgSetTune('${key}',this.value)">
        <span class="pg-tune-val" id="pg-tune-val-${key}">${t.val}</span>
      </div>
    </div>`).join('');
}

function pgSetTune(key, val) {
  PG.tune[key].val = parseFloat(val);
  const el = document.getElementById(`pg-tune-val-${key}`);
  if (el) el.textContent = parseFloat(val).toFixed(val%1===0?0:2);
}

function pgRenderMiscOptions() {
  const container = document.getElementById('pg-misc-options');
  if (!container) return;
  const opts = [
    { key:'addMoons',       label:'Allow moon generation' },
    { key:'addRings',       label:'Allow ring systems' },
    { key:'addAtmospheres', label:'Allow atmospheres' },
  ];
  container.innerHTML = opts.map(o => `
    <label class="pg-misc-row">
      <input type="checkbox" ${PG.misc[o.key]?'checked':''}
        onchange="PG.misc['${o.key}']=this.checked" style="accent-color:#64dcb4;width:15px;height:15px">
      <span>${o.label}</span>
    </label>`).join('');
}

// ── Generation ────────────────────────────────────────────────
function pgGenerate() {
  const enabled = Object.entries(PG.types).filter(([,t])=>t.enabled);
  if (!enabled.length) { pgShowStatus('Enable at least one body type.','warn'); return; }

  PG.preview.bodies = [];
  PG.preview.center = null;

  // Center: prefer star
  const centerType   = PG.types.star.enabled ? 'star' : enabled[0][0];
  const centerPreset = pgPickPreset(centerType);
  if (!centerPreset) { pgShowStatus('No presets loaded — load a preset pack first.','warn'); return; }

  const centerName = NameGen.generate();
  const center = {
    name:     centerName,
    type:     centerType,
    preset:   centerPreset,
    isCenter: true,
    orbitSMA: 0,
    radius:   (centerPreset.data.BASE_DATA?.radius||34817000),
    color:    PG.types[centerType]?.color||'#ffd060',
    icon:     PG.types[centerType]?.icon||'⭐',
    _angle:   0,
    children: [],
  };
  PG.preview.center = center;
  PG.preview.bodies.push(center);

  // Orbiting bodies
  const count    = PG.tune.bodyCount.val - 1;
  const orbitMin = PG.tune.orbitMin.val * AU;
  const orbitMax = PG.tune.orbitMax.val * AU;
  const spacing  = (orbitMax - orbitMin) / Math.max(count, 1);

  // Minimum safe clearance: star radius + a buffer so planets never overlap it
  const starRadius = center.radius || 34817000;
  const safeClearance = Math.max(orbitMin, starRadius * 8);

  const orbitTypes = enabled.filter(([k])=> k!=='star' || !PG.types.star.enabled);
  const pickPool   = orbitTypes.length ? orbitTypes : enabled;

  for (let i = 0; i < count; i++) {
    const type   = pgWeightedPick(pickPool.map(([k])=>[k, PG.types[k].weight]));
    const preset = pgPickPreset(type);
    if (!preset) continue;

    // Jitter is ±20% of spacing but never lets sma drop below safeClearance
    const baseSma = orbitMin + spacing * i;
    const jitter  = spacing * (0.4 * Math.random() - 0.2);
    const sma     = Math.max(safeClearance, Math.min(orbitMax, baseSma + jitter));
    const ecc  = Math.random() * PG.tune.eccentricity.val;
    const name = NameGen.generate();
    const radius = (preset.data.BASE_DATA?.radius||600000) * PG.tune.radiusScale.val;

    const body = {
      name, type, preset, isCenter:false,
      parent:   centerName,
      orbitSMA: sma, orbitEcc:ecc, orbitDir: Math.random()>0.1?1:-1,
      radius, color:PG.types[type]?.color||'#aaaaaa', icon:PG.types[type]?.icon||'🌍',
      _angle: Math.random()*Math.PI*2,
      children: [],
    };

    // Moons
    if (PG.misc.addMoons && (type==='planet'||type==='gasgiant') && Math.random()>0.5) {
      const moonPreset = pgPickPreset('moon');
      if (moonPreset) {
        const moonCount = Math.floor(Math.random()*3)+1;
        for (let m=0; m<moonCount; m++) {
          body.children.push({
            name: NameGen.generate(), type:'moon',
            parent: name, preset: moonPreset,
            orbitSMA: radius*(8+m*6+Math.random()*3),
            orbitEcc: Math.random()*0.05, orbitDir:1,
            radius: (moonPreset.data?.BASE_DATA?.radius||300000)*0.3,
            color:'#999999', icon:'🌙', _angle:Math.random()*Math.PI*2, children:[],
          });
        }
      }
    }

    PG.preview.bodies.push(body);
    center.children.push(body);
  }

  pgDrawCanvas();
  pgShowStatus(`✓ ${PG.preview.bodies.length} bodies ready — click APPLY TO SYSTEM`, 'ok');
}

// ── Preset helpers ────────────────────────────────────────────
function pgPickPreset(type) {
  if (typeof buildAllPresets !== 'function') return null;
  const all = buildAllPresets();
  if (!all.length) return null;
  const typeMap = {
    star:['star'], planet:['planet','mercurylike','marslike'],
    moon:['moon'], asteroid:['asteroid'],
    gasgiant:['gasgiant','ringedgiant'],
    brown_dwarf:['star'], blackhole:['blackhole'],
  };
  const ids = typeMap[type]||['planet'];
  const matches = all.filter(p=>ids.includes(p.id));
  const pool = matches.length ? matches : all;
  return pool[Math.floor(Math.random()*pool.length)];
}
function pgWeightedPick(pairs) {
  const total = pairs.reduce((s,[,w])=>s+w,0);
  let r = Math.random()*total;
  for (const [k,w] of pairs) { r-=w; if(r<=0) return k; }
  return pairs[pairs.length-1][0];
}

// ── Apply → show import dialog ────────────────────────────────
function pgApply() {
  if (!PG.preview.center) { pgShowStatus('Generate a system first.','warn'); return; }

  const bodyCount = PG.preview.bodies.reduce((s,b)=>s+1+b.children.length,0);
  document.getElementById('pg-import-body-count').textContent =
    `${bodyCount} bodies ready to import`;

  // Populate parent selector with current system bodies
  const sel = document.getElementById('pg-orbit-parent-sel');
  const currentBodies = typeof bodies!=='undefined' ? Object.keys(bodies) : [];
  const hasExisting = currentBodies.length > 0;

  sel.innerHTML = currentBodies.length
    ? currentBodies.map(n=>`<option value="${n}">${n}${bodies[n]?.isCenter?' ★':''}</option>`).join('')
    : '<option value="">— no bodies in current system —</option>';

  // Hide orbit option if no existing system
  const orbitBtn = sel.closest('button');

  document.getElementById('pg-import-dialog').style.display = 'flex';
}

function pgImportCancel() {
  document.getElementById('pg-import-dialog').style.display = 'none';
}

function pgImportReplace() {
  pgImportCancel();
  if (typeof pushUndo==='function') pushUndo();

  // Wipe current system
  if (typeof bodies!=='undefined') {
    Object.keys(bodies).forEach(k=>delete bodies[k]);
  }
  document.getElementById('empty-state')?.classList.add('gone');

  // Add center (no orbit)
  const c = PG.preview.center;
  const cd = JSON.parse(JSON.stringify(c.preset.data));
  delete cd.ORBIT_DATA;
  const cm = typeof inferPresetMeta==='function' ? inferPresetMeta(c.name,cd) : {};
  bodies[c.name] = { data:cd, preset:cm.id||'star', isCenter:true,
    color:cm.color||c.color, glow:cm.glow||c.color, icon:cm.icon||c.icon };

  _pgAddOrbiters(c.name);
  _pgFinish(c.name);
}

function pgImportOrbit() {
  const parentName = document.getElementById('pg-orbit-parent-sel').value;
  if (!parentName || !bodies[parentName]) {
    alert('Select a valid parent body first.'); return;
  }
  pgImportCancel();
  if (typeof pushUndo==='function') pushUndo();
  document.getElementById('empty-state')?.classList.add('gone');

  // Add the generated center as an orbiting body of the chosen parent
  const c = PG.preview.center;
  const cd = JSON.parse(JSON.stringify(c.preset.data));
  // Give center an orbit around chosen parent
  const parentR = bodies[parentName]?.data?.BASE_DATA?.radius || 34817000;
  cd.ORBIT_DATA  = { parent:parentName, semiMajorAxis:parentR*80, SMA:parentR*80, E:0.05, direction:1 };
  const cm = typeof inferPresetMeta==='function' ? inferPresetMeta(c.name,cd) : {};
  bodies[c.name] = { data:cd, preset:cm.id||'star', isCenter:false,
    color:cm.color||c.color, glow:cm.glow||c.color, icon:cm.icon||c.icon };

  _pgAddOrbiters(c.name);
  _pgFinish(null);
}

function pgImportMerge() {
  pgImportCancel();
  if (typeof pushUndo==='function') pushUndo();
  document.getElementById('empty-state')?.classList.add('gone');

  const existingCenter = typeof bodies!=='undefined'
    ? Object.keys(bodies).find(k=>bodies[k].isCenter) : null;

  // If no existing center, treat same as replace
  if (!existingCenter) { pgImportReplace(); return; }

  // Add generated bodies orbiting the existing center
  _pgAddOrbiters(existingCenter);
  _pgFinish(existingCenter);
}

function _pgAddOrbiters(parentName) {
  for (const body of PG.preview.bodies) {
    if (body.isCenter) continue;
    _pgAddBody(body, parentName);
    for (const moon of body.children) {
      _pgAddBody(moon, body.name);
    }
  }
}

function _pgAddBody(body, parentName) {
  let name = body.name, suffix = 2;
  while (bodies[name]) name = body.name+'_'+(suffix++);

  const bd = JSON.parse(JSON.stringify(body.preset?.data||{}));
  if (bd.BASE_DATA) bd.BASE_DATA.radius = body.radius;
  bd.ORBIT_DATA = {
    parent: parentName, semiMajorAxis:body.orbitSMA, SMA:body.orbitSMA,
    E:body.orbitEcc||0, direction:body.orbitDir||1,
  };
  if (!PG.misc.addRings)       delete bd.RINGS_DATA;
  if (!PG.misc.addAtmospheres) { delete bd.ATMOSPHERE_PHYSICS_DATA; delete bd.ATMOSPHERE_VISUALS_DATA; }

  const m = typeof inferPresetMeta==='function' ? inferPresetMeta(name,bd) : {};
  bodies[name] = { data:bd, preset:m.id||body.type, isCenter:false,
    color:m.color||body.color, glow:m.glow||body.color, icon:m.icon||body.icon };
  // Persist original name for moons to find parent
  if (name !== body.name) body.name = name;
}

function _pgFinish(selectName) {
  if (typeof drawViewport   ==='function') drawViewport();
  if (typeof updateStatusBar==='function') updateStatusBar();
  if (selectName && typeof selectBody==='function') selectBody(selectName);
  pgShowStatus(`✓ System imported successfully!`, 'ok');
  setTimeout(closeProceduralGen, 1400);
}

function pgClear() {
  PG.preview.bodies=[];PG.preview.center=null;
  PG.canvas.selected=null;PG.canvas.hovered=null;
  pgDrawCanvas(); pgShowStatus('','');
}

function pgShowStatus(msg, type) {
  const el = document.getElementById('pg-status');
  if (!el) return;
  el.textContent  = msg;
  el.style.color  = type==='ok'?'rgba(100,220,180,.9)':type==='warn'?'rgba(255,180,80,.9)':'rgba(150,160,200,.5)';
  el.style.display= msg?'block':'none';
}

// ── Canvas ────────────────────────────────────────────────────
let _pgCanvasInitDone = false;
function pgInitCanvas() {
  const cv = document.getElementById('pg-canvas');
  if (!cv) return;
  if (!_pgCanvasInitDone) {
    _pgCanvasInitDone = true;
    const s = PG.canvas;

    cv.addEventListener('mousedown', e => { s.drag=true; s.lastP={x:e.clientX,y:e.clientY}; e.preventDefault(); });
    window.addEventListener('mousemove', e => {
      if (!s.drag) { _pgHoverTest(cv,e.clientX,e.clientY); return; }
      s.pan.x+=e.clientX-s.lastP.x; s.pan.y+=e.clientY-s.lastP.y;
      s.lastP={x:e.clientX,y:e.clientY}; pgDrawCanvas();
    });
    window.addEventListener('mouseup', e => {
      if (s.drag) { s.drag=false; _pgClickTest(cv,e.clientX,e.clientY); }
    });

    // Touch
    let _pinchD=null;
    cv.addEventListener('touchstart', e => {
      e.preventDefault();
      if (e.touches.length===1) { s.drag=true; s.lastP={x:e.touches[0].clientX,y:e.touches[0].clientY}; _pinchD=null; }
      else if (e.touches.length===2) { s.drag=false; _pinchD=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY); }
    },{passive:false});
    cv.addEventListener('touchmove', e => {
      e.preventDefault();
      if (e.touches.length===2&&_pinchD) {
        const t0=e.touches[0], t1=e.touches[1];
        const d=Math.hypot(t0.clientX-t1.clientX, t0.clientY-t1.clientY);
        const rect=cv.getBoundingClientRect();
        // midpoint in canvas-local coords
        const mx=((t0.clientX+t1.clientX)/2 - rect.left  - rect.width /2 - s.pan.x) / s.zoom;
        const my=((t0.clientY+t1.clientY)/2 - rect.top   - rect.height/2 - s.pan.y) / s.zoom;
        const nz=Math.max(0.05,Math.min(8,s.zoom*(d/_pinchD)));
        // pan so the midpoint stays fixed on screen
        s.pan.x -= mx*(nz-s.zoom);
        s.pan.y -= my*(nz-s.zoom);
        s.zoom=nz; _pinchD=d; pgDrawCanvas();
      } else if (e.touches.length===1&&s.drag) {
        s.pan.x+=e.touches[0].clientX-s.lastP.x; s.pan.y+=e.touches[0].clientY-s.lastP.y;
        s.lastP={x:e.touches[0].clientX,y:e.touches[0].clientY}; pgDrawCanvas();
      }
    },{passive:false});
    cv.addEventListener('touchend', e=>{ if(!e.touches.length){s.drag=false;_pinchD=null;} });

    cv.addEventListener('wheel', e => {
      e.preventDefault();
      const rect=cv.getBoundingClientRect();
      const mx=(e.clientX-rect.left-rect.width/2-s.pan.x)/s.zoom;
      const my=(e.clientY-rect.top-rect.height/2-s.pan.y)/s.zoom;
      const f=e.deltaY<0?1.12:0.89;
      const nz=Math.max(0.05,Math.min(8,s.zoom*f));
      s.pan.x-=mx*(nz-s.zoom); s.pan.y-=my*(nz-s.zoom); s.zoom=nz; pgDrawCanvas();
    },{passive:false});
  }
  pgDrawCanvas();
}

function pgResizeCanvas() {
  const cv=document.getElementById('pg-canvas'); if(!cv) return;
  const w=cv.parentElement.clientWidth, h=cv.parentElement.clientHeight;
  const dpr=window.devicePixelRatio||1;
  cv.width=Math.round(w*dpr); cv.height=Math.round(h*dpr);
  cv.style.width=w+'px'; cv.style.height=h+'px';
}

// ── Draw ──────────────────────────────────────────────────────
const AU_PX = 60; // pixels per AU at zoom=1

function pgDrawCanvas() {
  const cv=document.getElementById('pg-canvas'); if(!cv) return;
  pgResizeCanvas();
  const ctx=cv.getContext('2d');
  const dpr=window.devicePixelRatio||1;
  const W=cv.width, H=cv.height;
  const s=PG.canvas;

  ctx.clearRect(0,0,W,H);
  ctx.fillStyle='#020509'; ctx.fillRect(0,0,W,H);
  _pgStarfield(ctx,W,H);
  _pgGrid(ctx,W,H,s,dpr);

  if (!PG.preview.center) {
    ctx.save(); ctx.globalAlpha=0.3;
    ctx.font=`bold ${Math.round(13*dpr)}px 'JetBrains Mono',monospace`;
    ctx.fillStyle='#3355aa'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText('Generate a system to preview it here',W/2,H/2);
    ctx.restore(); return;
  }

  ctx.save();
  ctx.translate(W/2+s.pan.x*dpr, H/2+s.pan.y*dpr);
  ctx.scale(s.zoom*dpr, s.zoom*dpr);

  // Orbits
  for (const b of PG.preview.bodies) {
    if (!b.isCenter) _pgOrbit(ctx,b,null);
    for (const m of b.children) _pgOrbit(ctx,m,b);
  }
  // Bodies
  for (const b of PG.preview.bodies) {
    _pgBody(ctx,b,null,s,dpr);
    for (const m of b.children) _pgBody(ctx,m,b,s,dpr);
  }
  ctx.restore();

  if (s.hovered) _pgTooltip(ctx,s.hovered,W,H,dpr);
  _pgLegend(ctx,W,H,dpr);
}

function _pgStarfield(ctx,W,H) {
  ctx.save();
  for (let i=0;i<100;i++) {
    const x=((i*7919)%W+W)%W, y=((i*6271)%H+H)%H;
    ctx.globalAlpha=0.08+(i%5)*0.07;
    ctx.fillStyle='#fff';
    ctx.beginPath(); ctx.arc(x,y,0.5+(i%3)*0.4,0,Math.PI*2); ctx.fill();
  }
  ctx.restore();
}

function _pgGrid(ctx,W,H,s,dpr) {
  const cx=W/2+s.pan.x*dpr, cy=H/2+s.pan.y*dpr;
  const aupx=AU_PX*s.zoom*dpr;
  ctx.save(); ctx.strokeStyle='rgba(40,70,120,.2)'; ctx.lineWidth=1; ctx.setLineDash([3,7]);
  for (let r=1;r<=30;r++) {
    const rpx=r*aupx; if(rpx>W*1.6) break;
    ctx.beginPath(); ctx.arc(cx,cy,rpx,0,Math.PI*2); ctx.stroke();
    if (rpx>24&&rpx<W*0.82) {
      ctx.save();
      ctx.font=`${Math.round(9*dpr)}px 'JetBrains Mono',monospace`;
      ctx.fillStyle='rgba(50,90,160,.4)'; ctx.textAlign='left'; ctx.globalAlpha=.7; ctx.setLineDash([]);
      ctx.fillText(`${r}AU`,cx+rpx+4*dpr,cy-4*dpr); ctx.restore(); ctx.setLineDash([3,7]);
    }
  }
  ctx.setLineDash([]); ctx.restore();
}

function _pgBodyPos(body, parent) {
  if (body.isCenter) return {x:0,y:0};
  const r=(body.orbitSMA/AU)*AU_PX;
  let ox=0,oy=0;
  if (parent&&!parent.isCenter) { ox=(parent.orbitSMA/AU)*AU_PX*Math.cos(parent._angle||0); oy=(parent.orbitSMA/AU)*AU_PX*Math.sin(parent._angle||0); }
  return {x:ox+r*Math.cos(body._angle||0), y:oy+r*Math.sin(body._angle||0)};
}

function _pgOrbit(ctx,body,parent) {
  const r=(body.orbitSMA/AU)*AU_PX;
  let ox=0,oy=0;
  if (parent&&!parent.isCenter) { ox=(parent.orbitSMA/AU)*AU_PX*Math.cos(parent._angle||0); oy=(parent.orbitSMA/AU)*AU_PX*Math.sin(parent._angle||0); }
  ctx.save();
  ctx.strokeStyle=parent?'rgba(80,120,180,.15)':'rgba(80,140,255,.22)';
  ctx.lineWidth=parent?0.5:1; ctx.setLineDash(parent?[2,5]:[]);
  ctx.beginPath(); ctx.arc(ox,oy,r,0,Math.PI*2); ctx.stroke();
  ctx.setLineDash([]); ctx.restore();
}

function _pgBody(ctx,body,parent,s,dpr) {
  const pos=_pgBodyPos(body,parent);
  const isSel=s.selected?.name===body.name, isHov=s.hovered?.name===body.name;
  const minR=body.isCenter?14:(parent?3:5);
  const visR=Math.max(minR, Math.log10(Math.max(body.radius,1e4)/1e5)*6+minR);

  // Glow for stars
  if (body.isCenter||body.type==='star'||body.type==='brown_dwarf'||body.type==='blackhole') {
    const g=ctx.createRadialGradient(pos.x,pos.y,0,pos.x,pos.y,visR*3.5);
    g.addColorStop(0,body.color+'bb'); g.addColorStop(0.5,body.color+'33'); g.addColorStop(1,body.color+'00');
    ctx.save(); ctx.globalAlpha=0.6; ctx.beginPath(); ctx.arc(pos.x,pos.y,visR*3.5,0,Math.PI*2); ctx.fillStyle=g; ctx.fill(); ctx.restore();
  }

  // Body
  const g2=ctx.createRadialGradient(pos.x-visR*.3,pos.y-visR*.3,0,pos.x,pos.y,visR);
  g2.addColorStop(0,_pgLighten(body.color,.5)); g2.addColorStop(1,body.color);
  ctx.save(); ctx.fillStyle=g2; ctx.beginPath(); ctx.arc(pos.x,pos.y,visR,0,Math.PI*2); ctx.fill();

  if (isSel||isHov) {
    ctx.strokeStyle=isSel?'rgba(255,255,100,.9)':'rgba(100,220,180,.75)';
    ctx.lineWidth=isSel?2:1.5;
    ctx.beginPath(); ctx.arc(pos.x,pos.y,visR+3,0,Math.PI*2); ctx.stroke();
  }
  ctx.restore();

  // Label
  if (!parent||isSel||isHov) {
    ctx.save();
    ctx.font=`${body.isCenter?9:7}px 'JetBrains Mono',monospace`;
    ctx.fillStyle=isSel?'rgba(255,255,140,.95)':'rgba(180,200,255,.72)';
    ctx.textAlign='center'; ctx.fillText(body.name,pos.x,pos.y+visR+10);
    ctx.restore();
  }

  body._sx=pos.x; body._sy=pos.y; body._sr=visR;
}

function _pgTooltip(ctx,body,W,H,dpr) {
  const s=PG.canvas;
  if (body._sx===undefined) return;
  const sx=W/2+(s.pan.x+body._sx*s.zoom)*dpr;
  const sy=H/2+(s.pan.y+body._sy*s.zoom)*dpr;
  const lines=[body.name,`Type: ${body.type}`,
    body.isCenter?'System center':`Orbit: ${(body.orbitSMA/AU).toFixed(2)} AU`,
    `Radius: ${_pgFmt(body.radius)} m`,
    ...(body.children.length?[`Moons: ${body.children.length}`]:[]),
  ];
  const pad=10*dpr,lh=15*dpr,tw=140*dpr,th=lines.length*lh+pad*2;
  let tx=sx+16*dpr, ty=sy-th/2;
  tx=Math.max(6*dpr,Math.min(tx,W-tw-6*dpr)); ty=Math.max(6*dpr,Math.min(ty,H-th-6*dpr));
  ctx.save();
  ctx.fillStyle='rgba(3,7,18,.93)'; ctx.strokeStyle='rgba(100,220,180,.3)'; ctx.lineWidth=1;
  ctx.beginPath(); ctx.roundRect(tx,ty,tw,th,4*dpr); ctx.fill(); ctx.stroke();
  ctx.font=`bold ${Math.round(8.5*dpr)}px 'JetBrains Mono',monospace`;
  ctx.fillStyle='rgba(100,220,180,.95)'; ctx.textAlign='left';
  ctx.fillText(lines[0],tx+pad,ty+pad+9*dpr);
  ctx.font=`${Math.round(7.5*dpr)}px 'JetBrains Mono',monospace`;
  ctx.fillStyle='rgba(170,195,255,.75)';
  for (let i=1;i<lines.length;i++) ctx.fillText(lines[i],tx+pad,ty+pad+(i+1)*lh);
  ctx.restore();
}

function _pgLegend(ctx,W,H,dpr) {
  const enabled=Object.entries(PG.types).filter(([,t])=>t.enabled);
  if (!enabled.length) return;
  const pad=10*dpr,lh=16*dpr,bw=110*dpr,bh=enabled.length*lh+pad*2;
  const bx=10*dpr, by=H-bh-10*dpr;
  ctx.save(); ctx.globalAlpha=0.8;
  ctx.fillStyle='rgba(2,5,16,.85)'; ctx.strokeStyle='rgba(50,80,140,.4)'; ctx.lineWidth=1;
  ctx.beginPath(); ctx.roundRect(bx,by,bw,bh,4*dpr); ctx.fill(); ctx.stroke();
  ctx.font=`${Math.round(7.5*dpr)}px 'JetBrains Mono',monospace`;
  enabled.forEach(([,t],i)=>{
    const y=by+pad+(i+0.75)*lh;
    ctx.fillStyle=t.color; ctx.beginPath(); ctx.arc(bx+pad+5*dpr,y,4*dpr,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='rgba(175,195,255,.75)'; ctx.textAlign='left'; ctx.fillText(t.label,bx+pad+14*dpr,y+3*dpr);
  });
  ctx.restore();
}

// Hit test
function _pgHoverTest(cv,cx,cy) {
  const r=cv.getBoundingClientRect(),s=PG.canvas;
  const mx=(cx-r.left-r.width/2-s.pan.x)/s.zoom, my=(cy-r.top-r.height/2-s.pan.y)/s.zoom;
  let found=null;
  outer: for (const b of PG.preview.bodies) {
    if (b._sx!==undefined&&Math.hypot(mx-b._sx,my-b._sy)<=b._sr+6){found=b;break;}
    for (const m of b.children) if(m._sx!==undefined&&Math.hypot(mx-m._sx,my-m._sy)<=m._sr+6){found=m;break outer;}
  }
  if (s.hovered?.name!==found?.name) { s.hovered=found; cv.style.cursor=found?'pointer':'grab'; pgDrawCanvas(); }
}

function _pgClickTest(cv,cx,cy) {
  const r=cv.getBoundingClientRect(),s=PG.canvas;
  const mx=(cx-r.left-r.width/2-s.pan.x)/s.zoom, my=(cy-r.top-r.height/2-s.pan.y)/s.zoom;
  let found=null;
  outer: for (const b of PG.preview.bodies) {
    if (b._sx!==undefined&&Math.hypot(mx-b._sx,my-b._sy)<=b._sr+6){found=b;break;}
    for (const m of b.children) if(m._sx!==undefined&&Math.hypot(mx-m._sx,my-m._sy)<=m._sr+6){found=m;break outer;}
  }
  s.selected=found; pgDrawCanvas();
  if (found) {
    const el=document.getElementById('pg-body-info');
    if (el) {
      el.innerHTML=[`<b>${found.icon} ${found.name}</b>`,`Type: ${found.type}`,
        found.isCenter?'System center':`Orbit: ${(found.orbitSMA/AU).toFixed(2)} AU`,
        `Radius: ${_pgFmt(found.radius)} m`,
        found.children.length?`Moons: ${found.children.length}`:'',
        `Preset: ${found.preset?.name||'—'}`,
      ].filter(Boolean).join('<br>');
      el.style.display='block';
    }
  }
}

// Helpers
function _pgLighten(hex,amt) {
  try { const n=parseInt(hex.replace('#',''),16); return `rgb(${Math.min(255,(n>>16)+~~(255*amt))},${Math.min(255,((n>>8)&0xff)+~~(255*amt))},${Math.min(255,(n&0xff)+~~(255*amt))})` } catch{return hex;}
}
function _pgFmt(n) {
  if(n>=1e9) return (n/1e9).toFixed(1)+'B';
  if(n>=1e6) return (n/1e6).toFixed(1)+'M';
  if(n>=1e3) return (n/1e3).toFixed(1)+'K';
  return Math.round(n)+'';
}
