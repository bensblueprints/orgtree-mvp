# Voice notes (with on-device transcription) — design

Date: 2026-07-22 · Spec 2 of 3 (A/V calls + screenshare follow as a separate spec)

## Goal

Anyone connected to the office chat can record a short voice note in any
channel or DM, review it (and its auto-generated transcript) before sending,
and play notes inline. Notes vanish with disappearing chats; transcripts make
them searchable. Nothing leaves the network after a one-time speech-model
download.

## Recording (renderer, chat compose bar)

- Mic button next to the paperclip in the conversation compose bar. Click to
  start (live timer shown), click again to stop. 5-minute hard cap auto-stops.
- After stopping, an inline review card appears: audio preview player, the
  transcript (editable textarea), **Send** and **Discard**.
- Capture: `getUserMedia({ audio })` + `MediaRecorder` (WebM/Opus, Chromium's
  default in Electron).
- macOS packaging: `build.mac.extendInfo.NSMicrophoneUsageDescription` in
  `package.json` so the OS grants mic access; camera/screen strings are NOT
  added (that's spec 3).

## Transcription (on-device, sender's machine)

- Engine: `@huggingface/transformers` (new npm dependency) running Whisper
  `Xenova/whisper-tiny.en` in a dedicated Web Worker
  (`renderer/transcribe-worker.js`) so the UI never blocks.
- Triggered automatically when recording stops; review card shows
  "Transcribing…", then the text. First-ever use shows "Downloading speech
  model (one-time ~40 MB)"; the model is cached in the app's storage and
  works offline afterwards. English-only in v1.
- Transcript is editable before sending.
- Failure policy: model download failure, worker error, or empty result →
  the note still sends, without a transcript. Transcription never blocks
  sending.

## Wire format + server (`src/chat-server.js`)

- New client→server message `{ type: 'voice', channel, data (base64),
  duration (seconds), mime, text (transcript, may be '') }`.
- Server stores the audio bytes via the existing file store and pushes a
  message `{ channel, from, fromName, ts, kind: 'voice', fileId, duration,
  mime, text }`. Transcript text capped by the existing `TEXT_CAP`.
- DM rules identical to DM files: only the two participants receive/fetch it.
- **Not** added to the shared library. Retention pruning that removes a
  `kind: 'voice'` message also deletes its audio bytes from disk (unlike
  library files, which are kept forever).
- `fileGet` serves voice bytes to entitled clients unchanged.

## Playback + display (renderer)

- `kind: 'voice'` messages render as an inline player: play/pause button,
  elapsed/total time, progress bar, with the transcript shown under it
  (plain text, searchable/copiable).
- Audio bytes fetched lazily via existing `fileGet`, played from a Blob URL.
- Message search results show voice notes as `[voice note] <transcript>`.
- CSP (`renderer/index.html`): add `media-src 'self' blob: data:`,
  `worker-src 'self' blob:`, `script-src 'self' 'wasm-unsafe-eval'`, and
  `connect-src 'self' ws: https://huggingface.co` (one-time model download).

## Error handling / edge cases

- Mic permission denied → inline error in the compose bar, no recording.
- Unsupported `MediaRecorder` mime → fall back to whatever the runtime offers;
  the recorded `mime` travels with the message so playback matches.
- Note recorded while offline/disconnected → sends only when the socket is
  open (same as text today); otherwise an error is shown.
- Empty/0-second recording → discarded, nothing sent.

## Testing

- `test/chat-smoke.js`: voice send/receive with duration + transcript;
  byte round-trip via `fileGet`; DM privacy (third party can't fetch);
  retention pruning deletes voice bytes from disk; transcript participates
  in message search.
- Renderer recording/playback/transcription: no DOM harness — verified via
  boot smoke + manual acceptance (record → transcribe → edit → send → play
  on a second client).

## Out of scope

A/V calls and screensharing (spec 3); multilingual models; speaker
diarization; transcription of notes received from others (transcript is
always produced by the sender); voice-note waveforms.

## Version

1.7.0.
