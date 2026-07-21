'use strict';

/* global OrgtreeTree, OrgtreeCSV, OrgtreeLayout */

// ---------- state ----------

let doc = null;             // full normalized document {people, settings, scenarios}
let people = [];            // active roster (live people OR active scenario's people)
let collapsed = new Set();  // active collapsed set
let activeScenarioId = null;

let rootId = null;          // drill-down root person id, or null for full tree
let deptFilter = '';        // '' = all departments
let selectedId = null;      // node shown in the profile drawer
let highlightId = null;     // search-highlighted node (fades after a beat)
let hoverId = null;         // node under the cursor
let deptColorMap = new Map();
let rollupStats = new Map();
let zoom = 1;

const canvas = document.getElementById('chart');
const ctx = canvas.getContext('2d');
const chartWrap = document.getElementById('chart-wrap');
const emptyEl = document.getElementById('empty');

let lastLayout = null;
const photoCache = new Map(); // path -> HTMLImageElement | 'error'

const $ = (id) => document.getElementById(id);

// ---------- theme ----------

const THEMES = {
  light: {
    cardBg: '#ffffff', cardBorder: '#e4e9f1', cardBorderHover: '#c9d3e0',
    shadow: 'rgba(16,24,40,0.10)', shadowHover: 'rgba(16,24,40,0.18)',
    name: '#101828', title: '#667085', edge: '#c9d3e0', dottedEdge: '#94a3c0',
    badgeBg: '#ffffff', badgeBorder: '#c9d3e0', badgeText: '#475467',
    select: '#0b66ff', highlight: '#f59e0b', pillAlpha: 0.12, avatarAlpha: 0.16,
    chipBg: '#f0f3f8', chipText: '#475467', openTint: 'rgba(11,102,255,0.04)',
  },
  dark: {
    cardBg: '#151d2a', cardBorder: '#223047', cardBorderHover: '#324258',
    shadow: 'rgba(0,0,0,0.45)', shadowHover: 'rgba(0,0,0,0.65)',
    name: '#e8eef7', title: '#8b9bb4', edge: '#324258', dottedEdge: '#4a5f80',
    badgeBg: '#1a2434', badgeBorder: '#324258', badgeText: '#e8eef7',
    select: '#60a5fa', highlight: '#facc15', pillAlpha: 0.22, avatarAlpha: 0.24,
    chipBg: '#1a2434', chipText: '#8b9bb4', openTint: 'rgba(59,130,246,0.07)',
  },
};

function currentTheme() {
  return THEMES[document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'];
}

function applyTheme(mode) {
  document.documentElement.dataset.theme = mode;
  try { localStorage.setItem('orgtree-theme', mode); } catch (e) { /* private mode */ }
  render();
}

$('btn-theme').addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
});

(function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem('orgtree-theme'); } catch (e) { /* private mode */ }
  document.documentElement.dataset.theme = saved === 'dark' ? 'dark' : 'light';
})();

// ---------- document plumbing ----------

function viewSettings() { return doc.settings; }

function adoptDocument(data, fileName) {
  doc = data;
  activeScenarioId = doc.settings.activeScenarioId || null;
  const sc = activeScenarioId ? doc.scenarios.find(s => s.id === activeScenarioId) : null;
  if (sc) {
    people = sc.people;
    collapsed = new Set(sc.collapsed || []);
  } else {
    activeScenarioId = null;
    people = doc.people;
    collapsed = new Set(doc.settings.collapsed || []);
  }
  if (fileName) lastFileName = fileName;
  updateDocChip();
  clearHistory();
  rootId = null; deptFilter = ''; selectedId = null; highlightId = null;
  deptColorMap = new Map();
}

let lastFileName = 'My Org';
function updateDocChip() {
  const company = doc && doc.settings.companyName;
  $('doc-name').textContent = company ? company : lastFileName;
  $('doc-name').title = company ? `${company} (${lastFileName})` : lastFileName;
}

/** Reload the document from disk (e.g. an employee updated their profile over
 *  chat) while keeping the current view state and undo history. */
async function refreshFromDisk() {
  const res = await window.orgtree.loadData();
  doc = res.data;
  const sc = activeScenarioId ? doc.scenarios.find(s => s.id === activeScenarioId) : null;
  if (sc) {
    people = sc.people;
    collapsed = new Set(sc.collapsed || []);
  } else {
    activeScenarioId = null;
    people = doc.people;
    collapsed = new Set(doc.settings.collapsed || []);
  }
  if (selectedId && !people.some(p => p.id === selectedId)) { selectedId = null; closeDrawer(); }
  if (rootId && !people.some(p => p.id === rootId)) rootId = null;
  render();
}

if (window.orgtree.onExternalChange) {
  window.orgtree.onExternalChange(() => {
    // Skip while the editor is open so the admin's in-progress edit wins.
    if (!$('modal').classList.contains('hidden')) return;
    refreshFromDisk();
    toast('Chart updated — an employee filled in their profile');
  });
}

/** Write the active roster/collapsed back into its slot in `doc`. */
function syncBack() {
  const sc = activeScenarioId ? doc.scenarios.find(s => s.id === activeScenarioId) : null;
  if (sc) {
    sc.people = people;
    sc.collapsed = [...collapsed];
  } else {
    doc.people = people;
    doc.settings.collapsed = [...collapsed];
  }
  doc.settings.activeScenarioId = activeScenarioId;
}

async function loadAll() {
  const res = await window.orgtree.loadData();
  adoptDocument(res.data, res.fileName);
}

async function persist() {
  if (!doc) return; // member edition never loads a document
  syncBack();
  await window.orgtree.saveData(doc);
}

// ---------- undo / redo ----------

const undoStack = [];
const redoStack = [];
const HISTORY_MAX = 100;

function snapshot() {
  return { people: JSON.parse(JSON.stringify(people)), collapsed: [...collapsed] };
}
function restore(snap) {
  people = snap.people;
  collapsed = new Set(snap.collapsed);
  if (selectedId && !people.some(p => p.id === selectedId)) selectedId = null;
  if (rootId && !people.some(p => p.id === rootId)) rootId = null;
}
function pushUndo() {
  undoStack.push(snapshot());
  if (undoStack.length > HISTORY_MAX) undoStack.shift();
  redoStack.length = 0;
  updateHistoryButtons();
}
function clearHistory() {
  undoStack.length = 0; redoStack.length = 0;
  updateHistoryButtons();
}
async function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  restore(undoStack.pop());
  updateHistoryButtons();
  await persist(); render(); toast('Undone');
}
async function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  restore(redoStack.pop());
  updateHistoryButtons();
  await persist(); render(); toast('Redone');
}
function updateHistoryButtons() {
  $('btn-undo').disabled = !undoStack.length;
  $('btn-redo').disabled = !redoStack.length;
}
$('btn-undo').addEventListener('click', undo);
$('btn-redo').addEventListener('click', redo);

// ---------- department colors ----------

const PALETTE = [
  '#0b66ff', '#0d9488', '#ea580c', '#7c3aed', '#e11d48',
  '#ca8a04', '#0891b2', '#db2777', '#65a30d', '#4f46e5',
  '#c2410c', '#059669',
];

function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function colorFor(dept) {
  if (!dept) return '#64748b';
  if (!deptColorMap.has(dept)) {
    deptColorMap.set(dept, PALETTE[hashStr(dept) % PALETTE.length]);
  }
  return deptColorMap.get(dept);
}

function rebuildLegend() {
  const legend = $('legend');
  const depts = OrgtreeTree.departmentsOf(people);
  if (!depts.length) { legend.innerHTML = ''; legend.classList.add('hidden'); return; }
  legend.classList.remove('hidden');
  legend.innerHTML = '<div class="legend-title">Departments</div>' + depts.map(d =>
    `<div class="legend-row" data-dept="${escapeAttr(d)}"><span class="dot" style="background:${colorFor(d)}"></span>${escapeHtml(d)}</div>`
  ).join('');
}
$('legend').addEventListener('click', (e) => {
  const row = e.target.closest('.legend-row');
  if (!row) return;
  const d = row.dataset.dept;
  deptFilter = (deptFilter === d) ? '' : d;
  $('dept-filter').value = deptFilter;
  render();
});

// ---------- dept filter + manager dropdowns ----------

function rebuildDeptFilterOptions() {
  const sel = $('dept-filter');
  const depts = OrgtreeTree.departmentsOf(people);
  const cur = deptFilter;
  sel.innerHTML = '<option value="">All departments</option>' +
    depts.map(d => `<option value="${escapeAttr(d)}">${escapeHtml(d)}</option>`).join('');
  sel.value = depts.includes(cur) ? cur : '';
  deptFilter = sel.value;

  const dl = $('dept-list');
  dl.innerHTML = depts.map(d => `<option value="${escapeAttr(d)}">`).join('');
}

function rebuildManagerOptions(excludeId) {
  const problems = new Set(OrgtreeTree.detectCycles(people).map(p => p.id));
  const options = people
    .filter(p => p.id !== excludeId)
    .sort((a, b) => a.name.localeCompare(b.name));
  const optHtml = options.map(p =>
    `<option value="${escapeAttr(p.id)}">${escapeHtml(p.name)}${problems.has(p.id) ? ' ⚠' : ''}${p.title ? ' — ' + escapeHtml(p.title) : ''}</option>`
  ).join('');
  $('f-manager').innerHTML = '<option value="">— No manager (root) —</option>' + optHtml;
  $('f-dotted').innerHTML = '<option value="">— None —</option>' + optHtml;
}

// ---------- HTML escaping ----------

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

function fmtMoney(n) {
  if (n == null || isNaN(n)) return '';
  if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1) + 'M';
  if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'k';
  return '$' + Math.round(n);
}

