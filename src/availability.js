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
