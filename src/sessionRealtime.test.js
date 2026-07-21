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
  assert.ok(itemId.length <= 32, `client item ID must fit Realtime's 32-character limit: ${itemId}`);
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
      arguments: { text: "A distinct idea", expected_revision: 3 },
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
  assert.ok(sent[0].item.id.length <= 32);
  assert.equal(JSON.parse(sent[0].item.output).revision, 4);
  assert.equal(sent[1].type, "response.create");
  assert.equal(sent[1].response.tool_choice, "none");
  assert.equal(sent[1].response.input.at(-1).id, sent[0].item.id);
  assert.notEqual(sent[1].response.metadata.request_id, sent[1].event_id);
});

test("tool continuations wait for the active Realtime response to finish", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: true,
    revision: 2,
    affected_ids: ["node-1"],
  }), { headers: { "Content-Type": "application/json" } });

  const { client, sent } = connectedClient();
  await client._receiveEvent({ data: JSON.stringify({
    type: "response.created",
    response: { id: "response-active", status: "in_progress" },
  }) });
  await client._receiveEvent({ data: JSON.stringify({
    type: "response.function_call_arguments.done",
    response_id: "response-active",
    call_id: "call-active-response",
    name: "create_bubble",
    arguments: JSON.stringify({ text: "A distinct idea" }),
  }) });

  assert.equal(sent.filter((event) => event.item?.type === "function_call_output").length, 1);
  assert.equal(sent.filter((event) => event.type === "response.create").length, 0);

  await client._receiveEvent({ data: JSON.stringify({
    type: "response.done",
    response: { id: "response-active", status: "completed" },
  }) });

  assert.equal(sent.filter((event) => event.type === "response.create").length, 1);
  const continuation = sent.find((event) => event.type === "response.create");
  assert.equal(continuation.response.tool_choice, "none");
  assert.notEqual(continuation.response.metadata.request_id, continuation.event_id);
});

async function runToolContinuationInputRace(kind) {
  let releaseTool;
  let toolStarted;
  const started = new Promise((resolve) => { toolStarted = resolve; });
  globalThis.fetch = async () => {
    toolStarted();
    await new Promise((resolve) => { releaseTool = resolve; });
    return new Response(JSON.stringify({
      ok: true,
      revision: 2,
      affected_ids: ["node-1"],
    }), { headers: { "Content-Type": "application/json" } });
  };

  const { client, sent } = connectedClient();
  await client._receiveEvent({ data: JSON.stringify({
    type: "conversation.item.created",
    previous_item_id: null,
    item: { id: `input-a-${kind}`, type: "message", role: "user" },
  }) });
  await client._receiveEvent({ data: JSON.stringify({
    type: "conversation.item.created",
    previous_item_id: `input-a-${kind}`,
    item: {
      id: `tool-item-${kind}`,
      type: "function_call",
      call_id: `call-context-${kind}`,
      name: "create_bubble",
      arguments: JSON.stringify({ text: "Input A" }),
    },
  }) });
  await client._receiveEvent({ data: JSON.stringify({
    type: "response.created",
    response: { id: `response-active-${kind}`, status: "in_progress" },
  }) });

  const handling = client._receiveEvent({ data: JSON.stringify({
    type: "response.function_call_arguments.done",
    response_id: `response-active-${kind}`,
    item_id: `tool-item-${kind}`,
    call_id: `call-context-${kind}`,
    name: "create_bubble",
    arguments: JSON.stringify({ text: "Input A" }),
  }) });
  await started;

  let laterInputId;
  if (kind === "typed") {
    laterInputId = await client.sendText("Input B");
  } else {
    laterInputId = `input-b-${kind}`;
    if (kind === "push-to-talk") {
      client.voiceMode = "push-to-talk";
      client.stopPushToTalk();
    }
    await client._receiveEvent({ data: JSON.stringify({
      type: "input_audio_buffer.committed",
      item_id: laterInputId,
      previous_item_id: `tool-item-${kind}`,
    }) });
    await client._receiveEvent({ data: JSON.stringify({
      type: "conversation.item.created",
      previous_item_id: `tool-item-${kind}`,
      item: { id: laterInputId, type: "message", role: "user" },
    }) });
  }

  if (kind === "vad") {
    await client._receiveEvent({ data: JSON.stringify({
      type: "response.created",
      response: { id: "response-vad-input-b", status: "in_progress" },
    }) });
  }
  releaseTool();
  await handling;
  await client._receiveEvent({ data: JSON.stringify({
    type: "response.done",
    response: { id: `response-active-${kind}`, status: "completed" },
  }) });
  if (kind === "vad") {
    await client._receiveEvent({ data: JSON.stringify({
      type: "response.done",
      response: { id: "response-vad-input-b", status: "completed" },
    }) });
  }

  const continuation = sent.find((event) => event.type === "response.create"
    && event.response.tool_choice === "none");
  assert.ok(continuation);
  const contextIds = continuation.response.input.map((item) => item.id);
  assert.deepEqual(contextIds.slice(0, 2), [
    `input-a-${kind}`,
    `tool-item-${kind}`,
  ]);
  assert.equal(contextIds.includes(laterInputId), false);
  assert.equal(
    contextIds.includes(sent.find((event) => event.item?.type === "function_call_output").item.id),
    true,
  );
}

