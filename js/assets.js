// ════════════════════════════════ TEXTURE CACHE ════════════════════════════════
// Maps texture name (without extension) → HTMLImageElement
const textureCache  = {};
const texPixelCache = {};
let _sfsDbgLogged   = {}; // throttle per-body NODRAW warnings to once per load

function cacheTexture(name, dataUrl){
  const img = new Image();
  img.onload = () => {
    textureCache[name] = img;
    // ── Fast path: 64×64 strip samples (cheap, done immediately) ───────────
    try {
      const c = document.createElement('canvas');
      c.width = 64; c.height = 64;
      const x = c.getContext('2d');
      x.drawImage(img, 0, 0, 64, 64);
      texPixelCache[name + '_ring']  = x.getImageData(0, 0, 64, 1).data;
      texPixelCache[name + '_atmos'] = x.getImageData(0, 0, 1, 64).data;
    } catch(e) { console.warn('[SFS|CACHE] strip sample failed:', e); }

    // Notify immediately so the viewport can render (without atmo polar warp yet).
    drawViewport();
    if(typeof refreshTexPickerLists === 'function') refreshTexPickerLists();
    if(typeof _PSC !== 'undefined' && _PSC.open && typeof _pscScheduleDraw === 'function'){
      _pscScheduleDraw();
    }

    // ── Slow path: 256×256 atmosphere polar warp — deferred off main thread ─
    // requestIdleCallback fires when the browser is idle so it won't block
    // loading-screen paint, scrolling, or any other interaction.
    // Falls back to setTimeout(0) on browsers without rIC (rare).
    const _doPolarWarp = () => {
      try {
        // ── Atmosphere polar canvas ──────────────────────────────────────────
        // Pre-warp the texture into polar coordinates so drawImage() can paint
        // it directly onto the atmosphere disc at render time.
        //
        // SFS wrapping rules:
        //   - Texture left  edge (U=0) = rightmost point of planet (East, angle=0)
        //   - Texture right edge (U=1) = wraps back after 360° counter-clockwise
        //   - Wrapping is CCW: East→North→West→South→East = left→right of texture
        //   - Texture bottom row (Y=SH-1) = planet surface (radFrac=0)
        //   - Texture top    row (Y=0)    = outer atmosphere edge (radFrac=1)
        //
        // Canvas atan2: angle=0 → East, increases clockwise (CW).
        // To get CCW from East: u = 1 - normalised_CW_angle  (flip direction)
        const SZ = 256;
        const pc = document.createElement('canvas');
        pc.width = SZ; pc.height = SZ;
        const px2 = pc.getContext('2d');
        const srcC = document.createElement('canvas');
        srcC.width = img.naturalWidth; srcC.height = img.naturalHeight;
        const srcX = srcC.getContext('2d');
        srcX.drawImage(img, 0, 0);
        const srcD = srcX.getImageData(0, 0, srcC.width, srcC.height).data;
        const SW = srcC.width, SH = srcC.height;
        const outD = px2.createImageData(SZ, SZ);
        const od = outD.data;
        const halfSZ = SZ / 2;
        for(let py = 0; py < SZ; py++){
          for(let ppx = 0; ppx < SZ; ppx++){
            const dx = ppx - halfSZ, dy = py - halfSZ;
            const radFrac = Math.sqrt(dx*dx + dy*dy) / halfSZ;
            const oi = (py*SZ + ppx)*4;
            if(radFrac > 1.0){
              od[oi]=od[oi+1]=od[oi+2]=od[oi+3]=0;
              continue;
            }
            let cwAngle = Math.atan2(dy, dx) / (Math.PI*2);
            if(cwAngle < 0) cwAngle += 1;
            const u = (1 - cwAngle) % 1;
            const sx = Math.min(SW-1, Math.max(0, Math.round(u * (SW-1))));
            const sy = Math.min(SH-1, Math.max(0, Math.round((1 - radFrac) * (SH-1))));
            const si = (sy * SW + sx) * 4;
            od[oi]   = srcD[si];
            od[oi+1] = srcD[si+1];
            od[oi+2] = srcD[si+2];
            od[oi+3] = srcD[si+3];
          }
        }
        px2.putImageData(outD, 0, 0);
        texPixelCache[name + '_atmoCanvas'] = pc;
        // Re-draw now that the atmosphere canvas is ready
        drawViewport();
      } catch(e) { console.warn('[SFS|CACHE] atmo polar warp failed:', e); }
    };
    if(typeof requestIdleCallback === 'function'){
      requestIdleCallback(_doPolarWarp, { timeout: 2000 });
    } else {
      setTimeout(_doPolarWarp, 0);
    }
  };
  img.src = dataUrl;
}

