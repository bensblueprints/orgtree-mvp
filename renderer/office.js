'use strict';

/**
 * WholeTeam Social Mode — a walkable virtual office over the org data.
 * (Experimental — lives on the virtual-office branch.)
 *
 * Departments become rooms, every person gets a desk and chair, your avatar
 * walks with WASD/arrows. Walk up to a colleague to talk: proximity voice
 * connects your microphones peer-to-peer over the LAN (the chat server only
 * relays the WebRTC handshake — audio never touches the server). Close your
 * door to show you're heads-down; closed doors mute proximity chat and voice.
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const btn = $('btn-social');
  const overlay = $('social-overlay');
  const canvas = $('social-canvas');
  if (!btn || !overlay || !canvas) return;
  const ctx = canvas.getContext('2d');

  const TILE = 10;
  const SPEED = 3.4;
  const VOICE_RANGE = 120;   // px — mics connect inside this radius
  const HINT_RANGE = 130;

  const S = {
    on: false,
    meId: null,
    roster: [],
    rooms: [],               // {x,y,w,h,label,color}
    desks: new Map(),        // personId -> {x,y,room}
    world: { w: 1200, h: 800 },
    pos: { x: 0, y: 0 },
    keys: {},
    others: new Map(),       // personId -> {x,y,ts}
    busy: new Set(),
    myBusy: false,
    raf: null,
    lastSent: 0,
    lastPos: { x: 0, y: 0 },
    stream: null,
    voiceState: 'off',       // off | ready | denied
    peers: new Map(),        // personId -> {pc, audio, polite}
  };

  const chat = () => window.__wholeteamChat;
  const send = (o) => { const c = chat(); if (c) c.send(o); };

  const PALETTE = ['#0b66ff', '#0d9488', '#ea580c', '#7c3aed', '#e11d48', '#ca8a04', '#0891b2', '#db2777', '#65a30d', '#4f46e5'];
  function hashStr(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return Math.abs(h); }
  function colorFor(d) { return d ? PALETTE[hashStr(d) % PALETTE.length] : '#64748b'; }
  function initials(name) {
    const p = String(name || '?').trim().split(/\s+/).filter(Boolean);
    return p.length ? (p[0][0] + (p[1] ? p[1][0] : '')).toUpperCase() : '?';
  }

  // ---------- layout: departments -> rooms, people -> desks ----------

  function buildLayout(roster) {
    S.rooms = []; S.desks = new Map();
    const byDept = new Map();
    for (const p of roster) {
      const d = p.department || 'Team';
      if (!byDept.has(d)) byDept.set(d, []);
      byDept.get(d).push(p);
    }
    const deskW = 104, deskH = 78, pad = 26, cols = 3;
    let rx = 40, ry = 40, rowMaxH = 0;
    const maxRowW = Math.max(900, (overlay.clientWidth || 1200) - 80);
    for (const [dept, people] of byDept) {
      const dcols = Math.min(cols, Math.max(1, people.length));
      const drows = Math.ceil(people.length / dcols);
      const w = dcols * deskW + pad * 2;
      const h = drows * deskH + pad * 2 + 26;
      if (rx + w > maxRowW && S.rooms.length) { rx = 40; ry += rowMaxH + 34; rowMaxH = 0; }
      const room = { x: rx, y: ry, w, h, label: dept, color: colorFor(dept) };
      S.rooms.push(room);
      people.forEach((p, i) => {
        const cx = room.x + pad + (i % dcols) * deskW + deskW / 2;
        const cy = room.y + pad + 26 + Math.floor(i / dcols) * deskH + deskH / 2;
        S.desks.set(p.id, { x: cx, y: cy, room });
      });
      rowMaxH = Math.max(rowMaxH, h);
      rx += w + 34;
    }
    S.world.w = Math.max(1000, ...S.rooms.map(r => r.x + r.w + 40));
    S.world.h = Math.max(700, ...S.rooms.map(r => r.y + r.h + 40));
  }

  function posOf(id) {
    if (id === S.meId) return S.pos;
    const live = S.others.get(id);
    if (live) return live;
    const desk = S.desks.get(id);
    return desk ? { x: desk.x, y: desk.y + 18 } : { x: 60, y: 60 };
  }

  // ---------- enter / exit ----------

  function enter() {
    const c = chat();
    const st = c && c.getState();
    if (!st || !st.you) {
      if (c) c.openPanel();
      flashHint('Connect to Team Chat first — Social Mode uses your office connection.');
      return;
    }
    S.on = true;
    S.meId = st.you.id;
    S.roster = st.roster;
    S.busy = new Set(st.busy || []);
    buildLayout(st.roster);
    const desk = S.desks.get(S.meId);
    S.pos = desk ? { x: desk.x, y: desk.y + 22 } : { x: 80, y: 80 };
    overlay.classList.remove('hidden');
    btn.classList.add('active');
    sizeCanvas();
    initVoice();
    loop();
  }

  function exit() {
    S.on = false;
    cancelAnimationFrame(S.raf);
    for (const id of [...S.peers.keys()]) closePeer(id);
    if (S.stream) { S.stream.getTracks().forEach(t => t.stop()); S.stream = null; }
    S.voiceState = 'off';
    overlay.classList.add('hidden');
    btn.classList.remove('active');
  }

  function sizeCanvas() {
    canvas.width = overlay.clientWidth;
    canvas.height = overlay.clientHeight - 46; // header bar
  }
  window.addEventListener('resize', () => { if (S.on) sizeCanvas(); });

  // ---------- voice (proximity WebRTC over the LAN) ----------

  async function initVoice() {
    if (S.stream || S.voiceState === 'denied') return;
    try {
      S.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      S.voiceState = 'ready';
    } catch (_) {
      S.voiceState = 'denied';
    }
    updateHeader();
  }

  function makePeer(id, polite) {
    const pc = new RTCPeerConnection();
    const entry = { pc, audio: null, polite };
    S.peers.set(id, entry);
    if (S.stream) for (const t of S.stream.getTracks()) pc.addTrack(t, S.stream);
    pc.onicecandidate = (e) => { if (e.candidate) send({ type: 'rtc', to: id, data: { candidate: e.candidate } }); };
    pc.ontrack = (e) => {
      if (!entry.audio) {
        entry.audio = document.createElement('audio');
        entry.audio.autoplay = true;
        overlay.appendChild(entry.audio);
      }
      entry.audio.srcObject = e.streams[0];
    };
    pc.onnegotiationneeded = async () => {
      try {
        await pc.setLocalDescription(await pc.createOffer());
        send({ type: 'rtc', to: id, data: { sdp: pc.localDescription } });
      } catch (_) { /* renegotiation race */ }
    };
    return entry;
  }

  function closePeer(id) {
    const e = S.peers.get(id);
    if (!e) return;
    try { e.pc.close(); } catch (_) {}
    if (e.audio) e.audio.remove();
    S.peers.delete(id);
  }

  async function handleRtc(m) {
    if (!S.on) return;
    let entry = S.peers.get(m.from);
    if (!entry) entry = makePeer(m.from, true);
    const { pc } = entry;
    try {
      if (m.data.sdp) {
        await pc.setRemoteDescription(m.data.sdp);
        if (m.data.sdp.type === 'offer') {
          await pc.setLocalDescription(await pc.createAnswer());
          send({ type: 'rtc', to: m.from, data: { sdp: pc.localDescription } });
        }
      } else if (m.data.candidate) {
        await pc.addIceCandidate(m.data.candidate);
      }
    } catch (_) { /* glare — the polite side recovers on next negotiation */ }
  }

  function nearIds() {
    const st = chat() && chat().getState();
    if (!st) return [];
    const onlineSet = new Set(st.online || []);
    const out = [];
    for (const p of S.roster) {
      if (p.id === S.meId || !onlineSet.has(p.id)) continue;
      if (S.busy.has(p.id) || S.myBusy) continue;
      const o = posOf(p.id);
      const d = Math.hypot(o.x - S.pos.x, o.y - S.pos.y);
      if (d < VOICE_RANGE) out.push({ id: p.id, d, name: p.name });
    }
    return out;
  }

  function syncVoicePeers(near) {
    if (S.voiceState !== 'ready') return;
    const nearSet = new Set(near.map(n => n.id));
    for (const n of near) {
      if (!S.peers.has(n.id) && S.meId < n.id) makePeer(n.id, false); // deterministic initiator
    }
    for (const id of [...S.peers.keys()]) {
      if (!nearSet.has(id)) closePeer(id);
    }
    // distance-based volume
    for (const n of near) {
      const e = S.peers.get(n.id);
      if (e && e.audio) e.audio.volume = Math.max(0.15, 1 - n.d / (VOICE_RANGE * 1.4));
    }
  }

  // ---------- loop ----------

  function loop() {
    if (!S.on) return;
    let dx = 0, dy = 0;
    if (S.keys.ArrowLeft || S.keys.a) dx -= SPEED;
    if (S.keys.ArrowRight || S.keys.d) dx += SPEED;
    if (S.keys.ArrowUp || S.keys.w) dy -= SPEED;
    if (S.keys.ArrowDown || S.keys.s) dy += SPEED;
    if (dx || dy) {
      S.pos.x = Math.min(S.world.w - 16, Math.max(16, S.pos.x + dx));
      S.pos.y = Math.min(S.world.h - 16, Math.max(16, S.pos.y + dy));
    }
    const now = performance.now();
    if (now - S.lastSent > 100 && (S.pos.x !== S.lastPos.x || S.pos.y !== S.lastPos.y)) {
      S.lastSent = now;
      S.lastPos = { ...S.pos };
      send({ type: 'pos', x: Math.round(S.pos.x), y: Math.round(S.pos.y) });
    }
    const near = nearIds();
    syncVoicePeers(near);
    draw(near);
    S.raf = requestAnimationFrame(loop);
  }

  // ---------- render ----------

  let cam = { x: 0, y: 0 };

  function draw(near) {
    const W = canvas.width, H = canvas.height;
    const dark = document.documentElement.dataset.theme === 'dark';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = dark ? '#0b0f14' : '#eef1f6';
    ctx.fillRect(0, 0, W, H);

    // camera follows me
    cam.x = Math.max(0, Math.min(S.world.w - W, S.pos.x - W / 2));
    cam.y = Math.max(0, Math.min(Math.max(0, S.world.h - H), S.pos.y - H / 2));
    ctx.translate(-cam.x, -cam.y);

    const st = chat() && chat().getState();
    const onlineSet = new Set((st && st.online) || []);
    const status = window.__wholeteamStatus;

    for (const r of S.rooms) {
      ctx.fillStyle = dark ? '#151d2a' : '#ffffff';
      roundRect(r.x, r.y, r.w, r.h, 14); ctx.fill();
      ctx.strokeStyle = r.color + '55'; ctx.lineWidth = 2;
      roundRect(r.x, r.y, r.w, r.h, 14); ctx.stroke();
      ctx.fillStyle = r.color;
      ctx.font = '700 12px "Segoe UI", system-ui, sans-serif';
      ctx.fillText(r.label.toUpperCase(), r.x + 14, r.y + 20);
    }

    // desks + chairs
    for (const [pid, d] of S.desks) {
      ctx.fillStyle = dark ? '#1a2434' : '#e6ebf3';
      roundRect(d.x - 34, d.y - 14, 68, 24, 6); ctx.fill();
      ctx.beginPath(); ctx.arc(d.x, d.y + 22, 8, 0, Math.PI * 2);
      ctx.fillStyle = dark ? '#223047' : '#d3dbe7'; ctx.fill();
    }

    // avatars
    for (const p of S.roster) {
      const pos = posOf(p.id);
      const me = p.id === S.meId;
      const isOnline = me || onlineSet.has(p.id);
      const busy = S.busy.has(p.id) || (me && S.myBusy);
      ctx.globalAlpha = isOnline ? 1 : 0.35;

      ctx.beginPath(); ctx.arc(pos.x, pos.y, 15, 0, Math.PI * 2);
      ctx.fillStyle = colorFor(p.department) + (dark ? '55' : '2e'); ctx.fill();
      ctx.lineWidth = me ? 3 : 1.5;
      ctx.strokeStyle = busy ? '#e11d48' : (me ? '#0b66ff' : (dark ? '#324258' : '#c9d3e0'));
      ctx.stroke();
      ctx.fillStyle = colorFor(p.department);
      ctx.font = '700 11px "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(initials(p.name), pos.x, pos.y + 0.5);

      if (status && status.clockedIn.has(p.id)) {
        ctx.beginPath(); ctx.arc(pos.x + 11, pos.y + 11, 5, 0, Math.PI * 2);
        ctx.fillStyle = dark ? '#0b0f14' : '#eef1f6'; ctx.fill();
        ctx.beginPath(); ctx.arc(pos.x + 11, pos.y + 11, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = '#22c55e'; ctx.fill();
      }
      if (busy) {
        ctx.font = '10px "Segoe UI", system-ui, sans-serif';
        ctx.fillStyle = '#e11d48';
        ctx.fillText('door closed', pos.x, pos.y + 28);
      }

      ctx.fillStyle = dark ? '#e8eef7' : '#101828';
      ctx.font = (me ? '700 ' : '') + '11px "Segoe UI", system-ui, sans-serif';
      ctx.fillText(p.name.split(' ')[0], pos.x, pos.y - 24);
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      ctx.globalAlpha = 1;
    }

    // proximity rings + hint
    const hint = $('social-hint');
    if (near.length) {
      for (const n of near) {
        const o = posOf(n.id);
        ctx.beginPath(); ctx.arc(o.x, o.y, 22, 0, Math.PI * 2);
        ctx.strokeStyle = '#22c55e88'; ctx.lineWidth = 2; ctx.stroke();
      }
      const names = near.map(n => n.name.split(' ')[0]).join(', ');
      hint.textContent = S.voiceState === 'ready'
        ? `🎙 Talking with ${names} — click their avatar to open the text chat`
        : `With ${names} — click their avatar to chat (mic ${S.voiceState === 'denied' ? 'blocked' : 'starting'})`;
      hint.classList.remove('hidden');
    } else {
      hint.classList.add('hidden');
    }
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // ---------- input ----------

  window.addEventListener('keydown', (e) => {
    if (!S.on) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName)) return;
    if (e.key === 'Escape') { exit(); return; }
    S.keys[e.key.length === 1 ? e.key.toLowerCase() : e.key] = true;
  });
  window.addEventListener('keyup', (e) => {
    S.keys[e.key.length === 1 ? e.key.toLowerCase() : e.key] = false;
  });

  canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left + cam.x;
    const y = e.clientY - rect.top + cam.y;
    for (const p of S.roster) {
      if (p.id === S.meId) continue;
      const o = posOf(p.id);
      if (Math.hypot(o.x - x, o.y - y) < 20) {
        const c = chat();
        if (c) c.openDm(p.id);
        return;
      }
    }
  });

  function flashHint(text) {
    const hint = $('social-hint');
    hint.textContent = text;
    hint.classList.remove('hidden');
    setTimeout(() => hint.classList.add('hidden'), 3500);
  }

  // ---------- header controls ----------

  function updateHeader() {
    const door = $('social-door');
    door.textContent = S.myBusy ? '🚪 Door closed — open it' : '🚪 Close my door';
    door.classList.toggle('danger', S.myBusy);
    const mic = $('social-mic');
    mic.textContent = S.voiceState === 'ready' ? '🎙 Voice on (walk up to talk)'
      : S.voiceState === 'denied' ? '🎙 Mic blocked — check permissions'
      : '🎙 Voice starting…';
  }

  $('btn-social').addEventListener('click', () => (S.on ? exit() : enter()));
  $('social-exit').addEventListener('click', exit);
  $('social-door').addEventListener('click', () => {
    S.myBusy = !S.myBusy;
    send({ type: 'status', busy: S.myBusy });
    if (S.myBusy) for (const id of [...S.peers.keys()]) closePeer(id);
    updateHeader();
  });

  // ---------- messages from the server (via chat.js) ----------

  window.__wholeteamOffice = {
    onMessage(m) {
      if (m.type === 'pos') {
        if (m.personId !== S.meId) S.others.set(m.personId, { x: m.x, y: m.y, ts: Date.now() });
      } else if (m.type === 'status') {
        if (m.busy) S.busy.add(m.personId); else S.busy.delete(m.personId);
        if (m.busy) closePeer(m.personId);
      } else if (m.type === 'rtc') {
        handleRtc(m);
      }
    },
    onPresence(state) {
      S.busy = new Set(state.busy || []);
      // drop live positions of people who went offline
      const on = new Set(state.online || []);
      for (const id of [...S.others.keys()]) if (!on.has(id)) S.others.delete(id);
      for (const id of [...S.peers.keys()]) if (!on.has(id)) closePeer(id);
    },
  };
})();
