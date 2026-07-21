import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createThoughtformServer } from "../server/index.mjs";
import { createSessionStore } from "../server/sessionStore.mjs";

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
      transcript_quote: "Server owned maps",
      realtime_item_id: "input-http-1",
      parent_reference: null,
      expected_revision: 0,
    },
  };
  const createdBubble = await request(`/api/sessions/${id}/tool-calls`, { method: "POST", body: toolBody });
  assert.equal(createdBubble.data.revision, 1);
  assert.equal(createdBubble.data.snapshot.nodes.length, 1);
  assert.equal(createdBubble.data.snapshot.nodes[0].sources[0].quote, "Server owned maps");
  assert.equal(createdBubble.data.function_call_output.type, "function_call_output");

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
