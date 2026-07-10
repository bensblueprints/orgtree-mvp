'use strict';

/* global OrgtreeTree, OrgtreeCSV, OrgtreeLayout */

// ---------- state ----------

let people = [];
let collapsed = new Set();
let rootId = null;      // drill-down root person id, or null for full tree
let deptFilter = '';    // '' = all departments
let selectedId = null;  // node under the floating toolbar
let highlightId = null; // search-highlighted node (fades after a beat)
let deptColorMap = new Map();

const canvas = document.getElementById('chart');
const ctx = canvas.getContext('2d');
const chartWrap = document.getElementById('chart-wrap');
const emptyEl = document.getElementById('empty');

let lastLayout = null;
const photoCache = new Map(); // path -> HTMLImageElement | 'error'

// ---------- persistence ----------

async function loadAll() {
  const data = await window.orgtree.loadData();
  people = data.people || [];
  collapsed = new Set((data.settings && data.settings.collapsed) || []);
}

async function persist() {
  await window.orgtree.saveData({
    schema: 1, app: 'orgtree',
    people,
    settings: { collapsed: [...collapsed] },
  });
}

// ---------- department colors ----------

const PALETTE = [
  '#22c55e', '#38bdf8', '#f97316', '#a78bfa', '#f43f5e',
  '#eab308', '#14b8a6', '#ec4899', '#84cc16', '#6366f1',
  '#fb923c', '#2dd4bf',
];

function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function colorFor(dept) {
  if (!dept) return '#5b6b85';
  if (!deptColorMap.has(dept)) {
    deptColorMap.set(dept, PALETTE[hashStr(dept) % PALETTE.length]);
  }
  return deptColorMap.get(dept);
}

function rebuildLegend() {
  const legend = document.getElementById('legend');
  const depts = OrgtreeTree.departmentsOf(people);
  if (!depts.length) { legend.innerHTML = ''; legend.classList.add('hidden'); return; }
  legend.classList.remove('hidden');
  legend.innerHTML = '<div class="legend-title">Departments</div>' + depts.map(d =>
    `<div class="legend-row"><span class="dot" style="background:${colorFor(d)}"></span>${escapeHtml(d)}</div>`
  ).join('');
}

// ---------- dept filter + manager dropdown ----------

function rebuildDeptFilterOptions() {
  const sel = document.getElementById('dept-filter');
  const depts = OrgtreeTree.departmentsOf(people);
  const cur = sel.value;
  sel.innerHTML = '<option value="">All departments</option>' +
    depts.map(d => `<option value="${escapeAttr(d)}">${escapeHtml(d)}</option>`).join('');
  sel.value = depts.includes(cur) ? cur : '';
  deptFilter = sel.value;

  const dl = document.getElementById('dept-list');
  dl.innerHTML = depts.map(d => `<option value="${escapeAttr(d)}">`).join('');
}

function rebuildManagerOptions(excludeId) {
  const sel = document.getElementById('f-manager');
  const problems = new Set(OrgtreeTree.detectCycles(people).map(p => p.id));
  const options = people
    .filter(p => p.id !== excludeId)
    .sort((a, b) => a.name.localeCompare(b.name));
  sel.innerHTML = '<option value="">— No manager (root) —</option>' +
    options.map(p => `<option value="${escapeAttr(p.id)}">${escapeHtml(p.name)}${problems.has(p.id) ? ' ⚠' : ''}${p.title ? ' — ' + escapeHtml(p.title) : ''}</option>`).join('');
}

// ---------- HTML escaping ----------

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

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

function render() {
  rebuildLegend();
  rebuildDeptFilterOptions();

  const resetBtn = document.getElementById('btn-reset-view');
  resetBtn.classList.toggle('active', !!rootId);
  resetBtn.textContent = rootId ? '← Full tree' : 'Full tree';

  if (!people.length) {
    emptyEl.classList.remove('hidden');
    canvas.width = 0; canvas.height = 0;
    lastLayout = null;
    persist();
    return;
  }
  emptyEl.classList.add('hidden');

  const roots = currentRoots();
  const layout = OrgtreeLayout.layoutTree(roots, collapsed);
  lastLayout = layout;

  const PAD = 60;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(200, layout.width) + PAD * 2;
  const h = Math.max(160, layout.height) + PAD * 2;

  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.translate(-layout.minX + PAD, PAD);

  drawTree(layout);
  persist();
}

