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

export function traceFluidBridge(path, a, b, settings, angleLimits) {
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

  path.moveTo(aTop.x, aTop.y);
  path.bezierCurveTo(
    aTop.x + aTopTangent.x * sourceTangentLength,
    aTop.y + aTopTangent.y * sourceTangentLength,
    waistTop.x - ux * leftLength * waistHandleFactor,
    waistTop.y - uy * leftLength * waistHandleFactor,
    waistTop.x,
    waistTop.y,
  );
  path.bezierCurveTo(
    waistTop.x + ux * rightLength * waistHandleFactor,
    waistTop.y + uy * rightLength * waistHandleFactor,
    bTop.x - bTopTangent.x * targetTangentLength,
    bTop.y - bTopTangent.y * targetTangentLength,
    bTop.x,
    bTop.y,
  );
  path.lineTo(bBottom.x, bBottom.y);
  path.bezierCurveTo(
    bBottom.x - bBottomTangent.x * targetTangentLength,
    bBottom.y - bBottomTangent.y * targetTangentLength,
    waistBottom.x + ux * rightLength * waistHandleFactor,
    waistBottom.y + uy * rightLength * waistHandleFactor,
    waistBottom.x,
    waistBottom.y,
  );
  path.bezierCurveTo(
    waistBottom.x - ux * leftLength * waistHandleFactor,
    waistBottom.y - uy * leftLength * waistHandleFactor,
    aBottom.x + aBottomTangent.x * sourceTangentLength,
    aBottom.y + aBottomTangent.y * sourceTangentLength,
    aBottom.x,
    aBottom.y,
  );
  path.closePath();
  return true;
}
