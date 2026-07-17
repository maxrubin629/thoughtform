// Physics ported from sites/fluid-bubble-lab/app/BubblePrototype.jsx.
// The lab remains the behavioral source of truth for spring bands, clearance,
// release inertia, damping, and edge collisions.

import { DEFAULT_MATERIAL_SETTINGS, clamp } from "./fluidMaterial.js";

export const FLUID_PHYSICS_SETTINGS = {
  ...DEFAULT_MATERIAL_SETTINGS,
};

function linkKey(a, b) {
  return String(a) < String(b) ? `${a}:${b}` : `${b}:${a}`;
}

function distanceToSegment(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (!lengthSquared) {
    return {
      distance: Math.hypot(point.x - a.x, point.y - a.y),
      t: 0,
      x: a.x,
      y: a.y,
    };
  }
  const t = clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared, 0, 1);
  const x = a.x + dx * t;
  const y = a.y + dy * t;
  return { distance: Math.hypot(point.x - x, point.y - y), t, x, y };
}

export function captureFluidRestLengths(nodes, edges, { reset = false } = {}) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return edges.map((edge) => {
    if (edge.ghost) {
      const { rest: _rest, restDx: _restDx, restDy: _restDy, ...ghostEdge } = edge;
      return ghostEdge;
    }
    if (!reset && Number.isFinite(edge.rest)) return { ...edge };
    const a = byId.get(edge.from);
    const b = byId.get(edge.to);
    if (!a || !b) return { ...edge };
    const restDx = b.x - a.x;
    const restDy = b.y - a.y;
    return {
      ...edge,
      rest: Math.max(Math.hypot(restDx, restDy), 1),
      restDx,
      restDy,
    };
  });
}