function drawTree(layout) {
  ctx.clearRect(layout.minX - 60, -60, layout.width + 120, layout.height + 120);

  // edges first (under nodes)
  ctx.strokeStyle = '#324258';
  ctx.lineWidth = 1.6;
  for (const e of layout.edges) {
    const midY = (e.y1 + e.y2) / 2;
    ctx.beginPath();
    ctx.moveTo(e.x1, e.y1);
    ctx.lineTo(e.x1, midY);
    ctx.lineTo(e.x2, midY);
    ctx.lineTo(e.x2, e.y2);
    ctx.stroke();
  }

  for (const pos of layout.positions) {
    drawNode(pos);
  }
}

function drawNode(pos) {
  const p = pos.node;
  const color = colorFor(p.department);
  const dimmed = false; // structural filter already prunes; kept for future dim mode
  const isSelected = p.id === selectedId;
  const isHighlight = p.id === highlightId;

  ctx.save();
  ctx.globalAlpha = dimmed ? 0.35 : 1;

  // card background
  roundRect(ctx, pos.x, pos.y, pos.w, pos.h, 12);
  ctx.fillStyle = '#151d2a';
  ctx.fill();
  ctx.lineWidth = isHighlight ? 3 : (isSelected ? 2.4 : 1.4);
  ctx.strokeStyle = isHighlight ? '#facc15' : (isSelected ? '#e8eef7' : '#223047');
  ctx.stroke();

  // department color bar (left edge)
  roundRectLeftBar(ctx, pos.x, pos.y, pos.h, color);

  // avatar
  const av = 40;
  const avX = pos.x + 14;
  const avY = pos.y + (pos.h - av) / 2;
  drawAvatar(p, avX, avY, av, color);

  // text
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#e8eef7';
  ctx.font = '600 14px "Segoe UI", system-ui, sans-serif';
  clipText(ctx, p.name || '(no name)', avX + av + 12, pos.y + 28, pos.w - av - 34);

  ctx.fillStyle = '#8b9bb4';
  ctx.font = '400 12px "Segoe UI", system-ui, sans-serif';
  clipText(ctx, p.title || '', avX + av + 12, pos.y + 46, pos.w - av - 34);

  ctx.fillStyle = color;
  ctx.font = '600 11px "Segoe UI", system-ui, sans-serif';
  clipText(ctx, p.department || '', avX + av + 12, pos.y + 62, pos.w - av - 34);

  ctx.restore();

  // collapse/expand badge
  if (pos.hasChildren) {
    const bx = pos.x + pos.w / 2;
    const by = pos.y + pos.h;
    ctx.beginPath();
    ctx.arc(bx, by, 10, 0, Math.PI * 2);
    ctx.fillStyle = '#1a2434';
    ctx.fill();
    ctx.strokeStyle = '#324258';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.fillStyle = '#e8eef7';
    ctx.font = '700 12px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(pos.collapsed ? '+' : '−', bx, by + 1);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }
}

function drawAvatar(p, x, y, size, color) {
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
  ctx.globalAlpha = 0.22;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = color;
  ctx.font = '700 15px "Segoe UI", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(initials(p.name), x + size / 2, y + size / 2 + 1);
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
  img.src = 'file:///' + filePath.replace(/\\/g, '/').replace(/^\/+/, '');
  return null;
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

function roundRectLeftBar(c, x, y, h, color) {
  c.save();
  c.beginPath();
  c.moveTo(x + 12, y);
  c.arcTo(x, y, x, y + 12, 12);
  c.lineTo(x, y + h - 12);
  c.arcTo(x, y + h, x + 12, y + h, 12);
  c.lineTo(x + 4, y + h);
  c.lineTo(x + 4, y);
  c.closePath();
  c.fillStyle = color;
  c.fill();
  c.restore();
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

function hitTest(clientX, clientY) {
  if (!lastLayout) return null;
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / (window.devicePixelRatio || 1) / rect.width;
  const scaleY = canvas.height / (window.devicePixelRatio || 1) / rect.height;
  const dpr = window.devicePixelRatio || 1;
  const PAD = 60;
  const localX = (clientX - rect.left) * scaleX - PAD + lastLayout.minX;
  const localY = (clientY - rect.top) * scaleY - PAD;

  for (const pos of lastLayout.positions) {
    if (pos.hasChildren) {
      const bx = pos.x + pos.w / 2, by = pos.y + pos.h;
      const dx = localX - bx, dy = localY - by;
      if (dx * dx + dy * dy <= 12 * 12) return { type: 'badge', pos };
    }
    if (localX >= pos.x && localX <= pos.x + pos.w && localY >= pos.y && localY <= pos.y + pos.h) {
      return { type: 'node', pos };
    }
  }
  return null;
}

canvas.addEventListener('click', (e) => {
  const hit = hitTest(e.clientX, e.clientY);
  if (!hit) { selectedId = null; positionToolbar(null); render(); return; }
  if (hit.type === 'badge') {
    toggleCollapse(hit.pos.id);
    return;
  }
  selectedId = hit.pos.id;
  positionToolbar(hit.pos);
  render();
});

canvas.addEventListener('dblclick', (e) => {
  const hit = hitTest(e.clientX, e.clientY);
  if (hit && hit.type === 'node') openEditor(hit.pos.node.id);
});

function toggleCollapse(id) {
  if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
  render();
}

// ---------- floating node toolbar ----------

let toolbarEl = null;
function ensureToolbar() {
  if (toolbarEl) return toolbarEl;
  toolbarEl = document.createElement('div');
  toolbarEl.className = 'node-toolbar hidden';
  toolbarEl.innerHTML = `
    <button data-a="edit">Edit</button>
    <button data-a="drill">Drill down</button>
    <button data-a="delete" class="danger">Delete</button>
  `;
  toolbarEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn || !selectedId) return;
    const action = btn.dataset.a;
    if (action === 'edit') openEditor(selectedId);
    if (action === 'drill') { rootId = selectedId; selectedId = null; positionToolbar(null); render(); }
    if (action === 'delete') deletePerson(selectedId);
  });
  chartWrap.appendChild(toolbarEl);
  return toolbarEl;
}

