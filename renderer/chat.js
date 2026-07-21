'use strict';

/**
 * WholeTeam Chat — renderer client for the closed-loop LAN chat.
 * Talks plain WebSocket JSON to src/chat-server.js (hosted by this app via
 * IPC, or by another WholeTeam on the office network).
 *
 * Panel views: setup -> pick (identity) -> list -> convo | library | profile | search
 * Extras: disappearing chats (files are never pruned), file/link library with
 * machine sync, all-channels shared-files bucket, message search, self-service
 * profile (contact details only — role/department are admin-set), PIN clock-in
 * with idle-based activity sharing, admin timesheets.
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const panel = $('chat-panel');
  const chatBtn = $('btn-chat');
  const unreadBadge = $('chat-unread-badge');

  const C = {
    view: 'setup',
    ws: null,
    hosting: null,
    addr: '',
    roster: [],
    channels: [],
    taken: [],
    online: [],
    you: null,
    admin: false,
    retentionDays: null,
    current: null,
    backView: 'list',
    msgs: new Map(),
    unread: new Map(),
    library: new Map(),      // channel -> entries ('*' = all shared files)
    timesheets: [],
    searchResults: [],
    searchQ: '',
    pinSet: false,
    clockedIn: false,
    mySummary: null,
    error: '',
    notice: '',
    open: false,
  };

  const RETENTION_OPTIONS = [
    ['', 'Keep chats forever'], ['1', 'Chats vanish after 1 day'], ['2', '2 days'], ['5', '5 days'],
    ['7', '7 days'], ['30', '30 days'], ['90', '90 days'], ['180', '180 days'], ['365', '365 days'],
  ];

  let samplerTimer = null;
  let sampleAcc = { active: 0, sample: 0 };
  let tsRefreshTimer = null;
  let lastTimesheetJson = '';
  const pendingDownloads = new Set();

  function saveLast(obj) {
    try { localStorage.setItem('orgtree-chat-last', JSON.stringify(obj)); } catch (_) {}
  }
  function loadLast() {
    try { return JSON.parse(localStorage.getItem('orgtree-chat-last')) || {}; } catch (_) { return {}; }
  }
  function syncedSet() {
    try { return new Set(JSON.parse(localStorage.getItem('orgtree-chat-synced')) || []); } catch (_) { return new Set(); }
  }
  function markSynced(id) {
    const s = syncedSet(); s.add(id);
    try { localStorage.setItem('orgtree-chat-synced', JSON.stringify([...s].slice(-3000))); } catch (_) {}
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function fmtSize(n) {
    if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return n + ' B';
  }
  function fmtHours(sec) {
    const h = sec / 3600;
    return h >= 10 ? Math.round(h) + 'h' : (Math.round(h * 10) / 10) + 'h';
  }

  function personById(id) { return C.roster.find(p => p.id === id) || null; }
  function dmChannel(a, b) { return 'dm:' + [String(a), String(b)].sort().join('|'); }

  function channelLabel(ch) {
    if (ch === '*') return 'All shared files';
    if (ch === 'org') return 'Everyone';
    if (ch.startsWith('dept:')) return ch.slice(5);
    if (ch.startsWith('dm:')) {
      const other = ch.slice(3).split('|').find(id => !C.you || id !== C.you.id);
      const p = personById(other);
      return p ? p.name : 'Direct message';
    }
    return ch;
  }

  function totalUnread() {
    let n = 0;
    for (const v of C.unread.values()) n += v;
    return n;
  }

  function updateBadge() {
    const n = totalUnread();
    unreadBadge.classList.toggle('hidden', n === 0);
    unreadBadge.textContent = n > 99 ? '99+' : String(n);
    chatBtn.classList.toggle('active', C.open);
  }

  // ---------- websocket ----------

  function connect(addr) {
    disconnect(false);
    C.addr = addr;
    C.view = 'connecting';
    C.error = '';
    render();
    let ws;
    try {
      ws = new WebSocket('ws://' + addr);
    } catch (err) {
      C.view = 'setup'; C.error = 'Bad address: ' + addr; render(); return;
    }
    C.ws = ws;

    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (_) { return; }
      handleServer(m);
    };
    ws.onclose = () => {
      if (C.ws !== ws) return;
      C.ws = null;
      stopActivitySampler();
      const wasIn = ['list', 'convo', 'library', 'profile', 'search'].includes(C.view);
      C.view = 'setup';
      if (wasIn) C.error = 'Disconnected from the chat server.';
      else if (!C.error) C.error = 'Could not reach ' + addr + '. Is the host running?';
      C.you = null; C.online = []; C.clockedIn = false;
      render(); updateBadge();
    };
  }

  function disconnect(rerender = true) {
    stopActivitySampler();
    clearInterval(tsRefreshTimer);
    tsRefreshTimer = null;
    lastTimesheetJson = '';
    if (C.ws) { const w = C.ws; C.ws = null; try { w.close(); } catch (_) {} }
    C.you = null; C.view = 'setup'; C.current = null;
    C.msgs = new Map(); C.unread = new Map(); C.library = new Map();
    C.online = []; C.clockedIn = false; C.admin = false;
    if (rerender) { render(); updateBadge(); }
  }

  function sendServer(obj) {
    if (C.ws && C.ws.readyState === 1) C.ws.send(JSON.stringify(obj));
  }

  function handleServer(m) {
    if (m.type === 'roster') {
      C.roster = m.roster || [];
      C.channels = m.channels || [];
      C.taken = m.taken || [];
      C.retentionDays = m.retentionDays || null;
      const last = loadLast();
      if (last.personId && C.roster.some(p => p.id === last.personId) && !C.taken.includes(last.personId)) {
        sendServer({ type: 'hello', personId: last.personId });
        C.view = 'connecting';
      } else {
        C.view = 'pick';
      }
      render();
      return;
    }
    if (m.type === 'welcome') {
      C.you = m.you;
      C.online = m.online || [];
      C.admin = !!m.admin;
      C.pinSet = !!m.pinSet;
      C.clockedIn = !!m.clockedIn;
      C.retentionDays = m.retentionDays || null;
      C.view = 'list';
      C.error = '';
      saveLast({ ...loadLast(), addr: C.addr, personId: m.you.id });
      for (const ch of C.channels) {
        sendServer({ type: 'history', channel: ch.id });
        sendServer({ type: 'library', channel: ch.id });
      }
      if (C.admin) {
        sendServer({ type: 'timesheet' });
        clearInterval(tsRefreshTimer);
        tsRefreshTimer = setInterval(() => {
          if (C.ws && C.admin) sendServer({ type: 'timesheet' });
        }, 30000);
      }
      if (C.clockedIn) startActivitySampler();
      render(); updateBadge();
      return;
    }
    if (m.type === 'error') {
      if (m.error === 'identity-taken') { C.view = 'pick'; C.error = 'That person is already connected — pick someone else.'; }
      else if (m.error === 'bad-pin') C.error = 'Wrong PIN.';
      else if (m.error === 'no-pin-set') C.error = 'Set a PIN in My profile first.';
      else if (m.error === 'file-too-large') C.error = 'That file is over the 300 MB share limit.';
      else C.error = m.error;
      render();
      return;
    }
    if (m.type === 'presence') {
      C.online = m.online || [];
      if (['list', 'convo', 'library', 'profile'].includes(C.view)) render();
      return;
    }
    if (m.type === 'rosterUpdate') {
      const p = personById(m.personId);
      if (p && m.fields) {
        for (const k of ['timezone', 'workHours']) if (m.fields[k] != null) p[k] = m.fields[k];
      }
      return;
    }
    if (m.type === 'history') {
      C.msgs.set(m.channel, m.messages || []);
      if ((C.view === 'convo' && C.current === m.channel) || C.view === 'list') render();
      return;
    }
    if (m.type === 'library') {
      C.library.set(m.channel, m.entries || []);
      if (m.channel !== '*') autoSyncChannel(m.channel);
      if (C.view === 'library' && C.current === m.channel) render();
      return;
    }
    if (m.type === 'libraryChanged') {
      sendServer({ type: 'library', channel: m.channel });
      if (C.view === 'library' && C.current === '*') sendServer({ type: 'library', channel: '*' });
      return;
    }
    if (m.type === 'searchResults') {
      C.searchResults = m.results || [];
      C.searchQ = m.q;
      C.view = 'search';
      render();
      return;
    }
    if (m.type === 'fileData') {
      handleFileData(m);
      return;
    }
    if (m.type === 'profileSaved') {
      const hadPin = C.pinSet;
      C.pinSet = !!m.pinSet || C.pinSet;
      C.notice = (!hadPin && C.pinSet)
        ? 'Profile saved. PIN set — you can clock in below to start tracking your hours.'
        : 'Profile saved — it now shows on the company chart.';
      if (C.view === 'profile') render();
      return;
    }
    if (m.type === 'clock') {
      C.clockedIn = m.status === 'in';
      C.error = '';
      if (C.clockedIn) startActivitySampler(); else stopActivitySampler();
      if (m.summary) C.mySummary = m.summary;
      render();
      return;
    }
    if (m.type === 'timesheet') {
      // Only re-render when the data actually changed — rendering the list on
      // every reply while the list itself requests timesheets would loop.
      const j = JSON.stringify(m.entries || []);
      const changed = j !== lastTimesheetJson;
      lastTimesheetJson = j;
      if (C.admin && m.entries && m.entries.length > 1) C.timesheets = m.entries;
      else if (m.entries && m.entries.length === 1) C.mySummary = m.entries[0];
      if (changed && C.view === 'list') render();
      return;
    }
    if (m.type === 'msg') {
      const list = C.msgs.get(m.channel) || [];
      list.push(m);
      C.msgs.set(m.channel, list);
      const mine = C.you && m.from === C.you.id;
      if (!mine && !(C.open && C.view === 'convo' && C.current === m.channel)) {
        C.unread.set(m.channel, (C.unread.get(m.channel) || 0) + 1);
      }
      if ((C.view === 'convo' && C.current === m.channel) || C.view === 'list') render();
      updateBadge();
    }
  }

  // ---------- library sync to this machine ----------

  function autoSyncChannel(channel) {
    if (channel.startsWith('dm:')) return; // DM files never auto-sync
    const synced = syncedSet();
    for (const e of C.library.get(channel) || []) {
      if (e.kind === 'file' && !synced.has(e.id)) {
        sendServer({ type: 'fileGet', id: e.id, reason: 'sync' });
      }
    }
  }

  async function handleFileData(m) {
    if (pendingDownloads.has(m.id)) {
      pendingDownloads.delete(m.id);
      const res = await window.orgtree.chatSaveFile(m.name, m.data);
      if (res && res.ok) { C.notice = 'Saved: ' + res.path; if (C.open) render(); }
      return;
    }
    const res = await window.orgtree.chatSyncWrite(channelLabel(m.channel), m.name, m.data);
    if (res && res.ok) markSynced(m.id);
  }

  // ---------- clocked-in activity sampler (idle counts only, no content) ----------

  function startActivitySampler() {
    stopActivitySampler();
    samplerTimer = setInterval(async () => {
      try {
        const idle = await window.orgtree.activityIdleSec();
        sampleAcc.sample += 30;
        if (idle < 60) sampleAcc.active += 30;
        if (sampleAcc.sample >= 120) {
          sendServer({ type: 'activity', activeSec: sampleAcc.active, sampleSec: sampleAcc.sample });
          sampleAcc = { active: 0, sample: 0 };
        }
      } catch (_) { /* bridge unavailable */ }
    }, 30000);
  }
  function stopActivitySampler() {
    clearInterval(samplerTimer);
    samplerTimer = null;
    if (sampleAcc.sample > 0) {
      sendServer({ type: 'activity', activeSec: sampleAcc.active, sampleSec: sampleAcc.sample });
      sampleAcc = { active: 0, sample: 0 };
    }
  }

  // ---------- hosting ----------

  async function hostAndJoin(port, retentionDays) {
    const res = await window.orgtree.chatHost(port, retentionDays);
    if (!res.ok) { C.error = res.error || 'Could not start the chat server.'; render(); return; }
    C.hosting = { ip: res.ip, port: res.port };
    C.retentionDays = res.retentionDays || null;
    saveLast({ ...loadLast(), mode: 'host', port: res.port, retentionDays: retentionDays || '' });
    connect('127.0.0.1:' + res.port);
  }

  async function stopHosting() {
    await window.orgtree.chatStopHost();
    C.hosting = null;
    disconnect();
  }

  // ---------- views ----------

  function render() {
    if (!C.open) { panel.classList.add('hidden'); return; }
    panel.classList.remove('hidden');
    if (C.view === 'setup') renderSetup();
    else if (C.view === 'connecting') renderConnecting();
    else if (C.view === 'pick') renderPick();
    else if (C.view === 'list') renderList();
    else if (C.view === 'convo') renderConvo();
    else if (C.view === 'library') renderLibrary();
    else if (C.view === 'profile') renderProfile();
    else if (C.view === 'search') renderSearch();
  }

  function header(title, opts = {}) {
    return `<div class="chat-head">
      ${opts.back ? '<button class="chat-icon-btn" id="chat-back" title="Back"><svg class="icon"><use href="#i-back"/></svg></button>' : ''}
      <div class="chat-head-title">
        <h2>${esc(title)}</h2>
        ${opts.sub ? `<p>${esc(opts.sub)}</p>` : ''}
      </div>
      ${opts.buttons || ''}
      <button class="chat-icon-btn" id="chat-close" title="Close panel"><svg class="icon"><use href="#i-x"/></svg></button>
    </div>`;
  }

  function errLine() {
    let html = '';
    if (C.error) html += `<div class="chat-error">${esc(C.error)}</div>`;
    if (C.notice) { html += `<div class="chat-notice">${esc(C.notice)}</div>`; C.notice = ''; }
    return html;
  }

  function retentionNote() {
    return C.retentionDays ? `Chats vanish after ${C.retentionDays} day${C.retentionDays === 1 ? '' : 's'}` : '';
  }

  function renderSetup() {
    const last = loadLast();
    panel.innerHTML = header('Team Chat', { sub: 'Closed-loop office chat — nothing leaves your network' }) + `
      <div class="chat-body">
        ${errLine()}
        <div class="chat-setup-card">
          <div class="chat-setup-title"><svg class="icon"><use href="#i-server"/></svg>Host chat on this machine (admin)</div>
          <p>Your computer becomes the office server. You keep the only edit access to the chart; others join and manage just their own profile.</p>
          <div class="chat-inline">
            <input type="number" id="chat-port" value="${esc(last.port || 4600)}" min="1024" max="65535" title="Port">
            <select id="chat-retention" title="Disappearing chats (shared files are always kept)">
              ${RETENTION_OPTIONS.map(([v, l]) => `<option value="${v}" ${String(last.retentionDays || '') === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select>
          </div>
          <p style="margin:6px 0 0">Disappearing chats never delete shared files — the library keeps everything.</p>
          <div class="chat-inline" style="margin-top:8px">
            <button class="btn primary small" id="chat-host-btn" style="flex:1">Start hosting</button>
          </div>
        </div>
        <div class="chat-setup-card">
          <div class="chat-setup-title"><svg class="icon"><use href="#i-chat"/></svg>Join the office chat</div>
          <p>Enter the address shown on the host's screen (e.g. 192.168.1.24:4600).</p>
          <div class="chat-inline">
            <input type="text" id="chat-addr" placeholder="192.168.1.24:4600" value="${esc(last.mode === 'join' ? (last.addr || '') : '')}">
            <button class="btn primary small" id="chat-join-btn">Join</button>
          </div>
        </div>
        <div class="chat-setup-card">
          <div class="chat-setup-title"><svg class="icon"><use href="#i-globe"/></svg>Remote team? (another city or country)</div>
          <p>Install the free <b>Tailscale</b> VPN on every machine and sign them into the same account. Remote people then join using the host's Tailscale address (looks like <b>100.x.y.z:4600</b>) instead of the office one. Traffic stays private and encrypted end-to-end — still no cloud chat server.</p>
          <div class="chat-inline">
            <button class="btn ghost small" id="chat-tailscale-btn" style="flex:1">Get Tailscale (tailscale.com)</button>
          </div>
        </div>
      </div>`;
    wireCommon();
    $('chat-host-btn').addEventListener('click', () =>
      hostAndJoin(Number($('chat-port').value) || 4600, Number($('chat-retention').value) || null));
    const join = () => {
      const addr = $('chat-addr').value.trim().replace(/^ws:\/\//, '');
      if (!addr) return;
      saveLast({ ...loadLast(), mode: 'join', addr });
      connect(addr);
    };
    $('chat-join-btn').addEventListener('click', join);
    $('chat-addr').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
    $('chat-tailscale-btn').addEventListener('click', () => window.orgtree.chatOpenExternal('https://tailscale.com/download'));
  }

  function renderConnecting() {
    panel.innerHTML = header('Team Chat') + `
      <div class="chat-body"><div class="chat-hint">Connecting to ${esc(C.addr)}…</div></div>`;
    wireCommon();
  }

  function renderPick() {
    const taken = new Set(C.taken.concat(C.online));
    panel.innerHTML = header('Who are you?', { sub: 'Pick yourself from the org chart' }) + `
      <div class="chat-body">
        ${errLine()}
        <div class="chat-people">
          ${C.roster.map(p => `
            <button class="chat-person ${taken.has(p.id) ? 'taken' : ''}" data-id="${esc(p.id)}" ${taken.has(p.id) ? 'disabled' : ''}>
              <span class="chat-dot" style="background:${taken.has(p.id) ? 'var(--muted)' : 'var(--accent)'}"></span>
              <span class="chat-person-name">${esc(p.name)}</span>
              <span class="chat-person-title">${esc(p.title)}${taken.has(p.id) ? ' · connected elsewhere' : ''}</span>
            </button>`).join('')}
        </div>
      </div>`;
    wireCommon();
    panel.querySelectorAll('.chat-person:not(.taken)').forEach(b => {
      b.addEventListener('click', () => sendServer({ type: 'hello', personId: b.dataset.id }));
    });
  }

  function hostLine() {
    if (!C.hosting) return '';
    return `<div class="chat-hosting">
      <svg class="icon"><use href="#i-server"/></svg>
      Hosting — join at <b>${esc(C.hosting.ip + ':' + C.hosting.port)}</b>
      <button class="btn small ghost" id="chat-stop-host">Stop</button>
    </div>`;
  }

  function clockCard() {
    if (!C.you) return '';
    if (C.clockedIn) {
      return `<div class="chat-clock on">
        <svg class="icon"><use href="#i-timer"/></svg>
        <span><b>Clocked in.</b> Your active/idle level (no keystrokes) is shared with the admin.</span>
        <button class="btn small ghost" id="chat-clock-out">Clock out</button>
      </div>`;
    }
    if (!C.pinSet) {
      return `<div class="chat-clock">
        <svg class="icon"><use href="#i-timer"/></svg>
        <span>Track your hours — set a PIN in <b>My profile</b> first.</span>
      </div>`;
    }
    return `<div class="chat-clock">
      <svg class="icon"><use href="#i-timer"/></svg>
      <input type="password" id="chat-pin" placeholder="PIN" maxlength="8" inputmode="numeric" style="width:64px">
      <button class="btn small primary" id="chat-clock-in">Clock in</button>
    </div>`;
  }

  function renderList() {
    const onlineSet = new Set(C.online);
    const lastMsgOf = (ch) => {
      const list = C.msgs.get(ch) || [];
      return list.length ? list[list.length - 1] : null;
    };
    const preview = (last) => {
      if (!last) return '';
      const who = last.fromName ? last.fromName.split(' ')[0] + ': ' : '';
      return who + (last.kind === 'file' ? '[file] ' + last.fileName : last.text);
    };
    const chRow = (id, label, sub, isDm, otherId) => {
      const unread = C.unread.get(id) || 0;
      const last = lastMsgOf(id);
      return `<button class="chat-row" data-ch="${esc(id)}">
        ${isDm
          ? `<span class="chat-dot ${onlineSet.has(otherId) ? 'on' : ''}"></span>`
          : '<span class="chat-hash">#</span>'}
        <span class="chat-row-main">
          <span class="chat-row-name">${esc(label)}</span>
          <span class="chat-row-sub">${esc(preview(last) || sub)}</span>
        </span>
        ${unread ? `<span class="chat-row-unread">${unread > 99 ? '99+' : unread}</span>` : ''}
      </button>`;
    };

    const headBtns = `
      <button class="chat-icon-btn" id="chat-all-files" title="All shared files"><svg class="icon"><use href="#i-lib"/></svg></button>
      <button class="chat-icon-btn" id="chat-profile" title="My profile"><svg class="icon"><use href="#i-user"/></svg></button>`;
    const subBits = [`You are ${C.you.name}`, `${C.online.length} online`];
    if (retentionNote()) subBits.push(retentionNote());

    let html = header('Team Chat', { sub: subBits.join(' · '), buttons: headBtns }) + '<div class="chat-body">' + errLine() + hostLine() + clockCard();

    html += `<div class="chat-inline" style="margin-bottom:10px">
      <input type="text" id="chat-msg-search" placeholder="Search all messages…" style="flex:1;background:var(--bg);border:1px solid var(--border);border-radius:10px;color:var(--text);padding:8px 12px;font-size:13px;font-family:inherit">
    </div>`;

    if (C.admin && C.timesheets.length) {
      html += '<div class="chat-section">Timesheets (admin only)</div>';
      for (const t of C.timesheets) {
        const p = personById(t.personId);
        if (!p) continue;
        html += `<div class="chat-ts-row">
          <span class="chat-dot ${t.clockedIn ? 'on' : ''}"></span>
          <span class="chat-row-main">
            <span class="chat-row-name">${esc(p.name)}</span>
            <span class="chat-row-sub">${fmtHours(t.todaySec)} today · ${fmtHours(t.weekSec)} this week${t.activePct != null ? ` · ${t.activePct}% active` : ''}</span>
          </span>
        </div>`;
      }
    }

    html += '<div class="chat-section">Channels</div>';
    for (const ch of C.channels) {
      html += chRow(ch.id, ch.id === 'org' ? 'Everyone' : ch.label, ch.id === 'org' ? 'The whole company' : ch.label + ' team', false);
    }
    html += '<div class="chat-section">Direct messages</div>';
    for (const p of C.roster.filter(p => p.id !== C.you.id)) {
      const bits = [p.title || '—'];
      if (p.timezone) {
        try {
          bits.push(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: p.timezone }) + ' local');
        } catch (_) { /* bad tz string */ }
      }
      html += chRow(dmChannel(C.you.id, p.id), p.name, bits.join(' · '), true, p.id);
    }
    html += '</div>';
    panel.innerHTML = html;
    wireCommon();
    panel.querySelectorAll('.chat-row').forEach(b => {
      b.addEventListener('click', () => openChannel(b.dataset.ch));
    });
    const stop = $('chat-stop-host');
    if (stop) stop.addEventListener('click', stopHosting);
    const prof = $('chat-profile');
    if (prof) prof.addEventListener('click', () => { C.view = 'profile'; C.error = ''; render(); });
    const allFiles = $('chat-all-files');
    if (allFiles) allFiles.addEventListener('click', () => {
      C.current = '*'; C.backView = 'list'; C.view = 'library';
      sendServer({ type: 'library', channel: '*' });
      render();
    });
    const msgSearch = $('chat-msg-search');
    if (msgSearch) msgSearch.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && msgSearch.value.trim()) {
        sendServer({ type: 'search', q: msgSearch.value.trim() });
      }
    });
    const cin = $('chat-clock-in');
    if (cin) cin.addEventListener('click', () => sendServer({ type: 'clockIn', pin: $('chat-pin').value }));
    const cout = $('chat-clock-out');
    if (cout) cout.addEventListener('click', () => sendServer({ type: 'clockOut' }));
  }

  function openChannel(ch) {
    C.current = ch;
    C.view = 'convo';
    C.unread.delete(ch);
    if (!C.msgs.has(ch)) sendServer({ type: 'history', channel: ch });
    render(); updateBadge();
  }

  function renderConvo() {
    const ch = C.current;
    const msgs = C.msgs.get(ch) || [];
    const isDm = ch.startsWith('dm:');
    const otherId = isDm ? ch.slice(3).split('|').find(id => id !== C.you.id) : null;
    const onlineNote = isDm
      ? (C.online.includes(otherId) ? 'online' : 'offline')
      : `${C.online.length} online`;
    const subBits = [onlineNote];
    if (retentionNote()) subBits.push(retentionNote());

    let bodyHtml = '';
    let lastFrom = null, lastTs = 0;
    const synced = syncedSet();
    for (const m of msgs) {
      const mine = m.from === C.you.id;
      const grouped = m.from === lastFrom && m.ts - lastTs < 5 * 60 * 1000 && m.kind !== 'file';
      lastFrom = m.from; lastTs = m.ts;
      const time = new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      let bubble;
      if (m.kind === 'file') {
        bubble = `<div class="chat-bubble file">
          <svg class="icon"><use href="#i-paperclip"/></svg>
          <span class="chat-file-main"><b>${esc(m.fileName)}</b><span>${fmtSize(m.size)}${synced.has(m.fileId) ? ' · synced to your library folder' : ''}</span></span>
          <button class="btn small ghost chat-dl" data-file="${esc(m.fileId)}">Save</button>
        </div>`;
      } else {
        bubble = `<div class="chat-bubble">${esc(m.text)}</div>`;
      }
      bodyHtml += `<div class="chat-msg ${mine ? 'mine' : ''}">
        ${!grouped ? `<div class="chat-msg-meta">${esc(mine ? 'You' : m.fromName)} · ${time}</div>` : ''}
        ${bubble}
      </div>`;
    }
    if (!msgs.length) bodyHtml = `<div class="chat-hint">No messages yet in ${esc(channelLabel(ch))}. Say something.</div>`;

    const libBtn = isDm ? '' : `<button class="chat-icon-btn" id="chat-lib" title="Channel library (files & links)"><svg class="icon"><use href="#i-lib"/></svg></button>`;

    panel.innerHTML = header((isDm ? '' : '#') + channelLabel(ch), { back: true, sub: subBits.join(' · '), buttons: libBtn }) + `
      <div class="chat-body chat-msgs" id="chat-msgs">${errLine()}${bodyHtml}</div>
      <div class="chat-compose">
        <button class="btn ghost icon-only" id="chat-attach" title="Share a file (goes to the ${esc(channelLabel(ch))} library)"><svg class="icon"><use href="#i-paperclip"/></svg></button>
        <input type="text" id="chat-input" placeholder="Message ${esc(channelLabel(ch))}…" maxlength="4000" autocomplete="off">
        <button class="btn primary icon-only" id="chat-send" title="Send"><svg class="icon"><use href="#i-send"/></svg></button>
      </div>`;
    wireCommon();
    $('chat-back').addEventListener('click', () => { C.view = 'list'; C.current = null; render(); });
    if (!isDm) $('chat-lib').addEventListener('click', () => { C.backView = 'convo'; C.view = 'library'; render(); });
    const input = $('chat-input');
    const send = () => {
      const text = input.value.trim();
      if (!text) return;
      sendServer({ type: 'msg', channel: ch, text });
      input.value = '';
      input.focus();
    };
    $('chat-send').addEventListener('click', send);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
    $('chat-attach').addEventListener('click', async () => {
      const res = await window.orgtree.chatPickFile();
      if (!res || res.canceled) return;
      if (!res.ok) { C.error = res.error; render(); return; }
      sendServer({ type: 'file', channel: ch, name: res.name, data: res.data });
    });
    panel.querySelectorAll('.chat-dl').forEach(b => {
      b.addEventListener('click', () => {
        pendingDownloads.add(b.dataset.file);
        sendServer({ type: 'fileGet', id: b.dataset.file, reason: 'download' });
      });
    });
    const box = $('chat-msgs');
    box.scrollTop = box.scrollHeight;
    input.focus();
  }

  function renderLibrary() {
    const ch = C.current;
    const isAll = ch === '*';
    const entries = (C.library.get(ch) || []).slice().reverse();
    const files = entries.filter(e => e.kind === 'file');
    const links = entries.filter(e => e.kind === 'link');
    const synced = syncedSet();

    let html = header(isAll ? 'Shared files' : channelLabel(ch) + ' library', {
      back: true,
      sub: `${files.length} file${files.length === 1 ? '' : 's'} · ${links.length} link${links.length === 1 ? '' : 's'} · kept forever`,
    }) + '<div class="chat-body">' + errLine();

    html += `<div class="chat-lib-note">${isAll
      ? 'Everything the team has shared, across all channels. Files sync automatically to <b>Documents\\WholeTeam Library</b> on every member\'s machine and are never deleted by disappearing chat.'
      : `Files shared in #${esc(channelLabel(ch))} sync automatically to <b>Documents\\WholeTeam Library\\${esc(channelLabel(ch))}</b> on every member's machine and are never deleted by disappearing chat.`}
      <button class="btn small ghost" id="chat-open-folder">Open folder</button></div>`;

    const fileRow = (e) => `<div class="chat-lib-row">
      <svg class="icon"><use href="#i-paperclip"/></svg>
      <span class="chat-row-main">
        <span class="chat-row-name">${esc(e.name)}</span>
        <span class="chat-row-sub">${isAll ? '#' + esc(channelLabel(e.channel)) + ' · ' : ''}${fmtSize(e.size)} · ${esc(e.fromName)} · ${new Date(e.ts).toLocaleDateString()}${synced.has(e.id) ? ' · synced' : ''}</span>
      </span>
      <button class="btn small ghost chat-dl" data-file="${esc(e.id)}">Save</button>
    </div>`;
    const linkRow = (e) => `<div class="chat-lib-row">
      <svg class="icon"><use href="#i-link"/></svg>
      <span class="chat-row-main">
        <span class="chat-row-name chat-link" data-url="${esc(e.url)}">${esc(e.url)}</span>
        <span class="chat-row-sub">${isAll ? '#' + esc(channelLabel(e.channel)) + ' · ' : ''}${esc(e.fromName)} · ${new Date(e.ts).toLocaleDateString()}</span>
      </span>
    </div>`;

    if (files.length) {
      html += '<div class="chat-section">Files</div>';
      for (const e of files) html += fileRow(e);
    }
    if (links.length) {
      html += '<div class="chat-section">Links</div>';
      for (const e of links) html += linkRow(e);
    }
    if (!files.length && !links.length) {
      html += '<div class="chat-hint">Nothing here yet. Files you attach and links you paste in chat are collected automatically.</div>';
    }
    html += '</div>';
    panel.innerHTML = html;
    wireCommon();
    $('chat-back').addEventListener('click', () => { C.view = C.backView === 'convo' ? 'convo' : 'list'; render(); });
    $('chat-open-folder').addEventListener('click', () => window.orgtree.chatOpenLibrary(isAll ? null : channelLabel(ch)));
    panel.querySelectorAll('.chat-dl').forEach(b => {
      b.addEventListener('click', () => {
        pendingDownloads.add(b.dataset.file);
        sendServer({ type: 'fileGet', id: b.dataset.file, reason: 'download' });
      });
    });
    panel.querySelectorAll('.chat-link').forEach(a => {
      a.addEventListener('click', () => window.orgtree.chatOpenExternal(a.dataset.url));
    });
  }

  function renderSearch() {
    const results = C.searchResults || [];
    let html = header(`Results for "${C.searchQ}"`, { back: true, sub: `${results.length} message${results.length === 1 ? '' : 's'}` }) + '<div class="chat-body">';
    if (!results.length) html += '<div class="chat-hint">No messages matched.</div>';
    for (const m of results) {
      html += `<button class="chat-row" data-ch="${esc(m.channel)}">
        <span class="chat-hash">${m.channel.startsWith('dm:') ? '@' : '#'}</span>
        <span class="chat-row-main">
          <span class="chat-row-name">${esc(channelLabel(m.channel))} · ${esc(m.fromName)} · ${new Date(m.ts).toLocaleDateString()}</span>
          <span class="chat-row-sub">${esc(m.kind === 'file' ? '[file] ' + m.fileName : m.text)}</span>
        </span>
      </button>`;
    }
    html += '</div>';
    panel.innerHTML = html;
    wireCommon();
    $('chat-back').addEventListener('click', () => { C.view = 'list'; render(); });
    panel.querySelectorAll('.chat-row').forEach(b => {
      b.addEventListener('click', () => openChannel(b.dataset.ch));
    });
  }

  function renderProfile() {
    const me = personById(C.you.id) || {};
    const zones = (Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : []).filter(z => /\//.test(z));
    panel.innerHTML = header('My profile', { back: true, sub: 'Visible on the company chart' }) + `
      <div class="chat-body">
        ${errLine()}
        <div class="chat-profile-fixed">
          <b>${esc(C.you.name)}</b> · ${esc(me.title || '—')}${me.department ? ' · ' + esc(me.department) : ''}
          <span>Name, role and department are set by your admin.</span>
        </div>
        <div class="form" style="gap:10px">
          <label>Phone <input type="text" id="pf-phone" placeholder="+1 555 010 2030"></label>
          <label>Location <input type="text" id="pf-location" placeholder="Austin, TX"></label>
          <label>Time zone
            <select id="pf-timezone">
              <option value="">— Not set —</option>
              ${zones.map(z => `<option value="${esc(z)}" ${me.timezone === z ? 'selected' : ''}>${esc(z.replace(/_/g, ' '))}</option>`).join('')}
            </select>
          </label>
          <label>Working hours <input type="text" id="pf-hours" placeholder="9:00-17:00" value="${esc(me.workHours || '')}"></label>
          <label>Start date <input type="date" id="pf-start"></label>
          <label>Notes <input type="text" id="pf-notes" placeholder="Anything your team should know"></label>
          <label>${C.pinSet ? 'Change clock-in PIN' : 'Set clock-in PIN'} <span class="hint">(4-8 digits, used to track your hours)</span>
            <input type="password" id="pf-pin" maxlength="8" inputmode="numeric" placeholder="${C.pinSet ? '****' : 'e.g. 4821'}">
          </label>
        </div>
        ${C.pinSet ? `
        <div class="chat-clock ${C.clockedIn ? 'on' : ''}" style="margin-top:14px">
          <svg class="icon"><use href="#i-timer"/></svg>
          ${C.clockedIn
            ? `<span><b>Clocked in${C.mySummary ? ' — ' + fmtHours(C.mySummary.todaySec) + ' today' : ''}.</b> Your active/idle level (no keystrokes) is shared with the admin.</span>
               <button class="btn small ghost" id="pf-clock-out">Clock out</button>`
            : `<span><b>Track your hours:</b></span>
               <input type="password" id="pf-clock-pin" placeholder="PIN" maxlength="8" inputmode="numeric" style="width:64px">
               <button class="btn small primary" id="pf-clock-in">Clock in</button>`}
        </div>` : ''}
        <div class="chat-inline" style="margin-top:14px">
          <button class="btn primary" id="pf-save" style="flex:1">Save profile</button>
        </div>
        <p class="chat-lib-note" style="margin-top:10px">Only fields you fill in are sent. Blank fields stay as they are.</p>
      </div>`;
    wireCommon();
    $('chat-back').addEventListener('click', () => { C.view = 'list'; render(); });
    const pfIn = $('pf-clock-in');
    if (pfIn) pfIn.addEventListener('click', () => sendServer({ type: 'clockIn', pin: $('pf-clock-pin').value }));
    const pfOut = $('pf-clock-out');
    if (pfOut) pfOut.addEventListener('click', () => sendServer({ type: 'clockOut' }));
    $('pf-save').addEventListener('click', () => {
      const fields = {};
      const map = { phone: 'pf-phone', location: 'pf-location', timezone: 'pf-timezone', workHours: 'pf-hours', startDate: 'pf-start', notes: 'pf-notes' };
      for (const [k, id] of Object.entries(map)) {
        const v = $(id).value.trim();
        if (v) fields[k] = v;
      }
      const pin = $('pf-pin').value.trim();
      const payload = { type: 'profile', fields };
      if (pin) {
        if (!/^\d{4,8}$/.test(pin)) { C.error = 'PIN must be 4-8 digits.'; render(); return; }
        payload.pin = pin;
      }
      if (!Object.keys(fields).length && !pin) { C.error = 'Nothing to save yet.'; render(); return; }
      C.error = '';
      sendServer(payload);
    });
  }

  function wireCommon() {
    const close = $('chat-close');
    if (close) close.addEventListener('click', togglePanel);
  }

  function togglePanel() {
    C.open = !C.open;
    if (C.open && C.view === 'convo' && C.current) C.unread.delete(C.current);
    render(); updateBadge();
  }

  chatBtn.addEventListener('click', togglePanel);

  (async function initChat() {
    try {
      const info = await window.orgtree.chatHostInfo();
      if (info.hosting) C.hosting = { ip: info.ip, port: info.port };
    } catch (_) { /* bridge unavailable */ }
  })();

  // ---------- demo/QA hook ----------

  window.__orgtreeChatDemo = async () => {
    C.open = true;
    await hostAndJoin(4655, null);
    await new Promise(r => setTimeout(r, 600));
    const me = C.roster[0];
    sendServer({ type: 'hello', personId: me.id });
    await new Promise(r => setTimeout(r, 400));

    const other = C.roster.find(p => p.id !== me.id && p.department === 'Engineering') || C.roster[1];
    const ws2 = new WebSocket('ws://127.0.0.1:4655');
    await new Promise(r => { ws2.onopen = r; });
    ws2.send(JSON.stringify({ type: 'hello', personId: other.id }));
    await new Promise(r => setTimeout(r, 300));
    ws2.send(JSON.stringify({ type: 'msg', channel: 'org', text: 'Morning everyone — the new org chart is live: https://wholeteam.example.com/handbook' }));
    await new Promise(r => setTimeout(r, 250));
    sendServer({ type: 'msg', channel: 'org', text: 'Nice. Drafting the Q3 reorg as a scenario now, will share before Friday.' });
    await new Promise(r => setTimeout(r, 300));
    if (window.__orgtreeChatMode === 'profile') {
      // regression check for the admin render-loop bug: click the real button
      C.view = 'list'; render();
      await new Promise(r => setTimeout(r, 400));
      const btn = document.getElementById('chat-profile');
      if (btn) btn.click();
    } else {
      openChannel('org');
    }
    await new Promise(r => setTimeout(r, 300));
  };
})();
