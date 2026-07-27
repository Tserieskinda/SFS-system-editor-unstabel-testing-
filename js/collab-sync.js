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
// Scope: full-system sync on join, live property-edit sync + per-body
// lock indicators for whichever body is selected, AND structural sync
// (bodies added/deleted/renamed/imported/restored/regenerated/etc.) via a
// polling-based change detector rather than hooking each mutation site
// individually — see the "Structural-change detection" section below for
// why. Not covered: real conflict resolution for two people making
// structural changes at the same instant (last-write-wins, same as most
// casual P2P collab tools) — acceptable for now, flagged as a known
// simplification rather than an oversight.
(function(){
  if(typeof Collab === 'undefined') return;

  let lockOwners = {};        // body name -> peerId currently editing it
  let peerInfo   = {};        // peerId -> {name, color}
  let applyingRemote = false; // true while we're applying an incoming state-sync/edit, so our own hooks don't re-broadcast it

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

  // ── Apply an incoming full `bodies` snapshot — shared by 'state-sync'
  // (on join) and 'full-sync' (any later structural change: add/delete/
  // rename/import/restore/preset/procgen/etc., whatever the source). ──
  function _applyIncomingBodies(newBodies){
    console.log('[CollabSync] applying incoming bodies —', Object.keys(newBodies || {}).length, 'bodies:', Object.keys(newBodies || {}));
    applyingRemote = true;
    try {
      bodies = JSON.parse(JSON.stringify(newBodies || {}));
      _lastBodiesFp = _bodiesFp(); // baseline so our own poll doesn't immediately re-broadcast this right back

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
      console.error('[CollabSync] error applying incoming bodies:', err);
    } finally {
      applyingRemote = false;
    }
  }

  Collab.on('state-sync', d => {
    _applyIncomingBodies(d.bodies);
    peerInfo = {};
    for(const [pid, info] of Object.entries(d.roster || {})) peerInfo[pid] = info;
    _setLockOwnersFromSnapshot(d.locks);
  });

  Collab.on('full-sync', d => _applyIncomingBodies(d.bodies));

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
  let _lastBodiesFp = null;
  function _bodiesFp(){
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
    return names.map(name => name === selectedBody ? name : name + ':' + JSON.stringify(bodies[name])).join('|');
  }
  function _checkStructuralChange(){
    if(!Collab.isActive() || applyingRemote) return;
    const fp = _bodiesFp();
    if(fp !== _lastBodiesFp){
      console.log('[CollabSync] structural change detected — broadcasting full-sync. bodies:', Object.keys(bodies));
      _lastBodiesFp = fp;
      Collab.broadcastFullSync(bodies);
    }
  }
  setInterval(_checkStructuralChange, 1200);
  Collab.on('hosted', () => { _lastBodiesFp = _bodiesFp(); });

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
  Collab.on('left',              () => { lockOwners = {}; peerInfo = {}; _refreshLockUI(); });
  Collab.on('host-disconnected', () => { lockOwners = {}; peerInfo = {}; _refreshLockUI(); });

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
