import assert from "node:assert/strict";
import test from "node:test";
import { applyOperation } from "../server/sessionOperations.mjs";
import {
  utterance, session, storeHarness, jsonResponse, requestDocument, requestEnvelope, noChange, deferred, controllerFor,
} from "./helpers/mapController.mjs";

test("post-watermark evidence cannot commit even when transcript append does not change revision", async () => {
  const initial = session({ transcript: [utterance(0, "you", "Original thought")] });
  const store = storeHarness(initial);
  let release;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const firstResponse = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const controller = controllerFor(store, {
    client: { responses: { create: async () => {
      calls += 1;
      if (calls === 1) {
        started();
        return firstResponse;
      }
      return jsonResponse(noChange, "repair");
    } } },
    idFactory: (kind) => `${kind}-watermark-evidence`,
  });
  const running = controller.run("session-1", { watermark: 1 });
  await startedPromise;
  store.replace({
    ...store.current,
    transcript: [...store.current.transcript, utterance(1, "you", "New private arrival")],
  });
  release(jsonResponse({
    decision: "apply",
    operations: [{
      type: "create_bubble",
      temp_id: "late",
      node_id: null,
      from: null,
      to: null,
      parent: null,
      text: "Private arrival",
      evidence: [{ utterance_id: "u-1", quote: "private arrival" }],
    }],
    proposal: null,
  }, "late"));

  await running;

  assert.equal(calls, 2, "invalid late evidence receives one fresh repair request");
  assert.equal(store.current.nodes.length, 0);
  assert.equal(store.current.map_controller.processed_transcript_count, 1);
});

test("applies ordered temporary references and exact evidence atomically", async () => {
  const initial = session({ transcript: [utterance(0, "you", "Build a voice map with exact provenance.")] });
  const store = storeHarness(initial);
  let sequence = 0;
  const controller = controllerFor(store, {
    client: { responses: { create: async () => jsonResponse({
      decision: "apply",
      operations: [
        {
          type: "set_central_idea",
          temp_id: "root",
          node_id: null,
          from: null,
          to: null,
          parent: null,
          text: "Voice map",
          evidence: [{ utterance_id: "u-0", quote: "voice map" }],
        },
        {
          type: "create_bubble",
          temp_id: "detail",
          node_id: null,
          from: null,
          to: null,
          parent: "root",
          text: "Exact provenance",
          evidence: [{ utterance_id: "u-0", quote: "exact provenance" }],
        },
      ],
      proposal: null,
    }) } },
    idFactory: (kind) => `${kind}-${++sequence}`,
  });

  const result = await controller.run("session-1", { watermark: 1 });

  assert.equal(result.decision, "apply");
  assert.equal(store.current.nodes.length, 2);
  assert.equal(store.current.nodes[0].depth, 0);
  assert.equal(store.current.edges[0].from, store.current.nodes[0].id);
  assert.equal(store.current.edges[0].to, store.current.nodes[1].id);
  assert.equal(store.current.nodes[0].sources[0].quote, "voice map");
  assert.ok(store.current.operations.slice(-2).every((operation) => operation.origin === "map_controller"));
  assert.ok(store.current.operations.slice(-2).every((operation) => operation.actor === "partner"));
  assert.match(store.current.operations.at(-1).call_id, /^map-controller-/);
  assert.equal(store.current.map_controller.processed_transcript_count, 1);
  assert.equal(store.current.map_controller.last_error, null);
});

test("rejects a whole invalid decision and repairs it once without carrying response state", async () => {
  const initial = session({ transcript: [utterance(0, "you", "A complete idea")] });
  const store = storeHarness(initial);
  const requests = [];
  const replies = [
    jsonResponse({
      decision: "apply",
      operations: [
        { type: "create_bubble", temp_id: "one", node_id: null, from: null, to: null, parent: null, text: "Complete idea", evidence: [] },
        { type: "connect_bubbles", temp_id: null, node_id: null, from: "one", to: "missing", parent: null, text: null, evidence: [] },
      ],
      proposal: null,
    }, "bad"),
    jsonResponse(noChange, "repaired"),
  ];
  const controller = controllerFor(store, {
    client: { responses: { create: async (payload) => { requests.push(payload); return replies.shift(); } } },
    idFactory: (kind) => `${kind}-repair`,
  });

  await controller.run("session-1", { watermark: 1 });

  assert.equal(requests.length, 2);
  assert.equal(requests[1].previous_response_id, undefined);
  assert.match(requestDocument(requests[1]).repair, /repair/i);
  assert.equal(store.current.nodes.length, 0, "the failed batch did not partially persist");
  assert.equal(store.current.map_controller.processed_transcript_count, 1);
});

