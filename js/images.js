// ══════════════════════════════════════════════════════════════════════════════
//  images.js  —  Viewport image overlay system
//  Supports: import, drag, resize, rotate, opacity, click-through, lock-to-planet
// ══════════════════════════════════════════════════════════════════════════════

// ── State ─────────────────────────────────────────────────────────────────────
const _imgOverlays = [];     // array of overlay objects
let   _imgSelected = null;   // currently selected overlay id
let   _imgNextId   = 1;

// Each overlay: { id, name, img, worldX, worldY, worldW, worldH, rotation,
//                opacity, clickThrough, lockToBody, _imgEl(HTMLImageElement) }

// ── Panel open/close ───────────────────────────────────────────────────────────
function openImagePanel() {
  _utilsDropOpen = false;
  document.getElementById('utils-dropdown').style.display = 'none';
  document.getElementById('img-panel').classList.add('open');
}
function closeImagePanel() {
  document.getElementById('img-panel').classList.remove('open');
}

// ── Import from device ────────────────────────────────────────────────────────
function imgTriggerFileInput() {
  document.getElementById('img-file-input').click();
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('img-file-input').addEventListener('change', e => {
    const files = Array.from(e.target.files || []);
    files.forEach(f => {
      if(!/\.(png|jpe?g|gif|webp|svg)$/i.test(f.name)) return;
      const reader = new FileReader();
      reader.onload = ev => _imgAddOverlay(f.name, ev.target.result);
      reader.readAsDataURL(f);
    });
    e.target.value = '';
  });

  // Drag-and-drop onto the LOAD IMAGES area
  const drop = document.getElementById('img-drop-zone');
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('drag-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag-over'));
  drop.addEventListener('drop', e => {
    e.preventDefault(); drop.classList.remove('drag-over');
    Array.from(e.dataTransfer.files).forEach(f => {
      if(!/\.(png|jpe?g|gif|webp|svg)$/i.test(f.name)) return;
      const reader = new FileReader();
      reader.onload = ev => _imgAddOverlay(f.name, ev.target.result);
      reader.readAsDataURL(f);
    });
  });
});

// ── Add a new overlay ─────────────────────────────────────────────────────────
function _imgAddOverlay(name, dataUrl) {
  const img = new Image();
  img.onload = () => {
    // Place it at the current viewport centre in world coords, default 200px wide
    const wc = screenToWorld(vp.width / 2, vp.height / 2);
    const worldW = 200 / vpZ;
    const worldH = worldW * (img.naturalHeight / img.naturalWidth);
    const ov = {
      id: _imgNextId++,
      name: name.replace(/\.[^.]+$/, ''),
      img,
      worldX: wc.x - worldW / 2,
      worldY: wc.y - worldH / 2,
      worldW,
      worldH,
      rotation: 0,
      opacity: 1,
      clickThrough: false,
      lockToBody: 'None',
      _lockOffX: 0,
      _lockOffY: 0,
    };
    _imgOverlays.push(ov);
    _imgSelectOverlay(ov.id);
    _imgRebuildList();
    drawViewport();
  };
  img.src = dataUrl;
}

// ── Draw all overlays (called from _drawViewportNow hook) ─────────────────────
function imgDrawOverlays(ctx, vpZ_, vpOffX_, vpOffY_, vpW, vpH) {
  _imgOverlays.forEach(ov => {
    // Resolve lock-to-body offset
    let wx = ov.worldX, wy = ov.worldY;
    if(ov.lockToBody && ov.lockToBody !== 'None' && typeof bodyWorldPos !== 'undefined') {
      const bp = bodyWorldPos[ov.lockToBody];
      if(bp) { wx = bp.x + ov._lockOffX; wy = bp.y + ov._lockOffY; }
    }

    const sx = (wx + vpOffX_) * vpZ_ + vpW / 2;
    const sy = (wy + vpOffY_) * vpZ_ + vpH / 2;
    const sw = ov.worldW * vpZ_;
    const sh = ov.worldH * vpZ_;

    // Cull if entirely off-screen (generous margin for rotated images)
    const diag = Math.hypot(sw, sh) / 2;
    if(sx + diag < 0 || sx - diag > vpW || sy + diag < 0 || sy - diag > vpH) return;

    ctx.save();
    ctx.globalAlpha = ov.opacity;
    ctx.translate(sx + sw / 2, sy + sh / 2);
    ctx.rotate(ov.rotation);
    ctx.drawImage(ov.img, -sw / 2, -sh / 2, sw, sh);

    // Selection outline
    if(_imgSelected === ov.id) {
      ctx.strokeStyle = 'rgba(100,220,180,0.85)';
      ctx.lineWidth   = 1.5 / vpZ_;
      ctx.setLineDash([6 / vpZ_, 4 / vpZ_]);
      ctx.strokeRect(-sw / 2, -sh / 2, sw, sh);
      ctx.setLineDash([]);
      // Corner handles
      _imgHandleCorners(sw, sh).forEach(([hx, hy]) => {
        ctx.fillStyle = 'rgba(100,220,180,0.9)';
        const hr = 5 / vpZ_;
        ctx.fillRect(hx - hr, hy - hr, hr * 2, hr * 2);
      });
      // Rotation handle (top-centre)
      ctx.beginPath();
      ctx.arc(0, -sh / 2 - 18 / vpZ_, 5 / vpZ_, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,200,80,0.9)';
      ctx.fill();
    }

    ctx.globalAlpha = 1;
    ctx.restore();
  });
}

