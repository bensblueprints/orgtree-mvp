# Availability & Presence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-weekday working-hour blocks with breaks, a timezone-translated availability panel in Team Chat, live presence dots (green/yellow/red/grey), a "working on" line at clock-in, and a per-person 12h/24h display preference.

**Architecture:** A new pure availability engine (`src/availability.js`) owns schedule shape, state math, and timezone conversion — loadable in Node (tests, store, chat-server) and the renderer (script tag). The chat server carries `schedule`/`timeFormat` on the roster and an ephemeral per-person status map broadcast via `statusChanged`. Renderer: a shared schedule-editor component used by the chart form and chat profile, plus a new `availability` panel view.

**Tech Stack:** Electron 33, plain Node `ws`, vanilla JS renderer, `Intl.DateTimeFormat` timezone math. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-22-availability-presence-design.md`

## Global Constraints

- No new runtime or dev dependencies.
- Follow the existing UMD pattern for `src/` modules (`module.exports` + `window.*`).
- `schedule` shape: `{ mon: [["09:00","12:00"],["13:00","17:00"]], ... }`, weekday keys `mon`…`sun`, 24h `HH:MM`, local to the person's `timezone`. Empty day = day off. No cross-midnight blocks.
- `timeFormat` is exactly `'12h'` or `'24h'`; default `'12h'`.
- Presence dots: green = clocked in, yellow = busy (clocked-in only), red = inside a scheduled block but not clocked in, grey = off-hours / no schedule.
- All existing tests must keep passing: `npm test`, `npm run test:chat`.
- Chat server stays pure Node and cross-platform (the Windows CI job builds from the same sources).

## File Structure

- Create `src/availability.js` — schedule normalization, state machine, countdowns, owner→viewer timeline conversion, time formatting.
- Create `test/availability-smoke.js` — node test for the engine.
- Modify `src/store.js` — `normalizePerson` validates `schedule` + `timeFormat`.
- Modify `test/smoke.js` — normalize coverage for the new fields.
- Modify `src/chat-server.js` — roster fields, profile `schedule`/`timeFormat`, statuses map, `status` message, `statusChanged` broadcast, `statusText` at clock-in.
- Modify `test/chat-smoke.js` — status/statusText protocol coverage.
- Create `renderer/schedule-editor.js` — shared per-weekday block editor (`window.ScheduleEditor`).
- Modify `renderer/index.html` — script tags; swap `f-workhours` input for the schedule editor container.
- Modify `renderer/app.js` — chart form + drawer integration.
- Modify `renderer/chat.js` — statuses state, dots, availability view, profile integration, clock-in working-on, 60s refresh.
- Modify `renderer/styles.css` — dot colors, availability rows/timeline, schedule editor.

---

### Task 1: Availability engine

**Files:**
- Create: `src/availability.js`
- Test: `test/availability-smoke.js`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces (used by later tasks — exact names):
  - `OrgtreeAvailability.WEEK` → `['mon','tue','wed','thu','fri','sat','sun']`
  - `OrgtreeAvailability.normalizeSchedule(raw)` → sanitized `{ dayKey: [["HH:MM","HH:MM"],...] }` (24h strings, sorted, non-overlapping; invalid dropped)
  - `OrgtreeAvailability.isEmpty(schedule)` → boolean
  - `OrgtreeAvailability.blocksOn(schedule, dayKey)` → `[[startMins, endMins], ...]` (numbers)
  - `OrgtreeAvailability.stateAt(schedule, tz, instant)` → `{ state: 'working'|'starts'|'break'|'off'|'none', until?, nextStart? }` (`until`/`nextStart` in ms)
  - `OrgtreeAvailability.nextStartIn(schedule, tz, instant)` → ms or `null`
  - `OrgtreeAvailability.viewerTimeline(schedule, ownerTz, viewerTz, instant)` → `[{ startMin, endMin }, ...]` clipped to the viewer's current day (0–1440 minutes since viewer midnight)
  - `OrgtreeAvailability.fmtCountdown(ms)` → `'2h 15m'` / `'43m'` / `'<1m'` / `'1d 3h'` / `''`
  - `OrgtreeAvailability.fmtTime(mins, format)` → `'9:05 AM'` (`'12h'`) or `'09:05'` (`'24h'`)
  - `OrgtreeAvailability.clockInTz(tz, date, format)` → current wall-clock string in `tz`
  - `OrgtreeAvailability.partsInTz(tz, date)` → `{ dayKey, year, month, day, mins }`
  - `OrgtreeAvailability.zonedTimeToUtc(year, month, day, mins, tz)` → epoch ms

- [ ] **Step 1: Write the failing test**

Create `test/availability-smoke.js`:

```js
'use strict';

/**
 * Availability engine smoke test — pure node, deterministic instants.
 * Covers: schedule normalization, state machine, countdowns, formatting,
 * and owner→viewer timezone conversion.
 */

const assert = require('assert');
const A = require('../src/availability');

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; console.log('  ✔ ' + msg); }
function eq(a, b, msg) { assert.deepStrictEqual(a, b, msg); passed++; console.log('  ✔ ' + msg); }

console.log('\n— normalizeSchedule —');
{
  const s = A.normalizeSchedule({
    mon: [['13:00', '17:00'], ['09:00', '12:00']],
    tue: 'garbage',
    wed: [['25:00', '26:00']],
    thu: [['10:00', '09:00']],
    fri: [['09:00', '12:00'], ['11:00', '14:00']],
    sat: [],
  });
  eq(s.mon, [['09:00', '12:00'], ['13:00', '17:00']], 'blocks sorted by start');
  ok(!('tue' in s) && !('wed' in s) && !('thu' in s), 'malformed days/blocks dropped');
  eq(s.fri, [['09:00', '12:00']], 'overlapping block dropped (first wins)');
  ok(A.isEmpty(A.normalizeSchedule(null)), 'null schedule normalizes to empty');
  ok(!A.isEmpty(s), 'non-empty schedule detected');
}

console.log('\n— fmtTime / fmtCountdown —');
{
  eq(A.fmtTime(545, '12h'), '9:05 AM', '12h morning');
  eq(A.fmtTime(785, '12h'), '1:05 PM', '12h afternoon');
  eq(A.fmtTime(0, '12h'), '12:00 AM', '12h midnight');
  eq(A.fmtTime(720, '12h'), '12:00 PM', '12h noon');
  eq(A.fmtTime(545, '24h'), '09:05', '24h zero-padded');
  eq(A.fmtCountdown(25 * 60000), '25m', 'minutes only');
  eq(A.fmtCountdown(135 * 60000), '2h 15m', 'hours and minutes');
  eq(A.fmtCountdown(120 * 60000), '2h', 'round hours drop minutes');
  eq(A.fmtCountdown(27 * 3600000), '1d 3h', 'days for long waits');
  eq(A.fmtCountdown(null), '', 'null countdown is empty');
}

// 2026-07-22 is a Wednesday everywhere relevant below.
const sched = { wed: [['09:00', '12:00'], ['13:00', '17:00']], thu: [['09:00', '17:00']] };

