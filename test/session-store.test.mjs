import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  SessionRevisionConflictError,
  SessionSchemaError,
  SessionStore,
  UNTITLED_SESSION_TITLE,
} from "../server/sessionStore.mjs";
import { applyOperation } from "../server/sessionOperations.mjs";

async function temporaryStore() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "thoughtform-sessions-"));
  let counter = 0;
  let tick = 0;
  const store = new SessionStore({
    directory,
    idFactory: () => `session-${++counter}`,
    now: () => new Date(Date.UTC(2026, 6, 20, 12, 0, tick++)),
  });
  await store.init();
  return { store, directory };
}

test("creates, lists, renames, resumes, and deletes local sessions", async () => {
  const { store } = await temporaryStore();
  assert.equal(await store.resume(), null);

  const first = await store.create();
  assert.equal(first.title, UNTITLED_SESSION_TITLE);
  assert.equal(first.schema_version, 2);
  assert.equal(first.revision, 0);
  assert.deepEqual(first.nodes, []);
  assert.deepEqual(first.map_controller, {
    processed_transcript_count: 0,
    last_run_id: null,
    last_success_at: null,
    last_error: null,
  });

  const second = await store.create({ title: "Voice agents" });
  let listing = await store.list();
  assert.equal(listing.active_session_id, second.id);
  assert.deepEqual(listing.sessions.map(({ id }) => id), [second.id, first.id]);
  assert.equal((await store.resume()).id, second.id);

  const renamed = await store.rename(first.id, "Realtime map");
  assert.equal(renamed.title, "Realtime map");
  assert.equal((await store.resume()).id, second.id, "renaming a background session does not steal active status");

  await store.delete(first.id);
  listing = await store.list();
  assert.equal(listing.active_session_id, second.id);
  assert.deepEqual(listing.sessions.map(({ id }) => id), [second.id]);
});

test("listing and resume skip corrupt or concurrently removed session files", async () => {
  const { store, directory } = await temporaryStore();
  const valid = await store.create({ title: "Valid" });
  await writeFile(path.join(directory, "broken.json"), "{not json", "utf8");
  await writeFile(path.join(directory, "invalid.json"), "{}\n", "utf8");

  const listing = await store.list();
  assert.deepEqual(listing.sessions.map(({ id }) => id), [valid.id]);
  assert.deepEqual(listing.warnings.map(({ filename }) => filename).sort(), ["broken.json", "invalid.json"]);
  assert.equal((await store.resume()).id, valid.id);
});

test("background saves do not change the active session", async () => {
  const { store } = await temporaryStore();
  const active = await store.create({ title: "Active" });
  const background = await store.create({ title: "Background" });
  await store.setActive(active.id);

  await store.transact(background.id, (session) => {
    session.revision += 1;
    session.updated_at = new Date(Date.parse(session.updated_at) + 1_000).toISOString();
    return session;
  });

  assert.equal((await store.list()).active_session_id, active.id);
});

test("writes session JSON atomically without leaving temporary files", async () => {
  const { store, directory } = await temporaryStore();
  const session = await store.create({ title: "Atomic" });
  session.revision = 1;
  session.updated_at = new Date(Date.parse(session.updated_at) + 1_000).toISOString();
  await store.save(session, { expectedRevision: 0 });

  const filenames = await readdir(directory);
  assert.equal(filenames.some((filename) => filename.endsWith(".tmp")), false);
  const persisted = JSON.parse(await readFile(path.join(directory, `${session.id}.json`), "utf8"));
  assert.equal(persisted.revision, 1);
});

test("startup recovers by discarding an orphaned atomic-write temporary file", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "thoughtform-recovery-"));
  await writeFile(path.join(directory, ".session-crash.json.123.tmp"), "partial", "utf8");
  const store = new SessionStore({ directory, idFactory: () => "session-recovered" });

  await store.init();
  assert.deepEqual((await readdir(directory)).sort(), ["_index.json"]);
  const session = await store.create({ title: "Recovered" });
  assert.equal((await store.get(session.id)).title, "Recovered");
});

test("rejects a stale save and includes the current snapshot", async () => {
  const { store } = await temporaryStore();
  const original = await store.create();
  const current = structuredClone(original);
  current.revision = 1;
  current.updated_at = new Date(Date.parse(current.updated_at) + 1_000).toISOString();
  await store.save(current, { expectedRevision: 0 });

  const stale = structuredClone(original);
  stale.title = "Stale write";
  await assert.rejects(
    store.save(stale, { expectedRevision: 0 }),
    (error) => {
      assert.ok(error instanceof SessionRevisionConflictError);
      assert.equal(error.current_revision, 1);
      assert.equal(error.snapshot.title, current.title);
      return true;
    },
  );
});

test("strictly rejects unsupported or malformed persisted schemas", async () => {
  const { store, directory } = await temporaryStore();
  const session = await store.create();
  const filename = path.join(directory, `${session.id}.json`);

  await writeFile(filename, `${JSON.stringify({ ...session, schema_version: 3 })}\n`, "utf8");
  await assert.rejects(store.get(session.id), SessionSchemaError);

  await writeFile(filename, `${JSON.stringify({ ...session, unexpected: true })}\n`, "utf8");
  await assert.rejects(store.get(session.id), SessionSchemaError);
});

