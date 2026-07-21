import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import OpenAI from "openai";
import {
  COMPANION_SCHEMA,
  COMPANION_SYSTEM,
  DICTATE_SYSTEM,
  DICTATION_SCHEMA,
  PROPOSAL_SCHEMA,
  PROPOSE_SYSTEM,
  SYNTHESIZE_SYSTEM,
} from "./prompts.mjs";
import { createSessionStore } from "./sessionStore.mjs";
import {
  RevisionConflictError,
  SessionOperationError,
  applyOperation,
} from "./sessionOperations.mjs";
import {
  DEFAULT_REALTIME_MODEL,
  buildRealtimeInstructions,
  buildRealtimeSessionConfig,
  forwardRealtimeSdp,
} from "./realtime.mjs";
import { createCurator, createCuratorScheduler } from "./curator.mjs";

const PORT = Number(process.env.PORT ?? 8787);
const MODEL = process.env.OPENAI_MODEL ?? "gpt-5.6";
const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL ?? DEFAULT_REALTIME_MODEL;
const hasKey = Boolean(process.env.OPENAI_API_KEY);
const client = hasKey ? new OpenAI() : null;

const asJsonSchema = (name, schema) => ({
  format: { type: "json_schema", name, strict: true, schema },
});

async function structuredCall({ system, payload, schemaName, schema }) {
  const response = await client.responses.create({
    model: MODEL,
    reasoning: { effort: "low" },
    instructions: system,
    input: JSON.stringify(payload),
    text: asJsonSchema(schemaName, schema),
  });
  return JSON.parse(response.output_text);
}

