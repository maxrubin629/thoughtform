export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function distanceToSegment(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared ? clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared, 0, 1) : 0;
  const x = a.x + dx * t;
  const y = a.y + dy * t;
  return { distance: Math.hypot(point.x - x, point.y - y), t, x, y };
}

function segmentsIntersect(a, b, c, d) {
  const cross = (p, q, r) => (
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)
  );
  const abC = cross(a, b, c);
  const abD = cross(a, b, d);
  const cdA = cross(c, d, a);
  const cdB = cross(c, d, b);
  return abC * abD < 0 && cdA * cdB < 0;
}
export function segmentClearance(a, b, c, d) {
  if (segmentsIntersect(a, b, c, d)) return 0;
  return Math.min(
    distanceToSegment(a, c, d).distance,
    distanceToSegment(b, c, d).distance,
    distanceToSegment(c, a, b).distance,
    distanceToSegment(d, a, b).distance,
  );
}

export function angleSeparation(a, b) {
  return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
}