// ---------- conditional formatting ----------

function ruleFieldValue(p, field) {
  switch (field) {
    case 'name': return p.name || '';
    case 'title': return p.title || '';
    case 'department': return p.department || '';
    case 'email': return p.email || '';
    case 'location': return p.location || '';
    case 'salary': return p.salary;
    default: return '';
  }
}

function matchingRuleColor(p) {
  for (const r of viewSettings().condRules) {
    const v = ruleFieldValue(p, r.field);
    if (r.field === 'salary') {
      const num = typeof v === 'number' ? v : NaN;
      const target = Number(String(r.value).replace(/[$,\s]/g, ''));
      if (isNaN(num) || isNaN(target)) continue;
      if (r.op === 'gt' && num > target) return r.color;
      if (r.op === 'lt' && num < target) return r.color;
      if (r.op === 'equals' && num === target) return r.color;
    } else {
      const s = String(v).toLowerCase();
      const t = String(r.value).toLowerCase();
      if (!t) continue;
      if (r.op === 'contains' && s.includes(t)) return r.color;
      if (r.op === 'equals' && s === t) return r.color;
    }
  }
  return null;
}

// ---------- rendering ----------

function currentRoots() {
  const fullTree = OrgtreeTree.buildTree(people);
  let roots = fullTree;
  if (rootId) {
    const node = OrgtreeTree.findNode(fullTree, rootId);
    roots = node ? [node] : fullTree;
  }
  if (deptFilter) {
    roots = OrgtreeTree.filterByDepartment(roots, deptFilter);
  }
  return roots;
}

const PAD = 60;

function render() {
  if (!doc) return; // member edition never loads a document
  rebuildLegend();
  rebuildDeptFilterOptions();
  updateScenarioUI();
  updateViewTicks();
  rollupStats = OrgtreeTree.descendantStats(people);

  const resetBtn = $('btn-reset-view');
  resetBtn.classList.toggle('active', !!rootId);
  resetBtn.querySelector('span').textContent = rootId ? 'Back to full tree' : 'Full tree';

  if (!people.length) {
    emptyEl.classList.remove('hidden');
    canvas.width = 0; canvas.height = 0;
    lastLayout = null;
    closeDrawer();
    persist();
    return;
  }
  emptyEl.classList.add('hidden');

  const roots = currentRoots();
  const layout = OrgtreeLayout.layoutTree(roots, collapsed);
  lastLayout = layout;

  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(200, layout.width) + PAD * 2;
  const h = Math.max(160, layout.height) + PAD * 2;

  canvas.style.width = (w * zoom) + 'px';
  canvas.style.height = (h * zoom) + 'px';
  canvas.width = Math.round(w * zoom * dpr);
  canvas.height = Math.round(h * zoom * dpr);
  ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, 0, 0);
  ctx.translate(-layout.minX + PAD, PAD);

  drawTree(layout);
  syncDrawer();
  persist();
}

function drawTree(layout) {
  const t = currentTheme();
  ctx.clearRect(layout.minX - PAD, -PAD, layout.width + PAD * 2, layout.height + PAD * 2);

  const posById = new Map(layout.positions.map(p => [p.id, p]));

  // solid reporting edges (under nodes), soft rounded elbows
  ctx.strokeStyle = t.edge;
  ctx.lineWidth = 1.6;
  for (const e of layout.edges) {
    const midY = (e.y1 + e.y2) / 2;
    const dx = e.x2 - e.x1;
    ctx.beginPath();
    ctx.moveTo(e.x1, e.y1);
    if (Math.abs(dx) < 22) {
      ctx.lineTo(e.x1, midY);
      ctx.lineTo(e.x2, midY);
      ctx.lineTo(e.x2, e.y2);
    } else {
      const r = 10;
      const dir = Math.sign(dx);
      ctx.lineTo(e.x1, midY - r);
      ctx.arcTo(e.x1, midY, e.x1 + dir * r, midY, r);
      ctx.lineTo(e.x2 - dir * r, midY);
      ctx.arcTo(e.x2, midY, e.x2, midY + r, r);
      ctx.lineTo(e.x2, e.y2);
    }
    ctx.stroke();
  }

  // dotted-line (secondary) reporting edges
  ctx.save();
  ctx.strokeStyle = t.dottedEdge;
  ctx.lineWidth = 1.4;
  ctx.setLineDash([6, 5]);
  for (const p of people) {
    if (!p.dottedManagerId || p.dottedManagerId === p.managerId) continue;
    const from = posById.get(p.dottedManagerId);
    const to = posById.get(p.id);
    if (!from || !to) continue;
    const x1 = from.cx, y1 = from.y + from.h;
    const x2 = to.cx, y2 = to.y;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.bezierCurveTo(x1, y1 + 44, x2, y2 - 44, x2, y2);
    ctx.stroke();
  }
  ctx.restore();

  for (const pos of layout.positions) {
    drawNode(pos, t);
  }

  drawDragOverlay(t);
}

function drawNode(pos, t) {
  const p = pos.node;
  const color = colorFor(p.department);
  const isSelected = p.id === selectedId;
  const isHighlight = p.id === highlightId;
  const isHover = p.id === hoverId && !drag.active;
  const isDragged = drag.active && drag.id === p.id;
  const isDropTarget = drag.active && drag.targetId === p.id;
  const ruleColor = matchingRuleColor(p);

  ctx.save();
  if (isDragged) ctx.globalAlpha = 0.35;

  // card with soft shadow
  roundRect(ctx, pos.x, pos.y, pos.w, pos.h, 12);
  ctx.shadowColor = (isHover || isSelected) ? t.shadowHover : t.shadow;
  ctx.shadowBlur = (isHover || isSelected) ? 16 : 8;
  ctx.shadowOffsetY = (isHover || isSelected) ? 5 : 2;
  ctx.fillStyle = t.cardBg;
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  if (p.isOpenRole) {
    roundRect(ctx, pos.x, pos.y, pos.w, pos.h, 12);
    ctx.fillStyle = t.openTint;
    ctx.fill();
  }
  if (ruleColor) {
    roundRect(ctx, pos.x, pos.y, pos.w, pos.h, 12);
    ctx.globalAlpha = (isDragged ? 0.35 : 1) * 0.08;
    ctx.fillStyle = ruleColor;
    ctx.fill();
    ctx.globalAlpha = isDragged ? 0.35 : 1;
  }

  roundRect(ctx, pos.x, pos.y, pos.w, pos.h, 12);
  ctx.lineWidth = isHighlight ? 2.6 : (isSelected || isDropTarget) ? 2 : 1.4;
  if (p.isOpenRole && !isSelected && !isHighlight && !isDropTarget) ctx.setLineDash([5, 4]);
  ctx.strokeStyle = isHighlight ? t.highlight
    : isDropTarget ? t.select
    : isSelected ? t.select
    : ruleColor ? ruleColor
    : (isHover ? t.cardBorderHover : t.cardBorder);
  ctx.stroke();
  ctx.setLineDash([]);

  // avatar
  const av = 44;
  const avX = pos.x + 14;
  const avY = pos.y + (pos.h - av) / 2;
  drawAvatar(p, avX, avY, av, color, t);

  // text block
  const textX = avX + av + 12;
  const maxW = pos.w - (textX - pos.x) - 12;

  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillStyle = p.isOpenRole ? t.title : t.name;
  ctx.font = (p.isOpenRole ? 'italic 600 13.5px' : '600 13.5px') + ' "Segoe UI", system-ui, sans-serif';
  clipText(ctx, p.isOpenRole ? (p.name || 'Open role') : (p.name || '(no name)'), textX, pos.y + 28, maxW);

  ctx.fillStyle = t.title;
  ctx.font = '400 12px "Segoe UI", system-ui, sans-serif';
  clipText(ctx, p.title || '', textX, pos.y + 46, maxW);

  // row 3: chips right (headcount / cost), department pill left in remaining space
  const s = viewSettings();
  const stats = rollupStats.get(p.id) || { reports: 0, cost: 0 };
  const py = pos.y + 55;
  let rightEdge = pos.x + pos.w - 10;

  ctx.font = '600 10.5px "Segoe UI", system-ui, sans-serif';
  if (s.showCost && stats.cost > 0) {
    rightEdge -= drawChip(fmtMoney(stats.cost), rightEdge, py, t, true);
    rightEdge -= 4;
  }
  if (s.showHeadcount && stats.reports > 0) {
    rightEdge -= drawChip(String(stats.reports), rightEdge, py, t, false);
    rightEdge -= 4;
  }

  if (s.showDeptPill && p.department) {
    ctx.font = '600 10.5px "Segoe UI", system-ui, sans-serif';
    let label = p.department;
    const pillMax = rightEdge - textX - 2;
    if (pillMax > 24) {
      if (ctx.measureText(label).width > pillMax - 14) {
        while (label.length > 1 && ctx.measureText(label + '…').width > pillMax - 14) label = label.slice(0, -1);
        label += '…';
      }
      const tw = ctx.measureText(label).width;
      roundRect(ctx, textX, py, tw + 14, 18, 9);
      ctx.globalAlpha = (isDragged ? 0.35 : 1) * t.pillAlpha;
      ctx.fillStyle = color;
      ctx.fill();
      ctx.globalAlpha = isDragged ? 0.35 : 1;
      ctx.fillStyle = color;
      ctx.textBaseline = 'middle';
      ctx.fillText(label, textX + 7, py + 9.5);
      ctx.textBaseline = 'alphabetic';
    }
  }

  ctx.restore();

  // collapse/expand badge with direct-report count
  if (pos.hasChildren) {
    const bx = pos.x + pos.w / 2;
    const by = pos.y + pos.h;
    const label = pos.collapsed ? '+' + pos.childCount : '−';
    ctx.font = '700 11px "Segoe UI", system-ui, sans-serif';
    const lw = ctx.measureText(label).width;
    const bw = Math.max(22, lw + 14);

    roundRect(ctx, bx - bw / 2, by - 11, bw, 22, 11);
    ctx.fillStyle = pos.collapsed ? t.select : t.badgeBg;
    ctx.fill();
    ctx.strokeStyle = pos.collapsed ? t.select : t.badgeBorder;
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.fillStyle = pos.collapsed ? '#ffffff' : t.badgeText;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, bx, by + 1);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }
}

