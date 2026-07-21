import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  applySessionOperation,
  negotiateRealtimeSession,
  retrySessionMapController,
  shouldApplySessionSnapshot,
  subscribeSessionEvents,
} from "./sessionApi.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("session operations carry revision and call id through the shared endpoint", async () => {
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ ok: true, revision: 8 }), {
      headers: { "Content-Type": "application/json" },
    });
  };

  const result = await applySessionOperation(
    "session/one",
    { type: "move_node", node_id: "node-1", x: 12, y: 20 },
    { expectedRevision: 7, callId: "call-1", actor: "you" },
  );

  assert.equal(request.url, "/api/sessions/session%2Fone/operations");
  assert.equal(request.options.method, "POST");
  assert.deepEqual(JSON.parse(request.options.body), {
    operation: { type: "move_node", node_id: "node-1", x: 12, y: 20 },
    expected_revision: 7,
    call_id: "call-1",
    actor: "you",
  });
  assert.equal(result.revision, 8);
});

test("session operations retry once at the revision returned by a conflict", async () => {
  const bodies = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    bodies.push(body);
    if (bodies.length === 1) {
      return new Response(JSON.stringify({
        error: {
          code: "revision_conflict",
          message: "Expected revision 12, but session is at revision 15",
        },
        revision: 15,
        snapshot: { id: "session-1", revision: 15 },
      }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true, revision: 16 }), {
      headers: { "Content-Type": "application/json" },
    });
  };

  const result = await applySessionOperation(
    "session-1",
    { type: "move_bubble", node_reference: "node-1", x: 10, y: 20 },
    { expectedRevision: 12, actor: "you" },
  );

  assert.deepEqual(bodies.map((body) => body.expected_revision), [12, 15]);
  assert.equal(result.revision, 16);
});

test("map controller retry posts to the session retry endpoint and returns its snapshot", async () => {
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({
      ok: true,
      scheduled: true,
      snapshot: { id: "session-1", revision: 8, map_controller: { status: "waiting" } },
    }), {
      headers: { "Content-Type": "application/json" },
    });
  };

  const result = await retrySessionMapController("session-1");

  assert.equal(request.url, "/api/sessions/session-1/map-controller/retry");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.body, "{}");
  assert.equal(result.snapshot.map_controller.status, "waiting");
});

test("Realtime negotiation sends raw SDP without exposing a credential", async () => {
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response("answer-sdp", {
      headers: { "Content-Type": "application/sdp" },
    });
  };

  const answer = await negotiateRealtimeSession("session-1", "offer-sdp", {
    voiceMode: "push-to-talk",
  });

  assert.equal(answer, "answer-sdp");
  assert.equal(request.url, "/api/sessions/session-1/realtime?voice_mode=push-to-talk");
  assert.equal(request.options.body, "offer-sdp");
  assert.equal(request.options.headers["Content-Type"], "application/sdp");
  assert.equal("Authorization" in request.options.headers, false);
});

test("SSE subscriptions dispatch snapshots and close idempotently", () => {
  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      this.closeCount = 0;
      FakeEventSource.instance = this;
    }

    addEventListener(name, listener) {
      this.listeners.set(name, listener);
    }

    emit(name, data) {
      this.listeners.get(name)?.({ type: name, data: JSON.stringify(data) });
    }

    close() {
      this.closeCount += 1;
    }
  }

  const snapshots = [];
  const cleanup = subscribeSessionEvents(
    "session-1",
    { onSnapshot: (snapshot) => snapshots.push(snapshot) },
    { EventSourceImpl: FakeEventSource },
  );
  FakeEventSource.instance.emit("snapshot", { revision: 4, nodes: [] });
  cleanup();
  cleanup();

  assert.equal(FakeEventSource.instance.url, "/api/sessions/session-1/events");
  assert.deepEqual(snapshots, [{ revision: 4, nodes: [] }]);
  assert.equal(FakeEventSource.instance.closeCount, 1);
});

test("SSE subscriptions dispatch named map-controller snapshots immediately", () => {
  class FakeEventSource {
    constructor() {
      this.listeners = new Map();
      FakeEventSource.instance = this;
    }
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    emit(name, data) { this.listeners.get(name)?.({ type: name, data: JSON.stringify(data) }); }
    close() {}
  }

  const snapshots = [];
  const cleanup = subscribeSessionEvents(
    "session-1",
    { onSnapshot: (snapshot) => snapshots.push(snapshot) },
    { EventSourceImpl: FakeEventSource },
  );
  FakeEventSource.instance.emit("map_controller", {
    type: "map_controller",
    snapshot: {
      id: "session-1",
      revision: 4,
      controller_event_sequence: 9,
      map_controller: { status: "idle", processed_transcript_count: 3 },
      nodes: [{ id: "controller-node" }],
    },
  });
  cleanup();

  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].controller_event_sequence, 9);
  assert.equal(snapshots[0].map_controller.status, "idle");
  assert.equal(snapshots[0].nodes[0].id, "controller-node");
});

test("same-revision snapshot reconciliation keeps the newest controller event", () => {
  const current = {
    id: "session-1",
    revision: 7,
    controller_event_epoch: 100,
    controller_event_sequence: 12,
    map_controller: { status: "idle" },
  };
  const staleRetry = {
    ...current,
    controller_event_sequence: 11,
    map_controller: { status: "waiting" },
  };
  const newerError = {
    ...current,
    controller_event_sequence: 13,
    map_controller: { status: "error" },
  };

  assert.equal(shouldApplySessionSnapshot(current, staleRetry), false);
  assert.equal(shouldApplySessionSnapshot(current, newerError), true);
  assert.equal(shouldApplySessionSnapshot(current, { ...staleRetry, revision: 8 }), true);
});

test("a newer server epoch resets the same-revision controller sequence watermark", () => {
  const oldServerSnapshot = {
    id: "session-1",
    revision: 7,
    controller_event_epoch: 100,
    controller_event_sequence: 500,
    map_controller: { status: "waiting" },
  };
  const restartedServerSnapshot = {
    ...oldServerSnapshot,
    controller_event_epoch: 101,
    controller_event_sequence: 0,
    map_controller: { status: "idle" },
  };

  assert.equal(shouldApplySessionSnapshot(oldServerSnapshot, restartedServerSnapshot), true);
  assert.equal(shouldApplySessionSnapshot(restartedServerSnapshot, oldServerSnapshot), false);
});

test("a terminal EventSource failure creates a fresh subscription", () => {
  const instances = [];
  const timers = [];
  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.listeners = new Map();
      this.closeCount = 0;
      instances.push(this);
    }
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    close() { this.closeCount += 1; }
  }

  const cleanup = subscribeSessionEvents("session-1", {}, {
    EventSourceImpl: FakeEventSource,
    reconnectDelayMs: 10,
    setTimeoutImpl: (callback) => { timers.push(callback); return timers.length; },
    clearTimeoutImpl: () => {},
  });
  instances[0].readyState = 0;
  instances[0].onerror({ type: "error" });
  assert.equal(instances[0].closeCount, 1);
  timers.shift()();
  assert.equal(instances.length, 2);
  assert.equal(instances[1].url, "/api/sessions/session-1/events");
  cleanup();
  assert.equal(instances[1].closeCount, 1);
});
