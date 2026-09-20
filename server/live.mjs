import { createHash } from "node:crypto";
import { ensureLiveState } from "./liveState.mjs";
import { createLiveCapture, DEFAULT_LIVE_MODEL, DEFAULT_LIVE_BACKEND_MODEL, LiveError, liveDigest, pendingFragments } from "./liveCapture.mjs";
import { buildLiveSessionConfig, forwardLiveSdp } from "./liveConnection.mjs";
import { createPartnerBackend } from "./partnerBackend.mjs";

function compactAppend(text) {
  let result = text;
  while (Buffer.byteLength(result, "utf8") > 480) result = result.slice(0, -1);
  if (result.length < text.length) {
    const lastSentence = Math.max(result.lastIndexOf(". "), result.lastIndexOf("? "), result.lastIndexOf("! "));
    if (lastSentence > 100) result = result.slice(0, lastSentence + 1);
  }
  return result;
}

function latestUserText(session, liveSessionId) {
  const fragments = (session.transcript_fragments ?? []).filter((fragment) => fragment.live_session_id === liveSessionId && fragment.speaker === "you");
  const completed = session.live_capture?.delegations.findLast((item) => item.live_session_id === liveSessionId && item.status === "completed");
  const handled = new Set(completed?.source_fragment_ids ?? []);
  return fragments.filter((fragment) => !handled.has(fragment.id)).slice(-24).map(({ delta }) => delta).join("");
}

