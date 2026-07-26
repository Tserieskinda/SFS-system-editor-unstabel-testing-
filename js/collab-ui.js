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
      _showChatWidget();
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
      _showChatWidget();
    }).catch(err => {
      errEl.textContent = 'Could not connect — check the code and try again.';
      errEl.style.display = '';
      if(btn){ btn.disabled = false; btn.innerHTML = '<span class="mico">▶</span>JOIN SESSION'; }
    });
  }

  function leave(){
    Collab.leaveSession();
    _resetModalToIdle();
    _hideChatWidget();
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

  // ── Floating chat widget ──
  // Lives outside the modal (bottom-right, mirrors CollabDebug's bottom-left
  // bubble pattern) since chat needs to stay usable while the person is
  // actually editing the system, not just while the Multiplayer modal is open.
  let chatBubbleEl = null, chatPanelEl = null, chatListEl = null, chatInputEl = null;
  let chatOpen = false;
  let chatMessages = []; // {peerId?, name, color, text, system?}
  let unread = 0;

  function _ensureChatDom(){
    if(chatBubbleEl) return;

    const style = document.createElement('style');
    style.textContent = `
      #mpc-bubble {
        position: fixed; bottom: 12px; right: 12px; z-index: 99998;
        width: 44px; height: 44px; border-radius: 50%;
        background: var(--dp3); border: 1.5px solid var(--ac30);
        color: var(--sky2); font-size: 1.15rem; display: flex; align-items: center; justify-content: center;
        cursor: pointer; box-shadow: 0 2px 12px rgba(0,0,0,.45);
      }
      #mpc-bubble.hidden { display: none; }
      #mpc-badge {
        position: absolute; top: -4px; right: -4px; min-width: 16px; height: 16px; padding: 0 4px;
        border-radius: 8px; background: var(--rose); color: #fff; font-size: .58rem; font-weight: bold;
        display: flex; align-items: center; justify-content: center; font-family: 'JetBrains Mono', monospace;
      }
      #mpc-badge.hidden { display: none; }
      #mpc-panel {
        position: fixed; bottom: 64px; right: 12px; z-index: 99998;
        width: 260px; max-height: 340px; display: flex; flex-direction: column;
        background: rgba(20,20,24,.97); border: 1.5px solid var(--ac28); border-radius: 10px;
        box-shadow: 0 4px 20px rgba(0,0,0,.5); overflow: hidden;
      }
      #mpc-panel.hidden { display: none; }
      #mpc-head {
        display: flex; justify-content: space-between; align-items: center;
        padding: 8px 10px; border-bottom: 1px solid var(--ac18);
        font-family: 'JetBrains Mono', monospace; font-size: .66rem; letter-spacing: .06em; color: var(--sky2);
      }
      #mpc-head button { background: none; border: none; color: var(--ink4); cursor: pointer; font-size: .8rem; }
      #mpc-list { flex: 1; overflow-y: auto; padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; min-height: 80px; }
      .mpc-msg { font-size: .68rem; line-height: 1.4; }
      .mpc-msg .mpc-name { font-weight: bold; margin-right: 5px; }
      .mpc-msg.mpc-system { color: var(--ink4); font-style: italic; }
      .mpc-msg .mpc-text { color: var(--ink2); word-break: break-word; }
      #mpc-inputrow { display: flex; gap: 6px; padding: 8px; border-top: 1px solid var(--ac18); }
      #mpc-input {
        flex: 1; min-width: 0; background: var(--dp3); border: 1px solid var(--ac22); border-radius: 4px;
        padding: 6px 8px; color: var(--ink2); font-family: 'JetBrains Mono', monospace; font-size: .68rem;
      }
      #mpc-send {
        background: var(--ac13); border: 1px solid var(--ac28); color: var(--sky2); border-radius: 4px;
        padding: 0 10px; font-family: 'JetBrains Mono', monospace; font-size: .66rem; cursor: pointer;
      }
      #mpc-send:hover { background: var(--ac20); }
      #mpc-empty { color: var(--ink4); font-size: .62rem; text-align: center; padding: 10px 0; }
    `;
    document.head.appendChild(style);

    chatBubbleEl = document.createElement('div');
    chatBubbleEl.id = 'mpc-bubble';
    chatBubbleEl.classList.add('hidden');
    chatBubbleEl.title = 'Session chat';
    chatBubbleEl.innerHTML = `💬<span id="mpc-badge" class="hidden">0</span>`;
    chatBubbleEl.onclick = toggleChat;
    document.body.appendChild(chatBubbleEl);

    chatPanelEl = document.createElement('div');
    chatPanelEl.id = 'mpc-panel';
    chatPanelEl.classList.add('hidden');
    chatPanelEl.innerHTML = `
      <div id="mpc-head"><span>💬 SESSION CHAT</span><button id="mpc-close-btn" title="Close">✕</button></div>
      <div id="mpc-list"></div>
      <div id="mpc-inputrow">
        <input id="mpc-input" maxlength="240" placeholder="Message…" autocomplete="off">
        <button id="mpc-send">SEND</button>
      </div>
    `;
    document.body.appendChild(chatPanelEl);

    chatListEl = chatPanelEl.querySelector('#mpc-list');
    chatInputEl = chatPanelEl.querySelector('#mpc-input');
    chatPanelEl.querySelector('#mpc-close-btn').onclick = () => setChatOpen(false);
    chatPanelEl.querySelector('#mpc-send').onclick = _sendChatMsg;
    chatInputEl.addEventListener('keydown', e => {
      if(e.key === 'Enter'){ e.preventDefault(); _sendChatMsg(); }
    });
  }

  function _peerNameFor(peerId){
    if(peerId === Collab.getMyInfo().peerId) return 'You';
    return roster[peerId]?.name || 'Peer';
  }
  function _peerColorFor(peerId){
    return roster[peerId]?.color || '#888';
  }

  function _chatMsgHtml(m){
    if(m.system) return `<div class="mpc-msg mpc-system">${_esc(m.text)}</div>`;
    return `<div class="mpc-msg"><span class="mpc-name" style="color:${m.color || '#888'}">${_esc(m.name)}:</span><span class="mpc-text">${_esc(m.text)}</span></div>`;
  }

  function _renderChat(){
    if(!chatListEl) return;
    chatListEl.innerHTML = chatMessages.length
      ? chatMessages.map(_chatMsgHtml).join('')
      : `<div id="mpc-empty">No messages yet — say hi.</div>`;
    chatListEl.scrollTop = chatListEl.scrollHeight;
    const badge = document.getElementById('mpc-badge');
    if(badge){
      badge.textContent = unread > 9 ? '9+' : String(unread);
      badge.classList.toggle('hidden', unread === 0);
    }
  }

  function _pushChatMsg(m){
    chatMessages.push(m);
    if(chatMessages.length > 200) chatMessages.shift(); // cap in-memory history
    if(!chatOpen && !m.system) unread++;
    _renderChat();
  }

  function _sendChatMsg(){
    const text = (chatInputEl?.value || '').trim();
    if(!text) return;
    const me = Collab.getMyInfo();
    // Shown locally right away — Collab.sendChat() only echoes a peer's own
    // message back to *other* participants, not the sender (see collab.js).
    _pushChatMsg({ peerId: me.peerId, name: 'You', color: me.color, text });
    Collab.sendChat(text);
    chatInputEl.value = '';
    chatInputEl.focus();
  }

  function setChatOpen(open){
    chatOpen = open;
    if(!chatPanelEl) return;
    chatPanelEl.classList.toggle('hidden', !open);
    if(open){ unread = 0; _renderChat(); chatInputEl?.focus(); }
  }
  function toggleChat(){ setChatOpen(!chatOpen); }

  function _showChatWidget(){
    _ensureChatDom();
    chatMessages = [];
    unread = 0;
    chatBubbleEl.classList.remove('hidden');
    _renderChat();
  }
  function _hideChatWidget(){
    if(chatBubbleEl) chatBubbleEl.classList.add('hidden');
    setChatOpen(false);
    chatMessages = [];
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
      if(chatBubbleEl) _pushChatMsg({ system: true, text: `${d.info?.name || 'A peer'} joined the session` });
    });
    Collab.on('peer-left', d => {
      const name = roster[d.peerId]?.name || 'A peer';
      delete roster[d.peerId];
      _renderPeerList();
      if(chatBubbleEl) _pushChatMsg({ system: true, text: `${name} left the session` });
    });
    Collab.on('chat', d => {
      // Sender already sees their own message locally on send (see
      // _sendChatMsg) — collab.js only echoes it back to *other* peers.
      if(d.peerId === Collab.getMyInfo().peerId) return;
      _pushChatMsg({ peerId: d.peerId, name: _peerNameFor(d.peerId), color: _peerColorFor(d.peerId), text: d.text });
    });
    Collab.on('host-disconnected', () => {
      alert('Lost connection to the host.');
      roster = {};
      _resetModalToIdle();
      _hideChatWidget();
    });
    Collab.on('left', () => {
      roster = {};
    });
  }

  return { openModal, closeModal, switchTab, startHost, startJoin, leave, copyCode };
})();