test("tool continuations bind context before later typed input arrives", async () => {
  await runToolContinuationInputRace("typed");
});

test("tool continuations bind context before later push-to-talk input commits", async () => {
  await runToolContinuationInputRace("push-to-talk");
});

test("tool continuations bind context before later VAD input commits", async () => {
  await runToolContinuationInputRace("vad");
});

test("a delayed function event uses the conversation prefix ending at its function-call item", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: true,
    revision: 2,
    affected_ids: ["node-1"],
  }), { headers: { "Content-Type": "application/json" } });

  const { client, sent } = connectedClient();
  await client._receiveEvent({ data: JSON.stringify({
    type: "response.created",
    response: { id: "response-tool-a", status: "in_progress" },
  }) });
  await client._receiveEvent({ data: JSON.stringify({
    type: "conversation.item.created",
    previous_item_id: null,
    item: { id: "input-a-delayed", type: "message", role: "user" },
  }) });
  await client._receiveEvent({ data: JSON.stringify({
    type: "conversation.item.created",
    previous_item_id: "input-a-delayed",
    item: {
      id: "tool-a-delayed",
      type: "function_call",
      call_id: "call-a-delayed",
      name: "create_bubble",
      arguments: JSON.stringify({ text: "Input A" }),
    },
  }) });
  const inputB = await client.sendText("Input B arrived before arguments.done");

  await client._receiveEvent({ data: JSON.stringify({
    type: "response.function_call_arguments.done",
    response_id: "response-tool-a",
    item_id: "tool-a-delayed",
    call_id: "call-a-delayed",
    name: "create_bubble",
    arguments: JSON.stringify({ text: "Input A" }),
  }) });
  await client._receiveEvent({ data: JSON.stringify({
    type: "response.done",
    response: { id: "response-tool-a", status: "completed" },
  }) });

  const continuation = sent.find((event) => event.type === "response.create"
    && event.response.tool_choice === "none");
  assert.ok(continuation);
  const contextIds = continuation.response.input.map((item) => item.id);
  assert.deepEqual(contextIds.slice(0, 2), ["input-a-delayed", "tool-a-delayed"]);
  assert.equal(contextIds.includes(inputB), false);
  assert.equal(
    contextIds.includes(sent.find((event) => event.item?.type === "function_call_output").item.id),
    true,
  );
});

