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
  assert.equal(first.schema_version, 1);
  assert.equal(first.revision, 0);
  assert.deepEqual(first.nodes, []);

  const second = await store.create({ title: "Voice agents" });
  let listing = await store.list();
  assert.equal(listing.active_session_id, second.id);
  assert.deepEqual(listing.sessions.map(({ id }) => id), [second.id, first.id]);
  assert.equal((await store.resume()).id, second.id);

  const renamed = await store.rename(first.id, "Realtime map");
  assert.equal(renamed.title, "Realtime map");
  assert.equal((await store.resume()).id, first.id);

  await store.delete(first.id);
  listing = await store.list();
  assert.equal(listing.active_session_id, second.id);
  assert.deepEqual(listing.sessions.map(({ id }) => id), [second.id]);
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

  await writeFile(filename, `${JSON.stringify({ ...session, schema_version: 2 })}\n`, "utf8");
  await assert.rejects(store.get(session.id), SessionSchemaError);

  await writeFile(filename, `${JSON.stringify({ ...session, unexpected: true })}\n`, "utf8");
  await assert.rejects(store.get(session.id), SessionSchemaError);
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
