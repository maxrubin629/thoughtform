import assert from "node:assert/strict";
import { SESSION_SCHEMA_VERSION } from "../../server/sessionStore.mjs";
import { createMapController } from "../../server/mapController.mjs";
import { createMapControllerScheduler } from "../../server/mapControllerScheduler.mjs";

export const stamp = "2026-07-21T12:00:00.000Z";

export function utterance(index, speaker = "you", text = `thought ${index}`) {
  return {
    id: `u-${index}`,
    realtime_item_id: `rt-${index}`,
    speaker,
    text,
    completed_at: stamp,
  };
}

export function session(overrides = {}) {
  return {
    schema_version: SESSION_SCHEMA_VERSION,
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

export function storeHarness(initial) {
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

export function jsonResponse(value, id = "response-1") {
  return { id, output_text: JSON.stringify(value), output: [] };
}

export function requestDocument(request) {
  assert.ok(Array.isArray(request.input), "controller input is a structured message array");
  assert.equal(request.input[0].role, "developer");
  assert.ok(Array.isArray(request.input[0].content));
  assert.equal(request.input[0].content[0].type, "input_text");
  const document = JSON.parse(request.input[0].content[0].text);
  assert.equal(document.kind, "thoughtform_map_controller_evidence");
  return document;
}

export function requestEnvelope(request) {
  return requestDocument(request).evidence;
}

export const noChange = { decision: "no_change", operations: [], proposal: null };

export function fakeTimers() {
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

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/** Bind an in-memory store and deterministic clock; each test supplies its API behavior. */
export function controllerFor(store, options) {
  return createMapController({
    env: {},
    loadSnapshot: store.loadSnapshot,
    transact: store.transact,
    now: () => new Date(stamp),
    ...options,
  });
}

export function schedulerFor(timers, options) {
  return createMapControllerScheduler({ setTimer: timers.setTimer, clearTimer: timers.clearTimer, ...options });
}