test("a server-created VAD response cannot acknowledge a pending manual response", async () => {
  const { client, sent } = connectedClient();
  client.requestResponse({ instructions: "Manual response" });
  client.requestResponse({ instructions: "Latest manual response" });
  const firstCreate = sent[0];

  assert.match(firstCreate.event_id, /^event_/);
  assert.notEqual(firstCreate.response.metadata.request_id, firstCreate.event_id);

  await client._receiveEvent({ data: JSON.stringify({
    type: "response.created",
    response: { id: "response-vad", status: "in_progress" },
  }) });
  await client._receiveEvent({ data: JSON.stringify({
    type: "response.done",
    response: { id: "response-vad", status: "completed" },
  }) });
  assert.equal(sent.filter((event) => event.type === "response.create").length, 1);

  await client._receiveEvent({ data: JSON.stringify({
    type: "response.created",
    response: {
      id: "response-manual",
      status: "in_progress",
      metadata: { request_id: firstCreate.response.metadata.request_id },
    },
  }) });
  await client._receiveEvent({ data: JSON.stringify({
    type: "response.done",
    response: { id: "response-manual", status: "completed" },
  }) });

  const creates = sent.filter((event) => event.type === "response.create");
  assert.equal(creates.length, 2);
  assert.equal(creates[1].response.instructions, "Latest manual response");
  assert.notEqual(creates[1].event_id, firstCreate.event_id);
});

test("queued responses wait for every active response ID to finish", async () => {
  const { client, sent } = connectedClient();
  await client._receiveEvent({ data: JSON.stringify({
    type: "response.created",
    response: { id: "response-a", status: "in_progress" },
  }) });
  await client._receiveEvent({ data: JSON.stringify({
    type: "response.created",
    response: { id: "response-b", status: "in_progress" },
  }) });
  client.requestResponse({ instructions: "After both" });

  await client._receiveEvent({ data: JSON.stringify({
    type: "response.done",
    response: { id: "response-a", status: "completed" },
  }) });
  assert.equal(sent.filter((event) => event.type === "response.create").length, 0);

  await client._receiveEvent({ data: JSON.stringify({
    type: "response.done",
    response: { id: "response-b", status: "completed" },
  }) });
  assert.equal(sent.filter((event) => event.type === "response.create").length, 1);
});

test("a matching response.create error requeues that request until the active response ends", async () => {
  const { client, sent } = connectedClient();
  client.requestResponse({ instructions: "Retry me" });
  const create = sent[0];

  await client._receiveEvent({ data: JSON.stringify({
    type: "response.created",
    response: { id: "response-vad", status: "in_progress" },
  }) });
  await client._receiveEvent({ data: JSON.stringify({
    type: "error",
    error: {
      event_id: create.event_id,
      code: "conversation_already_has_active_response",
      message: "An active response is already in progress",
    },
  }) });
  await client._receiveEvent({ data: JSON.stringify({
    type: "response.done",
    response: { id: "response-vad", status: "completed" },
  }) });

  const creates = sent.filter((event) => event.type === "response.create");
  assert.equal(creates.length, 2);
  assert.notEqual(creates[1].event_id, create.event_id);
  assert.equal(
    creates[1].response.metadata.request_id,
    create.response.metadata.request_id,
  );
  assert.equal(creates[1].response.instructions, "Retry me");
});

test("terminal response.create errors release the scheduler without resending", async () => {
  const { client, sent } = connectedClient();
  client.requestResponse({ instructions: "Do not retry me" });
  const failedCreate = sent[0];

  await client._receiveEvent({ data: JSON.stringify({
    type: "error",
    error: {
      event_id: failedCreate.event_id,
      code: "invalid_request_error",
      message: "The request is invalid",
    },
  }) });

  assert.equal(sent.filter((event) => event.type === "response.create").length, 1);
  client.requestResponse({ instructions: "A later valid request" });
  const creates = sent.filter((event) => event.type === "response.create");
  assert.equal(creates.length, 2);
  assert.equal(creates[1].response.instructions, "A later valid request");
});

