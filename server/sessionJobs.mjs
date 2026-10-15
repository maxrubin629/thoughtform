/**
 * Per-session cancellation scopes for background model work. Deleting a
 * session aborts its scope; disposing the server aborts every scope. A
 * cancelled scope stays aborted, so work that asks for a signal after the
 * deletion (for example while it was still loading context) cannot start.
 */
export class SessionCancelledError extends Error {
  constructor(message = "This session's work was cancelled.") {
    super(message);
    this.name = "SessionCancelledError";
    this.code = "session_cancelled";
    this.status = 410;
  }
}

/** True for our cancellation reason or the OpenAI SDK's wrapped abort. */
export const isCancellation = (error) => (
  error instanceof SessionCancelledError || error?.name === "APIUserAbortError" || error?.name === "AbortError"
);

export function createSessionJobs() {
  const root = new AbortController();
  const scopes = new Map();

  const signal = (sessionId) => {
    let scope = scopes.get(sessionId);
    if (!scope) {
      scope = new AbortController();
      scopes.set(sessionId, scope);
    }
    return AbortSignal.any([root.signal, scope.signal]);
  };

  const cancel = (sessionId) => {
    let scope = scopes.get(sessionId);
    if (!scope) {
      scope = new AbortController();
      scopes.set(sessionId, scope);
    }
    if (!scope.signal.aborted) scope.abort(new SessionCancelledError());
  };

  const dispose = () => {
    root.abort(new SessionCancelledError("The server is shutting down."));
    scopes.clear();
  };

  return { signal, cancel, dispose };
}