function _imgHandleCorners(sw, sh) {
  return [
    [-sw/2, -sh/2], [sw/2, -sh/2],
    [-sw/2,  sh/2], [sw/2,  sh/2],
  ];
}

// ── Hit-test helpers ──────────────────────────────────────────────────────────
// Returns overlay id (or null) for a screen point, top (last) first.
function imgHitTest(sx, sy) {
  for(let i = _imgOverlays.length - 1; i >= 0; i--) {
    const ov = _imgOverlays[i];
    if(ov.clickThrough) continue;
    if(_imgPointInOverlay(sx, sy, ov)) return ov.id;
  }
  return null;
}

function _imgWorldXY(ov) {
  let wx = ov.worldX, wy = ov.worldY;
  if(ov.lockToBody && ov.lockToBody !== 'None' && typeof bodyWorldPos !== 'undefined') {
    const bp = bodyWorldPos[ov.lockToBody];
    if(bp) { wx = bp.x + ov._lockOffX; wy = bp.y + ov._lockOffY; }
  }
  return { wx, wy };
}

function _imgPointInOverlay(sx, sy, ov) {
  const { wx, wy } = _imgWorldXY(ov);
  const cx = (wx + vpOffX) * vpZ + vp.width  / 2 + (ov.worldW * vpZ) / 2;
  const cy = (wy + vpOffY) * vpZ + vp.height / 2 + (ov.worldH * vpZ) / 2;
  const dx = sx - cx, dy = sy - cy;
  const cos = Math.cos(-ov.rotation), sin = Math.sin(-ov.rotation);
  const lx = cos * dx - sin * dy;
  const ly = sin * dx + cos * dy;
  return Math.abs(lx) <= (ov.worldW * vpZ) / 2 + 6
      && Math.abs(ly) <= (ov.worldH * vpZ) / 2 + 6;
}

// Returns 'corner'|'rotate'|'body'|null for a screen point on the selected overlay
function _imgHandleAt(sx, sy) {
  if(_imgSelected === null) return null;
  const ov = _imgOverlays.find(o => o.id === _imgSelected);
  if(!ov) return null;
  const { wx, wy } = _imgWorldXY(ov);
  const sw = ov.worldW * vpZ, sh = ov.worldH * vpZ;
  const cx = (wx + vpOffX) * vpZ + vp.width  / 2 + sw / 2;
  const cy = (wy + vpOffY) * vpZ + vp.height / 2 + sh / 2;
  const dx = sx - cx, dy = sy - cy;
  const cos = Math.cos(-ov.rotation), sin = Math.sin(-ov.rotation);
  const lx = cos * dx - sin * dy;
  const ly = sin * dx + cos * dy;

  // Rotation handle
  if(Math.hypot(lx, ly - (-sh / 2 - 18)) < 10) return 'rotate';
  // Corner handles
  for(const [hx, hy] of _imgHandleCorners(sw, sh)) {
    if(Math.hypot(lx - hx, ly - hy) < 10) return 'corner';
  }
  return null;
}

// ── Interaction state ─────────────────────────────────────────────────────────
let _imgDrag    = null; // { type:'move'|'corner'|'rotate', ovId, startX, startY, startWX, startWY, startW, startH, startRot, cornerIdx }

function _imgSelectOverlay(id) {
  _imgSelected = id;
  _imgUpdateSidebar();
  drawViewport();
}

