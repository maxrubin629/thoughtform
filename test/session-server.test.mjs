import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSseEventWriter, createThoughtformServer } from "../server/index.mjs";
import { applyOperation } from "../server/sessionOperations.mjs";
import { createSessionStore } from "../server/sessionStore.mjs";

test("SSE backpressure queues complete controller events and flushes them in order", () => {
  const writer = createSseEventWriter();
  const response = new EventEmitter();
  const writes = [];
  let firstWrite = true;
  let ended = 0;
  response.destroyed = false;
  response.writableEnded = false;
  response.write = (chunk) => {
    writes.push(chunk);
    const accepted = !firstWrite;
    firstWrite = false;
    return accepted;
  };
  response.end = () => { ended += 1; response.writableEnded = true; };

  writer.write(response, "event: map_controller\ndata: first\n\n");
  writer.write(response, "event: map_controller\ndata: second\n\n");
  writer.write(response, "event: map_controller\ndata: third\n\n");

  assert.deepEqual(writes, ["event: map_controller\ndata: first\n\n"]);
  assert.equal(response.listenerCount("drain"), 1);
  assert.equal(ended, 0);

  response.emit("drain");

  assert.deepEqual(writes, [
    "event: map_controller\ndata: first\n\n",
    "event: map_controller\ndata: second\n\n",
    "event: map_controller\ndata: third\n\n",
  ]);
  assert.equal(response.listenerCount("drain"), 0);
  assert.equal(ended, 0);
});