test("active-response retries stop after one retry attempt", async () => {
  const { client, sent } = connectedClient();
  client.requestResponse({ instructions: "Bounded retry" });
  const firstCreate = sent[0];

  await client._receiveEvent({ data: JSON.stringify({
    type: "response.created",
    response: { id: "response-overlap-1", status: "in_progress" },
  }) });
  await client._receiveEvent({ data: JSON.stringify({
    type: "error",
    error: {
      event_id: firstCreate.event_id,
      code: "conversation_already_has_active_response",
      message: "An active response is already in progress",
    },
  }) });
  await client._receiveEvent({ data: JSON.stringify({
    type: "response.done",
    response: { id: "response-overlap-1", status: "completed" },
  }) });

  const retryCreate = sent.filter((event) => event.type === "response.create")[1];
  assert.ok(retryCreate);
  await client._receiveEvent({ data: JSON.stringify({
    type: "response.created",
    response: { id: "response-overlap-2", status: "in_progress" },
  }) });
  await client._receiveEvent({ data: JSON.stringify({
    type: "error",
    error: {
      event_id: retryCreate.event_id,
      code: "conversation_already_has_active_response",
      message: "Still active",
    },
  }) });
  await client._receiveEvent({ data: JSON.stringify({
    type: "response.done",
    response: { id: "response-overlap-2", status: "completed" },
  }) });

  assert.equal(sent.filter((event) => event.type === "response.create").length, 2);
});

test("an unrelated error cannot release a pending response.create", async () => {
  const { client, sent } = connectedClient();
  client.requestResponse({ instructions: "Pending" });
  const firstCreate = sent[0];

  await client._receiveEvent({ data: JSON.stringify({
    type: "error",
    error: { event_id: "event_unrelated", code: "unrelated", message: "Other failure" },
  }) });
  client.requestResponse({ instructions: "Still queued" });
  assert.equal(sent.filter((event) => event.type === "response.create").length, 1);

  await client._receiveEvent({ data: JSON.stringify({
    type: "response.created",
    response: {
      id: "response-pending",
      status: "in_progress",
      metadata: { request_id: firstCreate.response.metadata.request_id },
    },
  }) });
  await client._receiveEvent({ data: JSON.stringify({
    type: "response.done",
    response: { id: "response-pending", status: "completed" },
  }) });
  assert.equal(sent.filter((event) => event.type === "response.create").length, 2);
});

test("response requests never overlap an active response and coalesce to one follow-up", async () => {
  const { client, sent } = connectedClient();
  await client._receiveEvent({ data: JSON.stringify({
    type: "response.created",
    response: { id: "response-active", status: "in_progress" },
  }) });

  client.requestResponse({ instructions: "First queued request" });
  client.requestResponse({ instructions: "Latest queued request" });
  assert.equal(sent.filter((event) => event.type === "response.create").length, 0);

  await client._receiveEvent({ data: JSON.stringify({
    type: "response.done",
    response: { id: "response-active", status: "completed" },
  }) });

  const creates = sent.filter((event) => event.type === "response.create");
  assert.equal(creates.length, 1);
  assert.equal(creates[0].response.instructions, "Latest queued request");
  assert.notEqual(creates[0].response.metadata.request_id, creates[0].event_id);
});

test("response requests coalesce while a previous response.create awaits response.created", async () => {
  const { client, sent } = connectedClient();

  client.requestResponse({ instructions: "Initial request" });
  client.requestResponse({ instructions: "Queued while starting" });
  assert.equal(sent.filter((event) => event.type === "response.create").length, 1);

  await client._receiveEvent({ data: JSON.stringify({
    type: "response.created",
    response: {
      id: "response-started",
      status: "in_progress",
      metadata: { request_id: sent[0].response.metadata.request_id },
    },
  }) });
  await client._receiveEvent({ data: JSON.stringify({
    type: "response.done",
    response: { id: "response-started", status: "completed" },
  }) });

  const creates = sent.filter((event) => event.type === "response.create");
  assert.equal(creates.length, 2);
  assert.equal(creates[1].response.instructions, "Queued while starting");
  assert.notEqual(creates[1].response.metadata.request_id, creates[1].event_id);
});

