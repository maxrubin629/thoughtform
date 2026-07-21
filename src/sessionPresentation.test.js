import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildFluidVisualNodes } from "./fluidMaterial.js";
import { proposalVisuals, visualizeSession } from "./session/presentation.js";
import { radiusForThought, wrapThought } from "./thoughtSizing.js";

test("classic and session routes reuse one sizing and canvas renderer", () => {
  const appSource = readFileSync(new URL("./App.jsx", import.meta.url), "utf8");
  const motionSource = readFileSync(new URL("./connectionVisualMotion.js", import.meta.url), "utf8");
  const sessionMotionSource = readFileSync(new URL("./session/connectionMotion.js", import.meta.url), "utf8");
  const presentationSource = readFileSync(new URL("./session/presentation.js", import.meta.url), "utf8");
  const sessionSource = readFileSync(new URL("./CanonicalSessionApp.jsx", import.meta.url), "utf8");

  assert.match(appSource, /import \{ radiusForThought, wrapThought \} from "\.\/thoughtSizing\.js"/);
  assert.match(presentationSource, /import \{ radiusForThought, wrapThought \} from "\.\.\/thoughtSizing\.js"/);
  assert.doesNotMatch(appSource, /function (?:wrapThought|radiusForThought)\(/);
  assert.doesNotMatch(presentationSource, /function (?:wrapThought|radiusForThought)\(/);
  assert.match(sessionSource, /import \{ IconButton, MindMap, layoutHierarchy \} from "\.\/App\.jsx"/);
  assert.match(appSource, /from "\.\/connectionVisualMotion\.js"/);
  assert.match(sessionMotionSource, /from "\.\.\/connectionVisualMotion\.js"/);
  assert.match(motionSource, /export function applyConnectionGrowthMotion/);
  assert.match(motionSource, /export function buildConnectionPopTransition/);
  assert.doesNotMatch(sessionSource, /updateBubbleRadii/);
});

test("create-bubble proposals preserve their parent ghost tether", () => {
  const nodes = [{ id: "root", x: 500, y: 500, r: 70, depth: 0, ghost: false }];
  const proposals = [{
    id: "proposal-1",
    status: "pending",
    operations: [{
      id: "proposal-operation-1",
      type: "create_bubble",
      node_id: "ghost-child",
      parent: "root",
      text: "A reviewable idea",
      excluded: false,
    }],
  }];

  const visuals = proposalVisuals(proposals, nodes);
  assert.equal(visuals.ghostNodes[0].id, "ghost-child");
  assert.deepEqual(
    { from: visuals.ghostEdges[0].from, to: visuals.ghostEdges[0].to },
    { from: "root", to: "ghost-child" },
  );
});

test("canonical snapshots preserve browser physics until the server position changes", () => {
  const session = {
    nodes: [{
      id: "node-1",
      text: "One",
      depth: 0,
      x: 100,
      y: 200,
      sources: [],
      created_by: "partner",
      created_at: "2026-07-20T12:00:00.000Z",
      updated_at: "2026-07-20T12:00:00.000Z",
    }],
    edges: [],
  };
  const pulses = [{ startAt: 900, amplitude: 0.08, forceX: 1, forceY: 0, travel: 0.2 }];
  const previous = [{
    id: "node-1",
    x: 140,
    y: 220,
    r: 60,
    vx: 2,
    vy: 3,
    dragging: true,
    shadeVx: 4,
    shadeVy: 5,
    wobblePulses: pulses,
    wobbleEndAt: 1540,
    ghost: false,
  }];
  const committed = new Map([["node-1", { x: 100, y: 200 }]]);

  const preserved = visualizeSession(session, previous, [], committed, 1000);
  assert.deepEqual([preserved.nodes[0].x, preserved.nodes[0].y], [140, 220]);
  assert.equal(preserved.nodes[0].wobblePulses, pulses);
  assert.equal(preserved.nodes[0].dragging, true);
  assert.deepEqual([preserved.nodes[0].shadeVx, preserved.nodes[0].shadeVy], [4, 5]);
  session.nodes[0].x = 300;
  const moved = visualizeSession(session, preserved.nodes, [], preserved.committedPositions, 1100);
  assert.deepEqual([moved.nodes[0].x, moved.nodes[0].y], [300, 200]);
  assert.equal(moved.nodes[0].wobblePulses, pulses);
});

test("canonical edge transitions are staggered once and remain idempotent across duplicate snapshots", () => {
  const node = (id, x) => ({
    id,
    text: id,
    depth: id === "root" ? 0 : 1,
    x,
    y: 200,
    sources: [],
    created_by: "partner",
    created_at: "2026-07-20T12:00:00.000Z",
    updated_at: "2026-07-20T12:00:00.000Z",
  });
  const session = {
    nodes: [node("root", 100), node("one", 300), node("two", 500)],
    edges: [
      { id: "edge-1", from: "root", to: "one", created_by: "partner" },
      { id: "edge-2", from: "root", to: "two", created_by: "partner" },
    ],
  };

  const first = visualizeSession(session, [], [], new Map(), 1000);
  assert.deepEqual(first.addedEdges.map((edge) => edge.id), ["edge-1", "edge-2"]);
  assert.deepEqual(first.edges.map((edge) => edge.createdAt), [1000, 1160]);
  assert.deepEqual(first.removedEdges, []);

  first.edges[0].rest = 240;
  const duplicate = visualizeSession(
    session,
    first.nodes,
    first.edges,
    first.committedPositions,
    1050,
  );
  assert.deepEqual(duplicate.addedEdges, []);
  assert.deepEqual(duplicate.removedEdges, []);
  assert.deepEqual(duplicate.edges.map((edge) => edge.createdAt), [1000, 1160]);
  assert.equal(duplicate.edges[0].rest, 240);

  const removedSession = { ...session, edges: [session.edges[1]] };
  const removed = visualizeSession(
    removedSession,
    duplicate.nodes,
    duplicate.edges,
    duplicate.committedPositions,
    1100,
  );
  assert.deepEqual(removed.removedEdges.map((edge) => edge.id), ["edge-1"]);
  assert.deepEqual(removed.addedEdges, []);

  const restored = visualizeSession(
    session,
    removed.nodes,
    removed.edges,
    removed.committedPositions,
    1200,
  );
  assert.deepEqual(restored.addedEdges.map((edge) => edge.id), ["edge-1"]);
  assert.equal(restored.addedEdges[0].createdAt, 1200);
});

test("committing a connection preserves classic lobe radius and typography", () => {
  const session = {
    nodes: [
      {
        id: "root",
        text: "First thought",
        depth: 0,
        x: 100,
        y: 200,
        sources: [],
        created_by: "you",
        created_at: "2026-07-20T12:00:00.000Z",
        updated_at: "2026-07-20T12:00:00.000Z",
      },
      {
        id: "other",
        text: "Second thought",
        depth: 1,
        x: 300,
        y: 200,
        sources: [],
        created_by: "you",
        created_at: "2026-07-20T12:00:00.000Z",
        updated_at: "2026-07-20T12:00:00.000Z",
      },
    ],
    edges: [],
  };
  const before = visualizeSession(session, [], [], new Map(), 1000);
  const typographyBefore = before.nodes.map((node) => ({
    id: node.id,
    r: node.r,
    targetR: node.targetR,
    lines: node.lines,
  }));

  const connected = visualizeSession(
    {
      ...session,
      edges: [{ id: "edge-1", from: "root", to: "other", created_by: "you" }],
    },
    before.nodes,
    before.edges,
    before.committedPositions,
    1200,
  );

  assert.deepEqual(
    connected.nodes.map((node) => ({
      id: node.id,
      r: node.r,
      targetR: node.targetR,
      lines: node.lines,
    })),
    typographyBefore,
  );

  const reloadedConnected = visualizeSession(
    {
      ...session,
      edges: [{ id: "edge-1", from: "root", to: "other", created_by: "you" }],
    },
    [],
    [],
    new Map(),
    1200,
    { animateNew: false },
  );
  assert.deepEqual(
    reloadedConnected.nodes.map((node) => ({
      id: node.id,
      r: node.r,
      targetR: node.targetR,
      lines: node.lines,
    })),
    typographyBefore,
  );

  const classicNodes = session.nodes.map((node, index) => {
    const lines = wrapThought(node.text);
    const fallback = index === 0 ? 82 : 46;
    const r = radiusForThought(lines, fallback, false);
    return {
      id: node.id,
      x: node.x,
      y: node.y,
      r,
      lines,
      createdAt: before.nodes[index].createdAt,
    };
  });
  const sessionGeometry = buildFluidVisualNodes(before.nodes, 1400, false);
  const classicGeometry = buildFluidVisualNodes(classicNodes, 1400, false);
  classicNodes.forEach((node) => {
    const sessionVisual = sessionGeometry.get(node.id);
    const classicVisual = classicGeometry.get(node.id);
    assert.deepEqual(
      [sessionVisual.radius, sessionVisual.radiusX, sessionVisual.radiusY, sessionVisual.rotation],
      [classicVisual.radius, classicVisual.radiusX, classicVisual.radiusY, classicVisual.rotation],
    );
  });
});
