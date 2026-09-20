import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { request, SessionApiError } from "./apiRequest.js";
import { updateWorkspacePreferences } from "./workspaceApi.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("workspace errors preserve the same conflict snapshot and retry metadata as map operations", async () => {
  const details = { error: { code: "revision_conflict", message: "Map changed", retryable: false }, revision: 7, snapshot: { id: "map", revision: 7 } };
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "/api/sessions/map%2F1/preferences");
    assert.equal(options.method, "PATCH");
    assert.deepEqual(JSON.parse(options.body), { mapping: "paused" });
    return Response.json(details, { status: 409 });
  };
  await assert.rejects(updateWorkspacePreferences("map/1", { mapping: "paused" }), (error) => {
    assert.ok(error instanceof SessionApiError);
    assert.equal(error.code, "revision_conflict");
    assert.equal(error.revision, 7);
    assert.equal(error.retryable, false);
    assert.deepEqual(error.snapshot, details.snapshot);
    return true;
  });
});

test("cancellation and keepalive survive the shared request boundary", async () => {
  const controller = new AbortController();
  const cause = new DOMException("Cancelled", "AbortError");
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.signal, controller.signal);
    assert.equal(options.keepalive, true);
    throw cause;
  };
  await assert.rejects(request("/api/sessions/map", { signal: controller.signal, keepalive: true }), (error) => error === cause);
});

test("raw export responses stay unread while HTTP failures still become structured errors", async () => {
  const file = new Response("# Saved session", { headers: { "Content-Type": "text/markdown" } });
  globalThis.fetch = async () => file;
  assert.equal(await request("/api/sessions/map/export", { raw: true }), file);
  assert.equal(file.bodyUsed, false);
  globalThis.fetch = async () => new Response("Export unavailable", { status: 503 });
  await assert.rejects(request("/api/sessions/map/export", { raw: true }), { message: "Export unavailable", status: 503, retryable: true });
});

test("empty and malformed JSON responses retain their established null behavior", async () => {
  for (const response of [new Response(null, { status: 204 }), new Response("broken", { headers: { "Content-Type": "application/json" } })]) {
    globalThis.fetch = async () => response;
    assert.equal(await request("/api/sessions/map"), null);
  }
});
