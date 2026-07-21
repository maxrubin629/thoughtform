const API_BASE = "/api";

export class SessionApiError extends Error {
  constructor(message, { status = 0, code = "request_failed", details = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "SessionApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.revision = details?.revision ?? details?.current_revision ?? null;
    this.snapshot = details?.snapshot ?? details?.current_snapshot ?? null;
    this.retryable = details?.retryable
      ?? details?.error?.retryable
      ?? (status === 409 || status >= 500 || status === 0);
  }
}

function sessionPath(sessionId, suffix = "") {
  if (!sessionId) throw new TypeError("A session ID is required");
  return `${API_BASE}/sessions/${encodeURIComponent(sessionId)}${suffix}`;
}

async function parseResponseBody(response) {
  if (response.status === 204) return null;

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json().catch(() => null);
  }

  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function request(path, { method = "GET", body, headers, signal } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: body === undefined
        ? headers
        : { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (cause) {
    if (cause?.name === "AbortError") throw cause;
    throw new SessionApiError("The session server is unavailable", {
      code: "network_error",
      cause,
    });
  }

  const data = await parseResponseBody(response);
  if (!response.ok) {
    const message = typeof data === "string"
      ? data
      : data?.error?.message ?? data?.error ?? data?.message ?? `Session request failed (${response.status})`;
    const code = typeof data?.error === "object"
      ? data.error.code
      : data?.code ?? (response.status === 409 ? "revision_conflict" : "request_failed");
    throw new SessionApiError(message, {
      status: response.status,
      code,
      details: data,
    });
  }

  return data;
}

export function listSessions({ signal } = {}) {
  return request(`${API_BASE}/sessions`, { signal });
}

export function createSession({ title } = {}, { signal } = {}) {
  return request(`${API_BASE}/sessions`, {
    method: "POST",
    body: title ? { title } : {},
    signal,
  });
}

export function getSession(sessionId, { signal } = {}) {
  return request(sessionPath(sessionId), { signal });
}

export function renameSession(sessionId, title, { signal } = {}) {
  return request(sessionPath(sessionId), {
    method: "PATCH",
    body: { title },
    signal,
  });
}

export function deleteSession(sessionId, { signal } = {}) {
  return request(sessionPath(sessionId), {
    method: "DELETE",
    signal,
  });
}

export function updateSessionUiContext(sessionId, context, { signal } = {}) {
  return request(sessionPath(sessionId, "/ui-context"), {
    method: "PATCH",
    body: context,
    signal,
  });
}

export function applySessionOperation(
  sessionId,
  operation,
  { expectedRevision, callId, actor, signal } = {},
) {
  return request(sessionPath(sessionId, "/operations"), {
    method: "POST",
    body: {
      operation,
      ...(expectedRevision === undefined ? {} : { expected_revision: expectedRevision }),
      ...(callId ? { call_id: callId } : {}),
      ...(actor ? { actor } : {}),
    },
    signal,
  });
}

export function executeSessionToolCall(
  sessionId,
  { name, arguments: toolArguments = {}, callId, expectedRevision },
  { signal } = {},
) {
  return request(sessionPath(sessionId, "/tool-calls"), {
    method: "POST",
    body: {
      name,
      arguments: toolArguments,
      call_id: callId,
      ...(expectedRevision === undefined ? {} : { expected_revision: expectedRevision }),
    },
    signal,
  });
}

export function synthesizeSession(sessionId, { expectedRevision, signal } = {}) {
  return request(sessionPath(sessionId, "/synthesize"), {
    method: "POST",
    body: expectedRevision === undefined ? {} : { expected_revision: expectedRevision },
    signal,
  });
}

export function retrySessionMapController(sessionId, { signal } = {}) {
  return request(sessionPath(sessionId, "/map-controller/retry"), {
    method: "POST",
    body: {},
    signal,
  });
}

export function shouldApplySessionSnapshot(current, incoming) {
  if (!incoming?.id) return false;
  if (!current || current.id !== incoming.id) return true;
  const currentRevision = Number.isFinite(current.revision) ? current.revision : -1;
  const incomingRevision = Number.isFinite(incoming.revision) ? incoming.revision : -1;
  if (incomingRevision !== currentRevision) return incomingRevision > currentRevision;
  const currentControllerEpoch = Number.isFinite(current.controller_event_epoch)
    ? current.controller_event_epoch
    : 0;
  const incomingControllerEpoch = Number.isFinite(incoming.controller_event_epoch)
    ? incoming.controller_event_epoch
    : 0;
  if (incomingControllerEpoch !== currentControllerEpoch) {
    return incomingControllerEpoch > currentControllerEpoch;
  }
  const currentControllerSequence = Number.isFinite(current.controller_event_sequence)
    ? current.controller_event_sequence
    : 0;
  const incomingControllerSequence = Number.isFinite(incoming.controller_event_sequence)
    ? incoming.controller_event_sequence
    : 0;
  return incomingControllerSequence >= currentControllerSequence;
}

export async function negotiateRealtimeSession(
  sessionId,
  sdp,
  { voiceMode = "vad", signal } = {},
) {
  if (typeof sdp !== "string" || !sdp.trim()) {
    throw new TypeError("A WebRTC offer SDP is required");
  }

  const query = new URLSearchParams({ voice_mode: voiceMode });
  let response;
  try {
    response = await fetch(`${sessionPath(sessionId, "/realtime")}?${query}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/sdp",
        Accept: "application/sdp, application/json",
      },
      body: sdp,
      signal,
    });
  } catch (cause) {
    if (cause?.name === "AbortError") throw cause;
    throw new SessionApiError("Realtime voice could not reach the session server", {
      code: "realtime_network_error",
      cause,
    });
  }

  const answer = await parseResponseBody(response);
  if (!response.ok) {
    const message = typeof answer === "string"
      ? answer
      : answer?.error?.message ?? answer?.error ?? answer?.message ?? `Realtime setup failed (${response.status})`;
    throw new SessionApiError(message, {
      status: response.status,
      code: answer?.code ?? answer?.error?.code ?? "realtime_setup_failed",
      details: answer,
    });
  }

  const answerSdp = typeof answer === "string" ? answer : answer?.sdp;
  if (!answerSdp) {
    throw new SessionApiError("Realtime setup returned no answer SDP", {
      code: "invalid_realtime_answer",
      details: answer,
    });
  }
  return answerSdp;
}

function decodeEvent(event) {
  if (!event.data) return null;
  try {
    return JSON.parse(event.data);
  } catch {
    return { type: event.type, data: event.data };
  }
}

/**
 * Subscribe to canonical session updates. The returned function is the complete
 * cleanup operation and is safe to call more than once.
 */
export function subscribeSessionEvents(
  sessionId,
  handlers = {},
  {
    EventSourceImpl = globalThis.EventSource,
    reconnectDelayMs = 500,
    setTimeoutImpl = globalThis.setTimeout,
    clearTimeoutImpl = globalThis.clearTimeout,
  } = {},
) {
  if (!EventSourceImpl) {
    throw new SessionApiError("This browser does not support live session updates", {
      code: "event_source_unavailable",
    });
  }

  const normalized = typeof handlers === "function" ? { onSnapshot: handlers } : handlers;
  const eventUrl = sessionPath(sessionId, "/events");
  let source = null;
  let retryTimer = null;
  let retryCount = 0;
  let closed = false;

  // EventSource only routes named SSE events to explicitly registered listeners.
  const namedEvents = [
    "snapshot",
    "session",
    "update",
    "operation",
    "proposal",
    "transcript",
    "activity",
    "map_controller",
    "connected",
  ];

  const connect = () => {
    if (closed) return;
    const current = new EventSourceImpl(eventUrl);
    source = current;
    const dispatch = (event) => {
      if (closed || source !== current) return;
      const payload = decodeEvent(event);
      normalized.onEvent?.(payload, event);

      const carriesSnapshot = ["snapshot", "session", "update"].includes(event.type)
        || payload?.type === "snapshot";
      const snapshot = payload?.snapshot
        ?? payload?.session
        ?? (carriesSnapshot ? payload?.data ?? payload : null);
      if (snapshot) normalized.onSnapshot?.(snapshot, event);
    };

    current.onopen = (event) => {
      if (closed || source !== current) return;
      retryCount = 0;
      normalized.onOpen?.(event);
    };
    current.onerror = (event) => {
      if (closed || source !== current) return;
      normalized.onError?.(event);
      current.close();
      source = null;
      const delay = Math.min(reconnectDelayMs * (2 ** retryCount), 2_000);
      retryCount += 1;
      retryTimer = setTimeoutImpl(connect, delay);
    };
    current.onmessage = dispatch;
    for (const eventName of namedEvents) current.addEventListener?.(eventName, dispatch);
  };

  connect();

  return () => {
    if (closed) return;
    closed = true;
    if (retryTimer) clearTimeoutImpl(retryTimer);
    source?.close();
    source = null;
  };
}

// Concise aliases for callers that already operate in a session namespace.
export const patchSessionUiContext = updateSessionUiContext;
export const performSessionOperation = applySessionOperation;
export const postSessionToolCall = executeSessionToolCall;
export const requestSessionSynthesis = synthesizeSession;
export const retryMapController = retrySessionMapController;