console.log('\n— stateAt (America/Chicago, UTC-5 in July) —');
{
  const at = (hh, mm) => new Date(Date.UTC(2026, 6, 22, hh, mm)); // Chicago = UTC-5
  eq(A.stateAt(sched, 'America/Chicago', at(15, 30)).state, 'working', '10:30 local = working');
  eq(A.stateAt(sched, 'America/Chicago', at(15, 30)).until, 90 * 60000, 'until = 90 min to block end');
  const brk = A.stateAt(sched, 'America/Chicago', at(17, 30)); // 12:30 local
  eq(brk.state, 'break', '12:30 local = lunch break');
  eq(brk.nextStart, 30 * 60000, 'back in 30 min');
  const early = A.stateAt(sched, 'America/Chicago', at(13, 0)); // 08:00 local
  eq(early.state, 'starts', '08:00 local = starts today');
  eq(early.nextStart, 60 * 60000, 'starts in 1h');
  const done = A.stateAt(sched, 'America/Chicago', at(23, 0)); // 18:00 local
  eq(done.state, 'off', '18:00 local = off');
  eq(done.nextStart, 15 * 3600000, 'next start is Thursday 09:00 (15h)');
  eq(A.stateAt({}, 'America/Chicago', at(15, 30)).state, 'none', 'empty schedule = none');
}

console.log('\n— nextStartIn across days off —');
{
  const onlyMon = { mon: [['09:00', '17:00']] };
  // Wednesday 12:00 UTC (07:00 Chicago) → Monday 09:00 Chicago = Monday 14:00 UTC = 122h
  const ms = A.nextStartIn(onlyMon, 'America/Chicago', new Date(Date.UTC(2026, 6, 22, 12)));
  eq(ms, 122 * 3600000, 'skips empty days to next Monday');
  eq(A.nextStartIn({}, 'America/Chicago', new Date()), null, 'empty schedule = null');
}

console.log('\n— viewerTimeline timezone conversion —');
{
  // Owner in Tokyo works 09:00–12:00 JST. Viewer in Chicago (UTC-5, JST = UTC+9).
  // Wednesday 2026-07-22 14:00 UTC = 09:00 Wednesday Chicago = 23:00 Wednesday Tokyo.
  // Tokyo Wednesday 09:00–12:00 JST = Tuesday 19:00–22:00 Chicago → nothing on Wednesday.
  const tokyo = { wed: [['09:00', '12:00']] };
  const now = new Date(Date.UTC(2026, 6, 22, 14));
  eq(A.viewerTimeline(tokyo, 'Asia/Tokyo', 'America/Chicago', now), [], 'past-day blocks not shown');
  // Tokyo Thursday 09:00–12:00 JST = Wednesday 19:00–22:00 Chicago = 1140–1320 min.
  const tokyoThu = { thu: [['09:00', '12:00']] };
  eq(A.viewerTimeline(tokyoThu, 'Asia/Tokyo', 'America/Chicago', now),
    [{ startMin: 1140, endMin: 1320 }], 'Tokyo Thursday morning lands Wednesday evening in Chicago');
  // Same-tz viewer: blocks render verbatim.
  const local = { wed: [['09:00', '12:00'], ['13:00', '17:00']] };
  eq(A.viewerTimeline(local, 'America/Chicago', 'America/Chicago', now),
    [{ startMin: 540, endMin: 720 }, { startMin: 780, endMin: 1020 }], 'same timezone = verbatim minutes');
  eq(A.viewerTimeline({}, 'Asia/Tokyo', 'America/Chicago', now), [], 'empty schedule = empty timeline');
}

console.log('\n— clockInTz —');
{
  const now = new Date(Date.UTC(2026, 6, 22, 14, 30)); // 09:30 Chicago, 23:30 Tokyo
  eq(A.clockInTz('America/Chicago', now, '24h'), '09:30', '24h clock in tz');
  eq(A.clockInTz('Asia/Tokyo', now, '12h'), '11:30 PM', '12h clock in tz');
}

console.log(`\nAvailability engine all good — ${passed} assertions passed.\n`);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/orgtree-mvp && node test/availability-smoke.js`
Expected: FAIL with `Cannot find module '../src/availability'`

- [ ] **Step 3: Implement `src/availability.js`**

```js
/**
 * WholeTeam — availability engine. Pure functions, no DOM, no dependencies.
 *
 * A person's `schedule` is { mon: [["09:00","12:00"],["13:00","17:00"]], ... }
 * in 24h HH:MM, local to their IANA `timezone`. This module owns the shape
 * (normalize), the state machine (stateAt), countdowns, owner→viewer timeline
 * conversion, and 12h/24h formatting. Everything is computed from instants,
 * so viewers in other timezones always see correct local renderings.
 */

'use strict';

