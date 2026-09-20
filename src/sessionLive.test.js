import assert from "node:assert/strict";
import { test } from "node:test";
import { groupLiveTranscriptFragments, SessionLiveClient } from "./sessionLive.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));
function fragment(eventId, delta, start = 0, speaker = "you") {
  return { type: `session.${speaker === "you" ? "input" : "output"}_transcript.delta`, event_id: eventId, delta, start_ms: start, end_ms: start + 100 };
}
function memoryStorage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
}
class Channel extends EventTarget {
  readyState = "open";
  sent = [];
  constructor({ autoAck = true } = {}) { super(); this.autoAck = autoAck; }
  send(value) {
    const event = JSON.parse(value);
    this.sent.push(event);
    if (this.autoAck) queueMicrotask(() => {
      let type = event.type.replace(/\.append$/, ".appended");
      if (event.type === "session.input_audio.mute") type = "session.input_audio.muted";
      if (event.type === "session.input_audio.unmute") type = "session.input_audio.unmuted";
      if (event.type === "session.close") type = "session.closed";
      this.receive({ type, event_id: `ack_${event.event_id}`, client_event_id: event.event_id });
    });
  }
  receive(event) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) })); }
  close() { this.readyState = "closed"; this.dispatchEvent(new Event("close")); }
}
function fixture(options = {}) {
  const channel = new Channel({ autoAck: options.autoAck });
  const track = { enabled: true, stopped: false, stop() { this.stopped = true; } };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const requests = [];
  const peer = new EventTarget();
  Object.assign(peer, {
    connectionState: "connected", iceGatheringState: "complete", channel,
    createDataChannel: () => channel, addTrack() {}, createOffer: async () => ({ type: "offer", sdp: "before-candidates" }),
    setLocalDescription: async () => { peer.localDescription = { type: "offer", sdp: "with-candidates" }; },
    setRemoteDescription: async (description) => { peer.remoteDescription = description; if (options.autoStarted !== false) channel.receive({ type: "session.started", session: { id: "live-session" } }); },
    close() { this.connectionState = "closed"; },
  });
  const api = {
    negotiateLiveSession: async (sessionId, sdp) => { requests.push(["negotiate", sdp]); return { session: { id: "live-session" }, transport: { sdp: "answer" } }; },
    persistLiveEvents: async (sessionId, liveId, events) => { requests.push(["persist", liveId, events]); return { ok: true, pending_fragment_ids: events.map((event) => `${liveId}:${event.event_id}`) }; },
    flushLiveTranscript: async (sessionId, liveId, args) => { requests.push(["flush", liveId, args]); return { ok: true }; },
    delegateLiveTask: async () => ({ ok: true, events: [] }),
    sendSessionChat: async (sessionId, text, args) => { requests.push(["chat", text, args]); return { ok: true, reply: "A useful question", snapshot: { id: sessionId, revision: 3 } }; },
    ...options.api,
  };
  const client = new SessionLiveClient({
    sessionId: "canonical-1", storage: options.storage ?? memoryStorage(),
    mediaDevices: { getUserMedia: async () => stream }, peerConnectionFactory: () => peer,
    audioContextFactory: () => null, batchMs: 60_000, timeouts: { setup: 100, command: 100, close: 100, reconnect: 20 },
    ...options, api,
  });
  return { client, channel, peer, track, requests };
}

test("WebRTC sends gathered SDP and waits for session.started without sending session.start", async (t) => {
  const { client, channel, peer, requests } = fixture({ autoStarted: false });
  t.after(() => client.disconnect());
  let resolved = false;
  const connecting = client.connect().then(() => { resolved = true; });
  await tick();
  assert.equal(resolved, false);
  assert.deepEqual(requests[0], ["negotiate", "with-candidates"]);
  assert.equal(peer.remoteDescription.sdp, "answer");
  channel.receive({ type: "session.started", session: { id: "live-session" } });
  await connecting;
  assert.equal(client.connected, true);
  assert.equal(channel.sent.length, 0);
});

