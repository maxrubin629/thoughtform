import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createThoughtformServer } from "../../server/index.mjs";
import { createSessionStore } from "../../server/sessionStore.mjs";

/** A real HTTP server and isolated session directory, both closed after the test. */
export async function startTestServer(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "thoughtform-http-"));
  const store = createSessionStore({ directory });
  const app = await createThoughtformServer({ store, env: {}, ...options });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  t.after(async () => {
    app.locals.dispose();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const request = async (route, { method = "GET", body, headers } = {}) => {
    const response = await fetch(base + route, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { response, status: response.status, data: await response.json() };
  };
  return { app, store, directory, base, request, post: (route, body) => request(route, { method: "POST", body }) };
}
