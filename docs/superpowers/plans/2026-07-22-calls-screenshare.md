# 1:1 Calls + Screenshare Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 1:1 audio calls with mid-call video and screen/window sharing, peer-to-peer WebRTC over the office LAN/Tailscale, signaling relayed by the existing chat server, auto-busy presence while in a call.

**Architecture:** The chat server relays call messages between the two parties and owns call state (pending/active, one call per person, auto-busy). Clients run `RTCPeerConnection` with no ICE servers, audio-first, video/screenshare as added tracks. Screenshare sources come from a new main-process IPC (`desktopCapturer`).

**Tech Stack:** Electron 33 (`desktopCapturer`, `getUserMedia`), WebRTC, plain Node `ws` server. No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-07-22-calls-screenshare-design.md`

## Global Constraints

- No new npm dependencies.
- Media is peer-to-peer ONLY — the server relays signaling JSON and never sees media.
- One active call per person (server-enforced); inviting a busy person → `call-busy` error.
- Disconnect (either side) ends the call for the peer — no hanging UI.
- Auto-busy: `call:accept` sets both parties busy via the existing statuses map + `statusChanged`; `call:end`/disconnect restores. Client dot rule: busy wins over the clocked-in check.
- Voice-note invariants stay intact (DM privacy, retention, transcription failure policy).
- All existing suites stay green: `npm test` (92), `npm run test:chat` (84), `node test/availability-smoke.js` (32).

## File Structure

- Modify `src/chat-server.js` — call state + relay handlers + auto-busy + disconnect cleanup.
- Modify `test/chat-smoke.js` — signaling tests.
- Modify `preload.js` + `main.js` — `chatGetSources` IPC via `desktopCapturer`.
- Modify `package.json` — `NSCameraUsageDescription`.
- Modify `renderer/index.html` — call overlay root div.
- Modify `renderer/chat.js` — call state machine, ring/in-call overlays, WebRTC, dot rule.
- Modify `renderer/styles.css` — call UI.

---

### Task 1: Server call signaling

**Files:**
- Modify: `src/chat-server.js` (status helpers area ~:207-226, message handlers, ws close handler ~:508-516)
- Test: `test/chat-smoke.js` (append before final `fs.rmSync`)

**Interfaces:**
- Consumes: existing `conns`, `send`, `statuses` map, `statusEntry`, `pushStatus`.
- Produces (wire protocol consumed by Task 3):
  - Client→server `{ type: 'call:invite'|'call:accept'|'call:decline'|'call:end'|'call:signal', to, data? }`
  - Server→client relays `{ type: 'call:invite'|'call:accept'|'call:decline'|'call:end'|'call:cancel'|'call:signal', from, fromName?, data? }`
  - Errors: `call-busy`, `call-offline`, `call-unknown`.

- [ ] **Step 1: Write the failing test**

Append to `test/chat-smoke.js` before the final `fs.rmSync`:

```js
  console.log('\n— 1:1 calls: invite, busy, accept, signal, end, disconnect —');
  {
    const s15 = await createChatServer({ port: PORT, roster });
    const a = await client(PORT); await sleep(80);
    a.send({ type: 'hello', personId: 'ada' }); await sleep(120);
    const b = await client(PORT); await sleep(80);
    b.send({ type: 'hello', personId: 'vic' }); await sleep(120);
    const c = await client(PORT); await sleep(80);
    c.send({ type: 'hello', personId: 'sam' }); await sleep(120);

    a.send({ type: 'call:invite', to: 'vic' });
    await sleep(150);
    ok(b.inbox.some(m => m.type === 'call:invite' && m.from === 'ada'), 'invite relayed to the target');
    ok(!c.inbox.some(m => m.type && String(m.type).startsWith('call:')), 'invite not leaked to a third person');

    c.send({ type: 'call:invite', to: 'ada' });
    await sleep(120);
    // ada has a pending outgoing invite but is not IN a call yet — second invite still allowed? No:
    // she is engaged (pending). Spec: one call per person incl. pending → busy.
    ok(c.inbox.some(m => m.type === 'error' && m.error === 'call-busy'), 'pending engagement counts as busy');

    b.send({ type: 'call:accept', to: 'ada' });
    await sleep(150);
    ok(a.inbox.some(m => m.type === 'call:accept' && m.from === 'vic'), 'accept relayed to the caller');
    const busyAda = c.inbox.concat(a.inbox).filter(m => m.type === 'statusChanged' && m.entry && m.entry.personId === 'ada').pop();
    eq(busyAda.entry.status, 'busy', 'accept auto-marks the caller busy');
    const busyVic = a.inbox.filter(m => m.type === 'statusChanged' && m.entry && m.entry.personId === 'vic').pop();
    eq(busyVic.entry.status, 'busy', 'accept auto-marks the callee busy');

    c.send({ type: 'call:invite', to: 'vic' });
    await sleep(120);
    ok(c.inbox.some(m => m.type === 'error' && m.error === 'call-busy'), 'active call = busy for new invites');

    a.send({ type: 'call:signal', to: 'vic', data: { kind: 'sdp', sdp: 'offer-blob' } });
    await sleep(120);
    ok(b.inbox.some(m => m.type === 'call:signal' && m.from === 'ada' && m.data.sdp === 'offer-blob'), 'signal relayed between the pair');
    c.send({ type: 'call:signal', to: 'vic', data: { kind: 'sdp', sdp: 'evil' } });
    await sleep(120);
    ok(!b.inbox.some(m => m.type === 'call:signal' && m.from === 'sam'), 'outsider signal not relayed');

    a.send({ type: 'call:end', to: 'vic' });
    await sleep(150);
    ok(b.inbox.some(m => m.type === 'call:end' && m.from === 'ada'), 'end relayed to the peer');
    const freeAda = a.inbox.filter(m => m.type === 'statusChanged' && m.entry && m.entry.personId === 'ada').pop();
    eq(freeAda.entry.status, 'available', 'call end restores available');

    // disconnect mid-call ends it for the peer
    a.send({ type: 'call:invite', to: 'vic' }); await sleep(120);
    b.send({ type: 'call:accept', to: 'ada' }); await sleep(120);
    a.ws.close(); await sleep(250);
    ok(b.inbox.some(m => m.type === 'call:end' && m.from === 'ada'), 'disconnect mid-call ends it for the peer');

    // invite to offline person
    b.send({ type: 'call:invite', to: 'nobody' });
    await sleep(120);
    ok(b.inbox.some(m => m.type === 'error' && m.error === 'call-offline'), 'offline target rejected');

    await s15.stop();
  }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/orgtree-mvp && npm run test:chat`
Expected: FAIL — `invite relayed to the target`

- [ ] **Step 3: Implement**

In `src/chat-server.js`:

3a. After the `pushStatus` helper, add call state + helpers:

```js
  // ----- 1:1 calls (signaling relay only — media is peer-to-peer) -----
  const pendingCalls = new Map(); // callerId -> calleeId
  const activeCalls = new Map();  // personId -> peerId (both directions)
  function sendToPerson(pid, obj) {
    for (const [sock, inf] of conns) if (inf.personId === pid) { send(sock, obj); return true; }
    return false;
  }
  function engaged(pid) { return activeCalls.has(pid) || pendingCalls.has(pid) || [...pendingCalls.values()].includes(pid); }
  function setBusy(pid, busy) {
    const s = statuses.get(pid) || {};
    s.status = busy ? 'busy' : undefined;
    statuses.set(pid, s);
    pushStatus(pid);
  }
  function clearEngagement(pid, notifyType) {
    // Pending invite where pid is the caller
    const callee = pendingCalls.get(pid);
    if (callee) {
      pendingCalls.delete(pid);
      if (notifyType) sendToPerson(callee, { type: notifyType, from: pid });
    }
    // Pending invite where pid is the callee
    for (const [caller, c2] of [...pendingCalls]) {
      if (c2 === pid) {
        pendingCalls.delete(caller);
        if (notifyType) sendToPerson(caller, { type: notifyType, from: pid });
      }
    }
    // Active call
    const peer = activeCalls.get(pid);
    if (peer != null) {
      activeCalls.delete(pid);
      activeCalls.delete(peer);
      if (notifyType) sendToPerson(peer, { type: notifyType, from: pid });
      setBusy(pid, false);
      setBusy(peer, false);
    }
  }
