import assert from "node:assert/strict";
import test from "node:test";
import {
  MAP_CONTROLLER_OUTPUT_SCHEMA,
  MAP_CONTROLLER_SYSTEM,
  createMapController,
  createMapControllerScheduler,
  searchTranscript,
} from "../server/mapController.mjs";

const stamp = "2026-07-21T12:00:00.000Z";

function utterance(index, speaker = "you", text = `thought ${index}`) {
  return {
    id: `u-${index}`,
    realtime_item_id: `rt-${index}`,
    speaker,
    text,
    completed_at: stamp,
  };
}

function session(overrides = {}) {
  return {
    schema_version: 2,
    id: "session-1",
    title: "Untitled map",
    revision: 0,
    created_at: stamp,
    updated_at: stamp,
    transcript: [],
    nodes: [],
    edges: [],
    proposals: [],
    operations: [],
    history_cursor: 0,
    map_controller: {
      processed_transcript_count: 0,
      last_run_id: null,
      last_success_at: null,
      last_error: null,
    },
    ...overrides,
  };
}

function storeHarness(initial) {
  let current = structuredClone(initial);
  return {
    loadSnapshot: async () => structuredClone(current),
    transact: async (_sessionId, transform) => {
      const outcome = await transform(structuredClone(current));
      current = structuredClone(outcome.session ?? outcome);
      return outcome?.session ? { ...outcome, session: structuredClone(current) } : structuredClone(current);
    },
    get current() { return current; },
    replace(next) { current = structuredClone(next); },
  };
}

function jsonResponse(value, id = "response-1") {
  return { id, output_text: JSON.stringify(value), output: [] };
}

function requestDocument(request) {
  assert.ok(Array.isArray(request.input), "controller input is a structured message array");
  assert.equal(request.input[0].role, "developer");
  assert.ok(Array.isArray(request.input[0].content));
  assert.equal(request.input[0].content[0].type, "input_text");
  const document = JSON.parse(request.input[0].content[0].text);
  assert.equal(document.kind, "thoughtform_map_controller_evidence");
  return document;
}

function requestEnvelope(request) {
  return requestDocument(request).evidence;
}

const noChange = { decision: "no_change", operations: [], proposal: null };

test("builds a bounded untrusted-evidence envelope with the Sol defaults", async () => {
  const transcript = Array.from({ length: 13 }, (_, index) => utterance(index));
  const initial = session({
    revision: 7,
    transcript,
    map_controller: {
      processed_transcript_count: 10,
      last_run_id: null,
      last_success_at: null,
      last_error: null,
    },
    operations: [{
      id: "op-realtime",
      type: "revisit_bubble",
      actor: "partner",
      origin: "realtime",
      created_at: stamp,
      source_utterance_ids: ["u-11"],
    }],
  });
  const store = storeHarness(initial);
  let request;
  const controller = createMapController({
    env: {},
    client: { responses: { create: async (payload) => { request = payload; return jsonResponse(noChange); } } },
    loadSnapshot: store.loadSnapshot,
    transact: store.transact,
    now: () => new Date(stamp),
    idFactory: (kind) => `${kind}-test`,
  });

  await controller.run("session-1", { watermark: 13 });

  assert.equal(controller.model, "gpt-5.6-sol");
  assert.equal(request.model, "gpt-5.6-sol");
  assert.deepEqual(request.reasoning, { effort: "low" });
  assert.equal(request.instructions, MAP_CONTROLLER_SYSTEM);
  assert.equal(request.text.format.strict, true);
  assert.equal(request.text.format.schema, MAP_CONTROLLER_OUTPUT_SCHEMA);
  assert.equal(request.previous_response_id, undefined);
  const envelope = requestEnvelope(request);
  assert.equal(envelope.base_revision, 7);
  assert.equal(envelope.transcript_watermark, 13);
  assert.deepEqual(envelope.preceding_utterances.map(({ id }) => id), transcript.slice(2, 10).map(({ id }) => id));
  assert.deepEqual(envelope.transcript_delta.map(({ id }) => id), ["u-10", "u-11", "u-12"]);
  assert.deepEqual(envelope.relevant_realtime_operations.map(({ id }) => id), ["op-realtime"]);
  assert.ok(!request.input[0].content[0].text.includes("thought 1\""), "older transcript is absent from the ordinary request");
  assert.equal(store.current.map_controller.processed_transcript_count, 13);
});

