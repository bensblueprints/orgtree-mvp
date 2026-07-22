/**
 * Orgtree — local JSON store. Pure Node (no Electron imports) so it is
 * testable and reusable. The Electron main process passes in the userData path
 * (default store) or an explicit file path (File > Open / Save As).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const availability = require('./availability');

const SCHEMA_VERSION = 2;

function defaultSettings() {
  return {
    collapsed: [],        // ids of collapsed nodes in the tree view
    showDeptPill: true,   // department pill on cards
    showHeadcount: true,  // descendant-count chip on cards
    showCost: false,      // branch salary rollup chip on cards
    condRules: [],        // [{field, op, value, color}]
    activeScenarioId: null,
    companyName: '',      // set by the getting-started wizard
    onboarded: false,     // wizard completed or skipped
  };
}

function defaultData() {
  return {
    schema: SCHEMA_VERSION,
    app: 'orgtree',
    people: [],
    settings: defaultSettings(),
    scenarios: [],        // [{id, name, createdAt, people, collapsed}]
  };
}

function dataFile(dir) {
  return path.join(dir, 'orgtree-data.json');
}

function load(dir) {
  return loadFile(dataFile(dir));
}

function loadFile(file) {
  if (!fs.existsSync(file)) return defaultData();
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return normalize(JSON.parse(raw));
  } catch (err) {
    // Corrupt file: keep it aside instead of silently destroying data.
    try { fs.copyFileSync(file, file + '.corrupt-' + Date.now()); } catch (_) {}
    return defaultData();
  }
}

function save(dir, data) {
  fs.mkdirSync(dir, { recursive: true });
  return saveFile(dataFile(dir), data);
}

function saveFile(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file); // atomic-ish swap
  return file;
}

function normalizePerson(p) {
  return {
    id: String(p.id),
    name: String(p.name),
    title: p.title ? String(p.title) : '',
    department: p.department ? String(p.department) : '',
    email: p.email ? String(p.email) : '',
    phone: p.phone ? String(p.phone) : '',
    location: p.location ? String(p.location) : '',
    startDate: p.startDate ? String(p.startDate) : '',
    salary: (p.salary === 0 || p.salary) && !isNaN(Number(p.salary)) ? Number(p.salary) : null,
    notes: p.notes ? String(p.notes) : '',
    custom: p.custom && typeof p.custom === 'object' && !Array.isArray(p.custom)
      ? Object.fromEntries(Object.entries(p.custom).map(([k, v]) => [String(k), String(v)]))
      : {},
    isOpenRole: !!p.isOpenRole,
    managerId: p.managerId ? String(p.managerId) : null,
    dottedManagerId: p.dottedManagerId ? String(p.dottedManagerId) : null,
    photo: p.photo ? String(p.photo) : '',
    timezone: p.timezone ? String(p.timezone) : '',
    workHours: p.workHours ? String(p.workHours) : '',
    timeFormat: p.timeFormat === '24h' ? '24h' : '12h',
    schedule: availability.normalizeSchedule(p.schedule),
    pinHash: p.pinHash ? String(p.pinHash) : '',
  };
}

function normalizePeople(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.filter(p => p && p.id && (p.name || p.isOpenRole)).map(normalizePerson);
}

function normalizeSettings(obj) {
  const s = defaultSettings();
  if (!obj || typeof obj !== 'object') return s;
  s.collapsed = Array.isArray(obj.collapsed) ? obj.collapsed.map(String) : [];
  if (typeof obj.showDeptPill === 'boolean') s.showDeptPill = obj.showDeptPill;
  if (typeof obj.showHeadcount === 'boolean') s.showHeadcount = obj.showHeadcount;
  if (typeof obj.showCost === 'boolean') s.showCost = obj.showCost;
  if (Array.isArray(obj.condRules)) {
    s.condRules = obj.condRules
      .filter(r => r && r.field && r.op)
      .map(r => ({
        field: String(r.field), op: String(r.op),
        value: r.value == null ? '' : String(r.value),
        color: r.color ? String(r.color) : '#0b66ff',
      }));
  }
  if (obj.activeScenarioId) s.activeScenarioId = String(obj.activeScenarioId);
  if (obj.companyName) s.companyName = String(obj.companyName).slice(0, 120);
  if (typeof obj.onboarded === 'boolean') s.onboarded = obj.onboarded;
  return s;
}

/** Coerce arbitrary parsed JSON (schema 1 or 2) into a valid store shape. Throws if hopeless. */
function normalize(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('Not an Orgtree data object');
  const d = defaultData();
  d.people = normalizePeople(obj.people);
  d.settings = normalizeSettings(obj.settings);
  if (Array.isArray(obj.scenarios)) {
    d.scenarios = obj.scenarios
      .filter(s => s && s.id && s.name)
      .map(s => ({
        id: String(s.id),
        name: String(s.name),
        createdAt: s.createdAt ? String(s.createdAt) : '',
        people: normalizePeople(s.people),
        collapsed: Array.isArray(s.collapsed) ? s.collapsed.map(String) : [],
      }));
  }
  // A persisted active scenario that no longer exists resolves to live.
  if (d.settings.activeScenarioId && !d.scenarios.some(s => s.id === d.settings.activeScenarioId)) {
    d.settings.activeScenarioId = null;
  }
  return d;
}

// ---------- export / import ----------

function exportJSON(data) {
  return JSON.stringify({ ...data, exportedAt: new Date().toISOString() }, null, 2);
}

/** Parse an exported JSON string back into a valid store. Throws on bad input. */
function importJSON(str) {
  const parsed = JSON.parse(str);
  if (parsed.app !== 'orgtree') throw new Error('Not an Orgtree export file');
  return normalize(parsed);
}

module.exports = {
  defaultData, defaultSettings, dataFile,
  load, save, loadFile, saveFile,
  normalize, normalizePerson, normalizePeople,
  exportJSON, importJSON, SCHEMA_VERSION,
};