/** Draw a small stat chip whose RIGHT edge is at x. Returns its width. */
function drawChip(label, x, y, t, isMoney) {
  const tw = ctx.measureText(label).width;
  const glyphW = isMoney ? 0 : 11;
  const w = tw + glyphW + 12;
  roundRect(ctx, x - w, y, w, 18, 9);
  ctx.fillStyle = t.chipBg;
  ctx.fill();
  ctx.fillStyle = t.chipText;
  let tx = x - w + 6;
  if (!isMoney) {
    // mini "people" glyph: two heads
    ctx.beginPath();
    ctx.arc(tx + 3, y + 7, 2.4, 0, Math.PI * 2);
    ctx.arc(tx + 7.5, y + 8.5, 1.9, 0, Math.PI * 2);
    ctx.fill();
    tx += glyphW;
  }
  ctx.textBaseline = 'middle';
  ctx.fillText(label, tx, y + 9.5);
  ctx.textBaseline = 'alphabetic';
  return w;
}

function drawAvatar(p, x, y, size, color, t) {
  if (p.photo) {
    const img = getPhotoImage(p.photo);
    if (img && img !== 'error') {
      ctx.save();
      ctx.beginPath();
      ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(img, x, y, size, size);
      ctx.restore();
      return;
    }
  }
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.globalAlpha *= t.avatarAlpha;
  ctx.fill();
  ctx.globalAlpha = drag.active && drag.id === p.id ? 0.35 : 1;
  ctx.fillStyle = color;
  ctx.font = '700 15px "Segoe UI", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(p.isOpenRole ? '+' : initials(p.name), x + size / 2, y + size / 2 + 1);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}

function getPhotoImage(filePath) {
  if (photoCache.has(filePath)) return photoCache.get(filePath);
  const img = new Image();
  photoCache.set(filePath, img);
  img.onload = () => render();
  img.onerror = () => photoCache.set(filePath, 'error');
  img.src = photoUrl(filePath);
  return null;
}
function photoUrl(filePath) {
  return 'file:///' + String(filePath).replace(/\\/g, '/').replace(/^\/+/, '');
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function clipText(c, text, x, y, maxWidth) {
  if (!text) return;
  let t = text;
  if (c.measureText(t).width > maxWidth) {
    while (t.length > 1 && c.measureText(t + '…').width > maxWidth) t = t.slice(0, -1);
    t += '…';
  }
  c.fillText(t, x, y);
}

// ---------- hit testing ----------

function chartCoords(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (clientX - rect.left) / zoom - PAD + (lastLayout ? lastLayout.minX : 0),
    y: (clientY - rect.top) / zoom - PAD,
  };
}

function hitTest(clientX, clientY) {
  if (!lastLayout) return null;
  const { x: localX, y: localY } = chartCoords(clientX, clientY);

  for (const pos of lastLayout.positions) {
    if (pos.hasChildren) {
      const bx = pos.x + pos.w / 2, by = pos.y + pos.h;
      if (Math.abs(localX - bx) <= 20 && Math.abs(localY - by) <= 13) return { type: 'badge', pos };
    }
    if (localX >= pos.x && localX <= pos.x + pos.w && localY >= pos.y && localY <= pos.y + pos.h) {
      return { type: 'node', pos };
    }
  }
  return null;
}

// ---------- drag-and-drop re-parenting ----------

const drag = { candidate: null, active: false, id: null, targetId: null, x: 0, y: 0 };

function dragValidTarget(targetId) {
  if (!targetId || targetId === drag.id) return false;
  const dragged = people.find(p => p.id === drag.id);
  if (!dragged) return false;
  if (targetId === dragged.managerId) return false;   // no-op
  return !wouldCreateCycle(drag.id, targetId);
}

canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  const hit = hitTest(e.clientX, e.clientY);
  if (hit && hit.type === 'node') {
    drag.candidate = { id: hit.pos.id, sx: e.clientX, sy: e.clientY };
  }
});

// ---------- pan by dragging empty space ----------

const pan = { candidate: null, active: false };

chartWrap.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  if (e.target.closest('.zoom-pill') || e.target.closest('.empty')) return;
  // A press on a card starts a re-parent drag, not a pan.
  if (e.target === canvas && hitTest(e.clientX, e.clientY)) return;
  pan.candidate = { sx: e.clientX, sy: e.clientY, sl: chartWrap.scrollLeft, st: chartWrap.scrollTop };
});

window.addEventListener('mousemove', (e) => {
  if (!pan.candidate) return;
  const dx = e.clientX - pan.candidate.sx;
  const dy = e.clientY - pan.candidate.sy;
  if (!pan.active && Math.abs(dx) + Math.abs(dy) > 4) {
    pan.active = true;
    chartWrap.style.cursor = 'grabbing';
    canvas.style.cursor = 'grabbing';
  }
  if (pan.active) {
    chartWrap.scrollLeft = pan.candidate.sl - dx;
    chartWrap.scrollTop = pan.candidate.st - dy;
  }
});

window.addEventListener('mouseup', () => {
  if (pan.active) {
    // A real pan is not a click — don't clear the selection afterwards.
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);
  }
  pan.candidate = null;
  pan.active = false;
  chartWrap.style.cursor = '';
  canvas.style.cursor = '';
});

window.addEventListener('mousemove', (e) => {
  if (drag.candidate && !drag.active) {
    if (Math.abs(e.clientX - drag.candidate.sx) + Math.abs(e.clientY - drag.candidate.sy) > 7) {
      drag.active = true;
      drag.id = drag.candidate.id;
      canvas.style.cursor = 'grabbing';
    }
  }
  if (drag.active) {
    const c = chartCoords(e.clientX, e.clientY);
    drag.x = c.x; drag.y = c.y;
    const hit = hitTest(e.clientX, e.clientY);
    drag.targetId = (hit && hit.type === 'node' && dragValidTarget(hit.pos.id)) ? hit.pos.id : null;
    if (lastLayout) drawTree(lastLayout);
  }
});

window.addEventListener('mouseup', async (e) => {
  const wasActive = drag.active;
  const dropTarget = drag.targetId;
  const draggedId = drag.id;
  drag.candidate = null; drag.active = false; drag.id = null; drag.targetId = null;
  canvas.style.cursor = 'default';

  if (!wasActive) return;
  suppressClick = true;
  setTimeout(() => { suppressClick = false; }, 0);

  if (dropTarget) {
    const p = people.find(x => x.id === draggedId);
    const boss = people.find(x => x.id === dropTarget);
    if (p && boss) {
      pushUndo();
      p.managerId = dropTarget;
      await persist();
      render();
      toast(`${p.name} now reports to ${boss.name}`);
      return;
    }
  }
  if (lastLayout) drawTree(lastLayout);
});

function drawDragOverlay(t) {
  if (!drag.active || !lastLayout) return;
  const p = people.find(x => x.id === drag.id);
  if (!p) return;

  const w = 150, h = 40;
  const x = drag.x - w / 2, y = drag.y - h - 8;
  ctx.save();
  roundRect(ctx, x, y, w, h, 10);
  ctx.shadowColor = t.shadowHover;
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 6;
  ctx.fillStyle = t.cardBg;
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.strokeStyle = t.select;
  ctx.lineWidth = 1.6;
  roundRect(ctx, x, y, w, h, 10);
  ctx.stroke();
  ctx.fillStyle = t.name;
  ctx.font = '600 12.5px "Segoe UI", system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  clipText(ctx, p.name, x + 12, y + h / 2, w - 24);
  ctx.textBaseline = 'alphabetic';
  ctx.restore();
}

// ---------- click / hover ----------

let suppressClick = false;

canvas.addEventListener('click', (e) => {
  if (suppressClick) return;
  const hit = hitTest(e.clientX, e.clientY);
  if (!hit) { selectedId = null; closeDrawer(); render(); return; }
  if (hit.type === 'badge') {
    toggleCollapse(hit.pos.id);
    return;
  }
  selectedId = hit.pos.id;
  openDrawer(hit.pos.node.id);
  render();
});

canvas.addEventListener('dblclick', (e) => {
  const hit = hitTest(e.clientX, e.clientY);
  if (hit && hit.type === 'node') openEditor(hit.pos.node.id);
});

let hoverRafPending = false;
canvas.addEventListener('mousemove', (e) => {
  if (drag.active || hoverRafPending) return;
  hoverRafPending = true;
  const cx = e.clientX, cy = e.clientY;
  requestAnimationFrame(() => {
    hoverRafPending = false;
    if (drag.active) return;
    const hit = hitTest(cx, cy);
    const newHover = hit && hit.type === 'node' ? hit.pos.id : null;
    canvas.style.cursor = hit ? 'pointer' : 'grab';
    if (newHover !== hoverId) {
      hoverId = newHover;
      if (lastLayout) drawTree(lastLayout);
    }
  });
});
canvas.addEventListener('mouseleave', () => {
  if (drag.active) return;
  if (hoverId !== null) { hoverId = null; if (lastLayout) drawTree(lastLayout); }
  canvas.style.cursor = 'default';
});

