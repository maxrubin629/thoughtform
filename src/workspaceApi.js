import { SessionApiError } from "./sessionApi.js";

async function responseOrError(response) {
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new SessionApiError(payload?.error?.message ?? payload?.error ?? "The session could not be saved", { status: response.status, code: payload?.error?.code ?? "request_failed", details: payload });
  return payload;
}

export async function updateWorkspacePreferences(sessionId, preferences) {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/preferences`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(preferences),
  });
  return responseOrError(response);
}

export async function downloadSessionExport(sessionId, format = "markdown") {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/export?format=${encodeURIComponent(format)}`);
  if (!response.ok) return responseOrError(response);
  const blob = await response.blob();
  const disposition = response.headers.get("content-disposition") ?? "";
  saveSessionDownload(blob, disposition.match(/filename="([^"]+)"/)?.[1] ?? `thoughtform-session.${format === "json" ? "json" : "md"}`);
}

export function saveSessionDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
