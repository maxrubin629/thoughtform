/** Shared same-origin transport for canonical sessions, voice, and workspace data. */
export class SessionApiError extends Error {
  constructor(message, { status = 0, code = "request_failed", details = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "SessionApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.revision = details?.revision ?? details?.current_revision ?? null;
    this.snapshot = details?.snapshot ?? details?.current_snapshot ?? null;
    this.retryable = details?.retryable ?? details?.error?.retryable
      ?? (status === 409 || status >= 500 || status === 0);
  }
}

export function sessionPath(sessionId, suffix = "") {
  if (!sessionId) throw new TypeError("A session ID is required");
  return `/api/sessions/${encodeURIComponent(sessionId)}${suffix}`;
}

async function responseBody(response) {
  if (response.status === 204) return null;
  if (response.headers.get("content-type")?.includes("application/json")) {
    return response.json().catch(() => null);
  }
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

export async function request(path, { method = "GET", body, headers, signal, keepalive, raw = false } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      ...(keepalive === undefined ? {} : { keepalive }),
    });
  } catch (cause) {
    if (cause?.name === "AbortError") throw cause;
    throw new SessionApiError("The session server is unavailable", { code: "network_error", cause });
  }
  if (response.ok && raw) return response;
  const data = await responseBody(response);
  if (!response.ok) {
    throw new SessionApiError(
      typeof data === "string" ? data : data?.error?.message ?? data?.error ?? data?.message ?? `Session request failed (${response.status})`,
      {
        status: response.status,
        code: data?.error?.code ?? data?.code ?? (response.status === 409 ? "revision_conflict" : "request_failed"),
        details: data,
      },
    );
  }
  return data;
}

export function requestSession(sessionId, suffix, options) {
  return request(sessionPath(sessionId, suffix), options);
}
