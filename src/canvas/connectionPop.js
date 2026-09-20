import { clamp } from "./geometry.js";
import { easeOutCubic, lerp, seededUnit, smoothstep } from "./easing.js";
import { DEFAULT_MATERIAL_SETTINGS, CONNECTION_POP_DURATION, CONNECTION_POP_RUPTURE_PROGRESS, CONNECTION_POP_TRAVEL_PROGRESS } from "./materialSettings.js";
import { bridgeMetrics, traceFluidBridge } from "./bridgeGeometry.js";

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
  const settings = rawSettings;
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
  const settings = rawSettings ?? DEFAULT_MATERIAL_SETTINGS;
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