```

3b. Add the call handlers (place before the `if (!info) return;` line is NOT possible — calls need identity, so place them after it, e.g. right after the `status` handler):

```js
      if (m.type === 'call:invite') {
        const to = String(m.to || '');
        if (!to || to === info.personId) return;
        if (!minimalRoster.some(p => p.id === to)) { send(ws, { type: 'error', error: 'call-unknown' }); return; }
        if (engaged(info.personId) || engaged(to)) { send(ws, { type: 'error', error: 'call-busy' }); return; }
        if (!sendToPerson(to, { type: 'call:invite', from: info.personId, fromName: info.name })) {
          send(ws, { type: 'error', error: 'call-offline' });
          return;
        }
        pendingCalls.set(info.personId, to);
        return;
      }

      if (m.type === 'call:accept') {
        const caller = String(m.to || '');
        if (pendingCalls.get(caller) !== info.personId) return;
        pendingCalls.delete(caller);
        activeCalls.set(caller, info.personId);
        activeCalls.set(info.personId, caller);
        sendToPerson(caller, { type: 'call:accept', from: info.personId });
        setBusy(caller, true);
        setBusy(info.personId, true);
        return;
      }

      if (m.type === 'call:decline') {
        const caller = String(m.to || '');
        if (pendingCalls.get(caller) !== info.personId) return;
        pendingCalls.delete(caller);
        sendToPerson(caller, { type: 'call:decline', from: info.personId });
        return;
      }

      if (m.type === 'call:end') {
        const peer = String(m.to || '');
        if (activeCalls.get(info.personId) === peer || pendingCalls.get(info.personId) === peer) {
          clearEngagement(info.personId, 'call:end');
        }
        return;
      }

      if (m.type === 'call:signal') {
        const to = String(m.to || '');
        if (activeCalls.get(info.personId) !== to) return; // only paired parties
        sendToPerson(to, { type: 'call:signal', from: info.personId, data: m.data });
        return;
      }
