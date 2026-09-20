// The polygon and circle use canvas world coordinates, independent of zoom/pan.
export function lassoIntersectsNode(points, node) {
  if (points.length < 3) return false;
  const radius = node.r;
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[j];
    const b = points[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared ? Math.max(0, Math.min(1, ((node.x - a.x) * dx + (node.y - a.y) * dy) / lengthSquared)) : 0;
    if (Math.hypot(node.x - a.x - t * dx, node.y - a.y - t * dy) <= radius) return true;
    if ((a.y > node.y) !== (b.y > node.y)
      && node.x < (b.x - a.x) * (node.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