// ════════════════════════════════ ASSETS SYSTEM ════════════════════════════════
const assets = {
  textures: [],   // all uploaded image textures (flat list, no categories)
  heightmaps: [], other: []
};

function openAssets(){ document.getElementById('modal-assets').classList.add('open'); }
function closeAssets(){ document.getElementById('modal-assets').classList.remove('open'); }

function switchAssetTab(name, btn){
  document.querySelectorAll('.atab').forEach(b=>b.classList.remove('on'));
  document.querySelectorAll('.asset-panel').forEach(p=>p.classList.remove('on'));
  btn.classList.add('on');
  document.getElementById('apanel-'+name).classList.add('on');
}

function handleDrop(e, type){
  e.preventDefault();
  handleFiles(e.dataTransfer.files, type);
}

function handleFiles(files, type){
  Array.from(files).forEach(file => {
    const reader = new FileReader();
    if(type === 'textures'){
      reader.onload = ev => {
        // Auto-rename duplicates: "Tex.png" → "Tex_1.png" → "Tex_2.png" …
        const ext  = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.')) : '';
        let   base = file.name.slice(0, file.name.length - ext.length);
        let   finalName = file.name;
        let   n = 1;
        while(assets.textures.find(a => a.name === finalName)){
          finalName = base + '_' + n + ext;
          n++;
        }
        const entry = { name: finalName, url: ev.target.result, size: file.size };
        assets.textures.push(entry);
        renderAssetThumb(entry);
        const texName = finalName.replace(/\.[^.]+$/, '');
        cacheTexture(texName, ev.target.result);
        refreshTexPickerLists();
        updateAssetEmptyState();
      };
      reader.readAsDataURL(file);
    } else if(type==='heightmaps' && /\.(png|jpe?g)$/i.test(file.name)){
      reader.onload = ev => {
        const entry = { name: file.name, url: ev.target.result, size: file.size };
        assets.heightmaps.push(entry);
        renderAssetRow(entry, 'heightmaps');
        injectCustomHeightmap(entry.name);
      };
      reader.readAsDataURL(file);
    } else if(type==='heightmaps' || type==='other'){
      reader.onload = ev => {
        const entry = { name: file.name, content: ev.target.result, size: file.size };
        assets[type].push(entry);
        renderAssetRow(entry, type);
        if(type==='heightmaps') injectCustomHeightmap(entry.name);
      };
      reader.readAsText(file);
    }
  });
}

function renderAssetThumb(entry){
  const grid = document.getElementById('agrid-textures');
  if(!grid) return;
  const safe = sanitize(entry.name);
  const div = document.createElement('div');
  div.className = 'asset-thumb'; div.id='asset-tex-'+safe;
  div.dataset.name = entry.name.replace(/\.[^.]+$/,'').toLowerCase();
  div.innerHTML = `<img src="${entry.url}" alt="${entry.name}">
    <div class="asset-thumb-name">${entry.name}</div>
    <button class="adel" onclick="removeAsset('${safe}')">✕</button>`;
  grid.appendChild(div);
}

