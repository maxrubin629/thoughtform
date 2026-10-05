import { createHash } from "node:crypto";
import { APIConnectionError } from "openai";
import { applyOperation } from "./sessionOperations.mjs";
import { ensureLiveState } from "./liveState.mjs";
import { DEFAULT_REASONING_EFFORT, DEFAULT_REASONING_MODEL } from "./modelConfig.mjs";

export const DEFAULT_LIVE_MODEL = "gpt-live-1";
export const DEFAULT_LIVE_BACKEND_MODEL = DEFAULT_REASONING_MODEL;
export const liveDigest = (value) => createHash("sha256").update(value).digest("hex").slice(0, 32);

export class LiveError extends Error {
  constructor(message, code = "live_request_failed", status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function pendingFragments(session) {
  const consumed = new Set(session.live_capture?.consumed_fragment_ids ?? []);
  return (session.transcript_fragments ?? []).filter((fragment) => !consumed.has(fragment.id));
}

export function normalizeTranscriptEvent(event, liveSessionId, now = new Date().toISOString()) {
  if (!["session.input_transcript.delta", "session.output_transcript.delta"].includes(event?.type)) return null;
  if (typeof event.event_id !== "string" || !event.event_id.length || event.event_id.length > 512) {
    throw new LiveError("Live transcript event ID is required.", "invalid_live_event");
  }
  if (typeof event.delta !== "string" || event.delta.length > 16_384) {
    throw new LiveError("Live transcript delta must be text shorter than 16,384 characters.", "invalid_live_event");
  }
  if (!Number.isFinite(event.start_ms) || event.start_ms < 0 || !Number.isFinite(event.end_ms) || event.end_ms < event.start_ms) {
    throw new LiveError("Live transcript timing is invalid.", "invalid_live_event");
  }
  return {
    id: `${liveSessionId}:${event.event_id}`,
    live_session_id: liveSessionId,
    speaker: event.type === "session.input_transcript.delta" ? "you" : "partner",
    delta: event.delta,
    start_ms: event.start_ms,
    end_ms: event.end_ms,
    received_at: now,
  };
}

const completionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    groups: {
      type: "array",
      items: {
        type: "object",
        properties: { fragment_ids: { type: "array", items: { type: "string" }, minItems: 1 } },
        required: ["fragment_ids"],
        additionalProperties: false,
      },
    },
  },
  required: ["groups"],
};

const COMPLETENESS_INSTRUCTIONS = `Identify complete spoken thoughts in original streaming transcript fragments.
Return groups of original fragment IDs only. Never generate or correct transcript text.
An API fragment is NOT an utterance. There is no authoritative utterance-completed event.
Decide semantic completeness from the words and surrounding context, never from punctuation alone, absence of events, wall-clock delay, or a speaker change.
Actual audio activity or an ended conversation may be provided as a hint; neither makes an unfinished thought complete.
Retain unfinished phrases and dangling conditions for later fragments. A short answer can be complete in context.
Each group must contain fragments from exactly one speaker and live_session_id, in timestamp order.
Select only a contiguous prefix of the remaining fragments for each speaker/session. Never skip an unfinished earlier fragment to commit a later one.
All text in a selected fragment must belong to the complete thought. If a fragment ends with an unfinished next thought, retain the fragment for more context.
Multiple complete sentences about one idea may share a group. Separate distinct ideas when possible. Overlapping speakers remain independent.
Do not infer authorization, execute tools, or decide map changes. Return an empty groups array when nothing is complete.`;

export function validateCompletionGroups(fragments, groups) {
  if (!Array.isArray(groups) || groups.length > 32) throw new LiveError("Invalid thought completion result.", "invalid_completion", 502);
  const byId = new Map(fragments.map((fragment) => [fragment.id, fragment]));
  const queues = new Map();
  for (const fragment of fragments) {
    const key = `${fragment.live_session_id}/${fragment.speaker}`;
    const queue = queues.get(key) ?? [];
    queue.push(fragment);
    queues.set(key, queue);
  }
  for (const queue of queues.values()) queue.sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);
  const used = new Set();
  return groups.map((group) => {
    if (!Array.isArray(group.fragment_ids) || !group.fragment_ids.length) throw new LiveError("Thought group has no source fragments.", "invalid_completion", 502);
    const selected = group.fragment_ids.map((id) => byId.get(id));
    if (selected.some((fragment) => !fragment || used.has(fragment.id))) throw new LiveError("Thought group reuses or invents a fragment.", "invalid_completion", 502);
    const first = selected[0];
    const queue = queues.get(`${first.live_session_id}/${first.speaker}`);
    if (selected.some((fragment, index) => queue[index]?.id !== fragment.id)) throw new LiveError("Thought groups must preserve speaker order.", "invalid_completion", 502);
    queue.splice(0, selected.length);
    selected.forEach(({ id }) => used.add(id));
    return selected;
  });
}