export function registerLiveRoutes(app, {
  store, openaiClient, env = process.env, fetchImpl = globalThis.fetch,
  jsonRoute, publish = () => {}, snapshotFor = (session) => session,
  performOperation, getUiContext = () => ({}), onTranscriptCommitted = () => {}, updatePreferences,
  captureOptions = {},
}) {
  const model = env.OPENAI_LIVE_BACKEND_MODEL || DEFAULT_LIVE_BACKEND_MODEL;
  const capture = createLiveCapture({ store, openaiClient, model, publish, onTranscriptCommitted, ...captureOptions });
  const jobs = new Map();
  const chatJobs = new Map();
  const backend = createPartnerBackend({ store, openaiClient, model, performOperation, getUiContext, updatePreferences });
  const runBackend = backend.run;

  app.post("/api/sessions/:id/live", jsonRoute(async (req, res) => {
    const session = await store.get(req.params.id);
    const controller = new AbortController();
    req.once?.("aborted", () => controller.abort());
    res.once?.("close", () => { if (!res.writableEnded) controller.abort(); });
    const answer = await forwardLiveSdp({
      sdp: req.body?.sdp,
      sessionConfig: buildLiveSessionConfig(session, { model: env.OPENAI_LIVE_MODEL || DEFAULT_LIVE_MODEL }),
      apiKey: env.OPENAI_API_KEY, fetchImpl, signal: controller.signal,
      safetyIdentifier: createHash("sha256").update(`thoughtform:${session.id}`).digest("hex"),
    });
    const updated = await store.transact(session.id, (current) => {
      const state = ensureLiveState(current);
      state.active_session_id = answer.session.id;
      if (!state.known_session_ids.includes(answer.session.id)) state.known_session_ids.push(answer.session.id);
      return current;
    });
    await store.setActive(session.id);
    capture.resetActivity(session.id);
    res.status(201);
    return { ...answer, snapshot: snapshotFor(updated) };
  }));

  app.post("/api/sessions/:id/live/events", jsonRoute(async (req) => {
    const result = await capture.ingest(req.params.id, req.body?.live_session_id, req.body?.events);
    return { ok: true, snapshot: snapshotFor(result.session), acknowledged_event_ids: result.acknowledged_event_ids, pending_fragment_ids: pendingFragments(result.session).map(({ id }) => id), committed_utterance_ids: [] };
  }));

  app.post("/api/sessions/:id/live/flush", jsonRoute(async (req) => {
    const session = await store.get(req.params.id);
    if (!session.live_capture?.known_session_ids.includes(req.body?.live_session_id)) throw new LiveError("This voice session is not recognized.", "unknown_live_session", 409);
    const result = await capture.flush(session.id, { ended: req.body?.ended === true, activity: req.body?.activity, live_session_id: req.body?.live_session_id });
    const current = await store.get(session.id);
    return { ok: true, ...result, snapshot: snapshotFor(current), pending_fragment_ids: pendingFragments(current).map(({ id }) => id) };
  }));

  app.post("/api/sessions/:id/live/delegations", jsonRoute(async (req) => {
    const id = req.params.id;
    const liveId = req.body?.live_session_id;
    const delegation = req.body?.delegation;
    if (typeof delegation?.id !== "string" || !delegation.id || delegation.id.length > 512 || delegation.target !== "client") throw new LiveError("A client delegation ID is required.", "invalid_delegation");
    const key = `${id}/${liveId}/${delegation.id}`;
    const current = await store.get(id);
    if (current.live_capture?.active_session_id !== liveId) return { ok: true, stale: true, events: [], snapshot: snapshotFor(current) };
    const previous = current.live_capture?.delegations.find((item) => item.id === delegation.id && item.live_session_id === liveId);
    if (previous?.status === "completed") return { ok: true, replayed: true, events: previous.result, snapshot: snapshotFor(current) };
    if (jobs.has(key)) return jobs.get(key);
    // Persisted running entries cannot be replayed after a process crash: an
    // action may already have committed. The user can issue a fresh request.
    if (previous && (previous.status !== "failed" || previous.mutation_started)) return { ok: true, stale: true, events: [], snapshot: snapshotFor(current) };
    const text = latestUserText(current, liveId);
    if (!text.trim()) return { ok: true, pending: true, events: [], snapshot: snapshotFor(current) };
    const sourceIds = (current.transcript_fragments ?? []).filter((item) => item.live_session_id === liveId && item.speaker === "you").map(({ id: fragmentId }) => fragmentId);
    const job = (async () => {
      await capture.flush(id);
      await store.transact(id, (session) => {
        const state = ensureLiveState(session);
        state.delegations = state.delegations.filter((item) => item.id !== delegation.id || item.live_session_id !== liveId);
        state.delegations.push({ id: delegation.id, live_session_id: liveId, status: "running", source_fragment_ids: sourceIds, created_at: new Date().toISOString(), result: null, mutation_started: false });
        return session;
      });
      const result = await runBackend({ id, liveId, requestId: key, sourceIds, latestText: text, beforeMutation: () => store.transact(id, (session) => {
        session.live_capture.delegations.find((item) => item.id === delegation.id && item.live_session_id === liveId).mutation_started = true;
        return session;
      }) });
      const events = [];
      if (!result.stale && !result.pending) {
        if (result.operations.length) events.push({ type: "session.thinking.append", event_id: `map_${liveDigest(key)}`, delegation_id: delegation.id, content: "The backend applied verified map changes. The visible changes are the confirmation. Continue the conversation without narrating the map operations." });
        if (result.reply) events.push({ type: "session.commentary.append", event_id: `reply_${liveDigest(key)}`, delegation_id: delegation.id, content: compactAppend(result.reply) });
      }
      const updated = await store.transact(id, (session) => {
        const state = ensureLiveState(session);
        const record = state.delegations.find((item) => item.id === delegation.id && item.live_session_id === liveId);
        if (result.pending && !result.operations.length) state.delegations = state.delegations.filter((item) => item !== record);
        else if (record) { record.status = result.stale ? "stale" : "completed"; record.result = events; }
        return session;
      });
      return { ok: true, pending: Boolean(result.pending), stale: Boolean(result.stale), events, snapshot: snapshotFor(updated) };
    })().catch(async (error) => {
      await store.transact(id, (session) => {
        const record = session.live_capture?.delegations.find((item) => item.id === delegation.id && item.live_session_id === liveId);
        if (record) record.status = "failed";
        return session;
      }).catch(() => {});
      throw error;
    }).finally(() => jobs.delete(key));
    jobs.set(key, job);
    return job;
  }));

  app.post("/api/sessions/:id/chat", jsonRoute(async (req) => {
    const id = req.params.id;
    const { text, request_id: requestId } = req.body ?? {};
    if (typeof text !== "string" || !text.trim() || text.length > 16_384 || typeof requestId !== "string" || !requestId || requestId.length > 256) throw new LiveError("A message and stable request ID are required.", "invalid_chat_message");
    const key = `${id}/${requestId}`;
    const chatRecordId = `chat_${liveDigest(requestId)}`;
    if (chatJobs.has(key)) return chatJobs.get(key);
    const job = (async () => {
      const initial = await store.get(id);
      const userId = `typed_${liveDigest(requestId)}`;
      const existingUser = initial.transcript.find((utterance) => utterance.realtime_item_id === userId);
      if (existingUser && existingUser.text !== text) throw new LiveError("That message ID has already been used.", "message_conflict", 409);
      const previous = initial.live_capture?.delegations.find((item) => item.id === chatRecordId && item.live_session_id === "typed");
      if (previous?.status === "completed") return { ok: true, replayed: true, reply: previous.result?.[0]?.content ?? "", events: [], snapshot: snapshotFor(initial) };
      if (previous && (previous.status !== "failed" || previous.mutation_started)) throw new LiveError("That request may already have changed the map. Review it before sending a new request.", "chat_already_attempted", 409);
      const assistantId = `typed_reply_${liveDigest(requestId)}`;
      const existingReply = initial.transcript.find((utterance) => utterance.realtime_item_id === assistantId);
      if (existingReply) return { ok: true, replayed: true, reply: existingReply.text, events: [], snapshot: snapshotFor(initial) };
      const appended = await performOperation(id, { type: "append_utterance", speaker: "you", actor: "you", origin: "ui", text, realtime_item_id: userId, expected_revision: initial.revision, call_id: userId });
      if (!appended.replayed) await onTranscriptCommitted(id, appended.snapshot.transcript.find((utterance) => utterance.realtime_item_id === userId));
      await store.transact(id, (session) => {
        const state = ensureLiveState(session);
        state.delegations = state.delegations.filter((item) => item.id !== chatRecordId || item.live_session_id !== "typed");
        state.delegations.push({ id: chatRecordId, live_session_id: "typed", status: "running", source_fragment_ids: [], created_at: new Date().toISOString(), result: null, mutation_started: false });
        return session;
      });
      const result = await runBackend({ id, requestId: key, sourceIds: [], latestText: text, beforeMutation: () => store.transact(id, (session) => {
        session.live_capture.delegations.find((item) => item.id === chatRecordId && item.live_session_id === "typed").mutation_started = true;
        return session;
      }) });
      if (result.reply && !result.stale) {
        const current = await store.get(id);
        await performOperation(id, { type: "append_utterance", speaker: "partner", actor: "partner", origin: "ui", text: result.reply, realtime_item_id: assistantId, expected_revision: current.revision, call_id: assistantId });
      }
      await store.transact(id, (session) => {
        const record = session.live_capture.delegations.find((item) => item.id === chatRecordId && item.live_session_id === "typed");
        record.status = result.stale ? "stale" : "completed";
        record.result = [{ type: "reply", content: result.reply ?? "" }];
        return session;
      });
      return { ok: true, reply: result.reply, events: [], snapshot: snapshotFor(await store.get(id)) };
    })().catch(async (error) => {
      await store.transact(id, (session) => {
        const record = session.live_capture?.delegations.find((item) => item.id === chatRecordId && item.live_session_id === "typed");
        if (record?.status === "running") record.status = "failed";
        return session;
      }).catch(() => {});
      throw error;
    }).finally(() => chatJobs.delete(key));
    chatJobs.set(key, job);
    return job;
  }));

  return { flushCapture: capture.flush, dispose() { backend.dispose(); capture.dispose(); } };
}