test("reruns the fixed transcript range against a fresh map after a revision conflict", async () => {
  const initial = session({ transcript: [utterance(0, "you", "Stable delta")] });
  const store = storeHarness(initial);
  const requests = [];
  let conflicted = false;
  const transact = async (sessionId, transform) => {
    if (!conflicted) {
      conflicted = true;
      const latest = store.current;
      store.replace({ ...latest, revision: 1 });
    }
    return store.transact(sessionId, transform);
  };
  const controller = controllerFor(store, {
    client: { responses: { create: async (payload) => { requests.push(payload); return jsonResponse(noChange, `r-${requests.length}`); } } },
    transact,
    idFactory: (kind) => `${kind}-conflict`,
  });

  await controller.run("session-1", { watermark: 1 });

  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map((request) => requestEnvelope(request).base_revision), [0, 1]);
  assert.deepEqual(requests.map((request) => requestEnvelope(request).transcript_delta.map(({ id }) => id)), [["u-0"], ["u-0"]]);
});

test("proposal operations preserve and validate every exact evidence entry", async () => {
  const initial = session({
    transcript: [
      utterance(0, "you", "First exact source"),
      utterance(1, "you", "Second exact source"),
    ],
  });
  const store = storeHarness(initial);
  const controller = controllerFor(store, {
    client: { responses: { create: async () => jsonResponse({
      decision: "apply",
      operations: [],
      proposal: {
        rationale: "A reviewable sourced idea.",
        evidence: [],
        operations: [{
          type: "create_bubble",
          temp_id: "proposal-node",
          node_id: null,
          from: null,
          to: null,
          parent: null,
          text: "Two exact sources",
          evidence: [
            { utterance_id: "u-0", quote: "First exact source" },
            { utterance_id: "u-1", quote: "Second exact source" },
          ],
        }],
      },
    }) } },
    idFactory: (kind) => `${kind}-proposal-evidence`,
  });

  await controller.run("session-1", { watermark: 2 });

  assert.equal(store.current.proposals.length, 1);
  assert.deepEqual(
    store.current.proposals[0].operations[0].sources.map(({ utterance_id, quote }) => ({ utterance_id, quote })),
    [
      { utterance_id: "u-0", quote: "First exact source" },
      { utterance_id: "u-1", quote: "Second exact source" },
    ],
  );
});

test("an invalid later proposal-operation evidence entry rejects the whole decision", async () => {
  const initial = session({ transcript: [utterance(0, "you", "Only valid source")] });
  const store = storeHarness(initial);
  let calls = 0;
  const controller = controllerFor(store, {
    client: { responses: { create: async () => {
      calls += 1;
      if (calls > 1) return jsonResponse(noChange, "repair");
      return jsonResponse({
        decision: "apply",
        operations: [],
        proposal: {
          rationale: "Must validate all evidence.",
          evidence: [],
          operations: [{
            type: "create_bubble",
            temp_id: "proposal-node",
            node_id: null,
            from: null,
            to: null,
            parent: null,
            text: "Invalid second source",
            evidence: [
              { utterance_id: "u-0", quote: "Only valid source" },
              { utterance_id: "u-0", quote: "not present" },
            ],
          }],
        },
      }, "invalid-proposal");
    } } },
    idFactory: (kind) => `${kind}-invalid-proposal`,
  });

  await controller.run("session-1", { watermark: 1 });

  assert.equal(calls, 2);
  assert.equal(store.current.proposals.length, 0);
});

