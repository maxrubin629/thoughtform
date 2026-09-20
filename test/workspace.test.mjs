import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { SESSION_SCHEMA_VERSION } from "../server/sessionStore.mjs";
import { startTestServer } from "./helpers/server.mjs";
import { applyOperation } from "../server/sessionOperations.mjs";
import { sessionMarkdown } from "../server/sessionExport.mjs";

async function fixture(t, extra = {}) {
  const server = await startTestServer(t, { env: { THOUGHTFORM_MAP_CONTROLLER_ENABLED: "false" }, ...extra });
  return { ...server, request: (route, body, method = body === undefined ? "GET" : "POST") => server.request(route, { body, method }) };
}

test("v2 migration preserves processing checkpoint and keeps an original backup", async (t) => {
  const { store, directory } = await fixture(t);
  const current = await store.create();
  const legacy = { ...current, schema_version: 2 };
  for (const key of ["preferences", "synthesis", "transcript_fragments", "live_capture"]) delete legacy[key];
  legacy.map_controller.last_run_id = "already-finished";
  await writeFile(path.join(directory, `${legacy.id}.json`), JSON.stringify(legacy));
  const migrated = await store.get(legacy.id);
  assert.equal(migrated.schema_version, SESSION_SCHEMA_VERSION);
  assert.equal(migrated.map_controller.last_run_id, "already-finished");
  assert.deepEqual(migrated.preferences, { mapping_paused: false, partner_mode: "proactive" });
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, `${legacy.id}.json.v2.backup`), "utf8")), legacy);
});

test("workspace settings persist independently of graph revision and reject malformed input", async (t) => {
  const { request, store } = await fixture(t);
  const { data: session } = await request("/sessions", {});
  const { data, status } = await request(`/sessions/${session.id}/preferences`, { mapping_paused: true, partner_mode: "quiet" }, "PATCH");
  assert.equal(status, 200);
  assert.equal(data.snapshot.revision, session.revision);
  assert.equal(data.snapshot.preferences.mapping_paused, true);
  assert.ok(data.snapshot.controller_event_sequence > session.controller_event_sequence);
  assert.equal((await store.get(session.id)).preferences.partner_mode, "quiet");
  assert.equal((await request(`/sessions/${session.id}/preferences`, { partner_mode: "noisy" }, "PATCH")).status, 400);
  assert.equal((await request(`/sessions/${session.id}/preferences`, { mapping_paused: "false" }, "PATCH")).status, 400);
});

test("synthesis is saved against its source revision even if the map changes while generating", async (t) => {
  let finish;
  let started;
  const began = new Promise((resolve) => { started = resolve; });
  const response = new Promise((resolve) => { finish = resolve; });
  const calls = [];
  const { request, store } = await fixture(t, { openaiClient: { responses: { create: (body) => { calls.push(body); started(); return response; } } } });
  const session = await store.create();
  const first = await store.transact(session.id, (s) => applyOperation(s, { type: "create_bubble", actor: "you", text: "A clear thought", expected_revision: s.revision }));
  const generation = request(`/sessions/${session.id}/synthesize`, { expected_revision: first.revision });
  await began;
  const later = await store.transact(session.id, (s) => applyOperation(s, { type: "edit_bubble", actor: "you", node_id: s.nodes[0].id, text: "A refined thought", expected_revision: s.revision }));
  finish({ output_text: "A grounded synthesis." });
  const result = await generation;
  assert.equal(result.status, 200);
  assert.equal(calls[0].model, "gpt-5.6-terra");
  assert.equal(calls[0].reasoning.effort, "medium");
  const saved = await store.get(session.id);
  assert.equal(saved.revision, later.revision);
  assert.equal(saved.nodes[0].text, "A refined thought");
  assert.equal(saved.synthesis.revision, first.revision);
  assert.equal(saved.synthesis.text, "A grounded synthesis.");
  assert.match(sessionMarkdown(saved), /map has changed since/);
});

test("public session snapshots omit raw Live storage while export preserves it", async (t) => {
  const { request, store, base } = await fixture(t);
  const session = await store.create();
  const result = await request(`/sessions/${session.id}`);
  assert.equal(result.data.transcript_fragments, undefined);
  assert.equal(result.data.live_capture, undefined);
  assert.equal(result.data.capture_status.pending_fragments, 0);
  const exported = await fetch(`${base}/sessions/${session.id}/export?format=json`);
  assert.match(exported.headers.get("content-disposition"), /attachment/);
  assert.deepEqual((await exported.json()).transcript_fragments, []);
});

test("Markdown export carries exact provenance and connection destinations", () => {
  const content = sessionMarkdown({
    title: "My map", revision: 2, updated_at: "2026-09-17T00:00:00Z", synthesis: null,
    nodes: [{ id: "n1", text: "Idea", sources: [{ utterance_id: "u1", start: 5, end: 13 }] }, { id: "n2", text: "Connection", sources: [], parked: true }],
    edges: [{ from: "n1", to: "n2" }],
    transcript: [{ id: "u1", speaker: "you", text: "Some exact words", completed_at: "2026-09-17T00:00:00Z" }],
  });
  assert.match(content, /> exact wo/);
  assert.match(content, /Connected to: Connection/);
  assert.match(content, /Kept aside/);
});
