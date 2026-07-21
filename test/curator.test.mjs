import test from "node:test";
import assert from "node:assert/strict";
import {
  CURATOR_PROPOSAL_SCHEMA,
  createCurator,
  createCuratorScheduler,
  isCuratorEnabled,
  shouldRunCurator,
} from "../server/curator.mjs";

function snapshot(overrides = {}) {
  return {
    id: "session-1",
    title: "Untitled map",
    revision: 4,
    transcript: [
      { id: "u1", speaker: "you", text: "Voice should make the map feel immediate." },
      { id: "p1", speaker: "partner", text: "What makes it immediate?" },
      { id: "u2", speaker: "you", text: "The structure should appear after I finish a thought." },
    ],
    nodes: [
      { id: "n1", text: "Voice makes maps immediate", sources: [] },
      { id: "n2", text: "Structure after complete thoughts", sources: [] },
    ],
    edges: [],
    proposals: [],
    ...overrides,
  };
}

test("curator is environment gated and skips ineligible snapshots", () => {
  assert.equal(isCuratorEnabled({}), true);
  assert.equal(isCuratorEnabled({ THOUGHTFORM_CURATOR_ENABLED: "false" }), false);
  assert.equal(isCuratorEnabled({ THOUGHTFORM_CURATOR_ENABLED: "TRUE" }), true);
  assert.equal(shouldRunCurator(snapshot()), true);
  assert.equal(shouldRunCurator(snapshot({ transcript: [{ speaker: "you", text: "one" }] })), false);
  assert.equal(shouldRunCurator(snapshot({ proposals: [{ status: "pending" }] })), false);
  assert.equal(shouldRunCurator(snapshot({
    proposals: Array.from({ length: 3 }, (_, index) => ({
      id: `curator-${index}`,
      actor: "curator",
      status: "dismissed",
    })),
  })), false);
});

test("disabled curator does not call the Responses API", async () => {
  let called = false;
  const curator = createCurator({
    env: { THOUGHTFORM_CURATOR_ENABLED: "false" },
    client: { responses: { create: async () => { called = true; } } },
  });
  assert.equal(curator.enabled, false);
  assert.equal(await curator.propose(snapshot()), null);
  assert.equal(called, false);
});

test("enabled curator creates a canonical proposal through structured Responses output", async () => {
  let request;
  const client = {
    responses: {
      create: async (payload) => {
        request = payload;
        return {
          output_text: JSON.stringify({
            rationale: "These ideas describe the same conversational loop.",
            evidence: [
              { utterance_id: "u1", quote: "Voice should make the map feel immediate." },
              { utterance_id: "u2", quote: "structure should appear after I finish a thought" },
              { utterance_id: "u2", quote: "structure should appear after I finish a thought" },
            ],
            operations: [{
              id: null,
              type: "connect_bubbles",
              node_id: null,
              from: "n1",
              to: "n2",
              edge_id: null,
              text: null,
              depth: null,
              x: null,
              y: null,
              parent: null,
              quote: null,
              utterance_id: null,
              excluded: false,
            }],
          }),
        };
      },
    },
  };
  let sequence = 0;
  const curator = createCurator({
    env: {
      THOUGHTFORM_CURATOR_ENABLED: "true",
      OPENAI_CURATOR_MODEL: "curator-test-model",
    },
    client,
    now: () => new Date("2026-07-20T12:00:00.000Z"),
    idFactory: (prefix) => `${prefix}-${++sequence}`,
  });

  const proposal = await curator.propose(snapshot());
  assert.equal(request.model, "curator-test-model");
  assert.equal(request.text.format.strict, true);
  assert.equal(request.text.format.schema, CURATOR_PROPOSAL_SCHEMA);
  assert.equal(CURATOR_PROPOSAL_SCHEMA.properties.operations.maxItems, 3);
  assert.deepEqual(JSON.parse(request.input).nodes.map((node) => node.id), ["n1", "n2"]);
  assert.equal(proposal.id, "proposal-1");
  assert.equal(proposal.base_revision, 4);
  assert.equal(proposal.actor, "curator");
  assert.equal(proposal.status, "pending");
  assert.deepEqual(proposal.evidence, [
    {
      utterance_id: "u1",
      start: 0,
      end: 41,
      quote: "Voice should make the map feel immediate.",
    },
    {
      utterance_id: "u2",
      start: 4,
      end: 52,
      quote: "structure should appear after I finish a thought",
    },
  ]);
  assert.equal(proposal.operations[0].id, "proposal_operation-2");
  assert.equal(proposal.operations[0].type, "connect_bubbles");
  assert.equal(proposal.created_at, "2026-07-20T12:00:00.000Z");
});

test("curator returns no card for an empty recommendation", async () => {
  const curator = createCurator({
    env: { THOUGHTFORM_CURATOR_ENABLED: "true" },
    client: { responses: { create: async () => ({ output_text: '{"rationale":"No change","evidence":[],"operations":[]}' }) } },
  });
  assert.equal(await curator.propose(snapshot()), null);
});

