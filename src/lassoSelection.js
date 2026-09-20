import { distanceToSegment } from "./canvas/geometry.js";

// The polygon and circle use canvas world coordinates, independent of zoom/pan.
export function lassoIntersectsNode(points, node) {
  if (points.length < 3) return false;
  const radius = node.r;
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[j];
    const b = points[i];
    if (distanceToSegment(node, a, b).distance <= radius) return true;
    if ((a.y > node.y) !== (b.y > node.y)
      && node.x < (b.x - a.x) * (node.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
