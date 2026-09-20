import assert from "node:assert/strict";
import test from "node:test";
import { distanceToSegment } from "./canvas/geometry.js";
import { getFocusIds, layoutHierarchy } from "./canvas/graphLayout.js";
import { canvasTransform, panForAnchor, MIN_ZOOM, MAX_ZOOM } from "./canvas/viewport.js";

test("focus includes descendants and ancestors without leaking into siblings or looping on cycles", () => {
  const edges = [
    { from: "root", to: "focus" }, { from: "root", to: "sibling" },
    { from: "focus", to: "child" }, { from: "child", to: "focus" },
    { from: "child", to: "leaf" },
  ];
  assert.deepEqual(getFocusIds("focus", edges), new Set(["focus", "child", "leaf", "root"]));
  assert.equal(getFocusIds(null, edges), null);
});

test("hierarchy distributes proposal siblings clear of their parent and reserved chrome", () => {
  const nodes = [
    { id: "root", depth: 0, r: 100, x: 0, y: 0 },
    { id: "one", ghost: true, r: 48 }, { id: "two", ghost: true, r: 48 },
  ];
  const [root, one, two] = layoutHierarchy(nodes, [
    { from: "root", to: "one" }, { from: "root", to: "two" },
  ]);
  assert.ok(one.x - one.r > root.x + root.r);
  assert.ok(two.y - one.y >= one.r + two.r);
  assert.ok(one.y - one.r >= 175 && two.y + two.r <= 805);
  assert.equal(nodes[0].x, 0, "layout must not mutate canonical geometry");
});

test("wheel and touch zoom share a transform that keeps the chosen world point under the cursor", () => {
  for (const viewport of [{ width: 1600, height: 1000 }, { width: 390, height: 844 }]) {
    const screen = { x: 137, y: 282 };
    const world = { x: 487, y: 313 };
    for (const zoom of [MIN_ZOOM, 1, MAX_ZOOM]) {
      const pan = panForAnchor(viewport, zoom, screen, world);
      const transform = canvasTransform(viewport, zoom, pan);
      assert.ok(Math.abs(transform.offsetX + world.x * transform.scale - screen.x) < 1e-9);
      assert.ok(Math.abs(transform.offsetY + world.y * transform.scale - screen.y) < 1e-9);
    }
  }
});

test("shared nearest-segment geometry handles endpoints and zero-length stems", () => {
  const a = { x: 2, y: 3 };
  assert.deepEqual(distanceToSegment({ x: 5, y: 7 }, a, a), { distance: 5, t: 0, x: 2, y: 3 });
  assert.deepEqual(distanceToSegment({ x: 8, y: 7 }, a, { x: 6, y: 3 }), { distance: Math.hypot(2, 4), t: 1, x: 6, y: 3 });
});
