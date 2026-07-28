// ═══════════════════════════ COLLAB SYNC ═══════════════════════════
// Bridges the Collab networking layer (collab.js) to the actual editor
// state — `bodies`, `selectedBody`, the sidebar, and the viewport. Until
// this file, Collab could request/release locks and relay edit patches
// over the wire, but nothing in the app ever called any of that: selecting
// a body didn't request a lock, editing a body didn't broadcast anything,
// and joining a session never actually loaded the host's system.
//
// Loaded LAST (after state.js, sidebar.js, viewport.js, preset-modal.js,
// collab.js, collab-ui.js) — it wraps a handful of existing global
// functions rather than editing those files directly, the same pattern
// fillSidebar() already uses internally for window.setVal.
//
// Scope: full-system sync on join (with a loading screen masking the
// handshake), live property-edit sync + per-body lock indicators for
// whichever body is selected, structural sync (bodies added/deleted/
// renamed/imported/restored/regenerated/etc.) via a polling-based change
// detector rather than hooking each mutation site individually,
// systemSettings sync (importSettings/spaceCenterData from settings.js)
// riding along with that same mechanism, AND live asset sync (upload/
// delete, including bulk imports/restores that add many at once) via a
// parallel poll that sends only the delta — newly added entries + removed
// names — rather than the whole library each time. NOT covered: real
// conflict resolution for two people making structural changes at the same
// instant (last-write-wins, same as most casual P2P collab tools).
(function(){
  if(typeof Collab === 'undefined') return;

  let lockOwners = {};        // body name -> peerId currently editing it
  let peerInfo   = {};        // peerId -> {name, color}
  let applyingRemote = false; // true while we're applying an incoming state-sync/edit, so our own hooks don't re-broadcast it

  // ── Join-time loading screen ──
  // Without this, a joining peer briefly sees their own empty/default
  // system (still showing "+ ADD SYSTEM CENTER") for however long the
  // handshake + state-sync takes, before it's abruptly replaced by the
  // host's actual system. This masks that transition instead.
  let _joinLoadingTimeout = null;
  function _showJoinLoadingScreen(){
    let el = document.getElementById('cs-join-overlay');
    if(!el){
      el = document.createElement('div');
      el.id = 'cs-join-overlay';
      el.style.cssText = 'position:fixed; inset:0; z-index:99999; background:rgba(8,8,10,.94);'
        + 'display:flex; flex-direction:column; align-items:center; justify-content:center; gap:14px;'
        + 'font-family:inherit; color:var(--ink2, #ddd); backdrop-filter:blur(2px);';
      el.innerHTML = `
        <div style="width:34px;height:34px;border-radius:50%;border:3px solid var(--ac28);border-top-color:var(--sky2);animation:cs-spin 0.8s linear infinite"></div>
        <div style="font-size:.8rem;letter-spacing:.04em;color:var(--ink2, #ddd)">Syncing system from host…</div>
        <div id="cs-join-overlay-sub" style="font-size:.68rem;color:var(--ink4, #888)"></div>
      `;
      const style = document.createElement('style');
      style.textContent = '@keyframes cs-spin { to { transform: rotate(360deg); } }';
      document.head.appendChild(style);
      document.body.appendChild(el);
    }
    el.style.display = 'flex';

    // Safety net: if state-sync never arrives (join failed silently, host
    // vanished mid-handshake, etc.) don't trap the person behind this
    // overlay forever.
    clearTimeout(_joinLoadingTimeout);
    _joinLoadingTimeout = setTimeout(() => {
      const sub = document.getElementById('cs-join-overlay-sub');
      if(sub) sub.textContent = 'Taking longer than expected — check your connection, or leave and try again.';
    }, 12000);
  }
  function _hideJoinLoadingScreen(){
    clearTimeout(_joinLoadingTimeout);
    const el = document.getElementById('cs-join-overlay');
    if(el) el.style.display = 'none';
  }

  // Wraps the public API method directly — every caller (the Multiplayer
  // modal's Join flow in collab-ui.js) gets the overlay for free without
  // needing to change anything there.
  const _origJoinSession = Collab.joinSession;
  Collab.joinSession = function(...args){
    _showJoinLoadingScreen();
    return _origJoinSession.apply(Collab, args).catch(err => {
      _hideJoinLoadingScreen();
      throw err;
    });
  };

  // ── Multiplayer-scoped undo ──
  // Solo undo is a whole-`bodies` snapshot rollback — fine with one editor,
  // but in a shared session it would revert EVERYONE's changes back to that
  // point in time, not just the local user's own last action (if peer B
  // edited Mars after peer A's last push, peer A hitting undo would wipe out
  // B's edit too, even though A never touched Mars). Instead of a snapshot
  // rollback, multiplayer mode computes a per-body DIFF (which specific
  // bodies your own action added/removed/changed) and undo reverts only
  // those exact keys on top of whatever the CURRENT shared state is —
  // leaving anything anyone else has since changed untouched.
  //
  // Solo mode (Collab inactive) always falls through to the original
  // pushUndo/undoAction unchanged.
  let _mpUndoStack = []; // [{ bodyName: {before, after}, ... }, ...]

  function _computeBodiesDiff(before, after){
    const diff = {};
    const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for(const key of allKeys){
      const b = before[key], a = after[key];
      if(JSON.stringify(b) !== JSON.stringify(a)) diff[key] = { before: b, after: a };
    }
    return diff;
  }

  function _setUndoBtnState(active){
    const undoBtn = document.getElementById('undo-btn');
    if(!undoBtn) return;
    undoBtn.disabled = !active;
    undoBtn.classList.toggle('undo-active', active);
  }

  const _origPushUndo = pushUndo;
  pushUndo = function(){
    if(!Collab.isActive()){ _origPushUndo(); return; }
    // Every pushUndo() call site is a synchronous `pushUndo(); <mutate bodies>;`
    // pair (confirmed across tools.js/sidebar.js/placer.js/preset-modal.js/
    // procgen.js — none of them are async), so capturing "after" on the next
    // tick reliably lands once that mutation has completed.
    const before = JSON.parse(JSON.stringify(bodies));
    setTimeout(() => {
      const after = JSON.parse(JSON.stringify(bodies));
      const diff = _computeBodiesDiff(before, after);
      if(Object.keys(diff).length){
        _mpUndoStack.push(diff);
        if(_mpUndoStack.length > MAX_UNDO) _mpUndoStack.shift();
        _setUndoBtnState(true);
      }
    }, 0);
  };

  const _origUndoAction = undoAction;
  undoAction = function(){
    if(!Collab.isActive()){ _origUndoAction(); return; }
    if(!_mpUndoStack.length) return;
    const diff = _mpUndoStack.pop();

    for(const [name, { before }] of Object.entries(diff)){
      if(before === undefined) delete bodies[name]; // this key didn't exist before my action
      else bodies[name] = before;                   // restore to what it was before my action
    }

    if(selectedBody && !bodies[selectedBody]){
      selectedBody = null;
      if(typeof closeSidebar === 'function') closeSidebar();
    } else if(selectedBody && typeof fillSidebar === 'function'){
      fillSidebar(selectedBody);
    }
    const hasCenter = Object.values(bodies).some(b => b.isCenter);
    const empty = document.getElementById('empty-state');
    if(empty) empty.classList.toggle('gone', hasCenter);
    if(typeof updateStatusBar === 'function') updateStatusBar();
    if(typeof syncAddBodyBtn === 'function') syncAddBodyBtn();
    if(typeof resizeViewport === 'function') resizeViewport();
    if(typeof drawViewport === 'function') drawViewport();
    _setUndoBtnState(_mpUndoStack.length > 0);

    // This is a genuine local change (not a remote one), so it should
    // propagate to everyone else like any other structural change — do it
    // immediately rather than waiting up to 1.2s for the next poll tick.
    _checkStructuralChange();
  };

  // Fresh session, fresh undo history — a stale diff from a previous
  // session (or from before joining) shouldn't be replayable in a new one.
  Collab.on('hosted', () => { _mpUndoStack = []; _setUndoBtnState(false); });
  Collab.on('state-sync', () => { _mpUndoStack = []; _setUndoBtnState(false); });
  Collab.on('left', () => {
    _mpUndoStack = [];
    // Control reverts to the original solo undoStack, which was untouched
    // the whole time we were bypassing it above — reflect ITS actual state
    // rather than blindly disabling (it may still hold pre-session history).
    _setUndoBtnState(typeof undoStack !== 'undefined' && undoStack.length > 0);
  });

  function _me(){ return Collab.getMyInfo(); }

  // ── Lock bookkeeping ──
  function _setLockOwnersFromSnapshot(snapshot){
    lockOwners = {};
    for(const [body, lock] of Object.entries(snapshot || {})) lockOwners[body] = lock.peerId;
    _refreshLockUI();
  }

  // ── Lock UI: read-only overlay + banner on the sidebar when the open
  // body is locked by someone else. Targets the sidebar's scrollable
  // content area (.sb-body) rather than every individual field — far
  // simpler than threading a disabled state through hundreds of inputs. ──
  function _ensureLockBanner(){
    let el = document.getElementById('cs-lock-banner');
    if(!el){
      el = document.createElement('div');
      el.id = 'cs-lock-banner';
      el.style.cssText = 'padding:7px 14px; background:var(--rose); color:#fff;'
        + 'font-size:.72rem; font-weight:600; text-align:center; letter-spacing:.02em;';
      const sidebar = document.getElementById('sidebar');
      if(sidebar) sidebar.insertBefore(el, sidebar.firstChild);
    }
    return el;
  }

  function _refreshLockUI(){
    const sbBody = document.querySelector('#sidebar .sb-body');
    const banner = document.getElementById('cs-lock-banner');

    if(!Collab.isActive() || !selectedBody){
      if(sbBody){ sbBody.style.pointerEvents = ''; sbBody.style.opacity = ''; }
      if(banner) banner.remove();
      return;
    }

    const ownerId = lockOwners[selectedBody];
    const lockedByOther = !!(ownerId && ownerId !== _me().peerId);

    if(sbBody){
      sbBody.style.pointerEvents = lockedByOther ? 'none' : '';
      sbBody.style.opacity = lockedByOther ? '.55' : '';
    }
    if(lockedByOther){
      const name = peerInfo[ownerId]?.name || 'Someone';
      _ensureLockBanner().textContent = `🔒 Locked by ${name} — view only`;
    } else if(banner){
      banner.remove();
    }
  }

  // Host hands this to a newly-joining peer as part of state-sync, so they
  // start with the same textures/heightmaps the host's system actually
  // uses instead of missing assets and rendering blank/default bodies.
  // (Ongoing mid-session asset changes are handled separately below by
  // _checkAssetChange/_applyIncomingAssetSync, which send only the delta —
  // this provider here is just for the one-time join snapshot.)
  // Registered unconditionally — the typeof check happens lazily INSIDE the
  // callback (matching how setStateProvider is registered in collab-ui.js),
  // not eagerly here at script-parse time. An eager check here would
  // silently and permanently skip registration if `assets` weren't defined
  // yet at the exact moment this line ran (e.g. subtle script-order
  // sensitivity) — this is a strictly safer pattern.
  Collab.setAssetsProvider(() => (typeof assets !== 'undefined' ? assets : null));

  // Same lazy-check pattern — importSettings/spaceCenterData from settings.js.
  // Small plain object, no binaries, so (unlike assets) this rides along
  // with every full-sync too, not just the initial join.
  Collab.setSettingsProvider(() => (typeof systemSettings !== 'undefined' ? systemSettings : null));

  function _mergeIncomingAssets(remoteAssets){
    if(!remoteAssets || typeof assets === 'undefined') return;
    let added = 0;

    const merge = (list, type) => {
      for(const entry of (list || [])){
        const existingIdx = assets[type].findIndex(a => a.name === entry.name);
        if(existingIdx !== -1){
          // Same name already present — replace rather than skip. Matters
          // for the delta-sync path below: an entry only appears there
          // because its content/size differs from what we last knew, not
          // because it's a duplicate to ignore.
          assets[type][existingIdx] = entry;
        } else {
          assets[type].push(entry);
        }
        added++;
        if(type === 'textures'){
          const texName = entry.name.replace(/\.[^.]+$/, '');
          if(entry.url && typeof cacheTexture === 'function') cacheTexture(texName, entry.url);
          document.getElementById('asset-tex-' + (typeof sanitize === 'function' ? sanitize(entry.name) : entry.name))?.remove();
          if(typeof renderAssetThumb === 'function') renderAssetThumb(entry);
        } else {
          document.getElementById('asset-' + type + '-' + (typeof sanitize === 'function' ? sanitize(entry.name) : entry.name))?.remove();
          if(typeof renderAssetRow === 'function') renderAssetRow(entry, type);
          if(type === 'heightmaps' && typeof injectCustomHeightmap === 'function') injectCustomHeightmap(entry.name);
        }
      }
    };

    merge(remoteAssets.textures, 'textures');
    merge(remoteAssets.heightmaps, 'heightmaps');
    merge(remoteAssets.other, 'other');

    console.log('[CollabSync] merged', added, 'incoming asset(s) from host —',
      'textures:', assets.textures.length, 'heightmaps:', assets.heightmaps.length, 'other:', assets.other.length);
    if(typeof refreshTexPickerLists === 'function') refreshTexPickerLists();
    if(typeof drawViewport === 'function') drawViewport();
  }

  // ── Live asset sync (upload/delete, mid-session) ──
  // Import/restore/preset flows add assets via many direct
  // `assets[type].push(...)` call sites across io.js/autosave.js — same
  // "too many mutation sites to chase individually" situation as `bodies`,
  // so this uses the same polling strategy. Unlike bodies, though, only the
  // DELTA (newly added entries + removed names) is sent, not the whole
  // library each time — asset entries carry real image data.
  function _assetSigMap(type){
    const m = new Map();
    for(const a of (assets?.[type] || [])) m.set(a.name, a.size || 0);
    return m;
  }
  let _lastAssetSig = null; // { textures: Map(name->size), heightmaps: Map, other: Map }
  function _checkAssetChange(){
    if(!Collab.isActive() || applyingRemote || typeof assets === 'undefined') return;
    const cur = { textures: _assetSigMap('textures'), heightmaps: _assetSigMap('heightmaps'), other: _assetSigMap('other') };
    if(!_lastAssetSig){ _lastAssetSig = cur; return; } // first tick after session start — just establishes the baseline

    const added = { textures: [], heightmaps: [], other: [] };
    const removed = { textures: [], heightmaps: [], other: [] };
    let hasChange = false;

    for(const type of ['textures', 'heightmaps', 'other']){
      const prev = _lastAssetSig[type], now = cur[type];
      for(const [name, size] of now){
        if(!prev.has(name) || prev.get(name) !== size){
          const entry = assets[type].find(a => a.name === name);
          if(entry){ added[type].push(entry); hasChange = true; }
        }
      }
      for(const name of prev.keys()){
        if(!now.has(name)){ removed[type].push(name); hasChange = true; }
      }
    }

    if(hasChange){
      console.log('[CollabSync] asset change detected — added:', Object.fromEntries(Object.entries(added).map(([k,v])=>[k,v.map(a=>a.name)])), 'removed:', removed);
      const sent = Collab.broadcastAssetSync(added, removed);
      if(sent) _lastAssetSig = cur;
      else console.warn('[CollabSync] asset-sync send failed — will retry next poll tick');
    }
  }

  function _applyIncomingAssetSync(added, removed){
    if(typeof assets === 'undefined') return;
    applyingRemote = true;
    try {
      _mergeIncomingAssets(added);
      for(const type of ['textures', 'heightmaps', 'other']){
        for(const name of (removed?.[type] || [])){
          const safe = typeof sanitize === 'function' ? sanitize(name) : name;
          // Reuse the real removeAsset() rather than reimplementing its
          // cleanup (DOM removal, texture/heightmap cache busting, terrain
          // cache invalidation, empty-state refresh) — it already handles
          // all of that correctly for a local delete.
          if(typeof removeAsset === 'function') removeAsset(safe, type === 'textures' ? undefined : type);
        }
      }
      _lastAssetSig = { textures: _assetSigMap('textures'), heightmaps: _assetSigMap('heightmaps'), other: _assetSigMap('other') };
    } catch(err){
      console.error('[CollabSync] error applying incoming asset-sync:', err);
    } finally {
      applyingRemote = false;
    }
  }

  Collab.on('asset-sync', d => _applyIncomingAssetSync(d.added, d.removed));

  // ── Apply an incoming full `bodies` (+ optional `settings`) snapshot —
  // shared by 'state-sync' (on join) and 'full-sync' (any later structural
  // change: add/delete/rename/import/restore/preset/procgen/settings edit/
  // etc., whatever the source). ──
  function _applyIncomingState(newBodies, newSettings){
    console.log('[CollabSync] applying incoming state —', Object.keys(newBodies || {}).length, 'bodies:', Object.keys(newBodies || {}), newSettings ? '+ settings' : '');
    applyingRemote = true;
    try {
      bodies = JSON.parse(JSON.stringify(newBodies || {}));
      if(newSettings && typeof systemSettings !== 'undefined'){
        systemSettings = JSON.parse(JSON.stringify(newSettings));
      }
      _lastStateFp = _stateFp(); // baseline so our own poll doesn't immediately re-broadcast this right back

      if(selectedBody && !bodies[selectedBody]){
        selectedBody = null;
        if(typeof closeSidebar === 'function') closeSidebar();
      } else if(selectedBody && typeof fillSidebar === 'function'){
        fillSidebar(selectedBody); // keep an open sidebar in sync if that body still exists
      }

      const hasCenter = Object.values(bodies).some(b => b.isCenter);
      const empty = document.getElementById('empty-state');
      if(empty) empty.classList.toggle('gone', hasCenter);
      if(typeof updateStatusBar === 'function') updateStatusBar();
      if(typeof syncAddBodyBtn === 'function') syncAddBodyBtn();
      if(typeof resizeViewport === 'function') resizeViewport();
      if(typeof drawViewport === 'function') drawViewport();
    } catch(err){
      // Explicit catch (not just relying on Collab.emit()'s own try/catch)
      // so this shows up clearly, AND so `finally` below still runs even if
      // something in here throws — otherwise applyingRemote could get stuck
      // `true` forever, silently blocking all further outgoing sync.
      console.error('[CollabSync] error applying incoming state:', err);
    } finally {
      applyingRemote = false;
    }
  }

  Collab.on('state-sync', d => {
    _mergeIncomingAssets(d.assets);
    _applyIncomingState(d.bodies, d.settings);
    peerInfo = {};
    for(const [pid, info] of Object.entries(d.roster || {})) peerInfo[pid] = info;
    _setLockOwnersFromSnapshot(d.locks);
    _hideJoinLoadingScreen();
  });

  Collab.on('full-sync', d => _applyIncomingState(d.bodies, d.settings));

  // ── Structural-change detection ──
  // Rather than hooking every individual mutation site (add body, delete
  // body, rename, import zip, load featured system, restore autosave,
  // apply preset, procgen regeneration — and anything added later that
  // touches `bodies`), poll for a change in `bodies`' shape and broadcast a
  // full snapshot when one is found. Less instant than a per-site hook, but
  // it can't miss a mutation path we don't know about. ~1.2s latency on
  // structural changes is fine — unlike live-dragging edits (which use the
  // fast, lock-gated broadcastEdit path above), adding/deleting a body
  // isn't latency-sensitive.
  //
  // The currently-selected body is deliberately excluded from the
  // fingerprint: its live edits already propagate instantly via
  // broadcastEdit/remote-edit, so including it here would trigger a
  // redundant full-bodies broadcast on every drag tick — exactly the kind
  // of per-message overhead the DEBUG-flag cleanup in collab.js was meant
  // to get rid of.
  let _lastStateFp = null;
  function _stateFp(){
    // The full set of body NAMES always participates in the fingerprint —
    // that's what changes on add/delete/rename, including the common
    // "add a body, immediately select it for editing" flow, where the new
    // body IS selectedBody from the very first poll tick. Excluding it
    // entirely (as an earlier version of this did) made a brand-new body's
    // fingerprint identical to "nothing changed" and silently missed it.
    // Only the selected body's own DATA CONTENTS are excluded from the deep
    // comparison, since those already propagate via the fast per-edit
    // broadcastEdit/remote-edit channel.
    const names = Object.keys(bodies).sort();
    const bodiesPart = names.map(name => name === selectedBody ? name : name + ':' + JSON.stringify(bodies[name])).join('|');
    // systemSettings is a small plain object (no binaries) — always
    // included in full, unlike bodies' selected-body exclusion above.
    const settingsPart = typeof systemSettings !== 'undefined' ? JSON.stringify(systemSettings) : '';
    return bodiesPart + '::' + settingsPart;
  }
  function _checkStructuralChange(){
    if(!Collab.isActive() || applyingRemote) return;
    const fp = _stateFp();
    if(fp !== _lastStateFp){
      console.log('[CollabSync] structural change detected — broadcasting full-sync. bodies:', Object.keys(bodies));
      const sent = Collab.broadcastFullSync(bodies, typeof systemSettings !== 'undefined' ? systemSettings : null);
      // Only advance the baseline if the send actually went out. If it
      // didn't (e.g. hostConn not open for a moment), leave the baseline
      // stale so the NEXT poll tick sees the same diff and retries —
      // otherwise a single dropped send would permanently lose that change,
      // since a future tick would compare against a baseline we'd already
      // (wrongly) advanced past it.
      if(sent) _lastStateFp = fp;
      else console.warn('[CollabSync] full-sync send failed — will retry next poll tick');
    }
  }
  setInterval(() => { _checkStructuralChange(); _checkAssetChange(); }, 1200);
  Collab.on('hosted', () => { _lastAssetSig = { textures: _assetSigMap('textures'), heightmaps: _assetSigMap('heightmaps'), other: _assetSigMap('other') }; });
  Collab.on('hosted', () => { _lastStateFp = _stateFp(); });

  // Settings are edited via the Settings modal's save button rather than
  // live-dragged like a body's fields — trigger an immediate check on save
  // instead of waiting up to 1.2s for the next poll tick.
  if(typeof closeSysSettings === 'function'){
    const _origCloseSysSettings = closeSysSettings;
    closeSysSettings = function(){
      _origCloseSysSettings();
      _checkStructuralChange();
    };
  }

  // Host: 'locks-changed' always carries the full current snapshot, so it's
  // the single source of truth on that side.
  Collab.on('locks-changed', snapshot => _setLockOwnersFromSnapshot(snapshot));

  // Peer: only incremental updates arrive after the initial snapshot in
  // 'state-sync' above — track them ourselves.
  Collab.on('lock-ack', d => { lockOwners[d.body] = d.peerId; _refreshLockUI(); });
  Collab.on('unlock',   d => { delete lockOwners[d.body]; _refreshLockUI(); });
  Collab.on('lock-deny', d => {
    // Someone else already had it (race on simultaneous select) — reflect
    // reality instead of pretending we got the lock.
    lockOwners[d.body] = d.lockedBy;
    _refreshLockUI();
  });

  Collab.on('peer-joined', d => { peerInfo[d.peerId] = d.info || {}; });
  Collab.on('peer-left',   d => { delete peerInfo[d.peerId]; }); // any locks they held are released host-side via individual 'unlock' broadcasts already
  Collab.on('left',              () => { lockOwners = {}; peerInfo = {}; _refreshLockUI(); _hideJoinLoadingScreen(); });
  Collab.on('host-disconnected', () => { lockOwners = {}; peerInfo = {}; _refreshLockUI(); _hideJoinLoadingScreen(); });

  // ── Remote edits: apply the incoming patch. broadcastEdit() below always
  // sends the WHOLE rebuilt `data` object for a body (matching how
  // _liveSyncNow already rebuilds it wholesale each tick), so applying one
  // is a straight replace, not a deep merge. ──
  Collab.on('remote-edit', ({ body, patch }) => {
    if(!bodies[body]) return;
    applyingRemote = true;
    try {
      bodies[body].data = JSON.parse(JSON.stringify(patch));
      if(selectedBody === body && typeof fillSidebar === 'function') fillSidebar(body);
      if(typeof drawViewport === 'function') drawViewport();
    } catch(err){
      console.error('[CollabSync] error applying remote edit:', err);
    } finally {
      applyingRemote = false;
    }
  });

  // ── Hook selectBody: request the lock whenever a session is active ──
  const _origSelectBody = selectBody;
  selectBody = function(name){
    if(Collab.isActive() && selectedBody && selectedBody !== name && !Collab.isLockedByOther(selectedBody)){
      Collab.releaseLock(selectedBody);
    }
    _origSelectBody(name);
    if(Collab.isActive()){
      Collab.requestLock(name);
      _refreshLockUI();
      // Covers "add a body, immediately select it" — without this, a
      // brand-new body wouldn't reach the other side until the next 1.2s
      // poll tick, and any edits made in the meantime would be silently
      // dropped on their end since they don't have the body yet at all.
      _checkStructuralChange();
    }
  };

  // ── Hook closeSidebar: release whatever lock we're holding ──
  const _origCloseSidebar = closeSidebar;
  closeSidebar = function(){
    if(Collab.isActive() && selectedBody && !Collab.isLockedByOther(selectedBody)){
      Collab.releaseLock(selectedBody);
    }
    _origCloseSidebar();
  };

  // ── Hook _liveSyncNow: broadcast the freshly-rebuilt body data ──
  const _origLiveSyncNow = _liveSyncNow;
  _liveSyncNow = function(){
    _origLiveSyncNow();
    if(applyingRemote) return; // we're the one applying an incoming edit right now — don't echo it back
    if(!Collab.isActive() || !selectedBody) return;
    if(Collab.isLockedByOther(selectedBody)) return; // UI already blocks input here, but never trust that alone
    const b = bodies[selectedBody];
    if(!b) return;
    Collab.broadcastEdit(selectedBody, JSON.parse(JSON.stringify(b.data)));
  };

  // Re-apply the lock UI whenever the sidebar visibly opens/closes, in case
  // something outside our hooks changed selectedBody (undo, delete, etc.)
  Collab.on('hosted', _refreshLockUI);
})();