const OrgtreeAvailability = (() => {
  const WEEK = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const DAYMAP = { Sun: 'sun', Mon: 'mon', Tue: 'tue', Wed: 'wed', Thu: 'thu', Fri: 'fri', Sat: 'sat' };
  const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

  function toMins(t) {
    const m = TIME_RE.exec(String(t == null ? '' : t).trim());
    return m ? (+m[1]) * 60 + (+m[2]) : null;
  }
  function toHHMM(mins) {
    return String(Math.floor(mins / 60)).padStart(2, '0') + ':' + String(mins % 60).padStart(2, '0');
  }

  /** Sanitize an arbitrary value into a valid schedule. Invalid input → {}. */
  function normalizeSchedule(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const d of WEEK) {
      const blocks = Array.isArray(raw[d]) ? raw[d] : [];
      const clean = [];
      for (const b of blocks) {
        if (!Array.isArray(b) || b.length !== 2) continue;
        const s = toMins(b[0]), e = toMins(b[1]);
        if (s == null || e == null || s >= e) continue;
        clean.push([s, e]);
      }
      clean.sort((a, b) => a[0] - b[0]);
      const kept = [];
      for (const [s, e] of clean) {
        if (kept.length && s < kept[kept.length - 1][1]) continue; // overlap: first wins
        kept.push([s, e]);
      }
      if (kept.length) out[d] = kept.map(([s, e]) => [toHHMM(s), toHHMM(e)]);
    }
    return out;
  }

  function isEmpty(schedule) {
    if (!schedule || typeof schedule !== 'object') return true;
    return !WEEK.some(d => Array.isArray(schedule[d]) && schedule[d].length);
  }

  /** Blocks for a weekday as [startMins, endMins] pairs (invalid skipped). */
  function blocksOn(schedule, dayKey) {
    const raw = schedule && Array.isArray(schedule[dayKey]) ? schedule[dayKey] : [];
    const out = [];
    for (const b of raw) {
      if (!Array.isArray(b)) continue;
      const s = toMins(b[0]), e = toMins(b[1]);
      if (s != null && e != null && s < e) out.push([s, e]);
    }
    return out.sort((a, b) => a[0] - b[0]);
  }

  /** Calendar + clock parts of an instant in a timezone. Bad tz → local time. */
  function partsInTz(tz, date) {
    try {
      if (tz) {
        const fmt = new Intl.DateTimeFormat('en-US', {
          timeZone: tz, weekday: 'short', year: 'numeric', month: '2-digit',
          day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
        });
        const p = {};
        for (const part of fmt.formatToParts(date)) p[part.type] = part.value;
        return {
          dayKey: DAYMAP[p.weekday], year: +p.year, month: +p.month, day: +p.day,
          mins: (+p.hour % 24) * 60 + (+p.minute),
        };
      }
      throw new Error('no tz');
    } catch (_) {
      return {
        dayKey: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][date.getDay()],
        year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(),
        mins: date.getHours() * 60 + date.getMinutes(),
      };
    }
  }

  /** Epoch ms of a wall-clock time in a timezone (iterative offset fix-up). */
  function zonedTimeToUtc(year, month, day, mins, tz) {
    let guess = Date.UTC(year, month - 1, day, 0, mins);
    const want = Date.UTC(year, month - 1, day, 0, mins);
    for (let i = 0; i < 3; i++) {
      const p = partsInTz(tz, new Date(guess));
      const have = Date.UTC(p.year, p.month - 1, p.day, 0, p.mins);
      const delta = want - have;
      if (delta === 0) break;
      guess += delta;
    }
    return guess;
  }

  /** ms until the next block starts (any day, up to 8 ahead), or null. */
  function nextStartIn(schedule, tz, instant) {
    if (isEmpty(schedule)) return null;
    const now = instant instanceof Date ? instant : new Date(instant);
    const here = partsInTz(tz, now);
    for (const [s] of blocksOn(schedule, here.dayKey)) {
      if (s > here.mins) return (s - here.mins) * 60000;
    }
    for (let i = 1; i <= 8; i++) {
      const noon = new Date(Date.UTC(here.year, here.month - 1, here.day + i, 12));
      const y = noon.getUTCFullYear(), mo = noon.getUTCMonth() + 1, dy = noon.getUTCDate();
      const probe = partsInTz(tz, new Date(zonedTimeToUtc(y, mo, dy, 720, tz)));
      const blocks = blocksOn(schedule, probe.dayKey);
      if (blocks.length) {
        return Math.max(0, zonedTimeToUtc(y, mo, dy, blocks[0][0], tz) - now.getTime());
      }
    }
    return null;
  }

  /**
   * What the person is doing right now:
   *  working — inside a block (until = ms to block end)
   *  starts  — first block still ahead today (nextStart = ms)
   *  break   — between blocks today (nextStart = ms)
   *  off     — nothing left today (nextStart = ms to next day's block, or null)
   *  none    — no schedule set
   */
  function stateAt(schedule, tz, instant) {
    if (isEmpty(schedule)) return { state: 'none' };
    const now = instant instanceof Date ? instant : new Date(instant);
    const here = partsInTz(tz, now);
    const today = blocksOn(schedule, here.dayKey);
    for (const [s, e] of today) {
      if (here.mins >= s && here.mins < e) return { state: 'working', until: (e - here.mins) * 60000 };
    }
    const next = today.find(([s]) => s > here.mins);
    if (next) {
      const hadEarlier = today.some(([, e]) => e <= here.mins);
      return { state: hadEarlier ? 'break' : 'starts', nextStart: (next[0] - here.mins) * 60000 };
    }
    return { state: 'off', nextStart: nextStartIn(schedule, tz, now) };
  }

  /**
   * The owner's blocks rendered on the viewer's current day, in minutes since
   * the viewer's midnight (clipped to 0–1440). Instant-accurate across
   * timezones: a Tokyo morning block lands in the Chicago previous evening.
   */
  function viewerTimeline(schedule, ownerTz, viewerTz, instant) {
    if (isEmpty(schedule)) return [];
    const now = instant ? new Date(instant) : new Date();
    const v = partsInTz(viewerTz, now);
    const dayStart = zonedTimeToUtc(v.year, v.month, v.day, 0, viewerTz);
    const dayEnd = zonedTimeToUtc(v.year, v.month, v.day + 1, 0, viewerTz);
    const out = [];
    const oStart = partsInTz(ownerTz, new Date(dayStart - 86400000));
    for (let i = 0; i < 4; i++) {
      const noon = new Date(Date.UTC(oStart.year, oStart.month - 1, oStart.day + i, 12));
      const y = noon.getUTCFullYear(), mo = noon.getUTCMonth() + 1, dy = noon.getUTCDate();
      const probe = partsInTz(ownerTz, new Date(zonedTimeToUtc(y, mo, dy, 720, ownerTz)));
      for (const [s, e] of blocksOn(schedule, probe.dayKey)) {
        const sUtc = zonedTimeToUtc(y, mo, dy, s, ownerTz);
        const eUtc = zonedTimeToUtc(y, mo, dy, e, ownerTz);
        const cs = Math.max(sUtc, dayStart), ce = Math.min(eUtc, dayEnd);
        if (cs < ce) {
          out.push({ startMin: Math.round((cs - dayStart) / 60000), endMin: Math.round((ce - dayStart) / 60000) });
        }
      }
    }
    return out.sort((a, b) => a.startMin - b.startMin);
  }

  function fmtCountdown(ms) {
    if (ms == null) return '';
    const mins = Math.max(0, Math.round(ms / 60000));
    if (mins < 1) return '<1m';
    const h = Math.floor(mins / 60), m = mins % 60;
    if (h >= 24) return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
    return h ? (m ? h + 'h ' + m + 'm' : h + 'h') : m + 'm';
  }

  function fmtTime(mins, format) {
    const h24 = Math.floor(mins / 60) % 24, m = mins % 60;
    const mm = String(m).padStart(2, '0');
    if (format === '24h') return String(h24).padStart(2, '0') + ':' + mm;
    return (h24 % 12 || 12) + ':' + mm + ' ' + (h24 >= 12 ? 'PM' : 'AM');
  }

  function clockInTz(tz, date, format) {
    return fmtTime(partsInTz(tz, date || new Date()).mins, format);
  }

  return {
    WEEK, normalizeSchedule, isEmpty, blocksOn, stateAt, nextStartIn,
    viewerTimeline, fmtCountdown, fmtTime, clockInTz, partsInTz, zonedTimeToUtc,
  };
})();

/* Works as a CommonJS module (main process, tests) and as a plain
   <script> in the sandboxed renderer (attaches to window). */
if (typeof module !== 'undefined' && module.exports) module.exports = OrgtreeAvailability;
if (typeof window !== 'undefined') window.OrgtreeAvailability = OrgtreeAvailability;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/orgtree-mvp && node test/availability-smoke.js`
Expected: PASS — `Availability engine all good — 32 assertions passed.`

- [ ] **Step 5: Commit**

```bash
cd ~/orgtree-mvp && git add src/availability.js test/availability-smoke.js
git commit -m "availability engine: schedule shape, state machine, tz conversion"
```

---

### Task 2: Store normalization for `schedule` + `timeFormat`

**Files:**
- Modify: `src/store.js` (`normalizePerson` at lines 69-92)
- Test: `test/smoke.js` (append near the existing normalize tests, ~line 348)

**Interfaces:**
- Consumes: `OrgtreeAvailability.normalizeSchedule` (Task 1).
- Produces: every person record from `store.normalize` now always has
  `schedule` (object, possibly `{}`) and `timeFormat` (`'12h'`/`'24h'`).
  Task 3's `buildMinimalRoster` and Task 4's editors rely on both.

- [ ] **Step 1: Write the failing test**

Append to `test/smoke.js`, right after the existing `normalize: working hours preserved` block:

```js
console.log('\n— normalize: schedule + timeFormat —');
{
  const n = store.normalize({
    people: [{
      id: 'a', name: 'A',
      schedule: { mon: [['13:00', '17:00'], ['09:00', '12:00']], wed: [['bad']] },
      timeFormat: '24h',
    }, {
      id: 'b', name: 'B', schedule: 'garbage', timeFormat: 'military',
    }],
  });
  eq(n.people[0].schedule, { mon: [['09:00', '12:00'], ['13:00', '17:00']] }, 'normalize: schedule sorted and validated');
  eq(n.people[0].timeFormat, '24h', 'normalize: timeFormat 24h preserved');
  eq(n.people[1].schedule, {}, 'normalize: malformed schedule becomes empty object');
  eq(n.people[1].timeFormat, '12h', 'normalize: unknown timeFormat falls back to 12h');
}
```

(Note: `test/smoke.js` already imports the store as `store` and defines `eq` — confirm the local names at the top of the file and match them.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/orgtree-mvp && npm test`
Expected: FAIL — `normalize: schedule sorted and validated` (deepStrictEqual mismatch: `schedule`/`timeFormat` missing)

- [ ] **Step 3: Implement**

