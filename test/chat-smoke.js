'use strict';

/**
 * Orgtree chat server smoke test — pure Node, real websockets on localhost.
 * Covers: roster handoff, identity claim + conflict, org broadcast, DM privacy,
 * history replay, presence, and persistence.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { createChatServer, dmChannel, hashPin } = require('../src/chat-server');

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; console.log('  ✔ ' + msg); }
function eq(a, b, msg) { assert.deepStrictEqual(a, b, msg); passed++; console.log('  ✔ ' + msg); }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function client(port) {
  const ws = new WebSocket('ws://127.0.0.1:' + port);
  const inbox = [];
  ws.on('message', (raw) => inbox.push(JSON.parse(raw)));
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve({ ws, inbox, send: (o) => ws.send(JSON.stringify(o)) }));
    ws.on('error', reject);
  });
}

const roster = [
  { id: 'ada', name: 'Ada Boss', title: 'CEO', department: 'Exec', salary: 250000 },
  { id: 'vic', name: 'Vic Eng', title: 'VP Eng', department: 'Engineering', salary: 180000, pinHash: hashPin('4821') },
  { id: 'sam', name: 'Sam Sales', title: 'VP Sales', department: 'Sales', salary: 175000 },
  { id: 'openx', name: 'Open role', title: 'Engineer', department: 'Engineering', isOpenRole: true },
];

(async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-chat-test-'));
  const storeFile = path.join(dir, 'history.json');
  const PORT = 4977;

  console.log('\n— chat server: boot + roster handoff —');
  const server = await createChatServer({ port: PORT, roster, storeFile });
  eq(server.port, PORT, 'server listens on the requested port');

  const a = await client(PORT);
  await sleep(150);
  const rosterMsg = a.inbox.find(m => m.type === 'roster');
  ok(!!rosterMsg, 'new connection immediately receives the roster');
  eq(rosterMsg.roster.length, 3, 'open roles are excluded from the chat roster');
  eq(rosterMsg.channels.map(c => c.id).sort(), ['dept:Engineering', 'dept:Exec', 'dept:Sales', 'org'].sort(), 'channels = org + one per department');

  console.log('\n— identity claim + conflict —');
  a.send({ type: 'hello', personId: 'ada' });
  await sleep(150);
  ok(a.inbox.some(m => m.type === 'welcome' && m.you.id === 'ada'), 'Ada claims her identity and is welcomed');

  const b = await client(PORT);
  await sleep(100);
  b.send({ type: 'hello', personId: 'ada' });
  await sleep(150);
  ok(b.inbox.some(m => m.type === 'error' && m.error === 'identity-taken'), 'second claim on the same person is rejected');
  b.send({ type: 'hello', personId: 'vic' });
  await sleep(150);
  ok(b.inbox.some(m => m.type === 'welcome' && m.you.id === 'vic'), 'Vic claims a free identity');
  ok(a.inbox.some(m => m.type === 'presence' && m.online.includes('vic')), 'Ada sees Vic come online (presence broadcast)');

  console.log('\n— org channel broadcast —');
  a.send({ type: 'msg', channel: 'org', text: 'Hello company' });
  await sleep(150);
  ok(b.inbox.some(m => m.type === 'msg' && m.channel === 'org' && m.text === 'Hello company' && m.fromName === 'Ada Boss'), 'org message reaches other members with sender name');
  ok(a.inbox.some(m => m.type === 'msg' && m.channel === 'org' && m.text === 'Hello company'), 'sender receives their own message back (single source of truth)');

  console.log('\n— DM privacy —');
  const c = await client(PORT);
  await sleep(100);
  c.send({ type: 'hello', personId: 'sam' });
  await sleep(150);
  const dm = dmChannel('ada', 'vic');
  a.send({ type: 'msg', channel: dm, text: 'secret to vic' });
  await sleep(200);
  ok(b.inbox.some(m => m.type === 'msg' && m.channel === dm && m.text === 'secret to vic'), 'DM delivered to the other participant');
  ok(!c.inbox.some(m => m.type === 'msg' && m.channel === dm), 'DM NOT delivered to a third person');
  c.send({ type: 'msg', channel: dm, text: 'sneaky' });
  c.send({ type: 'history', channel: dm });
  await sleep(200);
  ok(!a.inbox.some(m => m.type === 'msg' && m.text === 'sneaky'), 'outsider cannot post into a DM channel');
  const cHist = c.inbox.find(m => m.type === 'history' && m.channel === dm);
  eq(cHist.messages, [], 'outsider requesting DM history gets nothing');

  console.log('\n— history replay —');
  b.send({ type: 'history', channel: 'org' });
  await sleep(150);
  const hist = b.inbox.filter(m => m.type === 'history' && m.channel === 'org').pop();
  eq(hist.messages.length, 1, 'org history contains the broadcast message');
  eq(hist.messages[0].text, 'Hello company', 'history preserves message text');

  console.log('\n— presence on disconnect + persistence —');
  c.ws.close();
  await sleep(200);
  ok(a.inbox.some(m => m.type === 'presence' && !m.online.includes('sam')), 'others see Sam go offline');

  await server.stop();
  ok(fs.existsSync(storeFile), 'history persisted to disk on shutdown');
  const persisted = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  eq(persisted.org.length, 1, 'persisted history holds the org message');
  ok(!!persisted[dm], 'persisted history holds the DM channel');

  console.log('\n— message search + shared-files bucket —');
  {
    const s7 = await createChatServer({ port: PORT, roster, storeFile });
    const w = await client(PORT); await sleep(80);
    w.send({ type: 'hello', personId: 'ada' }); await sleep(80);
    w.send({ type: 'msg', channel: 'org', text: 'The quarterly budget review is on Friday' });
    w.send({ type: 'msg', channel: 'dept:Engineering', text: 'budget for new laptops approved' });
    await sleep(200);
    w.send({ type: 'search', q: 'budget' });
    await sleep(150);
    const sr = w.inbox.find(m => m.type === 'searchResults');
    eq(sr.results.length, 2, 'search finds matches across channels');
    ok(sr.results.every(r => r.text.toLowerCase().includes('budget')), 'search results actually match the query');
    w.send({ type: 'file', channel: 'dept:Engineering', name: 'roadmap.xlsx', data: Buffer.from('cells').toString('base64') });
    await sleep(200);
    w.send({ type: 'library', channel: '*' });
    await sleep(150);
    const bucket = w.inbox.filter(m => m.type === 'library' && m.channel === '*').pop();
    ok(bucket.entries.some(e => e.kind === 'file' && e.name === 'roadmap.xlsx'), 'shared-files bucket aggregates across channels');
    ok(bucket.entries.every(e => !String(e.channel).startsWith('dm:')), 'bucket never includes DM files');
    await s7.stop();
  }

  console.log('\n— deleted members leave timesheets + get disconnected —');
  {
    const s8 = await createChatServer({ port: PORT, roster });
    const admin = await client(PORT); await sleep(80);
    admin.send({ type: 'hello', personId: 'ada' }); await sleep(80);
    const emp = await client(PORT); await sleep(80);
    emp.send({ type: 'hello', personId: 'vic' }); await sleep(120);

    admin.send({ type: 'timesheet' }); await sleep(120);
    const before = admin.inbox.filter(m => m.type === 'timesheet').pop();
    ok(before.entries.some(e => e.personId === 'vic'), 'before deletion: Vic appears in admin timesheets');

    let empClosed = false;
    emp.ws.on('close', () => { empClosed = true; });
    s8.updateRoster(roster.filter(p => p.id !== 'vic')); // admin deleted Vic on the chart
    await sleep(250);

    const pushed = admin.inbox.filter(m => m.type === 'timesheet').pop();
    ok(!pushed.entries.some(e => e.personId === 'vic'), 'after deletion: Vic is gone from the pushed admin timesheets');
    ok(empClosed, 'after deletion: Vic\'s connection is closed by the server');

    const ghost = await client(PORT); await sleep(80);
    ghost.send({ type: 'hello', personId: 'vic' }); await sleep(120);
    ok(ghost.inbox.some(m => m.type === 'error' && m.error === 'unknown-person'), 'deleted member cannot reconnect');

    await s8.stop();
  }

  console.log('\n— restart: history survives —');
  const server2 = await createChatServer({ port: PORT, roster, storeFile });
  const d = await client(PORT);
  await sleep(100);
  d.send({ type: 'hello', personId: 'ada' });
  await sleep(100);
  d.send({ type: 'history', channel: 'org' });
  await sleep(150);
  const hist2 = d.inbox.filter(m => m.type === 'history' && m.channel === 'org').pop();
  ok(hist2.messages.some(x => x.text === 'Hello company'), 'history survives a server restart');
  await server2.stop();

  console.log('\n— salary privacy: pay data never crosses the wire —');
  {
    const s3 = await createChatServer({ port: PORT, roster, storeFile });
    const w = await client(PORT);
    await sleep(120);
    const r = w.inbox.find(m => m.type === 'roster');
    ok(r.roster.every(p => !('salary' in p) && !('pinHash' in p)), 'roster message contains no salary or pinHash for any person');
    w.send({ type: 'hello', personId: 'ada' });
    await sleep(120);
    const welcome = w.inbox.find(m => m.type === 'welcome');
    ok(!('salary' in welcome.you) && !('pinHash' in welcome.you), 'welcome payload also carries no salary or pinHash');
    await s3.stop();
  }

  console.log('\n— disappearing messages: retention prunes history + library —');
  {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-chat-ret-'));
    const sf = path.join(dir2, 'history.json');
    const fdir = path.join(dir2, 'files');
    const OLD = Date.now() - 10 * 86400000;
    fs.writeFileSync(sf, JSON.stringify({
      org: [
        { channel: 'org', from: 'ada', fromName: 'Ada Boss', text: 'ancient news', ts: OLD },
        { channel: 'org', from: 'ada', fromName: 'Ada Boss', text: 'fresh news', ts: Date.now() },
      ],
    }));
    fs.mkdirSync(fdir, { recursive: true });
    fs.writeFileSync(path.join(fdir, 'f-old'), 'oldfile');
    fs.writeFileSync(path.join(fdir, 'library.json'), JSON.stringify([
      { id: 'f-old', kind: 'file', channel: 'org', name: 'old.txt', size: 7, from: 'ada', fromName: 'Ada Boss', ts: OLD },
    ]));

    const s4 = await createChatServer({ port: PORT, roster, storeFile: sf, filesDir: fdir, retentionDays: 7 });
    const w = await client(PORT);
    await sleep(120);
    eq(w.inbox.find(m => m.type === 'roster').retentionDays, 7, 'clients are told the retention window');
    w.send({ type: 'hello', personId: 'ada' });
    await sleep(120);
    w.send({ type: 'history', channel: 'org' });
    w.send({ type: 'library', channel: 'org' });
    await sleep(200);
    const h = w.inbox.filter(m => m.type === 'history').pop();
    eq(h.messages.map(x => x.text), ['fresh news'], 'messages older than the window are gone from history');
    const lib = w.inbox.filter(m => m.type === 'library').pop();
    eq(lib.entries.length, 1, 'library entries SURVIVE retention — files never disappear');
    ok(fs.existsSync(path.join(fdir, 'f-old')), 'file bytes stay on disk even past the chat window');
    await s4.stop();
    fs.rmSync(dir2, { recursive: true, force: true });
  }

  console.log('\n— files + links: share, library, sync fetch, DM privacy —');
  {
    const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-chat-lib-'));
    const s5 = await createChatServer({ port: PORT, roster, filesDir: path.join(dir3, 'files') });
    const w1 = await client(PORT); await sleep(80);
    w1.send({ type: 'hello', personId: 'ada' }); await sleep(80);
    const w2 = await client(PORT); await sleep(80);
    w2.send({ type: 'hello', personId: 'vic' }); await sleep(80);

    const payload = Buffer.from('quarterly plan contents').toString('base64');
    w1.send({ type: 'file', channel: 'dept:Engineering', name: 'plan.pdf', data: payload });
    await sleep(200);
    const fmsg = w2.inbox.find(m => m.type === 'msg' && m.kind === 'file');
    ok(!!fmsg && fmsg.fileName === 'plan.pdf', 'file share arrives as a file message');
    w2.send({ type: 'library', channel: 'dept:Engineering' });
    await sleep(150);
    const lib = w2.inbox.filter(m => m.type === 'library').pop();
    eq(lib.entries.filter(e => e.kind === 'file').length, 1, 'file lands in the department library');
    w2.send({ type: 'fileGet', id: fmsg.fileId, reason: 'sync' });
    await sleep(150);
    const fdata = w2.inbox.find(m => m.type === 'fileData');
    eq(Buffer.from(fdata.data, 'base64').toString(), 'quarterly plan contents', 'file bytes round-trip through fileGet');

    w1.send({ type: 'msg', channel: 'org', text: 'Docs live here: https://wiki.internal/handbook now' });
    await sleep(200);
    w1.send({ type: 'library', channel: 'org' });
    await sleep(150);
    const orgLib = w1.inbox.filter(m => m.type === 'library').pop();
    ok(orgLib.entries.some(e => e.kind === 'link' && e.url === 'https://wiki.internal/handbook'), 'links in messages are auto-captured into the library');

    // DM file privacy: sam must not be able to fetch a dm file between ada+vic
    const dm = dmChannel('ada', 'vic');
    w1.send({ type: 'file', channel: dm, name: 'secret.txt', data: Buffer.from('sssh').toString('base64') });
    await sleep(200);
    const dmMsg = w1.inbox.filter(m => m.type === 'msg' && m.kind === 'file').pop();
    const w3 = await client(PORT); await sleep(80);
    w3.send({ type: 'hello', personId: 'sam' }); await sleep(80);
    w3.send({ type: 'fileGet', id: dmMsg.fileId });
    w3.send({ type: 'library', channel: dm });
    await sleep(200);
    ok(!w3.inbox.some(m => m.type === 'fileData'), 'outsider cannot fetch a DM file');
    eq(w3.inbox.filter(m => m.type === 'library').pop().entries, [], 'outsider sees an empty DM library');

    await s5.stop();
    fs.rmSync(dir3, { recursive: true, force: true });
  }

  console.log('\n— profile, PIN clock-in, activity, timesheets —');
  {
    let profileUpdates = [];
    const s6 = await createChatServer({
      port: PORT, roster,
      onProfileUpdate: (pid, fields) => profileUpdates.push({ pid, fields }),
    });
    const w = await client(PORT); await sleep(80);
    w.send({ type: 'hello', personId: 'ada' }); await sleep(80);

    w.send({ type: 'profile', fields: { phone: '555-0101', timezone: 'America/Chicago', title: 'HACKED CEO', salary: '1' }, pin: '9944' });
    await sleep(150);
    const up = profileUpdates[0];
    eq(up.pid, 'ada', 'profile update reaches the host callback');
    eq(up.fields.phone, '555-0101', 'allowed contact field passes through');
    ok(!('title' in up.fields), 'role/title cannot be self-edited (admin-only)');
    ok(!('salary' in up.fields), 'salary cannot be self-edited');
    ok(up.fields.pinHash === hashPin('9944'), 'PIN is stored as a hash, never plaintext');
    const rUpd = w.inbox.find(m => m.type === 'rosterUpdate');
    ok(rUpd && !('pinHash' in rUpd.fields), 'pin hash is not broadcast to other clients');

    w.send({ type: 'clockIn', pin: '1111' });
    await sleep(120);
    ok(w.inbox.some(m => m.type === 'error' && m.error === 'bad-pin'), 'wrong PIN is rejected');
    w.send({ type: 'clockIn', pin: '9944' });
    await sleep(120);
    ok(w.inbox.some(m => m.type === 'clock' && m.status === 'in'), 'correct PIN clocks in');
    w.send({ type: 'activity', activeSec: 90, sampleSec: 120 });
    await sleep(120);
    w.send({ type: 'clockOut' });
    await sleep(120);
    const out = w.inbox.filter(m => m.type === 'clock').pop();
    eq(out.status, 'out', 'clock out closes the session');
    eq(out.summary.activePct, 75, 'activity ratio computed from idle samples (90/120 = 75%)');
    ok(out.summary.weekSec >= 0 && out.summary.clockedIn === false, 'summary reports week totals and clocked-out state');

    // admin (loopback) sees everyone; a second identity asking for ada's sheet is the non-admin path we can't
    // simulate over loopback, so assert the self path instead
    w.send({ type: 'timesheet' });
    await sleep(120);
    const ts = w.inbox.filter(m => m.type === 'timesheet').pop();
    ok(ts.entries.length >= 1, 'timesheet query answers');

    await s6.stop();
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\nChat server all good — ${passed} assertions passed.\n`);
  process.exit(0);
})().catch((err) => {
  console.error('\nCHAT TEST FAILED:', err.message);
  process.exit(1);
});
