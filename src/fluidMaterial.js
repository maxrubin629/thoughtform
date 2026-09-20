// Public material API. Boundary geometry, lobe motion, and rupture each have one owner.
import { clamp, distanceToSegment, segmentClearance, angleSeparation } from "./canvas/geometry.js";
import { smoothstep, lerp } from "./canvas/easing.js";
import { linkEnds } from "./canvas/graphLayout.js";
import { DEFAULT_MATERIAL_SETTINGS, CONNECTION_CREATE_DURATION, CONNECTION_CREATE_CONTACT_PROGRESS } from "./canvas/materialSettings.js";
import { attachmentAngleLimits, traceFluidBridge } from "./canvas/bridgeGeometry.js";

export { clamp } from "./canvas/geometry.js";
export { DEFAULT_MATERIAL_SETTINGS, PAPER_MATERIAL_SETTINGS, CONNECTION_CREATE_DURATION, CONNECTION_CREATE_CONTACT_PROGRESS, CONNECTION_CREATE_RETURN_DELAY, CONNECTION_POP_DURATION } from "./canvas/materialSettings.js";
export { buildFluidVisualNodes, withWobble } from "./canvas/nodeMotion.js";
export { drawFluidConnectionPop, getConnectionPopImpactTimes } from "./canvas/connectionPop.js";

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

export function drawFluidMaterial(ctx, visualNodes, links, options = {}) {
  const settings = options.settings ?? DEFAULT_MATERIAL_SETTINGS;
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