In `src/store.js`, add the require at the top (after line 10 `const path = require('path');`):

```js
const availability = require('./availability');
```

In `normalizePerson`, add two fields before `pinHash`:

```js
    timezone: p.timezone ? String(p.timezone) : '',
    workHours: p.workHours ? String(p.workHours) : '',
    timeFormat: p.timeFormat === '24h' ? '24h' : '12h',
    schedule: availability.normalizeSchedule(p.schedule),
    pinHash: p.pinHash ? String(p.pinHash) : '',
```

- [ ] **Step 4: Run tests**

Run: `cd ~/orgtree-mvp && npm test`
Expected: PASS — all assertions including the 4 new ones (count rises from 88 to 92).

- [ ] **Step 5: Commit**

```bash
cd ~/orgtree-mvp && git add src/store.js test/smoke.js
git commit -m "store: normalize schedule + timeFormat on person records"
```

---

### Task 3: Chat server — roster fields, statuses, statusText

**Files:**
- Modify: `src/chat-server.js` (PROFILE_FIELDS :52, buildMinimalRoster :194-201, roster send :256, profile handler :336-362, clockIn :364-376, clockOut :378-382, updateRoster :488-508)
- Test: `test/chat-smoke.js` (append a new section before `fs.rmSync(dir, ...)` at the end)

**Interfaces:**
- Consumes: `OrgtreeAvailability.normalizeSchedule` (Task 1); person records with `schedule`/`timeFormat` (Task 2).
- Produces (wire protocol the renderer in Task 5 consumes):
  - `roster`, `rosterSync`, `welcome` messages each gain `statuses: [{ personId, clockedIn, status, statusText }]`.
  - Roster people gain `schedule` (normalized) and `timeFormat`.
  - Client→server `clockIn` accepts optional `statusText` (string ≤ 140 chars).
  - New client→server `{ type: 'status', status: 'available'|'busy', statusText? }` — ignored unless clocked in.
  - New server→client broadcast `{ type: 'statusChanged', entry: { personId, clockedIn, status, statusText } }`.
  - Client→server `profile` fields may include `schedule` (object) and `timeFormat`; both pass through `onProfileUpdate` to the host chart and are broadcast in `rosterUpdate`.

- [ ] **Step 1: Write the failing test**

Append to `test/chat-smoke.js`, just before the final `fs.rmSync(dir, { recursive: true, force: true });`:

```js
  console.log('\n— presence status: clock-in line, busy toggle, roster fields —');
  {
    const withSched = roster.map(p => p.id === 'vic'
      ? { ...p, schedule: { mon: [['09:00', '12:00'], ['13:00', '17:00']] }, timeFormat: '24h' }
      : p);
    const s10 = await createChatServer({ port: PORT, roster: withSched });
    const w1 = await client(PORT); await sleep(80);
    w1.send({ type: 'hello', personId: 'ada' }); await sleep(120);
    const w2 = await client(PORT); await sleep(80);
    w2.send({ type: 'hello', personId: 'vic' }); await sleep(120);

    const rMsg = w1.inbox.find(m => m.type === 'roster');
    const vicRow = rMsg.roster.find(p => p.id === 'vic');
    eq(vicRow.schedule, { mon: [['09:00', '12:00'], ['13:00', '17:00']] }, 'roster carries schedule');
    eq(vicRow.timeFormat, '24h', 'roster carries timeFormat');
    ok(Array.isArray(rMsg.statuses), 'roster carries a statuses list');

    w2.send({ type: 'status', status: 'busy' });
    await sleep(120);
    ok(!w1.inbox.some(m => m.type === 'statusChanged' && m.entry && m.entry.status === 'busy'),
      'busy ignored while not clocked in');

    w2.send({ type: 'clockIn', pin: '4821', statusText: 'Q3 budget review' });
    await sleep(150);
    const inChg = w1.inbox.filter(m => m.type === 'statusChanged').pop();
    eq(inChg.entry.personId, 'vic', 'statusChanged identifies the person');
    eq(inChg.entry.clockedIn, true, 'clock-in broadcast to everyone');
    eq(inChg.entry.statusText, 'Q3 budget review', 'working-on line broadcast');

    w2.send({ type: 'status', status: 'busy' });
    await sleep(120);
    eq(w1.inbox.filter(m => m.type === 'statusChanged').pop().entry.status, 'busy', 'busy while clocked in');

    w2.send({ type: 'status', statusText: 'budget review v2' });
    await sleep(120);
    eq(w1.inbox.filter(m => m.type === 'statusChanged').pop().entry.statusText, 'budget review v2', 'working-on line editable');

    w2.send({ type: 'clockOut' });
    await sleep(150);
    const outChg = w1.inbox.filter(m => m.type === 'statusChanged').pop();
    eq(outChg.entry.clockedIn, false, 'clock-out broadcast');
    eq(outChg.entry.statusText, '', 'clock-out clears the working-on line');
    eq(outChg.entry.status, 'available', 'clock-out resets busy');

    w2.send({ type: 'profile', fields: { schedule: { fri: [['10:00', '16:00']] }, timeFormat: '12h' } });
    await sleep(150);
    const rUpd = w1.inbox.filter(m => m.type === 'rosterUpdate').pop();
    eq(rUpd.fields.schedule, { fri: [['10:00', '16:00']] }, 'profile schedule update broadcast');
    eq(rUpd.fields.timeFormat, '12h', 'profile timeFormat update broadcast');

    await s10.stop();
  }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/orgtree-mvp && npm run test:chat`
Expected: FAIL — `roster carries schedule` (or earlier assertion in the new section)

- [ ] **Step 3: Implement**

In `src/chat-server.js`:

3a. Add the require at the top (after line 28):

```js
const availability = require('./availability');
```

3b. Replace `buildMinimalRoster` (lines 194-201) with:

```js
  function buildMinimalRoster(r) {
    return r
      .filter(p => !p.isOpenRole)
      .map(p => ({
        id: p.id, name: p.name, title: p.title || '', department: p.department || '',
        timezone: p.timezone || '', workHours: p.workHours || '',
        schedule: availability.normalizeSchedule(p.schedule),
        timeFormat: p.timeFormat === '24h' ? '24h' : '12h',
      }));
  }
```

3c. Right after `let minimalRoster = buildMinimalRoster(roster);` add the ephemeral status map and helpers:

```js
  // Ephemeral presence: never written to the chart file. The working-on line
  // dies with the clock session; busy resets on clock-out.
  const statuses = new Map(); // personId -> { status: 'busy'|undefined, statusText: string }
  function statusEntry(personId) {
    const s = statuses.get(personId) || {};
    return {
      personId,
      clockedIn: !!openSession(personId),
      status: s.status === 'busy' ? 'busy' : 'available',
      statusText: s.statusText || '',
    };
  }
  const statusList = () => minimalRoster.map(p => statusEntry(p.id));
  const pushStatus = (personId) => broadcast({ type: 'statusChanged', entry: statusEntry(personId) });
```

3d. In the connection roster send (line 256), add `statuses`:

```js
    send(ws, { type: 'roster', roster: minimalRoster, channels, taken: online(), retentionDays, statuses: statusList() });
```

3e. In the `welcome` send (lines 275-280), add `statuses: statusList(),` to the payload.

3f. In the `profile` handler, after the string-field loop (line 341), add:

```js
        if (m.fields && m.fields.schedule != null) {
          fields.schedule = availability.normalizeSchedule(m.fields.schedule);
        }
        if (m.fields && (m.fields.timeFormat === '12h' || m.fields.timeFormat === '24h')) {
          fields.timeFormat = m.fields.timeFormat;
        }
```

and extend the roster patch (lines 349-352) with:

