import { sessionSnapshot } from "../shared/sessionSnapshot.mjs";
import { fileURLToPath } from "node:url";
import express from "express";
import OpenAI from "openai";
import { SYNTHESIZE_SYSTEM } from "./prompts.mjs";
import { createSessionStore } from "./sessionStore.mjs";
import {
  RevisionConflictError,
  SessionOperationError,
  applyOperation,
} from "./sessionOperations.mjs";
import { createMapController, createMapControllerScheduler } from "./mapController.mjs";
import { createCurator, createCuratorScheduler } from "./curator.mjs";
import { resolveServerConfig } from "./config.mjs";
import { registerLiveRoutes } from "./live.mjs";
import { createSessionJobs, isCancellation } from "./sessionJobs.mjs";
import { sessionMarkdown } from "./sessionExport.mjs";

function synthesisGraph(session) {
  return {
    thoughts: session.nodes.map((node) => ({
      id: node.id,
      text: node.text,
      depth: node.depth,
      x: node.x,
      y: node.y,
      sources: node.sources,
    })),
    connections: session.edges.map((edge) => ({
      id: edge.id,
      from: edge.from,
      to: edge.to,
    })),
  };
}

function errorPayload(error, snapshot) {
  const { snapshot: _nestedSnapshot, ...details } = error?.details ?? {};
  return {
    ok: false,
    error: {
      code: error?.code ?? "request_failed",
      message: error?.message ?? "The request failed",
      retryable: Boolean(error?.retryable),
      ...details,
    },
    ...(snapshot ? { revision: snapshot.revision, snapshot } : {}),
  };
}

/** Queue SSE chunks per response when Node signals stream backpressure. */
export function createSseEventWriter() {
  const responses = new Map();

  const detach = (response, state) => {
    response.removeListener?.("drain", state.onDrain);
    response.removeListener?.("close", state.onClose);
    response.removeListener?.("error", state.onClose);
  };

  const cleanup = (response) => {
    const state = responses.get(response);
    if (!state) return;
    state.queue.length = 0;
    detach(response, state);
    responses.delete(response);
  };

  const flush = (response, state) => {
    if (response.destroyed || response.writableEnded) {
      cleanup(response);
      return false;
    }
    if (state.draining) return false;
    while (state.queue.length) {
      const chunk = state.queue.shift();
      if (!response.write(chunk)) {
        state.draining = true;
        response.once?.("drain", state.onDrain);
        return false;
      }
    }
    cleanup(response);
    return true;
  };

  const write = (response, chunk) => {
    if (response.destroyed || response.writableEnded) {
      cleanup(response);
      return false;
    }
    let state = responses.get(response);
    if (!state) {
      state = {
        queue: [],
        draining: false,
        onDrain: null,
        onClose: null,
      };
      state.onDrain = () => {
        state.draining = false;
        flush(response, state);
      };
      state.onClose = () => cleanup(response);
      responses.set(response, state);
      response.once?.("close", state.onClose);
      response.once?.("error", state.onClose);
    }
    state.queue.push(chunk);
    return flush(response, state);
  };

  return { write, cleanup };
}

