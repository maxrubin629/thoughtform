import assert from "node:assert/strict";
import test from "node:test";
import {
  stamp, utterance, session, storeHarness, jsonResponse, fakeTimers, deferred, controllerFor, schedulerFor,
} from "./helpers/mapController.mjs";

test("scheduler debounces completed user turns, serializes runs, and queues arrivals", async () => {
  let snapshot = session({ transcript: [utterance(0)] });
  const timers = fakeTimers();
  const watermarks = [];
  let release;
  const firstRun = new Promise((resolve) => { release = resolve; });
  let runs = 0;
  const scheduler = schedulerFor(timers, {
    controller: {
      run: async (_sessionId, options) => {
        watermarks.push(options.watermark);
        runs += 1;
        if (runs === 1) await firstRun;
      },
      recordFailure: async () => {},
    },
    loadSnapshot: async () => structuredClone(snapshot),
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
  const scheduler = schedulerFor(timers, {
    controller: {
      run: async () => { runs += 1; },
      recordFailure: async () => {},
    },
    loadSnapshot: async () => {
      loadCalls += 1;
      return snapshotLoad.promise;
    },
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

test("manual retry during snapshot loading queues another pass without replacing preflight", async () => {
  const timers = fakeTimers();
  const loading = deferred();
  const watermarks = [];
  const scheduler = schedulerFor(timers, {
    controller: { run: async (_id, { watermark }) => watermarks.push(watermark) },
    loadSnapshot: () => loading.promise,
  });
  scheduler.recover("session-1");
  const running = timers.fire(timers.calls.at(-1).id);
  scheduler.retry("session-1");
  assert.equal(scheduler.state("session-1").queued, true);
  assert.equal(timers.calls.length, 1, "the pending preflight remains the only scheduled run");
  loading.resolve(session({ transcript: [utterance(0)] }));
  await running;
  assert.deepEqual(watermarks, [1]);
  assert.equal(scheduler.state("session-1").scheduled, true);
  scheduler.dispose();
});

test("cancel and dispose invalidate a deferred preflight load", async () => {
  for (const action of ["cancel", "dispose"]) {
    const timers = fakeTimers();
    const snapshotLoad = deferred();
    let loadStarted;
    const started = new Promise((resolve) => { loadStarted = resolve; });
    let runs = 0;
    const scheduler = schedulerFor(timers, {
      controller: {
        run: async () => { runs += 1; },
        recordFailure: async () => {},
      },
      loadSnapshot: async () => {
        loadStarted();
        return snapshotLoad.promise;
      },
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
    const scheduler = schedulerFor(timers, {
      controller: {
        run: async () => { runs += 1; },
        recordFailure: async () => {},
      },
      loadSnapshot: async () => {
        loadStarted();
        return snapshotLoad.promise;
      },
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
  const scheduler = schedulerFor(timers, {
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
  const scheduler = schedulerFor(timers, {
    controller: {
      run: async () => { runs += 1; },
      recordFailure: async (_sessionId, error) => recorded.push(error.message),
    },
    loadSnapshot,
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
  const scheduler = schedulerFor(timers, {
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
  const controller = controllerFor(store, {
    client: { responses: { create: async () => {
      responses += 1;
      return jsonResponse(invalidDecision, `invalid-${responses}`);
    } } },
    idFactory: (kind) => `${kind}-${++ids}`,
  });
  const scheduler = schedulerFor(timers, {
    controller,
    loadSnapshot: store.loadSnapshot,
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
  const scheduler = schedulerFor(timers, {
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
    paused: false,
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
  const controller = controllerFor(store, {
    client: { responses: { create: async () => {
      attempts += 1;
      const error = new Error("busy");
      error.status = 503;
      throw error;
    } } },
    idFactory: (kind) => `${kind}-persistent`,
  });
  const scheduler = schedulerFor(timers, {
    controller,
    loadSnapshot: store.loadSnapshot,
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

test("scheduler cancels active mapping on pause and processes new backlog on resume", async () => {
  let snapshot = session({ transcript: [utterance(0)] });
  const timers = fakeTimers();
  const started = deferred();
  const watermarks = [];
  let signal;
  const scheduler = schedulerFor(timers, {
    controller: { run: async (_id, options) => {
      watermarks.push(options.watermark);
      if (watermarks.length > 1) return { decision: "no_change" };
      signal = options.signal;
      started.resolve();
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    } },
    loadSnapshot: async () => structuredClone(snapshot),
  });
  scheduler.notify("session-1", utterance(0));
  const firstRun = timers.fire(timers.calls.at(-1).id);
  await started.promise;
  snapshot.preferences = { mapping_paused: true, partner_mode: "proactive" };
  await scheduler.preferencesChanged("session-1");
  await firstRun;
  assert.equal(signal.aborted, true);
  assert.equal(scheduler.state("session-1").paused, true);
  snapshot.transcript.push(utterance(1));
  assert.equal(scheduler.notify("session-1", utterance(1)), false);
  snapshot.preferences.mapping_paused = false;
  await scheduler.preferencesChanged("session-1");
  await timers.fire(timers.calls.at(-1).id);
  assert.deepEqual(watermarks, [1, 2]);
  scheduler.dispose();
});
