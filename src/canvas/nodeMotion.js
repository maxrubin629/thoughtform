import { clamp } from "./geometry.js";
import { easeOutBack } from "./easing.js";
import { CREATE_DURATION, WOBBLE_DURATION, DEFAULT_MATERIAL_SETTINGS } from "./materialSettings.js";

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

  const wobblePulses = node.wobblePulses ?? [];
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
    const shadeVx = node.dragging ? (node.shadeVx ?? 0) : (node.vx ?? 0);
    const shadeVy = node.dragging ? (node.shadeVy ?? 0) : (node.vy ?? 0);
    const shadeSpeed = Math.hypot(shadeVx, shadeVy);
    const anisotropy = Math.abs(radiusX - radiusY) / Math.max(node.r, 1);
    const rawMotionStrength = clamp(shadeSpeed * 0.035 + anisotropy * 3.2, 0, 1);
    const motionStrength = reducedMotion || rawMotionStrength < 0.018 ? 0 : rawMotionStrength;
    const motionAngle = visual.rotation || (shadeSpeed > 0.01
      ? Math.atan2(shadeVy, shadeVx)
      : movementAngle);
    const stretchPolarity = radiusX >= radiusY ? 1 : -1;
    visuals.set(node.id, {
      ...node,
      x: node.x + visual.offsetX,
      y: node.y + visual.offsetY,
      radius: Math.max(0.01, Math.min(radiusX, radiusY) * 0.98),
      radiusX,
      radiusY,
      rotation: visual.rotation || movementAngle,
      motionShadeX: Math.cos(motionAngle) * stretchPolarity,
      motionShadeY: Math.sin(motionAngle) * stretchPolarity,
      motionShadeStrength: motionStrength,
    });
  });
  return visuals;
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
    wobbleEndAt: Math.max(...wobblePulses.map((item) => item.startAt + WOBBLE_DURATION)),
    wobblePulses,
  };
}
