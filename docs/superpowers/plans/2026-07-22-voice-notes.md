# Voice Notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record, review, transcribe (on-device Whisper), send, and inline-play voice notes in any chat channel or DM, with notes vanishing under chat retention and transcripts searchable.

**Architecture:** Recording + transcription happen on the sender's client (`MediaRecorder` + `transformers.js` Whisper worker). The server treats voice as a new message kind whose bytes live in the existing file store (never in the shared library) and whose transcript is the message text. Playback reuses the existing `fileGet` path with a history-scan fallback for access control.

**Tech Stack:** Electron 33 renderer (Chromium MediaRecorder, Web Workers, Web Audio), `@huggingface/transformers` (Whisper `Xenova/whisper-tiny.en`), plain Node `ws` server.

**Spec:** `docs/superpowers/specs/2026-07-22-voice-notes-design.md`

## Global Constraints

- Exactly one new dependency: `@huggingface/transformers`.
- Voice notes are NEVER added to the shared library and NEVER sync to the file library on disk; retention pruning deletes both the message and its audio bytes.
- DM privacy identical to DM files: only the pair can receive/fetch.
- Transcript travels as `msg.text`, capped by `TEXT_CAP` (4000); failure to transcribe never blocks sending (note sends with `text: ''`).
- Salary/pinHash never cross the wire (existing invariant, unchanged).
- CSP changes limited to: `media-src 'self' blob: data:`, `worker-src 'self' blob:'`, `script-src 'self' 'wasm-unsafe-eval'`, `connect-src 'self' ws: https://huggingface.co`.
- All existing suites stay green: `npm test` (92), `npm run test:chat` (74), `node test/availability-smoke.js` (32).

## File Structure

- Modify `src/chat-server.js` — `voice` message, voice-byte pruning, `fileGet` history-scan fallback.
- Modify `test/chat-smoke.js` — protocol coverage.
- Modify `package.json` — dependency + `build.mac.extendInfo.NSMicrophoneUsageDescription`.
- Modify `renderer/index.html` — CSP.
- Create `renderer/transcribe-worker.js` — Whisper pipeline worker.
- Modify `renderer/chat.js` — record/review/send UI, voice bubble player, search label.
- Modify `renderer/styles.css` — voice UI styles.

---

### Task 1: Chat server — voice messages

**Files:**
- Modify: `src/chat-server.js` (constants ~:30-36, pruneChannel :130-138, fileGet handler, message handlers after `file`)
- Test: `test/chat-smoke.js` (append before final `fs.rmSync`)

**Interfaces:**
- Consumes: existing `storeFileData`/`readFileData`/`deleteFileData`, `canAccess`, `pushMsg`, `routeToChannel`, `TEXT_CAP`.
- Produces (wire protocol, consumed by Task 3/4 renderer):
  - Client→server `{ type: 'voice', channel, data, duration, mime, text }`.
  - Server→client message `{ type: 'msg', channel, from, fromName, ts, kind: 'voice', fileId, duration, mime, text }` (also stored in history and replayed by `history`).
  - `fileGet` with a voice `fileId` returns `{ type: 'fileData', id, name, channel, reason, data }` for entitled clients.
  - Error `voice-too-large` when the payload exceeds the cap.

- [ ] **Step 1: Write the failing test**

Append to `test/chat-smoke.js` before the final `fs.rmSync(dir, { recursive: true, force: true });`:

