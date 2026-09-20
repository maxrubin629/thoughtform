import { clamp } from "./geometry.js";

export function smoothstep(value) {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

// Zero velocity and acceleration at both ends of a material transition.
export function smootherstep(value) {
  const t = clamp(value, 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

export function inverseSmootherstep(value) {
  const target = clamp(value, 0, 1);
  if (target === 0 || target === 1) return target;
  let low = 0;
  let high = 1;
  for (let index = 0; index < 24; index += 1) {
    const middle = (low + high) / 2;
    if (smootherstep(middle) < target) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
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
