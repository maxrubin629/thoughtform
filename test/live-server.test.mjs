import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../server/sessionStore.mjs";
import { applyOperation } from "../server/sessionOperations.mjs";
import { ensureLiveState } from "../server/liveState.mjs";
import { buildLiveSessionConfig, forwardLiveSdp, registerLiveRoutes } from "../server/live.mjs";
import { createChatSubmission } from "../src/chatSubmission.js";

async function setup(t, responses) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "thoughtform-live-server-"));
  const store = new SessionStore({ directory });
  await store.init();
  const session = await store.create();
  await store.transact(session.id, (current) => {
    const state = ensureLiveState(current);
    state.active_session_id = "live_one";
    state.known_session_ids = ["live_one"];
    return current;
  });
  const routes = new Map();
  const calls = [];
  const client = { responses: { async create(input) { calls.push(input); return responses(input, calls.length); } } };
  const snapshotFor = (current) => { const { live_capture, transcript_fragments, ...snapshot } = current; return snapshot; };
  const performOperation = async (id, operation) => {
    const result = await store.transact(id, (current) => applyOperation(current, operation, { requireExpectedRevision: true }));
    return { ...result, snapshot: snapshotFor(result.session) };
  };
  const runtime = registerLiveRoutes({ post: (route, handler) => routes.set(route, handler) }, {
    store, openaiClient: client, jsonRoute: (handler) => handler, performOperation, snapshotFor,
    captureOptions: { debounceMs: 60_000, classify: async ({ fragments }) => fragments.length ? [{ fragment_ids: fragments.filter(({ speaker }) => speaker === "you").map(({ id }) => id) }] : [] },
  });
  const request = (route, body) => routes.get(`/api/sessions/:id${route}`)({ params: { id: session.id }, body });
  t.after(async () => { runtime.dispose(); await rm(directory, { recursive: true, force: true }); });
  return { store, id: session.id, request, calls };
}

const transcript = (text, eventId = "one") => ({ type: "session.input_transcript.delta", event_id: eventId, delta: text, start_ms: 0, end_ms: 100 });
const delegate = { live_session_id: "live_one", delegation: { id: "item_first", target: "client" }, offset_ms: 100 };

test("Live negotiation uses official JSON endpoint and never exposes the key", async () => {
  let captured;
  const config = buildLiveSessionConfig({ transcript: [] });
  const result = await forwardLiveSdp({ sdp: "offer", apiKey: "test-key", sessionConfig: config, fetchImpl: async (url, options) => {
    captured = { url, options };
    return { ok: true, json: async () => ({ session: { id: "live_opaque", secret: "must-not-leak" }, transport: { sdp: "answer" } }) };
  } });
  assert.equal(captured.url, "https://api.openai.com/v1/live/sessions");
  assert.deepEqual(JSON.parse(captured.options.body).transport, { type: "webrtc", sdp: "offer" });
  assert.deepEqual(config.delegation, { type: "client" });
  assert.equal(config.model, "gpt-live-1");
  assert.deepEqual(result, { session: { id: "live_opaque" }, transport: { type: "webrtc", sdp: "answer" } });
});

test("Delegation metadata cannot become task text, duplicate IDs replay without another model call", async (t) => {
  const { request, calls } = await setup(t, async () => ({ output_text: JSON.stringify({ explicit_map_request: false, request_quote: null, reply: "That sounds like a tradeoff between speed and clarity." }) }));
  assert.equal((await request("/live/delegations", delegate)).pending, true);
  assert.equal(calls.length, 0);
  await request("/live/events", { live_session_id: "live_one", events: [transcript("I want to balance speed and clarity.")] });
  const first = await request("/live/delegations", delegate);
  assert.equal(first.events[0].type, "session.commentary.append");
  assert.equal(first.events[0].delegation_id, "item_first");
  const again = await request("/live/delegations", delegate);
  assert.equal(again.replayed, true);
  assert.deepEqual(again.events, first.events);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "gpt-6-luna");
  assert.deepEqual(calls[0].reasoning, { effort: "high" });
  assert.match(calls[0].input, /balance speed and clarity/);
});

test("An old delegation result is discarded when the voice generation changes", async (t) => {
  let release;
  let entered;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const { request, store, id } = await setup(t, async () => {
    entered();
    await new Promise((resolve) => { release = resolve; });
    return { output_text: JSON.stringify({ explicit_map_request: false, request_quote: null, reply: "Outdated answer." }) };
  });
  await request("/live/events", { live_session_id: "live_one", events: [transcript("Help me think about this.")] });
  const pending = request("/live/delegations", delegate);
  await enteredPromise;
  await store.transact(id, (session) => { session.live_capture.known_session_ids.push("live_two"); session.live_capture.active_session_id = "live_two"; return session; });
  release();
  const result = await pending;
  assert.equal(result.stale, true);
  assert.deepEqual(result.events, []);
});