test("session HTTP routes share the canonical reducer and revision contract", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "thoughtform-http-"));
  const app = await createThoughtformServer({ store: createSessionStore({ directory }) });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  t.after(async () => {
    app.locals.dispose?.();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });

  const request = async (pathname, { method = "GET", body, headers } = {}) => {
    const response = await fetch(`${base}${pathname}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { response, data: await response.json() };
  };

  const created = await request("/api/sessions", { method: "POST", body: {} });
  assert.equal(created.response.status, 200);
  assert.equal(created.data.revision, 0);
  const id = created.data.id;

  const getMap = await request(`/api/sessions/${id}/tool-calls`, {
    method: "POST",
    body: {
      name: "get_map",
      call_id: "call-http-get-map",
      arguments: {},
    },
  });
  assert.equal(getMap.data.ok, true);
  assert.equal(getMap.data.revision, 0);
  assert.equal(getMap.data.snapshot.nodes.length, 0);
  assert.equal(getMap.data.snapshot.history_length, 0);
  assert.equal(
    JSON.parse(getMap.data.function_call_output.output).snapshot.revision,
    0,
  );

  const removedTool = await request(`/api/sessions/${id}/tool-calls`, {
    method: "POST",
    body: {
      name: "no_map_change",
      call_id: "call-http-removed-tool",
      arguments: { expected_revision: 0 },
    },
  });
  assert.equal(removedTool.response.status, 400);
  assert.equal(removedTool.data.error.code, "unsupported_operation");

  const transcript = await request(`/api/sessions/${id}/operations`, {
    method: "POST",
    body: {
      expected_revision: 0,
      actor: "you",
      operation: {
        type: "append_utterance",
        speaker: "you",
        text: "Server owned maps keep an exact transcript",
        realtime_item_id: "input-http-1",
      },
    },
  });
  assert.equal(transcript.data.ok, true);
  assert.equal(transcript.data.revision, 0, "transcript append is not a semantic map revision");

  const toolBody = {
    name: "create_bubble",
    call_id: "call-http-1",
    expected_revision: 0,
    arguments: {
      text: "Server owned maps",
      quote: "Server owned maps",
      parent_reference: null,
      expected_revision: 0,
    },
  };
  const createdBubble = await request(`/api/sessions/${id}/tool-calls`, { method: "POST", body: toolBody });
  assert.equal(createdBubble.data.revision, 1);
  assert.equal(createdBubble.data.snapshot.nodes.length, 1);
  assert.equal(createdBubble.data.snapshot.nodes[0].sources[0].quote, "Server owned maps");
  const createdOperation = createdBubble.data.snapshot.operations.at(-1);
  assert.equal(createdOperation.origin, "realtime");
  assert.equal(createdOperation.actor, "partner");
  const sourceUtterance = createdBubble.data.snapshot.transcript.find(({ id: utteranceId }) => (
    utteranceId === createdBubble.data.snapshot.nodes[0].sources[0].utterance_id
  ));
  assert.equal(sourceUtterance.realtime_item_id, "input-http-1");
  assert.equal(createdBubble.data.snapshot.operations.some((operation) => "change" in operation), false);
  assert.equal(createdBubble.data.snapshot.history_length, 1);
  assert.equal(createdBubble.data.function_call_output.type, "function_call_output");
  const modelOutput = JSON.parse(createdBubble.data.function_call_output.output);
  assert.equal(modelOutput.snapshot.operations, undefined);
  assert.equal(modelOutput.snapshot.transcript, undefined);
  assert.equal(modelOutput.snapshot.nodes.length, 1);
  assert.equal(modelOutput.snapshot.central_node_id, modelOutput.snapshot.nodes[0].id);

  const replay = await request(`/api/sessions/${id}/tool-calls`, { method: "POST", body: toolBody });
  assert.equal(replay.data.replayed, true);
  assert.equal(replay.data.snapshot.nodes.length, 1);

  const nodeId = replay.data.snapshot.nodes[0].id;
  const selected = await request(`/api/sessions/${id}/ui-context`, {
    method: "PATCH",
    body: { selected_node_ids: [nodeId], view_mode: "clusters", voice_mode: "vad" },
  });
  assert.deepEqual(selected.data.ui_context.selected_node_ids, [nodeId]);
  assert.equal(selected.data.snapshot.revision, 1);

  const edited = await request(`/api/sessions/${id}/tool-calls`, {
    method: "POST",
    body: {
      name: "edit_bubble",
      call_id: "call-http-2",
      expected_revision: 1,
      arguments: {
        node_reference: "$selected",
        text: "Canonical server owned maps",
        transcript_quote: null,
        realtime_item_id: null,
        expected_revision: 1,
      },
    },
  });
  assert.equal(edited.data.revision, 2);
  assert.equal(edited.data.snapshot.nodes[0].text, "Canonical server owned maps");

  const staleToolIntent = await request(`/api/sessions/${id}/tool-calls`, {
    method: "POST",
    body: {
      name: "edit_bubble",
      call_id: "call-http-stale",
      expected_revision: 2,
      arguments: {
        node_reference: nodeId,
        text: "Must not overwrite newer state",
        transcript_quote: null,
        realtime_item_id: null,
        expected_revision: 1,
      },
    },
  });
  assert.equal(staleToolIntent.response.status, 409);
  assert.equal(staleToolIntent.data.error.code, "revision_conflict");
  assert.equal(staleToolIntent.data.snapshot.nodes[0].text, "Canonical server owned maps");
  assert.equal(staleToolIntent.data.function_call_output.type, "function_call_output");
  assert.equal(JSON.parse(staleToolIntent.data.function_call_output.output).snapshot.revision, 2);

  const stale = await request(`/api/sessions/${id}/operations`, {
    method: "POST",
    body: {
      expected_revision: 0,
      operation: { type: "move_bubble", node_reference: nodeId, x: 10, y: 20 },
    },
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.data.error.code, "revision_conflict");
  assert.equal(stale.data.snapshot.revision, 2);

  const listed = await request("/api/sessions");
  assert.equal(listed.data.active_session_id, id);
  assert.equal(listed.data.sessions[0].thought_count, 1);

  const missingCallId = await request(`/api/sessions/${id}/tool-calls`, {
    method: "POST",
    body: { name: "get_map", arguments: {} },
  });
  assert.equal(missingCallId.response.status, 400);
  assert.equal(missingCallId.data.error.code, "missing_call_id");

  const directCuratorMutation = await request(`/api/sessions/${id}/operations`, {
    method: "POST",
    body: {
      expected_revision: 2,
      actor: "curator",
      operation: { type: "create_bubble", text: "Must remain a proposal" },
    },
  });
  assert.equal(directCuratorMutation.response.status, 403);
  assert.equal(directCuratorMutation.data.error.code, "curator_proposal_only");

  const child = await request(`/api/sessions/${id}/operations`, {
    method: "POST",
    body: {
      expected_revision: 2,
      actor: "you",
      operation: { type: "create_bubble", text: "Temporary child", parent: nodeId },
    },
  });
  const childId = child.data.snapshot.nodes.find((node) => node.text === "Temporary child").id;
  await request(`/api/sessions/${id}/ui-context`, {
    method: "PATCH",
    body: { selected_node_ids: [childId], view_mode: "clusters", voice_mode: "vad" },
  });
  const deletedChild = await request(`/api/sessions/${id}/operations`, {
    method: "POST",
    body: {
      expected_revision: 3,
      actor: "you",
      operation: { type: "delete_bubble", node_reference: childId },
    },
  });
  assert.deepEqual(deletedChild.data.snapshot.ui_context.selected_node_ids, []);

  const staleSelection = await request(`/api/sessions/${id}/tool-calls`, {
    method: "POST",
    body: {
      name: "edit_bubble",
      call_id: "call-after-delete",
      arguments: {
        node_reference: "$selected",
        text: "No stale selection",
        transcript_quote: null,
        realtime_item_id: null,
        expected_revision: 4,
      },
    },
  });
  assert.equal(staleSelection.response.status, 409);
  assert.equal(staleSelection.data.error.code, "selection_clarification_required");

  const blockedOrigin = await request("/api/sessions", {
    headers: { Origin: "https://attacker.example" },
  });
  assert.equal(blockedOrigin.response.status, 403);
  assert.equal(blockedOrigin.data.error.code, "origin_not_allowed");
});

test("a completed user append notifies the map controller but a Partner append does not", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "thoughtform-map-controller-http-"));
  const notifications = [];
  let waiting = false;
  let cancellations = 0;
  let disposals = 0;
  const scheduler = {
    notify: (...args) => { notifications.push(args); waiting = true; return true; },
    recover: () => false,
    retry: () => true,
    cancel: () => { cancellations += 1; return true; },
    state: () => ({ scheduled: waiting, active: false, queued: false }),
    dispose: () => { disposals += 1; },
  };
  const app = await createThoughtformServer({
    store: createSessionStore({ directory }),
    mapController: { model: "controller-test-model" },
    mapControllerScheduler: scheduler,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    app.locals.dispose?.();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });

  const request = async (pathname, body) => {
    const response = await fetch(`${base}${pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { response, data: await response.json() };
  };

  const created = await request("/api/sessions", {});
  const userAppend = await request(`/api/sessions/${created.data.id}/operations`, {
    expected_revision: 0,
    operation: {
      type: "append_utterance",
      speaker: "you",
      text: "Map this complete thought.",
      realtime_item_id: "input-user-thought-1",
    },
  });
  assert.equal(userAppend.response.status, 200);
  assert.equal(userAppend.data.snapshot.map_controller.status, "waiting");
  const partnerAppend = await request(`/api/sessions/${created.data.id}/operations`, {
    expected_revision: 0,
    operation: { type: "append_utterance", speaker: "partner", text: "Tell me more." },
  });
  assert.equal(partnerAppend.response.status, 200);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0][0], created.data.id);
  assert.deepEqual(notifications[0][1], userAppend.data.snapshot.transcript[0]);
  const replay = await request(`/api/sessions/${created.data.id}/operations`, {
    expected_revision: 0,
    operation: {
      type: "append_utterance",
      speaker: "you",
      text: "Map this complete thought.",
      realtime_item_id: "input-user-thought-1",
    },
  });
  assert.equal(replay.data.replayed, true);
  assert.equal(notifications.length, 1);
  const deleted = await fetch(`${base}/api/sessions/${created.data.id}`, { method: "DELETE" });
  assert.equal(deleted.status, 200);
  assert.equal(cancellations, 1);
  app.locals.dispose?.();
  assert.equal(disposals, 1);
});