```

3c. In the `ws.on('close')` handler, after the existing `closeSession`/`statuses.delete`/`pushStatus` lines for `info`, add:

```js
      clearEngagement(info.personId, 'call:end');
```

(placed BEFORE `conns.delete(ws)` so `sendToPerson` can still address peers by personId — note `sendToPerson` scans `conns`, and the dying socket is still present but `send` is try/caught.)

- [ ] **Step 4: Run tests**

Run: `cd ~/orgtree-mvp && npm run test:chat`
Expected: PASS — 84 + 12 new = 96 assertions.

- [ ] **Step 5: Commit**

```bash
cd ~/orgtree-mvp && git add src/chat-server.js test/chat-smoke.js
git commit -m "calls: signaling relay, one-call-per-person, auto-busy, disconnect cleanup"
```

---

### Task 2: Screenshare IPC + camera permission

**Files:**
- Modify: `preload.js` (add one line to the exposed API)
- Modify: `main.js` (new IPC handler near the chat files section ~:430)
- Modify: `package.json` (`build.mac.extendInfo`)

**Interfaces:**
- Produces: `window.orgtree.chatGetSources()` → `[{ id, name, kind: 'screen'|'window', thumbnailDataUrl }]`.

- [ ] **Step 1: IPC**

In `preload.js`, add after `chatOpenExternal`:

```js
  chatGetSources: () => ipcRenderer.invoke('chat:desktopSources'),
