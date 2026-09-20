export function canConnect(sourceId, targetId, nodes, edges) {
  if (!sourceId || !targetId || sourceId === targetId) return false;
  const source = nodes.find((node) => node.id === sourceId);
  const target = nodes.find((node) => node.id === targetId);
  return Boolean(source && target && !source.ghost && !target.ghost
    && !edges.some((edge) => !edge.ghost && (
      (edge.from === sourceId && edge.to === targetId)
      || (edge.from === targetId && edge.to === sourceId)
    )));
}

export function connectionTargetAt(point, sourceId, nodes, edges, tolerance = 0) {
  // A direct hit on an invalid lobe must not snap through it to a nearby target.
  const direct = [...nodes].reverse().find((node) => Math.hypot(point.x - node.x, point.y - node.y) <= node.r);
  if (direct) return canConnect(sourceId, direct.id, nodes, edges) ? direct : null;
  return nodes.filter((node) => canConnect(sourceId, node.id, nodes, edges))
    .map((node) => ({ node, gap: Math.hypot(point.x - node.x, point.y - node.y) - node.r }))
    .filter(({ gap }) => gap <= tolerance)
    .sort((a, b) => a.gap - b.gap)[0]?.node ?? null;
}

export function connectionBud(node, nodes, transform, viewport) {
  const { scale, offsetX, offsetY } = transform;
  const center = { x: offsetX + node.x * scale, y: offsetY + node.y * scale };
  const distance = node.r * scale + 28;
  const candidates = [-0.45, 0.45, -1.2, 1.2, Math.PI, -2.3, 2.3].map((angle) => {
    const x = center.x + Math.cos(angle) * distance;
    const y = center.y + Math.sin(angle) * distance;
    const clearance = Math.min(x - 22, viewport.width - x - 22, y - 22, viewport.height - y - 22,
      ...nodes.filter((other) => other.id !== node.id).map((other) => (
        Math.hypot(x - offsetX - other.x * scale, y - offsetY - other.y * scale) - other.r * scale - 24
      )));
    return { x, y, angle, clearance };
  });
  return candidates.find((candidate) => candidate.clearance >= 0)
    ?? candidates.sort((a, b) => b.clearance - a.clearance)[0];
}

export function connectionPreviewPath(source, end, scale) {
  const dx = end.x - source.x;
  const dy = end.y - source.y;
  const distance = Math.hypot(dx, dy);
  if (distance <= source.r) return "";
  const ux = dx / distance;
  const uy = dy / distance;
  const halfBase = Math.min(source.r * 0.3, 13 / scale);
  const start = Math.sqrt(source.r ** 2 - halfBase ** 2) - 1 / scale;
  const head = 4 / scale;
  const point = (along, across) => `${source.x + ux * along - uy * across},${source.y + uy * along + ux * across}`;
  const span = distance - start;
  return `M${point(start, halfBase)} C${point(start + span * 0.4, halfBase * 0.25)} ${point(distance - span * 0.25, head)} ${point(distance, head)} Q${point(distance + head * 2, 0)} ${point(distance, -head)} C${point(distance - span * 0.25, -head)} ${point(start + span * 0.4, -halfBase * 0.25)} ${point(start, -halfBase)} Z`;
}