function renderAssetRow(entry, type){
  const list = document.getElementById('alist-'+type);
  if(!list) return;
  const div = document.createElement('div');
  div.className = 'asset-row'; div.id='asset-'+type+'-'+sanitize(entry.name);
  div.dataset.name = entry.name.replace(/\.[^.]+$/,'').toLowerCase();
  const icon = type==='heightmaps' ? '📊' : '📎';
  const kb = Math.round((entry.size||0)/1024*10)/10;
  div.innerHTML = `<span class="asset-row-icon">${icon}</span>
    <span class="asset-row-name">${entry.name}</span>
    <span class="asset-row-size">${kb} KB</span>
    <button class="asset-row-del" onclick="removeAsset('${sanitize(entry.name)}','${type}')">✕</button>`;
  list.appendChild(div);
  // Update empty state for heightmaps
  if(type === 'heightmaps'){
    const empty = document.getElementById('asset-hm-empty');
    if(empty) empty.style.display = 'none';
  }
}

function removeAsset(safeName, type){
  if(type && type !== 'textures'){
    // Find the real name before removing, so we can bust caches keyed by it
    const removed = assets[type]?.find(a => sanitize(a.name) === safeName);
    if(assets[type]) assets[type] = assets[type].filter(a=>sanitize(a.name)!==safeName);
    document.getElementById('asset-'+type+'-'+safeName)?.remove();
    if(type === 'heightmaps'){
      // Bust heightmap cache entries for removed name
      if(removed && typeof _hmCache !== 'undefined'){
        delete _hmCache[removed.name];
        const base = removed.name.replace(/\.[^.]+$/, '');
        if(base !== removed.name) delete _hmCache[base];
      }
      if(typeof invalidateTerrainCache === 'function') invalidateTerrainCache('*');
      if(typeof hmRefreshLoadedList === 'function') hmRefreshLoadedList();
      // Update empty state
      const list = document.getElementById('alist-heightmaps');
      const empty = document.getElementById('asset-hm-empty');
      if(empty && list) empty.style.display = list.querySelectorAll('.asset-row').length === 0 ? 'block' : 'none';
    }
    if(typeof drawViewport === 'function') drawViewport();
    return;
  }
  // Remove from textures list
  const removedTex = assets.textures.find(a => sanitize(a.name) === safeName);
  assets.textures = assets.textures.filter(a=>sanitize(a.name)!==safeName);
  document.getElementById('asset-tex-'+safeName)?.remove();
  // Bust texture cache for removed entry
  if(removedTex && typeof textureCache !== 'undefined'){
    const texBase = removedTex.name.replace(/\.[^.]+$/, '');
    delete textureCache[texBase];
  }
  refreshTexPickerLists();
  updateAssetEmptyState();
  if(typeof drawViewport === 'function') drawViewport();
}

function updateAssetEmptyState(){
  const empty = document.getElementById('asset-tex-empty');
  if(empty) empty.style.display = assets.textures.length === 0 ? 'block' : 'none';
}

function filterAssetGrid(){
  const q = (document.getElementById('asset-tex-search')?.value||'').toLowerCase();
  document.querySelectorAll('#agrid-textures .asset-thumb').forEach(el=>{
    const n = el.dataset.name || '';
    el.style.display = (!q || n.includes(q)) ? '' : 'none';
  });
}

function filterAssetHmList(){
  const q = (document.getElementById('asset-hm-search')?.value||'').toLowerCase();
  document.querySelectorAll('#alist-heightmaps .asset-row').forEach(el=>{
    const n = (el.dataset.name || '');
    el.style.display = (!q || n.includes(q)) ? '' : 'none';
  });
  // Update empty state
  const list = document.getElementById('alist-heightmaps');
  const empty = document.getElementById('asset-hm-empty');
  if(empty && list){
    const visible = list.querySelectorAll('.asset-row:not([style*="display: none"]):not([style*="display:none"])');
    const hasRows = list.querySelectorAll('.asset-row').length > 0;
    empty.style.display = (!hasRows || (q && visible.length === 0)) ? 'block' : 'none';
  }
}

function sanitize(name){ return name.replace(/[^a-zA-Z0-9_\-]/g,'_'); }

