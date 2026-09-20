import { clamp } from "./geometry.js";
import { inverseSmootherstep, lerp, seededUnit, smootherstep } from "./easing.js";
import { DEFAULT_MATERIAL_SETTINGS, CONNECTION_POP_DURATION, CONNECTION_POP_RUPTURE_PROGRESS, CONNECTION_POP_TRAVEL_PROGRESS } from "./materialSettings.js";
import { bridgeMetrics, bridgeOutline, traceBridgeSection } from "./bridgeGeometry.js";

function connectionPopOrigin(metrics, hitT) {
  if (!metrics) return clamp(hitT, 0, 1);
  const startT = metrics.edgeA / metrics.distance;
  const endT = 1 - metrics.edgeB / metrics.distance;
  return clamp((hitT - startT) / Math.max(endT - startT, 0.001), 0, 1);
}

export function connectionPopFronts(progress, origin) {
  const wave = smootherstep((progress - CONNECTION_POP_RUPTURE_PROGRESS) / CONNECTION_POP_TRAVEL_PROGRESS);
  return { source: Math.max(0, origin - wave), target: Math.min(1, origin + wave) };
}

export function getConnectionPopImpactTimes(start, hitT, duration = CONNECTION_POP_DURATION, a, b, settings = DEFAULT_MATERIAL_SETTINGS, angleLimits) {
  const metrics = a && b ? bridgeMetrics(
    { ...a, radius: a.radius ?? a.r }, { ...b, radius: b.radius ?? b.r }, settings, angleLimits,
  ) : null;
  const origin = connectionPopOrigin(metrics, hitT);
  const arrival = (distance) => start + duration * (
    CONNECTION_POP_RUPTURE_PROGRESS + inverseSmootherstep(distance) * CONNECTION_POP_TRAVEL_PROGRESS
  );
  return { source: arrival(origin), target: arrival(1 - origin) };
}

export function drawFluidConnectionPop(ctx, a, b, settings = DEFAULT_MATERIAL_SETTINGS, pop, progress, fill) {
  const outline = bridgeOutline(a, b, settings, pop.angleLimits);
  if (!outline) return;
  const metrics = outline.metrics;
  // Freeze the click fraction, while the cut follows both moving boundaries.
  pop.origin ??= connectionPopOrigin(bridgeMetrics(pop.a ?? a, pop.b ?? b, settings, pop.angleLimits), pop.hitT ?? 0.5);
  const origin = pop.origin;
  const originX = lerp(metrics.start.x, metrics.end.x, origin);
  const originY = lerp(metrics.start.y, metrics.end.y, origin);
  ctx.save();
  ctx.fillStyle = fill;
  const fillSection = (start, end, roundStart = 0, roundEnd = 0) => {
    const path = new Path2D();
    if (traceBridgeSection(path, outline, start, end, roundStart, roundEnd)) ctx.fill(path);
  };

  if (progress < CONNECTION_POP_RUPTURE_PROGRESS) {
    fillSection(0, 1);
    const pressure = Math.sin(Math.PI * clamp(progress / CONNECTION_POP_RUPTURE_PROGRESS, 0, 1)) ** 2;
    const radius = metrics.waistHalfWidth * 1.08 * pressure;
    if (radius > 0.01) {
      ctx.beginPath();
      ctx.ellipse(originX, originY, radius * 1.2, radius, Math.atan2(metrics.uy, metrics.ux), 0, Math.PI * 2);
      ctx.fill();
    }
  } else {
    const fronts = connectionPopFronts(progress, origin);
    const round = smootherstep((progress - CONNECTION_POP_RUPTURE_PROGRESS) / 0.09);
    fillSection(0, fronts.source, 0, round);
    fillSection(fronts.target, 1, round, 0);
  }

  // A few small beads follow the tear and return into the lobes, rather than
  // scattering confetti across the canvas. Their paths share the rupture clock.
  for (let index = 0; index < 4; index += 1) {
    const seed = seededUnit((pop.seed ?? 1) + index * 17.31);
    const t = clamp((progress - 0.17 - index * 0.022) / 0.57, 0, 1);
    if (t <= 0 || t >= 1) continue;
    const destination = index % 2 ? b : a;
    const travel = smootherstep(t);
    const side = index < 2 ? -1 : 1;
    const arc = Math.sin(Math.PI * travel) * side * (5 + seed * 8);
    const x = lerp(originX, destination.x, travel) + metrics.px * arc;
    const y = lerp(originY, destination.y, travel) + metrics.py * arc;
    const radius = Math.min(3.4, metrics.waistHalfWidth * 0.6) * (0.7 + seed * 0.3)
      * smootherstep(t / 0.14) * (1 - smootherstep((t - 0.5) / 0.5));
    ctx.beginPath();
    ctx.ellipse(x, y, radius * 1.25, radius * 0.82, Math.atan2(metrics.uy, metrics.ux), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}
