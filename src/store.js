/**
 * Orgtree — local JSON store. Pure Node (no Electron imports) so it is
 * testable and reusable. The Electron main process passes in the userData path.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 1;

function defaultData() {
  return {
    schema: SCHEMA_VERSION,
    app: 'orgtree',
    people: [],       // [{id, name, title, department, email, managerId, photo}]
    settings: { collapsed: [] }, // ids of collapsed nodes in the tree view
  };
}

function dataFile(dir) {
  return path.join(dir, 'orgtree-data.json');
}

function load(dir) {
  const file = dataFile(dir);
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
  const file = dataFile(dir);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file); // atomic-ish swap
  return file;
}

/** Coerce arbitrary parsed JSON into a valid store shape. Throws if hopeless. */
function normalize(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('Not an Orgtree data object');
  const d = defaultData();
  if (Array.isArray(obj.people)) {
    d.people = obj.people.filter(p => p && p.id && p.name).map(p => ({
      id: String(p.id),
      name: String(p.name),
      title: p.title ? String(p.title) : '',
      department: p.department ? String(p.department) : '',
      email: p.email ? String(p.email) : '',
      managerId: p.managerId ? String(p.managerId) : null,
      photo: p.photo ? String(p.photo) : '',
    }));
  }
  if (obj.settings && typeof obj.settings === 'object') {
    d.settings = {
      collapsed: Array.isArray(obj.settings.collapsed) ? obj.settings.collapsed.map(String) : [],
    };
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

module.exports = { defaultData, dataFile, load, save, normalize, exportJSON, importJSON, SCHEMA_VERSION };
