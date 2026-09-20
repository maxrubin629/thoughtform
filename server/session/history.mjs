import { validateSession } from "../sessionSchema.mjs";
import {
  SPEAKERS, SAFE_ID, SessionOperationError, actorOf, originOf, allocateId, textField,
} from "./operationInput.mjs";
import { operationProvenance } from "./provenance.mjs";

export function currentHistory(session) {
  const latest = session.operations.findLast((operation) => Array.isArray(operation.history_entry_ids));
  if (latest) return [...latest.history_entry_ids];
  return session.operations.filter((operation) => operation.undoable).map(({ id }) => id);
}

export function graphState(session) {
  return structuredClone({ nodes: session.nodes, edges: session.edges });
}

export function entityChanges(before, after) {
  const prior = new Map(before.map((value, index) => [value.id, { value, index }]));
  const next = new Map(after.map((value, index) => [value.id, { value, index }]));
  return [...new Set([...prior.keys(), ...next.keys()])]
    .filter((id) => JSON.stringify(prior.get(id)?.value) !== JSON.stringify(next.get(id)?.value))
    .map((id) => ({
      id,
      before: prior.has(id) ? structuredClone(prior.get(id).value) : null,
      after: next.has(id) ? structuredClone(next.get(id).value) : null,
      before_index: prior.get(id)?.index ?? null,
      after_index: next.get(id)?.index ?? null,
    }));
}

function restoreEntityChanges(values, changes, direction) {
  const indexField = direction === "before" ? "before_index" : "after_index";
  const restored = [...values];
  for (const change of changes ?? []) {
    const currentIndex = restored.findIndex(({ id }) => id === change.id);
    if (currentIndex >= 0) restored.splice(currentIndex, 1);
    const value = change[direction];
    if (value !== null) {
      const targetIndex = Math.min(change[indexField] ?? restored.length, restored.length);
      restored.splice(targetIndex, 0, structuredClone(value));
    }
  }
  return restored;
}

function restoreProposalChanges(session, changes, direction) {
  for (const change of changes ?? []) {
    const value = change[direction];
    const index = session.proposals.findIndex(({ id }) => id === change.id);
    if (value === null) {
      if (index >= 0) session.proposals.splice(index, 1);
    } else if (index >= 0) {
      session.proposals[index] = structuredClone(value);
    } else {
      session.proposals.push(structuredClone(value));
    }
  }
}

function restoreHistoryChange(session, record, direction) {
  const legacyState = record.change?.[direction];
  const hasDelta = Array.isArray(record.change?.nodes) && Array.isArray(record.change?.edges);
  if (!legacyState && !hasDelta) {
    throw new SessionOperationError("The history entry cannot be restored.", {
      code: "invalid_history_entry",
      status: 500,
      details: { operation_id: record.id },
    });
  }
  if (legacyState) {
    session.nodes = structuredClone(legacyState.nodes);
    session.edges = structuredClone(legacyState.edges);
  } else {
    session.nodes = restoreEntityChanges(session.nodes, record.change.nodes, direction);
    session.edges = restoreEntityChanges(session.edges, record.change.edges, direction);
  }
  restoreProposalChanges(session, record.change.proposals, direction);
}

export function findReplay(session, operation) {
  if (operation.call_id) {
    return session.operations.find((record) => record.call_id === operation.call_id) ?? null;
  }
  return null;
}

export function replayResult(session, record) {
  return {
    session: structuredClone(session),
    operation_id: record.id,
    revision: session.revision,
    affected_ids: structuredClone(record.affected_ids ?? []),
    warnings: [...(record.warnings ?? []), "Duplicate call_id replayed without applying another change."],
    replayed: true,
  };
}

function appendRecord(session, record, history) {
  for (const operation of session.operations) delete operation.history_entry_ids;
  session.operations.push({ ...record, history_entry_ids: [...history] });
}

export function finalizeResult(session, operationId, affected, warnings, extra = {}) {
  validateSession(session);
  return {
    session: structuredClone(session),
    operation_id: operationId,
    revision: session.revision,
    affected_ids: [...new Set(affected)],
    warnings,
    replayed: false,
    ...extra,
  };
}