```

In `main.js`, add the `desktopCapturer` import to the electron require at the top of the file, and register:

```js
ipcMain.handle('chat:desktopSources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 180 },
  });
  return sources.map(s => ({
    id: s.id, name: s.name,
    kind: s.id.startsWith('screen') ? 'screen' : 'window',
    thumbnailDataUrl: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL(),
  }));
});
```

- [ ] **Step 2: Camera usage description**

In `package.json` `build.mac.extendInfo`, add after the mic string:

```json
        "NSCameraUsageDescription": "WholeTeam uses your camera only when you turn on video in a call."
```

- [ ] **Step 3: Verify + commit**

Run: `cd ~/orgtree-mvp && npm test && ORGTREE_SMOKE=1 npx electron . 2>&1 | grep SMOKE`
Expected: 92 assertions pass; SMOKE prints.

```bash
cd ~/orgtree-mvp && git add preload.js main.js package.json
git commit -m "calls: desktopCapturer sources IPC, camera usage description"
```

---

### Task 3: Client call core (audio calls, ring, overlays)

**Files:**
- Modify: `renderer/index.html` (overlay root)
- Modify: `renderer/chat.js` (handleServer handlers, DM convo header, availability rows, dotClass, new call section)

**Interfaces:**
- Consumes: Task 1 wire protocol; `sendServer`, `C.you`, `personById`, `esc`, `fmtClock` (voice task).
- Produces: call overlay ids `#call-overlay`, `.call-card`; `dotClass` busy-first rule (Task 4/5 build on the overlay).

- [ ] **Step 1: Overlay root**

In `renderer/index.html`, add before the closing `</body>` (after the toast div):

```html
  <div id="call-overlay" class="call-overlay hidden"></div>
```

- [ ] **Step 2: Call state + WebRTC core in `renderer/chat.js`**

Module-level (next to the voice state):