async function runStickyToolContinuationInterleaving(order) {
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: true,
    revision: 2,
    affected_ids: ["node-1"],
  }), { headers: { "Content-Type": "application/json" } });
  const { client, sent } = connectedClient();
  await client._receiveEvent({ data: JSON.stringify({
    type: "response.created",
    response: { id: `response-${order}`, status: "in_progress" },
  }) });
  const queueUser = () => client.requestResponse({ instructions: `User ${order}` });
  const runTool = () => client._receiveEvent({ data: JSON.stringify({
    type: "response.function_call_arguments.done",
    response_id: `response-${order}`,
    call_id: `call-${order}`,
    name: "get_map",
    arguments: "{}",
  }) });

  if (order === "user-first") {
    queueUser();
    await runTool();
  } else {
    await runTool();
    queueUser();
  }
  await client._receiveEvent({ data: JSON.stringify({
    type: "response.done",
    response: { id: `response-${order}`, status: "completed" },
  }) });

  let creates = sent.filter((event) => event.type === "response.create");
  assert.equal(creates.length, 1);
  assert.equal(creates[0].response.tool_choice, "none");
  const continuation = creates[0];

  await client._receiveEvent({ data: JSON.stringify({
    type: "response.created",
    response: {
      id: `response-continuation-${order}`,
      status: "in_progress",
      metadata: { request_id: continuation.response.metadata.request_id },
    },
  }) });
  await client._receiveEvent({ data: JSON.stringify({
    type: "response.done",
    response: { id: `response-continuation-${order}`, status: "completed" },
  }) });

  creates = sent.filter((event) => event.type === "response.create");
  assert.equal(creates.length, 2);
  assert.equal(creates[1].response.instructions, `User ${order}`);
}

test("a tool continuation survives when an ordinary response was queued first", async () => {
  await runStickyToolContinuationInterleaving("user-first");
});

test("a tool continuation stays prioritized when an ordinary response is queued later", async () => {
  await runStickyToolContinuationInterleaving("tool-first");
});

test("a queued text response is discarded when the connection is replaced", async () => {
  const { client, sent } = connectedClient();
  await client._receiveEvent({ data: JSON.stringify({
    type: "response.created",
    response: { id: "response-old", status: "in_progress" },
  }) });
  await client.sendText("Do not leak this request");
  assert.equal(sent.filter((event) => event.type === "response.create").length, 0);

  client.disconnect({ state: "closed" });
  client._channel = {
    readyState: "open",
    send: (value) => sent.push(JSON.parse(value)),
    close() {},
  };
  client._state = "connected";
  await client._receiveEvent({ data: JSON.stringify({
    type: "response.done",
    response: { id: "response-old", status: "cancelled" },
  }) });

  assert.equal(sent.filter((event) => event.type === "response.create").length, 0);
});