test("Typed conversation is canonical, durable and idempotent", async (t) => {
  const { request, store, id, calls } = await setup(t, async () => ({ output_text: JSON.stringify({ explicit_map_request: false, request_quote: null, reply: "Which part feels most uncertain?" }) }));
  const body = { text: "I am still thinking through the design.", request_id: "request_one" };
  const result = await request("/chat", body);
  assert.equal(result.reply, "Which part feels most uncertain?");
  assert.deepEqual((await store.get(id)).transcript.map(({ speaker }) => speaker), ["you", "partner"]);
  assert.equal((await request("/chat", body)).replayed, true);
  assert.equal(calls.length, 1);
});

test("Explicit map-only commands replay without repeating side effects or adding spoken confirmations", async (t) => {
  const { request, store, id, calls } = await setup(t, async (_input, count) => {
    if (count === 1) return { output_text: JSON.stringify({ explicit_map_request: true, request_quote: "Add a bubble for testing.", reply: "" }) };
    if (count === 2) return { output: [{ type: "function_call", call_id: "tool_one", name: "create_bubble", arguments: JSON.stringify({ text: "Testing", quote: "testing", quotes: [], parent_reference: null, expected_revision: 0 }) }] };
    return { output: [], output_text: "" };
  });
  const body = { text: "Add a bubble for testing.", request_id: "map_request" };
  const first = await request("/chat", body);
  assert.equal(first.reply, "");
  const second = await request("/chat", body);
  assert.equal(second.replayed, true);
  assert.equal(calls.length, 3);
  assert.equal((await store.get(id)).nodes.length, 1);
  assert.equal((await store.get(id)).transcript.length, 1);
});

test("A provider failure before map execution retries the same typed request without duplicating its transcript", async (t) => {
  const { request, store, id, calls } = await setup(t, async (_input, count) => {
    if (count === 1) throw new Error("Temporary provider timeout");
    return { output_text: JSON.stringify({ explicit_map_request: false, request_quote: null, reply: "Let's examine the uncertain part." }) };
  });
  const body = { text: "Help me think through this.", request_id: "retry_one" };
  await assert.rejects(request("/chat", body), /Temporary provider timeout/);
  const retry = await request("/chat", body);
  assert.equal(retry.reply, "Let's examine the uncertain part.");
  assert.equal(calls.length, 2);
  assert.deepEqual((await store.get(id)).transcript.map(({ speaker }) => speaker), ["you", "partner"]);
});

test("the UI submission retries a saved message without duplicating it and permits a later identical thought", async (t) => {
  const { request, store, id } = await setup(t, async (_input, count) => {
    if (count === 1) throw new Error("Temporary provider timeout");
    return { output_text: JSON.stringify({ explicit_map_request: false, request_quote: null, reply: "Let's think about it." }) };
  });
  const submissions = createChatSubmission();
  const send = (text, { requestId }) => request('/chat', { text, request_id: requestId });
  await assert.rejects(submissions.send(id, 'Keep this thought.', send), error => error.details.message_saved === true);
  await submissions.send(id, 'Keep this thought.', send);
  assert.equal((await store.get(id)).transcript.filter(item => item.speaker === 'you').length, 1);
  await submissions.send(id, 'Keep this thought.', send);
  assert.equal((await store.get(id)).transcript.filter(item => item.speaker === 'you').length, 2);
});

test("editing a failed draft or using a different map starts a new submission", async () => {
  const submissions = createChatSubmission();
  const ids = [];
  const fail = async (_text, { requestId }) => { ids.push(requestId); throw new Error('offline'); };
  await assert.rejects(submissions.send('map_one', 'A thought', fail));
  submissions.edit('map_one', 'Different');
  submissions.edit('map_one', 'A thought');
  await assert.rejects(submissions.send('map_one', 'A thought', fail));
  await assert.rejects(submissions.send('map_two', 'A thought', fail));
  assert.equal(new Set(ids).size, 3);
});

test("retrying after a partial map action preserves the action without executing it again", async (t) => {
  const { request, store, id, calls } = await setup(t, async (_input, count) => {
    if (count === 1) return { output_text: JSON.stringify({ explicit_map_request: true, request_quote: "Add a bubble for testing.", reply: "" }) };
    if (count === 2) return { output: [{ type: "function_call", call_id: "partial_tool", name: "create_bubble", arguments: JSON.stringify({ text: "Testing", quote: "testing", quotes: [], parent_reference: null, expected_revision: 0 }) }] };
    throw new Error("Provider failed after the map changed");
  });
  const submissions = createChatSubmission();
  const send = (text, { requestId }) => request('/chat', { text, request_id: requestId });
  await assert.rejects(submissions.send(id, 'Add a bubble for testing.', send), /after the map changed/);
  await assert.rejects(submissions.send(id, 'Add a bubble for testing.', send), { code: 'chat_already_attempted' });
  const saved = await store.get(id);
  assert.equal(saved.nodes.length, 1);
  assert.equal(saved.transcript.length, 1);
  assert.equal(calls.length, 3);
});
