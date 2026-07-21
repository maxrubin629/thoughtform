import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildFluidVisualNodes } from "./fluidMaterial.js";
import {
  buildConversationTimeline,
  createMapControllerActivityDelay,
  mapControllerPresentation,
  modelActionLabel,
  proposalVisuals,
  visualizeSession,
} from "./session/presentation.js";
import { radiusForThought, wrapThought } from "./thoughtSizing.js";

test("conversation presentation groups consecutive utterances without changing their source records", () => {
  const transcript = [
    { id: "you-1", speaker: "you", text: "I have an idea for a...", completed_at: "2026-07-21T07:43:00.000Z" },
    { id: "you-2", speaker: "you", text: "Voice-based", completed_at: "2026-07-21T07:43:02.000Z" },
    { id: "you-3", speaker: "you", text: "Sort of mind map app.", completed_at: "2026-07-21T07:43:05.000Z" },
    { id: "partner-1", speaker: "partner", text: "That sounds promising.", completed_at: "2026-07-21T07:43:08.000Z" },
  ];

  const timeline = buildConversationTimeline(transcript, []);

  assert.equal(timeline.length, 2);
  assert.equal(timeline[0].speaker, "you");
  assert.deepEqual(timeline[0].utterances, transcript.slice(0, 3));
  assert.equal(timeline[1].speaker, "partner");
  assert.deepEqual(timeline[1].utterances, transcript.slice(3));
});

test("Partner action does not split one spoken turn and appears as a generic visual status", () => {
  const transcript = [
    { id: "you-1", speaker: "you", text: "Mostly infer it.", completed_at: "2026-07-21T07:44:33.000Z" },
    { id: "partner-1", speaker: "partner", text: "Got it—let me think.", completed_at: "2026-07-21T07:44:34.000Z" },
    { id: "partner-2", speaker: "partner", text: "Then it should mostly infer structure.", completed_at: "2026-07-21T07:44:41.000Z" },
  ];
  const operations = [{
    id: "operation-secret",
    type: "create_bubble",
    actor: "partner",
    created_at: "2026-07-21T07:44:37.000Z",
    affected_ids: ["node-secret"],
  }];

  const timeline = buildConversationTimeline(transcript, operations);

  assert.equal(timeline.length, 2);
  assert.deepEqual(timeline[1].utterances.map(({ id }) => id), ["partner-1", "partner-2"]);
  assert.deepEqual(timeline[1].actions, [{
    id: "operation-secret",
    label: "Created a bubble",
    createdAt: "2026-07-21T07:44:37.000Z",
  }]);
  assert.doesNotMatch(JSON.stringify(timeline[1].actions), /node-secret/);
});

test("conversation action labels cover map changes without exposing their targets", () => {
  assert.equal(modelActionLabel({ type: "create_bubble" }), "Created a bubble");
  assert.equal(modelActionLabel({ type: "edit_bubble" }), "Edited a bubble");
  assert.equal(modelActionLabel({ type: "set_central_idea" }), "Changed the central idea");
  assert.equal(modelActionLabel({ type: "delete_bubble" }), "Removed a bubble");
  assert.equal(modelActionLabel({ type: "connect_bubbles" }), "Created a new connection");
  assert.equal(modelActionLabel({ type: "delete_connection" }), "Removed a connection");
  assert.equal(modelActionLabel({ type: "append_utterance" }), null);
});

test("conversation presentation shows only Partner-side map actions", () => {
  const transcript = [{
    id: "partner-1",
    speaker: "partner",
    text: "What should we explore next?",
    completed_at: "2026-07-21T07:44:41.000Z",
  }];
  const operations = [
    { id: "append", type: "append_utterance", actor: "partner", created_at: "2026-07-21T07:44:41.000Z" },
    { id: "manual", type: "delete_bubble", actor: "you", created_at: "2026-07-21T07:44:42.000Z" },
    { id: "curator", type: "connect_bubbles", actor: "curator", created_at: "2026-07-21T07:44:40.000Z" },
  ];

  const timeline = buildConversationTimeline(transcript, operations);

  assert.deepEqual(timeline[0].actions.map(({ label }) => label), ["Created a new connection"]);
});

test("map controller activity stays quiet until it remains active for two seconds", () => {
  const controller = { status: "running", last_error: null };

  assert.equal(mapControllerPresentation(controller, { activeVisible: false }), null);
  assert.deepEqual(mapControllerPresentation(controller, { activeVisible: true }), {
    kind: "active",
    label: "Organizing map…",
  });
});