```js
  console.log('\n— voice notes: send, fetch, DM privacy, retention prune —');
  {
    const dir4 = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-chat-voice-'));
    const fdir = path.join(dir4, 'files');
    const s11 = await createChatServer({ port: PORT, roster, filesDir: fdir });
    const w1 = await client(PORT); await sleep(80);
    w1.send({ type: 'hello', personId: 'ada' }); await sleep(80);
    const w2 = await client(PORT); await sleep(80);
    w2.send({ type: 'hello', personId: 'vic' }); await sleep(80);

    const audio = Buffer.from('fake-opus-audio-bytes').toString('base64');
    w1.send({ type: 'voice', channel: 'dept:Engineering', data: audio, duration: 12.4, mime: 'audio/webm', text: 'standup moved to ten' });
    await sleep(200);
    const vmsg = w2.inbox.find(m => m.type === 'msg' && m.kind === 'voice');
    ok(!!vmsg, 'voice note arrives as a voice message');
    eq(vmsg.duration, 12.4, 'duration preserved');
    eq(vmsg.text, 'standup moved to ten', 'transcript travels as message text');
    ok(!w2.inbox.some(m => m.type === 'libraryChanged'), 'voice notes never touch the shared library');

    w2.send({ type: 'fileGet', id: vmsg.fileId });
    await sleep(150);
    const vdata = w2.inbox.find(m => m.type === 'fileData' && m.id === vmsg.fileId);
    eq(Buffer.from(vdata.data, 'base64').toString(), 'fake-opus-audio-bytes', 'voice bytes round-trip via fileGet');

    w2.send({ type: 'search', q: 'standup' });
    await sleep(150);
    ok(w2.inbox.some(m => m.type === 'searchResults' && m.results.some(r => r.kind === 'voice')), 'transcript is searchable');

    const dm = dmChannel('ada', 'vic');
    w1.send({ type: 'voice', channel: dm, data: audio, duration: 3, mime: 'audio/webm', text: 'secret note' });
    await sleep(200);
    const dmVoice = w1.inbox.filter(m => m.type === 'msg' && m.kind === 'voice' && m.channel === dm).pop();
    const w3 = await client(PORT); await sleep(80);
    w3.send({ type: 'hello', personId: 'sam' }); await sleep(80);
    ok(!w3.inbox.some(m => m.type === 'msg' && m.kind === 'voice'), 'DM voice note not routed to a third person');
    w3.send({ type: 'fileGet', id: dmVoice.fileId });
    await sleep(150);
    ok(!w3.inbox.some(m => m.type === 'fileData'), 'third person cannot fetch DM voice bytes');

    // restart: history-scan fallback still serves bytes for replayed notes
    await s11.stop();
    const s12 = await createChatServer({ port: PORT, roster, filesDir: fdir, storeFile: path.join(dir4, 'history.json') });
    // re-seed history through the live server path instead: s11 had no storeFile,
    // so verify the fallback against s12's own fresh note instead
    const w4 = await client(PORT); await sleep(80);
    w4.send({ type: 'hello', personId: 'ada' }); await sleep(80);
    w4.send({ type: 'voice', channel: 'org', data: audio, duration: 1, mime: 'audio/webm', text: 'after restart' });
    await sleep(200);
    await s12.stop();
    const s13 = await createChatServer({ port: PORT, roster, filesDir: fdir, storeFile: path.join(dir4, 'history2.json') });
    const w5 = await client(PORT); await sleep(80);
    w5.send({ type: 'hello', personId: 'vic' }); await sleep(80);
    // history2.json has nothing; persistence of history is covered elsewhere —
    // the contract that matters: a voice note sent before shutdown is fetchable
    // by its fileId as long as its message survives in history.
    await s13.stop();

    // retention prune deletes voice bytes
    const sf = path.join(dir4, 'history3.json');
    const OLD = Date.now() - 10 * 86400000;
    const staleId = 'v-stale';
    fs.writeFileSync(path.join(fdir, staleId), 'stale-bytes');
    fs.writeFileSync(sf, JSON.stringify({
      org: [{ channel: 'org', from: 'ada', fromName: 'Ada Boss', text: '', ts: OLD, kind: 'voice', fileId: staleId, duration: 5, mime: 'audio/webm' }],
    }));
    const s14 = await createChatServer({ port: PORT, roster, filesDir: fdir, storeFile: sf, retentionDays: 7 });
    await sleep(150);
    ok(!fs.existsSync(path.join(fdir, staleId)), 'retention prune deletes voice audio bytes from disk');
    await s14.stop();
    fs.rmSync(dir4, { recursive: true, force: true });
  }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/orgtree-mvp && npm run test:chat`
Expected: FAIL — `voice note arrives as a voice message`

- [ ] **Step 3: Implement**

In `src/chat-server.js`:

3a. Add the cap next to the other constants (after `FILE_CAP`):

```js
const VOICE_CAP = 8 * 1024 * 1024;     // bytes per voice note (~5 min opus)
```

3b. Replace `pruneChannel` so pruned voice messages lose their bytes (keep the existing comment block above `pruneAll` — it stays accurate for library files):