test("ICE gathering completes before the server receives the offer", async (t) => {
  const { client, peer, requests } = fixture();
  peer.iceGatheringState = "gathering";
  t.after(() => client.disconnect());
  const connecting = client.connect();
  await tick();
  assert.equal(requests.length, 0);
  peer.iceGatheringState = "complete";
  peer.dispatchEvent(new Event("icegatheringstatechange"));
  await connecting;
  assert.equal(requests[0][0], "negotiate");
});

test("late negotiation cannot restart a cancelled voice session", async () => {
  let finish;
  const { client, track, peer } = fixture({ api: {
    negotiateLiveSession: () => new Promise((resolve) => { finish = resolve; }),
  } });
  const connecting = client.connect();
  await tick();
  client.disconnect();
  finish({ session: { id: "live-session" }, transport: { sdp: "late" } });
  await assert.rejects(connecting, { name: "AbortError" });
  assert.equal(track.stopped, true);
  assert.equal(peer.remoteDescription, undefined);
  assert.equal(client.connected, false);
});

test("original transcript events survive a lost save response and retry unchanged", async (t) => {
  let attempts = 0;
  const payloads = [];
  const storage = memoryStorage();
  const finalCallbacks = [];
  const { client, channel } = fixture({ storage, onInputTranscriptDone: (value) => finalCallbacks.push(value), api: {
    persistLiveEvents: async (_session, _live, events) => {
      payloads.push(structuredClone(events));
      if (++attempts === 1) throw new Error("Lost response after save");
      return { ok: true, pending_fragment_ids: events.map((event) => event.event_id) };
    },
  } });
  t.after(() => client.disconnect());
  await client.connect();
  const input = fragment("original-1", "  Wait, wait ", 500);
  const partner = fragment("original-2", "yes", 510, "partner");
  channel.receive(input);
  channel.receive(partner);
  channel.receive(input);
  await assert.rejects(client.flushEvents(), /Lost response/);
  assert.equal(JSON.parse(storage.getItem(client.storageKey)).length, 2);
  await client.flushEvents();
  assert.deepEqual(payloads, [[input, partner], [input, partner]]);
  assert.equal(storage.getItem(client.storageKey), null);
  assert.deepEqual(finalCallbacks, []);
});

test("cached originals from an earlier connection are saved before replacement history is created", async (t) => {
  const storage = memoryStorage();
  const original = fragment("old-event", "An interrupted thought");
  storage.setItem("thoughtform:live-outbox:canonical-1", JSON.stringify([{ liveSessionId: "old-live", event: original }]));
  const { client, requests } = fixture({ storage });
  t.after(() => client.disconnect());
  await client.connect();
  assert.deepEqual(requests.slice(0, 2), [["persist", "old-live", [original]], ["negotiate", "with-candidates"]]);
});

test("partial save acknowledgments retain and replay the remaining originals", async (t) => {
  const batches = [];
  const { client, channel } = fixture({ api: {
    persistLiveEvents: async (_session, _live, events) => {
      batches.push(events.map(({ event_id: eventId }) => eventId));
      return { acknowledged_event_ids: [events[0].event_id] };
    },
  } });
  t.after(() => client.disconnect());
  await client.connect();
  channel.receive(fragment("first", "One "));
  channel.receive(fragment("second", "two", 100));
  await client.flushEvents();
  assert.deepEqual(batches, [["first", "second"], ["second"]]);
  assert.equal(client._outbox.length, 0);
});

test("caption rows preserve overlap, fragment identity and exact whitespace", () => {
  const events = [fragment("u1", "I think ", 100), fragment("p1", "yes ", 120, "partner"), fragment("u2", " maybe", 180), fragment("u3", "another thought", 6000)];
  const rows = groupLiveTranscriptFragments(events);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].id, "u1");
  assert.equal(rows[0].text, "I think  maybe");
  assert.equal(rows[1].speaker, "partner");
  assert.deepEqual(rows[0].fragments, [events[0], events[2]]);
});

test("user and Partner captions update independently and no text timeout commits a thought", async (t) => {
  const captions = { you: [], partner: [] };
  const { client, channel, requests } = fixture({
    onUserTranscriptPartial: ({ text }) => captions.you.push(text),
    onPartnerTranscriptPartial: ({ text }) => captions.partner.push(text),
  });
  t.after(() => client.disconnect());
  await client.connect();
  channel.receive(fragment("u1", "Because ", 100));
  channel.receive(fragment("p1", "mm", 200, "partner"));
  channel.receive(fragment("u2", "I need to think", 300));
  await client.flushEvents();
  assert.equal(captions.you.at(-1), "Because I need to think");
  assert.equal(captions.partner.at(-1), "mm");
  assert.equal(requests.filter(([kind]) => kind === "flush").length, 0);
});

