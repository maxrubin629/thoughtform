import assert from "node:assert/strict";
import test from "node:test";
import { captureFluidRestLengths, stepFluidPhysics } from "./fluidPhysics.js";

test("pinned lobes hold their position while neighbors settle away from them", () => {
  const nodes = [
    { id: "anchor", x: 300, y: 300, r: 60, vx: 8, vy: -5, pinned: true },
    { id: "neighbor", x: 350, y: 300, r: 60, vx: 0, vy: 0 },
  ];
  const result = stepFluidPhysics(nodes, [], { frameStep: 1, width: 1440, height: 1000 });
  assert.equal(result.nodes[0].x, 300);
  assert.equal(result.nodes[0].y, 300);
  assert.equal(result.nodes[0].vx, 0);
  assert.equal(result.nodes[0].vy, 0);
  assert.ok(result.nodes[1].x > 350);
});

test("session presentation can capture a stable rest length for proposal tethers", () => {
  const nodes = [
    { id: "committed", x: 100, y: 100, r: 60, ghost: false },
    { id: "proposal", x: 300, y: 100, r: 58, ghost: true },
  ];
  const [edge] = captureFluidRestLengths(
    nodes,
    [{ id: "proposal-edge", from: "committed", to: "proposal", ghost: true }],
    { includeGhosts: true },
  );

  assert.equal(edge.rest, 200);
  assert.equal(edge.restDx, 200);
  assert.equal(edge.restDy, 0);
});

test("session presentation can include proposal lobes in the shared fluid physics", () => {
  const nodes = [
    { id: "committed", x: 300, y: 300, r: 60, vx: 0, vy: 0, ghost: false },
    { id: "proposal", x: 350, y: 300, r: 58, vx: 0, vy: 0, ghost: true },
  ];

  const result = stepFluidPhysics(nodes, [], {
    frameStep: 1,
    width: 1440,
    height: 1000,
    includeGhosts: true,
  });

  const committed = result.nodes.find((node) => node.id === "committed");
  const proposal = result.nodes.find((node) => node.id === "proposal");
  assert.ok(committed.x < 300, "committed lobe should respond to the collision");
  assert.ok(proposal.x > 350, "proposal lobe should respond to the same collision");
  assert.equal(result.active, true);
});
