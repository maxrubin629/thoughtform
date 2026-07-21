import assert from "node:assert/strict";
import test from "node:test";

import {
  applyConnectionGrowthMotion,
  buildConnectionPopTransition,
  connectionEdgeKey,
  connectionEndpointKey,
  connectionMatches,
  confirmPendingConnectionEdge,
} from "./session/connectionMotion.js";

const baseNodes = () => ([
  { id: "source", x: 0, y: 0, r: 60, wobblePulses: [{ startAt: 50, amplitude: 0.01 }] },
  { id: "target", x: 30, y: 40, r: 50 },
]);

test("connection growth matches classic launch, contact, and return wobble", () => {
  const nodes = applyConnectionGrowthMotion(baseNodes(), {
    id: "edge-1",
    from: "source",
    to: "target",
    createdAt: 1000,
  });
  const source = nodes.find((node) => node.id === "source");
  const target = nodes.find((node) => node.id === "target");

  assert.deepEqual(source.wobblePulses.map((pulse) => pulse.startAt), [1000, 1317]);
  assert.deepEqual(source.wobblePulses.map((pulse) => pulse.amplitude), [0.064, 0.038]);
  assert.deepEqual(
    source.wobblePulses.map((pulse) => [pulse.forceX, pulse.forceY, pulse.travel]),
    [[0.6, 0.8, 0.14], [-0.6, -0.8, 0.11]],
  );
  assert.equal(target.wobblePulses[0].startAt, 1245);
  assert.equal(target.wobblePulses[0].amplitude, 0.105);
  assert.deepEqual(
    [target.wobblePulses[0].forceX, target.wobblePulses[0].forceY, target.wobblePulses[0].travel],
    [0.6, 0.8, 0.32],
  );
});

test("delayed manual confirmation preserves one click-owned causal clock", () => {
  const clickAt = 900;
  const serverConfirmedAt = 1000;
  const pendingEdge = { from: "source", to: "target", createdAt: clickAt };
  const animated = applyConnectionGrowthMotion(baseNodes(), pendingEdge);
  const confirmedEdge = confirmPendingConnectionEdge({
    id: "edge-1",
    from: "source",
    to: "target",
    createdAt: serverConfirmedAt,
  }, {
    startedAt: clickAt,
    edge: { ...pendingEdge, id: "pending:source:target", rest: 50, restDx: 30, restDy: 40, pending: true },
  });
  const source = animated.find((node) => node.id === "source");
  const target = animated.find((node) => node.id === "target");

  assert.equal(confirmedEdge.createdAt, clickAt);
  assert.equal(confirmedEdge.id, "edge-1");
  assert.equal(confirmedEdge.pending, false);
  assert.deepEqual(
    [confirmedEdge.rest, confirmedEdge.restDx, confirmedEdge.restDy],
    [50, 30, 40],
  );
  assert.deepEqual(source.wobblePulses.map((pulse) => pulse.startAt), [900, 1217]);
  assert.deepEqual(source.wobblePulses.map((pulse) => pulse.amplitude), [0.064, 0.038]);
  assert.deepEqual(target.wobblePulses.map((pulse) => pulse.startAt), [1145]);
  assert.equal(target.wobblePulses[0].startAt - clickAt, 245);
  assert.equal(source.wobblePulses[1].startAt - clickAt, 317);
  assert.equal(connectionEndpointKey(confirmedEdge), "source:target");
});

test("connection motion never retargets classic lobe sizes", () => {
  const createdAt = 1000;
  const pending = { from: "source", to: "target", createdAt, pending: true };
  const nodes = applyConnectionGrowthMotion([
    { id: "source", x: 0, y: 0, r: 96, targetR: 96, depth: 0 },
    { id: "target", x: 180, y: 0, r: 62, targetR: 62, depth: 1 },
  ], pending);

  assert.deepEqual(nodes.map((node) => [node.r, node.targetR]), [[96, 96], [62, 62]]);

  const confirmed = { ...pending, id: "edge-1", pending: false };
  assert.deepEqual(confirmed, { ...pending, id: "edge-1", pending: false });
  assert.deepEqual(nodes.map((node) => [node.r, node.targetR]), [[96, 96], [62, 62]]);
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
