// ══════════════════════════ MULTIPLAYER MODAL (MP) ══════════════════════════
// Thin UI layer over Collab (js/collab.js) — the real host/join modal reached
// from the main menu's "🌐 MULTIPLAYER" button. Keeps all Collab wiring in
// one place so future sidebar.js/viewport.js integration (lock badges, live
// edits) can hook into Collab directly without needing to know about this
// modal's DOM.

const MP = (() => {
  let activeTab = 'host';
  let wired = false;

  function openModal(){
    _wireEventsOnce();
    document.getElementById('modal-multiplayer').classList.add('open');
    _syncModalToState();
  }

  function closeModal(){
    document.getElementById('modal-multiplayer').classList.remove('open');
  }

  function switchTab(tab){
    activeTab = tab;
    const hostBtn = document.getElementById('mp-tab-host');
    const joinBtn = document.getElementById('mp-tab-join');
    const hostContent = document.getElementById('mp-host-content');
    const joinContent = document.getElementById('mp-join-content');

    const activeStyle = { background: 'var(--ac13)', border: '1px solid var(--ac28)', borderBottom: 'none', color: 'var(--sky2)' };
    const inactiveStyle = { background: 'transparent', border: '1px solid transparent', borderBottom: 'none', color: 'var(--ink4)' };

    Object.assign(hostBtn.style, tab === 'host' ? activeStyle : inactiveStyle);
    Object.assign(joinBtn.style, tab === 'join' ? activeStyle : inactiveStyle);
    hostContent.style.display = tab === 'host' ? '' : 'none';
    joinContent.style.display = tab === 'join' ? '' : 'none';
  }

  function _getName(){
    const v = (document.getElementById('mp-name')?.value || '').trim();
    return v || 'Player';
  }

  // ── Hosting ──
  function startHost(){
    if(Collab.isActive()){
      alert('Already in a session — leave it first.');
      return;
    }
    Collab.setStateProvider(() => (typeof bodies !== 'undefined' ? bodies : {}));
    const btn = event?.target?.closest?.('button');
    if(btn){ btn.disabled = true; btn.textContent = 'Starting…'; }

    Collab.hostSession(_getName()).then(({ code }) => {
      document.getElementById('mp-host-idle').style.display = 'none';
      document.getElementById('mp-host-active').style.display = '';
      document.getElementById('mp-code-display').textContent = code;
      _renderPeerList();
    }).catch(err => {
      alert('Could not start hosting: ' + (err?.message || err));
      if(btn){ btn.disabled = false; btn.innerHTML = '<span class="mico">▶</span>START HOSTING'; }
    });
  }

  function copyCode(){
    const code = document.getElementById('mp-code-display')?.textContent?.trim();
    if(!code || code.startsWith('—')) return;
    const btn = document.getElementById('mp-copy-btn');
    const done = ok => { if(btn){ const prev = btn.textContent; btn.textContent = ok ? '✓ COPIED' : '⚠ COPY FAILED'; setTimeout(() => btn.textContent = prev, 1400); } };
    if(navigator.clipboard?.writeText){
      navigator.clipboard.writeText(code).then(() => done(true)).catch(() => done(false));
    } else {
      // Fallback for older/locked-down mobile browsers without Clipboard API
      try {
        const ta = document.createElement('textarea');
        ta.value = code; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.focus(); ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        done(true);
      } catch(e){ done(false); }
    }
  }

  // ── Joining ──
  function startJoin(){
    if(Collab.isActive()){
      alert('Already in a session — leave it first.');
      return;
    }
    const codeInput = document.getElementById('mp-code-input');
    const code = (codeInput.value || '').trim().toUpperCase();
    const errEl = document.getElementById('mp-join-error');
    errEl.style.display = 'none';

    if(code.length < 5){
      errEl.textContent = 'Enter the 5-character code.';
      errEl.style.display = '';
      return;
    }

    const btn = event?.target?.closest?.('button');
    if(btn){ btn.disabled = true; btn.textContent = 'Connecting…'; }

    Collab.joinSession(code, _getName()).then(() => {
      document.getElementById('mp-join-idle').style.display = 'none';
      document.getElementById('mp-join-active').style.display = '';
      _renderPeerList();
    }).catch(err => {
      errEl.textContent = 'Could not connect — check the code and try again.';
      errEl.style.display = '';
      if(btn){ btn.disabled = false; btn.innerHTML = '<span class="mico">▶</span>JOIN SESSION'; }
    });
  }

  function leave(){
    Collab.leaveSession();
    _resetModalToIdle();
  }

  function _resetModalToIdle(){
    document.getElementById('mp-host-idle').style.display = '';
    document.getElementById('mp-host-active').style.display = 'none';
    document.getElementById('mp-join-idle').style.display = '';
    document.getElementById('mp-join-active').style.display = 'none';
    document.getElementById('mp-code-display').textContent = '— — — — —';
    document.getElementById('mp-code-input').value = '';
    document.getElementById('mp-join-error').style.display = 'none';
    const hostStartBtn = document.querySelector('#mp-host-idle button');
    if(hostStartBtn){ hostStartBtn.disabled = false; hostStartBtn.innerHTML = '<span class="mico">▶</span>START HOSTING'; }
    const joinBtn = document.querySelector('#mp-join-idle button');
    if(joinBtn){ joinBtn.disabled = false; joinBtn.innerHTML = '<span class="mico">▶</span>JOIN SESSION'; }
  }

  // If the modal is (re)opened while already in a session (e.g. user closed
  // and reopened it), reflect the current state instead of showing "idle".
  function _syncModalToState(){
    if(!Collab.isActive()){
      _resetModalToIdle();
      switchTab('host');
      return;
    }
    const info = Collab.getMyInfo();
    if(info.isHost){
      switchTab('host');
      document.getElementById('mp-host-idle').style.display = 'none';
      document.getElementById('mp-host-active').style.display = '';
    } else {
      switchTab('join');
      document.getElementById('mp-join-idle').style.display = 'none';
      document.getElementById('mp-join-active').style.display = '';
    }
    _renderPeerList();
  }

  // ── Peer list rendering (shared roster mirror, fed by Collab events) ──
  let roster = {}; // peerId -> {name, color}

  function _peerChipHtml(pid, info){
    const isMe = pid === Collab.getMyInfo().peerId;
    return `<div class="mp-peer-chip"><span class="mp-peer-dot" style="background:${info.color || '#888'}"></span>${_esc(info.name || 'Peer')}${isMe ? '<span class="mp-peer-you">(you)</span>' : ''}</div>`;
  }
  function _esc(s){ return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

  function _renderPeerList(){
    const html = Object.keys(roster).length
      ? Object.entries(roster).map(([pid, info]) => _peerChipHtml(pid, info)).join('')
      : `<div style="font-size:.62rem;color:var(--ink4);text-align:center;padding:8px 0">Waiting for others to join…</div>`;
    const hostEl = document.getElementById('mp-peer-list');
    const joinEl = document.getElementById('mp-peer-list-join');
    if(hostEl) hostEl.innerHTML = html;
    if(joinEl) joinEl.innerHTML = html;
  }

  function _wireEventsOnce(){
    if(wired) return;
    wired = true;

    Collab.on('state-sync', d => {
      roster = d.roster || {};
      // Make sure "you" appear in the list even before any peer-join echo.
      const me = Collab.getMyInfo();
      if(me.peerId && !roster[me.peerId]) roster[me.peerId] = { name: me.name, color: me.color };
      _renderPeerList();
    });
    Collab.on('hosted', () => {
      const me = Collab.getMyInfo();
      roster = { [me.peerId]: { name: me.name, color: me.color } };
      _renderPeerList();
    });
    Collab.on('peer-joined', d => {
      roster[d.peerId] = d.info || { name: 'Peer' };
      _renderPeerList();
    });
    Collab.on('peer-left', d => {
      delete roster[d.peerId];
      _renderPeerList();
    });
    Collab.on('host-disconnected', () => {
      alert('Lost connection to the host.');
      roster = {};
      _resetModalToIdle();
    });
    Collab.on('left', () => {
      roster = {};
    });
  }

  return { openModal, closeModal, switchTab, startHost, startJoin, leave, copyCode };
})();