```js
  // ---------- 1:1 calls ----------
  let call = null; // { state: 'outgoing'|'incoming'|'active', peerId, peerName, pc, localStream, videoSender, screenSender, screenStream, startTs, timerId, ringCtx }
  const overlay = () => $('call-overlay');

  function ringStart() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0.06;
      osc.frequency.value = 880;
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start();
      const iv = setInterval(() => { try { osc.frequency.value = osc.frequency.value === 880 ? 660 : 880; } catch (_) {} }, 700);
      call.ringCtx = { ctx, osc, iv };
    } catch (_) { /* no ring */ }
  }
  function ringStop() {
    if (!call || !call.ringCtx) return;
    const { ctx, osc, iv } = call.ringCtx;
    clearInterval(iv);
    try { osc.stop(); } catch (_) {}
    try { ctx.close(); } catch (_) {}
    call.ringCtx = null;
  }

  function renderCallOverlay() {
    const el = overlay();
    if (!el) return;
    if (!call) { el.classList.add('hidden'); el.innerHTML = ''; return; }
    el.classList.remove('hidden');
    const name = esc(call.peerName || 'teammate');
    if (call.state === 'incoming') {
      el.innerHTML = `<div class="call-card">
        <b>${name}</b> is calling…
        <div class="chat-inline">
          <button class="btn primary small" id="call-accept" style="flex:1">Accept</button>
          <button class="btn danger small" id="call-decline" style="flex:1">Decline</button>
        </div>
      </div>`;
      $('call-accept').addEventListener('click', acceptCall);
      $('call-decline').addEventListener('click', () => { sendServer({ type: 'call:decline', to: call.peerId }); teardownCall(false); });
    } else if (call.state === 'outgoing') {
      el.innerHTML = `<div class="call-card">
        Calling <b>${name}</b>…
        <button class="btn ghost small" id="call-cancel" style="width:100%">Cancel</button>
      </div>`;
      $('call-cancel').addEventListener('click', () => { sendServer({ type: 'call:end', to: call.peerId }); teardownCall(false); });
    } else {
      const muted = call.localStream && !call.localStream.getAudioTracks()[0].enabled;
      el.innerHTML = `<div class="call-card active">
        <div class="call-head"><b>${name}</b><span id="call-timer">${call.startTs ? fmtClock((Date.now() - call.startTs) / 1000) : '0:00'}</span></div>
        <div class="call-videos">
          <video id="call-remote" autoplay playsinline></video>
          <video id="call-local" autoplay playsinline muted></video>
        </div>
        <div class="chat-inline">
          <button class="btn ghost small" id="call-mute">${muted ? 'Unmute' : 'Mute'}</button>
          <button class="btn ghost small" id="call-video">${call.videoSender ? 'Video off' : 'Video on'}</button>
          <button class="btn ghost small" id="call-screen">${call.screenSender ? 'Stop sharing' : 'Share screen'}</button>
          <button class="btn danger small" id="call-hangup">Hang up</button>
        </div>
      </div>`;
      $('call-mute').addEventListener('click', toggleMute);
      $('call-video').addEventListener('click', toggleVideo);
      $('call-screen').addEventListener('click', toggleScreen);
      $('call-hangup').addEventListener('click', () => { sendServer({ type: 'call:end', to: call.peerId }); teardownCall(false); });
    }
  }

  function startOutgoingCall(peerId) {
    if (call) return;
    const p = personById(peerId);
    call = { state: 'outgoing', peerId, peerName: p ? p.name : peerId };
    sendServer({ type: 'call:invite', to: peerId });
    renderCallOverlay();
  }

  async function acceptCall() {
    if (!call || call.state !== 'incoming') return;
    sendServer({ type: 'call:accept', to: call.peerId });
    await startCallMedia(false);
  }

  function makePeerConnection() {
    const pc = new RTCPeerConnection();
    pc.onicecandidate = (e) => {
      if (e.candidate) sendServer({ type: 'call:signal', to: call.peerId, data: { kind: 'ice', candidate: e.candidate } });
    };
    pc.ontrack = (e) => {
      const remote = $('call-remote');
      if (remote && e.streams[0]) remote.srcObject = e.streams[0];
    };
    // Perfect negotiation: both sides may offer (video/screenshare toggles);
    // the polite peer (callee) rolls back on collision.
    pc.onnegotiationneeded = async () => {
      try {
        call.makingOffer = true;
        await pc.setLocalDescription(await pc.createOffer());
        sendServer({ type: 'call:signal', to: call.peerId, data: { kind: 'sdp', sdp: pc.localDescription } });
      } catch (_) { /* glare/teardown race */ } finally {
        if (call) call.makingOffer = false;
      }
    };
    return pc;
  }

  async function startCallMedia(isCaller) {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (_) {
      C.notice = 'Microphone unavailable — check macOS mic permission.';
      sendServer({ type: 'call:end', to: call.peerId });
      teardownCall(false);
      return;
    }
    ringStop();
    call.state = 'active';
    call.polite = !isCaller; // callee rolls back on offer collision
    call.makingOffer = false;
    call.localStream = stream;
    call.startTs = Date.now();
    call.pc = makePeerConnection();
    stream.getTracks().forEach(t => call.pc.addTrack(t, stream));
    call.timerId = setInterval(() => {
      const el = $('call-timer');
      if (el && call) el.textContent = fmtClock((Date.now() - call.startTs) / 1000);
    }, 1000);
    renderCallOverlay();
    const local = $('call-local');
    if (local) local.srcObject = stream;
  }

  async function handleSignal(data) {
    const pc = call && call.pc;
    if (!pc || !data) return;
    try {
      if (data.kind === 'sdp') {
        const collision = data.sdp.type === 'offer' && (call.makingOffer || pc.signalingState !== 'stable');
        if (!call.polite && collision) return; // impolite peer wins the glare
        if (collision) await pc.setLocalDescription({ type: 'rollback' });
        await pc.setRemoteDescription(data.sdp);
        if (data.sdp.type === 'offer') {
          await pc.setLocalDescription(await pc.createAnswer());
          sendServer({ type: 'call:signal', to: call.peerId, data: { kind: 'sdp', sdp: pc.localDescription } });
        }
      } else if (data.kind === 'ice') {
        await pc.addIceCandidate(data.candidate);
      }
    } catch (_) { /* stale signaling during teardown */ }
  }

  function toggleMute() {
    if (!call || !call.localStream) return;
    const t = call.localStream.getAudioTracks()[0];
    if (t) t.enabled = !t.enabled;
    renderCallOverlay();
  }

  function teardownCall(notify) {
    if (!call) return;
    ringStop();
    clearInterval(call && call.timerId);
    if (notify && call.peerId) sendServer({ type: 'call:end', to: call.peerId });
    if (call.localStream) call.localStream.getTracks().forEach(t => t.stop());
    if (call.screenStream) call.screenStream.getTracks().forEach(t => t.stop());
    if (call.pc) { try { call.pc.close(); } catch (_) {} }
    call = null;
    renderCallOverlay();
    if (C.view) render();
  }
```

