import assert from "node:assert/strict";
import test from "node:test";
import { layoutThoughtLabel } from "./thoughtTypography.js";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const segments = (text) => Array.from(segmenter.segment(text), ({ segment }) => segment);
const measureText = (text, { fontSize }) => segments(text).reduce((width, character) => (
  width + fontSize * (character === " " ? 0.3 : /[il.,]/u.test(character) ? 0.25 : /[WM]/u.test(character) ? 0.9 : 0.55)
), 0);

function assertFitsCircle(node, label, { textOffsetY = 0, footerTop = Infinity } = {}) {
  const innerRadius = node.r - Math.min(8, Math.max(4, node.r * 0.1));
  label.lines.forEach((line, index) => {
    const lineY = textOffsetY + (index - (label.lines.length - 1) / 2) * label.lineHeight;
    const outerY = Math.abs(lineY) + label.fontSize * 0.6;
    const halfWidth = measureText(line, label) / 2;
    assert.ok(Math.hypot(halfWidth, outerY) <= innerRadius + 0.001, `Line exceeds its lobe: ${line}`);
    assert.ok(lineY + label.fontSize * 0.6 <= footerTop + 0.001, `Line overlaps its footer: ${line}`);
  });
}

test("semantic root uses readable type at the canonical 82px radius", () => {
  const node = { r: 82, text: "A neighborhood reading room" };
  const label = layoutThoughtLabel(node, { isRoot: true, measureText });
  assert.equal(label.fontSize, 20);
  assert.equal(label.fontWeight, 400);
  assert.equal(label.truncated, false);
  assert.equal(label.lines.join(" "), node.text);
  assertFitsCircle(node, label);
  assert.equal(layoutThoughtLabel({ ...node, r: 137 }, { measureText }).fontSize, 15);
});

test("measured wrapping keeps short child and ghost labels readable inside their lobes", () => {
  for (const ghost of [false, true]) {
    const node = { r: 46, text: "Quiet mornings", ghost };
    const label = layoutThoughtLabel(node, { measureText });
    assert.equal(label.fontSize, 15);
    assert.equal(label.truncated, false);
    assert.deepEqual(label.lines, ["Quiet", "mornings"]);
    assertFitsCircle(node, label);
  }
});

test("wrapping uses measured widths instead of character counts", () => {
  const narrow = layoutThoughtLabel({ r: 36, text: "iiiiii iiiiii" }, { measureText });
  const wide = layoutThoughtLabel({ r: 36, text: "WWWWWW WWWWWW" }, { measureText });
  assert.equal(narrow.lines.length, 1);
  assert.ok(wide.lines.length > narrow.lines.length);
  assert.equal(wide.truncated, true);
  assertFitsCircle({ r: 36 }, wide);
});

test("overflow adds only a final presentation ellipsis and preserves complete source text", () => {
  const original = "A detailed thought about a shared room with quiet mornings, open evenings, and a long explanation of how it works.";
  const node = Object.freeze({ r: 46, text: original, lines: Object.freeze(["Old wrapped text"]), sources: Object.freeze([{ quote: original }]) });
  const before = JSON.stringify(node);
  const label = layoutThoughtLabel(node, { measureText });
  assert.equal(label.truncated, true);
  assert.ok(label.lines.at(-1).endsWith("…"));
  assert.ok(label.lines.slice(0, -1).every((line) => !line.includes("…")));
  assert.ok(label.lines.join(" ").startsWith("A detailed"));
  assert.equal(JSON.stringify(node), before);
  assertFitsCircle(node, label);
});

test("layout stays stable across position, connectivity, conversational heat, and deformation", () => {
  const node = { r: 82, text: "A neighborhood reading room", depth: 0, x: 120, y: 220 };
  const first = layoutThoughtLabel(node, { isRoot: true, measureText });
  const moved = layoutThoughtLabel({ ...node, x: 600, y: 490, depth: 3, heatAt: 9000, vx: 55, deformation: 0.3, connections: 12 }, { isRoot: true, measureText });
  assert.deepEqual(moved, first);
});

test("long words wrap without losing characters", () => {
  const node = { r: 82, text: "abcdefghijklmnopqrstuvwxyz" };
  const label = layoutThoughtLabel(node, { measureText });
  assert.equal(label.truncated, false);
  assert.ok(label.lines.length > 1);
  assert.equal(label.lines.join(""), node.text);
  assertFitsCircle(node, label);
});

test("Unicode wrapping preserves emoji and combining sequences", () => {
  const grapheme = "👨‍👩‍👧‍👦";
  const node = { r: 46, text: `${grapheme.repeat(6)}${"é".repeat(6)}` };
  const label = layoutThoughtLabel(node, { measureText });
  assert.equal(label.truncated, false);
  assert.equal(label.lines.join(""), node.text);
  assert.ok(label.lines.flatMap(segments).every((part) => part === grapheme || part === "é"));
  assertFitsCircle(node, label);
});

test("legacy lines and TextMetrics are supported without mutating the input", () => {
  const node = { r: 46, lines: ["Free", "access"] };
  const label = layoutThoughtLabel(node, { measureText: (text, style) => ({ width: measureText(text, style) }) });
  assert.deepEqual(label.lines, ["Free", "access"]);
  assert.deepEqual(node.lines, ["Free", "access"]);
  assert.equal(label.truncated, false);
  assertFitsCircle(node, label);
});

test("shifted labels reserve provenance space without shrinking type or crossing the lobe", () => {
  for (const r of [36, 46, 58, 72, 82]) {
    for (const isRoot of [false, true]) {
      const node = { r, text: "A long explanation of the shared reading room and how it works" };
      const placement = { textOffsetY: -5, footerTop: r * 0.56 - 8.5 * 0.6 - 4 };
      const label = layoutThoughtLabel(node, { isRoot, measureText, ...placement });
      assert.equal(label.fontSize, isRoot ? 20 : 15);
      assertFitsCircle(node, label, placement);
    }
  }
});

test("metadata shifts rewrap dense labels while preserving the footer gap", () => {
  for (const r of [36, 46, 82, 137]) {
    const node = { r, text: "WWW wide words WWW wide words WWW wide words ".repeat(4), meta: "00:18" };
    const placement = { textOffsetY: -11, footerTop: r * 0.53 - 10 * 0.6 - 4 };
    const label = layoutThoughtLabel(node, { measureText, ...placement });
    assert.equal(label.fontSize, 15);
    assertFitsCircle(node, label, placement);
  }
});
