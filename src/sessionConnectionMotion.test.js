import assert from "node:assert/strict";
import test from "node:test";

import {
  applyConnectionGrowthMotion,
  buildConnectionPopTransition,
  connectionEdgeKey,
  connectionMatches,
} from "./session/connectionMotion.js";

const baseNodes = () => ([
  { id: "source", x: 0, y: 0, r: 60, wobblePulses: [{ startAt: 50, amplitude: 0.01 }] },
  { id: "target", x: 30, y: 40, r: 50 },
]);

test("connection growth appends the classic launch, contact, and return pulses", () => {
  const nodes = applyConnectionGrowthMotion(baseNodes(), {
    id: "edge-1",
    from: "source",
    to: "target",
    createdAt: 1000,
  });
  const source = nodes.find((node) => node.id === "source");
  const target = nodes.find((node) => node.id === "target");

  assert.deepEqual(source.wobblePulses.map((pulse) => pulse.startAt), [50, 1000, 1317]);
  assert.deepEqual(source.wobblePulses.slice(1).map((pulse) => pulse.amplitude), [0.064, 0.038]);
  assert.deepEqual(
    source.wobblePulses.slice(1).map((pulse) => [pulse.forceX, pulse.forceY, pulse.travel]),
    [[0.6, 0.8, 0.14], [-0.6, -0.8, 0.11]],
  );
  assert.equal(target.wobblePulses[0].startAt, 1245);
  assert.equal(target.wobblePulses[0].amplitude, 0.105);
  assert.equal(target.wobblePulses[0].travel, 0.32);
});

test("connection pop uses exact click-origin arrival clocks without creating a second rupture", () => {
  const nodes = [
    { id: "source", x: 0, y: 0, r: 60 },
    { id: "target", x: 100, y: 0, r: 50 },
  ];
  const transition = buildConnectionPopTransition(
    nodes,
    { id: "edge-1", from: "source", to: "target" },
    { hitT: 0.25, sourceImpactAt: 200, targetImpactAt: 300 },
    { includePop: false },
  );
  const sourcePulse = transition.nodes[0].wobblePulses[0];
  const targetPulse = transition.nodes[1].wobblePulses[0];

  assert.equal(transition.pop, null);
  assert.deepEqual(transition.impacts, { source: 200, target: 300 });
  assert.equal(sourcePulse.startAt, 200);
  assert.equal(sourcePulse.amplitude, 0.048);
  assert.deepEqual([sourcePulse.forceX, sourcePulse.forceY, sourcePulse.travel], [-1, 0, 0.13]);
  assert.equal(targetPulse.startAt, 300);
  assert.ok(Math.abs(targetPulse.amplitude - 0.04) < Number.EPSILON);
  assert.deepEqual([targetPulse.forceX, targetPulse.forceY, targetPulse.travel], [1, 0, 0.13]);
});

test("server-originated removal creates one cached 520 ms midpoint rupture", () => {
  const edge = { id: "edge-1", from: "source", to: "target" };
  const transition = buildConnectionPopTransition(baseNodes(), edge, {}, {
    eventId: "revision-3:edge-1",
    start: 100,
  });

  assert.equal(transition.pop.id, "revision-3:edge-1");
  assert.equal(transition.pop.edgeId, "edge-1");
  assert.equal(transition.pop.hitT, 0.5);
  assert.equal(transition.pop.start, 100);
  assert.equal(transition.pop.duration, 520);
  assert.equal(transition.pop.a.id, "source");
  assert.equal(transition.pop.b.id, "target");
  assert.equal(connectionEdgeKey(edge), "id:edge-1");
  assert.equal(connectionMatches(edge, { id: "edge-1", from: "target", to: "source" }), true);
});

test("reduced motion schedules neither deformation pulses nor a rupture", () => {
  const nodes = baseNodes();
  const edge = { id: "edge-1", from: "source", to: "target", createdAt: 1000 };
  assert.equal(applyConnectionGrowthMotion(nodes, edge, { reducedMotion: true }), nodes);
  const transition = buildConnectionPopTransition(nodes, edge, {}, { reducedMotion: true });
  assert.equal(transition.nodes, nodes);
  assert.equal(transition.pop, null);
});
