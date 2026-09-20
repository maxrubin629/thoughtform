import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { delegateLiveTask, negotiateLiveSession, persistLiveEvents, sendSessionChat } from "./liveApi.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

test("Live negotiation uses same-origin JSON and preserves the server session ID", async () => {
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "/api/sessions/map%2F1/live");
    assert.deepEqual(JSON.parse(options.body), { sdp: "offer" });
    assert.equal(options.headers.Authorization, undefined);
    return response({ session: { id: "live1" }, transport: { type: "webrtc", sdp: "answer" } });
  };
  assert.equal((await negotiateLiveSession("map/1", "offer")).session.id, "live1");
});

test("invalid negotiation answers are rejected before peer setup", async () => {
  globalThis.fetch = async () => response({ transport: { sdp: "answer" } });
  await assert.rejects(negotiateLiveSession("map1", "offer"), { code: "invalid_live_answer" });
});

test("delegation sends metadata and timing without fabricating task text", async () => {
  globalThis.fetch = async (_url, options) => {
    assert.deepEqual(JSON.parse(options.body), { live_session_id: "live1", delegation: { id: "opaque", target: "client" }, offset_ms: 90 });
    return response({ ok: true });
  };
  await delegateLiveTask("map1", "live1", { delegation: { id: "opaque", target: "client" }, offset_ms: 90, task: "must not be sent" });
});

test("saving retries remain possible on network failure and API error details survive", async () => {
  globalThis.fetch = async () => { throw new Error("offline"); };
  await assert.rejects(persistLiveEvents("map1", "live1", []), { code: "network_error", retryable: true });
  globalThis.fetch = async () => response({ error: { code: "pending", message: "Waiting for context", retryable: true } }, 409);
  await assert.rejects(persistLiveEvents("map1", "live1", []), { code: "pending", message: "Waiting for context", retryable: true });
});

test("typed chat carries a stable identity and preserves exact text", async () => {
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "/api/sessions/map1/chat");
    assert.deepEqual(JSON.parse(options.body), { text: "  hello  ", request_id: "retry-safe" });
    return response({ reply: "Hello" });
  };
  await sendSessionChat("map1", "  hello  ", { requestId: "retry-safe" });
});

test("typed chat generates one request ID and reuses it after an uncertain network result", async () => {
  const bodies = [];
  globalThis.fetch = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    if (bodies.length === 1) throw new Error("Response lost after commit");
    return response({ ok: true, reply: "Saved" });
  };
  await sendSessionChat("map1", "hello");
  assert.equal(bodies.length, 2);
  assert.ok(bodies[0].request_id);
  assert.deepEqual(bodies[0], bodies[1]);
});