test("search_transcript ranks normalized matches with context and caps results", () => {
  const transcript = [
    utterance(0, "you", "Opening context"),
    utterance(1, "you", "A Voice-Controlled mind map should feel immediate."),
    utterance(2, "partner", "What would make that work?"),
    ...Array.from({ length: 10 }, (_, index) => utterance(index + 3, "you", `voice map detail ${index}`)),
  ];
  const matches = searchTranscript(transcript, "VOICE controlled map");
  assert.equal(matches.length, 8);
  assert.equal(matches[0].utterance.id, "u-1");
  assert.equal(matches[0].previous.id, "u-0");
  assert.equal(matches[0].next.id, "u-2");
});

test("allows at most two transcript-search rounds and keeps response ids inside that loop", async () => {
  const initial = session({ transcript: [utterance(0, "you", "An old exact phrase") ] });
  const store = storeHarness(initial);
  const requests = [];
  const replies = [
    { id: "r1", output: [{ type: "function_call", name: "search_transcript", call_id: "c1", arguments: '{"query":"exact phrase"}' }] },
    { id: "r2", output: [{ type: "function_call", name: "search_transcript", call_id: "c2", arguments: '{"query":"old phrase"}' }] },
    jsonResponse(noChange, "r3"),
  ];
  const controller = createMapController({
    client: { responses: { create: async (payload) => { requests.push(payload); return replies.shift(); } } },
    loadSnapshot: store.loadSnapshot,
    transact: store.transact,
    idFactory: (kind) => `${kind}-search`,
  });

  await controller.run("session-1", { watermark: 1 });

  assert.equal(requests.length, 3);
  assert.equal(requests[0].previous_response_id, undefined);
  assert.equal(requests[1].previous_response_id, "r1");
  assert.equal(requests[2].previous_response_id, "r2");
  assert.equal(JSON.parse(requests[1].input[0].output).matches[0].utterance.id, "u-0");
});

test("shares the two-search budget with a fresh repair request", async () => {
  const initial = session({ transcript: [utterance(0, "you", "Searchable evidence")] });
  const store = storeHarness(initial);
  const requests = [];
  const replies = [
    { id: "s1", output: [{ type: "function_call", name: "search_transcript", call_id: "sc1", arguments: '{"query":"searchable"}' }] },
    { id: "s2", output: [{ type: "function_call", name: "search_transcript", call_id: "sc2", arguments: '{"query":"evidence"}' }] },
    { id: "invalid", output: [], output_text: "not json" },
    jsonResponse(noChange, "repair"),
  ];
  const controller = createMapController({
    client: { responses: { create: async (payload, options) => { requests.push([payload, options]); return replies.shift(); } } },
    loadSnapshot: store.loadSnapshot,
    transact: store.transact,
    idFactory: (kind) => `${kind}-budget`,
  });

  const abortController = new AbortController();
  await controller.run("session-1", { watermark: 1, signal: abortController.signal });

  assert.equal(requests.length, 4);
  assert.equal(requests[3][0].previous_response_id, undefined);
  assert.equal(requests[3][0].tools, undefined, "repair cannot open a third search round");
  assert.ok(requests.every(([, options]) => options?.signal === abortController.signal));
  assert.match(requestDocument(requests[3][0]).repair, /malformed JSON/i);
});

