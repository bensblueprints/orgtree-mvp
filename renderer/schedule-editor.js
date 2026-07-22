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
