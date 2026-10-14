import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createSessionStore, SESSION_SCHEMA_VERSION } from "../server/sessionStore.mjs";
import { createThoughtformServer } from "../server/index.mjs";
import { applyOperation } from "../server/sessionOperations.mjs";
import { sessionMarkdown } from "../server/sessionExport.mjs";

async function fixture(t, extra = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "thoughtform-workspace-"));
  const store = createSessionStore({ directory });
  const app = await createThoughtformServer({ store, env: { THOUGHTFORM_MAP_CONTROLLER_ENABLED: "false" }, ...extra });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const request = async (route, body, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(base + route, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  };
  t.after(async () => { app.locals.dispose(); await new Promise((resolve) => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  return { store, directory, app, request, base };
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
  assert.equal(calls[0].model, "gpt-6-luna");
  assert.equal(calls[0].reasoning.effort, "high");
  const saved = await store.get(session.id);
  assert.equal(saved.revision, later.revision);
  assert.equal(saved.nodes[0].text, "A refined thought");
  assert.equal(saved.synthesis.revision, first.revision);
  assert.equal(saved.synthesis.text, "A grounded synthesis.");
  assert.match(sessionMarkdown(saved), /map has changed since/);
});

test("an older synthesis never replaces a newer one, and repeated requests share one call", async (t) => {
  const pending = [];
  const openaiClient = { responses: { create: (body) => new Promise((resolve) => pending.push({ body, resolve })) } };
  const { request, store } = await fixture(t, { openaiClient });
  const session = await store.create();
  const first = await store.transact(session.id, (s) => applyOperation(s, { type: "create_bubble", actor: "you", text: "A thought", expected_revision: s.revision }));
  const older = request(`/sessions/${session.id}/synthesize`, { expected_revision: first.revision });
  const duplicate = request(`/sessions/${session.id}/synthesize`, { expected_revision: first.revision });
  while (pending.length < 1) await new Promise((resolve) => setImmediate(resolve));
  const later = await store.transact(session.id, (s) => applyOperation(s, { type: "edit_bubble", actor: "you", node_id: s.nodes[0].id, text: "A refined thought", expected_revision: s.revision }));
  const newer = request(`/sessions/${session.id}/synthesize`, { expected_revision: later.revision });
  while (pending.length < 2) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending.length, 2, "same-revision requests share one model call");
  pending[1].resolve({ output_text: "Newer synthesis." });
  assert.equal((await newer).data.synthesis, "Newer synthesis.");
  pending[0].resolve({ output_text: "Older synthesis." });
  const [olderResult, duplicateResult] = await Promise.all([older, duplicate]);
  assert.equal(olderResult.data.synthesis, "Newer synthesis.");
  assert.equal(olderResult.data.revision, later.revision);
  assert.equal(duplicateResult.data.synthesis, "Newer synthesis.");
  const saved = await store.get(session.id);
  assert.deepEqual([saved.synthesis.text, saved.synthesis.revision], ["Newer synthesis.", later.revision]);
});

test("deleting a session aborts its in-flight Partner request", async (t) => {
  let signal;
  let started;
  const began = new Promise((resolve) => { started = resolve; });
  const openaiClient = { responses: { create: (_body, options) => {
    signal = options?.signal;
    started();
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  } } };
  const { request, store } = await fixture(t, { openaiClient });
  const session = await store.create();
  const chat = request(`/sessions/${session.id}/chat`, { text: "What am I missing here?", request_id: "chat-delete-1" });
  await began;
  assert.equal(signal.aborted, false);
  assert.equal((await request(`/sessions/${session.id}`, undefined, "DELETE")).status, 200);
  assert.equal(signal.aborted, true);
  assert.equal((await chat).status, 410);
});

test("server configuration comes only from the injected environment", async (t) => {
  const health = async (env) => {
    const { base } = await fixture(t, { env: { THOUGHTFORM_MAP_CONTROLLER_ENABLED: "false", ...env } });
    return (await fetch(`${base}/health`)).json();
  };
  const unconfigured = await health({});
  assert.equal(unconfigured.live.configured, false);
  assert.equal(unconfigured.live.voice_configured, false);
  const configured = await health({ OPENAI_API_KEY: "test-key", OPENAI_LIVE_MODEL: "custom-live", OPENAI_LIVE_BACKEND_MODEL: " " });
  assert.equal(configured.live.configured, true);
  assert.equal(configured.live.voice_configured, true);
  assert.equal(configured.live.model, "custom-live");
  assert.equal(configured.live.backend_model, "gpt-6-luna");
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