test("migrates v1 session and index files without backfilling historical transcript", async () => {
  const { store, directory } = await temporaryStore();
  const current = await store.create({ title: "Migration source" });
  const legacy = {
    ...current,
    schema_version: 1,
    transcript: [{
      id: "utterance-legacy",
      speaker: "you",
      text: "Already processed before the controller existed.",
      completed_at: current.created_at,
    }],
  };
  delete legacy.map_controller;
  await writeFile(path.join(directory, `${current.id}.json`), `${JSON.stringify(legacy)}\n`, "utf8");
  await writeFile(path.join(directory, "_index.json"), `${JSON.stringify({
    schema_version: 1,
    active_session_id: current.id,
  })}\n`, "utf8");

  const migratedStore = new SessionStore({ directory, idFactory: () => "unused" });
  const migrated = await migratedStore.get(current.id);
  assert.equal(migrated.schema_version, 2);
  assert.equal(migrated.map_controller.processed_transcript_count, 1);
  assert.equal(migrated.map_controller.last_run_id, null);
  assert.equal(JSON.parse(await readFile(path.join(directory, "_index.json"), "utf8")).schema_version, 2);
  assert.equal(JSON.parse(await readFile(path.join(directory, `${current.id}.json`), "utf8")).schema_version, 2);
});

test("migrates legacy curator records to the conservative ui origin", async () => {
  const { store, directory } = await temporaryStore();
  const current = await store.create({ title: "Legacy curator" });
  const legacy = {
    ...current,
    schema_version: 1,
    operations: [{
      id: "operation-legacy-curator",
      type: "propose_changes",
      actor: "curator",
      created_at: current.created_at,
    }],
  };
  delete legacy.map_controller;
  await writeFile(path.join(directory, `${current.id}.json`), `${JSON.stringify(legacy)}\n`, "utf8");

  const migrated = await store.get(current.id);
  assert.equal(migrated.operations[0].actor, "curator");
  assert.equal(migrated.operations[0].origin, "ui");
});

test("rejects v2 realtime and controller records whose actor is not Partner", async () => {
  const { store, directory } = await temporaryStore();
  const session = await store.create();
  const invalid = structuredClone(session);
  invalid.operations.push({
    id: "operation-invalid-origin-actor",
    type: "create_bubble",
    actor: "you",
    origin: "realtime",
    created_at: session.created_at,
  });
  await writeFile(path.join(directory, `${session.id}.json`), `${JSON.stringify(invalid)}\n`, "utf8");
  await assert.rejects(store.get(session.id), SessionSchemaError);

  invalid.operations[0].origin = "map_controller";
  await writeFile(path.join(directory, `${session.id}.json`), `${JSON.stringify(invalid)}\n`, "utf8");
  await assert.rejects(store.get(session.id), SessionSchemaError);
});

test("rejects unknown session and index schema versions", async () => {
  const { store, directory } = await temporaryStore();
  const session = await store.create();
  await writeFile(path.join(directory, `${session.id}.json`), `${JSON.stringify({ ...session, schema_version: 99 })}\n`, "utf8");
  await assert.rejects(store.get(session.id), SessionSchemaError);

  await writeFile(path.join(directory, "_index.json"), `${JSON.stringify({
    schema_version: 99,
    active_session_id: session.id,
  })}\n`, "utf8");
  const freshStore = new SessionStore({ directory, idFactory: () => "unused" });
  await assert.rejects(freshStore.init(), SessionSchemaError);
});

test("commits a controller checkpoint atomically with a map operation without adding a semantic revision", async () => {
  const { store } = await temporaryStore();
  const created = await store.create();
  const result = await store.transact(created.id, (session) => {
    const operation = applyOperation(session, {
      type: "create_bubble",
      text: "Atomic controller run",
      origin: "map_controller",
      expected_revision: session.revision,
    }, {
      idFactory: (kind) => `${kind}-atomic`,
      now: () => new Date("2026-07-21T12:00:00.000Z"),
    });
    operation.session.map_controller = {
      processed_transcript_count: 0,
      last_run_id: "run-atomic",
      last_success_at: "2026-07-21T12:00:00.000Z",
      last_error: null,
    };
    return operation;
  });

  assert.equal(result.session.revision, 1);
  assert.equal(result.session.map_controller.last_run_id, "run-atomic");
  assert.equal((await store.get(created.id)).map_controller.last_success_at, "2026-07-21T12:00:00.000Z");

  const checkpointOnly = await store.transact(created.id, (session) => {
    session.map_controller.last_error = {
      code: "temporary_failure",
      message: "Retry later.",
      at: "2026-07-21T12:01:00.000Z",
    };
    return session;
  });
  assert.equal(checkpointOnly.revision, 1, "checkpoint-only status updates are not semantic revisions");
});

test("serializes concurrent transactions for one session", async () => {
  const { store } = await temporaryStore();
  const session = await store.create();
  await Promise.all([
    store.transact(session.id, async (current) => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      current.revision += 1;
      current.title = "First";
      current.updated_at = new Date(Date.parse(current.updated_at) + 1_000).toISOString();
      return current;
    }),
    store.transact(session.id, (current) => {
      current.revision += 1;
      current.title += " + second";
      current.updated_at = new Date(Date.parse(current.updated_at) + 1_000).toISOString();
      return current;
    }),
  ]);
  const saved = await store.get(session.id);
  assert.equal(saved.revision, 2);
  assert.equal(saved.title, "First + second");
});
