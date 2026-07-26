// ════════════════════════════════ COLLAB (multiplayer) ════════════════════════════════
// Serverless live-collaboration layer built on PeerJS (WebRTC). No app-specific
// server is required — PeerJS's public broker is only used for the initial
// handshake; all planet data flows directly browser-to-browser after that.
//
// Topology: star, host-authoritative.
//   - One user "hosts" a session (becomes the PeerJS peer everyone else connects to).
//   - Every other user "joins" via the host's short code.
//   - The HOST is the arbiter for selection locks (see "Locking" below) and relays
//     edit patches between peers. The host is also a normal editor — no special
//     "server mode" UI, it's the same app with this module active.
//
// This file is intentionally self-contained: it does not touch `bodies`,
// `sidebar.js`, or `viewport.js` directly. It exposes a small public API
// (`Collab.*`) plus a set of event hooks (`Collab.on(...)`) that the rest of
// the app wires up later. This lets the networking layer be tested in
// isolation before it's connected to the editor's UI.
//
// ── Locking model (optimistic, host-arbitrated) ──
//   1. Peer clicks a body -> immediately treats it as locked locally (0 latency)
//      and sends {type:'select'} to the host.
//   2. Host is the source of truth for `locks` (bodyName -> {peerId, ts}).
//      - Free (or already locked by the same peer) -> host grants: broadcasts
//        {type:'lock-ack'} to everyone, including the sender, so all clients
//        converge on the same ground truth.
//      - Already locked by someone else -> host sends {type:'lock-deny'} back
//        to the requester only; that peer rolls back its optimistic lock.
//   3. Race case (two selects arrive close together): host processes messages
//      in arrival order, so the first one simply wins — no CRDT/vector-clock
//      machinery needed, just "first message the host sees, wins."
//   4. Idle safety net: locks older than LOCK_IDLE_MS with no refresh are
//      force-released by the host, in case a peer's tab dies mid-edit.
//
// ── Edit propagation ──
//   Edits are small dot-path patches (e.g. {'ORBIT_DATA.semiMajorAxis': 1.2e9}),
//   not whole-body payloads. The editing peer throttles broadcasts while
//   dragging (~120ms) and always sends one final unthrottled patch on
//   release, so nobody ends up looking at a stale in-between value. The host
//   relays patches verbatim to all other peers -- only the current lock
//   owner is allowed to send patches for a body, so there is no concurrent-
//   writer conflict to resolve; simple apply-in-arrival-order is safe.

