/**
 * Orgtree Chat — closed-loop LAN chat server. Pure Node (http + ws), no cloud.
 *
 * One machine on the office network hosts; everyone else connects to
 * ws://<host-ip>:<port>. Channels come from the org chart itself:
 *   'org'           — everyone
 *   'dept:<name>'   — one per department
 *   'dm:<a>|<b>'    — direct messages (only delivered to the two people)
 *
 * Identity is claimed from the roster (one connection per person).
 *
 * Extras:
 *  - Disappearing messages: retentionDays prunes chat history AND library
 *    entries (files deleted from disk) older than the window.
 *  - Library: files shared in org/department channels, plus links auto-captured
 *    from messages, are kept per-channel for later access. DM files are stored
 *    for the pair only and never listed in a shared library.
 *
 * Everything lives on the host machine — nothing ever leaves the network.
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const availability = require('./availability');

const HISTORY_CAP = 500;              // messages per channel
const TEXT_CAP = 4000;                // chars per message
// Practical ceiling of the JSON-over-websocket transfer (V8 max string length
// caps the base64 payload around 512MB). Streaming transfer lifts this later.
const FILE_CAP = 300 * 1024 * 1024;   // bytes per shared file
const LIBRARY_CAP = 2000;             // entries overall
const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;

function dmChannel(a, b) {
  return 'dm:' + [String(a), String(b)].sort().join('|');
}

function dmMembers(channel) {
  return String(channel).slice(3).split('|');
}

function sanitizeName(name) {
  return String(name || 'file').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) || 'file';
}

// Fields an employee may edit about THEMSELVES over the wire. Role (title),
// department, and manager are admin-only — the host edits those on the chart.
const PROFILE_FIELDS = ['phone', 'location', 'startDate', 'notes', 'timezone', 'workHours'];

function hashPin(pin) {
  return crypto.createHash('sha256').update('orgtree-pin:' + String(pin)).digest('hex');
}

function createChatServer({
  port = 4600, roster = [], storeFile = null, retentionDays = null, filesDir = null,
  onProfileUpdate = null, timesheetFile = null,
} = {}) {
  retentionDays = Number(retentionDays) > 0 ? Number(retentionDays) : null;

  // ----- history -----
  let history = {};
  if (storeFile && fs.existsSync(storeFile)) {
    try { history = JSON.parse(fs.readFileSync(storeFile, 'utf8')) || {}; } catch (_) { history = {}; }
  }
  let saveTimer = null;
  const persist = () => {
    if (!storeFile) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { fs.writeFileSync(storeFile, JSON.stringify(history)); } catch (_) { /* best effort */ }
    }, 800);
  };

  // ----- library (files + links) -----
  let library = [];
  const memFiles = new Map(); // id -> Buffer, when no filesDir
  let libFile = null;
  if (filesDir) {
    fs.mkdirSync(filesDir, { recursive: true });
    libFile = path.join(filesDir, 'library.json');
    if (fs.existsSync(libFile)) {
      try { library = JSON.parse(fs.readFileSync(libFile, 'utf8')) || []; } catch (_) { library = []; }
    }
  }
  let libTimer = null;
  const persistLibrary = () => {
    if (!libFile) return;
    clearTimeout(libTimer);
    libTimer = setTimeout(() => {
      try { fs.writeFileSync(libFile, JSON.stringify(library)); } catch (_) { /* best effort */ }
    }, 800);
  };

  function fileDiskPath(id) { return filesDir ? path.join(filesDir, String(id)) : null; }

  function storeFileData(id, buf) {
    if (filesDir) fs.writeFileSync(fileDiskPath(id), buf);
    else memFiles.set(id, buf);
  }
  function readFileData(id) {
    if (filesDir) {
      const p = fileDiskPath(id);
      return fs.existsSync(p) ? fs.readFileSync(p) : null;
    }
    return memFiles.get(id) || null;
  }
  function deleteFileData(id) {
    if (filesDir) { try { fs.unlinkSync(fileDiskPath(id)); } catch (_) {} }
    memFiles.delete(id);
  }

  function addLibraryEntry(entry) {
    library.push(entry);
    if (library.length > LIBRARY_CAP) {
      for (const old of library.splice(0, library.length - LIBRARY_CAP)) {
        if (old.kind === 'file') deleteFileData(old.id);
      }
    }
    persistLibrary();
  }

  // ----- disappearing messages -----
  function cutoffTs() { return retentionDays ? Date.now() - retentionDays * 86400000 : null; }

  function pruneChannel(ch) {
    const cutoff = cutoffTs();
    if (!cutoff || !history[ch]) return;
    const kept = history[ch].filter(m => m.ts >= cutoff);
    if (kept.length !== history[ch].length) {
      if (kept.length) history[ch] = kept; else delete history[ch];
      persist();
    }
  }
  // Retention prunes CHAT MESSAGES ONLY. Shared files and links live in the
  // library forever — disappearing chats never delete the team's documents.
  function pruneAll() {
    const cutoff = cutoffTs();
    if (!cutoff) return;
    for (const ch of Object.keys(history)) pruneChannel(ch);
  }

  // ----- timesheets (PIN clock-in, idle-based activity ratio) -----
  let timesheet = {};   // personId -> [{in, out, activeSec, sampleSec}]
  if (timesheetFile && fs.existsSync(timesheetFile)) {
    try { timesheet = JSON.parse(fs.readFileSync(timesheetFile, 'utf8')) || {}; } catch (_) { timesheet = {}; }
  }
  let tsTimer = null;
  const persistTimesheet = () => {
    if (!timesheetFile) return;
    clearTimeout(tsTimer);
    tsTimer = setTimeout(() => {
      try { fs.writeFileSync(timesheetFile, JSON.stringify(timesheet)); } catch (_) { /* best effort */ }
    }, 800);
  };
  const pinHashes = new Map(roster.map(p => [p.id, p.pinHash || null]));

  function openSession(personId) {
    return (timesheet[personId] || []).find(s => !s.out) || null;
  }
  function closeSession(personId) {
    const s = openSession(personId);
    if (s) { s.out = Date.now(); persistTimesheet(); }
    return s;
  }
  function summarize(personId) {
    const now = new Date();
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const weekStart = dayStart - ((now.getDay() + 6) % 7) * 86400000; // Monday
    let todaySec = 0, weekSec = 0, activeSec = 0, sampleSec = 0;
    for (const s of timesheet[personId] || []) {
      const end = s.out || Date.now();
      const dur = Math.max(0, (end - s.in) / 1000);
      if (end >= weekStart) {
        weekSec += dur;
        activeSec += s.activeSec || 0;
        sampleSec += s.sampleSec || 0;
      }
      if (end >= dayStart) todaySec += Math.max(0, (end - Math.max(s.in, dayStart)) / 1000);
    }
    return {
      personId,
      todaySec: Math.round(todaySec),
      weekSec: Math.round(weekSec),
      activePct: sampleSec > 0 ? Math.round((activeSec / sampleSec) * 100) : null,
      clockedIn: !!openSession(personId),
    };
  }

  // ----- roster / channels -----
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
  let minimalRoster = buildMinimalRoster(roster);

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
  let departments = [...new Set(minimalRoster.map(p => p.department).filter(Boolean))].sort();
  let channels = [
    { id: 'org', label: 'Everyone' },
    ...departments.map(d => ({ id: 'dept:' + d, label: d })),
  ];

  const conns = new Map(); // ws -> {personId, name}
  const online = () => [...conns.values()].map(c => c.personId);

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Orgtree chat server\n');
  });
  const wss = new WebSocketServer({ server, maxPayload: 512 * 1024 * 1024 });

  function send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch (_) { /* gone */ } }
  function broadcast(obj, filter) {
    for (const [ws, info] of conns) {
      if (!filter || filter(info)) send(ws, obj);
    }
  }
  function routeToChannel(channel, out) {
    if (channel.startsWith('dm:')) {
      const pair = dmMembers(channel);
      broadcast(out, i => pair.includes(i.personId));
    } else {
      broadcast(out);
    }
  }

  function pushMsg(channel, msg) {
    (history[channel] = history[channel] || []).push(msg);
    if (history[channel].length > HISTORY_CAP) history[channel] = history[channel].slice(-HISTORY_CAP);
    persist();
  }

  function canAccess(info, entry) {
    if (!String(entry.channel).startsWith('dm:')) return true;
    return dmMembers(entry.channel).includes(info.personId);
  }

  pruneAll();
  const pruneTimer = setInterval(pruneAll, 10 * 60 * 1000);
  if (pruneTimer.unref) pruneTimer.unref();

  wss.on('connection', (ws, req) => {
    // Connections from the host machine itself are the admin (the host is the
    // only one with edit access to other employees).
    const remoteAddr = (req && req.socket && req.socket.remoteAddress) || '';
    const isAdmin = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteAddr);
    ws._orgtreeAdmin = isAdmin;

    // First contact: hand over the roster so the joiner can pick who they are.
    send(ws, { type: 'roster', roster: minimalRoster, channels, taken: online(), retentionDays, statuses: statusList() });

    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch (_) { return; }
      const info = conns.get(ws);

      if (m.type === 'hello') {
        if (info) return; // already identified
        if (!m.personId || online().includes(String(m.personId))) {
          send(ws, { type: 'error', error: 'identity-taken' });
          return;
        }
        const person = minimalRoster.find(p => p.id === String(m.personId));
        if (!person) {
          send(ws, { type: 'error', error: 'unknown-person' });
          return;
        }
        conns.set(ws, { personId: person.id, name: person.name, admin: ws._orgtreeAdmin });
        send(ws, {
          type: 'welcome', you: person, channels, online: online(), retentionDays,
          admin: ws._orgtreeAdmin,
          pinSet: !!pinHashes.get(person.id),
          clockedIn: !!openSession(person.id),
          statuses: statusList(),
        });
        broadcast({ type: 'presence', online: online() });
        return;
      }

      if (!info) return; // everything below requires an identity

      if (m.type === 'msg') {
        const channel = String(m.channel || '');
        const text = String(m.text || '').slice(0, TEXT_CAP).trim();
        if (!text || !channel) return;
        if (channel.startsWith('dm:') && !dmMembers(channel).includes(info.personId)) return;
        const msg = { channel, from: info.personId, fromName: info.name, text, ts: Date.now() };
        pushMsg(channel, msg);
        routeToChannel(channel, { type: 'msg', ...msg });

        // auto-capture links into the shared library (never from DMs)
        if (!channel.startsWith('dm:')) {
          for (const url of text.match(URL_RE) || []) {
            addLibraryEntry({
              id: 'l-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36),
              kind: 'link', channel, url,
              from: info.personId, fromName: info.name, ts: Date.now(),
            });
          }
          routeToChannel(channel, { type: 'libraryChanged', channel });
        }
        return;
      }

      if (m.type === 'file') {
        const channel = String(m.channel || '');
        if (!channel) return;
        if (channel.startsWith('dm:') && !dmMembers(channel).includes(info.personId)) return;
        let buf;
        try { buf = Buffer.from(String(m.data || ''), 'base64'); } catch (_) { return; }
        if (!buf.length) return;
        if (buf.length > FILE_CAP) { send(ws, { type: 'error', error: 'file-too-large' }); return; }
        const id = 'f-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
        const name = sanitizeName(m.name);
        try { storeFileData(id, buf); } catch (err) { send(ws, { type: 'error', error: 'file-store-failed' }); return; }
        const entry = {
          id, kind: 'file', channel, name, size: buf.length,
          from: info.personId, fromName: info.name, ts: Date.now(),
        };
        addLibraryEntry(entry);
        const msg = {
          channel, from: info.personId, fromName: info.name, ts: entry.ts,
          kind: 'file', fileId: id, fileName: name, size: buf.length, text: '',
        };
        pushMsg(channel, msg);
        routeToChannel(channel, { type: 'msg', ...msg });
        if (!channel.startsWith('dm:')) routeToChannel(channel, { type: 'libraryChanged', channel });
        return;
      }

      if (m.type === 'profile') {
        // Employees update their OWN contact details only (see PROFILE_FIELDS).
        const fields = {};
        for (const k of PROFILE_FIELDS) {
          if (m.fields && typeof m.fields[k] === 'string') fields[k] = m.fields[k].slice(0, 300);
        }
        if (m.fields && m.fields.schedule != null) {
          fields.schedule = availability.normalizeSchedule(m.fields.schedule);
        }
        if (m.fields && (m.fields.timeFormat === '12h' || m.fields.timeFormat === '24h')) {
          fields.timeFormat = m.fields.timeFormat;
        }
        if (m.pin && /^\d{4,8}$/.test(String(m.pin))) {
          const h = hashPin(m.pin);
          pinHashes.set(info.personId, h);
          fields.pinHash = h;
        }
        if (!Object.keys(fields).length) return;
        const rp = minimalRoster.find(p => p.id === info.personId);
        if (rp) {
          if (fields.timezone != null) rp.timezone = fields.timezone;
          if (fields.workHours != null) rp.workHours = fields.workHours;
          if (fields.schedule != null) rp.schedule = fields.schedule;
          if (fields.timeFormat != null) rp.timeFormat = fields.timeFormat;
        }
        if (typeof onProfileUpdate === 'function') {
          try { onProfileUpdate(info.personId, fields); } catch (_) { /* host-side */ }
        }
        const { pinHash, ...publicFields } = fields;
        if (Object.keys(publicFields).length) {
          broadcast({ type: 'rosterUpdate', personId: info.personId, fields: publicFields });
        }
        send(ws, { type: 'profileSaved', pinSet: !!pinHashes.get(info.personId) });
        return;
      }

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

      if (m.type === 'clockOut') {
        closeSession(info.personId);
        statuses.delete(info.personId); // working-on line and busy die with the session
        send(ws, { type: 'clock', status: 'out', summary: summarize(info.personId) });
        pushStatus(info.personId);
        return;
      }

      if (m.type === 'status') {
        if (!openSession(info.personId)) return; // busy/working-on need an active clock session
        const s = statuses.get(info.personId) || {};
        if (m.status === 'busy' || m.status === 'available') s.status = m.status === 'busy' ? 'busy' : undefined;
        if (typeof m.statusText === 'string') s.statusText = m.statusText.trim().slice(0, 140);
        statuses.set(info.personId, s);
        pushStatus(info.personId);
        return;
      }

      if (m.type === 'activity') {
        // Idle-derived activity sample from a clocked-in client. Counts only —
        // no keystrokes or content are ever transmitted.
        const s = openSession(info.personId);
        if (!s) return;
        const sample = Math.min(Math.max(0, Number(m.sampleSec) || 0), 900);
        const active = Math.min(Math.max(0, Number(m.activeSec) || 0), sample);
        s.sampleSec += sample;
        s.activeSec += active;
        persistTimesheet();
        return;
      }

      if (m.type === 'timesheet') {
        const target = m.personId ? String(m.personId) : null;
        if (target && target !== info.personId && !info.admin) {
          send(ws, { type: 'error', error: 'not-allowed' });
          return;
        }
        let entries;
        if (target) entries = [summarize(target)];
        else if (info.admin) entries = minimalRoster.map(p => summarize(p.id));
        else entries = [summarize(info.personId)];
        send(ws, { type: 'timesheet', entries });
        return;
      }

      if (m.type === 'library') {
        const ch = String(m.channel || '');
        pruneAll();
        let entries;
        if (ch === '*') {
          // the shared-files bucket: everything except private DM files
          entries = library.filter(e => !String(e.channel).startsWith('dm:'));
        } else {
          entries = library.filter(e => e.channel === ch);
          if (ch.startsWith('dm:') && !dmMembers(ch).includes(info.personId)) entries = [];
        }
        send(ws, { type: 'library', channel: ch, entries });
        return;
      }

      if (m.type === 'fileGet') {
        const entry = library.find(e => e.id === String(m.id) && e.kind === 'file');
        if (!entry || !canAccess(info, entry)) { send(ws, { type: 'error', error: 'file-not-found' }); return; }
        const buf = readFileData(entry.id);
        if (!buf) { send(ws, { type: 'error', error: 'file-not-found' }); return; }
        send(ws, {
          type: 'fileData', id: entry.id, name: entry.name, channel: entry.channel,
          reason: m.reason || 'download', data: buf.toString('base64'),
        });
        return;
      }

      if (m.type === 'search') {
        const q = String(m.q || '').toLowerCase().trim();
        if (!q) return;
        const results = [];
        for (const [ch, msgs] of Object.entries(history)) {
          if (ch.startsWith('dm:') && !dmMembers(ch).includes(info.personId)) continue;
          for (const msg of msgs) {
            const hay = ((msg.text || '') + ' ' + (msg.fileName || '') + ' ' + (msg.fromName || '')).toLowerCase();
            if (hay.includes(q)) results.push(msg);
          }
        }
        results.sort((a, b) => b.ts - a.ts);
        send(ws, { type: 'searchResults', q, results: results.slice(0, 50) });
        return;
      }

      if (m.type === 'history') {
        const ch = String(m.channel || '');
        pruneChannel(ch);
        let msgs = history[ch] || [];
        if (ch.startsWith('dm:') && !dmMembers(ch).includes(info.personId)) msgs = [];
        send(ws, { type: 'history', channel: ch, messages: msgs.slice(-200) });
      }
    });

    ws.on('close', () => {
      const info = conns.get(ws);
      if (info) {
        closeSession(info.personId); // disconnect = automatic clock-out
        statuses.delete(info.personId); // working-on line and busy die with the session
        pushStatus(info.personId);
      }
      if (conns.delete(ws)) broadcast({ type: 'presence', online: online() });
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      resolve({
        port,
        retentionDays,
        clientCount: () => conns.size,
        /** Host chart changed (person deleted/edited/added): refresh the live
         *  roster, kick connections for removed people, close their clock
         *  sessions, push the new roster to every socket (even joiners who
         *  haven't picked an identity yet), and push fresh timesheets to
         *  admins immediately. */
        updateRoster: (newRoster) => {
          minimalRoster = buildMinimalRoster(newRoster || []);
          departments = [...new Set(minimalRoster.map(p => p.department).filter(Boolean))].sort();
          channels = [
            { id: 'org', label: 'Everyone' },
            ...departments.map(d => ({ id: 'dept:' + d, label: d })),
          ];
          pinHashes.clear();
          for (const p of newRoster || []) pinHashes.set(p.id, p.pinHash || null);
          const validIds = new Set(minimalRoster.map(p => p.id));
          for (const [ws, info] of conns) {
            if (!validIds.has(info.personId)) {
              closeSession(info.personId);
              try { ws.close(); } catch (_) { /* gone */ }
            }
          }
          for (const pid of [...statuses.keys()]) {
            if (!validIds.has(pid)) statuses.delete(pid);
          }
          // Push the fresh roster to every socket — including joiners still on
          // the "Who are you?" screen, who have no identity in `conns` yet.
          for (const ws of wss.clients) {
            send(ws, { type: 'rosterSync', roster: minimalRoster, channels, taken: online(), retentionDays, statuses: statusList() });
          }
          for (const [ws, info] of conns) {
            if (info.admin && validIds.has(info.personId)) {
              send(ws, { type: 'timesheet', entries: minimalRoster.map(p => summarize(p.id)) });
            }
          }
        },
        stop: () => new Promise((r) => {
          clearInterval(pruneTimer);
          clearTimeout(saveTimer);
          clearTimeout(libTimer);
          clearTimeout(tsTimer);
          for (const pid of Object.keys(timesheet)) closeSession(pid);
          if (storeFile) { try { fs.writeFileSync(storeFile, JSON.stringify(history)); } catch (_) {} }
          if (libFile) { try { fs.writeFileSync(libFile, JSON.stringify(library)); } catch (_) {} }
          if (timesheetFile) { try { fs.writeFileSync(timesheetFile, JSON.stringify(timesheet)); } catch (_) {} }
          for (const ws of wss.clients) ws.close();
          wss.close();
          server.close(() => r());
        }),
      });
    });
  });
}

module.exports = { createChatServer, dmChannel, dmMembers, sanitizeName, hashPin };
