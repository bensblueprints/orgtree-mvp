# Availability & presence — design

Date: 2026-07-22 · Spec 1 of 3 (voice notes → A/V calls follow as separate specs)

## Goal

A distributed team can see at a glance when everyone is available: structured
per-weekday working blocks with breaks, a timezone-translated availability
panel in Team Chat, live presence dots (clocked in / busy / not in), and a
"what I'm working on" line set at clock-in.

## Data model (per person, stored in the chart file)

- `schedule`: `{ mon: [["09:00","12:00"],["13:00","17:00"]], tue: [...], ... }`
  — weekday keys `mon`…`sun`, each an array of `[start, end]` strings in 24h
  `HH:MM`, **local to that person's `timezone`**. A missing/empty day = day
  off. Validated in `store.normalize`: well-formed times, start < end, sorted,
  non-overlapping. No cross-midnight blocks in v1.
- `timeFormat`: `'12h' | '24h'` (default `'12h'`) — that person's preferred
  display format, editable in their chat profile.
- `status`: `'available' | 'busy'` (default `'available'`) — manual toggle.
  (Phase 3 calls will auto-set busy while in a call; out of scope here.)
- Legacy free-text `workHours` is kept untouched for backward compat. When an
  editor opens a person with no `schedule` and a simple `H-H`/`H:MM-H:MM`
  `workHours`, it prefills Mon–Fri with that single block.
- Ephemeral, **not** written to the chart file: `statusText` (the
  "working on" line) and clock state. These live in the chat server's memory.

## Availability engine — new `src/availability.js`

Pure functions, no DOM, no new dependencies (timezone math via
`Intl.DateTimeFormat` parts). Loaded in Node tests and exposed to the renderer
as `window.OrgtreeAvailability` (same pattern as `src/tree.js`).

- `blocksOn(schedule, weekday)` → blocks for a weekday.
- `stateAt(schedule, tz, instant)` → `{ state: 'working'|'break'|'off'|'none',
  block, nextStart, until }` — `none` = no schedule set.
- `nextStartIn(schedule, tz, instant)` → ms until the next block starts
  (looking ahead across days, skipping days off).
- `viewerTimeline(schedule, ownerTz, viewerTz, day)` → the owner's blocks for
  the viewer's current day, converted into the viewer's timezone and clipped
  to midnight–midnight (a block may straddle the viewer's day boundary).
- `fmtCountdown(ms)` → `"2h 15m"` / `"43m"` / `"<1m"`.
- `fmtTime(mins, timeFormat)` → `"9:00 AM"` or `"09:00"`.

## Chat server (`src/chat-server.js`)

- `buildMinimalRoster` also carries `schedule`, `status`, `timeFormat`.
  The existing `rosterSync` push (added in the pick-screen fix) keeps every
  client current when the admin edits the chart.
- `clockIn` accepts optional `statusText`; `clockOut` clears it.
- New client→server message `{ type: 'status', status, statusText? }` to flip
  busy/available or edit the working-on line.
- New server→client broadcast `{ type: 'statusChanged', personId, clockedIn,
  status, statusText }` on clock in/out and status changes, so dots and the
  panel update live for everyone.
- `PROFILE_FIELDS` gains `schedule` and `timeFormat`, so an employee editing
  their own blocks/format in chat reaches the host's chart through the
  existing `onProfileUpdate` callback (admin stays the source of truth on
  disk).

## UI

- **Schedule editor** — new `renderer/schedule-editor.js`, one shared
  component used in the chart editor form (admin edits anyone, `app.js`) and
  in chat "My profile" (`chat.js`): 7 weekday rows, add/remove block,
  hour/minute pickers that render in the editor's own `timeFormat`.
- **Availability panel** — new Team Chat view (header button). One row per
  person: presence dot, name, statusText, their local time, status pill
  (*Available now* / *On break — back in 25m* / *Starts in 2h 15m* /
  *Off today* / *No schedule*), and a 24h timeline bar painted with their
  blocks **converted to the viewer's timezone**. Sorted: available now → on
  break → starting soonest → off. Refreshes on `presence`, `statusChanged`,
  `rosterSync`, and a 60s timer.
- **Presence dots** wherever names appear in chat (DM list, availability
  panel, admin timesheet rows):
  - green — clocked in (and not busy)
  - yellow — busy (manual toggle; requires clocked in)
  - red — inside a scheduled block but not clocked in
  - grey — outside scheduled hours or no schedule
- **Clock-in card**: PIN field plus an optional one-line
  "What are you working on?" input; editable later from the clocked-in card;
  cleared on clock-out.
- **12h/24h selector** in "My profile"; applied to every rendered time
  (availability panel, DM-list local times, schedule editor pickers).

## Error handling / edge cases

- Invalid or missing timezone → treated as viewer's own timezone for display,
  never throws.
- Malformed schedule entries are dropped by `normalize`, not repaired inline.
- Person with no schedule: panel shows *No schedule*, dot grey, excluded from
  "starting soonest" sorting.
- Busy with no clock-in is not allowed: status toggle only shown while
  clocked in; clock-out resets status to `available`.

## Testing

- `test/availability-smoke.js` (new, node): state machine across block
  boundaries, breaks, days off, countdown formatting, 12h/24h formatting, and
  owner→viewer timezone conversion including the day-straddle case.
- `test/smoke.js`: `normalize` accepts/validates `schedule`, drops malformed
  entries, preserves `timeFormat`.
- `test/chat-smoke.js`: `clockIn` with statusText broadcasts `statusChanged`;
  `status` message flips busy; `clockOut` clears statusText and status.

## Out of scope

Voice notes; audio/video calls and screensharing (own spec); cross-midnight
blocks; holidays/PTO calendars; per-day schedule overrides for specific dates.
