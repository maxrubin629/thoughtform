import assert from "node:assert/strict";
import test from "node:test";
import { createExampleWorkspace } from "../src/exampleWorkspace.js";
import { validateSession } from "../shared/sessionSchema.mjs";

// Storage contract double. Real IndexedDB transaction/reopen checks run in
// example-browser.html; these tests exercise the shared operations and history.
function memoryStore() {
  let state = { version: 1, active_session_id: null, sessions: {} };
  return {
    async read(fn) { return fn(structuredClone(state)); },
    async write(fn) { const next = structuredClone(state); const result = fn(next); state = next; return result; },
    async close() {},
  };
}
const clientFor = store => createExampleWorkspace({ store, channel: null });
const full = async (client, id) => JSON.parse((await client.exportSession(id)).text);
const operation = (client, snapshot, value) => client.applySessionOperation(snapshot.id, value, { expectedRevision: snapshot.revision });

test("the example preserves exact sources and the full original undo/redo history", async () => {
  const client = clientFor(memoryStore());
  let { snapshot } = await client.bootstrap();
  const initial = await full(client, snapshot.id);
  assert.equal(initial.nodes.length, 5);
  assert.equal(snapshot.operations.some(item => item.change), false);
  assert.ok(initial.operations.some(item => item.change));
  assert.ok(initial.operations.some(item => item.history_entry_ids?.length === initial.history_cursor));
  for (const node of initial.nodes) for (const span of node.sources) {
    assert.equal(initial.transcript.find(item => item.id === span.utterance_id).text.slice(span.start, span.end), span.quote);
  }
  const count = initial.history_cursor;
  for (let i = 0; i < count; i++) ({ snapshot } = await operation(client, snapshot, { type: 'undo_map_change' }));
  assert.equal(snapshot.nodes.length, 0);
  for (let i = 0; i < count; i++) ({ snapshot } = await operation(client, snapshot, { type: 'redo_map_change' }));
  assert.deepEqual(snapshot.nodes, initial.nodes);
  assert.deepEqual(snapshot.edges, initial.edges);
  assert.deepEqual(snapshot.transcript, initial.transcript);
});

test("proposal undo, reopen, redo and JSON import preserve history and evidence", async () => {
  const store = memoryStore();
  let client = clientFor(store);
  let { snapshot } = await client.bootstrap();
  ({ snapshot } = await operation(client, snapshot, { type: 'accept_proposal', proposal_id: 'trial_proposal' }));
  assert.equal(snapshot.nodes.length, 6);
  ({ snapshot } = await operation(client, snapshot, { type: 'undo_map_change' }));
  const exported = await full(client, snapshot.id);
  assert.equal(exported.proposals[0].status, 'pending');
  await client.dispose();
  client = clientFor(store);
  ({ snapshot } = await client.bootstrap());
  ({ snapshot } = await operation(client, snapshot, { type: 'redo_map_change' }));
  assert.equal(snapshot.nodes.length, 6);
  const imported = await client.importSession(exported);
  assert.notEqual(imported.id, snapshot.id);
  const redo = await operation(client, imported, { type: 'redo_map_change' });
  assert.equal(redo.snapshot.nodes.length, 6);
  assert.deepEqual(redo.snapshot.transcript, exported.transcript);
  assert.deepEqual(redo.snapshot.proposals[0].evidence, exported.proposals[0].evidence);
  validateSession(await full(client, imported.id));
  const markdown = (await client.exportSession(imported.id, 'markdown')).text;
  assert.match(markdown, /## Conversation/);
  assert.match(markdown, /> neighborhood reading room/);
  assert.match(markdown, /## Synthesis/);
});

test("failed writes and invalid imports preserve the saved map; examples never overwrite existing copies", async () => {
  const store = memoryStore();
  const client = clientFor(store);
  const { snapshot } = await client.bootstrap();
  const before = await full(client, snapshot.id);
  await assert.rejects(operation(client, snapshot, { type: 'connect_bubbles', from: 'reading_room', to: 'missing' }));
  const invalid = structuredClone(before); invalid.nodes[0].sources[0].quote = 'invented';
  await assert.rejects(client.importSession(invalid));
  assert.deepEqual(await full(client, snapshot.id), before);
  const another = await client.createExample();
  assert.notEqual(another.id, snapshot.id);
  assert.deepEqual(await full(client, snapshot.id), before);
  store.write = async () => { throw new Error('Disk full'); };
  await assert.rejects(operation(client, snapshot, { type: 'edit_bubble', node_id: 'reading_room', text: 'Changed' }), /Disk full/);
  assert.deepEqual(await full(client, snapshot.id), before);
});

test("separate browser stores are independent and example AI capabilities never call fetch", async () => {
  const left = clientFor(memoryStore()); const right = clientFor(memoryStore());
  const a = (await left.bootstrap()).snapshot; const b = (await right.bootstrap()).snapshot;
  await operation(left, a, { type: 'edit_bubble', node_id: 'reading_room', text: 'My practice copy' });
  assert.equal((await right.getSession(b.id)).nodes[0].text, 'A neighborhood reading room');
  for (const method of ['sendSessionChat', 'synthesizeSession', 'retryLiveCapture', 'retrySessionMapController']) {
    await assert.rejects(left[method](a.id), /off in this example/);
  }
});
