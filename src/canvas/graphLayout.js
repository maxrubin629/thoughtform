import { clamp } from "./geometry.js";
import { BASE_WIDTH } from "./viewport.js";

export function linkEnds(link) {
  return { a: link.a ?? link.from, b: link.b ?? link.to };
}

export function getFocusIds(focusId, edges) {
  if (!focusId) return null;
  const children = new Map();
  const parent = new Map();
  for (const { from, to } of edges) {
    if (!children.has(from)) children.set(from, []);
    children.get(from).push(to);
    if (!parent.has(to)) parent.set(to, from);
  }
  const included = new Set([focusId]);
  const pending = [focusId];
  for (const id of pending) {
    for (const child of children.get(id) ?? []) {
      if (included.has(child)) continue;
      included.add(child);
      pending.push(child);
    }
  }
  const ancestors = new Set();
  for (let id = focusId; id && !ancestors.has(id); id = parent.get(id)) {
    ancestors.add(id);
    included.add(id);
  }
  return included;
}

export function layoutHierarchy(nodes, edges) {
  const committed = nodes.filter((node) => !node.ghost);
  const byDepth = new Map();
  committed.forEach((node) => {
    const depth = clamp(node.depth ?? 0, 0, 4);
    byDepth.set(depth, [...(byDepth.get(depth) ?? []), node]);
  });
  const positions = new Map();
  byDepth.forEach((items, depth) => {
    const top = depth === 0 ? 300 : 175;
    const bottom = depth === 0 ? 720 : 805;
    const step = items.length <= 1 ? 0 : (bottom - top) / (items.length - 1);
    items.forEach((node, index) => {
      positions.set(node.id, {
        x: depth === 0 ? 285 : 430 + depth * 225,
        y: items.length === 1 ? (top + bottom) / 2 : top + index * step,
      });
    });
  });
  return nodes.map((node) => {
    if (!node.ghost) return { ...node, ...(positions.get(node.id) ?? {}) };
    const incoming = edges.find((edge) => edge.to === node.id);
    const parent = positions.get(incoming?.from);
    const parentNode = nodes.find((candidate) => candidate.id === incoming?.from);
    if (!parent || !parentNode) return node;
    const siblings = nodes.filter((candidate) => (
      candidate.ghost && edges.some((edge) => edge.from === parentNode.id && edge.to === candidate.id)
    ));
    const siblingIndex = Math.max(siblings.findIndex((candidate) => candidate.id === node.id), 0);
    const siblingOffset = (siblingIndex - (siblings.length - 1) / 2) * (node.r * 1.7 + 22);
    return {
      ...node,
      x: clamp(parent.x + parentNode.r + node.r + 48, node.r + 20, BASE_WIDTH - node.r - 20),
      y: clamp(parent.y + siblingOffset, 175 + node.r, 805 - node.r),
    };
  });
}
