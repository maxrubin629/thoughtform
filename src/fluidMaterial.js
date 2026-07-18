// Adapted from sites/fluid-bubble-lab/app/BubblePrototype.jsx.
// The lab remains the source of truth for the fused material geometry.

const MIN_CROWDED_HALF_ANGLE = 8 * (Math.PI / 180);
const CREATE_DURATION = 460;
export const CONNECTION_CREATE_DURATION = 420;
export const CONNECTION_CREATE_CONTACT_PROGRESS = 0.7;
export const CONNECTION_CREATE_RETURN_DELAY = 72;
export const CONNECTION_POP_DURATION = 520;
const CONNECTION_POP_RUPTURE_PROGRESS = 0.12;
const CONNECTION_POP_TRAVEL_PROGRESS = 0.24;
const WOBBLE_DURATION = 640;

export const DEFAULT_MATERIAL_SETTINGS = {
  viscosity: 0.8,
  elasticity: 0.05,
  repulsion: 0.95,
  minimumDistance: 0.8,
  maximumDistance: 1.2,
  damping: 0.6,
  bridgeWidth: 0.38,
  flare: 0.23,
  filletReach: 0.16,
  slenderSpan: 1,
  flareEnabled: true,
  filletReachEnabled: true,
  slenderSpanEnabled: false,
};

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function smoothstep(value) {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

function lerp(start, end, amount) {
  return start + (end - start) * clamp(amount, 0, 1);
}

function easeOutBack(value) {
  const t = clamp(value, 0, 1);
  const overshoot = 1.78;
  return 1 + (overshoot + 1) * ((t - 1) ** 3) + overshoot * ((t - 1) ** 2);
}

function easeOutCubic(value) {
  const t = clamp(value, 0, 1);
  return 1 - ((1 - t) ** 3);
}

function seededUnit(seed) {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

function linkEnds(link) {
  return { a: link.a ?? link.from, b: link.b ?? link.to };
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

function distanceToSegment(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (!lengthSquared) {
    return { distance: Math.hypot(point.x - a.x, point.y - a.y), t: 0 };
  }
  const t = clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared, 0, 1);
  const x = a.x + dx * t;
  const y = a.y + dy * t;
  return { distance: Math.hypot(point.x - x, point.y - y), t };
}

export function findFluidConnectionHit(point, visualNodes, links) {
  const nodes = visualNodes instanceof Map
    ? visualNodes
    : new Map(visualNodes.map((node) => [node.id, node]));
  for (let index = links.length - 1; index >= 0; index -= 1) {
    const link = links[index];
    if (link.ghost) continue;
    const { a: aId, b: bId } = linkEnds(link);
    const a = nodes.get(aId);
    const b = nodes.get(bId);
    if (!a || !b || a.ghost || b.ghost) continue;
    const hit = distanceToSegment(point, a, b);
    const aRadius = a.radius ?? a.r;
    const bRadius = b.radius ?? b.r;
    const hitWidth = Math.max(12, Math.min(aRadius, bRadius) * 0.26);
    if (hit.t > 0.14 && hit.t < 0.86 && hit.distance <= hitWidth) {
      return { link, a, b, hit };
    }
  }
  return null;
}

function segmentClearance(a, b, c, d) {
  if (segmentsIntersect(a, b, c, d)) return 0;
  return Math.min(
    distanceToSegment(a, c, d).distance,
    distanceToSegment(b, c, d).distance,
    distanceToSegment(c, a, b).distance,
    distanceToSegment(d, a, b).distance,
  );
}

function angleSeparation(a, b) {
  return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
}

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

function attachmentAngleLimits(a, b, links, nodes) {
  return {
    a: Math.max(MIN_CROWDED_HALF_ANGLE, nearestIncidentAngle(a, b, links, nodes) * 0.45),
    b: Math.max(MIN_CROWDED_HALF_ANGLE, nearestIncidentAngle(b, a, links, nodes) * 0.45),
  };
}

function distanceAttenuation(normalizedGap) {
  return 1 / (1 + Math.max(0, normalizedGap) * 0.9);
}

function enabledSettings(settings) {
  return {
    ...settings,
    flare: settings.flareEnabled === false ? -0.5 : settings.flare,
    filletReach: settings.filletReachEnabled === false ? -0.5 : settings.filletReach,
    slenderSpan: settings.slenderSpanEnabled === false ? 0 : settings.slenderSpan,
  };
}

function bridgeMetrics(a, b, settings, angleLimits) {
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
  const flare = clamp(settings.flare, -0.5, 1);
  const desiredHalfAngleDegrees = flare < 0
    ? lerp(6, 18, (flare + 0.5) / 0.5)
    : lerp(18, 46, flare);
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
  const halfSlenderSpan = settings.slenderSpanEnabled === false
    ? 0
    : bridgeLength * (0.025 + clamp(settings.slenderSpan, 0, 1) * 0.24);

  return {
    distance,
    ux,
    uy,
    px,
    py,
    start,
    end,
    leftWaist: {
      x: midpoint.x - ux * halfSlenderSpan,
      y: midpoint.y - uy * halfSlenderSpan,
    },
    rightWaist: {
      x: midpoint.x + ux * halfSlenderSpan,
      y: midpoint.y + uy * halfSlenderSpan,
    },
    edgeA,
    edgeB,
    endpointHalfWidthA,
    endpointHalfWidthB,
    waistHalfWidth,
  };
}

function traceFluidBridge(path, a, b, settings, angleLimits) {
  const metrics = bridgeMetrics(a, b, settings, angleLimits);
  if (!metrics) return false;

  const {
    ux,
    uy,
    px,
    py,
    start,
    end,
    leftWaist,
    rightWaist,
    edgeA,
    edgeB,
    endpointHalfWidthA,
    endpointHalfWidthB,
    waistHalfWidth,
  } = metrics;
  const leftLength = Math.hypot(leftWaist.x - start.x, leftWaist.y - start.y);
  const rightLength = Math.hypot(end.x - rightWaist.x, end.y - rightWaist.y);
  const filletReach = clamp(settings.filletReach, -0.5, 1);
  const negativeFilletProgress = (filletReach + 0.5) / 0.5;
  const endpointTangentFactor = filletReach < 0
    ? lerp(0.08, 0.34, negativeFilletProgress)
    : 0.34 + filletReach * 1.08;
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
  const waistHandleFactor = filletReach < 0
    ? lerp(0.04, 0.12, negativeFilletProgress)
    : 0.12 + filletReach * 0.22;
  const slenderLength = Math.hypot(
    rightWaist.x - leftWaist.x,
    rightWaist.y - leftWaist.y,
  );
  const slenderHandleLength = slenderLength / 3;
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
  const leftWaistTop = { x: leftWaist.x + px * waistHalfWidth, y: leftWaist.y + py * waistHalfWidth };
  const rightWaistTop = { x: rightWaist.x + px * waistHalfWidth, y: rightWaist.y + py * waistHalfWidth };
  const leftWaistBottom = { x: leftWaist.x - px * waistHalfWidth, y: leftWaist.y - py * waistHalfWidth };
  const rightWaistBottom = { x: rightWaist.x - px * waistHalfWidth, y: rightWaist.y - py * waistHalfWidth };

  path.moveTo(aTop.x, aTop.y);
  path.bezierCurveTo(
    aTop.x + aTopTangent.x * sourceTangentLength,
    aTop.y + aTopTangent.y * sourceTangentLength,
    leftWaistTop.x - ux * leftLength * waistHandleFactor,
    leftWaistTop.y - uy * leftLength * waistHandleFactor,
    leftWaistTop.x,
    leftWaistTop.y,
  );
  path.bezierCurveTo(
    leftWaistTop.x + ux * slenderHandleLength,
    leftWaistTop.y + uy * slenderHandleLength,
    rightWaistTop.x - ux * slenderHandleLength,
    rightWaistTop.y - uy * slenderHandleLength,
    rightWaistTop.x,
    rightWaistTop.y,
  );
  path.bezierCurveTo(
    rightWaistTop.x + ux * rightLength * waistHandleFactor,
    rightWaistTop.y + uy * rightLength * waistHandleFactor,
    bTop.x - bTopTangent.x * targetTangentLength,
    bTop.y - bTopTangent.y * targetTangentLength,
    bTop.x,
    bTop.y,
  );
  path.lineTo(bBottom.x, bBottom.y);
  path.bezierCurveTo(
    bBottom.x - bBottomTangent.x * targetTangentLength,
    bBottom.y - bBottomTangent.y * targetTangentLength,
    rightWaistBottom.x + ux * rightLength * waistHandleFactor,
    rightWaistBottom.y + uy * rightLength * waistHandleFactor,
    rightWaistBottom.x,
    rightWaistBottom.y,
  );
  path.bezierCurveTo(
    rightWaistBottom.x - ux * slenderHandleLength,
    rightWaistBottom.y - uy * slenderHandleLength,
    leftWaistBottom.x + ux * slenderHandleLength,
    leftWaistBottom.y + uy * slenderHandleLength,
    leftWaistBottom.x,
    leftWaistBottom.y,
  );
  path.bezierCurveTo(
    leftWaistBottom.x - ux * leftLength * waistHandleFactor,
    leftWaistBottom.y - uy * leftLength * waistHandleFactor,
    aBottom.x + aBottomTangent.x * sourceTangentLength,
    aBottom.y + aBottomTangent.y * sourceTangentLength,
    aBottom.x,
    aBottom.y,
  );
  path.closePath();
  return true;
}

function nodeVisualState(node, now, reducedMotion) {
  if (reducedMotion) return { scale: 1, scaleX: 1, scaleY: 1, rotation: 0, offsetX: 0, offsetY: 0 };
  let scale = 1;
  let scaleX = 1;
  let scaleY = 1;
  let rotation = 0;
  let offsetX = 0;
  let offsetY = 0;

  if (node.createdAt != null) {
    const createProgress = (now - node.createdAt) / CREATE_DURATION;
    if (createProgress < 0) scale = 0;
    else if (createProgress < 0.7) scale = Math.max(0, easeOutBack(createProgress / 0.7));
    else if (createProgress < 1) {
      const settleProgress = (createProgress - 0.7) / 0.3;
      const settleWave = Math.sin(settleProgress * Math.PI * 2.25)
        * 0.052
        * ((1 - settleProgress) ** 1.8);
      scaleX += settleWave;
      scaleY -= settleWave * 0.56;
    }
  }

  const wobblePulses = Array.isArray(node.wobblePulses)
    ? node.wobblePulses
    : node.wobbleStart != null
      ? [{
        startAt: node.wobbleStart,
        amplitude: node.wobbleAmplitude ?? 0.1,
        forceX: node.wobbleForceX ?? 1,
        forceY: node.wobbleForceY ?? 0,
        travel: node.wobbleTravel ?? 0.18,
      }]
      : [];
  let strongestWobble = 0;
  wobblePulses.forEach((pulse) => {
    const wobbleProgress = (now - pulse.startAt) / WOBBLE_DURATION;
    if (wobbleProgress >= 0 && wobbleProgress < 1) {
      const t = clamp(wobbleProgress, 0, 1);
      const envelope = (1 - t) ** 2.45;
      const amplitude = pulse.amplitude ?? 0.1;
      const impactCompression = -Math.exp(-10 * t) * amplitude * 0.48;
      const wave = impactCompression + Math.sin(t * Math.PI * 4.4) * amplitude * envelope;
      scaleX += wave;
      scaleY -= wave * 0.52;
      if (Math.abs(wave) >= strongestWobble) {
        strongestWobble = Math.abs(wave);
        rotation = Math.atan2(pulse.forceY ?? 0, pulse.forceX ?? 1);
      }
      const shove = (
        Math.exp(-8 * t) * 0.62
        + Math.sin(t * Math.PI * 3.6) * envelope * 0.38
      ) * node.r * amplitude * (pulse.travel ?? 0.18);
      offsetX += (pulse.forceX ?? 1) * shove;
      offsetY += (pulse.forceY ?? 0) * shove;
    }
  });

  return { scale: Math.max(0, scale), scaleX, scaleY, rotation, offsetX, offsetY };
}

export function buildFluidVisualNodes(nodes, now, reducedMotion = false) {
  const visuals = new Map();
  nodes.forEach((node) => {
    const visual = nodeVisualState(node, now, reducedMotion);
    const speed = Math.hypot(node.vx ?? 0, node.vy ?? 0);
    const stretch = node.dragging
      ? 0
      : clamp(speed * 0.008 * DEFAULT_MATERIAL_SETTINGS.viscosity, 0, 0.14);
    const movementAngle = speed > 0.08 ? Math.atan2(node.vy ?? 0, node.vx ?? 0) : 0;
    const radiusX = Math.max(
      0.01,
      node.r * visual.scale * (1 + stretch) * visual.scaleX,
    );
    const radiusY = Math.max(
      0.01,
      node.r * visual.scale * (1 - stretch * 0.52) * visual.scaleY,
    );
    visuals.set(node.id, {
      ...node,
      x: node.x + visual.offsetX,
      y: node.y + visual.offsetY,
      radius: Math.max(0.01, Math.min(radiusX, radiusY) * 0.98),
      radiusX,
      radiusY,
      rotation: visual.rotation || movementAngle,
    });
  });
  return visuals;
}

export function drawFluidMaterial(ctx, visualNodes, links, options = {}) {
  const settings = enabledSettings(options.settings ?? DEFAULT_MATERIAL_SETTINGS);
  const nodes = [...visualNodes.values()];
  const materialPaths = [];
  const fallbackColor = options.color ?? "#ed765d";
  const colorForNode = options.colorForNode ?? (() => fallbackColor);
  const now = options.now ?? performance.now();
  const reducedMotion = Boolean(options.reducedMotion);

  links.forEach((link) => {
    if (link.ghost) return;
    const { a: aId, b: bId } = linkEnds(link);
    const a = visualNodes.get(aId);
    const b = visualNodes.get(bId);
    if (!a || !b || a.ghost || b.ghost) return;
    let bridgeTarget = b;
    let bridgeSettings = settings;
    const connectionStart = link.createdAt;
    if (!reducedMotion && connectionStart != null) {
      const elapsedProgress = clamp(
        (now - connectionStart) / CONNECTION_CREATE_DURATION,
        0,
        1,
      );
      if (elapsedProgress < 1) {
        const travelProgress = clamp(
          elapsedProgress / CONNECTION_CREATE_CONTACT_PROGRESS,
          0,
          1,
        );
        const fusionProgress = clamp(
          (elapsedProgress - CONNECTION_CREATE_CONTACT_PROGRESS)
            / (1 - CONNECTION_CREATE_CONTACT_PROGRESS),
          0,
          1,
        );
        const travelEase = smoothstep(travelProgress);
        const fusionEase = smoothstep(fusionProgress);
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distance = Math.max(Math.hypot(dx, dy), 1);
        const ux = dx / distance;
        const uy = dy / distance;
        const smallestRadius = Math.min(a.radius, b.radius);
        const startDistance = a.radius * 0.72;
        const flightPulse = Math.sin(travelProgress * Math.PI) * 0.045;
        const contactPulse = Math.sin(fusionProgress * Math.PI) * 0.09;
        const headRadius = clamp(
          smallestRadius * (0.04 + travelProgress * 0.015) * (1 + flightPulse),
          2.8,
          4.8,
        );
        const impactDistance = Math.max(
          startDistance,
          distance - b.radius - headRadius,
        );
        const travelDistance = startDistance + (impactDistance - startDistance) * travelEase;
        const contactX = a.x + ux * impactDistance;
        const contactY = a.y + uy * impactDistance;
        const flightX = a.x + ux * travelDistance;
        const flightY = a.y + uy * travelDistance;
        bridgeTarget = {
          x: lerp(flightX, b.x, fusionEase),
          y: lerp(flightY, b.y, fusionEase),
          radius: lerp(headRadius, b.radius, fusionEase),
        };
        if (fusionProgress > 0) {
          bridgeTarget.x = lerp(contactX, b.x, fusionEase);
          bridgeTarget.y = lerp(contactY, b.y, fusionEase);
        }
        bridgeSettings = {
          ...settings,
          bridgeWidth: clamp(settings.bridgeWidth + flightPulse + contactPulse, 0, 1),
          flare: settings.flare * (
            0.52
            + travelProgress * 0.22
            + fusionEase * 0.26
          ),
        };
      }
    }
    const path = new Path2D();
    const angleLimits = attachmentAngleLimits(a, b, links, nodes);
    if (traceFluidBridge(path, a, bridgeTarget, bridgeSettings, angleLimits)) {
      const gradient = ctx.createLinearGradient(a.x, a.y, bridgeTarget.x, bridgeTarget.y);
      gradient.addColorStop(0, colorForNode(a));
      gradient.addColorStop(1, colorForNode(b));
      materialPaths.push({ path, fill: gradient });
    }
  });

  nodes.forEach((node) => {
    if (node.ghost) return;
    const path = new Path2D();
    path.ellipse(node.x, node.y, node.radiusX, node.radiusY, node.rotation, 0, Math.PI * 2);
    materialPaths.push({ path, fill: colorForNode(node) });
  });

  materialPaths.forEach(({ path, fill }) => {
    ctx.fillStyle = fill;
    ctx.fill(path);
  });
}

function fillFluidBridge(ctx, a, b, settings, angleLimits) {
  const path = new Path2D();
  if (!traceFluidBridge(path, a, b, settings, angleLimits)) return false;
  ctx.fill(path, "nonzero");
  return true;
}

function connectionPopOrigin(metrics, hitT) {
  const centerOrigin = clamp(hitT, 0, 1);
  if (!metrics) return centerOrigin;
  const startT = metrics.startT ?? metrics.edgeA / metrics.distance;
  const endT = metrics.endT ?? 1 - metrics.edgeB / metrics.distance;
  return clamp((centerOrigin - startT) / Math.max(endT - startT, 0.001), 0, 1);
}

export function getConnectionPopImpactTimes(
  start,
  hitT,
  duration = CONNECTION_POP_DURATION,
  a,
  b,
  rawSettings = DEFAULT_MATERIAL_SETTINGS,
) {
  const settings = enabledSettings(rawSettings);
  const popA = a ? { ...a, radius: a.radius ?? a.r } : null;
  const popB = b ? { ...b, radius: b.radius ?? b.r } : null;
  const metrics = popA && popB ? bridgeMetrics(popA, popB, settings) : null;
  const origin = connectionPopOrigin(metrics, hitT);
  const ruptureStart = start + duration * CONNECTION_POP_RUPTURE_PROGRESS;
  const travelDuration = duration * CONNECTION_POP_TRAVEL_PROGRESS;
  return {
    source: ruptureStart + origin * travelDuration,
    target: ruptureStart + (1 - origin) * travelDuration,
  };
}

export function drawFluidConnectionPop(ctx, a, b, rawSettings, pop, progress, fill) {
  const settings = enabledSettings(rawSettings ?? DEFAULT_MATERIAL_SETTINGS);
  const liveMetrics = bridgeMetrics(a, b, settings, pop.angleLimits);
  if (!pop.particleMetrics) {
    if (!liveMetrics) return;
    pop.particleMetrics = {
      distance: liveMetrics.distance,
      ux: liveMetrics.ux,
      uy: liveMetrics.uy,
      px: liveMetrics.px,
      py: liveMetrics.py,
      startT: liveMetrics.edgeA / liveMetrics.distance,
      endT: 1 - liveMetrics.edgeB / liveMetrics.distance,
      start: { ...liveMetrics.start },
      end: { ...liveMetrics.end },
    };
  }
  const particleMetrics = pop.particleMetrics;
  const burstOrigin = connectionPopOrigin(particleMetrics, pop.hitT ?? 0.5);
  const originX = lerp(particleMetrics.start.x, particleMetrics.end.x, burstOrigin);
  const originY = lerp(particleMetrics.start.y, particleMetrics.end.y, burstOrigin);
  const pressureProgress = clamp(progress / 0.28, 0, 1);
  const pressure = Math.sin(pressureProgress * Math.PI);
  const inflatedSettings = {
    ...settings,
    bridgeWidth: clamp(settings.bridgeWidth + pressure * 0.22, 0, 1),
    flare: clamp(settings.flare + pressure * 0.08, -0.5, 1),
  };

  ctx.save();
  ctx.fillStyle = fill;
  if (progress < CONNECTION_POP_RUPTURE_PROGRESS) {
    ctx.globalAlpha = 1;
    fillFluidBridge(ctx, a, b, inflatedSettings, pop.angleLimits);
  }
  if (pressure > 0.01 && progress < 0.22) {
    ctx.globalAlpha = pressure * 0.18;
    fillFluidBridge(ctx, a, b, {
      ...inflatedSettings,
      bridgeWidth: clamp(inflatedSettings.bridgeWidth + 0.18, 0, 1),
    }, pop.angleLimits);
  }

  const localPulse = Math.sin(clamp(progress / 0.25, 0, 1) * Math.PI);
  if (localPulse > 0.01) {
    ctx.globalAlpha = localPulse * 0.34;
    ctx.beginPath();
    ctx.ellipse(
      originX,
      originY,
      4 + localPulse * 13,
      3 + localPulse * 6,
      Math.atan2(particleMetrics.uy, particleMetrics.ux),
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }

  if (progress >= CONNECTION_POP_RUPTURE_PROGRESS) {
    const ruptureProgress = smoothstep(
      (progress - CONNECTION_POP_RUPTURE_PROGRESS) / 0.5,
    );
    const segmentAlpha = 1 - smoothstep((progress - 0.7) / 0.24);
    const headRadius = clamp(Math.min(a.radius, b.radius) * 0.045, 2.8, 4.8);
    const sourceHeadT = lerp(burstOrigin, 0, ruptureProgress);
    const targetHeadT = lerp(burstOrigin, 1, ruptureProgress);
    const sourceHead = {
      x: lerp(particleMetrics.start.x, particleMetrics.end.x, sourceHeadT),
      y: lerp(particleMetrics.start.y, particleMetrics.end.y, sourceHeadT),
      radius: headRadius,
    };
    const targetHead = {
      x: lerp(particleMetrics.start.x, particleMetrics.end.x, targetHeadT),
      y: lerp(particleMetrics.start.y, particleMetrics.end.y, targetHeadT),
      radius: headRadius,
    };
    const retractSettings = {
      ...settings,
      bridgeWidth: clamp(settings.bridgeWidth + pressure * 0.12, 0, 1),
      flare: settings.flare * (0.78 + (1 - ruptureProgress) * 0.22),
    };
    ctx.globalAlpha = segmentAlpha;
    fillFluidBridge(ctx, a, sourceHead, retractSettings, pop.angleLimits);
    fillFluidBridge(ctx, b, targetHead, retractSettings, pop.angleLimits);
  }

  const particleCount = clamp(Math.round(particleMetrics.distance / 26), 8, 17);
  const seedBase = pop.seed ?? 1;
  const centerLength = Math.hypot(
    particleMetrics.end.x - particleMetrics.start.x,
    particleMetrics.end.y - particleMetrics.start.y,
  );

  for (let index = 0; index < particleCount; index += 1) {
    const pathT = (index + 0.5) / particleCount;
    const seed = seededUnit(seedBase + index * 17.31);
    const seedB = seededUnit(seedBase + index * 43.77 + 11);
    const delay = CONNECTION_POP_RUPTURE_PROGRESS
      + Math.abs(pathT - burstOrigin) * CONNECTION_POP_TRAVEL_PROGRESS
      + seed * 0.015;
    const particleProgress = clamp((progress - delay) / 0.7, 0, 1);
    if (particleProgress <= 0 || particleProgress >= 1) continue;

    const outward = easeOutCubic(particleProgress);
    const side = seedB > 0.5 ? 1 : -1;
    const normalTravel = side * (9 + seed * 19) * outward;
    const alongTravel = (seedB - 0.5) * 15 * outward;
    const startX = lerp(particleMetrics.start.x, particleMetrics.end.x, pathT);
    const startY = lerp(particleMetrics.start.y, particleMetrics.end.y, pathT);
    const pathJitter = (seed - 0.5) * Math.min(centerLength / particleCount, 12);
    const x = startX
      + particleMetrics.ux * (alongTravel + pathJitter)
      + particleMetrics.px * normalTravel;
    const y = startY
      + particleMetrics.uy * (alongTravel + pathJitter)
      + particleMetrics.py * normalTravel;
    const fade = 1 - smoothstep((particleProgress - 0.5) / 0.5);
    const arrival = smoothstep(particleProgress / 0.14);
    const radius = (2.1 + seed * 2.8) * arrival * (1 - particleProgress * 0.52);
    const rotation = Math.atan2(particleMetrics.py * side, particleMetrics.px * side)
      + (seed - 0.5) * 0.7;

    ctx.globalAlpha = fade * 0.96;
    ctx.beginPath();
    ctx.ellipse(x, y, radius * 1.45, radius * 0.72, rotation, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

export function withWobble(node, forceX = 1, forceY = 0, amplitude = 0.1, options = {}) {
  const length = Math.max(Math.hypot(forceX, forceY), 0.001);
  const startAt = options.startAt ?? performance.now();
  const pulse = {
    startAt,
    amplitude,
    forceX: forceX / length,
    forceY: forceY / length,
    travel: options.travel ?? 0.18,
  };
  const existingPulses = options.append && Array.isArray(node.wobblePulses)
    ? node.wobblePulses
    : [];
  const wobblePulses = [...existingPulses, pulse]
    .sort((a, b) => a.startAt - b.startAt);
  return {
    ...node,
    wobbleStart: wobblePulses[0].startAt,
    wobbleEndAt: Math.max(...wobblePulses.map((item) => item.startAt + WOBBLE_DURATION)),
    wobbleAmplitude: amplitude,
    wobbleForceX: forceX / length,
    wobbleForceY: forceY / length,
    wobbleTravel: options.travel ?? 0.18,
    wobblePulses,
  };
}

export function findGrowthPlacement(parentNode, radius, nodeList, links, width, height) {
  const parentById = new Map(links.map((link) => [link.to ?? link.b, link.from ?? link.a]));
  const nodes = nodeList.map((node) => ({
    ...node,
    radius: node.r,
    parentId: node.parentId ?? parentById.get(node.id),
  }));
  const parent = { ...parentNode, radius: parentNode.r };
  const angles = [0, -0.18, 0.48, -0.9, 0.78, -1.22, 1.15, -Math.PI / 2, Math.PI / 2, Math.PI];
  const distances = [
    parent.radius + radius + 54,
    parent.radius + radius + 92,
    parent.radius + radius + 132,
  ];
  let best = null;

  distances.forEach((distance, ringIndex) => {
    angles.forEach((angle, angleIndex) => {
      const rawX = parent.x + Math.cos(angle) * distance;
      const rawY = parent.y + Math.sin(angle) * distance;
      const x = clamp(rawX, radius + 12, width - radius - 12);
      const y = clamp(rawY, radius + 12, height - radius - 54);
      let score = ringIndex * 24 + angleIndex * 2.5 + Math.abs(angle) ** 1.35 * 18;
      score += Math.abs(rawX - x) * 90 + Math.abs(rawY - y) * 90;
      if (x < parent.x + parent.radius * 0.45) score += (parent.x - x + 72) * 180;

      nodes.forEach((node) => {
        const clearance = radius + node.radius + 24;
        const distanceToNode = Math.hypot(x - node.x, y - node.y);
        if (distanceToNode < clearance) score += (clearance - distanceToNode) ** 2 * 42;
        if (node.id !== parent.id) {
          const webClearance = node.radius + Math.min(parent.radius, radius) * 0.12 + 18;
          const nearest = distanceToSegment(node, parent, { x, y });
          if (nearest.t > 0.12 && nearest.t < 0.9 && nearest.distance < webClearance) {
            score += (webClearance - nearest.distance) ** 2 * 36;
          }
        }
      });

      nodes.forEach((node) => {
        if (node.parentId !== parent.id || node.id === parent.id) return;
        const siblingAngle = Math.atan2(node.y - parent.y, node.x - parent.x);
        const separation = angleSeparation(angle, siblingAngle);
        if (separation < 0.44) score += 180 + (0.44 - separation) ** 2 * 4200;
        if (angle * siblingAngle < 0 && Math.abs(angle + siblingAngle) < 0.18) score += 70;
      });

      links.forEach((link) => {
        const { a: aId, b: bId } = linkEnds(link);
        const a = nodes.find((node) => node.id === aId);
        const b = nodes.find((node) => node.id === bId);
        if (!a || !b || a.id === parent.id || b.id === parent.id) return;
        const nearest = distanceToSegment({ x, y }, a, b);
        const clearance = radius + 22;
        if (nearest.t > 0.08 && nearest.t < 0.92 && nearest.distance < clearance) {
          score += (clearance - nearest.distance) ** 2 * 28;
        }
        const proposedClearance = segmentClearance(parent, { x, y }, a, b);
        const desiredWebClearance = Math.min(parent.radius, radius) * 0.18 + 10;
        if (proposedClearance < desiredWebClearance) {
          score += (desiredWebClearance - proposedClearance) ** 2 * 34;
        }
      });

      if (!best || score < best.score) best = { x, y, score };
    });
  });

  return best ?? {
    x: clamp(parent.x + parent.radius + radius + 54, radius + 12, width - radius - 12),
    y: clamp(parent.y, radius + 12, height - radius - 54),
  };
}