- [ ] **Step 3: Signaling handlers in `handleServer`**

Add (before the final unknown-message fall-through, after `statusChanged`):

```js
    if (m.type === 'call:invite') {
      if (call) return; // server enforces busy too; this is belt-and-braces
      call = { state: 'incoming', peerId: m.from, peerName: m.fromName };
      ringStart();
      renderCallOverlay();
      return;
    }
    if (m.type === 'call:cancel' || m.type === 'call:end') {
      if (call && call.peerId === m.from) { C.notice = 'Call ended.'; teardownCall(false); }
      return;
    }
    if (m.type === 'call:accept') {
      if (call && call.state === 'outgoing' && call.peerId === m.from) startCallMedia(true);
      return;
    }
    if (m.type === 'call:decline') {
      if (call && call.state === 'outgoing' && call.peerId === m.from) { C.notice = (call.peerName || 'They') + ' declined the call.'; teardownCall(false); }
      return;
    }
    if (m.type === 'call:signal') {
      if (call && call.peerId === m.from) handleSignal(m.data);
      return;
    }
```

In the `error` handler, add:

```js
      else if (m.error === 'call-busy') { C.error = 'They are in another call.'; if (call && call.state === 'outgoing') teardownCall(false); }
      else if (m.error === 'call-offline') { C.error = 'They are not connected right now.'; if (call && call.state === 'outgoing') teardownCall(false); }
```

Also call `teardownCall(false)` in `disconnect()` and in `ws.onclose` (next to `resetVoice()`).

- [ ] **Step 4: Call buttons + busy dot rule**

In `renderConvo`, add a call button to the DM header buttons (next to `libBtn`, DM-only):

```js
    const callBtn = isDm ? `<button class="chat-icon-btn" id="chat-call" title="Start a call"><svg class="icon"><use href="#i-phone"/></svg></button>` : '';
```

(include `callBtn` in the `buttons:` option, and wire:)

```js
    const callb = $('chat-call');
    if (callb) callb.addEventListener('click', () => startOutgoingCall(otherId));
```

In `renderAvailability`, add a per-row call button (never on your own row):

```js
          ${p.id !== C.you.id ? `<button class="chat-icon-btn avail-call" data-id="${esc(p.id)}" title="Call ${esc(p.name)}"><svg class="icon"><use href="#i-phone"/></svg></button>` : ''}
```

(wire with `panel.querySelectorAll('.avail-call').forEach(b => b.addEventListener('click', () => startOutgoingCall(b.dataset.id)))`.)

In `dotClass`, make busy win over the clocked-in check:

```js
  function dotClass(pid) {
    const e = C.statuses.get(pid);
    if (e && e.status === 'busy') return 'busy';
    if (e && e.clockedIn) return 'on';
    // ...unchanged schedule checks...
  }
```

- [ ] **Step 5: Verify + commit**

Run: `cd ~/orgtree-mvp && node --check renderer/chat.js && npm test && npm run test:chat && ORGTREE_SMOKE=1 npx electron . 2>&1 | grep SMOKE`
Expected: all green.

```bash
cd ~/orgtree-mvp && git add renderer/chat.js renderer/index.html
git commit -m "calls: audio call core — ring, overlays, WebRTC signaling, busy dot"
```

---

### Task 4: Video toggle + screenshare picker

