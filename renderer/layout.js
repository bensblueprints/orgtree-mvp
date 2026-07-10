'use strict';

/**
 * Orgtree — recursive tree layout for the canvas renderer.
 * No dependency on d3-hierarchy: computes subtree widths bottom-up, then
 * positions children left-to-right centered under their parent.
 *
 * Pure function of (tree, collapsedSet) -> { positions, edges, width, height }.
 * `tree` is the array of root nodes as returned by OrgtreeTree.buildTree
 * (each node has .id, .children, plus person fields).
 */
(function () {
  const NODE_W = 200;
  const NODE_H = 78;
  const H_GAP = 36;
  const V_GAP = 76;
  const ROOT_GAP = H_GAP * 2;

  function layoutTree(roots, collapsedSet) {
    collapsedSet = collapsedSet || new Set();
    const widthCache = new Map();

    function visibleChildren(node) {
      return collapsedSet.has(node.id) ? [] : node.children;
    }

    function subtreeWidth(node) {
      if (widthCache.has(node.id)) return widthCache.get(node.id);
      const children = visibleChildren(node);
      let w;
      if (!children.length) {
        w = NODE_W;
      } else {
        const sum = children.reduce((acc, c) => acc + subtreeWidth(c), 0) + H_GAP * (children.length - 1);
        w = Math.max(NODE_W, sum);
      }
      widthCache.set(node.id, w);
      return w;
    }

    const positions = [];
    const edges = [];

    function place(node, x, depth) {
      const w = subtreeWidth(node);
      const cx = x + w / 2;
      const y = depth * (NODE_H + V_GAP);
      const pos = {
        id: node.id, node, depth,
        x: cx - NODE_W / 2, y,
        w: NODE_W, h: NODE_H,
        cx, cy: y + NODE_H / 2,
        hasChildren: node.children.length > 0,
        collapsed: collapsedSet.has(node.id),
      };
      positions.push(pos);

      const children = visibleChildren(node);
      if (children.length) {
        let cursor = x;
        for (const c of children) {
          const cw = subtreeWidth(c);
          place(c, cursor, depth + 1);
          const childPos = positions[positions.length - 1];
          edges.push({
            fromId: node.id, toId: c.id,
            x1: cx, y1: y + NODE_H,
            x2: childPos.cx, y2: childPos.y,
          });
          cursor += cw + H_GAP;
        }
      }
    }

    let cursor = 0;
    for (const root of roots) {
      const w = subtreeWidth(root);
      place(root, cursor, 0);
      cursor += w + ROOT_GAP;
    }

    const maxX = positions.length ? Math.max(...positions.map(p => p.x + p.w)) : 0;
    const minX = positions.length ? Math.min(...positions.map(p => p.x)) : 0;
    const maxY = positions.length ? Math.max(...positions.map(p => p.y + p.h)) : 0;

    return {
      positions, edges,
      width: maxX - minX,
      height: maxY,
      minX,
      NODE_W, NODE_H, H_GAP, V_GAP,
    };
  }

  window.OrgtreeLayout = { layoutTree, NODE_W, NODE_H, H_GAP, V_GAP };
})();