```js
          if (fields.schedule != null) rp.schedule = fields.schedule;
          if (fields.timeFormat != null) rp.timeFormat = fields.timeFormat;
```

3g. Replace the `clockIn` handler (lines 364-376) with:

```js
      if (m.type === 'clockIn') {
        const h = pinHashes.get(info.personId);
        if (!h) { send(ws, { type: 'error', error: 'no-pin-set' }); return; }
        if (hashPin(m.pin) !== h) { send(ws, { type: 'error', error: 'bad-pin' }); return; }
        if (!openSession(info.personId)) {
          (timesheet[info.personId] = timesheet[info.personId] || []).push({
            in: Date.now(), out: null, activeSec: 0, sampleSec: 0,
          });
          persistTimesheet();
        }
        if (typeof m.statusText === 'string') {
          const s = statuses.get(info.personId) || {};
          s.statusText = m.statusText.trim().slice(0, 140);
          statuses.set(info.personId, s);
        }
        send(ws, { type: 'clock', status: 'in', summary: summarize(info.personId) });
        pushStatus(info.personId);
        return;
      }
```

3h. Replace the `clockOut` handler with:

```js
      if (m.type === 'clockOut') {
        closeSession(info.personId);
        statuses.delete(info.personId); // working-on line and busy die with the session
        send(ws, { type: 'clock', status: 'out', summary: summarize(info.personId) });
        pushStatus(info.personId);
        return;
      }
```

3i. Add a new `status` handler (right after `clockOut`):

```js
      if (m.type === 'status') {
        if (!openSession(info.personId)) return; // busy/working-on need an active clock session
        const s = statuses.get(info.personId) || {};
        if (m.status === 'busy' || m.status === 'available') s.status = m.status === 'busy' ? 'busy' : undefined;
        if (typeof m.statusText === 'string') s.statusText = m.statusText.trim().slice(0, 140);
        statuses.set(info.personId, s);
        pushStatus(info.personId);
        return;
      }
```

3j. In `updateRoster`, prune statuses for removed people and add `statuses` to the rosterSync push:

```js
          for (const pid of [...statuses.keys()]) {
            if (!validIds.has(pid)) statuses.delete(pid);
          }
          // Push the fresh roster to every socket — including joiners still on
          // the "Who are you?" screen, who have no identity in `conns` yet.
          for (const ws of wss.clients) {
            send(ws, { type: 'rosterSync', roster: minimalRoster, channels, taken: online(), retentionDays, statuses: statusList() });
          }
```

- [ ] **Step 4: Run tests**

Run: `cd ~/orgtree-mvp && npm run test:chat`
Expected: PASS — all assertions (58 + 14 new = 72).

- [ ] **Step 5: Commit**

```bash
cd ~/orgtree-mvp && git add src/chat-server.js test/chat-smoke.js
git commit -m "chat: presence statuses, working-on line, schedule/timeFormat on the wire"
```

---

### Task 4: Shared schedule editor + chart form integration

**Files:**
- Create: `renderer/schedule-editor.js`
- Modify: `renderer/index.html` (modal form lines 278-280, script tags lines 429-433)
- Modify: `renderer/app.js` (globals comment :3, `openEditor` :1323, `savePerson` :1393, drawer row :949)

**Interfaces:**
- Consumes: `OrgtreeAvailability` (Task 1).
- Produces: `window.ScheduleEditor` used by `app.js` (this task) and `chat.js` (Task 5):
  - `ScheduleEditor.mount(container, schedule, opts)` — renders the editor into `container`. `opts`: `{ timeFormat: '12h'|'24h', prefillFrom: string }` (legacy free-text like `"9-5"` prefills Mon–Fri when `schedule` is empty).
  - `ScheduleEditor.read(container)` → normalized schedule object (`{}` when all days empty).
  - `ScheduleEditor.summary(schedule, timeFormat)` → e.g. `'Mon–Fri 9:00 AM–5:00 PM'` or `''`.

- [ ] **Step 1: Create `renderer/schedule-editor.js`**

Renderer-only component (no node test — verified via the boot smoke test and the chart form manually; the schedule math it delegates to is fully covered by `test/availability-smoke.js`):

```js
/* global OrgtreeAvailability */
'use strict';

/**
 * Shared per-weekday working-hours editor. One instance edits one person's
 * schedule; used by the chart form (admin) and chat "My profile" (employee).
 * State lives in the DOM; read() returns a normalized schedule.
 */
window.ScheduleEditor = (() => {
  const WEEK = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']];
  const STEP = 30; // minute grid for the picker

  const hhmm = (mins) => String(Math.floor(mins / 60)).padStart(2, '0') + ':' + String(mins % 60).padStart(2, '0');
  const toMins = (t) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || ''));
    return m ? (+m[1]) * 60 + (+m[2]) : null;
  };

  function timeSelect(cls, valueMins, format) {
    const sel = document.createElement('select');
    sel.className = cls;
    for (let m = 0; m < 1440; m += STEP) {
      const opt = document.createElement('option');
      opt.value = String(m);
      opt.textContent = OrgtreeAvailability.fmtTime(m, format);
      sel.appendChild(opt);
    }
    if (valueMins != null && valueMins % STEP !== 0) {
      const opt = document.createElement('option');
      opt.value = String(valueMins);
      opt.textContent = OrgtreeAvailability.fmtTime(valueMins, format);
      sel.appendChild(opt);
      [...sel.options].sort((a, b) => (+a.value) - (+b.value)).forEach(o => sel.appendChild(o));
    }
    if (valueMins != null) sel.value = String(valueMins);
    return sel;
  }

  function addBlock(blocksEl, format, s, e) {
    const b = document.createElement('span');
    b.className = 'sched-block';
    b.appendChild(timeSelect('sched-start', s, format));
    b.appendChild(document.createTextNode('–'));
    b.appendChild(timeSelect('sched-end', e, format));
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'sched-remove';
    x.title = 'Remove block';
    x.textContent = '×';
    x.addEventListener('click', () => b.remove());
    b.appendChild(x);
    blocksEl.appendChild(b);
  }

  /** Parse legacy free text like "9-5" or "9:00-17:00" into Mon–Fri one block. */
  function prefillFromText(norm, text) {
    if (!OrgtreeAvailability.isEmpty(norm) || !text) return norm;
    const m = /(\d{1,2})(?::(\d{2}))?\s*[-–]\s*(\d{1,2})(?::(\d{2}))?/.exec(text);
    if (!m) return norm;
    const s = (+m[1]) * 60 + (+(m[2] || 0));
    let e = (+m[3]) * 60 + (+(m[4] || 0));
    if (e <= s) e += 12 * 60; // "9-5" means 9:00–17:00
    if (e <= s || e > 1440) return norm;
    for (const d of ['mon', 'tue', 'wed', 'thu', 'fri']) norm[d] = [[hhmm(s), hhmm(e)]];
    return norm;
  }

  function mount(container, schedule, opts = {}) {
    const format = opts.timeFormat === '24h' ? '24h' : '12h';
    const norm = prefillFromText(OrgtreeAvailability.normalizeSchedule(schedule), opts.prefillFrom);
    container.innerHTML = '';
    container.classList.add('sched-editor');
    for (const [key, label] of WEEK) {
      const row = document.createElement('div');
      row.className = 'sched-day';
      row.dataset.day = key;
      const dayLabel = document.createElement('span');
      dayLabel.className = 'sched-day-label';
      dayLabel.textContent = label;
      const blocks = document.createElement('span');
      blocks.className = 'sched-blocks';
      for (const [s, e] of (norm[key] || [])) addBlock(blocks, format, toMins(s), toMins(e));
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'sched-add';
      add.textContent = '+ add';
      add.addEventListener('click', () => addBlock(blocks, format, 540, 1020));
      row.appendChild(dayLabel);
      row.appendChild(blocks);
      row.appendChild(add);
      container.appendChild(row);
    }
  }

  function read(container) {
    const out = {};
    container.querySelectorAll('.sched-day').forEach(row => {
      const blocks = [];
      row.querySelectorAll('.sched-block').forEach(b => {
        const s = b.querySelector('.sched-start').value;
        const e = b.querySelector('.sched-end').value;
        blocks.push([hhmm(+s), hhmm(+e)]);
      });
      if (blocks.length) out[row.dataset.day] = blocks;
    });
    // normalizeSchedule drops start>=end and overlaps rather than erroring mid-form
    return OrgtreeAvailability.normalizeSchedule(out);
  }

  /** Compact human summary, e.g. "Mon–Fri 9:00 AM–12:00 PM, 1:00 PM–5:00 PM". */
  function summary(schedule, format) {
    const norm = OrgtreeAvailability.normalizeSchedule(schedule);
    if (OrgtreeAvailability.isEmpty(norm)) return '';
    const sig = (d) => (norm[d] || [])
      .map(([s, e]) => OrgtreeAvailability.fmtTime(toMins(s), format) + '–' + OrgtreeAvailability.fmtTime(toMins(e), format))
      .join(', ');
    const parts = [];
    let i = 0;
    while (i < WEEK.length) {
      const s = sig(WEEK[i][0]);
      if (!s) { i++; continue; }
      let j = i;
      while (j + 1 < WEEK.length && sig(WEEK[j + 1][0]) === s) j++;
      parts.push((j > i ? WEEK[i][1] + '–' + WEEK[j][1] : WEEK[i][1]) + ' ' + s);
      i = j + 1;
    }
    return parts.join(' · ');
  }

  return { mount, read, summary };
})();
```