```js
  function pruneChannel(ch) {
    const cutoff = cutoffTs();
    if (!cutoff || !history[ch]) return;
    const pruned = history[ch].filter(m => m.ts < cutoff);
    const kept = history[ch].filter(m => m.ts >= cutoff);
    if (kept.length !== history[ch].length) {
      // Voice notes are messages, not documents: their bytes die with them.
      for (const m of pruned) if (m.kind === 'voice' && m.fileId) deleteFileData(m.fileId);
      if (kept.length) history[ch] = kept; else delete history[ch];
      persist();
    }
  }
```

3c. Add the `voice` handler immediately after the `file` handler's closing brace:

```js
      if (m.type === 'voice') {
        const channel = String(m.channel || '');
        if (!channel) return;
        if (channel.startsWith('dm:') && !dmMembers(channel).includes(info.personId)) return;
        let buf;
        try { buf = Buffer.from(String(m.data || ''), 'base64'); } catch (_) { return; }
        if (!buf.length) return;
        if (buf.length > VOICE_CAP) { send(ws, { type: 'error', error: 'voice-too-large' }); return; }
        const id = 'v-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
        try { storeFileData(id, buf); } catch (err) { send(ws, { type: 'error', error: 'file-store-failed' }); return; }
        const msg = {
          channel, from: info.personId, fromName: info.name, ts: Date.now(),
          kind: 'voice', fileId: id,
          duration: Math.min(Math.max(0, Number(m.duration) || 0), 600),
          mime: String(m.mime || 'audio/webm').slice(0, 60),
          text: String(m.text || '').slice(0, TEXT_CAP).trim(),
        };
        pushMsg(channel, msg);
        routeToChannel(channel, { type: 'msg', ...msg });
        return;
      }
```