**Files:**
- Modify: `renderer/chat.js` (toggleVideo, toggleScreen implementations + picker modal)

**Interfaces:**
- Consumes: `window.orgtree.chatGetSources()` (Task 2); `call.pc`, `call.videoSender`, `call.screenSender` (Task 3).

- [ ] **Step 1: Video toggle**

```js
  async function toggleVideo() {
    if (!call || !call.pc) return;
    if (call.videoSender) {
      const track = call.videoSender.track;
      call.pc.removeTrack(call.videoSender);
      if (track) track.stop();
      call.videoSender = null;
    } else {
      try {
        const vs = await navigator.mediaDevices.getUserMedia({ video: true });
        const track = vs.getVideoTracks()[0];
        call.localStream.addTrack(track);
        call.videoSender = call.pc.addTrack(track, call.localStream);
        const local = $('call-local');
        if (local) local.srcObject = call.localStream;
      } catch (_) {
        C.notice = 'Camera unavailable — check macOS camera permission.';
        render();
      }
    }
    renderCallOverlay();
  }
```

- [ ] **Step 2: Screenshare picker + toggle**

```js
  async function toggleScreen() {
    if (!call || !call.pc) return;
    if (call.screenSender) { stopScreenShare(); renderCallOverlay(); return; }
    let sources;
    try { sources = await window.orgtree.chatGetSources(); } catch (_) { sources = []; }
    if (!sources.length) { C.notice = 'No screens or windows to share (check Screen Recording permission).'; render(); return; }
    const pick = await pickSource(sources);
    if (!pick) return;
    try {
      const ss = await navigator.mediaDevices.getUserMedia({
        video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: pick.id, maxWidth: 1920, maxHeight: 1080, maxFrameRate: 15 } },
        audio: false,
      });
      call.screenStream = ss;
      const track = ss.getVideoTracks()[0];
      track.onended = () => { if (call && call.screenSender) { stopScreenShare(); renderCallOverlay(); } };
      if (call.videoSender) {
        call.screenSender = call.videoSender;
        await call.videoSender.replaceTrack(track);
      } else {
        call.screenSender = call.pc.addTrack(track, ss);
      }
    } catch (_) {
      C.notice = 'Screen sharing failed — check Screen Recording permission.';
      render();
    }
    renderCallOverlay();
  }

  function stopScreenShare() {
    if (!call || !call.screenSender) return;
    if (call.screenStream) { call.screenStream.getTracks().forEach(t => t.stop()); call.screenStream = null; }
    if (call.videoSender && call.screenSender === call.videoSender) {
      const camTrack = call.localStream.getVideoTracks()[0] || null;
      call.videoSender.replaceTrack(camTrack); // back to camera (or black if camera off)
      call.screenSender = null;
    } else {
      call.pc.removeTrack(call.screenSender);
      call.screenSender = null;
    }
  }

  function pickSource(sources) {
    return new Promise((resolve) => {
      const el = overlay();
      el.classList.remove('hidden');
      el.innerHTML = `<div class="call-card source-picker">
        <b>Share what?</b>
        <div class="source-grid">
          ${sources.map(s => `<button class="source-item" data-id="${esc(s.id)}">
            ${s.thumbnailDataUrl ? `<img src="${esc(s.thumbnailDataUrl)}" alt="">` : ''}
            <span>${esc(s.name)}</span><em>${s.kind}</em>
          </button>`).join('')}
        </div>
        <button class="btn ghost small" id="source-cancel" style="width:100%">Cancel</button>
      </div>`;
      el.querySelectorAll('.source-item').forEach(b => b.addEventListener('click', () => { renderCallOverlay(); resolve(sources.find(s => s.id === b.dataset.id)); }));
      $('source-cancel').addEventListener('click', () => { renderCallOverlay(); resolve(null); });
    });
  }
```

- [ ] **Step 3: Verify + commit**

Run: `cd ~/orgtree-mvp && node --check renderer/chat.js && npm run test:chat && ORGTREE_SMOKE=1 npx electron . 2>&1 | grep SMOKE`

