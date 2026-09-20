import { fileURLToPath } from "node:url";
import express from "express";
import OpenAI from "openai";
import { createSessionStore } from "./sessionStore.mjs";
import { DEFAULT_MAP_CONTROLLER_MODEL } from "./mapController.mjs";
import { registerLiveRoutes } from "./live.mjs";
import { DEFAULT_LIVE_MODEL, DEFAULT_LIVE_BACKEND_MODEL } from "./liveCapture.mjs";
import { createWorkspaceRuntime } from "./workspaceRuntime.mjs";
import { createJsonRoute } from "./http.mjs";
import { registerSessionRoutes } from "./sessionRoutes.mjs";

export async function createThoughtformServer({
  env = process.env,
  store = createSessionStore(env.THOUGHTFORM_DATA_DIR ? { directory: env.THOUGHTFORM_DATA_DIR } : {}),
  openaiClient = env.OPENAI_API_KEY ? new OpenAI({ apiKey: env.OPENAI_API_KEY }) : null,
  fetchImpl = globalThis.fetch,
  ...runtimeOptions
} = {}) {
  const workspace = await createWorkspaceRuntime({ store, openaiClient, env, ...runtimeOptions });
  const { snapshotFor, mapController, mapControllerScheduler, curator, curatorScheduler, controllerConfigured } = workspace;
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", (req, res, next) => {
    const origin = req.get("origin");
    if (origin && !/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|terminal\.local)(?::\d+)?$/i.test(origin)) {
      return res.status(403).json({ ok: false, error: { code: "origin_not_allowed", message: "This local API only accepts the Thoughtform app origin." } });
    }
    next();
  });

  const jsonRoute = createJsonRoute({ store, snapshotFor });
  registerSessionRoutes(app, { workspace, jsonRoute, openaiClient, env });
  const live = registerLiveRoutes(app, { ...workspace, openaiClient, env, fetchImpl, jsonRoute });

  app.get("/api/health", (_req, res) => res.json({
    ok: true,
    model: env.OPENAI_MODEL ?? DEFAULT_LIVE_BACKEND_MODEL,
    mock: !controllerConfigured,
    live: {
      configured: controllerConfigured,
      model: env.OPENAI_LIVE_MODEL ?? DEFAULT_LIVE_MODEL,
      backend_model: env.OPENAI_LIVE_BACKEND_MODEL ?? DEFAULT_LIVE_BACKEND_MODEL,
      reasoning_effort: "medium",
    },
    map_controller: {
      configured: controllerConfigured,
      enabled: Boolean(mapControllerScheduler),
      model: mapController?.model ?? env.OPENAI_MAP_CONTROLLER_MODEL ?? DEFAULT_MAP_CONTROLLER_MODEL,
    },
    ...(curator ? { curator: { enabled: true, model: curator.model } } : {}),
  }));

  Object.assign(app.locals, {
    sessionStore: store, mapController, mapControllerScheduler,
    ...(curator ? { curator } : {}),
    ...(curatorScheduler ? { curatorScheduler } : {}),
    dispose() { live.dispose(); workspace.dispose(); },
  });
  return app;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT ?? 8787);
  const app = await createThoughtformServer();
  const server = app.listen(port, "127.0.0.1", () => {
    console.log(`thoughtform server on http://localhost:${port}`);
  });
  const shutdown = () => {
    app.locals.dispose();
    server.close(() => process.exit(0));
    server.closeAllConnections?.();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