function injectCustomHeightmap(name){
  // Clear this heightmap from the evaluator cache so it gets re-parsed.
  // The cache is keyed by basename WITHOUT extension (the name used in formulas),
  // so we must delete both the full name and the stripped basename.
  if(typeof _hmCache !== 'undefined'){
    delete _hmCache[name];
    const base = name.replace(/\.[^.]+$/, '');
    if(base !== name) delete _hmCache[base];
  }
  if(typeof invalidateTerrainCache === 'function') invalidateTerrainCache('*');
  if(typeof hmRefreshLoadedList === 'function') hmRefreshLoadedList();
  if(typeof drawViewport === 'function') drawViewport();
}
function refreshSortUI(){ /* removed — no sorting anymore */ }

// ════════ TEX-PICKER WIDGET SYSTEM ════════
// All texture fields (av-tex, cl-tex, etc.) are now tpick widgets.
// Each has: input#id (holds the value), dropdown#tpd-id (the open list).
// On load/change, setTexPick(id, value) populates the input display.
// val(id) just reads .value directly from the input — unchanged.

const TPICK_IDS = ['av-tex','cl-tex','fc-tex','tt-pt','tt-sa','tt-sb','tt-tc','rng-tex','wt-tex'];

// All texture names available (from loaded ZIPs only)
function allTexNames(){
  const uploaded = assets.textures.map(a => a.name.replace(/\.[^.]+$/,''));
  return [...new Set(uploaded)].sort((a,b)=>a.localeCompare(b,undefined,{sensitivity:'base'}));
}

// Returns aspect ratio (width/height) for a cached texture, or 1 if unknown.
function _texAspect(name){
  const img = textureCache[name];
  if(img && img.naturalWidth && img.naturalHeight) return img.naturalWidth / img.naturalHeight;
  // Fallback: check assets entry via an offscreen Image if not yet decoded.
  // We can't block here, so just return 1 (neutral) for uncached textures.
  return 1;
}

// Per-picker sort configs:
//   keyword  – boost textures whose name includes this string (case-insensitive)
//   aspect   – 'tall'   → portrait first (low ratio)
//              'wide'   → landscape first (high ratio)
//              'square' → closest to 1:1 first
//   keyFirst – keyword matches float above aspect-preference matches
// Special case: 'cl-tex' uses a custom 3-bucket sort (see sortTexForPicker).
const TPICK_SORT = {
  'av-tex':  { keyword: 'atmo',  aspect: 'tall',  keyFirst: true },
  'fc-tex':  { keyword: 'cloud', aspect: 'square', keyFirst: true },
  'rng-tex': { keyword: 'ring',  aspect: 'wide',   keyFirst: true },
};

// Score a texture for a given picker so lower = shown first.
function _texSortScore(name, cfg){
  const lower      = name.toLowerCase();
  const hasKw      = lower.includes(cfg.keyword);
  const ratio      = _texAspect(name);

  let aspectScore;
  if(cfg.aspect === 'tall'){
    aspectScore = ratio;
  } else if(cfg.aspect === 'wide'){
    aspectScore = 1 / Math.max(ratio, 0.01);
  } else { // 'square'
    aspectScore = Math.abs(ratio - 1);
  }

  // Keyword matches get a large bucket offset → float to top
  return (hasKw ? 0 : 1000) + aspectScore;
}

// cl-tex 3-bucket sort:
//   bucket 0 – "cloud" keyword + least square (furthest from 1:1, i.e. wide/tall)
//   bucket 1 – "cloud" keyword + squarer (closest to 1:1)
//   bucket 2 – everything else (alpha)
function _clTexSortScore(name){
  const hasCloud = name.toLowerCase().includes('cloud');
  const ratio    = _texAspect(name);
  const squareness = Math.abs(ratio - 1); // 0 = perfect square, higher = less square

  if(hasCloud){
    // bucket 0: non-square cloud textures (sorted most-non-square first → descending squareness)
    // bucket 1: square cloud textures (sorted most-square first → ascending squareness)
    // We split at squareness threshold of 0.2 (ratio outside 0.83–1.2 = "not square")
    const isSquare = squareness < 0.2;
    if(!isSquare){
      // bucket 0: sort descending squareness (least square = most stretched = first)
      return { bucket: 0, sub: -squareness };
    } else {
      // bucket 1: sort ascending squareness (most square first)
      return { bucket: 1, sub: squareness };
    }
  }
  // bucket 2: alpha sort
  return { bucket: 2, sub: 0 };
}

