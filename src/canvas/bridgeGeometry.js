// Shared boundary geometry for committed stems, growth, and click-origin rupture.
import { lerp } from "./easing.js";
import { clamp, angleSeparation } from "./geometry.js";
import { MIN_CROWDED_HALF_ANGLE } from "./materialSettings.js";
import { linkEnds } from "./graphLayout.js";

function nearestIncidentAngle(node, other, links, nodes) {
  const targetAngle = Math.atan2(other.y - node.y, other.x - node.x);
  let nearest = Math.PI;

  links.forEach((link) => {
    const { a, b } = linkEnds(link);
    const neighborId = a === node.id ? b : b === node.id ? a : null;
    if (neighborId == null || neighborId === other.id) return;
    const neighbor = nodes.find((candidate) => candidate.id === neighborId);
    if (!neighbor) return;
    const neighborAngle = Math.atan2(neighbor.y - node.y, neighbor.x - node.x);
    nearest = Math.min(nearest, angleSeparation(targetAngle, neighborAngle));
  });

  return nearest;
}

export function attachmentAngleLimits(a, b, links, nodes) {
  return {
    a: Math.max(MIN_CROWDED_HALF_ANGLE, nearestIncidentAngle(a, b, links, nodes) * 0.45),
    b: Math.max(MIN_CROWDED_HALF_ANGLE, nearestIncidentAngle(b, a, links, nodes) * 0.45),
  };
}

function distanceAttenuation(normalizedGap) {
  return 1 / (1 + Math.max(0, normalizedGap) * 0.9);
}

export function bridgeMetrics(a, b, settings, angleLimits) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 0.001) return null;

  const ux = dx / distance;
  const uy = dy / distance;
  const px = -uy;
  const py = ux;
  const gap = Math.max(0, distance - a.radius - b.radius);
  const normalizedGap = gap / Math.max(a.radius + b.radius, 1);
  const desiredHalfAngleDegrees = lerp(18, 46, settings.flare);
  const desiredHalfAngle = desiredHalfAngleDegrees * (Math.PI / 180);
  const halfAngleA = Math.min(desiredHalfAngle, angleLimits?.a ?? desiredHalfAngle);
  const halfAngleB = Math.min(desiredHalfAngle, angleLimits?.b ?? desiredHalfAngle);
  const endpointHalfWidthA = clamp(a.radius * Math.sin(halfAngleA), 3, a.radius * 0.8);
  const endpointHalfWidthB = clamp(b.radius * Math.sin(halfAngleB), 3, b.radius * 0.8);
  const smallestEndpoint = Math.min(endpointHalfWidthA, endpointHalfWidthB);
  const waistScale = lerp(0.15, 0.42, settings.bridgeWidth);
  const minimumWaist = Math.min(3, smallestEndpoint * 0.45);
  const waistHalfWidth = clamp(
    smallestEndpoint * waistScale * distanceAttenuation(normalizedGap),
    minimumWaist,
    smallestEndpoint * 0.52,
  );
  const edgeA = Math.sqrt(Math.max(a.radius ** 2 - endpointHalfWidthA ** 2, 0));
  const edgeB = Math.sqrt(Math.max(b.radius ** 2 - endpointHalfWidthB ** 2, 0));
  const start = { x: a.x + ux * edgeA, y: a.y + uy * edgeA };
  const end = { x: b.x - ux * edgeB, y: b.y - uy * edgeB };
  const bridgeLength = (end.x - start.x) * ux + (end.y - start.y) * uy;
  if (bridgeLength <= 0.5) return null;
  const midpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };

  return {
    distance,
    ux,
    uy,
    px,
    py,
    start,
    end,
    waist: midpoint,
    edgeA,
    edgeB,
    endpointHalfWidthA,
    endpointHalfWidthB,
    waistHalfWidth,
  };
}

