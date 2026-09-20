import { requestSession } from "./apiRequest.js";

export function updateWorkspacePreferences(sessionId, preferences) {
  return requestSession(sessionId, "/preferences", { method: "PATCH", body: preferences });
}

export async function downloadSessionExport(sessionId, format = "markdown") {
  const response = await requestSession(sessionId, `/export?format=${encodeURIComponent(format)}`, { raw: true });
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  const disposition = response.headers.get("content-disposition") ?? "";
  link.download = disposition.match(/filename="([^"]+)"/)?.[1] ?? `thoughtform-session.${format === "json" ? "json" : "md"}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