// Sort a list of texture names for a specific picker.
function sortTexForPicker(names, pickId){
  if(pickId === 'cl-tex'){
    return names.slice().sort((a, b) => {
      const sa = _clTexSortScore(a);
      const sb = _clTexSortScore(b);
      if(sa.bucket !== sb.bucket) return sa.bucket - sb.bucket;
      if(sa.sub    !== sb.sub)    return sa.sub    - sb.sub;
      return a.localeCompare(b, undefined, { sensitivity: 'base' });
    });
  }
  const cfg = TPICK_SORT[pickId];
  if(!cfg) return names; // no special ordering → unchanged (already alpha)
  return names.slice().sort((a, b) => {
    const sa = _texSortScore(a, cfg);
    const sb = _texSortScore(b, cfg);
    if(sa !== sb) return sa - sb;
    return a.localeCompare(b, undefined, { sensitivity: 'base' });
  });
}

function getTexThumb(name){
  // Check textureCache first (works for all built-ins and uploads)
  const img = textureCache[name];
  if(img && img.src) return img.src;
  // Check uploaded entry
  const entry = assets.textures.find(a=>a.name.replace(/\.[^.]+$/,'')===name);
  if(entry) return entry.url;
  return null;
}

function buildDropdownItems(pickId, query){
  const q = query.toLowerCase();
  // Get alphabetically-sorted base list, then apply per-picker smart ordering.
  const sorted   = sortTexForPicker(allTexNames(), pickId);
  const filtered = sorted.filter(n => !q || n.toLowerCase().includes(q));
  const dd = document.getElementById('tpd-'+pickId);
  if(!dd) return;
  // Bump token so any in-flight rAF chains from a previous build abort.
  dd._buildToken = (dd._buildToken || 0) + 1;
  dd.innerHTML = '';

  // Always show None at top (counts toward the cap)
  if(!q || 'none'.includes(q)){
    const noneEl = document.createElement('div');
    noneEl.className = 'tpick-opt tpick-none';
    noneEl.textContent = 'None';
    noneEl.onclick = () => commitTexPick(pickId, 'None');
    dd.appendChild(noneEl);
  }
  if(filtered.length === 0 && q){
    const emp = document.createElement('div');
    emp.className = 'tpick-empty';
    emp.textContent = 'No match for "' + query + '"';
    dd.appendChild(emp);
    return;
  }

  // Show at most 5 results — keeps DOM tiny and images small on mobile.
  const MAX_VISIBLE = 5;
  const visible = filtered.slice(0, MAX_VISIBLE);
  visible.forEach(name => {
    const el = document.createElement('div');
    el.className = 'tpick-opt';
    const thumb = getTexThumb(name);
    el.innerHTML = thumb
      ? `<img class="tpick-opt-thumb" src="${thumb}"><span class="tpick-opt-name">${name}</span>`
      : `<span class="tpick-opt-nothumb"></span><span class="tpick-opt-name">${name}</span>`;
    el.onclick = () => commitTexPick(pickId, name);
    dd.appendChild(el);
  });

  if(filtered.length > MAX_VISIBLE){
    const more = document.createElement('div');
    more.className = 'tpick-empty';
    more.textContent = `+${filtered.length - MAX_VISIBLE} more — type to filter`;
    dd.appendChild(more);
  }
}

function commitTexPick(pickId, name){
  const inp = document.getElementById(pickId);
  if(!inp) return;
  inp.value = name;
  inp.dataset.lastCommit = name;
  inp.classList.toggle('has-val', name !== 'None' && name !== '');
  const clr = document.getElementById('tpc-'+pickId);
  if(clr) clr.classList.toggle('show', name !== 'None' && name !== '');
  _tpickUpdatePreview(pickId, name);
  closeTexPicker(pickId);
  liveSync();
}