function positionToolbar(pos) {
  const bar = ensureToolbar();
  if (!pos) { bar.classList.add('hidden'); return; }
  const PAD = 60;
  bar.style.left = (pos.x - lastLayout.minX + PAD + pos.w / 2) + 'px';
  bar.style.top = (pos.y + PAD - 40) + 'px';
  bar.classList.remove('hidden');
}

// ---------- editor modal ----------

const modal = document.getElementById('modal');
let editingId = null;
let pickedPhoto = '';

function openEditor(id) {
  editingId = id || null;
  const p = editingId ? people.find(x => x.id === editingId) : null;
  document.getElementById('modal-title').textContent = p ? 'Edit Person' : 'Add Person';
  document.getElementById('f-name').value = p ? p.name : '';
  document.getElementById('f-title').value = p ? p.title : '';
  document.getElementById('f-department').value = p ? p.department : '';
  document.getElementById('f-email').value = p ? p.email : '';
  pickedPhoto = p ? (p.photo || '') : '';
  document.getElementById('f-photo').value = pickedPhoto;
  rebuildManagerOptions(editingId);
  document.getElementById('f-manager').value = p && p.managerId ? p.managerId : '';
  document.getElementById('btn-delete').classList.toggle('hidden', !p);
  modal.classList.remove('hidden');
  document.getElementById('f-name').focus();
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
  const name = document.getElementById('f-name').value.trim();
  if (!name) { toast('Name is required'); return; }
  const title = document.getElementById('f-title').value.trim();
  const department = document.getElementById('f-department').value.trim();
  const email = document.getElementById('f-email').value.trim();
  let managerId = document.getElementById('f-manager').value || null;

  const id = editingId || ('p-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36));

  if (managerId && wouldCreateCycle(id, managerId)) {
    toast('That manager choice would create a reporting cycle — pick someone else.');
    return;
  }

  const rec = { id, name, title, department, email, managerId, photo: pickedPhoto };

  if (editingId) {
    const idx = people.findIndex(p => p.id === editingId);
    people[idx] = rec;
  } else {
    people.push(rec);
  }

  closeEditor();
  await persist();
  render();
  toast(editingId ? 'Saved' : 'Person added');
}

async function deletePerson(id) {
  const p = people.find(x => x.id === id);
  if (!p) return;
  if (!confirm(`Delete ${p.name}? Their direct reports will be reassigned to ${p.managerId ? "their manager" : "no manager (root)"}.`)) return;

  for (const child of people) {
    if (child.managerId === id) child.managerId = p.managerId || null;
  }
  people = people.filter(x => x.id !== id);
  if (rootId === id) rootId = null;
  if (selectedId === id) { selectedId = null; positionToolbar(null); }
  collapsed.delete(id);

  closeEditor();
  await persist();
  render();
  toast('Deleted');
}

document.getElementById('btn-add').addEventListener('click', () => openEditor(null));
document.getElementById('btn-cancel').addEventListener('click', closeEditor);
document.getElementById('btn-save').addEventListener('click', savePerson);
document.getElementById('btn-delete').addEventListener('click', () => editingId && deletePerson(editingId));
modal.addEventListener('click', (e) => { if (e.target === modal) closeEditor(); });

document.getElementById('btn-pick-photo').addEventListener('click', async () => {
  const res = await window.orgtree.pickPhoto();
  if (res && res.ok) {
    pickedPhoto = res.path;
    document.getElementById('f-photo').value = pickedPhoto;
  }
});
document.getElementById('btn-clear-photo').addEventListener('click', () => {
  pickedPhoto = '';
  document.getElementById('f-photo').value = '';
});

// ---------- department filter / drill reset ----------

document.getElementById('dept-filter').addEventListener('change', (e) => {
  deptFilter = e.target.value;
  selectedId = null;
  positionToolbar(null);
  render();
});

document.getElementById('btn-reset-view').addEventListener('click', () => {
  rootId = null;
  selectedId = null;
  positionToolbar(null);
  render();
});

// ---------- search ----------

const searchInput = document.getElementById('search');
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') runSearch(searchInput.value.trim());
});
searchInput.addEventListener('input', () => {
  if (!searchInput.value.trim()) { highlightId = null; render(); }
});