export async function createThoughtformServer({
  env = process.env,
  store: suppliedStore,
  openaiClient: suppliedOpenaiClient,
  fetchImpl = globalThis.fetch,
  controllerEventEpoch = Date.now(),
  mapController: suppliedMapController,
  mapControllerScheduler: suppliedMapControllerScheduler,
  mapControllerFactory = createMapController,
  mapControllerSchedulerFactory = createMapControllerScheduler,
  curator: suppliedCurator,
  curatorScheduler: suppliedCuratorScheduler,
  curatorFactory = createCurator,
  curatorSchedulerFactory = createCuratorScheduler,
} = {}) {
  const config = resolveServerConfig(env);
  const store = suppliedStore ?? createSessionStore(config.dataDirectory ? { directory: config.dataDirectory } : {});
  const openaiClient = suppliedOpenaiClient ?? (config.apiKey ? new OpenAI({ apiKey: config.apiKey }) : null);
  await store.init();
  const app = express();
  const uiContexts = new Map();
  const eventClients = new Map();
  const controllerEventSequences = new Map();
  const sseWriter = createSseEventWriter();
  const sessionJobs = createSessionJobs();
  const synthesisRuns = new Map();
  const savedSynthesisOrder = new Map();
  let synthesisOrder = 0;
  const controllerConfigured = Boolean(openaiClient);
  const controllerRuntimeEnabled = config.mapControllerEnabled && (
    controllerConfigured || suppliedMapController || suppliedMapControllerScheduler
  );
  let mapController = null;
  let mapControllerScheduler = null;
  let curator = null;
  let curatorScheduler = null;

  const controllerEventSequenceFor = (sessionId) => controllerEventSequences.get(sessionId) ?? 0;
  const advanceControllerEventSequence = (sessionId) => {
    const next = controllerEventSequenceFor(sessionId) + 1;
    controllerEventSequences.set(sessionId, next);
    return next;
  };

  const hasUnprocessedUserUtterance = (session) => (
    session.transcript
      .slice(session.map_controller.processed_transcript_count)
      .some((item) => item.speaker === "you" && item.text?.trim())
  );

  const mapControllerStatusFor = (session) => {
    if (!mapControllerScheduler) return "idle";
    const state = mapControllerScheduler.state?.(session.id) ?? {};
    if (state.active || state.preparing) return "running";
    if (state.scheduled || state.queued) return "waiting";
    if (session.map_controller.last_error) return "error";
    return "idle";
  };

  const snapshotFor = (session) => {
    const snapshot = sessionSnapshot(session, {
      uiContext: uiContexts.get(session.id),
      controllerEventEpoch,
      controllerEventSequence: controllerEventSequenceFor(session.id),
      controllerStatus: mapControllerStatusFor(session),
    });
    uiContexts.set(session.id, snapshot.ui_context);
    return snapshot;
  };

  const writeEvent = (response, chunk) => sseWriter.write(response, chunk);

  const publish = (session, event = "snapshot", detail = {}, publishedSnapshot = null) => {
    const listeners = eventClients.get(session.id);
    if (!listeners?.size) return;
    const payload = JSON.stringify({
      type: event,
      snapshot: publishedSnapshot ?? snapshotFor(session),
      ...detail,
    });
    listeners.forEach((response) => {
      if (response.destroyed || response.writableEnded) {
        sseWriter.cleanup(response);
        listeners.delete(response);
        return;
      }
      writeEvent(response, `event: ${event}\ndata: ${payload}\n\n`);
    });
    if (!listeners.size) eventClients.delete(session.id);
  };

  const performOperation = async (sessionId, operation) => {
    const result = await store.transact(sessionId, (session) => applyOperation(session, operation, {
      selection: uiContexts.get(sessionId),
      requireExpectedRevision: true,
    }));
    const snapshot = snapshotFor(result.session);
    publish(result.session, operation.type === "append_utterance" ? "transcript" : "operation", {
      operation_id: result.operation_id,
    });
    return {
      ok: true,
      operation_id: result.operation_id,
      revision: result.revision,
      affected_ids: result.affected_ids,
      warnings: result.warnings,
      ...(result.replayed !== undefined ? { replayed: result.replayed } : {}),
      ...(result.effective_type ? { effective_type: result.effective_type } : {}),
      ...(result.proposal_status ? { proposal_status: result.proposal_status } : {}),
      ...(result.connection_animation_delays ? { connection_animation_delays: result.connection_animation_delays } : {}),
      snapshot,
    };
  };

  const publishMapControllerSnapshot = async (sessionId, committedSession = null) => {
    advanceControllerEventSequence(sessionId);
    const session = committedSession ?? await store.get(sessionId);
    const snapshot = snapshotFor(session);
    publish(session, "map_controller", {}, snapshot);
    return snapshot;
  };

  const commitCuratorProposal = async (sessionId, proposal) => {
    const result = await store.transact(sessionId, (session) => {
      if (session.preferences?.partner_mode === "quiet" || session.preferences?.mapping_paused) {
        return { session, skipped: true };
      }
      return applyOperation(session, {
      type: "propose_changes",
      actor: "curator",
      origin: "ui",
      call_id: `curator-${proposal.id}`,
      expected_revision: proposal.base_revision,
      proposal_id: proposal.id,
      base_revision: proposal.base_revision,
      rationale: proposal.rationale,
      evidence: proposal.evidence,
      operations: proposal.operations,
      });
    });
    if (result.skipped) return result;
    const snapshot = snapshotFor(result.session);
    publish(result.session, "operation", { operation_id: result.operation_id }, snapshot);
    return { ...result, snapshot };
  };

  if (controllerRuntimeEnabled) {
    mapController = suppliedMapController ?? mapControllerFactory({
      env,
      client: openaiClient ?? undefined,
      model: config.models.mapController,
      loadSnapshot: (sessionId) => store.get(sessionId),
      transact: (sessionId, transform) => store.transact(sessionId, transform),
    });
    mapControllerScheduler = suppliedMapControllerScheduler ?? mapControllerSchedulerFactory({
      controller: mapController,
      loadSnapshot: (sessionId) => store.get(sessionId),
      onStateChange: (sessionId) => publishMapControllerSnapshot(sessionId).catch(() => {}),
      onComplete: async (sessionId, result) => {
        await publishMapControllerSnapshot(sessionId, result?.session ?? null).catch(() => {});
        curatorScheduler?.notify(sessionId);
      },
      onError: (_error, sessionId) => publishMapControllerSnapshot(sessionId).catch(() => {}),
    });
  }

  const curatorRuntimeEnabled = Boolean(
    mapControllerScheduler
    && config.curatorEnabled
    && (controllerConfigured || suppliedCurator || suppliedCuratorScheduler),
  );
  if (curatorRuntimeEnabled) {
    curator = suppliedCurator ?? curatorFactory({
      env,
      client: openaiClient ?? undefined,
      model: config.models.curator,
    });
    curatorScheduler = suppliedCuratorScheduler ?? curatorSchedulerFactory({
      curator,
      loadSnapshot: (sessionId) => store.get(sessionId),
      isBlocked: (sessionId) => {
        const state = mapControllerScheduler?.state?.(sessionId) ?? {};
        return Boolean(state.scheduled || state.preparing || state.active || state.queued);
      },
      onProposal: commitCuratorProposal,
      onError: (error) => console.error(error),
    });
  }

  const recoverMapController = (session) => {
    if (!mapControllerScheduler || !hasUnprocessedUserUtterance(session)) return false;
    return mapControllerScheduler.recover(session.id);
  };

  if (mapControllerScheduler) {
    const { sessions } = await store.list();
    for (const { id } of sessions) recoverMapController(await store.get(id));
  }

  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", (req, res, next) => {
    const origin = req.get("origin");
    if (origin && !/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|terminal\.local)(?::\d+)?$/i.test(origin)) {
      res.status(403).json({ ok: false, error: { code: "origin_not_allowed", message: "This local API only accepts the Thoughtform app origin." } });
      return;
    }
    next();
  });

  const jsonRoute = (handler) => async (req, res) => {
    try {
      const value = await handler(req, res);
      if (!res.headersSent) res.json(value);
    } catch (error) {
      const status = isCancellation(error) ? 410 : error?.status ?? (error instanceof RevisionConflictError ? 409 : 500);
      let snapshot = error?.snapshot ?? error?.details?.snapshot ?? null;
      if (!snapshot && req.params?.id) {
        snapshot = await store.get(req.params.id).catch(() => null);
      }
      if (snapshot) snapshot = snapshotFor(snapshot);
      if (status >= 500 && !(error instanceof SessionOperationError)) console.error(error);
      res.status(status).json(errorPayload(error, snapshot));
    }
  };

  const updatePreferences = async (sessionId, patch = {}) => {
    const allowed = new Set(["mapping_paused", "partner_mode"]);
    if (!patch || typeof patch !== "object" || Array.isArray(patch)
      || Object.keys(patch).some((key) => !allowed.has(key))
      || (patch.mapping_paused !== undefined && typeof patch.mapping_paused !== "boolean")
      || (patch.partner_mode !== undefined && !["quiet", "proactive"].includes(patch.partner_mode))) {
      throw new SessionOperationError("Choose a valid mapping or Partner setting.", { code: "invalid_preferences" });
    }
    const updated = await store.transact(sessionId, (session) => ({
      ...session,
      preferences: { mapping_paused: false, partner_mode: "proactive", ...session.preferences, ...patch },
      updated_at: new Date().toISOString(),
    }));
    await mapControllerScheduler?.preferencesChanged?.(sessionId);
    if (updated.preferences.partner_mode === "quiet" || updated.preferences.mapping_paused) curatorScheduler?.cancel(sessionId);
    const snapshot = await publishMapControllerSnapshot(sessionId);
    return { ok: true, snapshot };
  };

  const liveService = registerLiveRoutes(app, {
    store, openaiClient, fetchImpl, jsonRoute,
    apiKey: config.apiKey, liveModel: config.models.live, backendModel: config.models.liveBackend, publish, snapshotFor, performOperation,
    updatePreferences, sessionSignal: sessionJobs.signal,
    getUiContext: (sessionId) => uiContexts.get(sessionId) ?? {},
    mapControllerScheduler,
    onTranscriptCommitted: async (sessionId, utterance) => {
      if (mapControllerScheduler?.notify(sessionId, utterance)) await publishMapControllerSnapshot(sessionId);
    },
  });

  app.patch("/api/sessions/:id/preferences", jsonRoute((req) => updatePreferences(req.params.id, req.body)));

  app.get("/api/sessions/:id/export", jsonRoute(async (req, res) => {
    const session = await store.get(req.params.id);
    const markdown = req.query.format === "markdown";
    res.set("Content-Disposition", `attachment; filename="thoughtform-${session.id}.${markdown ? "md" : "json"}"`);
    res.type(markdown ? "text/markdown" : "application/json").send(markdown ? sessionMarkdown(session) : JSON.stringify(session, null, 2));
  }));

  app.get("/api/health", (req, res) => {
    res.json({
      ok: true,
      model: config.models.synthesis,
      live: {
        configured: controllerConfigured,
        voice_configured: Boolean(config.apiKey),
        model: config.models.live,
        backend_model: config.models.liveBackend,
        reasoning_effort: config.reasoningEffort,
      },
      map_controller: {
        configured: controllerConfigured,
        enabled: Boolean(mapControllerScheduler),
        model: mapController?.model ?? config.models.mapController,
      },
      ...(curator ? {
        curator: {
          enabled: true,
          model: curator.model,
        },
      } : {}),
    });
  });

  app.get("/api/sessions", jsonRoute(() => store.list()));

  app.post("/api/sessions", jsonRoute(async (req) => (
    snapshotFor(await store.create({ title: req.body?.title }))
  )));

  app.get("/api/sessions/:id", jsonRoute(async (req) => {
    const session = await store.get(req.params.id);
    await store.setActive(session.id);
    recoverMapController(session);
    liveService.recoverCapture(session);
    return snapshotFor(session);
  }));

  app.patch("/api/sessions/:id", jsonRoute(async (req) => (
    snapshotFor(await store.rename(req.params.id, req.body?.title))
  )));

  app.delete("/api/sessions/:id", jsonRoute(async (req) => {
    sessionJobs.cancel(req.params.id);
    liveService.cancel(req.params.id);
    savedSynthesisOrder.delete(req.params.id);
    mapControllerScheduler?.cancel(req.params.id);
    curatorScheduler?.cancel(req.params.id);
    uiContexts.delete(req.params.id);
    controllerEventSequences.delete(req.params.id);
    const listeners = eventClients.get(req.params.id);
    listeners?.forEach((response) => {
      sseWriter.cleanup(response);
      response.end();
    });
    eventClients.delete(req.params.id);
    return store.delete(req.params.id);
  }));

  app.patch("/api/sessions/:id/ui-context", jsonRoute(async (req) => {
    const session = await store.get(req.params.id);
    const nodeIds = new Set(session.nodes.map((node) => node.id));
    const context = {
      selected_node_ids: Array.isArray(req.body?.selected_node_ids)
        ? [...new Set(req.body.selected_node_ids.filter((id) => nodeIds.has(id)))]
        : [],
      selected_proposal_id: session.proposals.some((proposal) => proposal.id === req.body?.selected_proposal_id && ["pending", "stale"].includes(proposal.status)) ? req.body.selected_proposal_id : null,
      focus_id: nodeIds.has(req.body?.focus_id) ? req.body.focus_id : null,
      view_mode: req.body?.view_mode === "hierarchy" ? "hierarchy" : "clusters",
      voice_mode: req.body?.voice_mode === "push-to-talk" ? "push-to-talk" : "vad",
    };
    uiContexts.set(session.id, context);
    await store.setActive(session.id);
    return { ok: true, revision: session.revision, ui_context: context, snapshot: snapshotFor(session) };
  }));

  app.post("/api/sessions/:id/operations", jsonRoute(async (req) => {
    const nested = req.body?.operation;
    const operation = {
      ...(nested && typeof nested === "object" ? nested : req.body),
      expected_revision: req.body?.expected_revision ?? nested?.expected_revision,
      ...(req.body?.call_id ? { call_id: req.body.call_id } : {}),
      ...(req.body?.actor ? { actor: req.body.actor } : {}),
    };
    const result = await performOperation(req.params.id, operation);
    if (!result.replayed && operation.type === "append_utterance" && operation.speaker === "you") {
      const scheduled = mapControllerScheduler?.notify(req.params.id, result.snapshot.transcript.at(-1));
      if (scheduled) {
        const session = await store.get(req.params.id);
        result.snapshot = await publishMapControllerSnapshot(session.id, session);
      }
    }
    return result;
  }));

  app.post("/api/sessions/:id/map-controller/retry", jsonRoute(async (req) => {
    const session = await store.get(req.params.id);
    if (!mapControllerScheduler) {
      throw new SessionOperationError("The map controller is not configured.", {
        code: "map_controller_unavailable",
        status: 503,
        retryable: true,
      });
    }
    mapControllerScheduler.retry(session.id);
    const snapshot = await publishMapControllerSnapshot(session.id, session);
    return { ok: true, scheduled: true, snapshot };
  }));

  app.get("/api/sessions/:id/events", async (req, res) => {
    let sessionId = null;
    let heartbeat = null;
    const cleanup = () => {
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      sseWriter.cleanup(res);
      if (!sessionId) return;
      const listeners = eventClients.get(sessionId);
      listeners?.delete(res);
      if (!listeners?.size) eventClients.delete(sessionId);
    };
    req.once("close", cleanup);
    try {
      const session = await store.get(req.params.id);
      sessionId = session.id;
      if (req.destroyed) {
        cleanup();
        return;
      }
      res.status(200);
      res.set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders?.();
      const listeners = eventClients.get(session.id) ?? new Set();
      listeners.add(res);
      eventClients.set(session.id, listeners);
      writeEvent(res, `event: connected\ndata: ${JSON.stringify({ type: "connected", revision: session.revision })}\n\n`);
      writeEvent(res, `event: snapshot\ndata: ${JSON.stringify({ type: "snapshot", snapshot: snapshotFor(session) })}\n\n`);
      heartbeat = setInterval(() => {
        if (res.destroyed || res.writableEnded) cleanup();
        else writeEvent(res, ": keep-alive\n\n");
      }, 20_000);
    } catch (error) {
      cleanup();
      if (!res.headersSent) res.status(error?.status ?? 500).json(errorPayload(error));
    }
  });

  app.post("/api/sessions/:id/synthesize", jsonRoute(async (req) => {
    const session = await store.get(req.params.id);
    const expected = req.body?.expected_revision;
    if (expected !== undefined && Number(expected) !== session.revision) {
      throw new RevisionConflictError(Number(expected), session);
    }
    if (!session.nodes.length) {
      throw new SessionOperationError("Add at least one bubble before synthesizing.", { code: "empty_map" });
    }
    if (!openaiClient) throw new SessionOperationError("Connect OpenAI to write a synthesis.", { code: "model_unavailable", status: 503 });
    // Repeated requests over the same map and transcript share one model call.
    // The transcript is append-only and does not advance the map revision.
    const runKey = `${session.id}:${session.revision}:${session.transcript.length}`;
    if (!synthesisRuns.has(runKey)) {
      const run = synthesize(session).finally(() => synthesisRuns.delete(runKey));
      synthesisRuns.set(runKey, run);
    }
    return synthesisRuns.get(runKey);
  }));

  const synthesize = async (session) => {
    const order = ++synthesisOrder;
    const response = await openaiClient.responses.create({
      model: config.models.synthesis,
      reasoning: { effort: config.reasoningEffort },
      instructions: SYNTHESIZE_SYSTEM,
      input: JSON.stringify({ graph: synthesisGraph(session), transcript: session.transcript }),
    }, { signal: sessionJobs.signal(session.id) });
    const text = response.output_text?.trim();
    if (!text) throw new SessionOperationError("The synthesis was empty. Please try again.", { code: "empty_synthesis", status: 502 });
    // A synthesis started later read a newer map or transcript and may finish
    // first; never replace it with this older result.
    const saved = await store.transact(session.id, (current) => {
      if ((savedSynthesisOrder.get(session.id) ?? 0) > order || current.synthesis?.revision > session.revision) return current;
      savedSynthesisOrder.set(session.id, order);
      return { ...current, synthesis: { text, revision: session.revision, created_at: new Date().toISOString() } };
    });
    const snapshot = await publishMapControllerSnapshot(session.id, saved);
    return { synthesis: saved.synthesis.text, revision: saved.synthesis.revision, snapshot };
  };

  app.locals.sessionStore = store;
  app.locals.mapController = mapController;
  app.locals.mapControllerScheduler = mapControllerScheduler;
  if (curator) app.locals.curator = curator;
  if (curatorScheduler) app.locals.curatorScheduler = curatorScheduler;
  app.locals.dispose = () => {
    sessionJobs.dispose();
    liveService?.dispose?.();
    mapControllerScheduler?.dispose();
    curatorScheduler?.dispose();
    eventClients.forEach((listeners) => listeners.forEach((response) => {
      sseWriter.cleanup(response);
      response.end();
    }));
    eventClients.clear();
  };
  return app;
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntrypoint) {
  const config = resolveServerConfig(process.env);
  const app = await createThoughtformServer({ env: process.env });
  const server = app.listen(config.port, "127.0.0.1", () => {
    const { models, reasoningEffort, apiKey } = config;
    console.log(`thoughtform server on http://localhost:${config.port} (${apiKey
      ? `live: ${models.live}, backend: ${models.liveBackend} / ${reasoningEffort}`
      : "no OPENAI_API_KEY: editing only, model features unavailable"})`);
  });
  const shutdown = () => {
    app.locals.dispose?.();
    server.close(() => process.exit(0));
    server.closeAllConnections?.();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