function openTexPicker(pickId){
  // Close any other open pickers first
  TPICK_IDS.forEach(id => { if(id !== pickId) closeTexPicker(id); });
  const dd = document.getElementById('tpd-'+pickId);
  const inp = document.getElementById(pickId);
  if(!dd || !inp) return;
  // On touch devices the dropdown is position:absolute (CSS override),
  // so fixed coords are not needed and would be wrong after keyboard resize.
  const isTouch = window.matchMedia('(pointer: coarse)').matches;
  if(!isTouch){
    // Desktop: position dropdown using fixed coords (escapes overflow:auto sidebar)
    const rect = inp.getBoundingClientRect();
    dd.style.left  = rect.left + 'px';
    dd.style.width = rect.width + 'px';
    const spaceBelow = window.innerHeight - rect.bottom;
    if(spaceBelow >= 160 || spaceBelow > window.innerHeight - rect.top){
      dd.style.top    = (rect.bottom + 2) + 'px';
      dd.style.bottom = 'auto';
    } else {
      dd.style.bottom = (window.innerHeight - rect.top + 2) + 'px';
      dd.style.top    = 'auto';
    }
  }
  buildDropdownItems(pickId, '');
  // Select-all so first keypress replaces the displayed name with a fresh query
  requestAnimationFrame(() => inp.select());
  dd.classList.add('open');
}

function closeTexPicker(pickId){
  const dd = document.getElementById('tpd-'+pickId);
  if(dd){ dd.classList.remove('open'); dd._buildToken = (dd._buildToken || 0) + 1; }
  // Restore display text if user typed but didn't pick a result
  const inp = document.getElementById(pickId);
  if(inp && inp.dataset.lastCommit !== undefined){
    inp.value = inp.dataset.lastCommit;
    inp.classList.toggle('has-val', inp.dataset.lastCommit !== 'None' && inp.dataset.lastCommit !== '');
    _tpickUpdatePreview(pickId, inp.dataset.lastCommit);
  }
}

function _tpickUpdatePreview(pickId, name){
  // pickId is e.g. 'av-tex'; preview container is 'tpv-av-tex'
  const prev = document.getElementById('tpv-' + pickId);
  if(!prev) return;
  const thumb = (name && name !== 'None') ? getTexThumb(name) : null;
  if(thumb){
    prev.innerHTML = `<img src="${thumb}" alt="${name}">`;
  } else {
    prev.innerHTML = '<div class="tpick-preview-none">none</div>';
  }
}

function setTexPick(pickId, value){
  const inp = document.getElementById(pickId);
  if(!inp) return;
  const v = value || 'None';
  inp.value = v;
  inp.dataset.lastCommit = v;
  inp.classList.toggle('has-val', v !== 'None');
  const clr = document.getElementById('tpc-'+pickId);
  if(clr) clr.classList.toggle('show', v !== 'None');
  _tpickUpdatePreview(pickId, v);
}

// val() override for tpick inputs — reading .value gives the texture name directly, 
// so val() still works unchanged. But setSelectVal must route to setTexPick:
function setSelectVal(id, v){
  if(TPICK_IDS.includes(id)){
    setTexPick(id, v);
    return;
  }
  const el = document.getElementById(id); if(!el) return;
  for(let i=0;i<el.options.length;i++){ if(el.options[i].value===v||el.options[i].text===v){ el.selectedIndex=i; return; } }
}

// Rebuild all picker dropdowns when texture list changes (uploads etc.)
function refreshTexPickerLists(){
  // Rebuild open dropdowns and refresh all previews (new textures may now have thumbs)
  TPICK_IDS.forEach(id => {
    const dd = document.getElementById('tpd-'+id);
    if(dd && dd.classList.contains('open')){
      const inp = document.getElementById(id);
      buildDropdownItems(id, inp ? inp.value : '');
    }
    // Refresh preview in case a texture thumbnail just became available
    const inp = document.getElementById(id);
    if(inp && inp.dataset.lastCommit) _tpickUpdatePreview(id, inp.dataset.lastCommit);
  });
}