- [ ] **Step 2: Wire up `renderer/index.html`**

In the script block at the bottom (lines 429-433), insert availability + editor so the order is:

```html
  <script src="../src/tree.js"></script>
  <script src="../src/csv.js"></script>
  <script src="../src/availability.js"></script>
  <script src="layout.js"></script>
  <script src="schedule-editor.js"></script>
  <script src="app.js"></script>
  <script src="chat.js"></script>
```

Replace the Working hours field in the person editor modal (lines 278-280):

```html
        <label class="span2">Working hours <span class="hint">(blocks per day — a gap between blocks is a break; empty day = day off)</span>
          <div id="f-schedule"></div>
        </label>
```

- [ ] **Step 3: Integrate in `renderer/app.js`**

Update the globals comment (line 3):

```js
/* global OrgtreeTree, OrgtreeCSV, OrgtreeLayout, OrgtreeAvailability, ScheduleEditor */
```

In `openEditor`, replace line 1323 (`$('f-workhours').value = p ? (p.workHours || '') : '';`) with:

```js
  ScheduleEditor.mount($('f-schedule'), p ? p.schedule : null, { timeFormat: '24h', prefillFrom: p ? p.workHours : '' });
```

In `savePerson`, replace `workHours: $('f-workhours').value.trim(),` in the `rec` object with:

```js
    workHours: prev ? (prev.workHours || '') : '',
    schedule: ScheduleEditor.read($('f-schedule')),
```

In the drawer (line 949), replace the Working hours row with:

```js
  html += row('i-timer', 'Working hours', escapeHtml(ScheduleEditor.summary(p.schedule, '12h') || p.workHours));
```

- [ ] **Step 4: Verify boot + all tests**

Run: `cd ~/orgtree-mvp && npm test && npm run test:chat && node test/availability-smoke.js && ORGTREE_SMOKE=1 npx electron . 2>&1 | grep SMOKE`
Expected: all suites pass; SMOKE line shows `tree/csv/bridge: "function"/"object"` and `canvas: true` (app boots with the new script tags).

- [ ] **Step 5: Commit**

```bash
cd ~/orgtree-mvp && git add renderer/schedule-editor.js renderer/index.html renderer/app.js
git commit -m "schedule editor: per-weekday blocks in the chart form + drawer summary"
```

---

### Task 5: Chat client — statuses, dots, availability panel, profile + clock-in

**Files:**
- Modify: `renderer/chat.js` (C state :20-48, handleServer :169-236, renderList :524-626, clockCard :502-522, renderProfile :794-858, render :380-390, disconnect :153-163, welcome handler :185-211, timeclock menu :902-904)

**Interfaces:**
- Consumes: wire protocol from Task 3 (`statuses` lists, `statusChanged`, `status` message, `clockIn.statusText`); `ScheduleEditor` (Task 4); `OrgtreeAvailability` (Task 1).
- Produces: `C.statuses` = `Map<personId, { personId, clockedIn, status, statusText }>`; `dotClass(personId)` → `'on'|'busy'|'late'|'off'`; new panel view `'availability'`.

- [ ] **Step 1: State + server message handling**

In the `C` object (line 25 area), add after `taken: [],`:

```js
    statuses: new Map(), // personId -> { personId, clockedIn, status, statusText }
```

Add a helper after `personById` (line 91):

```js
  function applyStatusList(list) {
    C.statuses = new Map((list || []).map(e => [e.personId, e]));
  }
```

In `handleServer`:
- In the `roster` handler (line 170) and the `rosterSync` handler, add `applyStatusList(m.statuses);` before `render()`.
- In the `welcome` handler (line 185), add `applyStatusList(m.statuses);` after `C.you = m.you;`.
- Extend the `rosterUpdate` handler (line 230) so the fields loop also covers `timeFormat` and `schedule`:

```js
    if (m.type === 'rosterUpdate') {
      const p = personById(m.personId);
      if (p && m.fields) {
        for (const k of ['timezone', 'workHours', 'timeFormat']) if (m.fields[k] != null) p[k] = m.fields[k];
        if (m.fields.schedule != null) p.schedule = m.fields.schedule;
      }
      return;
    }
```

- Add a new handler (right after `rosterUpdate`):

```js
    if (m.type === 'statusChanged') {
      if (m.entry) {
        C.statuses.set(m.entry.personId, m.entry);
        if (C.you && m.entry.personId === C.you.id) {
          C.clockedIn = !!m.entry.clockedIn;
          updateClockIndicator();
          if (clockMenuOpen()) renderClockMenu();
        }
        if (['list', 'availability'].includes(C.view)) render();
      }
      return;
    }
```

Add the 60-second refresh timer. In the `welcome` handler, next to the existing `tsRefreshTimer` setup:

```js
      clearInterval(availTimer);
      availTimer = setInterval(() => {
        if (['availability', 'list'].includes(C.view)) render();
      }, 60000);
```

Declare `let availTimer = null;` next to `let tsRefreshTimer = null;` (line 57), and in `disconnect` add `clearInterval(availTimer); availTimer = null;` next to the existing clear.

- [ ] **Step 2: Presence dots**

Add after `channelLabel` (line 105):

```js
  // green = clocked in, yellow = busy, red = scheduled now but not clocked in,
  // grey ('off') = outside scheduled hours / no schedule.
  function dotClass(pid) {
    const e = C.statuses.get(pid);
    if (e && e.clockedIn) return e.status === 'busy' ? 'busy' : 'on';
    const p = personById(pid);
    if (p && window.OrgtreeAvailability && !OrgtreeAvailability.isEmpty(p.schedule)) {
      const st = OrgtreeAvailability.stateAt(p.schedule, p.timezone, new Date());
      if (st.state !== 'off' && st.state !== 'none') return 'late';
    }
    return 'off';
  }
  function statusTextOf(pid) {
    const e = C.statuses.get(pid);
    return e && e.clockedIn ? (e.statusText || '') : '';
  }
```