function toggleCollapse(id) {
  if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
  render();
}

// ---------- zoom ----------

function setZoom(z, { silent } = {}) {
  zoom = Math.min(2, Math.max(0.25, z));
  $('zoom-label').textContent = Math.round(zoom * 100) + '%';
  if (!silent) render();
}
$('btn-zoom-in').addEventListener('click', () => setZoom(zoom * 1.2));
$('btn-zoom-out').addEventListener('click', () => setZoom(zoom / 1.2));
$('btn-zoom-fit').addEventListener('click', zoomToFit);

function zoomToFit() {
  if (!lastLayout) return;
  const w = lastLayout.width + PAD * 2;
  const h = lastLayout.height + PAD * 2;
  const z = Math.min((chartWrap.clientWidth - 8) / w, (chartWrap.clientHeight - 8) / h, 1.5);
  setZoom(z);
  chartWrap.scrollTo({ left: 0, top: 0 });
}

chartWrap.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  setZoom(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
}, { passive: false });

// ---------- profile drawer ----------

function openDrawer(id) {
  selectedId = id;
  syncDrawer();
}

function closeDrawer() {
  $('drawer').classList.add('hidden');
}

function syncDrawer() {
  const drawer = $('drawer');
  const p = selectedId ? people.find(x => x.id === selectedId) : null;
  if (!p) { drawer.classList.add('hidden'); return; }
  drawer.classList.remove('hidden');

  const color = colorFor(p.department);
  const av = $('drawer-avatar');
  if (p.photo) {
    av.style.backgroundImage = `url("${photoUrl(p.photo).replace(/"/g, '%22')}")`;
    av.style.backgroundColor = 'transparent';
    av.textContent = '';
  } else {
    av.style.backgroundImage = 'none';
    av.style.backgroundColor = color + '29';
    av.style.color = color;
    av.textContent = p.isOpenRole ? '+' : initials(p.name);
  }
  $('drawer-name').textContent = p.isOpenRole ? (p.name || 'Open role') : p.name;
  $('drawer-title').textContent = p.title || '—';

  const byId = new Map(people.map(x => [x.id, x]));
  const stats = rollupStats.get(p.id) || { reports: 0, cost: 0 };
  const directs = people.filter(x => x.managerId === p.id).length;
  const mgr = p.managerId ? byId.get(p.managerId) : null;
  const dotted = p.dottedManagerId ? byId.get(p.dottedManagerId) : null;

  const row = (iconId, k, vHtml) => vHtml
    ? `<div class="drawer-row"><svg class="icon"><use href="#${iconId}"/></svg><span class="k">${k}</span><span class="v">${vHtml}</span></div>`
    : '';

  let html = '';
  if (p.isOpenRole) {
    html += `<span class="drawer-badge" style="background:${color}22;color:${color}">OPEN ROLE — HIRING</span>`;
  }
  if (p.department) {
    html += `<span class="drawer-badge" style="background:${color}22;color:${color}">${escapeHtml(p.department)}</span>`;
  }
  html += `<div class="drawer-stats">
    <div class="drawer-stat"><b>${directs}</b><span>direct</span></div>
    <div class="drawer-stat"><b>${stats.reports}</b><span>total team</span></div>
    ${viewSettings().showCost && stats.cost > 0 ? `<div class="drawer-stat"><b>${fmtMoney(stats.cost)}</b><span>branch cost</span></div>` : ''}
  </div>`;

  html += row('i-users', 'Manager', mgr ? escapeHtml(mgr.name) : (p.managerId ? '(missing)' : '—'));
  if (dotted) html += row('i-users', 'Dotted line', escapeHtml(dotted.name));
  html += row('i-mail', 'Email', p.email ? `<a href="mailto:${escapeAttr(p.email)}">${escapeHtml(p.email)}</a>` : '');
  html += row('i-phone', 'Phone', escapeHtml(p.phone));
  html += row('i-pin', 'Location', escapeHtml(p.location));
  html += row('i-file', 'Start date', escapeHtml(p.startDate));
  html += row('i-timer', 'Time zone', escapeHtml(p.timezone));
  html += row('i-timer', 'Working hours', escapeHtml(p.workHours));
  if (p.salary != null) html += row('i-dollar', 'Salary', escapeHtml('$' + p.salary.toLocaleString()));
  html += row('i-file', 'Notes', escapeHtml(p.notes));
  for (const [k, v] of Object.entries(p.custom || {})) {
    html += row('i-file', escapeHtml(k), escapeHtml(v));
  }
  $('drawer-body').innerHTML = html;
  $('btn-drawer-invite').classList.toggle('hidden', !p.email || p.isOpenRole);
}

$('btn-drawer-close').addEventListener('click', () => { selectedId = null; closeDrawer(); render(); });
$('btn-drawer-invite').addEventListener('click', async () => {
  const p = selectedId ? people.find(x => x.id === selectedId) : null;
  if (!p || !p.email) return;
  const smtp = await window.orgtree.smtpGet();
  if (!smtp.host) { toast('Set up email first: File → Email invite settings'); openSmtpModal(); return; }
  const res = await window.orgtree.smtpInvite({
    to: p.email, name: p.name,
    company: viewSettings().companyName || '',
    department: p.department || '',
  });
  if (res.ok) toast(`Invite emailed to ${p.email}${res.joinAddr ? ' (join address included)' : ' — host the chat so invites include a join address'}`);
  else if (res.error === 'not-configured') { toast('Set up email first: File → Email invite settings'); openSmtpModal(); }
  else toast('Invite failed: ' + res.error);
});
$('btn-drawer-edit').addEventListener('click', () => selectedId && openEditor(selectedId));
$('btn-drawer-focus').addEventListener('click', () => {
  if (!selectedId) return;
  rootId = selectedId;
  render();
});
$('btn-drawer-delete').addEventListener('click', () => selectedId && deletePerson(selectedId));

// ---------- menus ----------

function closeAllMenus() {
  document.querySelectorAll('.menu-pop').forEach(m => m.classList.add('hidden'));
}
document.querySelectorAll('.menu-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const pop = btn.parentElement.querySelector('.menu-pop');
    const wasHidden = pop.classList.contains('hidden');
    closeAllMenus();
    if (wasHidden) {
      if (pop.id === 'scenario-pop') rebuildScenarioMenu();
      pop.classList.remove('hidden');
      if (pop.id === 'timeclock-pop' && window.__wholeteamRenderClockMenu) window.__wholeteamRenderClockMenu();
    }
  });
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.menu')) closeAllMenus();
});

$('menu-file').querySelector('.menu-pop').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-a]');
  if (!btn) return;
  closeAllMenus();
  fileAction(btn.dataset.a);
});

async function fileAction(a) {
  if (a === 'new') {
    await persist();
    const res = await window.orgtree.fileNew();
    if (res && res.ok) { adoptDocument(res.data, res.fileName); render(); toast('New chart created'); }
  } else if (a === 'open') {
    await persist();
    const res = await window.orgtree.fileOpen();
    if (res && res.ok) { adoptDocument(res.data, res.fileName); render(); toast('Opened ' + res.fileName); }
    else if (res && res.error) toast('Open failed: ' + res.error);
  } else if (a === 'openDefault') {
    await persist();
    const res = await window.orgtree.fileOpenDefault();
    if (res && res.ok) { adoptDocument(res.data, res.fileName); render(); }
  } else if (a === 'saveAs') {
    syncBack();
    const res = await window.orgtree.fileSaveAs(doc);
    if (res && res.ok) { $('doc-name').textContent = res.fileName; toast('Saved as ' + res.fileName); }
  } else if (a === 'importCSV') {
    importRoster();
  } else if (a === 'smtp') {
    openSmtpModal();
  } else if (a === 'wizard') {
    openWizard();
  } else if (a === 'exportCSV') {
    await persist();
    const res = await window.orgtree.exportCSV();
    if (res && res.ok) toast('Exported CSV: ' + res.path);
  } else if (a === 'exportXLSX') {
    await persist();
    const res = await window.orgtree.exportXLSX();
    if (res && res.ok) toast('Exported Excel: ' + res.path);
    else if (res && res.error) toast('Excel export failed: ' + res.error);
  } else if (a === 'exportPNG') {
    exportPNG();
  } else if (a === 'exportPDF') {
    exportPDF();
  }
}

$('menu-settings').querySelector('.menu-pop').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-a]');
  if (!btn) return;
  closeAllMenus();
  const a = btn.dataset.a;
  if (a === 'newCompany') {
    await persist();
    const res = await window.orgtree.fileNew();
    if (res && res.ok) {
      adoptDocument(res.data, res.fileName);
      render();
      openWizard();
    }
  } else if (a === 'wizard') {
    openWizard();
  } else if (a === 'chat') {
    // Hosting, joining, clock-in and My profile all live in the chat panel.
    if ($('chat-panel').classList.contains('hidden')) $('btn-chat').click();
  } else if (a === 'smtp') {
    openSmtpModal();
  } else if (a === 'rules') {
    openRulesModal();
  } else if (a === 'clearSample') {
    const sample = people.filter(p => p.id.startsWith('sample-'));
    if (!sample.length) { toast('No sample data on this chart'); return; }
    pushUndo();
    people = people.filter(p => !p.id.startsWith('sample-'));
    const alive = new Set(people.map(p => p.id));
    for (const p of people) {
      if (p.managerId && !alive.has(p.managerId)) p.managerId = null;
      if (p.dottedManagerId && !alive.has(p.dottedManagerId)) p.dottedManagerId = null;
    }
    collapsed = new Set([...collapsed].filter(id => alive.has(id)));
    if (rootId && !alive.has(rootId)) rootId = null;
    if (selectedId && !alive.has(selectedId)) { selectedId = null; closeDrawer(); }
    await persist();
    render();
    toast(`Removed ${sample.length} sample ${sample.length === 1 ? 'person' : 'people'} (Ctrl+Z to undo)`);
  } else if (a === 'clearAll') {
    if (!people.length) { toast('Chart is already empty'); return; }
    if (!confirm(`Clear the entire chart? All ${people.length} people will be removed.\n\nYou can undo with Ctrl+Z until you close the app.`)) return;
    pushUndo();
    people = [];
    collapsed = new Set();
    rootId = null; deptFilter = '';
    selectedId = null; closeDrawer();
    await persist();
    render();
    toast('Chart cleared (Ctrl+Z to undo)');
  }
});