test("fixed watermark bounds transcript search after the transcript grows", async () => {
  const initial = session({ transcript: [utterance(0, "you", "Original evidence")] });
  const store = storeHarness(initial);
  const requests = [];
  let conflicted = false;
  const transact = async (sessionId, transform) => {
    if (!conflicted) {
      conflicted = true;
      store.replace({
        ...store.current,
        revision: 1,
        transcript: [...store.current.transcript, utterance(1, "you", "Post watermark secret")],
      });
    }
    return store.transact(sessionId, transform);
  };
  const replies = [
    jsonResponse(noChange, "first"),
    { id: "search", output: [{ type: "function_call", name: "search_transcript", call_id: "search-call", arguments: '{"query":"post watermark secret"}' }] },
    jsonResponse(noChange, "second"),
  ];
  const controller = createMapController({
    client: { responses: { create: async (payload) => { requests.push(payload); return replies.shift(); } } },
    loadSnapshot: store.loadSnapshot,
    transact,
    idFactory: (kind) => `${kind}-watermark-search`,
  });

  await controller.run("session-1", { watermark: 1 });

  const searchOutput = JSON.parse(requests[2].input[0].output);
  assert.deepEqual(searchOutput.matches, []);
  assert.deepEqual(requestEnvelope(requests[1]).transcript_delta.map(({ id }) => id), ["u-0"]);
});

