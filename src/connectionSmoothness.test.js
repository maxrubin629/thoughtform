import assert from "node:assert/strict";
import test from "node:test";
import { buildFluidVisualNodes, withWobble } from "./canvas/nodeMotion.js";
import { WOBBLE_DURATION, PAPER_MATERIAL_SETTINGS, CONNECTION_POP_DURATION } from "./canvas/materialSettings.js";
import { attachmentAngleLimits, bridgeMetrics, bridgeOutline, traceBridgeSection } from "./canvas/bridgeGeometry.js";
import { connectionPopFronts, getConnectionPopImpactTimes } from "./canvas/connectionPop.js";
import { applyConnectionGrowthMotion, buildConnectionPopTransition } from "./connectionVisualMotion.js";

const node = { id: "a", x: 100, y: 150, r: 60 };
const visual = (value, now, reduced = false) => buildFluidVisualNodes([value], now, reduced).get(value.id);
const ellipse = (value) => {
  const c = Math.cos(value.rotation), s = Math.sin(value.rotation);
  return [value.x, value.y, value.radiusX ** 2 * c ** 2 + value.radiusY ** 2 * s ** 2,
    value.radiusX ** 2 * s ** 2 + value.radiusY ** 2 * c ** 2,
    (value.radiusX ** 2 - value.radiusY ** 2) * c * s];
};

test("a contact pulse starts and finishes at rest without a size or position jump", () => {
  const moving = withWobble(node, 0.6, 0.8, 0.1, { startAt: 1000 });
  assert.deepEqual(ellipse(visual(moving, 1000)), ellipse(visual(node, 1000)));
  const first = ellipse(visual(moving, 1000.01)), rest = ellipse(visual(node, 1000));
  first.forEach((value, index) => assert.ok(Math.abs(value - rest[index]) < 0.000001));
  assert.deepEqual(ellipse(visual(moving, 1000 + WOBBLE_DURATION)), rest);
  assert.ok(visual(moving, 1080).radiusX - visual(moving, 1080).radiusY > 1);
});

test("overlapping directional responses have continuous shape when their strengths cross", () => {
  const moving = withWobble(withWobble(node, 1, 0, 0.1, { startAt: 0 }),
    0, 1, 0.08, { startAt: 100, append: true });
  let previous = ellipse(visual(moving, 0));
  for (let time = 0.25; time <= 800; time += 0.25) {
    const current = ellipse(visual(moving, time));
    current.forEach((value, index) => assert.ok(Math.abs(value - previous[index]) < 6,
      `shape jump at ${time}ms in component ${index}`));
    previous = current;
  }
});

test("a new connection retains an active response until its scheduled return can blend in", () => {
  const active = withWobble(node, 0, 1, 0.08, { startAt: 900 });
  const target = { id: "b", x: 320, y: 150, r: 48 };
  const animated = applyConnectionGrowthMotion([active, target], { from: "a", to: "b", createdAt: 1000 });
  assert.deepEqual(ellipse(visual(animated[0], 1000)), ellipse(visual(active, 1000)));
  assert.equal(animated[0].wobblePulses.length, 3);
});

test("a newly created lobe settles continuously while a connection pulse changes direction", () => {
  const growing = withWobble(withWobble({ ...node, createdAt: 0 }, 1, 0, 0.1, { startAt: 240 }),
    0, 1, 0.08, { startAt: 320, append: true });
  let previous = ellipse(visual(growing, 322));
  for (let time = 322.25; time <= 600; time += 0.25) {
    const current = ellipse(visual(growing, time));
    current.forEach((value, index) => assert.ok(Math.abs(value - previous[index]) < 8,
      `creation/connection shape jump at ${time}ms in component ${index}`));
    previous = current;
  }
});

test("rupture fronts and endpoint responses arrive on the same clock for off-center clicks", () => {
  const a = { ...node, radius: 60 }, b = { id: "b", x: 380, y: 150, radius: 42 };
  const metrics = bridgeMetrics(a, b, PAPER_MATERIAL_SETTINGS);
  for (const origin of [0.02, 0.2, 0.5, 0.8, 0.98]) {
    const hitT = (metrics.edgeA + origin * (metrics.distance - metrics.edgeA - metrics.edgeB)) / metrics.distance;
    const times = getConnectionPopImpactTimes(1000, hitT, CONNECTION_POP_DURATION, a, b, PAPER_MATERIAL_SETTINGS);
    const atSource = connectionPopFronts((times.source - 1000) / CONNECTION_POP_DURATION, origin);
    const atTarget = connectionPopFronts((times.target - 1000) / CONNECTION_POP_DURATION, origin);
    assert.ok(atSource.source < 0.000001);
    assert.ok(1 - atTarget.target < 0.000001);
    assert.ok(connectionPopFronts((times.source - 1001) / CONNECTION_POP_DURATION, origin).source > 0);
    assert.ok(connectionPopFronts((times.target - 1001) / CONNECTION_POP_DURATION, origin).target < 1);
  }
});

test("retreating sections keep the original attachment and never emit invalid geometry", () => {
  const a = { ...node, radius: 60 }, b = { x: 380, y: 280, radius: 42 };
  const outline = bridgeOutline(a, b, PAPER_MATERIAL_SETTINGS, { a: 0.14, b: 0.2 });
  for (const end of [1, 0.7, 0.2, 0.001]) {
    const commands = [];
    const path = Object.fromEntries(["moveTo", "lineTo", "bezierCurveTo", "closePath"].map((name) =>
      [name, (...args) => commands.push([name, ...args])]));
    assert.equal(traceBridgeSection(path, outline, 0, end, 0, 1), true);
    assert.deepEqual(commands[0], ["moveTo", outline.top[0][0].x, outline.top[0][0].y]);
    assert.ok(commands.every(([, ...values]) => values.every(Number.isFinite)));
  }
});

test("canonical removals retain crowded-junction geometry from the previous graph", () => {
  const nodes = [node, { id: "b", x: 380, y: 150, r: 42 }, { id: "c", x: 350, y: 190, r: 35 }];
  const edge = { from: "a", to: "b" };
  const links = [edge, { from: "a", to: "c" }];
  const transition = buildConnectionPopTransition(nodes, edge, {}, { start: 1000, links });
  const expected = attachmentAngleLimits(nodes[0], nodes[1], links, nodes);
  assert.deepEqual(transition.pop.angleLimits, expected);
  assert.ok(expected.a < 0.2);
  assert.deepEqual(transition.impacts, getConnectionPopImpactTimes(1000, 0.5,
    CONNECTION_POP_DURATION, nodes[0], nodes[1], PAPER_MATERIAL_SETTINGS, expected));
});

test("reduced motion removes both inertial stretch and connection deformation", () => {
  const moving = withWobble({ ...node, vx: 12, vy: 7 }, 1, 1, 0.1, { startAt: 0 });
  assert.deepEqual(ellipse(visual(moving, 80, true)), ellipse(visual(node, 80, true)));
  assert.equal(visual(moving, 80, true).motionShadeStrength, 0);
});