test("saved incomplete caption remains until its namespaced fragment is committed", async (t) => {
  const captions = [];
  const { client, channel } = fixture({ onUserTranscriptPartial: ({ text }) => captions.push(text) });
  t.after(() => client.disconnect());
  await client.connect();
  channel.receive(fragment("unfinished", "The reason I think that is"));
  await client.flushEvents();
  assert.equal(captions.at(-1), "The reason I think that is");
  client._applyResult({ pending_fragment_ids: [] });
  assert.equal(captions.at(-1), "");
});

test("delegation waits for original transcript persistence and preserves the known delegation ID", async (t) => {
  const order = [];
  let release;
  const { client, channel } = fixture({ api: {
    persistLiveEvents: async () => { order.push("persist"); await new Promise((resolve) => { release = resolve; }); return { ok: true }; },
    delegateLiveTask: async (_session, _live, event) => {
      order.push("delegate");
      assert.deepEqual(event.delegation, { id: "opaque-delegation", type: "delegation", target: "client" });
      return { events: [{ type: "session.thinking.append", delegation_id: event.delegation.id, content: "The requested change succeeded." }] };
    },
  } });
  t.after(() => client.disconnect());
  await client.connect();
  channel.receive(fragment("user-context", "Connect these two thoughts."));
  channel.receive({ type: "session.delegation.created", event_id: "delegate-event", offset_ms: 100, delegation: { id: "opaque-delegation", type: "delegation", target: "client" } });
  await tick();
  assert.deepEqual(order, ["persist"]);
  release();
  await tick();
  assert.deepEqual(order, ["persist", "delegate"]);
  assert.equal(channel.sent[0].delegation_id, "opaque-delegation");
  assert.equal(client._delegations.get("opaque-delegation").state, "done");
});

test("delegation without enough context stays pending until new transcript is saved", async (t) => {
  let calls = 0;
  const { client, channel } = fixture({ batchMs: 2, api: {
    delegateLiveTask: async () => { calls += 1; return calls === 1 ? { pending: true, events: [] } : { events: [] }; },
  } });
  t.after(() => client.disconnect());
  await client.connect();
  channel.receive({ type: "session.delegation.created", event_id: "d1", delegation: { id: "delegation-1", target: "client" }, offset_ms: 0 });
  await tick();
  assert.equal(calls, 1);
  assert.equal(client._delegations.get("delegation-1").state, "pending");
  channel.receive(fragment("later-context", "Explore that idea."));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls, 2);
  assert.equal(client._delegations.get("delegation-1").state, "done");
});

test("late delegation results cannot speak on a different connection", async (t) => {
  let finish;
  const { client, channel } = fixture({ api: {
    delegateLiveTask: () => new Promise((resolve) => { finish = resolve; }),
  } });
  t.after(() => client.disconnect());
  await client.connect();
  channel.receive({ type: "session.delegation.created", event_id: "d1", delegation: { id: "delegation-1", target: "client" }, offset_ms: 0 });
  await tick();
  client.disconnect();
  finish({ events: [{ type: "session.commentary.append", delegation_id: "delegation-1", content: "Old result" }] });
  await tick();
  assert.equal(channel.sent.filter((event) => event.type === "session.commentary.append").length, 0);
});

test("mute closes local capture immediately but UI confirmation waits for server acknowledgment", async (t) => {
  const updates = [];
  const { client, channel, track } = fixture({ autoAck: false, onMutedChange: (update) => updates.push(update) });
  t.after(() => client.disconnect());
  await client.connect();
  const muting = client.setMuted(true);
  assert.equal(track.enabled, false);
  assert.equal(client.muted, false);
  assert.equal(updates.at(-1).pending, true);
  const command = channel.sent.at(-1);
  channel.receive({ type: "session.input_audio.muted", client_event_id: command.event_id });
  await muting;
  assert.equal(client.muted, true);
  const unmuting = client.setMuted(false);
  assert.equal(track.enabled, false);
  channel.receive({ type: "session.input_audio.unmuted", client_event_id: channel.sent.at(-1).event_id });
  await unmuting;
  assert.equal(track.enabled, true);
  assert.equal(client.muted, false);
});

