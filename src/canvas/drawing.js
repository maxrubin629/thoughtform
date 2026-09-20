import { clamp } from "./geometry.js";

export const palettes = {
  paper: {
    material: "#f78269",
    ink: "#251d1a",
    ghost: "#dc6d58",
    ghostFill: "rgba(245, 132, 109, 0.08)",
  },
  nocturne: {
    material: "#cc5d4b",
    materialByDepth: ["#d85e4c", "#d96552", "#dc6d59", "#df7560", "#e27d68"],
    ink: "#fff1df",
    ghost: "#e47b62",
    ghostFill: "rgba(228, 123, 98, 0.08)",
  },
};

export function drawWobblyCircle(ctx, node) {
  const points = 48;
  ctx.beginPath();
  for (let index = 0; index <= points; index += 1) {
    const angle = (index / points) * Math.PI * 2;
    const wobble = 1
      + Math.sin(angle * 3 + node.id.length) * 0.055
      + Math.sin(angle * 5 + node.id.length * 0.7) * 0.025;
    const x = node.x + Math.cos(angle) * node.r * wobble;
    const y = node.y + Math.sin(angle) * node.r * wobble;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

export function drawHoverGlow(ctx, node, concept, scale) {
  const radiusX = node.radiusX ?? node.radius ?? node.r;
  const radiusY = node.radiusY ?? node.radius ?? node.r;
  const spread = 24 / scale;
  const outerX = radiusX + spread;
  const outerY = radiusY + spread;
  const edge = Math.min(radiusX / outerX, radiusY / outerY);
  const color = concept === "nocturne" ? "255, 164, 121" : "255, 174, 138";

  // A continuous falloff beneath the material, with no stroked outer boundary.
  ctx.save();
  ctx.translate(node.x, node.y);
  ctx.rotate(node.rotation ?? 0);
  ctx.scale(outerX, outerY);
  const glow = ctx.createRadialGradient(0, 0, edge, 0, 0, 1);
  glow.addColorStop(0, `rgba(${color}, 0.56)`);
  glow.addColorStop(0.35, `rgba(${color}, 0.30)`);
  glow.addColorStop(0.7, `rgba(${color}, 0.07)`);
  glow.addColorStop(1, `rgba(${color}, 0)`);
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(0, 0, 1, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

export function drawSelectionContour(ctx, node, concept, scale) {
  const radiusX = (node.radiusX ?? node.radius ?? node.r) + 7 / scale;
  const radiusY = (node.radiusY ?? node.radius ?? node.r) + 7 / scale;
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(node.x, node.y, radiusX, radiusY, node.rotation ?? 0, 0, Math.PI * 2);
  ctx.lineWidth = 2 / scale;
  ctx.strokeStyle = concept === "nocturne"
    ? "rgba(255, 181, 158, 0.94)"
    : "rgba(132, 59, 45, 0.9)";
  ctx.stroke();
  ctx.restore();
}

function boundaryRadius(node, angle) {
  if (node.ghost) {
    const seed = String(node.id).length;
    const wobble = 1
      + Math.sin(angle * 3 + seed) * 0.055
      + Math.sin(angle * 5 + seed * 0.7) * 0.025;
    return node.r * wobble;
  }

  const radiusX = node.radiusX ?? node.radius ?? node.r;
  const radiusY = node.radiusY ?? node.radius ?? node.r;
  const localAngle = angle - (node.rotation ?? 0);
  const xTerm = Math.cos(localAngle) / Math.max(radiusX, 0.001);
  const yTerm = Math.sin(localAngle) / Math.max(radiusY, 0.001);
  return 1 / Math.max(Math.hypot(xTerm, yTerm), 0.001);
}

function exteriorBoundaryPoint(node, angle) {
  const radius = boundaryRadius(node, angle) + 0.85;
  return {
    x: node.x + Math.cos(angle) * radius,
    y: node.y + Math.sin(angle) * radius,
  };
}

export function drawGhostTether(ctx, from, to, bend, color) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const centerAngle = Math.atan2(dy, dx);
  const start = exteriorBoundaryPoint(from, centerAngle);
  const end = exteriorBoundaryPoint(to, centerAngle + Math.PI);
  const gapX = end.x - start.x;
  const gapY = end.y - start.y;
  const gap = Math.max(Math.hypot(gapX, gapY), 1);
  const ux = gapX / gap;
  const uy = gapY / gap;
  const px = -uy;
  const py = ux;
  const handle = gap * 0.32;
  const bendOffset = clamp(bend, -gap * 0.16, gap * 0.16);
  const controlA = {
    x: start.x + ux * handle + px * bendOffset,
    y: start.y + uy * handle + py * bendOffset,
  };
  const controlB = {
    x: end.x - ux * handle + px * bendOffset,
    y: end.y - uy * handle + py * bendOffset,
  };
  const traceTether = () => {
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.bezierCurveTo(controlA.x, controlA.y, controlB.x, controlB.y, end.x, end.y);
  };

  ctx.save();
  traceTether();
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.28;
  ctx.lineWidth = 0.8;
  ctx.lineCap = "round";
  ctx.stroke();

  traceTether();
  ctx.globalAlpha = 1;
  ctx.lineWidth = 1.7;
  ctx.lineCap = "round";
  ctx.setLineDash([1.4, 4.6]);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = color;
  [start, end].forEach((point) => {
    ctx.beginPath();
    ctx.arc(point.x, point.y, 0.9, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.restore();
}

export function drawWrappedText(ctx, node, x, y, palette, showProvenance) {
  const root = node.r > 100;
  const baseSize = root ? 22 : node.r > 72 ? 13.5 : node.r > 58 ? 12.5 : node.r > 43 ? 11.5 : 10.2;
  const verticalFit = (node.r * 1.48) / Math.max(node.lines.length * 1.22, 1);
  const size = root ? baseSize : clamp(Math.min(baseSize, verticalFit), 9.2, baseSize);
  const weight = root ? 400 : 500;
  ctx.fillStyle = node.ghost ? palette.ghost : palette.ink;
  ctx.font = `${weight} ${size}px Manrope, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const lineHeight = size * (root ? 1.3 : 1.22);
  const textY = y - (node.meta ? 11 : showProvenance && node.provenance ? 5 : 0);
  const start = textY - ((node.lines.length - 1) * lineHeight) / 2;
  node.lines.forEach((line, index) => {
    ctx.fillText(line, x, start + index * lineHeight, node.r * 1.65);
  });
  if (node.meta) {
    ctx.globalAlpha = 0.68;
    ctx.font = "500 10px Manrope, sans-serif";
    ctx.fillText(node.meta, x, y + node.r * 0.53);
    ctx.globalAlpha = 1;
  }
  if (showProvenance && node.provenance) {
    ctx.globalAlpha = 0.58;
    ctx.font = "500 8.5px Manrope, sans-serif";
    ctx.fillText(node.provenance, x, y + node.r * 0.56);
    ctx.globalAlpha = 1;
  }
}