function runSearch(q) {
  if (!q) return;
  const lower = q.toLowerCase();
  const match = people.find(p => p.name.toLowerCase().includes(lower));
  if (!match) { toast(`No match for "${q}"`); return; }

  // Make sure the match's ancestor chain is expanded and visible, and clear
  // any department filter / drill-down that would hide it.
  const path = OrgtreeTree.findPath(people, match.id);
  for (const ancestor of path) collapsed.delete(ancestor.id);
  if (deptFilter && match.department !== deptFilter) {
    deptFilter = ''; document.getElementById('dept-filter').value = '';
  }
  rootId = null;

  highlightId = match.id;
  render();
  scrollToNode(match.id);
  setTimeout(() => { if (highlightId === match.id) { highlightId = null; render(); } }, 2400);
}

function scrollToNode(id) {
  if (!lastLayout) return;
  const pos = lastLayout.positions.find(p => p.id === id);
  if (!pos) return;
  const PAD = 60;
  const targetX = pos.x - lastLayout.minX + PAD - chartWrap.clientWidth / 2 + pos.w / 2;
  const targetY = pos.y + PAD - chartWrap.clientHeight / 2 + pos.h / 2;
  chartWrap.scrollTo({ left: Math.max(0, targetX), top: Math.max(0, targetY), behavior: 'smooth' });
}

// ---------- CSV import/export ----------

document.getElementById('btn-import-csv').addEventListener('click', async () => {
  const res = await window.orgtree.importCSV();
  if (!res || res.canceled) return;
  if (!res.ok) { toast('Import failed: ' + res.error); return; }

  // Newly imported people replace the current roster (bulk-load), per spec.
  people = res.people.map(p => ({
    id: p.id, name: p.name, title: p.title, department: p.department,
    email: p.email, managerId: p.managerId, photo: '',
  }));
  collapsed = new Set();
  rootId = null; deptFilter = '';
  await persist();
  render();
  showImportSummary(people.length, res.errors);
});

function showImportSummary(count, errors) {
  const box = document.getElementById('import-summary');
  let html = `<p>Imported <b>${count}</b> ${count === 1 ? 'person' : 'people'}.</p>`;
  if (errors && errors.length) {
    html += `<p class="warn">${errors.length} row issue${errors.length === 1 ? '' : 's'}:</p><ul class="err-list">`;
    for (const e of errors) html += `<li>Row ${e.row} (${escapeHtml(e.name)}): ${escapeHtml(e.reason)}</li>`;
    html += '</ul>';
  } else {
    html += '<p class="ok-msg">No issues found.</p>';
  }
  box.innerHTML = html;
  document.getElementById('import-modal').classList.remove('hidden');
}
document.getElementById('btn-import-close').addEventListener('click', () => {
  document.getElementById('import-modal').classList.add('hidden');
});

document.getElementById('btn-export-csv').addEventListener('click', async () => {
  const res = await window.orgtree.exportCSV();
  if (res && res.ok) toast('Exported CSV: ' + res.path);
});

document.getElementById('btn-export-png').addEventListener('click', async () => {
  if (!lastLayout) { toast('Nothing to export yet'); return; }
  const dataUrl = canvas.toDataURL('image/png');
  const res = await window.orgtree.exportPNG(dataUrl);
  if (res && res.ok) toast('Exported PNG: ' + res.path);
});

// ---------- toast ----------

let toastTimer = null;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2800);
}

// ---------- boot ----------

(async function init() {
  await loadAll();
  render();
})();