test("the current browser revision rebases a stale model revision", async () => {
  const bodies = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    bodies.push(body);
    return new Response(JSON.stringify({ ok: true, revision: 4 }), {
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

  assert.equal(bodies[0].arguments.expected_revision, 3);
  assert.equal(bodies[0].expected_revision, 3);
});

test("a Realtime tool retries once against the conflict snapshot revision", async () => {
  const bodies = [];
  let revision = 12;
  let errors = 0;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    bodies.push(body);
    if (bodies.length === 1) {
      revision = 15;
      const conflict = {
        error: {
          code: "revision_conflict",
          message: "Expected revision 12, but session is at revision 15",
        },
        revision: 15,
        snapshot: { id: "session-1", revision: 15, nodes: [], edges: [], proposals: [] },
      };
      return new Response(JSON.stringify(conflict), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true, revision: 16 }), {
      headers: { "Content-Type": "application/json" },
    });
  };

  const { client } = connectedClient({
    getExpectedRevision: () => revision,
    onError: () => { errors += 1; },
  });
  await client._receiveEvent({ data: JSON.stringify({
    type: "response.function_call_arguments.done",
    call_id: "call-rebase",
    name: "edit_bubble",
    arguments: JSON.stringify({ node_reference: "node-1", text: "Updated", expected_revision: 12 }),
  }) });

  assert.deepEqual(bodies.map((body) => body.expected_revision), [12, 15]);
  assert.deepEqual(bodies.map((body) => body.arguments.expected_revision), [12, 15]);
  assert.equal(errors, 0);
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

test("a superseded connect failure cannot tear down its successful replacement", async () => {
  let releaseFirstRequest;
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    if (requestCount === 1) {
      await new Promise((resolve) => { releaseFirstRequest = resolve; });
      throw new Error("old connection failed late");
    }
    return new Response("replacement-answer", {
      headers: { "Content-Type": "application/sdp" },
    });
  };

  const tracks = [];
  const mediaDevices = {
    getUserMedia: async () => {
      const track = { enabled: true, stop() {} };
      tracks.push(track);
      return {
        getTracks: () => [track],
        getAudioTracks: () => [track],
      };
    },
  };
  const peers = [];
  const peerConnectionFactory = () => {
    const channel = {
      readyState: "open",
      addEventListener() {},
      close() { this.readyState = "closed"; },
      send() {},
    };
    const peer = {
      connectionState: "new",
      addTrack() {},
      createDataChannel: () => channel,
      createOffer: async () => ({ type: "offer", sdp: `offer-${peers.length + 1}` }),
      setLocalDescription: async () => {},
      setRemoteDescription: async () => {},
      close() { this.connectionState = "closed"; },
    };
    peers.push(peer);
    return peer;
  };
  const errors = [];
  const client = new SessionRealtimeClient({
    sessionId: "session-1",
    mediaDevices,
    peerConnectionFactory,
    audioElement: { play: async () => {}, srcObject: null },
    onError: (error) => errors.push(error),
  });

  const firstConnect = client.connect().catch((error) => error);
  while (requestCount < 1) await new Promise((resolve) => setTimeout(resolve, 0));
  await client.reconnect();
  assert.equal(client.connected, true);

  releaseFirstRequest();
  const oldError = await firstConnect;
  assert.equal(oldError.code, "realtime_network_error");
  assert.equal(client.connected, true);
  assert.equal(client._peer, peers[1]);
  assert.deepEqual(errors, []);
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

test("a quote-only provenance call waits for the completed transcript and retries", async () => {
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    const payload = attempts === 1
      ? {
          ok: false,
          error: {
            code: "quote_not_found",
            message: "The quote is not in the completed transcript yet.",
            retryable: true,
          },
        }
      : { ok: true, revision: 2, affected_ids: ["node-1"] };
    return new Response(JSON.stringify(payload), {
      status: attempts === 1 ? 422 : 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const { client, sent } = connectedClient();
  await client._receiveEvent({ data: JSON.stringify({
    type: "response.function_call_arguments.done",
    call_id: "call-quote-only",
    name: "create_bubble",
    arguments: JSON.stringify({
      text: "Voice ideation tool",
      quote: "voice ideation tool",
      expected_revision: 1,
    }),
  }) });

  assert.equal(attempts, 1);
  assert.equal(sent.length, 0);
  assert.equal(client._pendingTranscriptCalls.has("*"), true);

  await client.notifyTranscriptCommitted("input-completed-internally");
  assert.equal(attempts, 2);
  assert.equal(sent[0].item.call_id, "call-quote-only");
  assert.equal(JSON.parse(sent[0].item.output).ok, true);
  assert.equal(sent[1].type, "response.create");
});

test("wildcard transcript retries stay attached to input A across an input-A/tool-await/input-B race", async () => {
  let attempt = 0;
  let releaseFirstAttempt;
  let firstAttemptStarted;
  const started = new Promise((resolve) => { firstAttemptStarted = resolve; });
  globalThis.fetch = async () => {
    attempt += 1;
    if (attempt === 1) {
      firstAttemptStarted();
      await new Promise((resolve) => { releaseFirstAttempt = resolve; });
      return new Response(JSON.stringify({
        ok: false,
        error: { code: "quote_not_found", retryable: true },
      }), {
        status: 422,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true, revision: 2 }), {
      headers: { "Content-Type": "application/json" },
    });
  };

  const { client, sent } = connectedClient();
  await client._receiveEvent({ data: JSON.stringify({
    type: "conversation.item.input_audio_transcription.delta",
    item_id: "input-a",
    delta: "Input A",
  }) });
  const handling = client._receiveEvent({ data: JSON.stringify({
    type: "response.function_call_arguments.done",
    item_id: "tool-for-input-a",
    call_id: "call-input-race",
    name: "create_bubble",
    arguments: JSON.stringify({ text: "Input A", quote: "Input A" }),
  }) });
  await started;
  await client._receiveEvent({ data: JSON.stringify({
    type: "conversation.item.input_audio_transcription.delta",
    item_id: "input-b",
    delta: "Input B",
  }) });
  releaseFirstAttempt();
  await handling;

  assert.equal(client._pendingTranscriptCalls.get("*")?.[0]?.associatedItemId, "input-a");
  assert.deepEqual(await client.notifyTranscriptCommitted("input-a"), ["call-input-race"]);
  assert.equal(attempt, 2);
  assert.equal(client._pendingTranscriptCalls.size, 0);
  assert.equal(sent.find((event) => event.item?.type === "function_call_output")?.item.call_id, "call-input-race");
});

test("the client adds the current Realtime item ID internally for unsourced mutations", async () => {
  let requestBody;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ ok: true, revision: 2 }), {
      headers: { "Content-Type": "application/json" },
    });
  };

  const { client } = connectedClient();
  client._latestInputItemId = "input-owned-by-client";
  await client._receiveEvent({ data: JSON.stringify({
    type: "response.function_call_arguments.done",
    call_id: "call-delete-internal-provenance",
    name: "delete_connection",
    arguments: JSON.stringify({ edge_id: "edge-1", expected_revision: 1 }),
  }) });
  assert.equal(requestBody.arguments.realtime_item_id, "input-owned-by-client");
});

test("multi-fragment quotes are direct provenance and do not receive a fallback item ID", async () => {
  let requestBody;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ ok: true, revision: 2 }), {
      headers: { "Content-Type": "application/json" },
    });
  };

  const { client } = connectedClient();
  client._latestInputItemId = "input-must-not-be-injected";
  await client._receiveEvent({ data: JSON.stringify({
    type: "response.function_call_arguments.done",
    call_id: "call-multi-fragment",
    name: "create_bubble",
    arguments: JSON.stringify({
      text: "One coherent idea",
      quote: null,
      quotes: ["First fragment", "Second fragment"],
      expected_revision: 1,
    }),
  }) });

  assert.equal(Object.hasOwn(requestBody.arguments, "realtime_item_id"), false);
});

