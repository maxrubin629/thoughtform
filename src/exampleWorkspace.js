import { createExampleStore } from "./exampleStore.js";
import { createExampleSession } from "./exampleSession.js";
import { createEmptySession, validateSession, SessionNotFoundError } from "../shared/sessionSchema.mjs";
import { applyOperation } from "../shared/sessionOperations.mjs";
import { sessionSnapshot } from "../shared/sessionSnapshot.mjs";
import { sessionMarkdown } from "../shared/sessionExport.mjs";
import { saveSessionDownload } from "./workspaceApi.js";

export function createExampleWorkspace({ store = createExampleStore(), channel = typeof BroadcastChannel === "function" ? new BroadcastChannel("thoughtform-example-v1") : null } = {}) {
  const listeners = new Map();
  const contexts = new Map();
  const epoch = Date.now();
  let sequence = 0;
  const project = session => sessionSnapshot(session, { uiContext: contexts.get(session.id), controllerEventEpoch: epoch, controllerEventSequence: ++sequence });
  const sessionFrom = (state, id) => {
    const session = state.sessions[id];
    if (!session || session.id !== id) throw new SessionNotFoundError(id);
    return validateSession(session);
  };
  const summaries = state => ({
    active_session_id: state.active_session_id,
    sessions: Object.values(state.sessions).map(session => ({ id: session.id, title: session.title, revision: session.revision, thought_count: session.nodes.length, updated_at: session.updated_at })).sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
  });
  const notify = async (id, broadcast = true) => {
    if (broadcast) channel?.postMessage({ id });
    try {
      const snapshot = await store.read(state => project(sessionFrom(state, id)));
      for (const handler of listeners.get(id) ?? []) { handler.onOpen?.(); handler.onSnapshot?.(snapshot); }
    } catch (error) { for (const handler of listeners.get(id) ?? []) handler.onError?.(error); }
  };
  if (channel) channel.onmessage = event => { if (typeof event.data?.id === "string") void notify(event.data.id, false); };
  const writeSession = async (id, transform) => {
    const result = await store.write(state => {
      const current = sessionFrom(state, id);
      const outcome = transform(current);
      const next = outcome.session ?? outcome;
      validateSession(next);
      state.sessions[id] = next;
      return { ...outcome, snapshot: project(next) };
    });
    await notify(id);
    return result;
  };
  const unavailable = async () => { throw new Error("Live voice and AI are off in this example. You can edit the map, review sources, and try the saved suggestion."); };
  const exportSession = (id, format = "json") => store.read(state => {
    const session = sessionFrom(state, id);
    return { text: format === "markdown" ? sessionMarkdown(session) : JSON.stringify(session, null, 2), filename: `thoughtform-${id}.${format === "markdown" ? "md" : "json"}`, type: format === "markdown" ? "text/markdown" : "application/json" };
  });

  return {
    example: true,
    async bootstrap() {
      return store.write(state => {
        let session = state.sessions[state.active_session_id] ?? Object.values(state.sessions)[0];
        if (!session) { session = createExampleSession(); state.sessions[session.id] = session; }
        validateSession(session);
        state.active_session_id = session.id;
        return { listed: summaries(state), snapshot: project(session) };
      });
    },
    listSessions: () => store.read(summaries),
    getSession: id => store.write(state => { const session = sessionFrom(state, id); state.active_session_id = id; return project(session); }),
    async createSession({ title } = {}) {
      return store.write(state => {
        const session = createEmptySession({ id: `example_${crypto.randomUUID()}`, title });
        state.sessions[session.id] = session; state.active_session_id = session.id;
        return project(session);
      });
    },
    async createExample() {
      return store.write(state => {
        const session = createExampleSession();
        state.sessions[session.id] = session; state.active_session_id = session.id;
        return project(session);
      });
    },
    async importSession(input) {
      const session = structuredClone(validateSession(input));
      session.id = `example_${crypto.randomUUID()}`;
      return store.write(state => {
        state.sessions[session.id] = session; state.active_session_id = session.id;
        return project(session);
      });
    },
    renameSession: (id, title) => writeSession(id, session => {
      if (typeof title !== "string" || !title.trim()) throw new Error("Map name cannot be empty.");
      return { ...session, title: title.trim(), updated_at: new Date().toISOString() };
    }),
    async deleteSession(id) {
      await store.write(state => {
        sessionFrom(state, id); delete state.sessions[id];
        if (state.active_session_id === id) state.active_session_id = Object.keys(state.sessions)[0] ?? null;
      });
      await notify(id);
      return { deleted: true, id };
    },
    updateSessionUiContext: async (id, context) => { contexts.set(id, structuredClone(context)); return { ok: true }; },
    applySessionOperation: (id, operation, { expectedRevision, callId, actor = "you" } = {}) => writeSession(id, session => {
      const request = { ...operation, actor, origin: "ui", expected_revision: expectedRevision, ...(callId ? { call_id: callId } : {}) };
      try { return applyOperation(session, request, { requireExpectedRevision: true, selection: contexts.get(id) }); }
      catch (error) {
        // Same single rebase as the HTTP client; the reducer still validates targets.
        if (error.code !== "revision_conflict" || !Number.isInteger(expectedRevision)) throw error;
        return applyOperation(session, { ...request, expected_revision: session.revision }, { requireExpectedRevision: true, selection: contexts.get(id) });
      }
    }),
    updateWorkspacePreferences: (id, patch) => writeSession(id, session => ({ ...session, preferences: { ...session.preferences, ...patch } })),
    subscribeSessionEvents(id, handlers) {
      const set = listeners.get(id) ?? new Set(); set.add(handlers); listeners.set(id, set);
      handlers.onOpen?.();
      void notify(id, false);
      return () => { set.delete(handlers); if (!set.size) listeners.delete(id); };
    },
    exportSession,
    async downloadSessionExport(id, format) { const file = await exportSession(id, format); saveSessionDownload(new Blob([file.text], { type: file.type }), file.filename); },
    sendSessionChat: unavailable, retryLiveCapture: unavailable, retrySessionMapController: unavailable, synthesizeSession: unavailable,
    async dispose() { channel?.close(); listeners.clear(); await store.close(); },
  };
}