$('menu-view').querySelector('.menu-pop').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-a]');
  if (!btn) return;
  const a = btn.dataset.a;
  const s = viewSettings();
  if (a === 'toggleDept') { s.showDeptPill = !s.showDeptPill; render(); }
  if (a === 'toggleHeadcount') { s.showHeadcount = !s.showHeadcount; render(); }
  if (a === 'toggleCost') { s.showCost = !s.showCost; render(); }
  if (a === 'rules') { closeAllMenus(); openRulesModal(); }
});

function updateViewTicks() {
  const s = viewSettings();
  $('tick-dept').classList.toggle('off', !s.showDeptPill);
  $('tick-headcount').classList.toggle('off', !s.showHeadcount);
  $('tick-cost').classList.toggle('off', !s.showCost);
}

// ---------- scenarios ----------

function scenarioById(id) { return doc.scenarios.find(s => s.id === id) || null; }

function rebuildScenarioMenu() {
  const pop = $('scenario-pop');
  let html = `<button class="scenario-item ${!activeScenarioId ? 'active' : ''}" data-sc=""><svg class="icon"><use href="#i-logo"/></svg>Live chart</button>`;
  for (const sc of doc.scenarios) {
    html += `<button class="scenario-item ${activeScenarioId === sc.id ? 'active' : ''}" data-sc="${escapeAttr(sc.id)}"><svg class="icon"><use href="#i-layers"/></svg>${escapeHtml(sc.name)}</button>`;
  }
  html += '<div class="menu-sep"></div>';
  html += `<div style="display:flex;gap:6px;padding:4px 6px">
    <input type="text" id="sc-new-name" placeholder="e.g. Q3 reorg" style="flex:1;min-width:0;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:7px 9px;font-size:13px;font-family:inherit">
    <button class="btn small primary" id="sc-create">Draft</button>
  </div>`;
  pop.innerHTML = html;

  pop.querySelectorAll('.scenario-item').forEach(b => {
    b.addEventListener('click', () => { closeAllMenus(); switchScenario(b.dataset.sc || null); });
  });
  pop.querySelector('#sc-create').addEventListener('click', (e) => {
    e.stopPropagation();
    const name = pop.querySelector('#sc-new-name').value.trim() || ('Draft ' + (doc.scenarios.length + 1));
    createScenario(name);
  });
  pop.querySelector('#sc-new-name').addEventListener('click', e => e.stopPropagation());
  pop.querySelector('#sc-new-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') pop.querySelector('#sc-create').click();
  });
}

async function createScenario(name) {
  closeAllMenus();
  syncBack();
  const sc = {
    id: 'sc-' + Date.now().toString(36),
    name,
    createdAt: new Date().toISOString().slice(0, 10),
    people: JSON.parse(JSON.stringify(people)),
    collapsed: [...collapsed],
  };
  doc.scenarios.push(sc);
  await switchScenario(sc.id);
  toast(`Draft "${name}" created — edits here won't touch the live chart`);
}

async function switchScenario(id) {
  syncBack();
  activeScenarioId = id || null;
  const sc = activeScenarioId ? scenarioById(activeScenarioId) : null;
  if (sc) {
    people = sc.people;
    collapsed = new Set(sc.collapsed || []);
  } else {
    activeScenarioId = null;
    people = doc.people;
    collapsed = new Set(doc.settings.collapsed || []);
  }
  selectedId = null; rootId = null; highlightId = null;
  clearHistory();
  closeDrawer();
  await persist();
  render();
}

function scenarioDiff(livePeople, scPeople) {
  const liveBy = new Map(livePeople.map(p => [p.id, p]));
  const scBy = new Map(scPeople.map(p => [p.id, p]));
  let added = 0, removed = 0, changed = 0;
  for (const p of scPeople) {
    const live = liveBy.get(p.id);
    if (!live) { added++; continue; }
    const keys = ['name', 'title', 'department', 'email', 'phone', 'location', 'startDate', 'salary', 'notes', 'managerId', 'dottedManagerId', 'isOpenRole'];
    if (keys.some(k => JSON.stringify(p[k] ?? null) !== JSON.stringify(live[k] ?? null))) changed++;
  }
  for (const p of livePeople) if (!scBy.has(p.id)) removed++;
  return { added, removed, changed };
}

function updateScenarioUI() {
  const sc = activeScenarioId ? scenarioById(activeScenarioId) : null;
  $('scenario-banner').classList.toggle('hidden', !sc);
  if (sc) $('scenario-name').textContent = sc.name;
  $('scenario-btn').classList.toggle('active', !!sc);
}

$('btn-back-live').addEventListener('click', () => switchScenario(null));

$('btn-promote').addEventListener('click', async () => {
  const sc = activeScenarioId ? scenarioById(activeScenarioId) : null;
  if (!sc) return;
  syncBack();
  const d = scenarioDiff(doc.people, sc.people);
  if (!confirm(`Promote "${sc.name}" to the live chart?\n\nCompared to live: ${d.added} added, ${d.removed} removed, ${d.changed} changed.\n\nThe live chart will be replaced (undo history does not cross this).`)) return;
  doc.people = JSON.parse(JSON.stringify(sc.people));
  doc.settings.collapsed = [...(sc.collapsed || [])];
  await switchScenario(null);
  toast(`"${sc.name}" promoted to live`);
});

$('btn-delete-scenario').addEventListener('click', async () => {
  const sc = activeScenarioId ? scenarioById(activeScenarioId) : null;
  if (!sc) return;
  if (!confirm(`Delete draft "${sc.name}"? The live chart is unaffected.`)) return;
  doc.scenarios = doc.scenarios.filter(s => s.id !== sc.id);
  await switchScenario(null);
  toast('Draft deleted');
});

// ---------- conditional formatting modal ----------

let rulesDraft = [];
const RULE_FIELDS = [['name', 'Name'], ['title', 'Title'], ['department', 'Department'], ['email', 'Email'], ['location', 'Location'], ['salary', 'Salary']];
const RULE_OPS = [['contains', 'contains'], ['equals', 'equals'], ['gt', 'is greater than'], ['lt', 'is less than']];

function openRulesModal() {
  rulesDraft = JSON.parse(JSON.stringify(viewSettings().condRules));
  renderRules();
  $('rules-modal').classList.remove('hidden');
}