test("a failed transcript item leaves unrelated wildcard-buffered tools pending", async () => {
  const attempts = new Map();
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    const count = (attempts.get(body.call_id) ?? 0) + 1;
    attempts.set(body.call_id, count);
    const payload = count === 1
      ? {
          ok: false,
          error: { code: "quote_not_found", message: "Not committed yet", retryable: true },
        }
      : { ok: true, revision: 2, affected_ids: [body.call_id] };
    return new Response(JSON.stringify(payload), {
      status: count === 1 ? 422 : 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const { client, sent } = connectedClient();
  client._latestInputItemId = "input-failed";
  await client._receiveEvent({ data: JSON.stringify({
    type: "response.function_call_arguments.done",
    call_id: "call-failed-wildcard",
    name: "create_bubble",
    arguments: JSON.stringify({ text: "Failed", quote: "Failed fragment" }),
  }) });
  client._latestInputItemId = "input-survives";
  await client._receiveEvent({ data: JSON.stringify({
    type: "response.function_call_arguments.done",
    call_id: "call-surviving-wildcard",
    name: "create_bubble",
    arguments: JSON.stringify({ text: "Survives", quote: "Surviving fragment" }),
  }) });

  await client._receiveEvent({ data: JSON.stringify({
    type: "conversation.item.input_audio_transcription.failed",
    item_id: "input-failed",
    error: { message: "No speech recognized" },
  }) });
  const failureOutputs = sent.filter((event) => event.item?.type === "function_call_output");
  assert.deepEqual(failureOutputs.map((event) => event.item.call_id), ["call-failed-wildcard"]);
  assert.equal(client._pendingTranscriptCalls.get("*")?.length, 1);
  assert.equal(sent.some((event) => event.type === "response.create"), false);

  await client.notifyTranscriptCommitted("input-survives");
  assert.equal(attempts.get("call-surviving-wildcard"), 2);
  const allOutputs = sent.filter((event) => event.item?.type === "function_call_output");
  assert.deepEqual(allOutputs.map((event) => event.item.call_id), [
    "call-failed-wildcard",
    "call-surviving-wildcard",
  ]);
  assert.equal(client._pendingTranscriptCalls.size, 0);
});

test("failed input transcription resolves buffered tools and unblocks the response", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: false,
    error: {
      code: "transcript_pending",
      retryable: true,
      item_id: "input-failed",
    },
  }), { headers: { "Content-Type": "application/json" } });

  const { client, sent } = connectedClient();
  await client._receiveEvent({ data: JSON.stringify({
    type: "response.function_call_arguments.done",
    call_id: "call-failed-transcript",
    name: "create_bubble",
    arguments: JSON.stringify({ text: "Maybe", realtime_item_id: "input-failed" }),
  }) });
  assert.equal(sent.length, 0);

  await client._receiveEvent({ data: JSON.stringify({
    type: "conversation.item.input_audio_transcription.failed",
    item_id: "input-failed",
    error: { message: "No speech recognized" },
  }) });
  assert.equal(JSON.parse(sent[0].item.output).error.code, "transcription_failed");
  assert.equal(sent[1].type, "response.create");
  assert.equal(client._pendingTranscriptCalls.size, 0);
});

test("a stalled tool request times out without freezing the tool queue", async () => {
  globalThis.fetch = async (_url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  });
  const { client, sent } = connectedClient({ toolCallTimeoutMs: 5 });
  await client._receiveEvent({ data: JSON.stringify({
    type: "response.function_call_arguments.done",
    call_id: "call-timeout",
    name: "get_map",
    arguments: "{}",
  }) });
  assert.equal(JSON.parse(sent[0].item.output).error.code, "tool_call_timeout");
  assert.equal(sent[1].type, "response.create");
  assert.equal(client._queuedToolCalls, 0);
});

test("transcript completion callbacks commit in received order", async () => {
  const order = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const { client } = connectedClient({
    onInputTranscriptDone: async ({ itemId }) => {
      if (itemId === "input-1") await firstGate;
      order.push(itemId);
    },
  });
  const first = client._receiveEvent({ data: JSON.stringify({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "input-1",
    transcript: "First",
  }) });
  const second = client._receiveEvent({ data: JSON.stringify({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "input-2",
    transcript: "Second",
  }) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(order, []);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["input-1", "input-2"]);
});
