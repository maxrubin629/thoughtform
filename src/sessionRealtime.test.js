import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { SessionRealtimeClient } from "./sessionRealtime.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function connectedClient(options = {}) {
  const sent = [];
  const client = new SessionRealtimeClient({
    sessionId: "session-1",
    peerConnectionFactory: () => ({}),
    mediaDevices: { getUserMedia: async () => { throw new Error("not expected"); } },
    ...options,
  });
  client._channel = {
    readyState: "open",
    send: (value) => sent.push(JSON.parse(value)),
    close() {},
  };
  client._state = "connected";
  return { client, sent };
}

test("sendText assigns a stable item ID and awaits transcript commit before response", async () => {
  const order = [];
  const { client, sent } = connectedClient();
  let callbackItemId;
  client._channel.send = (value) => {
    sent.push(JSON.parse(value));
    order.push(JSON.parse(value).type);
  };

  const itemId = await client.sendText("  A complete idea  ", {
    beforeResponse: async ({ itemId: committedId, text }) => {
      callbackItemId = committedId;
      assert.equal(text, "A complete idea");
      order.push("transcript.commit");
    },
  });

  assert.match(itemId, /^item_/);
  assert.equal(callbackItemId, itemId);
  assert.equal(sent[0].item.id, itemId);
  assert.equal(sent[0].item.content[0].text, "A complete idea");
  assert.deepEqual(order, [
    "conversation.item.create",
    "transcript.commit",
    "response.create",
  ]);
});

test("completed input and Partner transcripts preserve raw event IDs", async () => {
  const received = [];
  const { client } = connectedClient({
    onInputTranscriptDone: (payload) => received.push(["you", payload]),
    onPartnerTranscriptFinal: (payload) => received.push(["partner", payload]),
  });

  const inputEvent = {
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "input-1",
    transcript: "My idea",
  };
  const partnerEvent = {
    type: "response.output_audio_transcript.done",
    item_id: "partner-1",
    response_id: "response-1",
    transcript: "Let's map that.",
  };
  await client._receiveEvent({ data: JSON.stringify(inputEvent) });
  await client._receiveEvent({ data: JSON.stringify(partnerEvent) });

  assert.equal(received[0][1].itemId, "input-1");
  assert.deepEqual(received[0][1].event, inputEvent);
  assert.equal(received[1][1].itemId, "partner-1");
  assert.equal(received[1][1].responseId, "response-1");
  assert.deepEqual(received[1][1].event, partnerEvent);
});

test("function calls return canonical server output through the data channel", async () => {
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "/api/sessions/session-1/tool-calls");
    assert.deepEqual(JSON.parse(options.body), {
      name: "create_bubble",
      arguments: { text: "A distinct idea" },
      call_id: "call-1",
      expected_revision: 3,
    });
    return new Response(JSON.stringify({
      ok: true,
      revision: 4,
      affected_ids: ["node-1"],
    }), { headers: { "Content-Type": "application/json" } });
  };

  const { client, sent } = connectedClient({ getExpectedRevision: () => 3 });
  await client._receiveEvent({ data: JSON.stringify({
    type: "response.function_call_arguments.done",
    call_id: "call-1",
    name: "create_bubble",
    arguments: JSON.stringify({ text: "A distinct idea" }),
  }) });

  assert.equal(sent[0].type, "conversation.item.create");
  assert.equal(sent[0].item.type, "function_call_output");
  assert.equal(sent[0].item.call_id, "call-1");
  assert.equal(JSON.parse(sent[0].item.output).revision, 4);
  assert.equal(sent[1].type, "response.create");
});

test("the model revision remains authoritative over a newer browser snapshot", async () => {
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.arguments.expected_revision, 1);
    assert.equal(body.expected_revision, 1);
    return new Response(JSON.stringify({ ok: false, revision: 3 }), {
      headers: { "Content-Type": "application/json" },
    });
  };

  const { client } = connectedClient({ getExpectedRevision: () => 3 });
  await client._receiveEvent({ data: JSON.stringify({
    type: "response.function_call_arguments.done",
    call_id: "call-stale-model",
    name: "edit_bubble",
    arguments: JSON.stringify({ node_reference: "node-1", text: "Stale", expected_revision: 1 }),
  }) });
});

