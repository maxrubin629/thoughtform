import assert from "node:assert/strict";
import test from "node:test";
import { MAP_CONTROLLER_OUTPUT_SCHEMA, MAP_CONTROLLER_SYSTEM, searchTranscript } from "../server/mapController.mjs";
import {
  stamp, utterance, session, storeHarness, jsonResponse, requestDocument, requestEnvelope, noChange, controllerFor,
} from "./helpers/mapController.mjs";

test("builds a bounded untrusted-evidence envelope with the Terra defaults", async () => {
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
  const controller = controllerFor(store, {
    client: { responses: { create: async (payload) => { request = payload; return jsonResponse(noChange); } } },
    idFactory: (kind) => `${kind}-test`,
  });

  await controller.run("session-1", { watermark: 13 });

  assert.equal(controller.model, "gpt-5.6-terra");
  assert.equal(request.model, "gpt-5.6-terra");
  assert.deepEqual(request.reasoning, { effort: "medium" });
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
  const controller = controllerFor(store, {
    client: { responses: { create: async (payload) => { requests.push(payload); return replies.shift(); } } },
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
  const controller = controllerFor(store, {
    client: { responses: { create: async (payload, options) => { requests.push([payload, options]); return replies.shift(); } } },
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
  const controller = controllerFor(store, {
    client: { responses: { create: async (payload) => { requests.push(payload); return replies.shift(); } } },
    transact,
    idFactory: (kind) => `${kind}-watermark-search`,
  });

  await controller.run("session-1", { watermark: 1 });

  const searchOutput = JSON.parse(requests[2].input[0].output);
  assert.deepEqual(searchOutput.matches, []);
  assert.deepEqual(requestEnvelope(requests[1]).transcript_delta.map(({ id }) => id), ["u-0"]);
});

test("foreground command ownership is attached to exact utterances without hiding mixed substantive content", async () => {
  const transcript = [
    utterance(0, "you", "An earlier idea."),
    utterance(1, "you", "Rename this bubble to Voice capture. Long pauses help me think."),
    utterance(2, "you", "The app needs a rename feature."),
    utterance(3, "you", "Connect these two bubbles."),
  ];
  const store = storeHarness(session({
    transcript,
    map_controller: { processed_transcript_count: 1, last_run_id: null, last_success_at: null, last_error: null },
    operations: [
      { id: "old-foreground", type: "edit_bubble", actor: "partner", origin: "realtime", created_at: stamp, source_utterance_ids: ["u-0"] },
      { id: "rename-foreground", type: "edit_bubble", actor: "partner", origin: "realtime", created_at: stamp, source_utterance_ids: ["u-1"] },
      { id: "connect-foreground", type: "connect_bubbles", actor: "partner", origin: "realtime", created_at: stamp, source_realtime_item_id: "rt-3" },
      { id: "mapping-record", type: "apply_map_batch", actor: "partner", origin: "map_controller", created_at: stamp, source_utterance_ids: ["u-2"] },
    ],
  }));
  let request;
  const controller = controllerFor(store, {
    client: { responses: { create: async (payload) => { request = payload; return jsonResponse(noChange); } } },
  });
  await controller.run("session-1");
  const envelope = requestEnvelope(request);
  assert.deepEqual(envelope.transcript_delta.map(({ id, foreground_operation_ids }) => ({ id, foreground_operation_ids })), [
    { id: "u-1", foreground_operation_ids: ["rename-foreground"] },
    { id: "u-2", foreground_operation_ids: [] },
    { id: "u-3", foreground_operation_ids: ["connect-foreground"] },
  ]);
  assert.equal(envelope.transcript_delta[0].text, transcript[1].text, "mixed content remains available for exact source spans");
  assert.equal(envelope.transcript_delta[1].text, "The app needs a rename feature.", "substantive mention of a control is not classified as a command");
  assert.deepEqual(envelope.relevant_realtime_operations.map(({ id }) => id), ["rename-foreground", "connect-foreground"]);
  assert.match(request.instructions, /Application-control requests belong exclusively to the foreground Partner/);
  assert.match(request.instructions, /even when the foreground operation has not appeared yet/);
  assert.match(request.instructions, /A delta containing only application controls requires no_change/);
  assert.match(request.instructions, /citing its exact substantive source span/);
  assert.equal(store.current.map_controller.processed_transcript_count, 4);
});
