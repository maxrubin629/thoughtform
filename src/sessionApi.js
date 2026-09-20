import { request, requestSession, sessionPath, SessionApiError } from "./apiRequest.js";
export { SessionApiError } from "./apiRequest.js";

export function listSessions({ signal } = {}) {
  return request("/api/sessions", { signal });
}

export function createSession({ title } = {}, { signal } = {}) {
  return request("/api/sessions", {
    method: "POST",
    body: title ? { title } : {},
    signal,
  });
}

export function getSession(sessionId, { signal } = {}) {
  return requestSession(sessionId, "", { signal });
}

export function renameSession(sessionId, title, { signal } = {}) {
  return requestSession(sessionId, "", {
    method: "PATCH",
    body: { title },
    signal,
  });
}

export function deleteSession(sessionId, { signal } = {}) {
  return requestSession(sessionId, "", {
    method: "DELETE",
    signal,
  });
}

export function updateSessionUiContext(sessionId, context, { signal } = {}) {
  return requestSession(sessionId, "/ui-context", {
    method: "PATCH",
    body: context,
    signal,
  });
}

export async function applySessionOperation(
  sessionId,
  operation,
  { expectedRevision, callId, actor, signal } = {},
) {
  const commit = (revision) => requestSession(sessionId, "/operations", {
    method: "POST",
    body: {
      operation,
      ...(revision === undefined ? {} : { expected_revision: revision }),
      ...(callId ? { call_id: callId } : {}),
      ...(actor ? { actor } : {}),
    },
    signal,
  });
  try {
    return await commit(expectedRevision);
  } catch (error) {
    if (!(error instanceof SessionApiError) || error.code !== "revision_conflict" || !Number.isInteger(error.revision)) throw error;
    // Rebase an explicit action once; further conflicts return to the caller.
    return commit(error.revision);
  }
}

export function synthesizeSession(sessionId, { expectedRevision, signal } = {}) {
  return requestSession(sessionId, "/synthesize", {
    method: "POST",
    body: expectedRevision === undefined ? {} : { expected_revision: expectedRevision },
    signal,
  });
}

export function retrySessionMapController(sessionId, { signal } = {}) {
  return requestSession(sessionId, "/map-controller/retry", {
    method: "POST",
    body: {},
    signal,
  });
}

export function shouldApplySessionSnapshot(current, incoming) {
  if (!incoming?.id) return false;
  if (!current || current.id !== incoming.id) return true;
  // Revision wins, followed by the controller's restart epoch and event sequence.
  for (const [key, fallback] of [["revision", -1], ["controller_event_epoch", 0], ["controller_event_sequence", 0]]) {
    const before = Number.isFinite(current[key]) ? current[key] : fallback;
    const after = Number.isFinite(incoming[key]) ? incoming[key] : fallback;
    if (before !== after) return after > before;
  }
  return true;
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