```bash
cd ~/orgtree-mvp && git add renderer/chat.js
git commit -m "calls: video toggle + screen/window sharing with source picker"
```

---

### Task 5: Styles

**Files:**
- Modify: `renderer/styles.css` (append)

- [ ] **Step 1: Append**

```css
/* ---------- calls ---------- */
.call-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.45); display: flex; align-items: center; justify-content: center; z-index: 60; }
.call-overlay.hidden { display: none; }
.call-card { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 18px; width: 340px; display: flex; flex-direction: column; gap: 12px; box-shadow: 0 12px 40px rgba(0,0,0,0.3); }
.call-card.active { width: 520px; }
.call-head { display: flex; justify-content: space-between; align-items: center; }
.call-videos { position: relative; background: #000; border-radius: 10px; aspect-ratio: 16/9; overflow: hidden; }
#call-remote { width: 100%; height: 100%; object-fit: contain; }
#call-local { position: absolute; right: 8px; bottom: 8px; width: 120px; border-radius: 8px; border: 1px solid var(--border-strong); background: #111; }
.source-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; max-height: 320px; overflow-y: auto; }
.source-item { display: flex; flex-direction: column; gap: 4px; background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 6px; cursor: pointer; color: var(--text); text-align: left; }
.source-item:hover { border-color: var(--accent); }
.source-item img { width: 100%; border-radius: 6px; }
.source-item span { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.source-item em { font-size: 10px; color: var(--muted); font-style: normal; text-transform: uppercase; }
.avail-call { flex: none; }
```

- [ ] **Step 2: Commit**

```bash
cd ~/orgtree-mvp && git add renderer/styles.css
git commit -m "styles: call overlays, videos, source picker"
```

---

### Task 6: Version bump, verification, build + install

**Files:**
- Modify: `package.json` (`"version": "1.7.0"` → `"1.8.0"`)

- [ ] **Step 1: Bump + lockfile**

```bash
cd ~/orgtree-mvp && npm pkg set version=1.8.0 && npm install --package-lock-only --no-audit --no-fund
```

- [ ] **Step 2: Full verification**

Run: `cd ~/orgtree-mvp && npm test && npm run test:chat && node test/availability-smoke.js && ORGTREE_SMOKE=1 npx electron . 2>&1 | grep SMOKE`
Expected: 92 + 96 + 32 assertions; SMOKE prints.

- [ ] **Step 3: Build + install**

```bash
cd ~/orgtree-mvp && npx electron-builder --mac dir --arm64 2>&1 | tail -3
osascript -e 'quit app "WholeTeam"' 2>/dev/null; sleep 2; pkill -f "WholeTeam.app" 2>/dev/null; sleep 1
rm -rf /Applications/WholeTeam.app && cp -R dist/mac-arm64/WholeTeam.app /Applications/
xattr -dr com.apple.quarantine /Applications/WholeTeam.app
defaults read /Applications/WholeTeam.app/Contents/Info.plist CFBundleShortVersionString
open -a /Applications/WholeTeam.app && sleep 6 && pgrep -fl "WholeTeam.app/Contents/MacOS"
```

Expected: `1.8.0`, app running.

- [ ] **Step 4: Commit**

```bash
cd ~/orgtree-mvp && git add package.json package-lock.json
git commit -m "1.8.0: 1:1 calls + screenshare"
```

---

## Self-Review Notes

- Spec coverage: signaling relay + busy + disconnect cleanup (Task 1), screenshare IPC + camera string (Task 2), audio-first core + ring + overlays + auto-busy dot (Task 3), video + screenshare (Task 4), styles (Task 5), build (Task 6).
- `call:end` from a pending caller uses the same `clearEngagement` with notifyType — the callee's incoming overlay treats `call:end`/`call:cancel` identically (server sends `call:end` for both paths; the `call:cancel` type exists for future use, client handles both).
- Manual acceptance (two instances, audio → video → screenshare → hang up) is the user's step; media paths are not headless-testable.
- Git commits pre-authorized for this execution flow.
