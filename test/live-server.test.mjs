import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../server/sessionStore.mjs";
import { applyOperation } from "../server/sessionOperations.mjs";
import { ensureLiveState } from "../server/liveState.mjs";
import { registerLiveRoutes } from "../server/live.mjs";
import { buildLiveSessionConfig, forwardLiveSdp } from "../server/liveConnection.mjs";

async function setup(t, responses, options = {}) {
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
    ...options,
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
  assert.equal(calls[0].model, "gpt-5.6-terra");
  assert.deepEqual(calls[0].reasoning, { effort: "medium" });
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

test("explicit commands rebase once after a concurrent map change", async (t) => {
  const { request, store, id } = await setup(t, async (_input, count) => {
    if (count === 1) return { output_text: JSON.stringify({ explicit_map_request: true, request_quote: "Add testing.", reply: "" }) };
    if (count === 2) {
      await store.transact(id, (session) => applyOperation(session, { type: "create_bubble", text: "Concurrent idea", expected_revision: 0 }));
      return { output: [{ type: "function_call", call_id: "create", name: "create_bubble", arguments: JSON.stringify({ text: "Testing", quote: "testing", expected_revision: 0 }) }] };
    }
    return { output: [], output_text: "" };
  });
  const result = await request("/chat", { text: "Add testing.", request_id: "concurrent" });
  assert.equal(result.reply, "");
  assert.equal(result.snapshot.revision, 2);
  assert.deepEqual(result.snapshot.nodes.map(({ text }) => text), ["Concurrent idea", "Testing"]);
  assert.equal(result.snapshot.nodes[1].sources[0].quote, "testing");
});

test("read-only tool dispatch cannot mutate the map and unknown tools return an error", async (t) => {
  let outputs;
  const { request } = await setup(t, async (input, count) => {
    if (count === 1) return { output_text: JSON.stringify({ explicit_map_request: true, request_quote: "Find my earlier idea.", reply: "" }) };
    if (count === 2) return { output: [
      { type: "function_call", call_id: "read", name: "get_map", arguments: "{}" },
      { type: "function_call", call_id: "search", name: "search_transcript", arguments: JSON.stringify({ query: "earlier", utterance_id: null }) },
      { type: "function_call", call_id: "invalid", name: "constructor", arguments: "{}" },
    ] };
    outputs = input.input.filter(({ type }) => type === "function_call_output").map(({ output }) => JSON.parse(output));
    return { output: [], output_text: "Your earlier idea is in the conversation." };
  });
  const result = await request("/chat", { text: "Find my earlier idea.", request_id: "read_only" });
  assert.equal(outputs[0].ok, true);
  assert.equal(outputs[1].utterances[0].text, "Find my earlier idea.");
  assert.equal(outputs[2].error.code, "unknown_live_tool");
  assert.equal(result.snapshot.revision, 0);
  assert.deepEqual(result.snapshot.nodes, []);
});

test("a selection change during reasoning prevents the pending command from executing", async (t) => {
  let selection = [];
  const { request, store, id } = await setup(t, async (_input, count) => {
    if (count === 1) return { output_text: JSON.stringify({ explicit_map_request: true, request_quote: "Rename this idea.", reply: "" }) };
    selection = [];
    return { output: [{ type: "function_call", call_id: "edit", name: "edit_bubble", arguments: JSON.stringify({ node_reference: "$selected", text: "Must not replace", expected_revision: 1 }) }] };
  }, { getUiContext: () => ({ selected_node_ids: selection }) });
  const created = await store.transact(id, (session) => applyOperation(session, { type: "create_bubble", text: "Original", expected_revision: 0 }));
  selection = [created.session.nodes[0].id];
  await request("/chat", { text: "Rename this idea.", request_id: "changed_selection" });
  assert.equal((await store.get(id)).nodes[0].text, "Original");
  assert.equal((await store.get(id)).revision, 1);
});