export function stepFluidPhysics(
  nodes,
  edges,
  {
    frameStep = 1,
    width,
    height,
    settings = FLUID_PHYSICS_SETTINGS,
  },
) {
  const boundedStep = clamp(frameStep, 0.35, 2);
  const previousById = new Map(nodes.map((node) => [node.id, node]));
  const nextNodes = nodes.map((node) => ({
    ...node,
    vx: Number.isFinite(node.vx) ? node.vx : 0,
    vy: Number.isFinite(node.vy) ? node.vy : 0,
    dragging: Boolean(node.dragging),
  }));
  const physicalNodes = nextNodes.filter((node) => !node.ghost);
  const physicalById = new Map(physicalNodes.map((node) => [node.id, node]));
  const links = edges.filter((edge) => !edge.ghost).flatMap((edge) => {
    const a = physicalById.get(edge.from);
    const b = physicalById.get(edge.to);
    if (!a || !b) return [];
    const currentDistance = Math.max(Math.hypot(b.x - a.x, b.y - a.y), 1);
    return [{
      ...edge,
      a: edge.from,
      b: edge.to,
      rest: Number.isFinite(edge.rest) ? edge.rest : currentDistance,
    }];
  });
  const linkMap = new Map(links.map((link) => [linkKey(link.a, link.b), link]));

  for (let i = 0; i < physicalNodes.length; i += 1) {
    const a = physicalNodes[i];
    for (let j = i + 1; j < physicalNodes.length; j += 1) {
      const b = physicalNodes[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.max(Math.hypot(dx, dy), 0.001);
      const ux = dx / distance;
      const uy = dy / distance;
      const combinedRadius = a.r + b.r;
      const savedLink = linkMap.get(linkKey(a.id, b.id));

      if (savedLink) {
        const minimumLinkDistance = savedLink.rest * settings.minimumDistance;
        const maximumLinkDistance = savedLink.rest * settings.maximumDistance;
        const boundaryStretch = distance < minimumLinkDistance
          ? distance - minimumLinkDistance
          : distance > maximumLinkDistance
            ? distance - maximumLinkDistance
            : 0;
        if (boundaryStretch !== 0) {
          const springForce = boundaryStretch * (0.0025 + settings.elasticity * 0.013);
          if (!a.dragging) {
            a.vx += ux * springForce * boundedStep;
            a.vy += uy * springForce * boundedStep;
          }
          if (!b.dragging) {
            b.vx -= ux * springForce * boundedStep;
            b.vy -= uy * springForce * boundedStep;
          }
        }
      }

      const minimumDistance =
        combinedRadius * (0.88 + settings.repulsion * 0.2) + settings.repulsion * 10;
      if (distance < minimumDistance) {
        const repel =
          (minimumDistance - distance) * (0.008 + settings.repulsion * 0.032);
        if (!a.dragging) {
          a.vx -= ux * repel * boundedStep;
          a.vy -= uy * repel * boundedStep;
        }
        if (!b.dragging) {
          b.vx += ux * repel * boundedStep;
          b.vy += uy * repel * boundedStep;
        }
      }
    }
  }

  links.forEach((link) => {
    const a = physicalById.get(link.a);
    const b = physicalById.get(link.b);
    if (!a || !b) return;
    const segmentDx = b.x - a.x;
    const segmentDy = b.y - a.y;
    const segmentLength = Math.max(Math.hypot(segmentDx, segmentDy), 1);

    physicalNodes.forEach((node) => {
      if (node.id === a.id || node.id === b.id) return;
      const nearest = distanceToSegment(node, a, b);
      if (nearest.t <= 0.12 || nearest.t >= 0.88) return;
      const webClearance = Math.max(10, Math.min(a.r, b.r) * 0.14);
      const clearanceDistance = node.r + webClearance;
      if (nearest.distance >= clearanceDistance) return;

      let nx;
      let ny;
      if (nearest.distance > 0.001) {
        nx = (node.x - nearest.x) / nearest.distance;
        ny = (node.y - nearest.y) / nearest.distance;
      } else {
        const direction = String(node.id).length + String(a.id).length + String(b.id).length;
        const sign = direction % 2 === 0 ? 1 : -1;
        nx = (-segmentDy / segmentLength) * sign;
        ny = (segmentDx / segmentLength) * sign;
      }

      const overlap = clearanceDistance - nearest.distance;
      const separationForce = overlap * (0.003 + settings.repulsion * 0.012);
      if (!node.dragging) {
        node.vx += nx * separationForce * boundedStep;
        node.vy += ny * separationForce * boundedStep;
      }
      const endpointShare = separationForce * 0.22 * boundedStep;
      if (!a.dragging) {
        a.vx -= nx * endpointShare;
        a.vy -= ny * endpointShare;
      }
      if (!b.dragging) {
        b.vx -= nx * endpointShare;
        b.vy -= ny * endpointShare;
      }
    });
  });

  const dampingFactor = Math.pow(1 - settings.damping * 0.085, boundedStep);
  physicalNodes.forEach((node) => {
    if (node.dragging) {
      node.vx = 0;
      node.vy = 0;
      return;
    }

    node.vx *= dampingFactor;
    node.vy *= dampingFactor;
    if (Math.abs(node.vx) < 0.0005) node.vx = 0;
    if (Math.abs(node.vy) < 0.0005) node.vy = 0;
    node.x += node.vx * boundedStep;
    node.y += node.vy * boundedStep;

    const edgePadding = node.r + 8;
    if (node.x < edgePadding) {
      node.x = edgePadding;
      node.vx *= -0.24;
    } else if (node.x > width - edgePadding) {
      node.x = width - edgePadding;
      node.vx *= -0.24;
    }
    if (node.y < edgePadding) {
      node.y = edgePadding;
      node.vy *= -0.24;
    } else if (node.y > height - edgePadding) {
      node.y = height - edgePadding;
      node.vy *= -0.24;
    }
  });

  const active = physicalNodes.some((node) => {
    const previous = previousById.get(node.id);
    if (!previous) return true;
    return Math.abs(node.x - previous.x) > 0.0005
      || Math.abs(node.y - previous.y) > 0.0005
      || Math.abs(node.vx) > 0.0005
      || Math.abs(node.vy) > 0.0005;
  });

  return { nodes: nextNodes, active };
}
