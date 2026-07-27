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

  // ── ICE server config ──
  // PeerJS's default free broker only supplies STUN servers. STUN is enough
  // when both peers can find a direct path (simple NATs, same network), but
  // it does nothing when a direct path isn't possible (symmetric NAT,
  // restrictive firewalls, some corporate/mobile networks) — the exact
  // failure mode confirmed by the stall watchdog: iceGatheringState reaches
  // "complete" but iceConnectionState never leaves "new". A TURN relay
  // fallback fixes that by routing traffic through a relay server when a
  // direct path can't be found. These are OpenRelay's public test TURN
  // credentials (metered.ca) — fine for development; swap in your own
  // TURN provider for production use.
  const ICE_SERVERS = [
    // Free, unlimited, no auth needed:
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.l.google.com:19302' },
    // OpenRelay's public test TURN credentials — free but shared/rate-limited
    // and has been reported flaky for some users. Kept as our TURN fallback
    // for now since it needs no signup; the candidate-summary logging below
    // will tell us definitively if it's the culprit (relay: 0 in the
    // summary = this server gave us nothing usable).
    { urls: 'stun:openrelay.metered.ca:80' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
  ];

  // ── Debug tracing ──
  // Flip to true (or call Collab.setDebug(true) from the console) to get the
  // full connection-lifecycle trace used to diagnose ICE/NAT issues —
  // candidate types, signaling state transitions, per-message logs, etc.
  // Left off by default: logging on every single message (locks, edits
  // while dragging, etc.) adds real overhead and was making sync feel
  // sluggish once connections were actually working.
  let DEBUG = false;
  function dlog(...args){ if(DEBUG) console.log(...args); }
  function dwarn(...args){ if(DEBUG) console.warn(...args); }
  function setDebug(v){ DEBUG = !!v; }

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
    const subs = listeners[evt] || [];
    dlog(`[Collab] emit("${evt}") ->`, subs.length, 'listener(s)', payload);
    subs.forEach(fn => {
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
    dlog(`[Collab] on("${evt}") registered — now ${listeners[evt].length} listener(s)`);
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
      dlog('[Collab:HOST] creating Peer with id', id);
      peer = new Peer(id, { debug: 2, config: { iceServers: ICE_SERVERS } });

      peer.on('open', pid => {
        dlog('[Collab:HOST] peer.open — broker connection established, id =', pid);
        myPeerId = pid;
        roster.set(pid, { name: myName, color: myColor });
        emit('hosted', { code, peerId: pid });
        resolve({ code, peerId: pid });
      });

      peer.on('connection', conn => {
        dlog('[Collab:HOST] peer.connection fired — incoming DataConnection from', conn.peer, 'metadata:', conn.metadata, 'connectionId:', conn.connectionId);
        _hostHandleIncomingConn(conn);
      });

      peer.on('error', err => {
        console.error('[Collab:HOST] peer.error —', err.type, err.message || err);
        emit('error', { err, phase: 'host' });
        if(!myPeerId) reject(err); // failed before we ever got an id
      });

      peer.on('disconnected', () => {
        dwarn('[Collab:HOST] peer.disconnected from signaling broker');
        emit('host-disconnected');
      });

      peer.on('close', () => dwarn('[Collab:HOST] peer.close — peer object destroyed'));
    });
  }

  // Attaches low-level WebRTC diagnostics to a DataConnection as early as
  // possible — NOT gated on conn.open, since that's exactly the event that's
  // failing to fire. Also arms a watchdog that reports the stuck state if
  // the connection hasn't opened within a few seconds (classic symptom of
  // ICE candidates failing to find a path — no TURN relay configured, so a
  // restrictive NAT/firewall on either side can strand the connection here
  // forever with no error ever thrown).
  function _wireIceDiagnostics(conn, label){
    if(!DEBUG) return; // skip entirely in normal use — see DEBUG flag above
    let opened = false;
    conn.on('open', () => { opened = true; });

    const candidateTypes = { host: 0, srflx: 0, relay: 0, prflx: 0 };

    const attach = () => {
      const pc = conn.peerConnection;
      if(!pc){
        // Not created yet — PeerJS sets this up asynchronously in some
        // versions. Retry shortly rather than giving up.
        setTimeout(attach, 100);
        return;
      }
      dlog(`[Collab:${label}] peerConnection acquired for`, conn.peer, '- iceGatheringState:', pc.iceGatheringState, 'iceConnectionState:', pc.iceConnectionState, 'signalingState:', pc.signalingState);

      pc.addEventListener('icegatheringstatechange', () => {
        dlog(`[Collab:${label}] iceGatheringState ->`, pc.iceGatheringState, 'for', conn.peer);
        if(pc.iceGatheringState === 'complete'){
          // This is the definitive answer to "did TURN actually give us a
          // usable relay candidate": if candidateTypes.relay is 0 here, the
          // TURN server never handed out a relay candidate at all (auth
          // failure, server down, blocked port, etc.) — distinct from
          // "we got a relay candidate but it still didn't connect".
          dlog(`[Collab:${label}] ── candidate summary for`, conn.peer, ':', {...candidateTypes},
            candidateTypes.relay === 0 ? '⚠ NO RELAY CANDIDATES — TURN server gave us nothing usable' : '✓ relay candidate(s) obtained');
        }
      });
      pc.addEventListener('iceconnectionstatechange', () => {
        dlog(`[Collab:${label}] iceConnectionState ->`, pc.iceConnectionState, 'for', conn.peer);
      });
      pc.addEventListener('connectionstatechange', () => {
        dlog(`[Collab:${label}] connectionState ->`, pc.connectionState, 'for', conn.peer);
      });
      pc.addEventListener('signalingstatechange', () => {
        dlog(`[Collab:${label}] signalingState ->`, pc.signalingState, 'for', conn.peer);
      });
      pc.addEventListener('icecandidateerror', (e) => {
        console.error(`[Collab:${label}] icecandidateerror for`, conn.peer, '- code:', e.errorCode, 'text:', e.errorText, 'url:', e.url);
      });
      pc.addEventListener('icecandidate', (e) => {
        if(e.candidate){
          const type = e.candidate.type;
          if(type in candidateTypes) candidateTypes[type]++;
          dlog(`[Collab:${label}] local ICE candidate:`, type, e.candidate.protocol, e.candidate.address || e.candidate.candidate);
        } else {
          dlog(`[Collab:${label}] ICE candidate gathering complete for`, conn.peer);
        }
      });
    };
    attach();

    // Staged watchdog: an early check is often premature (gathering can
    // still be in flight), so we re-check at 8s and again at 20s before
    // treating it as truly dead. This also stops nagging once opened.
    [8000, 20000].forEach(delay => {
      setTimeout(() => {
        if(opened) return;
        const pc = conn.peerConnection;
        console.error(`[Collab:${label}] ⚠ STALL WATCHDOG (${delay/1000}s) — connection to`, conn.peer, 'still not open.',
          pc ? `iceConnectionState=${pc.iceConnectionState} connectionState=${pc.connectionState} signalingState=${pc.signalingState} iceGatheringState=${pc.iceGatheringState} candidates=${JSON.stringify(candidateTypes)}` : '(no peerConnection object)',
          candidateTypes.relay === 0
            ? '\nNo relay candidates were ever gathered — the TURN server itself is unreachable/rejecting auth, not just failing to connect. Check the icecandidateerror logs above for the specific server/port that failed.'
            : '\nA relay candidate WAS obtained but the connection still hasn\'t completed — this points at something other than TURN availability (e.g. the other peer never got a matching relay candidate, or the offer/answer never reached them).');
      }, delay);
    });
  }

  function _hostHandleIncomingConn(conn){
    dlog('[Collab:HOST] _hostHandleIncomingConn — wiring listeners for', conn.peer, 'already open?', conn.open);
    _wireIceDiagnostics(conn, 'HOST');

    conn.on('open', () => {
      dlog('[Collab:HOST] conn.open — DataConnection ready for', conn.peer, '(reliable:', conn.reliable, ', serialization:', conn.serialization, ')');
      hostConns.set(conn.peer, conn);
      dlog('[Collab:HOST] hostConns now:', [...hostConns.keys()]);
    });

    conn.on('data', msg => {
      if(DEBUG) dlog('[Collab:HOST] conn.data <- raw message from', conn.peer, ':', JSON.stringify(msg));
      _hostOnMessage(conn, msg);
    });

    conn.on('close', () => {
      dwarn('[Collab:HOST] conn.close for', conn.peer);
      _hostDropPeer(conn.peer);
    });
    conn.on('error', (err) => {
      console.error('[Collab:HOST] conn.error for', conn.peer, ':', err);
      _hostDropPeer(conn.peer);
    });
  }

  function _hostDropPeer(peerId){
    if(!roster.has(peerId) && !hostConns.has(peerId)) return; // already dropped (e.g. 'bye' beat the transport close event)
    dwarn('[Collab:HOST] _hostDropPeer —', peerId, '(was in hostConns?', hostConns.has(peerId), ')');
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
    if(DEBUG) dlog('[Collab:HOST] _hostBroadcast', msg.type, 'excluding:', excludePeerId, 'to conns:', [...hostConns.keys()]);
    for(const [pid, conn] of hostConns){
      if(pid === excludePeerId) continue;
      if(conn.open){
        conn.send(msg);
      } else {
        dwarn('[Collab:HOST] skipped broadcast to', pid, '— conn.open is false');
      }
    }
    // Host applies to its own local state too, since the host is also a
    // participant — callers listening for these events don't need to know
    // whether they're the host or a peer.
    if(excludePeerId !== myPeerId) emit('message', msg);
  }

  function _hostSendTo(peerId, msg){
    const conn = hostConns.get(peerId);
    if(!conn){
      console.error('[Collab:HOST] _hostSendTo(', peerId, ') — NO CONNECTION FOUND in hostConns. Current keys:', [...hostConns.keys()]);
      return;
    }
    if(!conn.open){
      console.error('[Collab:HOST] _hostSendTo(', peerId, ') — connection exists but conn.open is FALSE. Message dropped:', msg.type);
      return;
    }
    dlog('[Collab:HOST] _hostSendTo(', peerId, ') sending', msg.type);
    conn.send(msg);
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
    dlog('[Collab:HOST] _hostOnMessage — type:', msg.type, 'from:', fromId);
    switch(msg.type){
      case 'hello': {
        dlog('[Collab:HOST] hello from', fromId, '- name:', msg.name, 'color:', msg.color);
        // New peer introducing itself with a display name/color choice.
        roster.set(fromId, { name: msg.name || 'Peer', color: msg.color || nextColor() });
        dlog('[Collab:HOST] roster updated:', _rosterSnapshot());
        // Send the newcomer a full snapshot so they converge on ground truth.
        const syncMsg = {
          type: 'state-sync',
          bodies: stateProvider ? stateProvider() : {},
          locks: _locksSnapshot(),
          roster: _rosterSnapshot(),
          you: fromId
        };
        dlog('[Collab:HOST] sending state-sync to', fromId, '- stateProvider set?', !!stateProvider, 'bodies keys:', stateProvider ? Object.keys(syncMsg.bodies || {}).length : 'n/a');
        _hostSendTo(fromId, syncMsg);
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

      case 'bye': {
        // Explicit graceful-leave notice — handle immediately rather than
        // waiting on the (slow/unreliable) transport-level conn.close event.
        _hostDropPeer(fromId);
        break;
      }

      case 'full-sync': {
        // A peer's whole `bodies` shape changed (add/delete/rename/import/
        // etc.) — relay to everyone else, and emit locally too so the
        // host's own app-level state gets updated the same way a peer's
        // would (collab.js has no idea what `bodies` even is; the actual
        // apply happens in the app-level listener for this event).
        _hostBroadcast({ type: 'full-sync', bodies: msg.bodies, peerId: fromId }, fromId);
        emit('full-sync', { bodies: msg.bodies, peerId: fromId });
        break;
      }

      default:
        dwarn('[Collab:HOST] unrecognized message type from', fromId, ':', msg.type, msg);
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
      dlog('[Collab:PEER] joinSession — code:', code, '-> resolved hostId:', hostId);
      peer = new Peer({ debug: 2, config: { iceServers: ICE_SERVERS } });

      peer.on('open', pid => {
        dlog('[Collab:PEER] peer.open — my broker id is', pid, '- now connecting to host', hostId);
        myPeerId = pid;
        hostConn = peer.connect(hostId, { reliable: true });
        dlog('[Collab:PEER] peer.connect() called, connectionId:', hostConn.connectionId, 'initial open?', hostConn.open);
        _wireIceDiagnostics(hostConn, 'PEER');

        hostConn.on('open', () => {
          dlog('[Collab:PEER] hostConn.open — DataConnection to host is ready. Sending hello.');
          hostConn.send({ type: 'hello', name: myName, color: myColor });
          dlog('[Collab:PEER] hello sent:', { type: 'hello', name: myName, color: myColor });
        });

        hostConn.on('data', msg => {
          if(DEBUG) dlog('[Collab:PEER] hostConn.data <- raw message from host:', JSON.stringify(msg));
          _peerOnMessage(msg, resolve);
        });

        hostConn.on('close', () => {
          dwarn('[Collab:PEER] hostConn.close — connection to host closed');
          emit('host-disconnected');
        });
        hostConn.on('error', err => {
          console.error('[Collab:PEER] hostConn.error —', err);
          emit('error', { err, phase: 'join' });
          reject(err);
        });
      });

      peer.on('error', err => {
        console.error('[Collab:PEER] peer.error —', err.type, err.message || err);
        emit('error', { err, phase: 'join' });
        reject(err);
      });

      peer.on('disconnected', () => dwarn('[Collab:PEER] peer.disconnected from signaling broker'));
      peer.on('close', () => dwarn('[Collab:PEER] peer.close — peer object destroyed'));
    });
  }

  function _peerOnMessage(msg, joinResolve){
    dlog('[Collab:PEER] _peerOnMessage — type:', msg.type);
    switch(msg.type){
      case 'state-sync':
        dlog('[Collab:PEER] state-sync received — resolving joinSession promise. bodies keys:', Object.keys(msg.bodies || {}).length, 'roster:', msg.roster);
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
      case 'full-sync':
        emit('full-sync', { bodies: msg.bodies, peerId: msg.peerId });
        break;
      default:
        dwarn('[Collab:PEER] unrecognized message type from host:', msg.type, msg);
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

  // Broadcast a whole-`bodies` snapshot — used for structural changes (a
  // body added/deleted/renamed, a system imported/restored/preset applied,
  // etc.) rather than a single body's data, which broadcastEdit already
  // handles at much lower overhead. Not lock-gated: unlike per-body edits,
  // structural changes aren't tied to holding a specific body's lock.
  function broadcastFullSync(bodiesSnapshot){
    if(!peer) return;
    const payload = JSON.parse(JSON.stringify(bodiesSnapshot));
    if(isHost){
      _hostBroadcast({ type: 'full-sync', bodies: payload, peerId: myPeerId });
    } else if(hostConn && hostConn.open){
      hostConn.send({ type: 'full-sync', bodies: payload, peerId: myPeerId });
    }
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
    const peerRef = peer; // capture before we null out the outer `peer` below
    try {
      if(isHost){
        _hostBroadcast({ type: 'peer-leave', peerId: myPeerId });
        for(const conn of hostConns.values()) conn.close();
        hostConns.clear();
        locks.clear();
        roster.clear();
        peerRef.destroy();
      } else if(hostConn){
        // Tell the host explicitly rather than relying on the transport-level
        // 'close' event alone — that event is slow/unreliable (especially
        // relayed through TURN) and can get cut off entirely if we destroy()
        // the peer before the close frame finishes sending. A small delay
        // gives the reliable data channel a chance to actually flush 'bye'
        // before we tear the connection down.
        if(hostConn.open) hostConn.send({ type: 'bye', peerId: myPeerId });
        hostConn.close();
        setTimeout(() => { try { peerRef.destroy(); } catch(e){} }, 150);
      } else {
        peerRef.destroy();
      }
    } catch(err){ dwarn('[Collab] error during leave:', err); }
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

  // Best-effort notice on abrupt tab close (browser back button, closing
  // the tab, navigating away) — the person never clicked "Leave Session" so
  // leaveSession()'s explicit messages never ran. 'pagehide' fires more
  // reliably than 'beforeunload' for this (including on mobile Safari).
  // Not guaranteed to arrive — the page may already be torn down before the
  // send completes — but costs nothing to try, and the transport-level
  // close/error handlers remain as the fallback either way.
  window.addEventListener('pagehide', () => {
    if(!peer) return;
    try {
      if(isHost){
        _hostBroadcast({ type: 'peer-leave', peerId: myPeerId });
      } else if(hostConn && hostConn.open){
        hostConn.send({ type: 'bye', peerId: myPeerId });
      }
    } catch(e){ /* page is already unloading — nothing more we can do */ }
  });

  return {
    on, off,
    hostSession, joinSession, leaveSession,
    requestLock, releaseLock, isLockedByOther,
    broadcastEdit, broadcastFullSync, sendChat,
    setStateProvider,
    getMyInfo, isActive,
    setDebug
  };
})();
