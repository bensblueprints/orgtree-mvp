'use strict';

/**
 * Orgtree smoke test — pure Node, no Electron.
 *   1. Tree engine unit tests (buildTree, detectCycles, depthOf, filterByDepartment, findPath).
 *   2. CSV round-trip (parse + serialize, embedded commas/quotes, unresolved managers).
 *   3. Store round-trip (save -> load fidelity, atomic write, corrupt-file recovery).
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const T = require('../src/tree');
const CSV = require('../src/csv');
const store = require('../src/store');

let passed = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  passed++;
  console.log('  ✔ ' + msg);
}
function eq(actual, expected, msg) {
  assert.deepStrictEqual(actual, expected, `${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  passed++;
  console.log('  ✔ ' + msg);
}

function p(id, name, title, department, managerId, email) {
  return { id, name, title, department, managerId: managerId || null, email: email || `${id}@co.test` };
}

console.log('\n— Fixture: healthy 12-person, 4-level roster —');
// Level 0: CEO
// Level 1: VP Eng, VP Sales
// Level 2: Eng Mgr A, Eng Mgr B (under VP Eng), Sales Mgr (under VP Sales)
// Level 3: 4 engineers (2 under each Eng Mgr), 2 sales reps (under Sales Mgr), 1 recruiter (under CEO directly)
const roster = [
  p('ceo', 'Ada Ceo', 'CEO', 'Executive', null),
  p('vpe', 'Vic Eng', 'VP Engineering', 'Engineering', 'ceo'),
  p('vps', 'Sam Sales', 'VP Sales', 'Sales', 'ceo'),
  p('recruiter', 'Rita Recruiter', 'Head of Recruiting', 'People', 'ceo'),
  p('emA', 'Eve MgrA', 'Engineering Manager', 'Engineering', 'vpe'),
  p('emB', 'Ellis MgrB', 'Engineering Manager', 'Engineering', 'vpe'),
  p('sm', 'Sid SalesMgr', 'Sales Manager', 'Sales', 'vps'),
  p('e1', 'Alan Eng', 'Software Engineer', 'Engineering', 'emA'),
  p('e2', 'Bea Eng', 'Software Engineer', 'Engineering', 'emA'),
  p('e3', 'Cara Eng', 'Software Engineer', 'Engineering', 'emB'),
  p('e4', 'Dan Eng', 'Software Engineer', 'Engineering', 'emB'),
  p('r1', 'Ray Rep', 'Sales Rep, "West"', 'Sales', 'sm'),
];

console.log('\n— detectCycles: healthy roster has zero problems —');
{
  const problems = T.detectCycles(roster);
  eq(problems, [], 'healthy roster: detectCycles returns no problems');
}

console.log('\n— buildTree: shape and depths —');
{
  const tree = T.buildTree(roster);
  eq(tree.length, 1, 'buildTree: one root (the CEO)');
  const ceo = tree[0];
  eq(ceo.id, 'ceo', 'buildTree: root is the CEO');
  eq(ceo.children.length, 3, 'buildTree: CEO has 3 direct reports (VP Eng, VP Sales, Recruiter)');

  const vpe = ceo.children.find(c => c.id === 'vpe');
  ok(!!vpe, 'buildTree: VP Eng is a child of CEO');
  eq(vpe.children.length, 2, 'buildTree: VP Eng has 2 direct reports (2 eng managers)');

  const emA = vpe.children.find(c => c.id === 'emA');
  eq(emA.children.length, 2, 'buildTree: Eng Mgr A has 2 engineers');
  eq(emA.children.map(c => c.id).sort(), ['e1', 'e2'], 'buildTree: correct engineers under Mgr A');

  eq(T.depthOf(roster, 'ceo'), 0, 'depthOf: CEO is depth 0');
  eq(T.depthOf(roster, 'vpe'), 1, 'depthOf: VP is depth 1');
  eq(T.depthOf(roster, 'emA'), 2, 'depthOf: Eng Manager is depth 2');
  eq(T.depthOf(roster, 'e1'), 3, 'depthOf: individual engineer is depth 3 (4 levels deep)');
  eq(T.depthOf(roster, 'nope'), -1, 'depthOf: unknown id returns -1');
}

console.log('\n— findPath: ancestor chain for search/scroll-to —');
{
  const chain = T.findPath(roster, 'e3');
  eq(chain.map(n => n.id), ['ceo', 'vpe', 'emB', 'e3'], 'findPath: root-first ancestor chain to a deep engineer');
  eq(T.findPath(roster, 'ceo').map(n => n.id), ['ceo'], 'findPath: root person path is just itself');
  eq(T.findPath(roster, 'missing'), [], 'findPath: unknown id returns empty array');
}

console.log('\n— filterByDepartment: pruning + ancestor preservation —');
{
  const tree = T.buildTree(roster);
  const eng = T.filterByDepartment(tree, 'Engineering');
  // CEO (Executive) is kept only because it's an ancestor of matching nodes.
  eq(eng.length, 1, 'filterByDepartment: still one root (CEO kept as ancestor)');
  const ceoF = eng[0];
  const idsUnderCeo = ceoF.children.map(c => c.id).sort();
  eq(idsUnderCeo, ['vpe'], 'filterByDepartment: VP Sales + Recruiter branches pruned entirely (no Engineering below them)');
  const vpeF = ceoF.children[0];
  eq(vpeF.children.map(c => c.id).sort(), ['emA', 'emB'], 'filterByDepartment: both eng managers survive');
  const emAF = vpeF.children.find(c => c.id === 'emA');
  eq(emAF.children.map(c => c.id).sort(), ['e1', 'e2'], 'filterByDepartment: leaf engineers survive under their manager');

  const untouched = T.buildTree(roster);
  T.filterByDepartment(tree, 'Engineering');
  eq(tree[0].children.length, untouched[0].children.length, 'filterByDepartment: does not mutate the input tree');
}

console.log('\n— departmentsOf —');
{
  eq(T.departmentsOf(roster), ['Engineering', 'Executive', 'People', 'Sales'], 'departmentsOf: distinct sorted department list');
}

console.log('\n— detectCycles: broken roster with a manager cycle (must not hang) —');
{
  // A -> B -> C -> A is a cycle. D reports to a manager id that doesn't exist.
  // E is a healthy root, unaffected by the cycle elsewhere in the roster.
  const broken = [
    p('A', 'Alice', 'Lead', 'Ops', 'B'),
    p('B', 'Bob', 'Lead', 'Ops', 'C'),
    p('C', 'Carl', 'Lead', 'Ops', 'A'),   // closes the cycle back to A
    p('D', 'Dana', 'IC', 'Ops', 'ghost'), // missing manager
    p('E', 'Erin', 'Founder', 'Ops', null),
  ];

  const start = Date.now();
  const problems = T.detectCycles(broken);
  const elapsedMs = Date.now() - start;
  ok(elapsedMs < 1000, `detectCycles: terminates fast on a cyclic roster (${elapsedMs}ms)`);

  const byId = Object.fromEntries(problems.map(pr => [pr.id, pr.reason]));
  eq(byId.A, 'cycle', 'detectCycles: A flagged as part of the A-B-C cycle');
  eq(byId.B, 'cycle', 'detectCycles: B flagged as part of the cycle');
  eq(byId.C, 'cycle', 'detectCycles: C flagged as part of the cycle');
  eq(byId.D, 'missing-manager', 'detectCycles: D flagged for a missing manager id');
  ok(!('E' in byId), 'detectCycles: healthy root E is not flagged');

  // buildTree must also never hang on this roster, and must not lose anyone:
  // cyclic/broken people fall back to being roots instead of vanishing.
  const tree2 = T.buildTree(broken);
  const allIds = [];
  const walk = (n) => { allIds.push(n.id); n.children.forEach(walk); };
  tree2.forEach(walk);
  eq(allIds.sort(), ['A', 'B', 'C', 'D', 'E'], 'buildTree: every person appears exactly once even with a cycle present');
}

console.log('\n— CSV: round-trip parse + serialize —');
{
  const csvIn = [
    'name,title,department,email,manager_name',
    '"Ada Ceo",CEO,Executive,ada@co.test,',
    'Vic Eng,VP Engineering,Engineering,vic@co.test,Ada Ceo',
    '"Rep, West",Sales Rep,Sales,rep@co.test,Vic Eng',
    '"Quote ""Nickname"" Guy",Engineer,Engineering,q@co.test,Vic Eng',
  ].join('\r\n') + '\r\n';

  const { people, errors } = CSV.parseRoster(csvIn);
  eq(errors, [], 'CSV import: no errors on a clean file');
  eq(people.length, 4, 'CSV import: 4 people parsed');

  const repRow = people.find(x => x.name === 'Rep, West');
  ok(!!repRow, 'CSV import: name with an embedded comma parsed correctly');
  const vic = people.find(x => x.name === 'Vic Eng');
  eq(repRow.managerId, vic.id, 'CSV import: manager_name "Vic Eng" resolved to Vic\'s generated id');

  const quoteGuy = people.find(x => x.name === 'Quote "Nickname" Guy');
  // (CSV escaping rule: an embedded literal quote is represented as "" inside a quoted field.)
  ok(!!quoteGuy, 'CSV import: name with embedded quotes parsed correctly');
  eq(quoteGuy.managerId, vic.id, 'CSV import: second report under Vic also resolved');

  const ada = people.find(x => x.name === 'Ada Ceo');
  eq(ada.managerId, null, 'CSV import: blank manager_name means no manager (root)');

  // Serialize back out and re-parse; names + manager relationships must survive.
  const csvOut = CSV.serializeRoster(people);
  ok(csvOut.includes('"Rep, West"'), 'CSV export: comma-containing name is quoted');
  const roundTrip = CSV.parseRoster(csvOut);
  eq(roundTrip.errors, [], 'CSV round-trip: re-parsing the export produces no errors');
  eq(roundTrip.people.length, 4, 'CSV round-trip: same person count after export+reimport');
  const repRow2 = roundTrip.people.find(x => x.name === 'Rep, West');
  const vic2 = roundTrip.people.find(x => x.name === 'Vic Eng');
  eq(repRow2.managerId, vic2.id, 'CSV round-trip: manager relationship preserved by name after export+reimport');
}

console.log('\n— CSV: unresolved manager reported as an error, not silently dropped —');
{
  const csvIn = 'name,title,department,email,manager_name\nNew Hire,IC,Ops,nh@co.test,Nonexistent Boss\n';
  const { people, errors } = CSV.parseRoster(csvIn);
  eq(people.length, 1, 'CSV import: person still imported despite bad manager ref');
  eq(people[0].managerId, null, 'CSV import: managerId left null when manager is unresolved');
  eq(errors.length, 1, 'CSV import: exactly one error reported');
  ok(errors[0].reason.includes('not found'), 'CSV import: error explains the manager was not found');
}

console.log('\n— CSV: ambiguous manager name flagged —');
{
  const csvIn = [
    'name,title,department,email,manager_name',
    'John Smith,Manager,Ops,js1@co.test,',
    'John Smith,Manager,Ops,js2@co.test,',
    'Report,IC,Ops,r@co.test,John Smith',
  ].join('\n');
  const { errors } = CSV.parseRoster(csvIn);
  ok(errors.some(e => e.reason.includes('ambiguous')), 'CSV import: duplicate manager name flagged as ambiguous');
}

console.log('\n— Store: round-trip —');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-test-'));
  const data = store.defaultData();
  data.people.push({
    id: 'abc', name: 'Water Cooler', title: 'VP, "Fun"', department: 'Culture',
    email: 'wc@co.test', managerId: null, photo: 'C:\\photos\\wc.png',
  });
  data.people.push({
    id: 'def', name: 'Report Person', title: 'IC', department: 'Culture',
    email: 'rp@co.test', managerId: 'abc', photo: '',
  });
  data.settings.collapsed = ['abc'];

  const file = store.save(dir, data);
  ok(fs.existsSync(file), 'store: save writes the data file');
  const loaded = store.load(dir);
  eq(loaded.people, store.normalizePeople(data.people), 'store: people survive round-trip (normalized shape)');
  eq(loaded.settings.collapsed, data.settings.collapsed, 'store: settings (collapsed nodes) survive round-trip');

  // corrupt file -> safe default + .corrupt backup
  fs.writeFileSync(store.dataFile(dir), '{not json', 'utf8');
  const recovered = store.load(dir);
  eq(recovered.people.length, 0, 'store: corrupt file recovers to safe defaults');
  ok(fs.readdirSync(dir).some(f => f.includes('.corrupt-')), 'store: corrupt file preserved as backup');

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n— Store: JSON export / import fidelity —');
{
  const data = store.defaultData();
  data.people.push({
    id: 'x1', name: 'Export Test', title: 'Engineer', department: 'Engineering',
    email: 'et@co.test', managerId: null, photo: '',
  });
  const json = store.exportJSON(data);
  const back = store.importJSON(json);
  eq(back.people, store.normalizePeople(data.people), 'export->import: people identical (normalized shape)');

  let threw = false;
  try { store.importJSON('{"app":"something-else"}'); } catch (_) { threw = true; }
  ok(threw, 'import: rejects non-Orgtree JSON');
}

console.log('\n— descendantStats: headcount + cost rollups —');
{
  const withPay = roster.map(x => ({ ...x, salary: 100 }));
  const stats = T.descendantStats(withPay);
  eq(stats.get('ceo').reports, 11, 'descendantStats: CEO has 11 descendants');
  eq(stats.get('emA').reports, 2, 'descendantStats: Eng Mgr A has 2 descendants');
  eq(stats.get('e1').reports, 0, 'descendantStats: leaf has 0 descendants');
  eq(stats.get('ceo').cost, 1200, 'descendantStats: CEO branch cost = whole company');
  eq(stats.get('emA').cost, 300, 'descendantStats: Mgr A branch cost = self + 2 reports');

  const noPay = T.descendantStats(roster);
  eq(noPay.get('ceo').cost, 0, 'descendantStats: missing salaries contribute 0 cost');
}

console.log('\n— CSV: schema-2 columns (open roles, dotted lines, salary) round-trip —');
{
  const csvIn = [
    'name,title,department,email,location,salary,is_open_role,manager_name,dotted_manager_name',
    'Boss One,CEO,Exec,b@co.test,Austin,"250,000",,,',
    'Dot Ted,Engineer,Eng,d@co.test,Remote,120000,,Boss One,Helper Two',
    'Helper Two,Support,Eng,h@co.test,,90000,,Boss One,',
    ',Senior Engineer,Eng,,,140000,yes,Boss One,',
  ].join('\r\n') + '\r\n';

  const { people, errors } = CSV.parseRoster(csvIn);
  eq(errors, [], 'CSV v2: clean file parses without errors');
  eq(people.length, 4, 'CSV v2: 4 rows parsed (incl. nameless open role)');

  const open = people.find(x => x.isOpenRole);
  ok(!!open, 'CSV v2: is_open_role=yes parsed as an open role');
  eq(open.name, 'Open role', 'CSV v2: nameless open role gets a default name');
  eq(open.salary, 140000, 'CSV v2: open role salary parsed');

  const boss = people.find(x => x.name === 'Boss One');
  eq(boss.salary, 250000, 'CSV v2: salary with $ commas parsed as a number');

  const dot = people.find(x => x.name === 'Dot Ted');
  const helper = people.find(x => x.name === 'Helper Two');
  eq(dot.dottedManagerId, helper.id, 'CSV v2: dotted_manager_name resolved within import');
  eq(dot.location, 'Remote', 'CSV v2: location column parsed');

  const out = CSV.serializeRoster(people);
  const rt = CSV.parseRoster(out);
  eq(rt.errors, [], 'CSV v2 round-trip: re-parse produces no errors');
  const rtDot = rt.people.find(x => x.name === 'Dot Ted');
  const rtHelper = rt.people.find(x => x.name === 'Helper Two');
  eq(rtDot.dottedManagerId, rtHelper.id, 'CSV v2 round-trip: dotted line survives export+reimport');
  const rtOpen = rt.people.find(x => x.isOpenRole);
  ok(!!rtOpen, 'CSV v2 round-trip: open role flag survives export+reimport');
}

console.log('\n— Store: schema-2 normalize (new fields + scenarios) —');
{
  const raw = {
    app: 'orgtree',
    people: [{ id: 'a', name: 'A Person', salary: '95000', isOpenRole: 0, custom: { Slack: '@a' } }],
    settings: { collapsed: [], showCost: true, condRules: [{ field: 'title', op: 'contains', value: 'Mgr', color: '#ff0000' }, { bad: true }] },
    scenarios: [{ id: 's1', name: 'Q3 reorg', people: [{ id: 'a', name: 'A Person' }], collapsed: ['a'] }],
  };
  const n = store.normalize(raw);
  eq(n.people[0].salary, 95000, 'normalize: string salary coerced to number');
  eq(n.people[0].isOpenRole, false, 'normalize: falsy isOpenRole coerced to boolean');
  eq(n.people[0].custom, { Slack: '@a' }, 'normalize: custom fields preserved');
  eq(n.settings.showCost, true, 'normalize: view toggles preserved');
  eq(n.settings.condRules.length, 1, 'normalize: malformed conditional rules dropped');
  eq(n.scenarios.length, 1, 'normalize: scenarios preserved');
  eq(n.scenarios[0].collapsed, ['a'], 'normalize: scenario collapsed set preserved');

  // schema-1 file (no new keys) still loads clean
  const old = store.normalize({ app: 'orgtree', people: [{ id: 'x', name: 'Old Timer', managerId: null }], settings: { collapsed: [] } });
  eq(old.people[0].dottedManagerId, null, 'normalize: schema-1 person gains dottedManagerId default');
  eq(old.scenarios, [], 'normalize: schema-1 file gains empty scenarios');
}

console.log('\n— invite email builder —');
{
  const inviteMod = require('../src/invite');
  const mail = inviteMod.buildInvite({
    name: 'Jordan Rivera', company: 'Acme Mfg', department: 'Engineering',
    inviterName: 'Ben', joinAddr: '192.168.1.24:4600',
  });
  ok(mail.subject.includes('Acme Mfg') && mail.subject.includes('Engineering'), 'invite subject names company and department');
  ok(mail.text.includes('192.168.1.24:4600'), 'invite text includes the chat join address');
  ok(mail.html.includes('My profile'), 'invite html points to the profile self-fill step');
  const noAddr = inviteMod.buildInvite({ name: 'X', company: 'Acme' });
  ok(noAddr.text.includes('ask your admin'), 'invite without a join address tells them to ask the admin');
  const xss = inviteMod.buildInvite({ name: '<script>x</script>', company: 'A&B' });
  ok(!xss.html.includes('<script>'), 'invite html escapes user-supplied values');
}

console.log('\n— store: company name + timezone/pin fields —');
{
  const n = store.normalize({
    app: 'orgtree',
    people: [{ id: 'a', name: 'A', timezone: 'America/Chicago', workHours: '9-5', pinHash: 'abc123' }],
    settings: { collapsed: [], companyName: 'Acme Mfg', onboarded: true },
  });
  eq(n.settings.companyName, 'Acme Mfg', 'normalize: company name preserved');
  eq(n.settings.onboarded, true, 'normalize: onboarded flag preserved');
  eq(n.people[0].timezone, 'America/Chicago', 'normalize: timezone preserved');
  eq(n.people[0].workHours, '9-5', 'normalize: working hours preserved');
  eq(n.people[0].pinHash, 'abc123', 'normalize: pin hash preserved');
}

console.log(`\nAll good — ${passed} assertions passed.\n`);
