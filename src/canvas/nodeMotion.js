import { clamp } from "./geometry.js";
import { easeOutBack, smootherstep } from "./easing.js";
import { CREATE_DURATION, WOBBLE_DURATION, DEFAULT_MATERIAL_SETTINGS } from "./materialSettings.js";

function nodeVisualState(node, now, reducedMotion) {
  if (reducedMotion) return { scale: 1, scaleX: 1, scaleY: 1, rotation: 0, offsetX: 0, offsetY: 0 };
  let scale = 1;
  let scaleX = 1;
  let scaleY = 1;
  let strainX = 0;
  let strainY = 0;
  let shear = 0;
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
  wobblePulses.forEach((pulse) => {
    const wobbleProgress = (now - pulse.startAt) / WOBBLE_DURATION;
    if (wobbleProgress >= 0 && wobbleProgress < 1) {
      const t = clamp(wobbleProgress, 0, 1);
      const attack = smootherstep(t / 0.075);
      const envelope = attack * (1 - t) ** 3;
      const amplitude = pulse.amplitude ?? 0.1;
      const wave = -Math.cos(t * Math.PI * 2.5) * amplitude * envelope * 0.85;
      const fx = pulse.forceX ?? 1;
      const fy = pulse.forceY ?? 0;
      // Add directional strain, not competing ellipse angles. Overlapping
      // launch/return/contact pulses then blend without flipping the lobe.
      strainX += wave * (fx * fx - 0.52 * fy * fy);
      strainY += wave * (fy * fy - 0.52 * fx * fx);
      shear += wave * 1.52 * fx * fy;
      const shove = attack * Math.exp(-6 * t) * (1 - t) ** 2
        * node.r * amplitude * (pulse.travel ?? 0.18);
      offsetX += fx * shove;
      offsetY += fy * shove;
    }
  });

  return { scale: Math.max(0, scale), scaleX, scaleY, strainX, strainY, shear, offsetX, offsetY };
}

export function buildFluidVisualNodes(nodes, now, reducedMotion = false) {
  const visuals = new Map();
  nodes.forEach((node) => {
    const visual = nodeVisualState(node, now, reducedMotion);
    const speed = Math.hypot(node.vx ?? 0, node.vy ?? 0);
    const stretch = reducedMotion || node.dragging
      ? 0
      : clamp(speed * 0.008 * DEFAULT_MATERIAL_SETTINGS.viscosity, 0, 0.14);
    const movementAngle = speed > 0.08 ? Math.atan2(node.vy ?? 0, node.vx ?? 0) : 0;
    const cosine = Math.cos(movementAngle);
    const sine = Math.sin(movementAngle);
    const xx = visual.scaleX - 1 + (visual.strainX ?? 0)
      + stretch * (cosine ** 2 - 0.52 * sine ** 2);
    const yy = visual.scaleY - 1 + (visual.strainY ?? 0)
      + stretch * (sine ** 2 - 0.52 * cosine ** 2);
    const xy = (visual.shear ?? 0) + stretch * 1.52 * sine * cosine;
    const mean = (xx + yy) / 2;
    const difference = Math.hypot(xx - yy, 2 * xy) / 2;
    const rotation = difference > 1e-8 ? Math.atan2(2 * xy, xx - yy) / 2 : 0;
    const radiusX = Math.max(0.01, node.r * visual.scale * (1 + mean + difference));
    const radiusY = Math.max(0.01, node.r * visual.scale * (1 + mean - difference));
    const shadeVx = node.dragging ? (node.shadeVx ?? 0) : (node.vx ?? 0);
    const shadeVy = node.dragging ? (node.shadeVy ?? 0) : (node.vy ?? 0);
    const shadeSpeed = Math.hypot(shadeVx, shadeVy);
    const anisotropy = Math.abs(radiusX - radiusY) / Math.max(node.r, 1);
    const rawMotionStrength = clamp(shadeSpeed * 0.035 + anisotropy * 3.2, 0, 1);
    const motionStrength = reducedMotion || rawMotionStrength < 0.018 ? 0 : rawMotionStrength;
    const motionAngle = difference > 1e-8 ? rotation : (shadeSpeed > 0.01
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
      rotation,
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
    ? node.wobblePulses.filter((item) => item.startAt + WOBBLE_DURATION > (options.retainAfter ?? startAt))
    : [];
  const wobblePulses = [...existingPulses, pulse]
    .sort((a, b) => a.startAt - b.startAt);
  return {
    ...node,
    wobbleEndAt: Math.max(...wobblePulses.map((item) => item.startAt + WOBBLE_DURATION)),
    wobblePulses,
  };
}