const Collab = (() => {

  const LOCK_IDLE_MS = 60000;       // auto-release a lock after this long w/ no refresh
  const EDIT_THROTTLE_MS = 120;     // min gap between broadcast patches for the same body

  // ── Internal state ──
  let peer = null;                  // PeerJS Peer instance
  let isHost = false;
  let myPeerId = null;
  let myName = null;
  let myColor = null;

  // Host-only:
  const hostConns = new Map();      // peerId -> DataConnection (host's view of all peers)
  const locks = new Map();          // bodyName -> { peerId, ts }
  const roster = new Map();         // peerId -> { name, color }

  // Peer(non-host)-only:
  let hostConn = null;              // DataConnection to the host
  const peerLockMirror = new Map(); // bodyName -> peerId — peers' local view of host's `locks`

  // Shared:
  const listeners = {};             // eventName -> [fn, ...]
  const editThrottles = new Map();  // bodyName -> { timer, pending }
  let stateProvider = null;         // () => bodies, set by the wiring layer (host only)

  function emit(evt, payload){
    (listeners[evt] || []).forEach(fn => {
      try { fn(payload); } catch(err){ console.error(`[Collab] listener error for "${evt}":`, err); }
    });
  }

  // The wiring layer calls this once so the host can hand out full-state
  // snapshots to newly-joined peers without collab.js needing to import or
  // know about `bodies` directly.
  function setStateProvider(fn){
    stateProvider = fn;
  }

  function on(evt, fn){
    (listeners[evt] = listeners[evt] || []).push(fn);
  }

  function off(evt, fn){
    if(!listeners[evt]) return;
    listeners[evt] = listeners[evt].filter(f => f !== fn);
  }

  // ── Small deterministic peer color palette (avoids everyone being the same hue) ──
  const PALETTE = ['#4fc3f7', '#ff8a65', '#aed581', '#ba68c8', '#ffd54f', '#4db6ac', '#f06292', '#90a4ae'];
  let _paletteIdx = 0;
  function nextColor(){
    const c = PALETTE[_paletteIdx % PALETTE.length];
    _paletteIdx++;
    return c;
  }

  // Short human-friendly session codes instead of raw PeerJS UUIDs.
  // PeerJS ids must be alphanumeric-safe; we prefix so collisions with other
  // apps sharing the public broker are astronomically unlikely.
  function makeSessionCode(){
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O/1/I
    let s = '';
    for(let i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }

  function peerIdFromCode(code){
    return `sfs-editor-${code.trim().toUpperCase()}`;
  }

  // ═══════════════════════════ HOST ═══════════════════════════

  function hostSession(name){
    return new Promise((resolve, reject) => {
      if(peer){ reject(new Error('Already in a session — leave first.')); return; }
      myName = name || 'Host';
      myColor = nextColor();
      isHost = true;

      const code = makeSessionCode();
      const id = peerIdFromCode(code);
      peer = new Peer(id, { debug: 1 });

      peer.on('open', pid => {
        myPeerId = pid;
        roster.set(pid, { name: myName, color: myColor });
        emit('hosted', { code, peerId: pid });
        resolve({ code, peerId: pid });
      });

      peer.on('connection', conn => _hostHandleIncomingConn(conn));

      peer.on('error', err => {
        emit('error', { err, phase: 'host' });
        if(!myPeerId) reject(err); // failed before we ever got an id
      });

      peer.on('disconnected', () => emit('host-disconnected'));
    });
  }

  function _hostHandleIncomingConn(conn){
    conn.on('open', () => {
      hostConns.set(conn.peer, conn);
    });

    conn.on('data', msg => _hostOnMessage(conn, msg));

    conn.on('close', () => _hostDropPeer(conn.peer));
    conn.on('error', () => _hostDropPeer(conn.peer));
  }

  function _hostDropPeer(peerId){
    hostConns.delete(peerId);
    roster.delete(peerId);
    // Release any locks that peer held
    let releasedAny = false;
    for(const [body, lock] of locks){
      if(lock.peerId === peerId){
        locks.delete(body);
        releasedAny = true;
        _hostBroadcast({ type: 'unlock', body });
      }
    }
    _hostBroadcast({ type: 'peer-leave', peerId });
    emit('peer-left', { peerId });
    if(releasedAny) emit('locks-changed', _locksSnapshot());
  }

  function _hostBroadcast(msg, excludePeerId){
    for(const [pid, conn] of hostConns){
      if(pid === excludePeerId) continue;
      if(conn.open) conn.send(msg);
    }
    // Host applies to its own local state too, since the host is also a
    // participant — callers listening for these events don't need to know
    // whether they're the host or a peer.
    if(excludePeerId !== myPeerId) emit('message', msg);
  }

  function _hostSendTo(peerId, msg){
    const conn = hostConns.get(peerId);
    if(conn && conn.open) conn.send(msg);
  }

  function _locksSnapshot(){
    const out = {};
    for(const [body, lock] of locks) out[body] = { peerId: lock.peerId, ts: lock.ts };
    return out;
  }

  function _rosterSnapshot(){
    const out = {};
    for(const [pid, info] of roster) out[pid] = info;
    return out;
  }

  function _hostOnMessage(conn, msg){
    const fromId = conn.peer;
    switch(msg.type){
      case 'hello': {
        // New peer introducing itself with a display name/color choice.
        roster.set(fromId, { name: msg.name || 'Peer', color: msg.color || nextColor() });
        // Send the newcomer a full snapshot so they converge on ground truth.
        _hostSendTo(fromId, {
          type: 'state-sync',
          bodies: stateProvider ? stateProvider() : {},
          locks: _locksSnapshot(),
          roster: _rosterSnapshot(),
          you: fromId
        });
        _hostBroadcast({ type: 'peer-join', peerId: fromId, info: roster.get(fromId) }, fromId);
        emit('peer-joined', { peerId: fromId, info: roster.get(fromId) });
        break;
      }

      case 'select': {
        const existing = locks.get(msg.body);
        if(!existing || existing.peerId === fromId){
          locks.set(msg.body, { peerId: fromId, ts: Date.now() });
          _hostBroadcast({ type: 'lock-ack', body: msg.body, peerId: fromId });
          emit('locks-changed', _locksSnapshot());
        } else {
          _hostSendTo(fromId, { type: 'lock-deny', body: msg.body, lockedBy: existing.peerId });
        }
        break;
      }

      case 'deselect': {
        const existing = locks.get(msg.body);
        if(existing && existing.peerId === fromId){
          locks.delete(msg.body);
          _hostBroadcast({ type: 'unlock', body: msg.body });
          emit('locks-changed', _locksSnapshot());
        }
        break;
      }

      case 'edit': {
        const existing = locks.get(msg.body);
        // Only the current lock owner's edits are relayed — silently drop
        // anything else (e.g. a stale in-flight patch after a lock changed
        // hands) rather than letting it corrupt shared state.
        if(existing && existing.peerId === fromId){
          existing.ts = Date.now(); // edits refresh the idle timer
          _hostBroadcast({ type: 'edit', body: msg.body, patch: msg.patch, peerId: fromId }, fromId);
          emit('remote-edit', { body: msg.body, patch: msg.patch, peerId: fromId });
        }
        break;
      }

      case 'chat': {
        _hostBroadcast({ type: 'chat', peerId: fromId, text: msg.text, ts: Date.now() }, fromId);
        emit('chat', { peerId: fromId, text: msg.text });
        break;
      }
    }
  }

  // Periodic idle-lock sweep (host only)
  let _idleSweepTimer = null;
  function _startIdleSweep(){
    if(_idleSweepTimer) return;
    _idleSweepTimer = setInterval(() => {
      if(!isHost) return;
      const now = Date.now();
      let changed = false;
      for(const [body, lock] of locks){
        if(now - lock.ts > LOCK_IDLE_MS){
          locks.delete(body);
          _hostBroadcast({ type: 'unlock', body });
          changed = true;
        }
      }
      if(changed) emit('locks-changed', _locksSnapshot());
    }, 10000);
  }

  // ═══════════════════════════ PEER (joining) ═══════════════════════════

  function joinSession(code, name){
    return new Promise((resolve, reject) => {
      if(peer){ reject(new Error('Already in a session — leave first.')); return; }
      myName = name || 'Peer';
      myColor = nextColor();
      isHost = false;

      const hostId = peerIdFromCode(code);
      peer = new Peer({ debug: 1 });

      peer.on('open', pid => {
        myPeerId = pid;
        hostConn = peer.connect(hostId, { reliable: true });

        hostConn.on('open', () => {
          hostConn.send({ type: 'hello', name: myName, color: myColor });
        });

        hostConn.on('data', msg => _peerOnMessage(msg, resolve));

        hostConn.on('close', () => emit('host-disconnected'));
        hostConn.on('error', err => {
          emit('error', { err, phase: 'join' });
          reject(err);
        });
      });

      peer.on('error', err => {
        emit('error', { err, phase: 'join' });
        reject(err);
      });
    });
  }

  function _peerOnMessage(msg, joinResolve){
    switch(msg.type){
      case 'state-sync':
        peerLockMirror.clear();
        for(const [body, lock] of Object.entries(msg.locks || {})) peerLockMirror.set(body, lock.peerId);
        emit('state-sync', { bodies: msg.bodies, locks: msg.locks, roster: msg.roster });
        if(joinResolve){ joinResolve({ peerId: myPeerId }); joinResolve = null; }
        break;
      case 'lock-ack':
        peerLockMirror.set(msg.body, msg.peerId);
        emit('lock-ack', { body: msg.body, peerId: msg.peerId, mine: msg.peerId === myPeerId });
        break;
      case 'lock-deny':
        emit('lock-deny', { body: msg.body, lockedBy: msg.lockedBy });
        break;
      case 'unlock':
        peerLockMirror.delete(msg.body);
        emit('unlock', { body: msg.body });
        break;
      case 'edit':
        emit('remote-edit', { body: msg.body, patch: msg.patch, peerId: msg.peerId });
        break;
      case 'peer-join':
        emit('peer-joined', { peerId: msg.peerId, info: msg.info });
        break;
      case 'peer-leave':
        emit('peer-left', { peerId: msg.peerId });
        break;
      case 'chat':
        emit('chat', { peerId: msg.peerId, text: msg.text });
        break;
    }
  }

  // ═══════════════════════════ SHARED PUBLIC API ═══════════════════════════

  // Ask to select/lock a body. Fires 'lock-ack' or 'lock-deny' asynchronously
  // (locally on the host, over the wire for peers). Caller should apply the
  // optimistic local lock itself *before* calling this, per the design.
  function requestLock(body){
    if(!peer) return;
    if(isHost){
      _hostOnMessage({ peer: myPeerId }, { type: 'select', body });
    } else if(hostConn && hostConn.open){
      hostConn.send({ type: 'select', body, peerId: myPeerId, ts: Date.now() });
    }
  }

  function releaseLock(body){
    if(!peer) return;
    if(isHost){
      _hostOnMessage({ peer: myPeerId }, { type: 'deselect', body });
    } else if(hostConn && hostConn.open){
      hostConn.send({ type: 'deselect', body, peerId: myPeerId });
    }
  }

  function isLockedByOther(body){
    if(isHost){
      const l = locks.get(body);
      return !!(l && l.peerId !== myPeerId);
    }
    const heldBy = peerLockMirror.get(body);
    return !!(heldBy && heldBy !== myPeerId);
  }

  // Broadcast an edit patch for a body the caller currently holds the lock
  // on. Throttled per-body; pass immediate:true for the final send on
  // mouseup/blur so the last value is never dropped by the throttle window.
  function broadcastEdit(body, patch, immediate){
    if(!peer) return;

    const send = p => {
      if(isHost){
        _hostOnMessage({ peer: myPeerId }, { type: 'edit', body, patch: p });
      } else if(hostConn && hostConn.open){
        hostConn.send({ type: 'edit', body, patch: p, peerId: myPeerId, ts: Date.now() });
      }
    };

    const existing = editThrottles.get(body);

    if(immediate){
      // Final send on release: cancel any pending trailing send and fire now
      // with the freshest patch we have, so the last value always lands.
      if(existing) { clearTimeout(existing.timer); editThrottles.delete(body); }
      send(patch);
      return;
    }

    if(existing){
      // Already mid-throttle-window for this body — just remember the
      // latest patch; the trailing timer will send it when it fires.
      existing.pending = patch;
      return;
    }

    // Leading edge: send immediately, then hold the window open so any
    // further calls during it get coalesced into a single trailing send.
    send(patch);
    editThrottles.set(body, {
      pending: null,
      timer: setTimeout(() => {
        const t = editThrottles.get(body);
        editThrottles.delete(body);
        if(t && t.pending) send(t.pending);
      }, EDIT_THROTTLE_MS)
    });
  }

  function sendChat(text){
    if(!peer) return;
    if(isHost){
      _hostBroadcast({ type: 'chat', peerId: myPeerId, text, ts: Date.now() });
      emit('chat', { peerId: myPeerId, text });
    } else if(hostConn && hostConn.open){
      hostConn.send({ type: 'chat', text });
    }
  }

  function leaveSession(){
    if(!peer) return;
    try {
      if(isHost){
        _hostBroadcast({ type: 'peer-leave', peerId: myPeerId });
        for(const conn of hostConns.values()) conn.close();
        hostConns.clear();
        locks.clear();
        roster.clear();
      } else if(hostConn){
        hostConn.close();
      }
      peer.destroy();
    } catch(err){ console.warn('[Collab] error during leave:', err); }
    peer = null;
    isHost = false;
    hostConn = null;
    myPeerId = null;
    peerLockMirror.clear();
    if(_idleSweepTimer){ clearInterval(_idleSweepTimer); _idleSweepTimer = null; }
    emit('left');
  }

  function getMyInfo(){
    return { peerId: myPeerId, name: myName, color: myColor, isHost };
  }

  function isActive(){
    return !!peer;
  }

  _startIdleSweep();

  return {
    on, off,
    hostSession, joinSession, leaveSession,
    requestLock, releaseLock, isLockedByOther,
    broadcastEdit, sendChat,
    setStateProvider,
    getMyInfo, isActive
  };
})();
