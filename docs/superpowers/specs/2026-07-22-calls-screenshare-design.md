# 1:1 calls + screenshare — design

Date: 2026-07-22 · Spec 3 of 3

## Goal

Two people on the office chat can start a 1:1 audio call from a DM or the
availability panel, turn video on mid-call, and share a screen or window —
peer-to-peer over the LAN (or Tailscale), no media through the server, no
cloud services.

## Signaling (`src/chat-server.js`, relay-only)

- New message types: `call:invite`, `call:accept`, `call:decline`,
  `call:end`, `call:cancel`, `call:signal` (SDP/ICE payload pass-through).
- Server tracks pending invites (`callerId → calleeId`) and active pairs
  (`callerId ↔ calleeId`), enforces one active call per person:
  inviting someone busy → `{ type: 'error', error: 'call-busy' }`.
- Signals/accept/decline/end only relay between paired or pending parties.
- If a connected client drops mid-call (or with a pending invite), the server
  notifies the peer (`call:end` / `call:cancel`) so nobody's UI hangs.
- **Auto-busy**: on `call:accept` the server sets both parties' ephemeral
  status to `busy` and broadcasts `statusChanged` (delivers the deferred
  spec-1 behavior); on `call:end`/disconnect it restores them. Busy-from-call
  shows the yellow dot even when the person isn't clocked in (client dot rule
  change: busy wins over the clocked-in check).

## Media (renderer, WebRTC)

- `RTCPeerConnection` with no ICE servers — host candidates suffice on the
  LAN and over Tailscale. (Cellular/NAT-only paths are out of scope; the
  product's remote answer is Tailscale.)
- Call starts **audio-first**: `getUserMedia({ audio: true })` on both sides
  at connect; camera off.
- Video toggle: `getUserMedia({ video: true })`, `addTrack` → standard
  renegotiation via `onnegotiationneeded`.
- Screenshare: main-process `desktopCapturer.getSources({ types:
  ['screen', 'window'] })` via a new preload IPC `chatGetSources()`; picker UI
  shows thumbnails; capture via Electron's desktop `getUserMedia` constraints
  (`chromeMediaSource: 'desktop'`). Screen share replaces the outgoing video
  track (or adds one if camera is off); stopping restores camera state.
- Ring tone: short WebAudio oscillator loop (no asset file).

## UX

- Call buttons: DM conversation header, availability-panel rows.
- Incoming call: overlay card with caller name, ring sound, Accept / Decline.
- In-call overlay: remote video (or avatar placeholder when audio-only),
  local PiP preview, mute toggle, camera toggle, screenshare toggle, hang up,
  elapsed timer. Both hang-up paths (button, peer end, disconnect) tear down
  tracks and the peer connection.

## Packaging

- `NSCameraUsageDescription` added to `build.mac.extendInfo` (mic string
  shipped in 1.7.0). macOS Screen Recording permission is OS-prompted on
  first `desktopCapturer` use. No new npm dependencies.

## Error handling / edge cases

- Mic/camera permission denied → inline error, call not started.
- Inviting someone offline → error `call-offline` (no queuing).
- Either side ending/closing the app → peer sees "call ended" and a clean
  teardown.
- Second incoming invite while ringing → `call-busy` to the second caller.

## Testing

- `test/chat-smoke.js`: invite relayed only to target; busy rejection;
  accept pairs and auto-busy `statusChanged`; signal relay only between
  paired parties; decline clears pending; end clears both and restores
  status; disconnect mid-call ends for the peer.
- Media/UI: manual acceptance between two app instances (audio → video →
  screenshare → hang up).

## Out of scope

Group calls (mesh >2), TURN/NAT traversal beyond LAN+Tailscale, call
recording, in-call text chat, call history.

## Version

1.8.0.