test("passes AbortSignal to Responses and aborts an in-flight request before commit", async () => {
  const initial = session({ transcript: [utterance(0, "you", "Do not commit late")] });
  const store = storeHarness(initial);
  let receivedSignal;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const controller = controllerFor(store, {
    client: { responses: { create: async (_payload, options) => {
      receivedSignal = options?.signal;
      markStarted();
      return new Promise((_resolve, reject) => {
        receivedSignal?.addEventListener("abort", () => reject(receivedSignal.reason), { once: true });
      });
    } } },
    idFactory: (kind) => `${kind}-cancel`,
  });
  const abortController = new AbortController();
  const running = controller.run("session-1", { watermark: 1, signal: abortController.signal });
  await started;
  assert.equal(receivedSignal, abortController.signal);
  abortController.abort(new Error("cancelled"));

  await assert.rejects(running, /cancelled/);
  assert.equal(store.current.map_controller.processed_transcript_count, 0);
});

test("one controller interpretation undoes as a whole while preserving transcript", async () => {
  const store = storeHarness(session({ transcript: [utterance(0, "you", "Voice maps need source spans.")] }));
  const controller = controllerFor(store, {
    client: { responses: { create: async () => jsonResponse({
      decision: "apply",
      operations: [
        { type: "create_bubble", temp_id: "root", text: "Voice maps", evidence: [{ utterance_id: "u-0", quote: "Voice maps" }] },
        { type: "create_bubble", temp_id: "detail", parent: "root", text: "Source spans", evidence: [{ utterance_id: "u-0", quote: "source spans" }] },
      ],
      proposal: null,
    }) } },
  });
  await controller.run("session-1");
  assert.equal(store.current.history_cursor, 1);
  assert.equal(store.current.operations.length, 1);
  assert.equal(store.current.operations[0].type, "apply_map_batch");
  assert.deepEqual(store.current.operations[0].source_utterance_ids, ["u-0"]);
  const undone = applyOperation(store.current, { type: "undo_map_change" }).session;
  assert.equal(undone.nodes.length, 0);
  assert.equal(undone.edges.length, 0);
  assert.deepEqual(undone.transcript, store.current.transcript);
  assert.equal(undone.map_controller.processed_transcript_count, 1);
});

test("mapping paused before a request spends no API call and retains its cursor", async () => {
  const store = storeHarness(session({
    transcript: [utterance(0)],
    preferences: { mapping_paused: true, partner_mode: "proactive" },
  }));
  let called = false;
  const controller = controllerFor(store, {
    client: { responses: { create: async () => { called = true; return jsonResponse(noChange); } } },
  });
  const result = await controller.run("session-1");
  assert.equal(result.paused, true);
  assert.equal(called, false);
  assert.equal(store.current.map_controller.processed_transcript_count, 0);
});

test("pausing during model work blocks late writes and resuming maps the backlog", async () => {
  const store = storeHarness(session({ transcript: [utterance(0)] }));
  const started = deferred();
  const response = deferred();
  let calls = 0;
  const controller = controllerFor(store, {
    client: { responses: { create: async () => {
      calls += 1;
      if (calls === 1) { started.resolve(); return response.promise; }
      return jsonResponse(noChange);
    } } },
  });
  const running = controller.run("session-1");
  await started.promise;
  store.replace({ ...store.current, preferences: { mapping_paused: true, partner_mode: "proactive" } });
  response.resolve(jsonResponse({
    decision: "apply", operations: [{ type: "create_bubble", text: "Late thought", evidence: [] }], proposal: null,
  }));
  assert.equal((await running).paused, true);
  assert.equal(store.current.nodes.length, 0);
  assert.equal(store.current.map_controller.processed_transcript_count, 0);
  store.replace({ ...store.current, preferences: { mapping_paused: false, partner_mode: "proactive" } });
  await controller.run("session-1");
  assert.equal(store.current.map_controller.processed_transcript_count, 1);
});

test("parked thoughts reject automatic edits and receive one repair", async () => {
  const seeded = applyOperation(session({ transcript: [utterance(0)] }), { type: "create_bubble", node_id: "parked", text: "Keep aside" }).session;
  seeded.nodes[0].parked = true;
  const store = storeHarness(seeded);
  let calls = 0;
  const controller = controllerFor(store, {
    client: { responses: { create: async () => {
      calls += 1;
      return jsonResponse(calls === 1 ? {
        decision: "apply", operations: [{ type: "edit_bubble", node_id: "parked", text: "Changed", evidence: [] }], proposal: null,
      } : noChange);
    } } },
  });
  await controller.run("session-1");
  assert.equal(calls, 2);
  assert.equal(store.current.nodes[0].text, "Keep aside");
});