function renderRules() {
  const list = $('rules-list');
  if (!rulesDraft.length) {
    list.innerHTML = '<div class="rules-empty">No rules yet. Example: Title contains "Manager" → gold.</div>';
    return;
  }
  list.innerHTML = rulesDraft.map((r, i) => `
    <div class="rule-row" data-i="${i}">
      <select data-k="field">${RULE_FIELDS.map(([v, l]) => `<option value="${v}" ${r.field === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <select data-k="op">${RULE_OPS.map(([v, l]) => `<option value="${v}" ${r.op === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <input type="text" data-k="value" value="${escapeAttr(r.value)}" placeholder="value">
      <input type="color" data-k="color" value="${escapeAttr(r.color || '#0b66ff')}">
      <button class="rule-del" title="Remove rule"><svg class="icon"><use href="#i-x"/></svg></button>
    </div>
  `).join('');
}

$('rules-list').addEventListener('input', (e) => {
  const rowEl = e.target.closest('.rule-row');
  if (!rowEl) return;
  const r = rulesDraft[Number(rowEl.dataset.i)];
  const k = e.target.dataset.k;
  if (r && k) r[k] = e.target.value;
});
$('rules-list').addEventListener('click', (e) => {
  const del = e.target.closest('.rule-del');
  if (!del) return;
  rulesDraft.splice(Number(del.closest('.rule-row').dataset.i), 1);
  renderRules();
});
$('btn-add-rule').addEventListener('click', () => {
  rulesDraft.push({ field: 'title', op: 'contains', value: '', color: '#0b66ff' });
  renderRules();
});
$('btn-rules-cancel').addEventListener('click', () => $('rules-modal').classList.add('hidden'));
$('btn-rules-save').addEventListener('click', async () => {
  viewSettings().condRules = rulesDraft.filter(r => String(r.value).trim() !== '');
  $('rules-modal').classList.add('hidden');
  await persist();
  render();
});
$('rules-modal').addEventListener('click', (e) => { if (e.target === $('rules-modal')) $('rules-modal').classList.add('hidden'); });

// ---------- editor modal ----------

const modal = $('modal');
let editingId = null;
let pickedPhoto = '';

function customToText(custom) {
  return Object.entries(custom || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
}
function textToCustom(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*([^:]+):\s*(.*)$/);
    if (m && m[1].trim()) out[m[1].trim()] = m[2].trim();
  }
  return out;
}

function openEditor(id) {
  editingId = id || null;
  const p = editingId ? people.find(x => x.id === editingId) : null;
  $('modal-title').textContent = p ? (p.isOpenRole ? 'Edit Open Role' : 'Edit Person') : 'Add Person';
  $('f-open-role').checked = p ? !!p.isOpenRole : false;
  $('f-name').value = p ? p.name : '';
  $('f-title').value = p ? p.title : '';
  $('f-department').value = p ? p.department : '';
  $('f-email').value = p ? p.email : '';
  $('f-phone').value = p ? p.phone : '';
  $('f-location').value = p ? p.location : '';
  $('f-start').value = p ? p.startDate : '';
  const tzSel = $('f-timezone');
  if (tzSel.options.length <= 1 && Intl.supportedValuesOf) {
    tzSel.innerHTML = '<option value="">— Not set —</option>' + Intl.supportedValuesOf('timeZone')
      .filter(z => /\//.test(z))
      .map(z => `<option value="${escapeAttr(z)}">${escapeHtml(z.replace(/_/g, ' '))}</option>`).join('');
  }
  tzSel.value = p ? (p.timezone || '') : '';
  if (tzSel.selectedIndex === -1) tzSel.value = '';
  $('f-workhours').value = p ? (p.workHours || '') : '';
  $('f-salary').value = p && p.salary != null ? p.salary : '';
  $('f-notes').value = p ? p.notes : '';
  $('f-custom').value = p ? customToText(p.custom) : '';
  pickedPhoto = p ? (p.photo || '') : '';
  $('f-photo').value = pickedPhoto;
  rebuildManagerOptions(editingId);
  $('f-manager').value = p && p.managerId ? p.managerId : '';
  $('f-dotted').value = p && p.dottedManagerId ? p.dottedManagerId : '';
  $('btn-delete').classList.toggle('hidden', !p);
  modal.classList.remove('hidden');
  $('f-name').focus();
}

function closeEditor() {
  modal.classList.add('hidden');
  editingId = null;
}

function wouldCreateCycle(id, managerId) {
  if (!id || !managerId) return false;
  if (id === managerId) return true;
  const byId = new Map(people.map(p => [p.id, p]));
  let cur = byId.get(managerId);
  const seen = new Set();
  while (cur) {
    if (cur.id === id) return true;
    if (seen.has(cur.id)) break;
    seen.add(cur.id);
    cur = cur.managerId ? byId.get(cur.managerId) : null;
  }
  return false;
}

async function savePerson() {
  const isOpenRole = $('f-open-role').checked;
  let name = $('f-name').value.trim();
  if (!name) {
    if (isOpenRole) name = 'Open role';
    else { toast('Name is required (or mark it as an open role)'); return; }
  }
  const managerId = $('f-manager').value || null;
  const dottedManagerId = $('f-dotted').value || null;

  const wasEditing = !!editingId;
  const id = editingId || ('p-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36));

  if (managerId && wouldCreateCycle(id, managerId)) {
    toast('That manager choice would create a reporting cycle — pick someone else.');
    return;
  }

  const salaryRaw = $('f-salary').value.trim();
  const prev = wasEditing ? people.find(p => p.id === editingId) : null;
  const rec = {
    id, name,
    title: $('f-title').value.trim(),
    department: $('f-department').value.trim(),
    email: $('f-email').value.trim(),
    phone: $('f-phone').value.trim(),
    location: $('f-location').value.trim(),
    startDate: $('f-start').value,
    salary: salaryRaw !== '' && !isNaN(Number(salaryRaw)) ? Number(salaryRaw) : null,
    notes: $('f-notes').value.trim(),
    custom: textToCustom($('f-custom').value),
    isOpenRole,
    managerId,
    dottedManagerId: dottedManagerId === id ? null : dottedManagerId,
    photo: pickedPhoto,
    timezone: $('f-timezone').value.trim(),
    workHours: $('f-workhours').value.trim(),
    pinHash: prev ? (prev.pinHash || '') : '',
  };

  pushUndo();
  if (wasEditing) {
    people[people.findIndex(p => p.id === editingId)] = rec;
  } else {
    people.push(rec);
  }

  closeEditor();
  await persist();
  render();
  toast(wasEditing ? 'Saved' : (isOpenRole ? 'Open role added' : 'Person added'));
}

async function deletePerson(id) {
  const p = people.find(x => x.id === id);
  if (!p) return;
  if (!confirm(`Delete ${p.name}? Their direct reports will be reassigned to ${p.managerId ? "their manager" : "no manager (root)"}.`)) return;

  pushUndo();
  for (const child of people) {
    if (child.managerId === id) child.managerId = p.managerId || null;
    if (child.dottedManagerId === id) child.dottedManagerId = null;
  }
  people = people.filter(x => x.id !== id);
  if (rootId === id) rootId = null;
  if (selectedId === id) { selectedId = null; closeDrawer(); }
  collapsed.delete(id);

  closeEditor();
  await persist();
  render();
  toast('Deleted');
}

$('btn-add').addEventListener('click', () => openEditor(null));
$('btn-empty-add').addEventListener('click', () => openEditor(null));
$('btn-cancel').addEventListener('click', closeEditor);
$('btn-save').addEventListener('click', savePerson);
$('btn-delete').addEventListener('click', () => editingId && deletePerson(editingId));
modal.addEventListener('click', (e) => { if (e.target === modal) closeEditor(); });

$('btn-pick-photo').addEventListener('click', async () => {
  const res = await window.orgtree.pickPhoto();
  if (res && res.ok) {
    pickedPhoto = res.path;
    $('f-photo').value = pickedPhoto;
  }
});
$('btn-clear-photo').addEventListener('click', () => {
  pickedPhoto = '';
  $('f-photo').value = '';
});

// ---------- department filter / drill reset ----------

$('dept-filter').addEventListener('change', (e) => {
  deptFilter = e.target.value;
  render();
});

$('btn-reset-view').addEventListener('click', () => {
  rootId = null;
  render();
});

// ---------- search (name, title, department, email, location) ----------

const searchInput = $('search');
let searchMatches = [];
let searchIndex = -1;
let lastQuery = '';

function findMatches(q) {
  const l = q.toLowerCase();
  return people.filter(p =>
    (p.name || '').toLowerCase().includes(l) ||
    (p.title || '').toLowerCase().includes(l) ||
    (p.department || '').toLowerCase().includes(l) ||
    (p.email || '').toLowerCase().includes(l) ||
    (p.location || '').toLowerCase().includes(l)
  );
}

searchInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const q = searchInput.value.trim();
  if (!q) return;
  if (q !== lastQuery) {
    lastQuery = q;
    searchMatches = findMatches(q);
    searchIndex = -1;
  }
  if (!searchMatches.length) { $('search-count').classList.add('hidden'); toast(`No match for "${q}"`); return; }
  searchIndex = (searchIndex + 1) % searchMatches.length;
  const match = searchMatches[searchIndex];
  const counter = $('search-count');
  counter.textContent = `${searchIndex + 1}/${searchMatches.length}`;
  counter.classList.remove('hidden');
  revealPerson(match);
});
searchInput.addEventListener('input', () => {
  lastQuery = '';
  if (!searchInput.value.trim()) {
    highlightId = null;
    $('search-count').classList.add('hidden');
    render();
  }
});

function revealPerson(match) {
  const path = OrgtreeTree.findPath(people, match.id);
  for (const ancestor of path) collapsed.delete(ancestor.id);
  if (deptFilter && match.department !== deptFilter) {
    deptFilter = ''; $('dept-filter').value = '';
  }
  rootId = null;
  highlightId = match.id;
  render();
  scrollToNode(match.id);
  const id = match.id;
  setTimeout(() => { if (highlightId === id) { highlightId = null; render(); } }, 2400);
}

function scrollToNode(id) {
  if (!lastLayout) return;
  const pos = lastLayout.positions.find(p => p.id === id);
  if (!pos) return;
  const targetX = (pos.x - lastLayout.minX + PAD + pos.w / 2) * zoom - chartWrap.clientWidth / 2;
  const targetY = (pos.y + PAD + pos.h / 2) * zoom - chartWrap.clientHeight / 2;
  chartWrap.scrollTo({ left: Math.max(0, targetX), top: Math.max(0, targetY), behavior: 'smooth' });
}

// ---------- CSV/XLSX import: replace or update-in-place ----------

let pendingImport = null; // { people, errors } awaiting the user's choice

async function importRoster() {
  const res = await window.orgtree.importCSV();
  if (!res || res.canceled) return;
  if (!res.ok) { toast('Import failed: ' + res.error); return; }

  if (!people.length) {
    applyReplace(res);
    return;
  }
  pendingImport = res;
  $('import-choice-desc').textContent =
    `You already have ${people.length} ${people.length === 1 ? 'person' : 'people'} on the chart, and the file contains ${res.people.length}.`;
  $('import-choice-modal').classList.remove('hidden');
}

$('btn-import-cancel').addEventListener('click', () => {
  pendingImport = null;
  $('import-choice-modal').classList.add('hidden');
});

$('btn-import-replace').addEventListener('click', () => {
  if (!pendingImport) return;
  const res = pendingImport;
  pendingImport = null;
  $('import-choice-modal').classList.add('hidden');
  applyReplace(res);
});

$('btn-import-update').addEventListener('click', () => {
  if (!pendingImport) return;
  const res = pendingImport;
  pendingImport = null;
  const removeMissing = $('chk-remove-missing').checked;
  $('import-choice-modal').classList.add('hidden');
  applyMerge(res, removeMissing);
});

async function applyReplace(res) {
  pushUndo();
  people = res.people.map(p => ({ ...p, photo: '' }));
  collapsed = new Set();
  rootId = null; deptFilter = '';
  selectedId = null; closeDrawer();
  await persist();
  render();
  showImportSummary({ mode: 'replace', added: people.length, errors: res.errors });
}

/**
 * Update-in-place merge: match imported rows to existing people by email
 * (exact, case-insensitive, unique) first, then by name (case-insensitive,
 * unique). Matched people keep their id, photo, custom fields, and collapsed
 * state; everything else comes from the file. Unmatched rows are added.
 * Existing people not present in the file are kept, or removed if requested.
 */
function mergeRoster(existing, imported, removeMissing) {
  const errors = [];

  const emailIdx = new Map(); const emailDup = new Set();
  const nameIdx = new Map(); const nameDup = new Set();
  for (const p of existing) {
    const e = (p.email || '').trim().toLowerCase();
    if (e) { if (emailIdx.has(e)) emailDup.add(e); else emailIdx.set(e, p); }
    const n = (p.name || '').trim().toLowerCase();
    if (n) { if (nameIdx.has(n)) nameDup.add(n); else nameIdx.set(n, p); }
  }

  const idMap = new Map();          // imported temp id -> final id
  const matchedExisting = new Set();
  const out = [];
  let updated = 0, added = 0;

  for (const imp of imported) {
    let match = null;
    const e = (imp.email || '').trim().toLowerCase();
    if (e && emailIdx.has(e) && !emailDup.has(e)) match = emailIdx.get(e);
    if (!match) {
      const n = imp.name.trim().toLowerCase();
      if (nameIdx.has(n) && !nameDup.has(n)) match = nameIdx.get(n);
    }
    if (match && matchedExisting.has(match.id)) match = null;

    if (match) {
      matchedExisting.add(match.id);
      idMap.set(imp.id, match.id);
      out.push({
        ...imp,
        id: match.id,
        photo: match.photo,
        custom: Object.keys(imp.custom || {}).length ? imp.custom : match.custom,
      });
      updated++;
    } else {
      idMap.set(imp.id, imp.id);
      out.push({ ...imp, photo: '' });
      added++;
    }
  }

  // Remap manager references from import-temp ids to final ids.
  const existingIds = new Set(existing.map(p => p.id));
  for (const p of out) {
    for (const key of ['managerId', 'dottedManagerId']) {
      const v = p[key];
      if (!v) continue;
      if (idMap.has(v)) p[key] = idMap.get(v);
      else if (!existingIds.has(v)) {
        if (key === 'managerId') errors.push({ row: '?', name: p.name, reason: 'manager reference could not be resolved — cleared' });
        p[key] = null;
      }
    }
  }

  // Existing people the file didn't mention.
  const missing = existing.filter(p => !matchedExisting.has(p.id));
  let removed = 0, kept = 0;
  if (removeMissing) {
    removed = missing.length;
    const removedIds = new Set(missing.map(p => p.id));
    for (const p of out) {
      if (p.managerId && removedIds.has(p.managerId)) p.managerId = null;
      if (p.dottedManagerId && removedIds.has(p.dottedManagerId)) p.dottedManagerId = null;
    }
  } else {
    kept = missing.length;
    for (const m of missing) out.push({ ...m });
  }

  return { people: out, updated, added, removed, kept, errors };
}

async function applyMerge(res, removeMissing) {
  pushUndo();
  const result = mergeRoster(people, res.people, removeMissing);
  people = result.people;

  const alive = new Set(people.map(p => p.id));
  collapsed = new Set([...collapsed].filter(id => alive.has(id)));
  if (rootId && !alive.has(rootId)) rootId = null;
  if (selectedId && !alive.has(selectedId)) { selectedId = null; closeDrawer(); }

  await persist();
  render();
  showImportSummary({
    mode: 'merge',
    updated: result.updated, added: result.added,
    removed: result.removed, kept: result.kept,
    errors: [...res.errors, ...result.errors],
  });
}

function showImportSummary(s) {
  const box = $('import-summary');
  let html = '';
  if (s.mode === 'replace') {
    html += `<p>Imported a fresh roster.</p><div class="stat-row"><div class="stat"><b>${s.added}</b>people</div></div>`;
  } else {
    html += '<p>Updated the chart in place — photos, layout and collapsed branches were preserved.</p>';
    html += '<div class="stat-row">';
    html += `<div class="stat"><b>${s.updated}</b>updated</div>`;
    html += `<div class="stat"><b>${s.added}</b>added</div>`;
    if (s.removed) html += `<div class="stat"><b>${s.removed}</b>removed</div>`;
    if (s.kept) html += `<div class="stat"><b>${s.kept}</b>kept (not in file)</div>`;
    html += '</div>';
  }
  const errors = s.errors || [];
  if (errors.length) {
    html += `<p class="warn">${errors.length} row issue${errors.length === 1 ? '' : 's'}:</p><ul class="err-list">`;
    for (const e of errors) html += `<li>Row ${escapeHtml(e.row)} (${escapeHtml(e.name)}): ${escapeHtml(e.reason)}</li>`;
    html += '</ul>';
  } else {
    html += '<p class="ok-msg">No issues found.</p>';
  }
  box.innerHTML = html;
  $('import-modal').classList.remove('hidden');
}
$('btn-import-close').addEventListener('click', () => {
  $('import-modal').classList.add('hidden');
});

// ---------- exports ----------

async function exportPNG() {
  if (!lastLayout) { toast('Nothing to export yet'); return; }
  const dataUrl = canvas.toDataURL('image/png');
  const res = await window.orgtree.exportPNG(dataUrl);
  if (res && res.ok) toast('Exported PNG: ' + res.path);
}

async function exportPDF() {
  if (!lastLayout) { toast('Nothing to export yet'); return; }
  const dataUrl = canvas.toDataURL('image/png');
  const w = parseFloat(canvas.style.width) || canvas.width;
  const h = parseFloat(canvas.style.height) || canvas.height;
  const res = await window.orgtree.exportPDF(dataUrl, w, h);
  if (res && res.ok) toast('Exported PDF: ' + res.path);
  else if (res && res.error) toast('PDF export failed: ' + res.error);
}

// ---------- keyboard ----------

document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
  if ((e.ctrlKey || e.metaKey) && !typing) {
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); return; }
    if (k === 'f') { e.preventDefault(); searchInput.focus(); searchInput.select(); return; }
  }
  if (e.key === 'Escape') {
    if (!$('modal').classList.contains('hidden')) { closeEditor(); return; }
    if (!$('rules-modal').classList.contains('hidden')) { $('rules-modal').classList.add('hidden'); return; }
    if (!$('import-choice-modal').classList.contains('hidden')) { $('btn-import-cancel').click(); return; }
    closeAllMenus();
    if (selectedId) { selectedId = null; closeDrawer(); render(); }
  }
});

