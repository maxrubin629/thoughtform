// Live transcripts are raw source material. Canonical utterances refer back to
// these immutable fragments; UI caption grouping never rewrites their contents.
export function defaultLiveCapture() {
  return {
    active_session_id: null,
    known_session_ids: [],
    consumed_fragment_ids: [],
    utterance_sources: [],
    delegations: [],
    last_error: null,
  };
}

export function ensureLiveState(session) {
  session.transcript_fragments ??= [];
  session.live_capture = { ...defaultLiveCapture(), ...session.live_capture };
  return session.live_capture;
}

const strings = (value) => Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
const validTime = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
const check = (value, message) => { if (!value) throw new TypeError(message); };

export function validateLiveStorage(session) {
  if (session.transcript_fragments === undefined && session.live_capture === undefined) return;
  check(Array.isArray(session.transcript_fragments), "transcript_fragments must be an array");
  const ids = new Set();
  for (const fragment of session.transcript_fragments) {
    check(fragment && typeof fragment === "object", "Invalid Live transcript fragment");
    check(typeof fragment.id === "string" && fragment.id.length > 0 && !ids.has(fragment.id), "Live fragment IDs must be unique");
    ids.add(fragment.id);
    check(typeof fragment.live_session_id === "string" && fragment.live_session_id.length > 0, "Live fragment session ID is required");
    check(["you", "partner"].includes(fragment.speaker), "Invalid Live fragment speaker");
    check(typeof fragment.delta === "string", "Live transcript delta must be text");
    check(Number.isFinite(fragment.start_ms) && fragment.start_ms >= 0 && Number.isFinite(fragment.end_ms) && fragment.end_ms >= fragment.start_ms, "Invalid Live fragment interval");
    check(validTime(fragment.received_at), "Invalid Live fragment receipt time");
  }
  const capture = session.live_capture;
  check(capture && typeof capture === "object" && !Array.isArray(capture), "live_capture must be an object");
  check(capture.active_session_id === null || typeof capture.active_session_id === "string", "Invalid active Live session ID");
  check(strings(capture.known_session_ids), "Invalid known Live session IDs");
  check(capture.active_session_id === null || capture.known_session_ids.includes(capture.active_session_id), "Active Live session must be known");
  check(strings(capture.consumed_fragment_ids) && new Set(capture.consumed_fragment_ids).size === capture.consumed_fragment_ids.length, "Invalid consumed Live fragment IDs");
  check(capture.consumed_fragment_ids.every((id) => ids.has(id)), "Consumed Live fragment must exist");
  check(Array.isArray(capture.utterance_sources), "Invalid Live utterance sources");
  for (const source of capture.utterance_sources) {
    check(session.transcript.some((utterance) => utterance.id === source.utterance_id), "Live source utterance must exist");
    check(strings(source.fragment_ids) && source.fragment_ids.length > 0 && source.fragment_ids.every((id) => ids.has(id)), "Live utterance source fragments must exist");
  }
  check(Array.isArray(capture.delegations), "Invalid Live delegations");
  for (const item of capture.delegations) {
    check(typeof item.id === "string" && typeof item.live_session_id === "string", "Invalid Live delegation ID");
    check(["running", "completed", "stale", "failed"].includes(item.status), "Invalid Live delegation status");
    check(strings(item.source_fragment_ids) && validTime(item.created_at), "Invalid Live delegation context");
    check(item.result === null || Array.isArray(item.result), "Invalid Live delegation result");
    check(item.mutation_started === undefined || typeof item.mutation_started === "boolean", "Invalid Live mutation checkpoint");
  }
  check(capture.last_error === null || typeof capture.last_error === "string", "Invalid Live capture error");
}