function classicGraphFromSession(session) {
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
  const details = error?.details ?? {};
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

export async function createThoughtformServer({
  store = createSessionStore(),
  openaiClient = client,
  fetchImpl = globalThis.fetch,
} = {}) {
  await store.init();
  const app = express();
  const uiContexts = new Map();
  const eventClients = new Map();

  const snapshotFor = (session) => {
    const nodeIds = new Set(session.nodes.map((node) => node.id));
    const storedContext = uiContexts.get(session.id) ?? {
      selected_node_ids: [],
      focus_id: null,
      view_mode: "clusters",
      voice_mode: "vad",
    };
    const context = {
      ...storedContext,
      selected_node_ids: (storedContext.selected_node_ids ?? []).filter((id) => nodeIds.has(id)),
      focus_id: nodeIds.has(storedContext.focus_id) ? storedContext.focus_id : null,
    };
    uiContexts.set(session.id, context);
    return { ...session, ui_context: context };
  };

  const publish = (session, event = "snapshot", detail = {}) => {
    const listeners = eventClients.get(session.id);
    if (!listeners?.size) return;
    const payload = JSON.stringify({ type: event, snapshot: snapshotFor(session), ...detail });
    listeners.forEach((response) => response.write(`event: ${event}\ndata: ${payload}\n\n`));
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

  const curator = createCurator({ client: openaiClient ?? undefined });
  const curatorScheduler = createCuratorScheduler({
    curator,
    loadSnapshot: (sessionId) => store.get(sessionId),
    onProposal: async (sessionId, proposal) => {
      const current = await store.get(sessionId);
      if (current.proposals.some((candidate) => candidate.status === "pending")) return;
      await performOperation(sessionId, {
        type: "propose_changes",
        actor: "curator",
        expected_revision: current.revision,
        proposal_id: proposal.id,
        base_revision: proposal.base_revision,
        rationale: proposal.rationale,
        evidence: proposal.evidence,
        operations: proposal.operations,
      });
    },
  });

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
      const status = error?.status ?? (error instanceof RevisionConflictError ? 409 : 500);
      let snapshot = error?.snapshot ?? error?.details?.snapshot ?? null;
      if (!snapshot && req.params?.id) {
        snapshot = await store.get(req.params.id).catch(() => null);
      }
      if (snapshot) snapshot = snapshotFor(snapshot);
      if (status >= 500) console.error(error);
      const payload = errorPayload(error, snapshot);
      if (req.originalUrl?.endsWith("/tool-calls") && req.body?.call_id) {
        payload.function_call_output = {
          type: "function_call_output",
          call_id: req.body.call_id,
          output: JSON.stringify(payload),
        };
      }
      res.status(status).json(payload);
    }
  };

  app.get("/api/health", (req, res) => {
    res.json({
      ok: true,
      model: MODEL,
      mock: !hasKey,
      realtime: { configured: hasKey, model: REALTIME_MODEL },
      curator: { enabled: curator.enabled, model: curator.model },
    });
  });

  app.get("/api/sessions", jsonRoute(() => store.list()));

  app.post("/api/sessions", jsonRoute(async (req) => (
    snapshotFor(await store.create({ title: req.body?.title }))
  )));

  app.get("/api/sessions/:id", jsonRoute(async (req) => {
    const session = await store.get(req.params.id);
    await store.setActive(session.id);
    return snapshotFor(session);
  }));

  app.patch("/api/sessions/:id", jsonRoute(async (req) => (
    snapshotFor(await store.rename(req.params.id, req.body?.title))
  )));

  app.delete("/api/sessions/:id", jsonRoute(async (req) => {
    curatorScheduler.cancel(req.params.id);
    uiContexts.delete(req.params.id);
    const listeners = eventClients.get(req.params.id);
    listeners?.forEach((response) => response.end());
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
    if (operation.type === "append_utterance" && operation.speaker === "you") {
      curatorScheduler.notify(req.params.id);
    }
    return result;
  }));

  app.post("/api/sessions/:id/tool-calls", jsonRoute(async (req) => {
    const { name, call_id: callId } = req.body ?? {};
    if (typeof name !== "string" || !name) {
      throw new SessionOperationError("Tool name is required.", { code: "missing_tool_name" });
    }
    if (typeof callId !== "string" || !callId.trim()) {
      throw new SessionOperationError("Realtime tool call_id is required.", { code: "missing_call_id" });
    }
    const session = await store.get(req.params.id);
    if (name === "get_map") {
      const payload = {
        ok: true,
        operation_id: null,
        revision: session.revision,
        affected_ids: [],
        warnings: [],
        snapshot: snapshotFor(session),
      };
      return {
        ...payload,
        function_call_output: {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify(payload),
        },
      };
    }
    const args = req.body?.arguments && typeof req.body.arguments === "object" ? req.body.arguments : {};
    const operation = {
      ...args,
      type: name,
      actor: "partner",
      call_id: callId,
      // The model's tool argument describes the snapshot it reasoned from. A
      // newer browser revision must never silently upgrade that stale intent.
      expected_revision: args.expected_revision ?? req.body?.expected_revision,
    };
    const payload = await performOperation(req.params.id, operation);
    return {
      ...payload,
      function_call_output: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(payload),
      },
    };
  }));

  app.get("/api/sessions/:id/events", async (req, res) => {
    try {
      const session = await store.get(req.params.id);
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
      res.write(`event: connected\ndata: ${JSON.stringify({ type: "connected", revision: session.revision })}\n\n`);
      res.write(`event: snapshot\ndata: ${JSON.stringify({ type: "snapshot", snapshot: snapshotFor(session) })}\n\n`);
      const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 20_000);
      req.on("close", () => {
        clearInterval(heartbeat);
        listeners.delete(res);
        if (!listeners.size) eventClients.delete(session.id);
      });
    } catch (error) {
      res.status(error?.status ?? 500).json(errorPayload(error));
    }
  });

  app.post(
    "/api/sessions/:id/realtime",
    express.text({ type: "application/sdp", limit: "1mb" }),
    async (req, res) => {
      try {
        const session = await store.get(req.params.id);
        await store.setActive(session.id);
        const voiceMode = req.query.voice_mode === "push-to-talk" ? "push-to-talk" : "vad";
        const sessionConfig = buildRealtimeSessionConfig({
          model: REALTIME_MODEL,
          voiceMode,
          instructions: buildRealtimeInstructions({ sessionTitle: session.title }),
        });
        const safetyIdentifier = createHash("sha256").update(`thoughtform:${session.id}`).digest("hex");
        const answer = await forwardRealtimeSdp({
          sdp: req.body,
          fetchImpl,
          sessionConfig,
          safetyIdentifier,
        });
        res.status(201).type("application/sdp").send(answer);
      } catch (error) {
        const status = hasKey ? (error?.status ?? 502) : 503;
        if (status >= 500) console.error(error);
        res.status(status).json(errorPayload(error));
      }
    },
  );

  app.post("/api/sessions/:id/synthesize", jsonRoute(async (req) => {
    const session = await store.get(req.params.id);
    const expected = req.body?.expected_revision;
    if (expected !== undefined && Number(expected) !== session.revision) {
      throw new RevisionConflictError(Number(expected), session);
    }
    if (!session.nodes.length) {
      throw new SessionOperationError("Add at least one bubble before synthesizing.", { code: "empty_map" });
    }
    if (!hasKey) {
      return { synthesis: `Offline mock synthesis of ${session.nodes.length} thoughts — set OPENAI_API_KEY to enable ${MODEL}.`, revision: session.revision };
    }
    const response = await openaiClient.responses.create({
      model: MODEL,
      reasoning: { effort: "low" },
      instructions: SYNTHESIZE_SYSTEM,
      input: JSON.stringify({ graph: classicGraphFromSession(session), transcript: session.transcript }),
    });
    return { synthesis: response.output_text.trim(), revision: session.revision };
  }));

  // Classic-mode endpoints remain unchanged and continue to operate on the
  // browser-owned graph at ?mode=classic.
  app.post("/api/propose", jsonRoute(async (req) => {
    const { graph, prompt, selectedId } = req.body ?? {};
    if (!graph?.thoughts?.length || !prompt) throw new Error("propose needs { graph, prompt }");
    if (!hasKey) {
      const parent = graph.thoughts.find((thought) => thought.id === selectedId) ?? graph.thoughts[0];
      return { proposals: [{ parent_id: parent.id, text: `Mock proposal for “${prompt.slice(0, 32)}”`, reason: "offline mock — set OPENAI_API_KEY" }] };
    }
    const { proposals } = await structuredCall({ system: PROPOSE_SYSTEM, payload: { graph, selected_id: selectedId, request: prompt }, schemaName: "proposals", schema: PROPOSAL_SCHEMA });
    const validIds = new Set(graph.thoughts.map((thought) => thought.id));
    return { proposals: proposals.filter((proposal) => validIds.has(proposal.parent_id) && proposal.text?.trim()).slice(0, 3) };
  }));

  app.post("/api/dictate", jsonRoute(async (req) => {
    const { transcript } = req.body ?? {};
    if (!transcript?.trim()) throw new Error("dictate needs { transcript }");
    if (!hasKey) return { thought: transcript.trim() };
    const { thought } = await structuredCall({ system: DICTATE_SYSTEM, payload: { transcript }, schemaName: "dictation", schema: DICTATION_SCHEMA });
    return { thought };
  }));

  app.post("/api/companion", jsonRoute(async (req) => {
    const { graph } = req.body ?? {};
    if (!graph?.thoughts?.length) throw new Error("companion needs { graph }");
    if (!hasKey) return { line: "Keep going, this is getting interesting…", followup: "What if we explored the flow a bit more?" };
    return structuredCall({ system: COMPANION_SYSTEM, payload: { graph }, schemaName: "companion", schema: COMPANION_SCHEMA });
  }));

  app.post("/api/synthesize", jsonRoute(async (req) => {
    const { graph } = req.body ?? {};
    if (!graph?.thoughts?.length) throw new Error("synthesize needs { graph }");
    if (!hasKey) return { synthesis: `Offline mock synthesis of ${graph.thoughts.length} thoughts — set OPENAI_API_KEY to enable ${MODEL}.` };
    const response = await openaiClient.responses.create({ model: MODEL, reasoning: { effort: "low" }, instructions: SYNTHESIZE_SYSTEM, input: JSON.stringify({ graph }) });
    return { synthesis: response.output_text.trim() };
  }));

  app.locals.sessionStore = store;
  app.locals.curatorScheduler = curatorScheduler;
  app.locals.dispose = () => curatorScheduler.dispose();
  return app;
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntrypoint) {
  const app = await createThoughtformServer();
  const server = app.listen(PORT, "127.0.0.1", () => {
    console.log(`thoughtform server on http://localhost:${PORT} (model: ${MODEL}${hasKey ? `, realtime: ${REALTIME_MODEL}` : ", MOCK MODE — no OPENAI_API_KEY"})`);
  });
  const shutdown = () => {
    app.locals.dispose?.();
    server.close(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
