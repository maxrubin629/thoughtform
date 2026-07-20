// Bubble sizing for the conversation-first session mode.
//
// In session mode a lobe's label is a concise interpretation of what was said,
// not the captured text itself (the transcript is the lossless record). That
// frees size to be a semantic signal instead of a text-fitting constraint:
//
//   tier   — structural role (anchor → theme → idea → detail) sets the base
//   degree — well-connected hub bubbles grow, log-scaled and capped
//   heat   — bubbles the conversation keeps returning to swell, then cool off
//   pinned — explicit user emphasis
//
// Radius is deliberately independent of label length. Labels are concise map
// interpretations; radius changes travel through the physics tick as a
// spring, so a resize reads as the material inflating rather than a layout
// snap.

import { clamp } from "../fluidMaterial.js";

const TIER_RADII = [96, 62, 48, 41, 37];
const MAX_RADIUS = 126;
const DEGREE_GAIN = 0.07;
const DEGREE_CAP = 0.22;
const HEAT_GAIN = 0.12;
const PIN_GAIN = 0.15;
const HEAT_DECAY_MS = 45000;
const RADIUS_QUANTUM = 2;
const RETARGET_HYSTERESIS = 0.04;
const EASE_PER_FRAME = 0.14;
const SETTLE_EPSILON = 0.22;

export function bubbleLines(label, maxLength = 14) {
  const words = String(label).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return ["Thought"];
  const lines = [];
  let current = "";
  words.forEach((word) => {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxLength && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  });
  if (current) lines.push(current);
  return lines;
}

export function heatOf(node, now) {
  if (!Number.isFinite(node.heatAt)) return 0;
  return Math.exp(-Math.max(now - node.heatAt, 0) / HEAT_DECAY_MS);
}

export function bubbleTargetRadius(node, degree, now) {
  const tier = TIER_RADII[clamp(node.depth ?? 2, 0, TIER_RADII.length - 1)];
  const emphasis = 1
    + Math.min(Math.log2(1 + degree) * DEGREE_GAIN, DEGREE_CAP)
    + heatOf(node, now) * HEAT_GAIN
    + (node.pinned ? PIN_GAIN : 0);
  const raw = clamp(tier * emphasis, TIER_RADII[TIER_RADII.length - 1], MAX_RADIUS);
  return Math.round(raw / RADIUS_QUANTUM) * RADIUS_QUANTUM;
}

function degreeMap(edges) {
  const degrees = new Map();
  edges.forEach((edge) => {
    if (edge.ghost) return;
    degrees.set(edge.from, (degrees.get(edge.from) ?? 0) + 1);
    degrees.set(edge.to, (degrees.get(edge.to) ?? 0) + 1);
  });
  return degrees;
}

// Runs inside the authoritative physics tick (the sole writer of node state),
// on the freshly cloned nodes stepFluidPhysics returned. Retargets with
// hysteresis and eases r toward targetR; returns true while any lobe is
// still inflating or deflating so the caller keeps committing frames.
export function updateBubbleRadii(nodes, edges, now, frameStep, { reducedMotion = false } = {}) {
  const degrees = degreeMap(edges);
  let active = false;
  nodes.forEach((node) => {
    if (node.ghost) return;
    const target = bubbleTargetRadius(node, degrees.get(node.id) ?? 0, now);
    const settled = node.targetR ?? node.r;
    if (Math.abs(target - settled) / Math.max(settled, 1) > RETARGET_HYSTERESIS
      || !Number.isFinite(node.targetR)) {
      node.targetR = target;
    }
    const delta = node.targetR - node.r;
    if (Math.abs(delta) <= SETTLE_EPSILON) {
      if (node.r !== node.targetR) node.r = node.targetR;
      return;
    }
    if (reducedMotion) {
      node.r = node.targetR;
      return;
    }
    node.r += delta * Math.min(EASE_PER_FRAME * frameStep, 1);
    active = true;
  });
  return active;
}