test("end waits for session.closed and cumulative usage replaces earlier totals", async (t) => {
  const usages = [];
  const { client, channel, track } = fixture({ autoAck: false, onUsage: (usage) => usages.push(usage) });
  t.after(() => client.disconnect());
  await client.connect();
  channel.receive({ type: "session.usage.updated", event_id: "usage1", usage: { total: 5 } });
  channel.receive({ type: "session.usage.updated", event_id: "usage2", usage: { total: 8 } });
  const ending = client.end();
  assert.equal(client.connectionState, "ending");
  assert.equal(track.enabled, false);
  channel.receive({ type: "session.closed", event_id: "closed", reason: "client_requested", usage: { total: 10 } });
  const result = await ending;
  assert.equal(result.finalized, true);
  assert.deepEqual(result.usage, { total: 10 });
  assert.deepEqual(usages, [{ total: 5 }, { total: 8 }, { total: 10 }]);
  assert.equal(client.connectionState, "closed");
});

test("close timeout reports unconfirmed finalization but saves original fragments", async (t) => {
  const errors = [];
  const { client, channel, requests } = fixture({ autoAck: false, timeouts: { setup: 100, command: 100, close: 5, reconnect: 20 }, onError: (error, context) => errors.push(context.phase) });
  t.after(() => client.disconnect());
  await client.connect();
  channel.receive(fragment("last-fragment", "still thinking"));
  const result = await client.end();
  assert.equal(result.finalized, false);
  assert.ok(errors.includes("close"));
  assert.ok(requests.some(([kind]) => kind === "persist"));
  assert.ok(requests.some(([kind, , args]) => kind === "flush" && args.ended));
});

test("brief connection loss keeps media alive and recovers without opening a second session", async (t) => {
  const { client, peer, track, requests } = fixture();
  t.after(() => client.disconnect());
  await client.connect();
  peer.connectionState = "disconnected";
  peer.onconnectionstatechange();
  assert.equal(client.connectionState, "reconnecting");
  assert.equal(track.stopped, false);
  peer.connectionState = "connected";
  peer.onconnectionstatechange();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(client.connectionState, "connected");
  assert.equal(requests.filter(([kind]) => kind === "negotiate").length, 1);
});

test("typed text uses canonical /chat with a stable request ID when voice is inactive", async () => {
  const { client, requests } = fixture();
  const result = await client.sendText("  Exactly typed  ", { requestId: "typed-request" });
  assert.equal(result.snapshot.revision, 3);
  assert.deepEqual(requests, [["chat", "  Exactly typed  ", { requestId: "typed-request" }]]);
  assert.equal(client.connectionState, "idle");
});

test("selected proposal is quiet reference context and stays unaccepted", async (t) => {
  const { client, channel } = fixture();
  t.after(() => client.disconnect());
  await client.connect();
  client.updateContext({ selectedNodeIds: [], selectedProposalId: "suggestion", selectedText: "考え".repeat(1000) });
  await new Promise((resolve) => setTimeout(resolve, 210));
  const context = channel.sent.find((event) => event.type === "session.thinking.append");
  assert.equal(context.delegation_id, null);
  assert.match(context.content, /unaccepted proposal/);
  assert.match(context.content, /does not accept/);
  assert.ok(new TextEncoder().encode(context.content).length <= 480);
  assert.equal(channel.sent.some((event) => event.type === "session.instructions.append"), false);
});

test("actual microphone silence triggers only a completeness check and never a transcript commit", async (t) => {
  const { client, requests } = fixture();
  t.after(() => client.disconnect());
  await client.connect();
  client.reportActivity(true);
  client.reportActivity(false);
  await tick();
  const flush = requests.findLast(([kind]) => kind === "flush");
  assert.equal(flush[2].activity.active, false);
  assert.equal(flush[2].ended, undefined);
});