// ---------- sample roster ----------

const SAMPLE_ROSTER = [
  // name, title, department, manager, location, salary, openRole
  ['Avery Collins', 'CEO', 'Leadership', '', 'Austin, TX', 260000, false],
  ['Morgan Hayes', 'VP Engineering', 'Engineering', 'Avery Collins', 'Austin, TX', 195000, false],
  ['Riley Bennett', 'VP Sales', 'Sales', 'Avery Collins', 'Chicago, IL', 180000, false],
  ['Quinn Foster', 'Head of Design', 'Design', 'Avery Collins', 'Remote', 165000, false],
  ['Jordan Rivera', 'Engineering Manager', 'Engineering', 'Morgan Hayes', 'Austin, TX', 150000, false],
  ['Casey Nguyen', 'Senior Engineer', 'Engineering', 'Jordan Rivera', 'Remote', 140000, false],
  ['Drew Patel', 'Engineer', 'Engineering', 'Jordan Rivera', 'Austin, TX', 115000, false],
  ['Open role', 'Senior Engineer', 'Engineering', 'Jordan Rivera', 'Remote', 145000, true],
  ['Skyler Brooks', 'QA Lead', 'Engineering', 'Morgan Hayes', 'Denver, CO', 125000, false],
  ['Taylor Kim', 'Account Executive', 'Sales', 'Riley Bennett', 'Chicago, IL', 95000, false],
  ['Jamie Ortiz', 'Account Executive', 'Sales', 'Riley Bennett', 'New York, NY', 95000, false],
  ['Reese Delgado', 'Product Designer', 'Design', 'Quinn Foster', 'Remote', 120000, false],
  ['Harper Singh', 'UX Researcher', 'Design', 'Quinn Foster', 'Remote', 110000, false],
];

async function loadSampleRoster() {
  pushUndo();
  const byName = new Map();
  people = SAMPLE_ROSTER.map(([name, title, department, mgr, location, salary, isOpenRole], i) => {
    const id = 'sample-' + (i + 1);
    if (!isOpenRole) byName.set(name, id);
    return {
      id, name, title, department,
      email: isOpenRole ? '' : name.toLowerCase().replace(/\s+/g, '.') + '@example.com',
      phone: '', location, startDate: '', salary, notes: '', custom: {},
      isOpenRole,
      managerId: mgr ? byName.get(mgr) : null,
      dottedManagerId: null,
      photo: '',
    };
  });
  // one dotted line for the demo: UX Researcher also supports VP Engineering
  const harper = people.find(p => p.name === 'Harper Singh');
  const morgan = people.find(p => p.name === 'Morgan Hayes');
  if (harper && morgan) harper.dottedManagerId = morgan.id;

  collapsed = new Set();
  rootId = null; deptFilter = '';
  await persist();
  render();
  toast('Sample roster loaded — 13 cards, one open role, one dotted line');
}

$('btn-sample').addEventListener('click', loadSampleRoster);

