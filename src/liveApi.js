import { requestSession, SessionApiError } from "./apiRequest.js";

const post = (sessionId, suffix, body, options) => requestSession(sessionId, suffix, {
  ...options, method: "POST", body,
});

export async function negotiateLiveSession(sessionId, sdp, options = {}) {
  if (typeof sdp !== "string" || !sdp.trim()) throw new TypeError("An SDP offer is required");
  const result = await post(sessionId, "/live", { sdp }, options);
  if (!result?.session?.id || typeof result?.transport?.sdp !== "string" || !result.transport.sdp) {
    throw new SessionApiError("The voice server returned an invalid connection", { code: "invalid_live_answer" });
  }
  return result;
}

export function persistLiveEvents(sessionId, liveSessionId, events, options) {
  return post(sessionId, "/live/events", { live_session_id: liveSessionId, events }, options);
}

export function flushLiveTranscript(sessionId, liveSessionId, { ended = false, activity, ...options } = {}) {
  return post(sessionId, "/live/flush", {
    live_session_id: liveSessionId,
    ended,
    ...(activity ? { activity } : {}),
  }, options);
}

export function delegateLiveTask(sessionId, liveSessionId, event, options) {
  // A delegation contains identity and timing, never an invented task string.
  return post(sessionId, "/live/delegations", {
    live_session_id: liveSessionId,
    delegation: event.delegation,
    offset_ms: event.offset_ms,
  }, options);
}

export async function sendSessionChat(sessionId, text, { requestId = `chat_${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`}`, ...options } = {}) {
  if (typeof text !== "string" || !text.trim()) throw new TypeError("Text is required");
  // A lost response can be retried without adding the typed message twice.
  const body = { text, request_id: requestId };
  try { return await post(sessionId, "/chat", body, options); }
  catch (error) {
    if (error?.code !== "network_error") throw error;
    return post(sessionId, "/chat", body, options);
  }
}