test("curator sends bounded recent conversation context and defaults to Sol", async () => {
  let request;
  const curator = createCurator({
    env: { THOUGHTFORM_CURATOR_ENABLED: "true" },
    client: { responses: { create: async (payload) => {
      request = payload;
      return { output_text: '{"rationale":"No change","evidence":[],"operations":[]}' };
    } } },
  });
  const transcript = Array.from({ length: 12 }, (_, index) => ({
    id: `utterance-${index}`,
    speaker: index % 2 ? "partner" : "you",
    text: `Utterance ${index}`,
  }));

  await curator.propose(snapshot({ transcript }));

  assert.equal(curator.model, "gpt-5.6-sol");
  assert.deepEqual(
    JSON.parse(request.input).transcript.map(({ id }) => id),
    transcript.slice(-8).map(({ id }) => id),
  );
});

test("scheduler debounces and reloads the latest canonical snapshot", async () => {
  const queued = [];
  const cleared = [];
  const proposals = [];
  const curator = {
    enabled: true,
    shouldRun: () => true,
    propose: async (value) => ({ id: `p-${value.revision}` }),
  };
  const scheduler = createCuratorScheduler({
    curator,
    loadSnapshot: async () => snapshot({ revision: 9 }),
    onProposal: async (sessionId, proposal) => proposals.push([sessionId, proposal.id]),
    setTimer: (callback) => { queued.push(callback); return queued.length; },
    clearTimer: (timer) => cleared.push(timer),
  });

  assert.equal(scheduler.notify("session-1"), true);
  assert.equal(scheduler.notify("session-1"), true);
  assert.deepEqual(cleared, [1]);
  await queued[1]();
  assert.deepEqual(proposals, [["session-1", "p-9"]]);
  scheduler.dispose();
});

test("scheduler runs again for a new user turn at the same map revision", async () => {
  const queued = [];
  const proposals = [];
  let current = snapshot({ revision: 9 });
  const curator = {
    enabled: true,
    shouldRun: () => true,
    propose: async (value) => ({ id: `p-${value.transcript.length}` }),
  };
  const scheduler = createCuratorScheduler({
    curator,
    loadSnapshot: async () => current,
    onProposal: async (_sessionId, proposal) => proposals.push(proposal.id),
    minimumUserTurnsBetweenRuns: 1,
    setTimer: (callback) => { queued.push(callback); return queued.length; },
    clearTimer: () => {},
  });

  scheduler.notify("session-1");
  await queued[0]();
  current = snapshot({
    revision: 9,
    transcript: [
      ...current.transcript,
      { id: "u3", speaker: "you", text: "A later thought at the same map revision." },
    ],
  });
  scheduler.notify("session-1");
  await queued[1]();

  assert.deepEqual(proposals, ["p-3", "p-4"]);
  scheduler.dispose();
});

test("scheduler waits for three new user turns before spending attention again", async () => {
  const queued = [];
  const proposals = [];
  let current = snapshot({ revision: 9 });
  const curator = {
    enabled: true,
    shouldRun: () => true,
    propose: async (value) => ({ id: `p-${value.transcript.length}` }),
  };
  const scheduler = createCuratorScheduler({
    curator,
    loadSnapshot: async () => current,
    onProposal: async (_sessionId, proposal) => proposals.push(proposal.id),
    minimumUserTurnsBetweenRuns: 3,
    setTimer: (callback) => { queued.push(callback); return queued.length; },
    clearTimer: () => {},
  });

  scheduler.notify("session-1");
  await queued.shift()();
  current = snapshot({
    revision: 10,
    transcript: [
      ...current.transcript,
      { id: "u3", speaker: "you", text: "One more thought." },
      { id: "p2", speaker: "partner", text: "Keep going." },
      { id: "u4", speaker: "you", text: "A second new thought." },
    ],
  });
  scheduler.notify("session-1");
  await queued.shift()();
  assert.deepEqual(proposals, ["p-3"]);

  current = snapshot({
    revision: 11,
    transcript: [
      ...current.transcript,
      { id: "u5", speaker: "you", text: "A third new thought." },
    ],
  });
  scheduler.notify("session-1");
  await queued.shift()();
  assert.deepEqual(proposals, ["p-3", "p-7"]);
  scheduler.dispose();
});

test("scheduler reschedules instead of overlapping an active map-controller pass", async () => {
  const queued = [];
  const proposals = [];
  let controllerBusy = true;
  const curator = {
    enabled: true,
    shouldRun: () => true,
    propose: async () => ({ id: "proposal-after-controller" }),
  };
  const scheduler = createCuratorScheduler({
    curator,
    loadSnapshot: async () => snapshot(),
    onProposal: async (_sessionId, proposal) => proposals.push(proposal.id),
    isBlocked: () => controllerBusy,
    setTimer: (callback) => { queued.push(callback); return queued.length; },
    clearTimer: () => {},
  });

  scheduler.notify("session-1");
  await queued.shift()();
  assert.deepEqual(proposals, []);
  assert.equal(queued.length, 1);

  controllerBusy = false;
  await queued.shift()();
  assert.deepEqual(proposals, ["proposal-after-controller"]);
  scheduler.dispose();
});
