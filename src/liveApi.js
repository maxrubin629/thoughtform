import { SessionApiError } from "./sessionApi.js";

function path(sessionId, suffix) {
  if (!sessionId) throw new TypeError("A session ID is required");
  return `/api/sessions/${encodeURIComponent(sessionId)}${suffix}`;
}

async function post(sessionId, suffix, body, { signal, keepalive = false } = {}) {
  let response;
  try {
    response = await fetch(path(sessionId, suffix), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
      keepalive,
    });
  } catch (cause) {
    if (cause?.name === "AbortError") throw cause;
    throw new SessionApiError("The session server is unavailable", { code: "network_error", cause });
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new SessionApiError(data?.error?.message ?? data?.error ?? "Live request failed", {
      status: response.status,
      code: data?.error?.code ?? data?.code ?? "live_request_failed",
      details: data,
    });
  }
  return data;
}

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

export function retryLiveCapture(sessionId) {
  return post(sessionId, "/live/retry-capture", {});
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