test("controller activity delay is scoped to one active session and clears stale timers", () => {
  const timers = [];
  const cleared = [];
  const states = [];
  const delay = createMapControllerActivityDelay({
    delayMs: 2_000,
    setTimer: (callback, milliseconds) => {
      const timer = { callback, milliseconds };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => cleared.push(timer),
    onChange: (state) => states.push(state),
  });

  delay.update({ id: "session-a", map_controller: { status: "waiting" } });
  assert.deepEqual(delay.state(), { sessionId: "session-a", active: true, visible: false });
  assert.equal(timers[0].milliseconds, 2_000);

  delay.update({ id: "session-b", map_controller: { status: "running" } });
  assert.deepEqual(delay.state(), { sessionId: "session-b", active: true, visible: false });
  assert.deepEqual(cleared, [timers[0]]);
  timers[0].callback();
  assert.equal(delay.state().visible, false, "a stale session timer cannot reveal the status");

  timers[1].callback();
  assert.deepEqual(delay.state(), { sessionId: "session-b", active: true, visible: true });
  delay.update({ id: "session-b", map_controller: { status: "idle" } });
  assert.deepEqual(delay.state(), { sessionId: "session-b", active: false, visible: false });
  delay.update({ id: "session-b", map_controller: { status: "waiting" } });
  assert.deepEqual(delay.state(), { sessionId: "session-b", active: true, visible: false });
  assert.equal(timers.length, 3, "a later run in the same session gets a fresh delay");
  delay.dispose();
  assert.ok(states.length >= 3);
});

test("a controller error is recoverable and an active retry suppresses the stale error", () => {
  const failed = {
    status: "error",
    last_error: { code: "transient", message: "Temporary failure", at: "2026-07-21T08:00:00.000Z" },
  };
  const retrying = { ...failed, status: "waiting" };

  assert.deepEqual(mapControllerPresentation(failed, { activeVisible: false }), {
    kind: "error",
    label: "Map organization paused",
  });
  assert.equal(mapControllerPresentation(retrying, { activeVisible: false }), null);
  assert.deepEqual(mapControllerPresentation(retrying, { activeVisible: true }), {
    kind: "active",
    label: "Organizing map…",
  });
});

test("a map-controller snapshot reconciles into the same generic Partner action timeline", () => {
  const snapshot = {
    revision: 11,
    map_controller: { status: "idle", last_error: null },
    operations: [{
      id: "controller-operation",
      type: "create_bubble",
      actor: "partner",
      origin: "map_controller",
      created_at: "2026-07-21T08:00:00.000Z",
      affected_ids: ["private-node-id"],
    }],
  };

  const timeline = buildConversationTimeline([], snapshot.operations);

  assert.deepEqual(timeline, [{
    id: "turn-action-controller-operation",
    speaker: "partner",
    utterances: [],
    actions: [{
      id: "controller-operation",
      label: "Created a bubble",
      createdAt: "2026-07-21T08:00:00.000Z",
    }],
  }]);
  assert.doesNotMatch(timeline[0].actions[0].label, /controller|private-node-id|map_controller/i);
});

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
  assert.match(sessionSource, /includeGhosts: true/);
  assert.match(sessionSource, /withWobble\(released, 1, 0, 0\.082\)/);
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

test("proposal bubbles are initially placed clear of committed bubbles", () => {
  const nodes = [
    { id: "root", x: 500, y: 500, r: 70, depth: 0, ghost: false },
    { id: "blocker", x: 650, y: 360, r: 82, depth: 1, ghost: false },
  ];
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

  const ghost = proposalVisuals(proposals, nodes).ghostNodes[0];
  nodes.forEach((node) => {
    assert.ok(
      Math.hypot(ghost.x - node.x, ghost.y - node.y) >= ghost.r + node.r + 20,
      `proposal overlaps ${node.id}`,
    );
  });
});

test("proposal visuals preserve a browser-local dragged position", () => {
  const nodes = [{ id: "root", x: 500, y: 500, r: 70, depth: 0, ghost: false }];
  const proposals = [{
    id: "proposal-1",
    status: "pending",
    operations: [{
      id: "proposal-operation-1",
      type: "create_bubble",
      node_id: "ghost-child",
      parent: "root",
      text: "A movable proposal",
      excluded: false,
    }],
  }];
  const positions = new Map([["ghost-child", { x: 940, y: 710 }]]);

  const ghost = proposalVisuals(proposals, nodes, positions).ghostNodes[0];
  assert.deepEqual({ x: ghost.x, y: ghost.y }, { x: 940, y: 710 });
});

test("proposal visuals preserve browser-local transient physics", () => {
  const nodes = [{ id: "root", x: 500, y: 500, r: 70, depth: 0, ghost: false }];
  const proposals = [{
    id: "proposal-1",
    status: "pending",
    operations: [{
      id: "proposal-operation-1",
      type: "create_bubble",
      node_id: "ghost-child",
      parent: "root",
      text: "A physical proposal",
      excluded: false,
    }],
  }];
  const wobblePulses = [{ startAt: 100, amplitude: 0.08, forceX: 1, forceY: 0 }];
  const motion = new Map([["ghost-child", {
    x: 940,
    y: 710,
    vx: 2.4,
    vy: -1.2,
    dragging: false,
    shadeVx: 3,
    shadeVy: -2,
    wobblePulses,
    wobbleEndAt: 640,
  }]]);

  const ghost = proposalVisuals(proposals, nodes, motion).ghostNodes[0];
  assert.deepEqual(
    {
      x: ghost.x,
      y: ghost.y,
      vx: ghost.vx,
      vy: ghost.vy,
      dragging: ghost.dragging,
      shadeVx: ghost.shadeVx,
      shadeVy: ghost.shadeVy,
      wobblePulses: ghost.wobblePulses,
      wobbleEndAt: ghost.wobbleEndAt,
    },
    {
      x: 940,
      y: 710,
      vx: 2.4,
      vy: -1.2,
      dragging: false,
      shadeVx: 3,
      shadeVy: -2,
      wobblePulses,
      wobbleEndAt: 640,
    },
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