// Hooks for the screenshot/CI harness.
window.__orgtreeSeedSampleIfEmpty = async () => {
  $('wizard-modal').classList.add('hidden');
  if (!people.length) await loadSampleRoster();
};
window.__orgtreeSetTheme = (mode) => applyTheme(mode);
window.__orgtreeSelectFirst = () => {
  if (!lastLayout || !lastLayout.positions.length) return;
  const pos = lastLayout.positions[0];
  selectedId = pos.id;
  openDrawer(pos.id);
  render();
};
window.__orgtreeEditFirst = () => {
  if (people.length) openEditor(people[0].id);
};

// ---------- SMTP settings modal ----------

async function openSmtpModal() {
  const s = await window.orgtree.smtpGet();
  $('smtp-host').value = s.host || '';
  $('smtp-port').value = s.port || 587;
  $('smtp-user').value = s.user || '';
  $('smtp-pass').value = s.pass || '';
  $('smtp-from').value = s.from || '';
  $('smtp-secure').checked = !!s.secure;
  $('smtp-modal').classList.remove('hidden');
}

function readSmtpForm() {
  return {
    host: $('smtp-host').value.trim(),
    port: Number($('smtp-port').value) || 587,
    user: $('smtp-user').value.trim(),
    pass: $('smtp-pass').value,
    from: $('smtp-from').value.trim(),
    secure: $('smtp-secure').checked,
  };
}

$('btn-smtp-cancel').addEventListener('click', () => $('smtp-modal').classList.add('hidden'));
$('smtp-modal').addEventListener('click', (e) => { if (e.target === $('smtp-modal')) $('smtp-modal').classList.add('hidden'); });
$('btn-smtp-save').addEventListener('click', async () => {
  await window.orgtree.smtpSave(readSmtpForm());
  $('smtp-modal').classList.add('hidden');
  toast('Email settings saved');
});
$('btn-smtp-test').addEventListener('click', async () => {
  await window.orgtree.smtpSave(readSmtpForm());
  toast('Testing connection…');
  const res = await window.orgtree.smtpTest();
  toast(res.ok ? 'SMTP connection works ✓' : 'SMTP failed: ' + res.error);
});

// ---------- getting-started wizard ----------

const wiz = { step: 1, company: '', departments: [], employees: [] };

function openWizard() {
  wiz.step = 1;
  wiz.company = viewSettings().companyName || '';
  wiz.departments = [...OrgtreeTree.departmentsOf(people)];
  wiz.employees = [];
  renderWizard();
  $('wizard-modal').classList.remove('hidden');
}

function renderWizard() {
  const body = $('wizard-body');
  $('wizard-step').textContent = wiz.step + ' / 3';
  $('btn-wizard-back').classList.toggle('hidden', wiz.step === 1);
  $('btn-wizard-next').textContent = wiz.step === 3 ? 'Finish — build my chart' : 'Next';

  if (wiz.step === 1) {
    $('wizard-title').textContent = 'Welcome to WholeTeam';
    body.innerHTML = `
      <p class="wizard-desc">Let's set up your company in under a minute. First — what's it called?</p>
      <div class="form">
        <label>Company name
          <input type="text" id="wz-company" placeholder="Acme Manufacturing" maxlength="120" value="${escapeAttr(wiz.company)}">
        </label>
      </div>`;
    $('wz-company').focus();
  } else if (wiz.step === 2) {
    $('wizard-title').textContent = wiz.company ? wiz.company + ' — departments' : 'Departments';
    body.innerHTML = `
      <p class="wizard-desc">Add the departments in the company. Each one gets its own color on the chart and its own chat channel.</p>
      <div class="chat-inline">
        <input type="text" id="wz-dept" placeholder="e.g. Engineering" maxlength="60" style="flex:1;background:var(--bg);border:1px solid var(--border);border-radius:10px;color:var(--text);padding:9px 12px;font-size:14px;font-family:inherit">
        <button class="btn ghost" id="wz-dept-add">Add</button>
      </div>
      <div class="wizard-chips" id="wz-chips"></div>`;
    const renderChips = () => {
      $('wz-chips').innerHTML = wiz.departments.map((d, i) =>
        `<span class="wizard-chip">${escapeHtml(d)}<button data-i="${i}" title="Remove">×</button></span>`).join('') ||
        '<span class="rules-empty">No departments yet — try Engineering, Sales, Operations…</span>';
      $('wz-chips').querySelectorAll('button').forEach(b =>
        b.addEventListener('click', () => { wiz.departments.splice(Number(b.dataset.i), 1); renderChips(); }));
    };
    const add = () => {
      const v = $('wz-dept').value.trim();
      if (v && !wiz.departments.includes(v)) { wiz.departments.push(v); renderChips(); }
      $('wz-dept').value = ''; $('wz-dept').focus();
    };
    $('wz-dept-add').addEventListener('click', add);
    $('wz-dept').addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
    renderChips();
    $('wz-dept').focus();
  } else {
    $('wizard-title').textContent = 'Add your people';
    if (!wiz.employees.length) wiz.employees.push({ name: '', email: '', department: wiz.departments[0] || '', manager: '' });
    body.innerHTML = `
      <p class="wizard-desc">Add employees and assign each to a department and manager. You can fine-tune everything on the chart afterwards — and email each person an invite so they fill in their own details.</p>
      <div id="wz-emps"></div>
      <button class="btn ghost small" id="wz-emp-add"><svg class="icon"><use href="#i-plus"/></svg><span>Add another person</span></button>`;
    const renderRows = () => {
      $('wz-emps').innerHTML = wiz.employees.map((e, i) => `
        <div class="wizard-emp-row" data-i="${i}">
          <input type="text" data-k="name" placeholder="Full name" value="${escapeAttr(e.name)}">
          <input type="email" data-k="email" placeholder="email@company.com" value="${escapeAttr(e.email)}">
          <select data-k="department">
            <option value="">Dept…</option>
            ${wiz.departments.map(d => `<option value="${escapeAttr(d)}" ${e.department === d ? 'selected' : ''}>${escapeHtml(d)}</option>`).join('')}
          </select>
          <select data-k="manager">
            <option value="">Manager…</option>
            ${wiz.employees.filter((x, xi) => xi !== i && x.name.trim()).map(x =>
              `<option value="${escapeAttr(x.name)}" ${e.manager === x.name ? 'selected' : ''}>${escapeHtml(x.name)}</option>`).join('')}
          </select>
          <button class="rule-del" title="Remove"><svg class="icon"><use href="#i-x"/></svg></button>
        </div>`).join('');
      $('wz-emps').querySelectorAll('.wizard-emp-row').forEach(row => {
        const i = Number(row.dataset.i);
        row.querySelectorAll('input, select').forEach(el => {
          el.addEventListener('change', () => { wiz.employees[i][el.dataset.k] = el.value; if (el.dataset.k === 'name') renderRows(); });
          el.addEventListener('input', () => { wiz.employees[i][el.dataset.k] = el.value; });
        });
        row.querySelector('.rule-del').addEventListener('click', () => { wiz.employees.splice(i, 1); renderRows(); });
      });
    };
    $('wz-emp-add').addEventListener('click', () => { wiz.employees.push({ name: '', email: '', department: wiz.departments[0] || '', manager: '' }); renderRows(); });
    renderRows();
  }
}

$('btn-wizard-back').addEventListener('click', () => { if (wiz.step > 1) { wiz.step--; renderWizard(); } });

$('btn-wizard-next').addEventListener('click', async () => {
  if (wiz.step === 1) {
    wiz.company = $('wz-company').value.trim();
    wiz.step = 2; renderWizard(); return;
  }
  if (wiz.step === 2) {
    wiz.step = 3; renderWizard(); return;
  }
  // finish
  const rows = wiz.employees.filter(e => e.name.trim());
  pushUndo();
  viewSettings().companyName = wiz.company;
  viewSettings().onboarded = true;
  if (rows.length) {
    const byName = new Map();
    const created = rows.map((e, i) => {
      const id = 'wz-' + Date.now().toString(36) + '-' + i;
      byName.set(e.name.trim(), id);
      return {
        id, name: e.name.trim(), title: '', department: e.department || '',
        email: e.email.trim(), phone: '', location: '', startDate: '', salary: null,
        notes: '', custom: {}, isOpenRole: false,
        managerId: null, dottedManagerId: null, photo: '',
        timezone: '', workHours: '', pinHash: '',
      };
    });
    for (let i = 0; i < rows.length; i++) {
      const mgr = rows[i].manager && byName.get(rows[i].manager.trim());
      if (mgr && mgr !== created[i].id) created[i].managerId = mgr;
    }
    people.push(...created);
  }
  $('wizard-modal').classList.add('hidden');
  updateDocChip();
  await persist();
  render();
  toast(rows.length
    ? `${wiz.company || 'Company'} set up — ${rows.length} people added. Select someone and hit Invite to email them.`
    : `${wiz.company || 'Company'} set up`);
});

$('btn-wizard-skip').addEventListener('click', async () => {
  viewSettings().onboarded = true;
  $('wizard-modal').classList.add('hidden');
  await persist();
});

// ---------- toast ----------

let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2800);
}

// ---------- boot ----------

(async function init() {
  const edition = window.orgtree.getEdition ? await window.orgtree.getEdition() : 'admin';
  if (edition === 'member') {
    // Member edition: chat, library, time clock and profile only — no chart
    // editing, no hosting, no admin surfaces. chat.js opens the panel itself.
    document.body.classList.add('member');
    $('member-hero').classList.remove('hidden');
    emptyEl.classList.add('hidden');
    return;
  }
  await loadAll();
  setZoom(1, { silent: true });
  render();
  // First run: walk through company name -> departments -> employees.
  if (!doc.settings.onboarded && !people.length && !window.__orgtreeQA) {
    openWizard();
  }
})();