test("the controller publishes its runtime status and applied snapshots over SSE", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "thoughtform-map-controller-sse-"));
  let hooks;
  let retries = 0;
  let schedulerState = { scheduled: false, preparing: false, active: false, queued: false };
  const scheduler = {
    notify: () => true,
    recover: () => false,
    retry: () => { retries += 1; return true; },
    cancel: () => false,
    state: () => schedulerState,
    dispose: () => {},
  };
  const app = await createThoughtformServer({
    store: createSessionStore({ directory }),
    env: { OPENAI_API_KEY: "test-key" },
    mapController: { model: "controller-test-model" },
    controllerEventEpoch: 41,
    mapControllerSchedulerFactory: (options) => {
      hooks = options;
      return scheduler;
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    app.locals.dispose?.();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });

  assert.equal(typeof hooks.onStateChange, "function");
  assert.equal(typeof hooks.onComplete, "function");
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.deepEqual(health.map_controller, {
    configured: true,
    enabled: true,
    model: "controller-test-model",
  });
  assert.equal("curator" in health, false);
  assert.equal("curatorScheduler" in app.locals, false);
  const created = await (await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  })).json();
  assert.equal(created.map_controller.status, "idle");
  assert.equal(created.controller_event_epoch, 41);
  assert.equal(created.controller_event_sequence, 0);
  const retry = await (await fetch(`${base}/api/sessions/${created.id}/map-controller/retry`, {
    method: "POST",
  })).json();
  assert.equal(retry.ok, true);
  assert.equal(retry.scheduled, true);
  assert.equal(retries, 1);
  assert.equal(retry.snapshot.controller_event_sequence, 1);
  const stream = await fetch(`${base}/api/sessions/${created.id}/events`);
  const reader = stream.body.getReader();
  await reader.read();
  await app.locals.sessionStore.transact(created.id, (session) => ({
    session: {
      ...session,
      map_controller: {
        ...session.map_controller,
        last_error: {
          code: "controller_test_failure",
          message: "Temporary controller failure",
          at: "2026-07-21T18:00:00.000Z",
        },
      },
    },
  }));
  schedulerState = { scheduled: false, preparing: true, active: false, queued: false };
  await hooks.onStateChange(created.id);
  schedulerState = { scheduled: false, preparing: false, active: false, queued: false };
  await hooks.onError(new Error("Temporary controller failure"), created.id);
  const applied = await app.locals.sessionStore.transact(created.id, (session) => ({
    session: {
      ...session,
      revision: 1,
      map_controller: {
        ...session.map_controller,
        processed_transcript_count: 0,
        last_run_id: "controller-run-1",
        last_error: null,
      },
    },
  }));
  await hooks.onComplete(created.id, { session: applied.session });
  let events = "";
  while (!events.includes('"last_run_id":"controller-run-1"')) {
    const { value, done } = await reader.read();
    assert.equal(done, false);
    events += new TextDecoder().decode(value);
  }
  assert.match(events, /event: map_controller/);
  assert.match(events, /"last_run_id":"controller-run-1"/);
  const controllerSnapshots = events
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)))
    .filter((payload) => payload.type === "map_controller")
    .map((payload) => payload.snapshot);
  assert.deepEqual(
    controllerSnapshots.map((snapshot) => [
      snapshot.revision,
      snapshot.controller_event_epoch,
      snapshot.controller_event_sequence,
      snapshot.map_controller.status,
    ]),
    [
      [0, 41, 2, "running"],
      [0, 41, 3, "error"],
      [1, 41, 4, "idle"],
    ],
  );
  const stored = await app.locals.sessionStore.get(created.id);
  assert.equal("controller_event_sequence" in stored, false);
  assert.equal("controller_event_epoch" in stored, false);
  await reader.cancel();
});