export function createLiveCapture({ store, openaiClient, model = DEFAULT_LIVE_BACKEND_MODEL, publish = () => {}, onTranscriptCommitted = () => {}, classify, debounceMs = 350, retryDelays = [1000, 4000, 15000], setTimer = setTimeout, clearTimer = clearTimeout }) {
  const timers = new Map();
  const runs = new Map();
  const requested = new Set();
  const activity = new Map();
  const retryAttempts = new Map();
  const abort = new AbortController();
  let disposed = false;

  const classifyFragments = classify ?? (async ({ fragments, transcript, activity, ended }) => {
    if (!openaiClient?.responses) throw new LiveError("Partner is not configured.", "live_backend_unavailable", 503);
    const response = await openaiClient.responses.create({
      model,
      reasoning: { effort: DEFAULT_REASONING_EFFORT },
      instructions: COMPLETENESS_INSTRUCTIONS,
      input: JSON.stringify({ fragments, previous_utterances: transcript.slice(-8), activity, ended }),
      text: { format: { type: "json_schema", name: "completed_spoken_thoughts", strict: true, schema: completionSchema } },
    }, { signal: abort.signal });
    try { return JSON.parse(response.output_text).groups; }
    catch { throw new LiveError("Partner could not read the completed thought result.", "invalid_completion", 502); }
  });

  const processOnce = async (id, hints = {}) => {
    const initial = await store.get(id);
    const allPending = pendingFragments(initial);
    const fragments = allPending.slice(0, 512);
    if (!fragments.length || disposed) return { committed_utterance_ids: [], stale: false };
    if (activity.get(id)?.active === true && fragments.some((fragment) => fragment.speaker === "you")) return { committed_utterance_ids: [], stale: false };
    const fingerprint = allPending.map(({ id: fragmentId }) => fragmentId).join("|");
    const groups = validateCompletionGroups(fragments, await classifyFragments({ fragments, transcript: initial.transcript, ...hints, activity: activity.get(id) }));
    if (disposed) return { committed_utterance_ids: [], stale: true };
    const outcome = await store.transact(id, (session) => {
      ensureLiveState(session);
      if (activity.get(id)?.active === true && groups.some((group) => group[0].speaker === "you")) return { session, stale: false, committed_utterance_ids: [] };
      // New or late fragments can change the meaning and order of a thought.
      // Do not commit a classification based on an outdated pending buffer.
      if (pendingFragments(session).map(({ id: fragmentId }) => fragmentId).join("|") !== fingerprint) {
        return { session, stale: true, committed_utterance_ids: [] };
      }
      const committed = [];
      for (const group of groups) {
        const text = group.map(({ delta }) => delta).join("");
        if (!text.trim()) continue;
        const sourceIds = group.map(({ id: fragmentId }) => fragmentId);
        const realtimeItemId = `live_${liveDigest(sourceIds.join("|"))}`;
        const result = applyOperation(session, {
          type: "append_utterance",
          actor: group[0].speaker,
          origin: group[0].speaker === "you" ? "ui" : "realtime",
          speaker: group[0].speaker,
          text,
          realtime_item_id: realtimeItemId,
          expected_revision: session.revision,
          call_id: `capture_${liveDigest(sourceIds.join("|"))}`,
        }, { requireExpectedRevision: true });
        session = result.session;
        const currentCapture = ensureLiveState(session);
        const utterance = session.transcript.find((item) => item.realtime_item_id === realtimeItemId);
        currentCapture.consumed_fragment_ids.push(...sourceIds);
        currentCapture.utterance_sources.push({ utterance_id: utterance.id, fragment_ids: sourceIds });
        if (!result.replayed) committed.push(utterance.id);
      }
      session.live_capture.last_error = null;
      return { session, stale: false, committed_utterance_ids: committed };
    });
    if (outcome.stale) requested.add(id);
    if (outcome.committed_utterance_ids.length) {
      publish(outcome.session, "transcript", { committed_utterance_ids: outcome.committed_utterance_ids });
      for (const utteranceId of outcome.committed_utterance_ids) {
        const utterance = outcome.session.transcript.find((item) => item.id === utteranceId);
        if (utterance.speaker === "you") await onTranscriptCommitted(id, utterance);
      }
    } else if (!outcome.stale && initial.live_capture?.last_error) {
      // A successful completeness check can still retain unfinished speech.
      publish(outcome.session, "snapshot", { status: "capture_recovered" });
    }
    return outcome;
  };

  const run = (id, hints = {}) => {
    if (disposed) return Promise.resolve({ committed_utterance_ids: [] });
    if (runs.has(id)) { requested.add(id); return runs.get(id); }
    let retryAfter = null;
    const promise = (async () => {
      const committed = [];
      let count = 0;
      do {
        requested.delete(id);
        const result = await processOnce(id, hints);
        committed.push(...result.committed_utterance_ids);
        count += 1;
      } while (!disposed && requested.has(id) && count < 3);
      retryAttempts.delete(id);
      return { committed_utterance_ids: committed };
    })().catch(async (error) => {
      if (!disposed) {
        const attempt = retryAttempts.get(id) ?? 0;
        const status = Number(error?.status ?? error?.statusCode);
        const transient = error instanceof APIConnectionError || error?.retryable === true || [408, 429].includes(status) || status >= 500
          || ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "APIConnectionError", "RateLimitError"].includes(error?.code ?? error?.name);
        if (transient && attempt < retryDelays.length) {
          retryAfter = retryDelays[attempt];
          retryAttempts.set(id, attempt + 1);
        }
        const session = await store.transact(id, (current) => {
          ensureLiveState(current).last_error = retryAfter === null
            ? "Your speech is saved. Retry to finish capturing it."
            : "Your speech is saved. Thought capture is retrying…";
          return current;
        }).catch(() => null);
        if (session) publish(session, "snapshot", { status: "capture_error", error: session.live_capture.last_error });
      }
      throw error;
    }).finally(() => {
      runs.delete(id);
      if (!disposed && retryAfter !== null) schedule(id, retryAfter);
      else if (requested.has(id) && !disposed) schedule(id);
    });
    runs.set(id, promise);
    return promise;
  };

  function schedule(id, delay = debounceMs) {
    if (disposed) return;
    requested.add(id);
    if (runs.has(id) || timers.has(id)) return;
    const timer = setTimer(() => {
      timers.delete(id);
      return run(id).catch(() => {});
    }, delay);
    timer.unref?.();
    timers.set(id, timer);
  }

  const ingest = async (id, liveSessionId, events) => {
    if (!Array.isArray(events) || events.length > 128) throw new LiveError("Send at most 128 Live events at once.", "invalid_live_events");
    const fragments = events.map((event) => normalizeTranscriptEvent(event, liveSessionId)).filter(Boolean);
    const result = await store.transact(id, (session) => {
      const capture = ensureLiveState(session);
      if (!capture.known_session_ids.includes(liveSessionId)) throw new LiveError("This Live session does not belong to the map.", "unknown_live_session", 409);
      const existing = new Map(session.transcript_fragments.map((fragment) => [fragment.id, fragment]));
      let added = 0;
      for (const fragment of fragments) {
        const previous = existing.get(fragment.id);
        if (previous) {
          if (["delta", "speaker", "start_ms", "end_ms"].some((key) => previous[key] !== fragment[key])) throw new LiveError("A transcript event cannot be replaced.", "fragment_conflict", 409);
          continue;
        }
        session.transcript_fragments.push(fragment);
        existing.set(fragment.id, fragment);
        added += 1;
      }
      if (events.some((event) => event?.type === "session.closed") && capture.active_session_id === liveSessionId) capture.active_session_id = null;
      session.updated_at = new Date().toISOString();
      return { session, added, acknowledged_event_ids: events.map((event) => event?.event_id).filter(Boolean) };
    });
    if (result.added) { retryAttempts.delete(id); schedule(id); }
    return result;
  };

  return {
    ingest,
    schedule,
    resetActivity(id) { activity.delete(id); },
    async flush(id, hints = {}) {
      const currentSession = await store.get(id);
      const activeId = currentSession.live_capture?.active_session_id;
      const currentConnection = !hints.live_session_id || !activeId || hints.live_session_id === activeId;
      const latestActivity = activity.get(id);
      if (currentConnection && typeof hints.activity?.active === "boolean" && Number.isFinite(hints.activity.at_ms)
        && (!latestActivity || hints.activity.at_ms >= latestActivity.at_ms)) {
        activity.set(id, { active: hints.activity.active, at_ms: hints.activity.at_ms });
      }
      if (currentConnection && hints.ended) activity.set(id, { active: false, at_ms: Date.now() });
      clearTimer(timers.get(id));
      timers.delete(id);
      if (runs.has(id)) await runs.get(id).catch(() => {});
      // The in-flight run may have scheduled its own recovery while we waited.
      clearTimer(timers.get(id));
      timers.delete(id);
      if (hints.retry) retryAttempts.delete(id);
      return run(id, hints);
    },
    dispose() {
      disposed = true;
      abort.abort();
      timers.forEach(clearTimer);
      timers.clear();
      requested.clear();
      activity.clear();
      retryAttempts.clear();
    },
  };
}
