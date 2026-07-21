import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  applySessionOperation,
  negotiateRealtimeSession,
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
