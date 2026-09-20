import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SessionStore } from "../server/sessionStore.mjs";
import { createLiveCapture, normalizeTranscriptEvent, pendingFragments, validateCompletionGroups } from "../server/liveCapture.mjs";
import { ensureLiveState } from "../server/liveState.mjs";

async function setup(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "thoughtform-live-capture-"));
  const store = new SessionStore({ directory });
  await store.init();
  const session = await store.create();
  await store.transact(session.id, (current) => {
    const capture = ensureLiveState(current);
    capture.known_session_ids = ["live_one"];
    capture.active_session_id = "live_one";
    return current;
  });
  const capture = createLiveCapture({ store, debounceMs: 60_000, ...options });
  t.after(async () => { capture.dispose(); await rm(directory, { recursive: true, force: true }); });
  return { store, capture, id: session.id };
}

const delta = (id, text, start = 0, end = 100, speaker = "input") => ({ type: `session.${speaker}_transcript.delta`, event_id: id, delta: text, start_ms: start, end_ms: end });

test("Live raw deltas preserve exact bytes, overlap, and idempotent event identity", async (t) => {
  const { store, capture, id } = await setup(t, { classify: async () => [] });
  const events = [delta("user", "  α\n", 0, 100), delta("assistant", "Yes", 40, 150, "output")];
  await capture.ingest(id, "live_one", events);
  await capture.ingest(id, "live_one", events);
  const saved = await store.get(id);
  assert.equal(saved.transcript_fragments.length, 2);
  assert.equal(saved.transcript_fragments[0].delta, "  α\n");
  assert.equal(saved.transcript_fragments[1].start_ms, 40);
  assert.equal(saved.transcript.length, 0);
  await assert.rejects(capture.ingest(id, "live_one", [delta("user", "changed", 0, 100)]), { code: "fragment_conflict" });
});

test("Incomplete thought survives end hints and only exact complete sources become utterances", async (t) => {
  let complete = false;
  const notified = [];
  const { store, capture, id } = await setup(t, {
    classify: async ({ fragments }) => complete ? [{ fragment_ids: fragments.map(({ id: fragmentId }) => fragmentId) }] : [],
    onTranscriptCommitted: (_id, utterance) => notified.push(utterance),
  });
  await capture.ingest(id, "live_one", [delta("a", "If we build", 0, 100)]);
  await capture.flush(id, { ended: true, activity: { active: false, at_ms: 100 } });
  assert.equal((await store.get(id)).transcript.length, 0);
  assert.equal(pendingFragments(await store.get(id)).length, 1);
  await capture.ingest(id, "live_one", [delta("b", " this, it can work.", 200, 400)]);
  complete = true;
  await capture.flush(id);
  const saved = await store.get(id);
  assert.equal(saved.transcript[0].text, "If we build this, it can work.");
  assert.deepEqual(saved.live_capture.utterance_sources[0], { utterance_id: saved.transcript[0].id, fragment_ids: ["live_one:a", "live_one:b"] });
  assert.equal(notified.length, 1);
  assert.equal(pendingFragments(saved).length, 0);
  await capture.flush(id);
  assert.equal(notified.length, 1);
});

test("Speaker changes do not finalize unfinished speech, and source order cannot be skipped", () => {
  const fragments = [normalizeTranscriptEvent(delta("a", "If", 0, 10), "live_one"), normalizeTranscriptEvent(delta("b", "yes", 2, 15, "output"), "live_one"), normalizeTranscriptEvent(delta("c", " it works", 11, 30), "live_one")];
  assert.deepEqual(validateCompletionGroups(fragments, [{ fragment_ids: ["live_one:b"] }])[0].map(({ delta: text }) => text), ["yes"]);
  assert.throws(() => validateCompletionGroups(fragments, [{ fragment_ids: ["live_one:c"] }]), { code: "invalid_completion" });
  assert.throws(() => validateCompletionGroups(fragments, [{ fragment_ids: ["live_one:a", "live_one:b"] }]), { code: "invalid_completion" });
});

test("Late incoming text invalidates an in-flight classification before it commits", async (t) => {
  let release;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  let calls = 0;
  const { store, capture, id } = await setup(t, { classify: async ({ fragments }) => {
    calls += 1;
    if (calls === 1) { entered(); await new Promise((resolve) => { release = resolve; }); return [{ fragment_ids: fragments.map(({ id: fragmentId }) => fragmentId) }]; }
    return [];
  } });
  await capture.ingest(id, "live_one", [delta("a", "That works.")]);
  const finishing = capture.flush(id);
  await started;
  await capture.ingest(id, "live_one", [delta("b", " Unless", 110, 200)]);
  release();
  await finishing;
  const saved = await store.get(id);
  assert.equal(saved.transcript.length, 0);
  assert.equal(saved.transcript_fragments.length, 2);
  assert.ok(calls >= 2);
});

test("Known retired sessions accept late source fragments while unknown sessions fail", async (t) => {
  const { store, capture, id } = await setup(t, { classify: async () => [] });
  await store.transact(id, (session) => { session.live_capture.active_session_id = "live_two"; session.live_capture.known_session_ids.push("live_two"); return session; });
  await capture.ingest(id, "live_one", [delta("late", "the rest", 500, 1000)]);
  await assert.rejects(capture.ingest(id, "unknown", [delta("bad", "bad")]), { code: "unknown_live_session" });
  assert.equal((await store.get(id)).live_capture.active_session_id, "live_two");
});

test("Capture continues preserving completed conversation while mapping is paused", async (t) => {
  const { store, capture, id } = await setup(t, { classify: async ({ fragments }) => [{ fragment_ids: fragments.map(({ id: fragmentId }) => fragmentId) }] });
  await store.transact(id, (session) => { session.preferences.mapping_paused = true; return session; });
  await capture.ingest(id, "live_one", [delta("a", "A complete thought.")]);
  await capture.flush(id);
  const saved = await store.get(id);
  assert.equal(saved.transcript.length, 1);
  assert.equal(saved.nodes.length, 0);
  assert.equal(saved.preferences.mapping_paused, true);
});

test("Actual active microphone defers classification and out-of-order activity hints cannot re-pause capture", async (t) => {
  let calls = 0;
  const { store, capture, id } = await setup(t, { classify: async ({ fragments }) => { calls += 1; return [{ fragment_ids: fragments.map(({ id: fragmentId }) => fragmentId) }]; } });
  await capture.flush(id, { activity: { active: true, at_ms: 100 }, live_session_id: "live_one" });
  await capture.ingest(id, "live_one", [delta("a", "A sentence.")]);
  await capture.flush(id);
  assert.equal(calls, 0);
  await capture.flush(id, { activity: { active: false, at_ms: 200 }, live_session_id: "live_one" });
  assert.equal((await store.get(id)).transcript.length, 1);
  await capture.flush(id, { activity: { active: true, at_ms: 150 }, live_session_id: "live_one" });
  await capture.ingest(id, "live_one", [delta("b", "Another sentence.", 200, 300)]);
  await capture.flush(id);
  assert.equal((await store.get(id)).transcript.length, 2);
});
