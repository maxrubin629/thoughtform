import { applyOperation, SessionOperationError } from "./sessionOperations.mjs";
import { createMapController, createMapControllerScheduler } from "./mapController.mjs";
import { createCurator, createCuratorScheduler, isCuratorEnabled } from "./curator.mjs";
import { createSessionEvents } from "./sessionEvents.mjs";

function normalizeContext(session, value) {
  const context = value ?? {};
  const nodeIds = new Set(session.nodes.map(({ id }) => id));
  return {
    selected_node_ids: [...new Set((Array.isArray(context.selected_node_ids) ? context.selected_node_ids : []).filter((id) => nodeIds.has(id)))],
    selected_proposal_id: session.proposals.some((proposal) => proposal.id === context.selected_proposal_id && ["pending", "stale"].includes(proposal.status)) ? context.selected_proposal_id : null,
    focus_id: nodeIds.has(context.focus_id) ? context.focus_id : null,
    view_mode: context.view_mode === "hierarchy" ? "hierarchy" : "clusters",
    voice_mode: context.voice_mode === "push-to-talk" ? "push-to-talk" : "vad",
  };
}

export async function createWorkspaceRuntime({
  store,
  openaiClient = null,
  env = process.env,
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
  await store.init();
  const uiContexts = new Map();
  const controllerEventSequences = new Map();
  const controllerConfigured = Boolean(openaiClient ?? env.OPENAI_API_KEY);
  const controllerRequested = env.THOUGHTFORM_MAP_CONTROLLER_ENABLED !== "false";
  const controllerRuntimeEnabled = controllerRequested && (
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
    const context = normalizeContext(session, uiContexts.get(session.id));
    uiContexts.set(session.id, context);
    const history = session.operations.findLast((operation) => Array.isArray(operation.history_entry_ids))?.history_entry_ids ?? [];
    const operations = session.operations.map(({ change: _change, history_entry_ids: _history, ...record }) => record);
    const labelFor = (id) => {
      const operation = operations.find((entry) => entry.id === id);
      if (!operation) return null;
      return operation.label || ({
        create_bubble: "Add thought", edit_bubble: "Edit thought", move_bubble: "Move thought",
        delete_bubble: "Remove thought", connect_bubbles: "Connect thoughts", delete_connection: "Remove connection",
        apply_map_batch: "Partner’s latest interpretation", accept_proposal: "Accept suggestion",
        set_node_pinned: "Change pinned position", set_node_parked: "Keep thought aside",
      }[operation.type] ?? "Latest map change");
    };
    const { transcript_fragments = [], live_capture, ...publicSession } = session;
    return {
      ...publicSession,
      preferences: session.preferences ?? { mapping_paused: false, partner_mode: "proactive" },
      synthesis: session.synthesis ?? null,
      capture_status: {
        pending_fragments: Math.max(0, transcript_fragments.length - (live_capture?.consumed_fragment_ids?.length ?? 0)),
        last_error: live_capture?.last_error ?? null,
      },
      controller_event_epoch: controllerEventEpoch,
      controller_event_sequence: controllerEventSequenceFor(session.id),
      map_controller: {
        ...session.map_controller,
        status: mapControllerStatusFor(session),
      },
      operations,
      history_length: history.length,
      undo_label: labelFor(history[session.history_cursor - 1]),
      redo_label: labelFor(history[session.history_cursor]),
      ui_context: context,
    };
  };

  const events = createSessionEvents({ store, snapshotFor });
  const { publish } = events;

  const performOperation = async (sessionId, operation) => {
    const { session, ...result } = await store.transact(sessionId, (current) => applyOperation(current, operation, {
      selection: uiContexts.get(sessionId),
      requireExpectedRevision: true,
    }));
    const snapshot = snapshotFor(session);
    publish(session, operation.type === "append_utterance" ? "transcript" : "operation", {
      operation_id: result.operation_id,
    }, snapshot);
    return { ok: true, ...result, snapshot };
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
    && isCuratorEnabled(env)
    && (controllerConfigured || suppliedCurator || suppliedCuratorScheduler),
  );
  if (curatorRuntimeEnabled) {
    curator = suppliedCurator ?? curatorFactory({
      env,
      client: openaiClient ?? undefined,
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

  const onTranscriptCommitted = async (sessionId, utterance) => {
    if (mapControllerScheduler?.notify(sessionId, utterance)) return publishMapControllerSnapshot(sessionId);
    return null;
  };

  return {
    store, snapshotFor, publish, performOperation, updatePreferences, events,
    controllerConfigured, mapController, mapControllerScheduler, curator, curatorScheduler,
    recoverMapController, publishMapControllerSnapshot, onTranscriptCommitted,
    getUiContext: (sessionId) => uiContexts.get(sessionId) ?? {},
    setUiContext(session, value) {
      const context = normalizeContext(session, value);
      uiContexts.set(session.id, context);
      return context;
    },
    async deleteSession(sessionId) {
      mapControllerScheduler?.cancel(sessionId);
      curatorScheduler?.cancel(sessionId);
      uiContexts.delete(sessionId);
      controllerEventSequences.delete(sessionId);
      events.close(sessionId);
      return store.delete(sessionId);
    },
    dispose() {
      mapControllerScheduler?.dispose();
      curatorScheduler?.dispose();
      events.dispose();
    },
  };
}
