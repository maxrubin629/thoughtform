import { clamp } from "./fluidMaterial.js";

export function wrapThought(value, maxLength = 18) {
  const words = String(value).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return ["New thought"];
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

export function radiusForThought(lines, fallbackRadius, ghost = false) {
  const longestLine = Math.max(...lines.map((line) => line.length), 1);
  const characterCount = lines.reduce((sum, line) => sum + line.length, 0);
  const contentRadius = Math.max(
    ghost ? 52 : 36,
    longestLine * 3.55,
    Math.sqrt(characterCount) * 10.5,
    22 + lines.length * 8,
  );
  return clamp(Math.max(fallbackRadius, contentRadius), ghost ? 52 : 36, ghost ? 78 : 82);
}