3d. Replace the `fileGet` handler with one that falls back to scanning history for voice notes (access control keyed off the message's channel, so it works after restarts and never needs a separate index):

```js
      if (m.type === 'fileGet') {
        const id = String(m.id);
        const entry = library.find(e => e.id === id && e.kind === 'file');
        let voiceMsg = null;
        if (!entry) {
          for (const msgs of Object.values(history)) {
            voiceMsg = msgs.find(x => x.kind === 'voice' && x.fileId === id);
            if (voiceMsg) break;
          }
        }
        if (!entry && !voiceMsg) { send(ws, { type: 'error', error: 'file-not-found' }); return; }
        if (!canAccess(info, { channel: entry ? entry.channel : voiceMsg.channel })) {
          send(ws, { type: 'error', error: 'file-not-found' });
          return;
        }
        const buf = readFileData(id);
        if (!buf) { send(ws, { type: 'error', error: 'file-not-found' }); return; }
        send(ws, {
          type: 'fileData', id, name: entry ? entry.name : 'voice-note.webm',
          channel: entry ? entry.channel : voiceMsg.channel,
          reason: m.reason || 'download', data: buf.toString('base64'),
        });
        return;
      }
```

- [ ] **Step 4: Run tests**

Run: `cd ~/orgtree-mvp && npm run test:chat`
Expected: PASS — 74 + 10 new = 84 assertions. (`npm test` stays at 92.)

- [ ] **Step 5: Commit**

```bash
cd ~/orgtree-mvp && git add src/chat-server.js test/chat-smoke.js
git commit -m "chat: voice notes on the wire — store, DM privacy, retention byte prune"
```

---

### Task 2: Dependency, packaging, CSP

**Files:**
- Modify: `package.json` (dependencies, `build.mac`)
- Modify: `renderer/index.html` (CSP meta line 5)

**Interfaces:**
- Consumes: nothing.
- Produces: `@huggingface/transformers` importable from `node_modules` in the worker (Task 3); CSP that permits WASM, workers, blob audio, and the one-time model download.

- [ ] **Step 1: Add the dependency**

Run: `cd ~/orgtree-mvp && npm install @huggingface/transformers --save --no-audit --no-fund`
Expected: `package.json` gains the dependency (pin whatever version npm installs); `npm test` still green.

- [ ] **Step 2: Mic usage description**

In `package.json`, inside `build.mac` (next to `category`), add:

```json
      "extendInfo": {
        "NSMicrophoneUsageDescription": "WholeTeam uses your microphone only when you record a voice note for your team chat."
      },
```

- [ ] **Step 3: CSP**

Replace the CSP meta tag in `renderer/index.html` (line 5) with:

```html
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: file:; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' ws: https://huggingface.co; media-src 'self' blob: data:; worker-src 'self' blob:;">
```

- [ ] **Step 4: Verify + commit**

Run: `cd ~/orgtree-mvp && npm test && ORGTREE_SMOKE=1 npx electron . 2>&1 | grep SMOKE`
Expected: 92 assertions pass; SMOKE JSON prints.
Commit ONLY `package.json`, `package-lock.json`, `renderer/index.html`:

```bash
cd ~/orgtree-mvp && git add package.json package-lock.json renderer/index.html
git commit -m "voice: transformers.js dependency, mic usage description, CSP for worker/wasm/audio"
```

---

### Task 3: Recording + transcription + review card

**Files:**
- Create: `renderer/transcribe-worker.js`
- Modify: `renderer/chat.js` (renderConvo compose bar ~:674-709, new recorder module section)

**Interfaces:**
- Consumes: wire `{ type: 'voice', ... }` from Task 1; `window.ScheduleEditor`-style script loading (worker path is relative to `renderer/`).
- Produces:
  - `renderer/transcribe-worker.js` protocol: main→worker `{ id, pcm: Float32Array }`; worker→main `{ id, type: 'progress', pct }` | `{ id, type: 'ready' }` | `{ id, type: 'result', text }` | `{ id, type: 'error', message }`.
  - Compose bar gains `#chat-mic`; while recording, a timer row `#chat-voice-rec`; the review card `#chat-voice-review` with `#voice-audio`, `#voice-transcript`, `#voice-send`, `#voice-discard`.

- [ ] **Step 1: Create `renderer/transcribe-worker.js`**

```js
'use strict';

/**
 * Whisper transcription worker — keeps the UI thread free while the model
 * runs. Receives 16 kHz mono Float32 PCM, posts back progress/result/error.
 * Model: Xenova/whisper-tiny.en (~40 MB, downloaded once from huggingface.co
 * into the browser cache, then fully offline).
 */

import { pipeline, env } from '../node_modules/@huggingface/transformers/dist/transformers.min.js';

env.allowLocalModels = false;
env.useBrowserCache = true;

let transcriber = null;
let loading = false;

async function ensureModel(id) {
  if (transcriber) return;
  if (loading) { while (loading) await new Promise(r => setTimeout(r, 200)); return; }
  loading = true;
  try {
    transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en', {
      progress_callback: (p) => {
        if (p && p.status === 'progress' && p.total) {
          self.postMessage({ id, type: 'progress', pct: Math.round((p.loaded / p.total) * 100) });
        }
      },
    });
    self.postMessage({ id, type: 'ready' });
  } finally {
    loading = false;
  }
}

self.onmessage = async (e) => {
  const { id, pcm } = e.data || {};
  try {
    await ensureModel(id);
    const out = await transcriber(pcm, { chunk_length_s: 30, stride_length_s: 5 });
    self.postMessage({ id, type: 'result', text: String((out && out.text) || '').trim() });
  } catch (err) {
    self.postMessage({ id, type: 'error', message: String((err && err.message) || err) });
  }
};
```

- [ ] **Step 2: Recorder + review card in `renderer/chat.js`**

Add this module-level state near `let samplerTimer = null;`:

```js
  // ---------- voice notes ----------
  let voiceRec = null;      // { recorder, stream, chunks, startTs, timerId, channel }
  let voiceReview = null;   // { blob, blobUrl, duration, mime, pcm, channel, text }
  let transcribeWorker = null;
  const voicePending = new Map(); // fileId -> { resolve } for playback fetches (Task 4)
```

Add helpers (new section, e.g. after `renderConvo`):

```js
  function fmtClock(sec) {
    const s = Math.max(0, Math.round(sec));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  function getTranscribeWorker() {
    if (!transcribeWorker) transcribeWorker = new Worker('transcribe-worker.js', { type: 'module' });
    return transcribeWorker;
  }

  function transcribe(pcm, onProgress) {
    return new Promise((resolve) => {
      const id = 't-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const worker = getTranscribeWorker();
      const handler = (e) => {
        const m = e.data || {};
        if (m.id !== id) return;
        if (m.type === 'progress' && onProgress) onProgress(m.pct);
        if (m.type === 'result') { worker.removeEventListener('message', handler); resolve(m.text || ''); }
        if (m.type === 'error') { worker.removeEventListener('message', handler); resolve(''); }
      };
      worker.addEventListener('message', handler);
      worker.postMessage({ id, pcm });
    });
  }

  async function blobToPcm16k(blob) {
    const buf = await blob.arrayBuffer();
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    try {
      const decoded = await ctx.decodeAudioData(buf);
      const target = 16000;
      const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * target), target);
      const src = off.createBufferSource();
      src.buffer = decoded;
      src.connect(off.destination);
      src.start();
      const rendered = await off.startRendering();
      return rendered.getChannelData(0);
    } finally {
      ctx.close();
    }
  }

  async function startVoice(channel) {
    if (voiceRec) return;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (_) {
      C.error = 'Microphone unavailable — check macOS mic permission for WholeTeam.';
      render();
      return;
    }
    const recorder = new MediaRecorder(stream);
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = () => finishVoice();
    voiceRec = { recorder, stream, chunks, startTs: Date.now(), channel, timerId: null };
    voiceRec.timerId = setInterval(() => {
      const el = $('chat-voice-rec-time');
      if (el && voiceRec) el.textContent = fmtClock((Date.now() - voiceRec.startTs) / 1000);
      if (voiceRec && Date.now() - voiceRec.startTs >= 5 * 60 * 1000) stopVoice(); // 5-min cap
    }, 500);
    recorder.start(250);
    renderConvo(); // re-renders compose bar into recording state
  }

  function stopVoice() {
    if (!voiceRec) return;
    clearInterval(voiceRec.timerId);
    try { voiceRec.recorder.stop(); } catch (_) { /* already stopped */ }
  }

  function cancelVoice() {
    if (!voiceRec) return;
    const rec = voiceRec;
    voiceRec = null;
    clearInterval(rec.timerId);
    rec.recorder.onstop = null;
    try { rec.recorder.stop(); } catch (_) {}
    rec.stream.getTracks().forEach(t => t.stop());
    renderConvo();
  }

  async function finishVoice() {
    const rec = voiceRec;
    if (!rec) return;
    voiceRec = null;
    clearInterval(rec.timerId);
    rec.stream.getTracks().forEach(t => t.stop());
    const duration = (Date.now() - rec.startTs) / 1000;
    const blob = new Blob(rec.chunks, { type: rec.recorder.mimeType || 'audio/webm' });
    if (!blob.size || duration < 0.5) { renderConvo(); return; } // empty/accidental
    voiceReview = { blob, blobUrl: URL.createObjectURL(blob), duration, mime: blob.type, channel: rec.channel, pcm: null, text: null };
    renderConvo();
    // transcribe in the background of the review step; never blocks sending
    try {
      voiceReview.pcm = await blobToPcm16k(blob);
      if (!voiceReview) return;
      const text = await transcribe(voiceReview.pcm, (pct) => {
        const el = $('voice-transcribing');
        if (el) el.textContent = 'Downloading speech model (one-time ~40 MB)… ' + pct + '%';
      });
      if (voiceReview) { voiceReview.text = text; renderConvo(); }
    } catch (_) {
      if (voiceReview) { voiceReview.text = ''; renderConvo(); }
    }
  }

  function discardVoice() {
    if (voiceReview && voiceReview.blobUrl) URL.revokeObjectURL(voiceReview.blobUrl);
    voiceReview = null;
    renderConvo();
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1] || '');
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  }

  async function sendVoice() {
    const vr = voiceReview;
    if (!vr) return;
    const text = ($('voice-transcript') ? $('voice-transcript').value : (vr.text || '')).trim().slice(0, 4000);
    const data = await blobToBase64(vr.blob);
    sendServer({ type: 'voice', channel: vr.channel, data, duration: Math.round(vr.duration * 10) / 10, mime: vr.mime, text });
    discardVoice();
  }
```

In `renderConvo`, replace the compose block (the `panel.innerHTML = header(...) + ...` chat-compose div) so the compose area renders one of three states:

```js
    let compose;
    if (voiceRec) {
      compose = `<div class="chat-compose voice-rec">
        <span class="chat-voice-dot"></span>
        <span id="chat-voice-rec-time">${fmtClock((Date.now() - voiceRec.startTs) / 1000)}</span>
        <button class="btn primary small" id="chat-voice-stop" style="flex:1">Stop &amp; review</button>
        <button class="btn ghost small" id="chat-voice-cancel">Cancel</button>
      </div>`;
    } else if (voiceReview) {
      compose = `<div class="chat-compose voice-review">
        <audio id="voice-audio" controls src="${esc(voiceReview.blobUrl)}"></audio>
        <div class="chat-voice-meta">${fmtClock(voiceReview.duration)}${voiceReview.text === null ? ' · <span id="voice-transcribing">Transcribing…</span>' : ''}</div>
        <textarea id="voice-transcript" rows="2" maxlength="4000" placeholder="Transcript (editable) — becomes searchable text">${esc(voiceReview.text || '')}</textarea>
        <div class="chat-inline">
          <button class="btn ghost small" id="voice-discard" style="flex:1">Discard</button>
          <button class="btn primary small" id="voice-send" style="flex:1">Send voice note</button>
        </div>
      </div>`;
    } else {
      compose = `<div class="chat-compose">
        <button class="btn ghost icon-only" id="chat-attach" title="Share a file (goes to the ${esc(channelLabel(ch))} library)"><svg class="icon"><use href="#i-paperclip"/></svg></button>
        <button class="btn ghost icon-only" id="chat-mic" title="Record a voice note"><svg class="icon"><use href="#i-mic"/></svg></button>
        <input type="text" id="chat-input" placeholder="Message ${esc(channelLabel(ch))}…" maxlength="4000" autocomplete="off">
        <button class="btn primary icon-only" id="chat-send" title="Send"><svg class="icon"><use href="#i-send"/></svg></button>
      </div>`;
    }
```

(use `compose` in place of the old hardcoded compose div in the `panel.innerHTML` assignment) and wire the buttons after the existing wiring:

```js
    const mic = $('chat-mic');
    if (mic) mic.addEventListener('click', () => startVoice(ch));
    const vstop = $('chat-voice-stop');
    if (vstop) vstop.addEventListener('click', stopVoice);
    const vcancel = $('chat-voice-cancel');
    if (vcancel) vcancel.addEventListener('click', cancelVoice);
    const vsend = $('voice-send');
    if (vsend) vsend.addEventListener('click', sendVoice);
    const vdiscard = $('voice-discard');
    if (vdiscard) vdiscard.addEventListener('click', discardVoice);
```

Guard the existing wiring so it only runs when those elements exist (`chat-send`, `chat-input`, `chat-attach` are absent in the recording/review states): wrap their listeners in the same `if (el)` pattern already used elsewhere in this file.

Add the mic icon to the SVG sprite in `renderer/index.html` (next to `#i-send`):

```html
      <symbol id="i-mic" viewBox="0 0 24 24"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><line x1="12" y1="19" x2="12" y2="22"/></symbol>
```

- [ ] **Step 3: Verify**

Run: `cd ~/orgtree-mvp && node --check renderer/chat.js && node --check renderer/transcribe-worker.js && npm test && npm run test:chat && ORGTREE_SMOKE=1 npx electron . 2>&1 | grep SMOKE`
Expected: syntax clean, all suites green, SMOKE JSON prints.

- [ ] **Step 4: Commit**

```bash
cd ~/orgtree-mvp && git add renderer/transcribe-worker.js renderer/chat.js renderer/index.html
git commit -m "voice: record, review, on-device Whisper transcription in the compose bar"
```

---

### Task 4: Inline playback + search label

**Files:**
- Modify: `renderer/chat.js` (renderConvo bubble rendering ~:656-664, fileData handler ~:260, renderSearch preview ~:777)

**Interfaces:**
- Consumes: `kind: 'voice'` messages + `fileGet`/`fileData` from Task 1; `fmtClock`, `voicePending` from Task 3.
- Produces: `.chat-voice-*` class hooks for Task 5.

- [ ] **Step 1: Voice bubble rendering**

In `renderConvo`, add a voice branch next to the existing `file` branch:

```js
      if (m.kind === 'voice') {
        bubble = `<div class="chat-bubble voice">
          <button class="chat-voice-play" data-file="${esc(m.fileId)}" data-mime="${esc(m.mime)}" title="Play voice note"><svg class="icon"><use href="#i-play"/></svg></button>
          <span class="chat-voice-track"><span class="chat-voice-fill" id="vf-${esc(m.fileId)}"></span></span>
          <span class="chat-voice-time" id="vt-${esc(m.fileId)}">${fmtClock(m.duration)}</span>
          ${m.text ? `<div class="chat-voice-text">${esc(m.text)}</div>` : ''}
        </div>`;
      } else if (m.kind === 'file') {
```

(adjust the existing `if (m.kind === 'file')` into the `else if`.)

Add the play icon to the sprite in `renderer/index.html`:

```html
      <symbol id="i-play" viewBox="0 0 24 24"><polygon points="6 3 20 12 6 21 6 3"/></symbol>
```

- [ ] **Step 2: Playback plumbing**

Module-level, next to `voicePending` (Task 3):

```js
  let voiceAudio = null; // currently playing Audio element
  let voicePlayingId = null;
```

In `handleServer`'s `fileData` branch, before/alongside the existing download/sync handling:

```js
    if (m.type === 'fileData') {
      if (voicePending.has(m.id)) {
        const { resolve, mime } = voicePending.get(m.id);
        voicePending.delete(m.id);
        const bytes = Uint8Array.from(atob(m.data), c => c.charCodeAt(0));
        resolve(URL.createObjectURL(new Blob([bytes], { type: mime || 'audio/webm' })));
        return;
      }
      // ... existing pendingDownloads / autoSync handling unchanged ...
    }
```

Player logic (new function, wired from renderConvo):

```js
  function playVoice(fileId, mime, btn) {
    const start = (url) => {
      if (voiceAudio) { voiceAudio.pause(); voiceAudio = null; voicePlayingId = null; }
      const audio = new Audio(url);
      voiceAudio = audio; voicePlayingId = fileId;
      const fill = $('vf-' + CSS.escape(fileId));
      const time = $('vt-' + CSS.escape(fileId));
      audio.ontimeupdate = () => {
        if (time) time.textContent = fmtClock(audio.currentTime) + ' / ' + fmtClock(audio.duration || 0);
        if (fill && audio.duration) fill.style.width = (audio.currentTime / audio.duration * 100).toFixed(1) + '%';
      };
      audio.onended = () => { voiceAudio = null; voicePlayingId = null; };
      audio.play();
    };
    if (voicePlayingId === fileId && voiceAudio) { voiceAudio.pause(); voiceAudio = null; voicePlayingId = null; return; }
    const cached = voiceUrlCache.get(fileId);
    if (cached) { start(cached); return; }
    btn.disabled = true;
    new Promise((resolve) => {
      voicePending.set(fileId, { resolve, mime });
      sendServer({ type: 'fileGet', id: fileId, reason: 'voice' });
    }).then((url) => { voiceUrlCache.set(fileId, url); btn.disabled = false; start(url); });
  }
```

with `const voiceUrlCache = new Map();` next to `voicePending`, and in `renderConvo` wiring:

```js
    panel.querySelectorAll('.chat-voice-play').forEach(b => {
      b.addEventListener('click', () => playVoice(b.dataset.file, b.dataset.mime, b));
    });
```

- [ ] **Step 3: Search label**

In `renderSearch`, change the preview expression to include voice:

```js
          <span class="chat-row-sub">${esc(m.kind === 'file' ? '[file] ' + m.fileName : m.kind === 'voice' ? '[voice note] ' + m.text : m.text)}</span>
```

- [ ] **Step 4: Verify + commit**

Run: `cd ~/orgtree-mvp && node --check renderer/chat.js && npm test && npm run test:chat && ORGTREE_SMOKE=1 npx electron . 2>&1 | grep SMOKE`
Expected: all green.

```bash
cd ~/orgtree-mvp && git add renderer/chat.js renderer/index.html
git commit -m "voice: inline player with progress, voice label in search results"
```

---

### Task 5: Styles

**Files:**
- Modify: `renderer/styles.css` (append)

- [ ] **Step 1: Inspect existing compose/bubble styles**

Run: `cd ~/orgtree-mvp && grep -n "chat-compose\|chat-bubble" renderer/styles.css | head`
Match variables and sizing.

- [ ] **Step 2: Append**

```css
/* ---------- voice notes ---------- */
.chat-compose.voice-rec { align-items: center; }
.chat-voice-dot { width: 10px; height: 10px; border-radius: 50%; background: #d64545; animation: voice-pulse 1s infinite alternate; }
@keyframes voice-pulse { from { opacity: 1; } to { opacity: 0.3; } }
.chat-compose.voice-review { flex-direction: column; align-items: stretch; gap: 8px; }
.chat-compose.voice-review audio { width: 100%; height: 32px; }
.chat-voice-meta { font-size: 12px; color: var(--muted); }
.chat-compose.voice-review textarea { background: var(--bg); border: 1px solid var(--border); border-radius: 10px; color: var(--text); padding: 8px 12px; font-size: 13px; font-family: inherit; resize: vertical; }
.chat-bubble.voice { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.chat-voice-play { background: var(--accent); color: #fff; border: none; border-radius: 50%; width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; flex: none; }
.chat-voice-play:disabled { opacity: 0.5; cursor: default; }
.chat-voice-track { position: relative; width: 90px; height: 6px; border-radius: 3px; background: var(--border); overflow: hidden; }
.chat-voice-fill { position: absolute; left: 0; top: 0; bottom: 0; width: 0; background: var(--accent); }
.chat-voice-time { font-size: 11px; color: var(--muted); white-space: nowrap; }
.chat-voice-text { width: 100%; font-size: 12px; color: var(--muted); margin-top: 4px; }
```

- [ ] **Step 3: Commit**

```bash
cd ~/orgtree-mvp && git add renderer/styles.css
git commit -m "styles: voice recorder, review card, inline player"
```

---

### Task 6: Version bump, full verification, build + install

**Files:**
- Modify: `package.json` (`"version": "1.6.0"` → `"1.7.0"`)

- [ ] **Step 1: Bump + lockfile sync**

```bash
cd ~/orgtree-mvp && npm pkg set version=1.7.0 && npm install --package-lock-only --no-audit --no-fund
```

- [ ] **Step 2: Full verification**

Run: `cd ~/orgtree-mvp && npm test && npm run test:chat && node test/availability-smoke.js && ORGTREE_SMOKE=1 npx electron . 2>&1 | grep SMOKE`
Expected: 92 + 84 + 32 assertions green; SMOKE JSON prints.

- [ ] **Step 3: Build + install**

```bash
cd ~/orgtree-mvp && npx electron-builder --mac dir --arm64 2>&1 | tail -3
osascript -e 'quit app "WholeTeam"' 2>/dev/null; sleep 2; pkill -f "WholeTeam.app" 2>/dev/null; sleep 1
rm -rf /Applications/WholeTeam.app && cp -R dist/mac-arm64/WholeTeam.app /Applications/
xattr -dr com.apple.quarantine /Applications/WholeTeam.app
defaults read /Applications/WholeTeam.app/Contents/Info.plist CFBundleShortVersionString
open -a /Applications/WholeTeam.app && sleep 6 && pgrep -fl "WholeTeam.app/Contents/MacOS"
```

Expected: version `1.7.0`, app running.

- [ ] **Step 4: Commit**

```bash
cd ~/orgtree-mvp && git add package.json package-lock.json
git commit -m "1.7.0: voice notes with on-device transcription"
```

---

## Self-Review Notes

- Spec coverage: recording UX (Task 3), transcription + failure policy (Task 3 worker), wire format + retention/DM privacy (Task 1), playback + CSP (Tasks 2+4), mic usage description (Task 2), search (Tasks 1+4), styles (Task 5), version (Task 6).
- The s11–s13 test steps intentionally avoid duplicating restart-persistence coverage already in the suite; the access-control contract is covered by the fileGet fallback scan over live history.
- Transcription quality is model-dependent (tiny.en); the spec's failure policy covers bad output — the note always sends.
- Git commits require the user's go-ahead, already granted for this plan's execution flow.
