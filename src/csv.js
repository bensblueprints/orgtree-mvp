/**
 * Orgtree — CSV import/export for the roster.
 * No Electron, no I/O. Pure string in / plain data out.
 *
 * Import columns: name, title, department, email, manager_name (or manager_id)
 * Export columns: name, title, department, email, manager_name
 */

'use strict';

// ---------- low-level RFC4180-ish CSV parsing ----------

/** Parse a CSV string into an array of rows, each an array of string cells.
 *  Handles quoted fields, embedded commas, embedded quotes ("" escape),
 *  and embedded newlines inside quoted fields. Accepts \r\n, \n, or \r line endings. */
function parseCSVRows(str) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const len = str.length;

  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };

  while (i < len) {
    const c = str[i];

    if (inQuotes) {
      if (c === '"') {
        if (str[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }

    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { pushField(); i++; continue; }
    if (c === '\r') {
      if (str[i + 1] === '\n') i++;
      pushRow(); i++; continue;
    }
    if (c === '\n') { pushRow(); i++; continue; }
    field += c; i++;
  }
  // Trailing field/row (file may or may not end with a newline).
  if (field.length > 0 || row.length > 0) pushRow();

  // Drop wholly-empty trailing rows (e.g. from a trailing blank line).
  return rows.filter(r => !(r.length === 1 && r[0] === ''));
}

function csvEscape(v) {
  const s = String(v == null ? '' : v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function serializeCSVRows(rows) {
  return rows.map(r => r.map(csvEscape).join(',')).join('\r\n') + '\r\n';
}

// ---------- roster import ----------

let importCounter = 0;
function nextImportId() {
  importCounter += 1;
  return 'imp-' + Date.now().toString(36) + '-' + importCounter;
}

const HEADER_ALIASES = {
  name: 'name',
  title: 'title',
  department: 'department',
  dept: 'department',
  email: 'email',
  phone: 'phone',
  location: 'location',
  start_date: 'start_date',
  startdate: 'start_date',
  salary: 'salary',
  notes: 'notes',
  is_open_role: 'is_open_role',
  isopenrole: 'is_open_role',
  open_role: 'is_open_role',
  manager_name: 'manager_name',
  managername: 'manager_name',
  manager: 'manager_name',
  manager_id: 'manager_id',
  managerid: 'manager_id',
  dotted_manager_name: 'dotted_manager_name',
  dottedmanagername: 'dotted_manager_name',
  dotted_manager: 'dotted_manager_name',
};

function parseBool(v) {
  return /^(1|y|yes|true|x)$/i.test(String(v || '').trim());
}

/**
 * Parse a roster CSV string.
 * Returns { people: [{id, name, title, department, email, managerId}], errors: [{row, name, reason}] }
 * - manager_name is resolved to a manager_id by exact, case-insensitive name match
 *   WITHIN this import. Duplicate names are ambiguous -> reported as an error.
 * - An unresolved manager reference is reported as an error but the person is
 *   still imported (with managerId null) rather than silently dropped.
 */
function parseRoster(str) {
  const rows = parseCSVRows(String(str || ''));
  const errors = [];
  if (rows.length === 0) return { people: [], errors };

  const header = rows[0].map(h => HEADER_ALIASES[h.trim().toLowerCase()] || h.trim().toLowerCase());
  const col = (key) => header.indexOf(key);
  const iName = col('name');
  const iTitle = col('title');
  const iDept = col('department');
  const iEmail = col('email');
  const iPhone = col('phone');
  const iLocation = col('location');
  const iStart = col('start_date');
  const iSalary = col('salary');
  const iNotes = col('notes');
  const iOpen = col('is_open_role');
  const iMgrName = col('manager_name');
  const iMgrId = col('manager_id');
  const iDotName = col('dotted_manager_name');

  if (iName === -1) {
    errors.push({ row: 1, name: '', reason: 'missing required "name" column' });
    return { people: [], errors };
  }

  const people = [];
  const cell = (r, idx) => (idx === -1 ? '' : (r[idx] || '').trim());

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const name = cell(row, iName);
    const isOpenRole = iOpen !== -1 && parseBool(cell(row, iOpen));
    if (!name && !isOpenRole) continue; // skip blank rows

    const salaryRaw = cell(row, iSalary).replace(/[$,\s]/g, '');
    people.push({
      id: nextImportId(),
      name: name || 'Open role',
      title: cell(row, iTitle),
      department: cell(row, iDept),
      email: cell(row, iEmail),
      phone: cell(row, iPhone),
      location: cell(row, iLocation),
      startDate: cell(row, iStart),
      salary: salaryRaw !== '' && !isNaN(Number(salaryRaw)) ? Number(salaryRaw) : null,
      notes: cell(row, iNotes),
      custom: {},
      isOpenRole,
      managerId: null,
      dottedManagerId: null,
      _rowNum: r + 1,
      _managerName: iMgrName !== -1 ? cell(row, iMgrName) : '',
      _managerIdRaw: iMgrId !== -1 ? cell(row, iMgrId) : '',
      _dottedName: iDotName !== -1 ? cell(row, iDotName) : '',
    });
  }

  // Build a case-insensitive name -> id index, flagging duplicates as ambiguous.
  const byNameLower = new Map();
  const ambiguous = new Set();
  for (const p of people) {
    const key = p.name.toLowerCase();
    if (byNameLower.has(key)) ambiguous.add(key);
    else byNameLower.set(key, p.id);
  }

  for (const p of people) {
    if (p._managerIdRaw) {
      p.managerId = p._managerIdRaw; // caller may be re-importing with real ids
    } else if (p._managerName) {
      const key = p._managerName.toLowerCase();
      if (ambiguous.has(key)) {
        errors.push({ row: p._rowNum, name: p.name, reason: `manager name "${p._managerName}" is ambiguous (matches multiple people)` });
      } else if (byNameLower.has(key)) {
        p.managerId = byNameLower.get(key);
      } else {
        errors.push({ row: p._rowNum, name: p.name, reason: `manager "${p._managerName}" not found in roster` });
      }
    }
    if (p._dottedName) {
      const key = p._dottedName.toLowerCase();
      if (ambiguous.has(key)) {
        errors.push({ row: p._rowNum, name: p.name, reason: `dotted-line manager "${p._dottedName}" is ambiguous (matches multiple people)` });
      } else if (byNameLower.has(key)) {
        p.dottedManagerId = byNameLower.get(key);
      } else {
        errors.push({ row: p._rowNum, name: p.name, reason: `dotted-line manager "${p._dottedName}" not found in roster` });
      }
    }
    delete p._rowNum;
    delete p._managerName;
    delete p._managerIdRaw;
    delete p._dottedName;
  }

  return { people, errors };
}

/** Roster as array-of-arrays (header + one row per person), shared by CSV and XLSX export. */
function rosterRows(people) {
  const byId = new Map(people.map(p => [p.id, p]));
  const nameOf = (id) => (id && byId.has(id) ? byId.get(id).name : '');
  const rows = [[
    'name', 'title', 'department', 'email', 'phone', 'location',
    'start_date', 'salary', 'notes', 'is_open_role', 'manager_name', 'dotted_manager_name',
  ]];
  for (const p of people) {
    rows.push([
      p.name || '', p.title || '', p.department || '', p.email || '',
      p.phone || '', p.location || '', p.startDate || '',
      p.salary == null ? '' : p.salary, p.notes || '',
      p.isOpenRole ? 'yes' : '',
      nameOf(p.managerId), nameOf(p.dottedManagerId),
    ]);
  }
  return rows;
}

/** Serialize a roster to CSV. */
function serializeRoster(people) {
  return serializeCSVRows(rosterRows(people));
}

const OrgtreeCSV = { parseCSVRows, serializeCSVRows, parseRoster, serializeRoster, rosterRows };

if (typeof module !== 'undefined' && module.exports) module.exports = OrgtreeCSV;
if (typeof window !== 'undefined') window.OrgtreeCSV = OrgtreeCSV;