export function transcriptOperation(session, operation, context) {
  const realtimeItemId = operation.realtime_item_id;
  if (realtimeItemId) {
    const existing = session.transcript.find((utterance) => utterance.realtime_item_id === realtimeItemId);
    if (existing) {
      const record = session.operations.findLast((candidate) => (
        candidate.type === "append_utterance" && candidate.realtime_item_id === realtimeItemId
      ));
      return {
        session: structuredClone(session),
        operation_id: record?.id ?? null,
        revision: session.revision,
        affected_ids: [existing.id],
        warnings: ["Realtime transcript item was already committed."],
        replayed: true,
      };
    }
  }
  const speaker = operation.speaker ?? (operation.actor === "you" ? "you" : "partner");
  if (!SPEAKERS.has(speaker)) {
    throw new SessionOperationError("speaker must be you or partner.", { code: "invalid_speaker" });
  }
  const text = textField(operation.text, "text");
  const utteranceId = operation.utterance_id ?? allocateId(session, "utterance", context, context.reservedIds);
  if (!SAFE_ID.test(String(utteranceId)) || session.transcript.some(({ id }) => id === utteranceId)) {
    throw new SessionOperationError("The utterance ID is invalid or already exists.", {
      code: "duplicate_utterance_id",
      status: 409,
    });
  }
  const completedAt = operation.completed_at ?? context.timestamp;
  if (Number.isNaN(Date.parse(completedAt))) {
    throw new SessionOperationError("completed_at must be an ISO-compatible timestamp.", {
      code: "invalid_completed_at",
    });
  }
  const utterance = {
    id: utteranceId,
    ...(realtimeItemId ? { realtime_item_id: textField(realtimeItemId, "realtime_item_id") } : {}),
    speaker,
    text,
    completed_at: new Date(completedAt).toISOString(),
  };
  session.transcript.push(utterance);
  const operationId = allocateId(session, "operation", context, context.reservedIds);
  const history = currentHistory(session);
  appendRecord(session, {
    id: operationId,
    type: "append_utterance",
    actor: speaker,
    origin: originOf(operation),
    created_at: context.timestamp,
    ...(operation.call_id ? { call_id: operation.call_id } : {}),
    ...(realtimeItemId ? { realtime_item_id: realtimeItemId } : {}),
    utterance_id: utteranceId,
    base_revision: session.revision,
    result_revision: session.revision,
    affected_ids: [utteranceId],
    warnings: [],
    undoable: false,
    source_utterance_ids: [utteranceId],
    ...(realtimeItemId ? { source_realtime_item_id: realtimeItemId } : {}),
  }, history);
  session.updated_at = context.timestamp;
  return finalizeResult(session, operationId, [utteranceId], []);
}

export function operationResultRecord({ operationId, type, actor, operation, timestamp, baseRevision, session, affected, warnings, undoable, change, history }) {
  const label = typeof operation.label === "string" && operation.label.trim()
    ? operation.label.trim()
    : (type === "set_node_pinned"
      ? (operation.pinned ? "Pinned a bubble" : "Unpinned a bubble")
      : (type === "set_node_parked" ? (operation.parked ? "Kept a thought aside" : "Returned a thought to focus") : null));
  const record = {
    id: operationId,
    type,
    actor,
    origin: originOf(operation),
    created_at: timestamp,
    ...(operation.call_id ? { call_id: textField(operation.call_id, "call_id") } : {}),
    base_revision: baseRevision,
    result_revision: session.revision,
    affected_ids: [...new Set(affected)],
    warnings: [...warnings],
    undoable,
    ...(label ? { label } : {}),
    ...(change ? { change } : {}),
    ...operationProvenance(session, operation),
  };
  appendRecord(session, record, history);
}

export function undoOrRedo(session, operation, context, direction) {
  const history = currentHistory(session);
  const undo = direction === "undo";
  const available = undo
    ? session.history_cursor > 0
    : session.history_cursor < history.length;
  const operationId = allocateId(session, "operation", context, context.reservedIds);
  const actor = actorOf(operation);
  const baseRevision = session.revision;
  const warnings = [];
  const affected = [];
  let target = null;
  if (available) {
    const targetId = history[undo ? session.history_cursor - 1 : session.history_cursor];
    target = session.operations.find((record) => record.id === targetId);
    if (!target?.undoable) {
      throw new SessionOperationError("The map history is inconsistent.", {
        code: "invalid_history_cursor",
        status: 500,
        details: { target_operation_id: targetId },
      });
    }
    restoreHistoryChange(session, target, undo ? "before" : "after");
    session.history_cursor += undo ? -1 : 1;
    affected.push(...(target.affected_ids ?? []));
  } else {
    warnings.push(undo ? "There is no map change to undo." : "There is no map change to redo.");
  }
  session.revision += 1;
  session.updated_at = context.timestamp;
  operationResultRecord({
    operationId,
    type: undo ? "undo_map_change" : "redo_map_change",
    actor,
    operation,
    timestamp: context.timestamp,
    baseRevision,
    session,
    affected,
    warnings,
    undoable: false,
    history,
  });
  const record = session.operations.at(-1);
  if (target) record.target_operation_id = target.id;
  return finalizeResult(session, operationId, affected, warnings, {
    target_operation_id: target?.id ?? null,
  });
}