test("controller recovery only schedules unprocessed user work and disabling it keeps editing available", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "thoughtform-map-controller-recovery-"));
  const store = createSessionStore({ directory });
  await store.init();
  const userSession = await store.create();
  const partnerSession = await store.create();
  const append = (speaker, text) => (session) => applyOperation(session, {
    type: "append_utterance",
    speaker,
    text,
  });
  await store.transact(userSession.id, append("you", "Recover this thought."));
  await store.transact(partnerSession.id, append("partner", "This must not trigger recovery."));
  const recovered = [];
  const recoveryApp = await createThoughtformServer({
    store,
    env: { OPENAI_API_KEY: "test-key" },
    mapController: { model: "controller-test-model" },
    mapControllerScheduler: {
      notify: () => true,
      recover: (id) => { recovered.push(id); return true; },
      retry: () => true,
      cancel: () => false,
      state: () => ({ scheduled: false, active: false, queued: false }),
      dispose: () => {},
    },
  });
  assert.deepEqual(recovered, [userSession.id]);
  const recoveryServer = recoveryApp.listen(0, "127.0.0.1");
  await new Promise((resolve) => recoveryServer.once("listening", resolve));
  const recoveryBase = `http://127.0.0.1:${recoveryServer.address().port}`;
  const openedUserSession = await store.create();
  await store.transact(openedUserSession.id, append("you", "Recover when this session opens."));
  const opened = await fetch(`${recoveryBase}/api/sessions/${openedUserSession.id}`);
  assert.equal(opened.status, 200);
  assert.deepEqual(recovered, [userSession.id, openedUserSession.id]);
  recoveryApp.locals.dispose?.();
  await new Promise((resolve) => recoveryServer.close(resolve));

  const app = await createThoughtformServer({
    store: createSessionStore({ directory: `${directory}-offline` }),
    env: { OPENAI_API_KEY: "test-key", THOUGHTFORM_MAP_CONTROLLER_ENABLED: "false" },
    openaiClient: null,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    app.locals.dispose?.();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
    await rm(`${directory}-offline`, { recursive: true, force: true });
  });
  const create = await (await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  })).json();
  const edited = await fetch(`${base}/api/sessions/${create.id}/operations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      expected_revision: 0,
      operation: { type: "create_bubble", text: "Manual editing stays available" },
    }),
  });
  assert.equal(edited.status, 200);
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.map_controller.configured, true);
  assert.equal(health.map_controller.enabled, false);
  const retry = await fetch(`${base}/api/sessions/${create.id}/map-controller/retry`, { method: "POST" });
  assert.equal(retry.status, 503);
  assert.equal((await retry.json()).error.code, "map_controller_unavailable");
});