// ── Mouse / touch wiring ──────────────────────────────────────────────────────
// Called from tools.js mousedown BEFORE body hit-test
function imgMouseDown(mx, my, clientX, clientY) {
  // Check handles first (only if an image is selected)
  const handle = _imgHandleAt(mx, my);
  if(handle) {
    const ov = _imgOverlays.find(o => o.id === _imgSelected);
    _imgDrag = {
      type: handle === 'rotate' ? 'rotate' : 'corner',
      ovId: ov.id,
      startX: clientX, startY: clientY,
      startWX: ov.worldX, startWY: ov.worldY,
      startW: ov.worldW, startH: ov.worldH,
      startRot: ov.rotation,
      aspect: ov.worldH / ov.worldW,
    };
    return true; // consumed
  }
  // Check body hit
  const hitId = imgHitTest(mx, my);
  if(hitId !== null) {
    _imgSelectOverlay(hitId);
    const ov = _imgOverlays.find(o => o.id === hitId);
    _imgDrag = {
      type: 'move',
      ovId: hitId,
      startX: clientX, startY: clientY,
      startWX: ov.worldX, startWY: ov.worldY,
      startOffX: ov._lockOffX, startOffY: ov._lockOffY,
    };
    return true; // consumed — don't pan
  }
  // Clicked empty space while an image was selected → deselect
  if(_imgSelected !== null) {
    _imgSelected = null;
    _imgUpdateSidebar();
    drawViewport();
  }
  return false;
}

function imgMouseMove(clientX, clientY) {
  if(!_imgDrag) return false;
  const ov = _imgOverlays.find(o => o.id === _imgDrag.ovId);
  if(!ov) { _imgDrag = null; return false; }
  const dx = (clientX - _imgDrag.startX) / vpZ;
  const dy = (clientY - _imgDrag.startY) / vpZ;

  if(_imgDrag.type === 'move') {
    if(ov.lockToBody && ov.lockToBody !== 'None') {
      ov._lockOffX = _imgDrag.startOffX + dx;
      ov._lockOffY = _imgDrag.startOffY + dy;
    } else {
      ov.worldX = _imgDrag.startWX + dx;
      ov.worldY = _imgDrag.startWY + dy;
    }
  } else if(_imgDrag.type === 'corner') {
    const newW = Math.max(20 / vpZ, _imgDrag.startW + dx * 2);
    ov.worldW = newW;
    ov.worldH = newW * _imgDrag.aspect;
  } else if(_imgDrag.type === 'rotate') {
    const { wx, wy } = _imgWorldXY(ov);
    const cx = (wx + vpOffX) * vpZ + vp.width  / 2 + ov.worldW * vpZ / 2;
    const cy = (wy + vpOffY) * vpZ + vp.height / 2 + ov.worldH * vpZ / 2;
    const rect = vp.getBoundingClientRect();
    const sx = clientX - rect.left, sy = clientY - rect.top;
    ov.rotation = Math.atan2(sy - cy, sx - cx) + Math.PI / 2;
  }
  _imgUpdateSidebar();
  drawViewport();
  return true;
}

function imgMouseUp() {
  _imgDrag = null;
}

// ── Sidebar panel ─────────────────────────────────────────────────────────────
function _imgUpdateSidebar() {
  const ov = _imgSelected !== null ? _imgOverlays.find(o => o.id === _imgSelected) : null;
  const det = document.getElementById('img-detail');
  const none = document.getElementById('img-detail-none');
  if(!ov) {
    if(det)  det.style.display  = 'none';
    if(none) none.style.display = '';
    return;
  }
  if(det)  det.style.display  = '';
  if(none) none.style.display = 'none';

  _imgSetField('img-d-name',    ov.name);
  _imgSetField('img-d-opacity', Math.round(ov.opacity * 100));
  _imgSetField('img-d-rotate',  Math.round(ov.rotation * 180 / Math.PI));
  _imgSetField('img-d-width',   Math.round(ov.worldW));
  _imgSetField('img-d-height',  Math.round(ov.worldH));
  _imgSetCheck('img-d-clickthrough', ov.clickThrough);

  // Sync range sliders
  const osl = document.getElementById('img-d-opacity-sl');
  const rsl = document.getElementById('img-d-rotate-sl');
  if(osl) osl.value = Math.round(ov.opacity * 100);
  if(rsl) rsl.value = Math.round(ov.rotation * 180 / Math.PI);

  // Lock-to-body dropdown
  const sel = document.getElementById('img-d-lock');
  if(sel) {
    const names = ['None', ...Object.keys(typeof bodies !== 'undefined' ? bodies : {})].sort();
    sel.innerHTML = names.map(n => `<option value="${n}"${ov.lockToBody===n?' selected':''}>${n}</option>`).join('');
  }
}

