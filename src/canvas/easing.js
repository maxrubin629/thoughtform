import { clamp } from "./geometry.js";

export function smoothstep(value) {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

export function lerp(start, end, amount) {
  return start + (end - start) * clamp(amount, 0, 1);
}

export function easeOutBack(value) {
  const t = clamp(value, 0, 1);
  const overshoot = 1.78;
  return 1 + (overshoot + 1) * ((t - 1) ** 3) + overshoot * ((t - 1) ** 2);
}

export function easeOutCubic(value) {
  const t = clamp(value, 0, 1);
  return 1 - ((1 - t) ** 3);
}

export function seededUnit(seed) {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}
