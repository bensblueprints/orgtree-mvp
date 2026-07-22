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