In `renderList` DM rows (line 582-590), replace the `bits` array with presence-aware content and use `dotClass`:

```js
    for (const p of C.roster.filter(p => p.id !== C.you.id)) {
      const bits = [p.title || '—'];
      const workingOn = statusTextOf(p.id);
      if (workingOn) bits.push('working on: ' + workingOn);
      if (p.timezone) {
        bits.push(OrgtreeAvailability.clockInTz(p.timezone, new Date(), (C.you && C.you.timeFormat) || '12h') + ' local');
      }
      html += chRow(dmChannel(C.you.id, p.id), p.name, bits.join(' · '), true, p.id);
    }
```

In `chRow`, replace the DM dot `<span class="chat-dot ${onlineSet.has(otherId) ? 'on' : ''}"></span>` with:

```js
          `<span class="chat-dot ${dotClass(otherId)}"></span>`
```

In the admin timesheet rows (line 567), replace `<span class="chat-dot ${t.clockedIn ? 'on' : ''}"></span>` with `<span class="chat-dot ${dotClass(t.personId)}"></span>`.

- [ ] **Step 3: Availability panel view**

Register the view in `render()` (line 389 area):

```js
    else if (C.view === 'availability') renderAvailability();
```

Add an entry button to `headBtns` in `renderList` (before the profile button):

```js
      <button class="chat-icon-btn" id="chat-avail" title="Team availability"><svg class="icon"><use href="#i-users"/></svg></button>
```

and wire it next to the `chat-profile` wiring (line 608):

```js
    const avail = $('chat-avail');
    if (avail) avail.addEventListener('click', () => { C.view = 'availability'; C.error = ''; render(); });
```

Add the view itself (new function next to `renderList`):

```js
  function renderAvailability() {
    const AV = OrgtreeAvailability;
    const tf = (C.you && C.you.timeFormat) || '12h';
    const now = new Date();
    const nowMin = (now.getHours() * 60 + now.getMinutes());
    const order = { working: 0, break: 1, starts: 2, off: 3, none: 4 };

    const rows = C.roster.map(p => {
      const st = AV.stateAt(p.schedule, p.timezone, now);
      return { p, st, tl: AV.viewerTimeline(p.schedule, p.timezone, undefined, now) };
    }).sort((a, b) =>
      (order[a.st.state] - order[b.st.state]) || ((a.st.nextStart || 0) - (b.st.nextStart || 0)));

    const pill = (st) => {
      switch (st.state) {
        case 'working': return `<span class="avail-pill on">Available now</span>`;
        case 'break': return `<span class="avail-pill break">On break — back in ${AV.fmtCountdown(st.nextStart)}</span>`;
        case 'starts': return `<span class="avail-pill">Starts in ${AV.fmtCountdown(st.nextStart)}</span>`;
        case 'off': return `<span class="avail-pill off">Off today${st.nextStart ? ' — back in ' + AV.fmtCountdown(st.nextStart) : ''}</span>`;
        default: return `<span class="avail-pill off">No schedule</span>`;
      }
    };

    let html = header('Team availability', { back: true, sub: 'Their blocks, in your timezone' }) + '<div class="chat-body">' + errLine();
    for (const { p, st, tl } of rows) {
      const workingOn = statusTextOf(p.id);
      const segs = tl.map(s =>
        `<span class="avail-seg" style="left:${(s.startMin / 1440 * 100).toFixed(2)}%;width:${((s.endMin - s.startMin) / 1440 * 100).toFixed(2)}%"></span>`).join('');
      html += `<div class="avail-row">
        <div class="avail-top">
          <span class="chat-dot ${dotClass(p.id)}"></span>
          <span class="chat-row-main">
            <span class="chat-row-name">${esc(p.name)}${p.id === C.you.id ? ' (you)' : ''}</span>
            <span class="chat-row-sub">${esc(AV.clockInTz(p.timezone, now, tf))} local${workingOn ? ' · working on: ' + esc(workingOn) : ''}</span>
          </span>
          ${pill(st)}
        </div>
        <div class="avail-track">${segs}<span class="avail-now" style="left:${(nowMin / 1440 * 100).toFixed(2)}%"></span></div>
      </div>`;
    }
    html += '</div>';
    panel.innerHTML = html;
    wireCommon();
    $('chat-back').addEventListener('click', () => { C.view = 'list'; render(); });
  }
```

- [ ] **Step 4: My profile — schedule editor + time format**

In `renderProfile`, replace the Working hours label (line 813) with:

```js
          <label>Time display
            <select id="pf-timeformat">
              <option value="12h" ${(me.timeFormat || '12h') === '12h' ? 'selected' : ''}>12-hour (2:30 PM)</option>
              <option value="24h" ${me.timeFormat === '24h' ? 'selected' : ''}>24-hour (14:30)</option>
            </select>
          </label>
          <label>Working hours <span class="hint">(blocks per day; a gap between blocks is a break)</span>
            <div id="pf-schedule"></div>
          </label>
```

After `wireCommon();` in `renderProfile`, mount the editor:

```js
    ScheduleEditor.mount($('pf-schedule'), me.schedule, { timeFormat: me.timeFormat || '12h', prefillFrom: me.workHours });
```

In the `pf-save` click handler, replace the `map` line so `workHours` is no longer read from an input, and always send schedule + timeFormat:

```js
      const fields = {};
      const map = { phone: 'pf-phone', location: 'pf-location', timezone: 'pf-timezone', startDate: 'pf-start', notes: 'pf-notes' };
      for (const [k, id] of Object.entries(map)) {
        const v = $(id).value.trim();
        if (v) fields[k] = v;
      }
      fields.schedule = ScheduleEditor.read($('pf-schedule'));
      fields.timeFormat = $('pf-timeformat').value;
```

(Drop the `Nothing to save yet.` early-return condition's reliance on empty fields — schedule/timeFormat are always present now, so the guard `if (!Object.keys(fields).length && !pin)` can never trigger; leave the code as-is otherwise.)

- [ ] **Step 5: Clock-in "working on" + busy toggle**

In `clockCard` (lines 511-521), replace the not-clocked-in branch:

```js
    return `<div class="chat-clock">
      <svg class="icon"><use href="#i-timer"/></svg>
      <input type="password" id="chat-pin" placeholder="PIN" maxlength="8" inputmode="numeric" style="width:64px">
      <input type="text" id="chat-status-text" placeholder="Working on… (optional)" maxlength="140" style="flex:1">
      <button class="btn small primary" id="chat-clock-in">Clock in</button>
    </div>`;
```

and the clocked-in branch (lines 504-510) with:

```js
    const me = C.statuses.get(C.you.id) || {};
    return `<div class="chat-clock on">
      <svg class="icon"><use href="#i-timer"/></svg>
      <span><b>Clocked in${me.status === 'busy' ? ' — busy' : ''}.</b>${me.statusText ? ' Working on: ' + esc(me.statusText) : ''}</span>
      <button class="btn small ghost" id="chat-busy">${me.status === 'busy' ? 'Mark available' : 'Mark busy'}</button>
      <button class="btn small ghost" id="chat-clock-out">Clock out</button>
    </div>`;
```

In `renderList` wiring (line 622-625), update clock-in and add busy:

```js
    const cin = $('chat-clock-in');
    if (cin) cin.addEventListener('click', () => {
      const st = $('chat-status-text');
      sendServer({ type: 'clockIn', pin: $('chat-pin').value, statusText: st ? st.value.trim() : '' });
    });
    const busy = $('chat-busy');
    if (busy) busy.addEventListener('click', () => {
      const me = C.statuses.get(C.you.id) || {};
      sendServer({ type: 'status', status: me.status === 'busy' ? 'available' : 'busy' });
    });
```

In the timeclock topbar menu (`renderClockMenu`, line 904), add the optional line to the PIN row:

```js
          <div class="chat-inline"><input type="password" id="tc-pin" placeholder="PIN" maxlength="8" inputmode="numeric"><input type="text" id="tc-status-text" placeholder="Working on…" maxlength="140" style="flex:1"><button class="btn small primary" id="tc-in" style="flex:1">Clock in</button></div>`;
```

and update both `clockIn` sends in that function to include it:

```js
    if (tin) tin.addEventListener('click', (e) => {
      e.stopPropagation();
      const st = $('tc-status-text');
      sendServer({ type: 'clockIn', pin: $('tc-pin').value, statusText: st ? st.value.trim() : '' });
    });
```

(same `statusText` addition in the Enter-key handler for `tc-pin`).

In the profile clock block (lines 826-828), add the same optional input next to `pf-clock-pin` and include it in the `pf-clock-in` send:

```js
            : `<span><b>Track your hours:</b></span>
               <input type="password" id="pf-clock-pin" placeholder="PIN" maxlength="8" inputmode="numeric" style="width:64px">
               <input type="text" id="pf-status-text" placeholder="Working on… (optional)" maxlength="140" style="flex:1">
               <button class="btn small primary" id="pf-clock-in">Clock in</button>`}