test("multiple tool events execute serially and request one follow-up response", async () => {
  let revision = 0;
  const bodies = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    bodies.push(body);
    await new Promise((resolve) => setTimeout(resolve, 5));
    return new Response(JSON.stringify({ ok: true, revision: body.expected_revision + 1 }), {
      headers: { "Content-Type": "application/json" },
    });
  };

  const { client, sent } = connectedClient({
    getExpectedRevision: () => revision,
    onToolResult: ({ result }) => { revision = result.revision; },
  });
  const first = client._receiveEvent({ data: JSON.stringify({
    type: "response.function_call_arguments.done",
    call_id: "call-batch-1",
    name: "create_bubble",
    arguments: JSON.stringify({ text: "First" }),
  }) });
  const second = client._receiveEvent({ data: JSON.stringify({
    type: "response.function_call_arguments.done",
    call_id: "call-batch-2",
    name: "create_bubble",
    arguments: JSON.stringify({ text: "Second" }),
  }) });
  await Promise.all([first, second]);

  assert.deepEqual(bodies.map((body) => body.expected_revision), [0, 1]);
  assert.equal(sent.filter((event) => event.item?.type === "function_call_output").length, 2);
  assert.equal(sent.filter((event) => event.type === "response.create").length, 1);
});

test("tool failures return the current revision and snapshot to Realtime", async () => {
  const failure = {
    ok: false,
    error: { code: "revision_conflict", message: "Stale", retryable: false },
    revision: 4,
    snapshot: { id: "session-1", revision: 4, nodes: [{ id: "node-new" }] },
  };
  failure.function_call_output = {
    type: "function_call_output",
    call_id: "call-conflict",
    output: JSON.stringify(failure),
  };
  globalThis.fetch = async () => new Response(JSON.stringify(failure), {
    status: 409,
    headers: { "Content-Type": "application/json" },
  });

  const { client, sent } = connectedClient({ getExpectedRevision: () => 3 });
  await client._receiveEvent({ data: JSON.stringify({
    type: "response.function_call_arguments.done",
    call_id: "call-conflict",
    name: "edit_bubble",
    arguments: JSON.stringify({ node_reference: "node-old", text: "Edit", expected_revision: 3 }),
  }) });

  const output = JSON.parse(sent[0].item.output);
  assert.equal(output.revision, 4);
  assert.equal(output.snapshot.nodes[0].id, "node-new");
  assert.equal(sent[1].type, "response.create");
});

test("an in-flight tool result cannot leak into a replacement connection", async () => {
  let releaseFetch;
  globalThis.fetch = async () => {
    await new Promise((resolve) => { releaseFetch = resolve; });
    return new Response(JSON.stringify({ ok: true, revision: 2 }), {
      headers: { "Content-Type": "application/json" },
    });
  };

  const { client, sent } = connectedClient({ getExpectedRevision: () => 1 });
  const handling = client._receiveEvent({ data: JSON.stringify({
    type: "response.function_call_arguments.done",
    call_id: "call-old-connection",
    name: "create_bubble",
    arguments: JSON.stringify({ text: "Old connection" }),
  }) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  client.disconnect({ state: "closed" });
  releaseFetch();
  await handling;

  assert.equal(sent.length, 0);
});

test("speech-derived function calls wait for the matching transcript commit", async () => {
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    const payload = attempts === 1
      ? {
          ok: false,
          error: {
            code: "transcript_pending",
            retryable: true,
            item_id: "input-1",
          },
        }
      : { ok: true, revision: 2, affected_ids: ["node-1"] };
    return new Response(JSON.stringify(payload), {
      headers: { "Content-Type": "application/json" },
    });
  };

  const { client, sent } = connectedClient();
  await client._receiveEvent({ data: JSON.stringify({
    type: "response.function_call_arguments.done",
    call_id: "call-pending",
    name: "create_bubble",
    arguments: JSON.stringify({
      text: "A sourced idea",
      realtime_item_id: "input-1",
      quote: "A sourced idea",
    }),
  }) });

  assert.equal(attempts, 1);
  assert.equal(sent.length, 0);

  await client.notifyTranscriptCommitted("input-1");
  assert.equal(attempts, 2);
  assert.equal(sent[0].item.call_id, "call-pending");
  assert.equal(JSON.parse(sent[0].item.output).ok, true);
  assert.equal(sent[1].type, "response.create");
});