function _imgSetField(id, val) {
  const el = document.getElementById(id);
  if(el && document.activeElement !== el) el.value = val;
}
function _imgSetCheck(id, val) {
  const el = document.getElementById(id);
  if(el) el.checked = val;
}

// ── Sidebar field change handlers ─────────────────────────────────────────────
function imgFieldChange(field, value) {
  const ov = _imgSelected !== null ? _imgOverlays.find(o => o.id === _imgSelected) : null;
  if(!ov) return;
  if(field === 'name')        ov.name        = value;
  if(field === 'opacity')     ov.opacity     = Math.max(0, Math.min(1, parseFloat(value) / 100)) || 1;
  if(field === 'rotate')      ov.rotation    = (parseFloat(value) || 0) * Math.PI / 180;
  if(field === 'width')  {
    const w = Math.max(1, parseFloat(value) || 1);
    ov.worldH = ov.worldH * (w / ov.worldW);
    ov.worldW = w;
  }
  if(field === 'height') {
    const h = Math.max(1, parseFloat(value) || 1);
    ov.worldW = ov.worldW * (h / ov.worldH);
    ov.worldH = h;
  }
  if(field === 'clickthrough') ov.clickThrough = value;
  if(field === 'lock') {
    const prev = ov.lockToBody;
    ov.lockToBody = value;
    if(value !== 'None' && prev === 'None') {
      // Compute offset from body position
      const bp = typeof bodyWorldPos !== 'undefined' ? bodyWorldPos[value] : null;
      if(bp) { ov._lockOffX = ov.worldX - bp.x; ov._lockOffY = ov.worldY - bp.y; }
    } else if(value === 'None' && prev !== 'None') {
      // Resolve current position back to worldX/Y
      const { wx, wy } = _imgWorldXY(ov);
      ov.worldX = wx; ov.worldY = wy;
    }
  }
  _imgUpdateSidebar();
  drawViewport();
}

function imgDeleteSelected() {
  if(_imgSelected === null) return;
  const idx = _imgOverlays.findIndex(o => o.id === _imgSelected);
  if(idx >= 0) _imgOverlays.splice(idx, 1);
  _imgSelected = null;
  _imgRebuildList();
  _imgUpdateSidebar();
  drawViewport();
}

function imgDuplicateSelected() {
  const ov = _imgSelected !== null ? _imgOverlays.find(o => o.id === _imgSelected) : null;
  if(!ov) return;
  const copy = { ...ov, id: _imgNextId++, name: ov.name + '_copy',
                  worldX: ov.worldX + 20/vpZ, worldY: ov.worldY + 20/vpZ };
  _imgOverlays.push(copy);
  _imgSelectOverlay(copy.id);
  _imgRebuildList();
  drawViewport();
}

function imgBringForward() {
  const idx = _imgOverlays.findIndex(o => o.id === _imgSelected);
  if(idx < 0 || idx === _imgOverlays.length - 1) return;
  [_imgOverlays[idx], _imgOverlays[idx+1]] = [_imgOverlays[idx+1], _imgOverlays[idx]];
  _imgRebuildList(); drawViewport();
}
function imgSendBackward() {
  const idx = _imgOverlays.findIndex(o => o.id === _imgSelected);
  if(idx <= 0) return;
  [_imgOverlays[idx], _imgOverlays[idx-1]] = [_imgOverlays[idx-1], _imgOverlays[idx]];
  _imgRebuildList(); drawViewport();
}

// ── Image list in panel ───────────────────────────────────────────────────────
function _imgRebuildList() {
  const list = document.getElementById('img-list');
  if(!list) return;
  if(_imgOverlays.length === 0) {
    list.innerHTML = '<div style="padding:12px;font-size:.62rem;color:var(--ink4);text-align:center">No images loaded</div>';
    return;
  }
  list.innerHTML = [..._imgOverlays].reverse().map(ov => `
    <div class="img-list-row${_imgSelected === ov.id ? ' selected' : ''}" onclick="imgSelectFromList(${ov.id})">
      <img src="${ov.img.src}" class="img-list-thumb" alt="">
      <span class="img-list-name">${ov.name}</span>
      ${ov.clickThrough ? '<span class="img-list-badge">click-thru</span>' : ''}
      ${ov.lockToBody && ov.lockToBody !== 'None' ? '<span class="img-list-badge lock">🔒</span>' : ''}
    </div>
  `).join('');
}

function imgSelectFromList(id) {
  _imgSelectOverlay(id);
  _imgRebuildList();
}