```

```js
    if (pfIn) pfIn.addEventListener('click', () => sendServer({ type: 'clockIn', pin: $('pf-clock-pin').value, statusText: $('pf-status-text').value.trim() }));
```

- [ ] **Step 6: Verify all tests**

Run: `cd ~/orgtree-mvp && npm test && npm run test:chat && node test/availability-smoke.js`
Expected: all green (renderer changes are covered indirectly; protocol already tested in Task 3).

- [ ] **Step 7: Commit**

```bash
cd ~/orgtree-mvp && git add renderer/chat.js
git commit -m "chat: availability panel, presence dots, working-on line, 12h/24h display"
```

---

### Task 6: Styles

**Files:**
- Modify: `renderer/styles.css` (append; first check the existing `.chat-dot` definition to match sizing)

**Interfaces:**
- Consumes: class hooks from Task 5 (`chat-dot busy/late/off`, `avail-*`) and Task 4 (`sched-*`).
- Produces: none.

- [ ] **Step 1: Inspect existing dot/chip styles**

Run: `cd ~/orgtree-mvp && grep -n "chat-dot\|chat-row\b\|chat-clock" renderer/styles.css | head -20`
Read the matching rules so the additions reuse the same variables (`--accent`, `--muted`, `--border`, `--surface`, `--bg`).

- [ ] **Step 2: Append styles**

Append to `renderer/styles.css` (adjust values to match what Step 1 shows):

```css
/* ---------- presence dots ---------- */
.chat-dot.off { background: var(--muted); }
.chat-dot.busy { background: #e6a700; }
.chat-dot.late { background: #d64545; }

/* ---------- availability panel ---------- */
.avail-row { padding: 8px 0; border-bottom: 1px solid var(--border); }
.avail-top { display: flex; align-items: center; gap: 8px; }
.avail-pill { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: var(--bg); border: 1px solid var(--border); white-space: nowrap; }
.avail-pill.on { color: #1a7f37; border-color: #1a7f3755; background: #1a7f3714; }
.avail-pill.break { color: #9a6a00; border-color: #e6a70055; background: #e6a70014; }
.avail-pill.off { color: var(--muted); }
.avail-track { position: relative; height: 8px; margin: 6px 0 2px 16px; border-radius: 4px; background: var(--bg); border: 1px solid var(--border); overflow: hidden; }
.avail-seg { position: absolute; top: 0; bottom: 0; background: var(--accent); opacity: 0.75; border-radius: 3px; }
.avail-now { position: absolute; top: -2px; bottom: -2px; width: 2px; background: #d64545; }

/* ---------- schedule editor ---------- */
.sched-editor { display: flex; flex-direction: column; gap: 4px; margin-top: 4px; }
.sched-day { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.sched-day-label { width: 34px; font-size: 12px; color: var(--muted); }
.sched-blocks { display: inline-flex; gap: 6px; flex-wrap: wrap; }
.sched-block { display: inline-flex; align-items: center; gap: 4px; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 2px 6px; }
.sched-block select { background: transparent; border: none; color: var(--text); font-size: 12px; }
.sched-remove { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 13px; padding: 0 2px; }
.sched-remove:hover { color: #d64545; }
.sched-add { background: none; border: none; color: var(--accent); cursor: pointer; font-size: 12px; padding: 2px; }
```

- [ ] **Step 3: Commit**

```bash
cd ~/orgtree-mvp && git add renderer/styles.css
git commit -m "styles: presence dots, availability panel, schedule editor"
```

---

### Task 7: Version bump, full verification, local build + install

**Files:**
- Modify: `package.json` (`"version": "1.5.6"` → `"1.6.0"`)

- [ ] **Step 1: Bump version**

Edit `package.json`: `"version": "1.6.0"`.

- [ ] **Step 2: Full test run**

Run: `cd ~/orgtree-mvp && npm test && npm run test:chat && node test/availability-smoke.js`
Expected: 92 + 72 + 32 assertions, all green.

- [ ] **Step 3: Boot smoke**

Run: `cd ~/orgtree-mvp && ORGTREE_SMOKE=1 npx electron . 2>&1 | grep SMOKE`
Expected: `SMOKE:{"tree":"function","csv":"object","bridge":"object","canvas":true,...}`

- [ ] **Step 4: Build + install (macOS arm64, unsigned dir build)**

```bash
cd ~/orgtree-mvp && npx electron-builder --mac dir --arm64 2>&1 | tail -3
osascript -e 'quit app "WholeTeam"' 2>/dev/null; sleep 2; pkill -f "WholeTeam.app" 2>/dev/null; sleep 1
rm -rf /Applications/WholeTeam.app && cp -R dist/mac-arm64/WholeTeam.app /Applications/
xattr -dr com.apple.quarantine /Applications/WholeTeam.app
defaults read /Applications/WholeTeam.app/Contents/Info.plist CFBundleShortVersionString
open -a /Applications/WholeTeam.app && sleep 6 && pgrep -fl "WholeTeam.app/Contents/MacOS"
```

Expected: version prints `1.6.0`, app process running.

- [ ] **Step 5: Manual acceptance (user journey)**

With the app open: Team Chat → Start hosting → pick yourself → open the availability button (team icon) → set your own blocks in My profile → watch the panel update live → clock in with a "working on" line → confirm the dot turns green and the line shows in the DM list.

- [ ] **Step 6: Commit**

```bash
cd ~/orgtree-mvp && git add package.json
git commit -m "1.6.0: team availability + presence"
```

---

## Self-Review Notes

- Spec coverage: data model (Task 2), engine (Task 1), server (Task 3), schedule editor in both surfaces (Tasks 4+5), availability panel, dots, working-on line, 12h/24h (Task 5), styles (Task 6), edge cases from the spec (busy requires clock-in — server-enforced in Task 3; malformed schedules dropped — Task 2; no-schedule people — engine `none` state).
- The legacy `workHours` string is preserved untouched on edit (prefill-only), per spec.
- Git commits in each task require the user's explicit go-ahead before execution (standing rule) — confirm at handoff.