// Wire up all tpick widgets
function initTexPickers(){
  // Detect touch once — coarse pointer = mobile/tablet
  const isTouch = window.matchMedia('(pointer: coarse)').matches;

  TPICK_IDS.forEach(pickId => {
    const inp = document.getElementById(pickId);
    const clr = document.getElementById('tpc-'+pickId);
    let   dd  = document.getElementById('tpd-'+pickId);
    if(!inp || !dd) return;

    // On desktop: move dropdown to <body> so it escapes the sidebar's
    // transform stacking context (transform:translateX makes position:fixed
    // relative to the sidebar, not the viewport).
    // On touch: keep dropdown inside .tpick-wrap so that the CSS
    // `position:absolute; bottom:calc(100% + 2px)` correctly places it
    // above the input (above the software keyboard).
    if(!isTouch){
      document.body.appendChild(dd);
    }

    // mousedown on input: open picker, stop propagation so _tpickOutside doesn't
    // immediately close it on the same event.
    inp.addEventListener('mousedown', e => {
      e.stopPropagation();
      if(!dd.classList.contains('open')) openTexPicker(pickId);
      // If already open, leave it — user may be clicking to reposition cursor for typing
    });
    // Mobile: touchend opens picker
    inp.addEventListener('touchend', e => {
      e.stopPropagation();
      openTexPicker(pickId);
    }, { passive: false });

    // Type to filter — debounced so mobile doesn't choke rebuilding DOM every keystroke.
    // Desktop gets a shorter delay (50 ms) for snappier feel; touch gets 150 ms.
    let _tpickTimer = null;
    inp.addEventListener('input', () => {
      if(!isTouch){
        // Reposition dropdown on desktop
        const rect = inp.getBoundingClientRect();
        dd.style.left  = rect.left + 'px';
        dd.style.width = rect.width + 'px';
        const spaceBelow = window.innerHeight - rect.bottom;
        if(spaceBelow >= 160 || spaceBelow > window.innerHeight - rect.top){
          dd.style.top    = (rect.bottom + 2) + 'px';
          dd.style.bottom = 'auto';
        } else {
          dd.style.bottom = (window.innerHeight - rect.top + 2) + 'px';
          dd.style.top    = 'auto';
        }
      }
      dd.classList.add('open');
      // Debounce the expensive DOM rebuild
      clearTimeout(_tpickTimer);
      _tpickTimer = setTimeout(() => {
        buildDropdownItems(pickId, inp.value);
      }, isTouch ? 150 : 50);
    });
    // Clear button
    if(clr) clr.addEventListener('click', e => {
      e.stopPropagation();
      commitTexPick(pickId, 'None');
    });
    // Set initial display
    setTexPick(pickId, inp.value || 'None');
  });

  // Click/touch outside closes all
  function _tpickOutside(e){
    TPICK_IDS.forEach(id => {
      const wrap = document.getElementById('tpw-'+id);
      const dd   = document.getElementById('tpd-'+id);
      if(wrap && !wrap.contains(e.target) && dd && !dd.contains(e.target))
        closeTexPicker(id);
    });
  }
  document.addEventListener('mousedown',  _tpickOutside);
  document.addEventListener('touchstart', _tpickOutside, { passive: true });
  // Stop mousedown/touchstart on any dropdown from bubbling to _tpickOutside.
  // Query dropdowns AFTER conditional body.appendChild above so we catch the
  // right parent for each device type.
  document.querySelectorAll('.tpick-dropdown').forEach(dd => {
    dd.addEventListener('mousedown', e => e.stopPropagation());
    dd.addEventListener('touchstart', e => e.stopPropagation(), { passive: true });
  });
  // Close on sb-body scroll (desktop fixed dropdown drifts on scroll)
  const sbBody = document.querySelector('.sb-body');
  if(sbBody) sbBody.addEventListener('scroll', () => {
    TPICK_IDS.forEach(id => closeTexPicker(id));
  }, {passive: true});
}

