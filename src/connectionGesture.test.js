import test from "node:test";
import assert from "node:assert/strict";
import { canConnect, connectionTargetAt, connectionBud } from "./connectionGesture.js";

const nodes = [{ id: "a", x: 100, y: 100, r: 40 }, { id: "b", x: 300, y: 100, r: 40 }, { id: "ghost", x: 400, y: 100, r: 40, ghost: true }];
test("connections reject self, missing, proposal and duplicate endpoints in either direction", () => {
  assert.equal(canConnect("a", "b", nodes, []), true);
  for (const [from, to] of [["a", "a"], ["a", "missing"], ["a", "ghost"], ["ghost", "b"]]) {
    assert.equal(canConnect(from, to, nodes, []), false);
  }
  assert.equal(canConnect("a", "b", nodes, [{ from: "b", to: "a" }]), false);
  assert.equal(canConnect("a", "b", nodes, [{ from: "a", to: "b", pending: true }]), false);
});
test("snapping permits a small exterior margin but never targets through an invalid lobe", () => {
  assert.equal(connectionTargetAt({ x: 346, y: 100 }, "a", nodes, [], 8)?.id, "b");
  assert.equal(connectionTargetAt({ x: 350, y: 100 }, "a", nodes, [], 8), null);
  assert.equal(connectionTargetAt({ x: 361, y: 100 }, "a", nodes, [], 30), null);
  assert.equal(connectionTargetAt({ x: 100, y: 100 }, "a", nodes, [], 300), null);
});
test("the whole 44px bud target remains outside its bubble at every zoom", () => {
  for (const scale of [0.4, 0.7, 1, 1.5]) {
    const transform = { scale, offsetX: 100, offsetY: 100 };
    const bud = connectionBud(nodes[0], nodes, transform, { width: 900, height: 600 });
    const distance = Math.hypot(bud.x - 100 - 100 * scale, bud.y - 100 - 100 * scale);
    assert.ok(distance - 22 > 40 * scale + 4);
  }
});