export function bridgeOutline(a, b, settings, angleLimits) {
  const metrics = bridgeMetrics(a, b, settings, angleLimits);
  if (!metrics) return false;

  const {
    ux,
    uy,
    px,
    py,
    start,
    end,
    waist,
    edgeA,
    edgeB,
    endpointHalfWidthA,
    endpointHalfWidthB,
    waistHalfWidth,
  } = metrics;
  const leftLength = Math.hypot(waist.x - start.x, waist.y - start.y);
  const rightLength = Math.hypot(end.x - waist.x, end.y - waist.y);
  const filletReach = clamp(settings.filletReach, 0, 1);
  const endpointTangentFactor = 0.34 + filletReach * 1.08;
  const sourceAcrossComponent = Math.max(edgeA / a.radius, 0.001);
  const targetAcrossComponent = Math.max(edgeB / b.radius, 0.001);
  const sourceTangentLength = Math.min(
    leftLength * 0.82,
    a.radius * endpointTangentFactor,
    (endpointHalfWidthA / sourceAcrossComponent) * 0.88,
  );
  const targetTangentLength = Math.min(
    rightLength * 0.82,
    b.radius * endpointTangentFactor,
    (endpointHalfWidthB / targetAcrossComponent) * 0.88,
  );
  const waistHandleFactor = 0.12 + filletReach * 0.22;
  const tangent = (along, across) => ({
    x: ux * along + px * across,
    y: uy * along + py * across,
  });
  const aTopTangent = tangent(endpointHalfWidthA / a.radius, -edgeA / a.radius);
  const aBottomTangent = tangent(endpointHalfWidthA / a.radius, edgeA / a.radius);
  const bTopTangent = tangent(endpointHalfWidthB / b.radius, edgeB / b.radius);
  const bBottomTangent = tangent(endpointHalfWidthB / b.radius, -edgeB / b.radius);
  const aTop = { x: start.x + px * endpointHalfWidthA, y: start.y + py * endpointHalfWidthA };
  const aBottom = { x: start.x - px * endpointHalfWidthA, y: start.y - py * endpointHalfWidthA };
  const bTop = { x: end.x + px * endpointHalfWidthB, y: end.y + py * endpointHalfWidthB };
  const bBottom = { x: end.x - px * endpointHalfWidthB, y: end.y - py * endpointHalfWidthB };
  const waistTop = { x: waist.x + px * waistHalfWidth, y: waist.y + py * waistHalfWidth };
  const waistBottom = { x: waist.x - px * waistHalfWidth, y: waist.y - py * waistHalfWidth };

  const control = (point, direction, distance) => ({
    x: point.x + direction.x * distance,
    y: point.y + direction.y * distance,
  });
  const along = { x: ux, y: uy };
  return {
    metrics,
    top: [
      [aTop, control(aTop, aTopTangent, sourceTangentLength), control(waistTop, along, -leftLength * waistHandleFactor), waistTop],
      [waistTop, control(waistTop, along, rightLength * waistHandleFactor), control(bTop, bTopTangent, -targetTangentLength), bTop],
    ],
    bottom: [
      [aBottom, control(aBottom, aBottomTangent, sourceTangentLength), control(waistBottom, along, -leftLength * waistHandleFactor), waistBottom],
      [waistBottom, control(waistBottom, along, rightLength * waistHandleFactor), control(bBottom, bBottomTangent, -targetTangentLength), bBottom],
    ],
  };
}

const mixPoint = (a, b, t) => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) });

function splitCurve([a, b, c, d], t) {
  const ab = mixPoint(a, b, t);
  const bc = mixPoint(b, c, t);
  const cd = mixPoint(c, d, t);
  const abc = mixPoint(ab, bc, t);
  const bcd = mixPoint(bc, cd, t);
  const middle = mixPoint(abc, bcd, t);
  return [[a, ab, abc, middle], [middle, bcd, cd, d]];
}

function curveTime(curve, distance, metrics) {
  const positions = curve.map((point) => (
    (point.x - metrics.start.x) * metrics.ux + (point.y - metrics.start.y) * metrics.uy
  ));
  if (distance <= positions[0]) return 0;
  if (distance >= positions[3]) return 1;
  let low = 0;
  let high = 1;
  for (let i = 0; i < 18; i += 1) {
    const t = (low + high) / 2;
    const u = 1 - t;
    const x = u ** 3 * positions[0] + 3 * u * u * t * positions[1]
      + 3 * u * t * t * positions[2] + t ** 3 * positions[3];
    if (x < distance) low = t;
    else high = t;
  }
  return (low + high) / 2;
}

function sliceCurves(curves, start, end, metrics) {
  if (start === 0 && end === 1) return curves;
  const length = Math.hypot(metrics.end.x - metrics.start.x, metrics.end.y - metrics.start.y);
  return curves.flatMap((curve) => {
    const a = curveTime(curve, start * length, metrics);
    const b = curveTime(curve, end * length, metrics);
    if (b <= a) return [];
    const left = b === 1 ? curve : splitCurve(curve, b)[0];
    return [a === 0 ? left : splitCurve(left, a / b)[1]];
  });
}

// Keep the original stem outline at rupture. Its two exact Bézier sections
// retreat from the click, with rounded ends rolling into the endpoint lobes.
export function traceBridgeSection(path, outline, start = 0, end = 1, roundStart = 0, roundEnd = 0) {
  if (!outline || end - start < 0.0001) return false;
  const { metrics } = outline;
  const top = sliceCurves(outline.top, start, end, metrics);
  const bottom = sliceCurves(outline.bottom, start, end, metrics);
  if (!top.length || !bottom.length) return false;
  const drawCurve = ([, b, c, d]) => path.bezierCurveTo(b.x, b.y, c.x, c.y, d.x, d.y);
  const cap = (a, b, round, direction) => {
    const reach = Math.hypot(a.x - b.x, a.y - b.y) * 0.55 * round * direction;
    if (!round) path.lineTo(b.x, b.y);
    else path.bezierCurveTo(a.x + metrics.ux * reach, a.y + metrics.uy * reach,
      b.x + metrics.ux * reach, b.y + metrics.uy * reach, b.x, b.y);
  };
  path.moveTo(top[0][0].x, top[0][0].y);
  top.forEach(drawCurve);
  cap(top.at(-1)[3], bottom.at(-1)[3], roundEnd, 1);
  [...bottom].reverse().forEach((curve) => drawCurve([...curve].reverse()));
  cap(bottom[0][0], top[0][0], roundStart, -1);
  path.closePath();
  return true;
}

export function traceFluidBridge(path, a, b, settings, angleLimits) {
  return traceBridgeSection(path, bridgeOutline(a, b, settings, angleLimits));
}