test("post-watermark evidence cannot commit even when transcript append does not change revision", async () => {
  const initial = session({ transcript: [utterance(0, "you", "Original thought")] });
  const store = storeHarness(initial);
  let release;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const firstResponse = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const controller = createMapController({
    client: { responses: { create: async () => {
      calls += 1;
      if (calls === 1) {
        started();
        return firstResponse;
      }
      return jsonResponse(noChange, "repair");
    } } },
    loadSnapshot: store.loadSnapshot,
    transact: store.transact,
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
  const controller = createMapController({
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
    loadSnapshot: store.loadSnapshot,
    transact: store.transact,
    now: () => new Date(stamp),
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
  const controller = createMapController({
    client: { responses: { create: async (payload) => { requests.push(payload); return replies.shift(); } } },
    loadSnapshot: store.loadSnapshot,
    transact: store.transact,
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
  const controller = createMapController({
    client: { responses: { create: async (payload) => { requests.push(payload); return jsonResponse(noChange, `r-${requests.length}`); } } },
    loadSnapshot: store.loadSnapshot,
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
  const controller = createMapController({
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
    loadSnapshot: store.loadSnapshot,
    transact: store.transact,
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
  const controller = createMapController({
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
    loadSnapshot: store.loadSnapshot,
    transact: store.transact,
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
  const controller = createMapController({
    client: { responses: { create: async (_payload, options) => {
      receivedSignal = options?.signal;
      markStarted();
      return new Promise((_resolve, reject) => {
        receivedSignal?.addEventListener("abort", () => reject(receivedSignal.reason), { once: true });
      });
    } } },
    loadSnapshot: store.loadSnapshot,
    transact: store.transact,
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

function fakeTimers() {
  let nextId = 0;
  const jobs = new Map();
  const calls = [];
  return {
    calls,
    jobs,
    setTimer(callback, delay) {
      const id = ++nextId;
      jobs.set(id, callback);
      calls.push({ id, delay });
      return id;
    },
    clearTimer(id) { jobs.delete(id); },
    async fire(id) {
      const callback = jobs.get(id);
      jobs.delete(id);
      await callback();
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("scheduler debounces completed user turns, serializes runs, and queues arrivals", async () => {
  let snapshot = session({ transcript: [utterance(0)] });
  const timers = fakeTimers();
  const watermarks = [];
  let release;
  const firstRun = new Promise((resolve) => { release = resolve; });
  let runs = 0;
  const scheduler = createMapControllerScheduler({
    controller: {
      run: async (_sessionId, options) => {
        watermarks.push(options.watermark);
        runs += 1;
        if (runs === 1) await firstRun;
      },
      recordFailure: async () => {},
    },
    loadSnapshot: async () => structuredClone(snapshot),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  assert.equal(scheduler.notify("session-1", utterance(0, "partner")), false);
  assert.equal(scheduler.notify("session-1", utterance(0)), true);
  assert.equal(scheduler.notify("session-1", utterance(0)), true);
  assert.equal(timers.calls.at(-1).delay, 1_500);
  const active = timers.fire(timers.calls.at(-1).id);
  await Promise.resolve();
  snapshot = { ...snapshot, transcript: [...snapshot.transcript, utterance(1)] };
  scheduler.notify("session-1", utterance(1));
  assert.equal(scheduler.state("session-1").queued, true);
  release();
  await active;
  assert.equal(timers.calls.at(-1).delay, 1_500);
  await timers.fire(timers.calls.at(-1).id);
  assert.deepEqual(watermarks, [1, 2]);
  assert.equal(scheduler.state("session-1").active, false);
  scheduler.dispose();
});

test("scheduler preflight permits one run across duplicate callbacks and notification during load", async () => {
  const timers = fakeTimers();
  const snapshotLoad = deferred();
  let loadCalls = 0;
  let runs = 0;
  const scheduler = createMapControllerScheduler({
    controller: {
      run: async () => { runs += 1; },
      recordFailure: async () => {},
    },
    loadSnapshot: async () => {
      loadCalls += 1;
      return snapshotLoad.promise;
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  scheduler.notify("session-1", utterance(0));
  const callback = timers.jobs.get(timers.calls.at(-1).id);
  const first = callback();
  await Promise.resolve();
  assert.equal(scheduler.state("session-1").preparing, true);
  scheduler.notify("session-1", utterance(1));
  const duplicate = callback();
  await Promise.resolve();
  snapshotLoad.resolve(session({ transcript: [utterance(0), utterance(1)] }));
  await Promise.all([first, duplicate]);

  assert.equal(loadCalls, 1);
  assert.equal(runs, 1);
  assert.equal(scheduler.state("session-1").preparing, false);
  assert.equal(scheduler.state("session-1").queued, false);
  assert.equal(timers.calls.at(-1).delay, 1_500, "the notification queues one later pass");
  scheduler.dispose();
});

test("cancel and dispose invalidate a deferred preflight load", async () => {
  for (const action of ["cancel", "dispose"]) {
    const timers = fakeTimers();
    const snapshotLoad = deferred();
    let loadStarted;
    const started = new Promise((resolve) => { loadStarted = resolve; });
    let runs = 0;
    const scheduler = createMapControllerScheduler({
      controller: {
        run: async () => { runs += 1; },
        recordFailure: async () => {},
      },
      loadSnapshot: async () => {
        loadStarted();
        return snapshotLoad.promise;
      },
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    scheduler.notify("session-1", utterance(0));
    const inFlight = timers.fire(timers.calls.at(-1).id);
    await started;
    if (action === "cancel") scheduler.cancel("session-1");
    else scheduler.dispose();
    snapshotLoad.resolve(session({ transcript: [utterance(0)] }));
    await inFlight;

    assert.equal(runs, 0, `${action} prevents a stale run after load resolves`);
    assert.equal(scheduler.state("session-1").active, false);
    scheduler.dispose();
  }
});

test("cancel and dispose invalidate a deferred recover preflight", async () => {
  for (const action of ["cancel", "dispose"]) {
    const timers = fakeTimers();
    const snapshotLoad = deferred();
    let loadStarted;
    const started = new Promise((resolve) => { loadStarted = resolve; });
    let runs = 0;
    const scheduler = createMapControllerScheduler({
      controller: {
        run: async () => { runs += 1; },
        recordFailure: async () => {},
      },
      loadSnapshot: async () => {
        loadStarted();
        return snapshotLoad.promise;
      },
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    const recovering = scheduler.recover("session-1");
    await Promise.resolve();
    const recoveryTimerId = timers.calls.at(-1)?.id;
    const inFlight = recoveryTimerId ? timers.fire(recoveryTimerId) : Promise.resolve();
    await started;
    if (action === "cancel") scheduler.cancel("session-1");
    else scheduler.dispose();
    snapshotLoad.resolve(session({ transcript: [utterance(0)] }));
    await Promise.all([Promise.resolve(recovering), inFlight]);

    assert.ok(recoveryTimerId, "recover schedules tokenized preflight before loading");
    assert.equal(runs, 0);
    assert.equal(scheduler.state("session-1").scheduled, false);
    scheduler.dispose();
  }
});

test("notification during deferred recover preflight queues a later pass", async () => {
  const timers = fakeTimers();
  const snapshotLoad = deferred();
  let current = session({ transcript: [utterance(0)] });
  let loadCalls = 0;
  let loadStarted;
  const started = new Promise((resolve) => { loadStarted = resolve; });
  const watermarks = [];
  const scheduler = createMapControllerScheduler({
    controller: {
      run: async (_sessionId, { watermark }) => watermarks.push(watermark),
      recordFailure: async () => {},
    },
    loadSnapshot: async () => {
      loadCalls += 1;
      if (loadCalls === 1) {
        loadStarted();
        return snapshotLoad.promise;
      }
      return structuredClone(current);
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  const recovering = scheduler.recover("session-1");
  await Promise.resolve();
  const recoveryTimerId = timers.calls.at(-1)?.id;
  const inFlight = recoveryTimerId ? timers.fire(recoveryTimerId) : Promise.resolve();
  await started;
  current = { ...current, transcript: [...current.transcript, utterance(1)] };
  scheduler.notify("session-1", utterance(1));
  snapshotLoad.resolve(structuredClone(current));
  await Promise.all([Promise.resolve(recovering), inFlight]);

  assert.ok(recoveryTimerId, "recover enters the shared timer preflight");
  assert.deepEqual(watermarks, [2]);
  assert.equal(scheduler.state("session-1").scheduled, true);
  assert.equal(timers.calls.at(-1).delay, 1_500);
  scheduler.dispose();
});

test("snapshot-load failures use controller backoff and persistent failure policy", async () => {
  const timers = fakeTimers();
  const pending = session({ transcript: [utterance(0)] });
  let loads = 0;
  let runs = 0;
  const recorded = [];
  const loadSnapshot = async () => {
    loads += 1;
    const error = new Error("snapshot unavailable");
    error.status = 503;
    throw error;
  };
  const scheduler = createMapControllerScheduler({
    controller: {
      run: async () => { runs += 1; },
      recordFailure: async (_sessionId, error) => recorded.push(error.message),
    },
    loadSnapshot,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  await scheduler.recover("session-1");
  await timers.fire(timers.calls.at(-1).id);
  for (const delay of [1_000, 4_000, 15_000]) {
    assert.equal(timers.calls.at(-1).delay, delay);
    await timers.fire(timers.calls.at(-1).id);
  }

  assert.equal(loads, 4, "recovery uses four scheduled preflight attempts");
  assert.equal(runs, 0);
  assert.deepEqual(recorded, ["snapshot unavailable"]);
  assert.equal(scheduler.state("session-1").retry_attempt, 0);
  scheduler.dispose();
});

test("notification during initial snapshot-load backoff cannot replace the retry", async () => {
  const timers = fakeTimers();
  const pending = session({ transcript: [utterance(0)] });
  let loads = 0;
  const watermarks = [];
  const scheduler = createMapControllerScheduler({
    controller: {
      run: async (_sessionId, { watermark }) => watermarks.push(watermark),
      recordFailure: async () => {},
    },
    loadSnapshot: async () => {
      loads += 1;
      if (loads === 1) {
        const error = new Error("first load failed");
        error.status = 503;
        throw error;
      }
      return structuredClone(pending);
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  scheduler.notify("session-1", utterance(0));
  await timers.fire(timers.calls.at(-1).id);
  const retryTimer = timers.calls.at(-1);
  scheduler.notify("session-1", utterance(1));

  assert.equal(timers.jobs.has(retryTimer.id), true);
  assert.equal(scheduler.state("session-1").retry_attempt, 1);
  assert.equal(scheduler.state("session-1").queued, true);
  await timers.fire(retryTimer.id);
  assert.deepEqual(watermarks, [1]);
  scheduler.dispose();
});

test("exhausted reducer validation gets one repair and no scheduler retry cycle", async () => {
  const timers = fakeTimers();
  const initial = session({ transcript: [utterance(0, "you", "One source for too many bubbles")] });
  const store = storeHarness(initial);
  let responses = 0;
  let ids = 0;
  const invalidDecision = {
    decision: "apply",
    operations: Array.from({ length: 4 }, (_, index) => ({
      type: "create_bubble",
      temp_id: `node-${index}`,
      node_id: null,
      from: null,
      to: null,
      parent: null,
      text: `Bubble ${index}`,
      evidence: [{ utterance_id: "u-0", quote: "One source" }],
    })),
    proposal: null,
  };
  const controller = createMapController({
    client: { responses: { create: async () => {
      responses += 1;
      return jsonResponse(invalidDecision, `invalid-${responses}`);
    } } },
    loadSnapshot: store.loadSnapshot,
    transact: store.transact,
    now: () => new Date(stamp),
    idFactory: (kind) => `${kind}-${++ids}`,
  });
  const scheduler = createMapControllerScheduler({
    controller,
    loadSnapshot: store.loadSnapshot,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  await scheduler.recover("session-1");
  await timers.fire(timers.calls.at(-1).id);

  assert.equal(responses, 2, "one initial decision plus one repair only");
  assert.equal(scheduler.state("session-1").scheduled, false);
  assert.equal(store.current.nodes.length, 0);
  assert.equal(store.current.map_controller.processed_transcript_count, 0);
  assert.equal(store.current.map_controller.last_error.code, "controller_decision_invalid");
  scheduler.dispose();
});

test("notification during transient backoff preserves retry range and queues a later pass", async () => {
  let snapshot = session({ transcript: [utterance(0)] });
  const timers = fakeTimers();
  const watermarks = [];
  let attempts = 0;
  const scheduler = createMapControllerScheduler({
    controller: {
      run: async (_sessionId, { watermark }) => {
        watermarks.push(watermark);
        attempts += 1;
        if (attempts === 1) {
          const error = new Error("retry me");
          error.status = 503;
          throw error;
        }
      },
      recordFailure: async () => {},
    },
    loadSnapshot: async () => structuredClone(snapshot),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  await scheduler.recover("session-1");
  await timers.fire(timers.calls.at(-1).id);
  const retryTimer = timers.calls.at(-1);
  assert.equal(retryTimer.delay, 1_000);
  snapshot = { ...snapshot, transcript: [...snapshot.transcript, utterance(1)] };
  scheduler.notify("session-1", utterance(1));
  assert.equal(timers.jobs.has(retryTimer.id), true, "the existing retry timer remains scheduled");
  assert.deepEqual(scheduler.state("session-1"), {
    scheduled: true,
    preparing: false,
    active: false,
    queued: true,
    retry_attempt: 1,
    watermark: 1,
  });

  await timers.fire(retryTimer.id);
  assert.deepEqual(watermarks, [1, 1]);
  assert.equal(timers.calls.at(-1).delay, 1_500);
  await timers.fire(timers.calls.at(-1).id);
  assert.deepEqual(watermarks, [1, 1, 2]);
  scheduler.dispose();
});

test("scheduler backoff persists failure without advancing the real controller cursor", async () => {
  const timers = fakeTimers();
  let attempts = 0;
  const pending = session({ transcript: [utterance(0)] });
  const store = storeHarness(pending);
  const controller = createMapController({
    client: { responses: { create: async () => {
      attempts += 1;
      const error = new Error("busy");
      error.status = 503;
      throw error;
    } } },
    loadSnapshot: store.loadSnapshot,
    transact: store.transact,
    now: () => new Date(stamp),
    idFactory: (kind) => `${kind}-persistent`,
  });
  const scheduler = createMapControllerScheduler({
    controller,
    loadSnapshot: store.loadSnapshot,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  assert.equal(await scheduler.recover("session-1"), true);
  assert.equal(timers.calls.at(-1).delay, 0);
  await timers.fire(timers.calls.at(-1).id);
  for (const delay of [1_000, 4_000, 15_000]) {
    assert.equal(timers.calls.at(-1).delay, delay);
    await timers.fire(timers.calls.at(-1).id);
  }
  assert.equal(attempts, 4);
  assert.equal(store.current.map_controller.processed_transcript_count, 0);
  assert.deepEqual(store.current.map_controller.last_error, {
    code: "503",
    message: "busy",
    at: stamp,
  });
  assert.equal(scheduler.state("session-1").retry_attempt, 0);
  assert.equal(scheduler.retry("session-1"), true);
  assert.equal(timers.calls.at(-1).delay, 0);
  scheduler.cancel("session-1");
  assert.equal(scheduler.state("session-1").scheduled, false);
  scheduler.dispose();
});
