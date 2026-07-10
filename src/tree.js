/**
 * Orgtree — pure tree engine.
 * No Electron, no I/O. Everything takes plain data in and returns plain data out,
 * so it can be unit-tested hard from Node.
 *
 * Data shape (flat roster, as stored):
 *   person = { id, name, title, department, managerId, email, photo }
 *   managerId is null/'' for a root (no manager) person.
 *
 * Tree node shape (as produced by buildTree):
 *   node = { ...person, children: [node, ...] }
 */

'use strict';

/**
 * Detect broken manager chains: cycles (A -> B -> A) and references to a
 * manager id that doesn't exist in the roster. Never infinite-loops, even
 * on a fully cyclic roster, because it caps chain walk length at roster size.
 *
 * Returns an array of problems: { id, name, reason }
 *   reason: 'cycle' | 'missing-manager'
 */
function detectCycles(people) {
  const byId = new Map(people.map(p => [p.id, p]));
  const problems = [];

  for (const p of people) {
    if (!p.managerId) continue;

    if (!byId.has(p.managerId)) {
      problems.push({ id: p.id, name: p.name, reason: 'missing-manager' });
      continue;
    }

    // Walk the manager chain from p. If we ever land back on p.id, it's a
    // cycle. Cap the walk at people.length + 1 steps so a fully-cyclic
    // roster can never spin forever.
    const seen = new Set([p.id]);
    let cur = byId.get(p.managerId);
    let steps = 0;
    let isCycle = false;
    while (cur && steps <= people.length) {
      if (seen.has(cur.id)) { isCycle = true; break; }
      seen.add(cur.id);
      if (!cur.managerId) break;
      cur = byId.get(cur.managerId);
      steps++;
    }
    if (isCycle) problems.push({ id: p.id, name: p.name, reason: 'cycle' });
  }

  return problems;
}

/**
 * Build a forest of tree nodes from a flat roster. People whose managerId
 * is missing/cyclic are treated as roots (so the tree always renders instead
 * of silently dropping people). Returns an array of root nodes.
 */
function buildTree(people) {
  const broken = new Set(detectCycles(people).map(p => p.id));
  const nodes = new Map(people.map(p => [p.id, { ...p, children: [] }]));
  const roots = [];

  for (const p of people) {
    const node = nodes.get(p.id);
    const hasManager = p.managerId && nodes.has(p.managerId) && !broken.has(p.id);
    if (hasManager) {
      nodes.get(p.managerId).children.push(node);
    } else {
      roots.push(node);
    }
  }

  // Stable ordering: by name within each sibling group.
  const sortChildren = (n) => {
    n.children.sort((a, b) => a.name.localeCompare(b.name));
    n.children.forEach(sortChildren);
  };
  roots.sort((a, b) => a.name.localeCompare(b.name));
  roots.forEach(sortChildren);

  return roots;
}

/** Depth of a person in the org (root = 0). -1 if id not found. Cycle-safe. */
function depthOf(people, id) {
  const byId = new Map(people.map(p => [p.id, p]));
  if (!byId.has(id)) return -1;
  const broken = new Set(detectCycles(people).map(p => p.id));

  let depth = 0;
  let cur = byId.get(id);
  const seen = new Set([cur.id]);
  while (cur && cur.managerId && byId.has(cur.managerId) && !broken.has(cur.id)) {
    cur = byId.get(cur.managerId);
    if (seen.has(cur.id)) break; // safety net, shouldn't hit given broken-set filter
    seen.add(cur.id);
    depth++;
  }
  return depth;
}

/**
 * Ancestor chain from the forest root down to (and including) `id`.
 * Returns an array of plain person objects (no children key), root-first.
 * Empty array if id not found.
 */
function findPath(people, id) {
  const byId = new Map(people.map(p => [p.id, p]));
  if (!byId.has(id)) return [];
  const broken = new Set(detectCycles(people).map(p => p.id));

  const chain = [];
  let cur = byId.get(id);
  const seen = new Set();
  while (cur) {
    if (seen.has(cur.id)) break; // cycle guard
    seen.add(cur.id);
    chain.push(cur);
    if (!cur.managerId || !byId.has(cur.managerId) || broken.has(cur.id)) break;
    cur = byId.get(cur.managerId);
  }
  chain.reverse();
  return chain;
}

/**
 * Return a NEW forest containing only nodes in `dept` and their ancestors
 * (so the reporting line to a matching node is preserved). Non-matching
 * leaf branches are pruned entirely. `dept` === null/'' returns tree unchanged
 * (deep-cloned).
 */
function filterByDepartment(tree, dept) {
  if (!dept) return cloneForest(tree);

  const filterNode = (node) => {
    const children = node.children.map(filterNode).filter(Boolean);
    const matches = node.department === dept;
    if (!matches && children.length === 0) return null;
    return { ...node, children };
  };

  return tree.map(filterNode).filter(Boolean);
}

function cloneForest(tree) {
  const cloneNode = (n) => ({ ...n, children: n.children.map(cloneNode) });
  return tree.map(cloneNode);
}

/** Find a node anywhere in a forest by id. Returns the node or null. */
function findNode(tree, id) {
  for (const n of tree) {
    if (n.id === id) return n;
    const found = findNode(n.children, id);
    if (found) return found;
  }
  return null;
}

/** All distinct, non-empty department names present in the roster, sorted. */
function departmentsOf(people) {
  return [...new Set(people.map(p => p.department).filter(Boolean))].sort();
}

const OrgtreeTree = {
  buildTree,
  detectCycles,
  depthOf,
  findPath,
  filterByDepartment,
  findNode,
  departmentsOf,
};

/* Works as a CommonJS module (main process, tests) and as a plain
   <script> in the sandboxed renderer (attaches to window). */
if (typeof module !== 'undefined' && module.exports) module.exports = OrgtreeTree;
if (typeof window !== 'undefined') window.OrgtreeTree = OrgtreeTree;
