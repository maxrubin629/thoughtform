import { RevisionConflictError, SessionOperationError } from "./sessionOperations.mjs";
import { sessionMarkdown } from "./sessionExport.mjs";
const SYNTHESIZE_SYSTEM = `You write the working synthesis panel for Thoughtform, a mind-mapping canvas.
You receive the user's full thought graph as JSON. Write a short synthesis (2-4 sentences, one
paragraph, plain prose) of what the map is currently saying: the central idea, the strongest
branches, and any tension or open question visible in the structure. Address the map's content
directly; never describe the app or the graph format.`;

export function registerSessionRoutes(app, { workspace, jsonRoute, openaiClient, env }) {
  const {
    store, snapshotFor, performOperation, updatePreferences, recoverMapController,
    mapControllerScheduler, publishMapControllerSnapshot,
  } = workspace;

  app.patch("/api/sessions/:id/preferences", jsonRoute((req) => updatePreferences(req.params.id, req.body)));

  app.get("/api/sessions/:id/export", jsonRoute(async (req, res) => {
    const session = await store.get(req.params.id);
    const markdown = req.query.format === "markdown";
    res.set("Content-Disposition", `attachment; filename="thoughtform-${session.id}.${markdown ? "md" : "json"}"`);
    res.type(markdown ? "text/markdown" : "application/json").send(markdown ? sessionMarkdown(session) : JSON.stringify(session, null, 2));
  }));

  app.get("/api/sessions", jsonRoute(() => store.list()));

  app.post("/api/sessions", jsonRoute(async (req) => (
    snapshotFor(await store.create({ title: req.body?.title }))
  )));

  app.get("/api/sessions/:id", jsonRoute(async (req) => {
    const session = await store.get(req.params.id);
    await store.setActive(session.id);
    recoverMapController(session);
    return snapshotFor(session);
  }));

  app.patch("/api/sessions/:id", jsonRoute(async (req) => (
    snapshotFor(await store.rename(req.params.id, req.body?.title))
  )));

  app.delete("/api/sessions/:id", jsonRoute((req) => workspace.deleteSession(req.params.id)));

  app.patch("/api/sessions/:id/ui-context", jsonRoute(async (req) => {
    const session = await store.get(req.params.id);
    const context = workspace.setUiContext(session, req.body);
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
      const snapshot = await workspace.onTranscriptCommitted(req.params.id, result.snapshot.transcript.at(-1));
      if (snapshot) result.snapshot = snapshot;
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

  app.get("/api/sessions/:id/events", workspace.events.attach);

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
    const response = await openaiClient.responses.create({
      model: env.OPENAI_MODEL ?? "gpt-5.6-terra",
      reasoning: { effort: "medium" },
      instructions: SYNTHESIZE_SYSTEM,
      input: JSON.stringify({ graph: { thoughts: session.nodes, connections: session.edges }, transcript: session.transcript }),
    });
    const text = response.output_text?.trim();
    if (!text) throw new SessionOperationError("The synthesis was empty. Please try again.", { code: "empty_synthesis", status: 502 });
    const saved = await store.transact(session.id, (current) => ({
      ...current,
      synthesis: { text, revision: session.revision, created_at: new Date().toISOString() },
    }));
    const snapshot = await publishMapControllerSnapshot(session.id, saved);
    return { synthesis: text, revision: session.revision, snapshot };
  }));

}
