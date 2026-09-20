import { validateSession } from "./sessionSchema.mjs";
import {
  SessionOperationError, RevisionConflictError, TranscriptPendingError,
  canonicalType, nonnegativeInteger, isoNow, actorOf, allocateId,
} from "./session/operationInput.mjs";
import { mutateGraph } from "./session/graph.mjs";
import { proposeChanges, excludeProposalOperation, dismissProposal, acceptProposal } from "./session/proposals.mjs";
import {
  currentHistory, graphState, entityChanges, findReplay, replayResult,
  finalizeResult, transcriptOperation, operationResultRecord, undoOrRedo,
} from "./session/history.mjs";

export { SessionOperationError, RevisionConflictError, TranscriptPendingError, resolveNodeReference } from "./session/operationInput.mjs";
export { resolveQuoteSpan } from "./session/provenance.mjs";
export { validateProposal } from "./session/proposals.mjs";

// Proposal edits change the review layer; only acceptance joins map undo history.
const PROPOSAL_ACTIONS = new Map([
  ["propose_changes", { apply: proposeChanges, undoable: false }],
  ["exclude_proposal_operation", { apply: excludeProposalOperation, undoable: false }],
  ["dismiss_proposal", { apply: dismissProposal, undoable: false }],
  ["accept_proposal", { apply: acceptProposal, undoable: true }],
]);
const DIRECT_ACTIONS = new Map([
  ["append_utterance", transcriptOperation],
  ["undo_map_change", (session, operation, context) => undoOrRedo(session, operation, context, "undo")],
  ["redo_map_change", (session, operation, context) => undoOrRedo(session, operation, context, "redo")],
]);

/**
 * Apply one canonical operation to an immutable session snapshot.
 *
 * The returned session is a deep clone; the caller may atomically persist it.
 * `expected_revision` is checked before any work unless this is an idempotent
 * replay. Set `options.requireExpectedRevision` for HTTP mutation routes.
 */
export function applyOperation(sessionInput, operationInput, options = {}) {
  validateSession(sessionInput);
  if (!operationInput || typeof operationInput !== "object" || Array.isArray(operationInput)) {
    throw new SessionOperationError("Operation body must be an object.");
  }
  const session = structuredClone(sessionInput);
  const operation = structuredClone(operationInput);
  const type = canonicalType(operation.type);
  operation.type = type;

  const replay = findReplay(session, operation);
  if (replay) return replayResult(session, replay);
  if (options.requireExpectedRevision && operation.expected_revision === undefined) {
    throw new SessionOperationError("expected_revision is required.", {
      code: "expected_revision_required",
      status: 428,
    });
  }
  if (operation.expected_revision !== undefined) {
    const expected = nonnegativeInteger(operation.expected_revision, "expected_revision");
    if (expected !== session.revision) throw new RevisionConflictError(expected, session);
  }

  const realtimeItemId = operation.realtime_item_id ?? operation.source?.realtime_item_id;
  if (type !== "append_utterance" && realtimeItemId
    && !session.transcript.some((utterance) => utterance.realtime_item_id === realtimeItemId)) {
    throw new TranscriptPendingError(realtimeItemId);
  }

  const context = {
    timestamp: isoNow(options.now),
    idFactory: options.idFactory,
    selection: options.selection ?? { selected_node_ids: operation.selected_node_ids ?? [] },
    operation,
    reservedIds: new Set(),
  };

  if (operation.actor === "curator" && type !== "propose_changes") {
    throw new SessionOperationError("The curator can only create reviewable proposals.", {
      code: "curator_proposal_only",
      status: 403,
    });
  }

  const directAction = DIRECT_ACTIONS.get(type);
  if (directAction) return directAction(session, operation, context);

  const actor = actorOf(operation);
  const operationId = allocateId(session, "operation", context, context.reservedIds);
  context.reservedIds.add(operationId);
  const baseRevision = session.revision;
  const beforeGraph = graphState(session);
  const beforeProposals = structuredClone(session.proposals);
  const { apply, undoable } = PROPOSAL_ACTIONS.get(type) ?? { apply: mutateGraph, undoable: true };
  const outcome = apply(session, operation, context);
  const historyAction = undoable && outcome.changed;
  const extra = outcome.extra ?? {};
  if (outcome.effective_type && outcome.effective_type !== type) extra.effective_type = outcome.effective_type;

  session.revision += 1;
  session.updated_at = context.timestamp;
  const beforeHistory = currentHistory(session);
  const history = historyAction
    ? [...beforeHistory.slice(0, session.history_cursor), operationId]
    : beforeHistory;
  if (historyAction) session.history_cursor = history.length;
  const change = historyAction ? {
    nodes: entityChanges(beforeGraph.nodes, session.nodes),
    edges: entityChanges(beforeGraph.edges, session.edges),
    proposals: entityChanges(beforeProposals, session.proposals).map(({ id, before, after }) => ({ id, before, after })),
  } : null;
  operationResultRecord({
    operationId,
    type,
    actor,
    operation,
    timestamp: context.timestamp,
    baseRevision,
    session,
    affected: outcome.affected,
    warnings: outcome.warnings,
    undoable: historyAction,
    change,
    history,
  });
  if (outcome.steps) {
    const record = session.operations.at(-1);
    record.steps = outcome.steps;
    const sources = new Set([
      ...(record.source_utterance_ids ?? []),
      ...outcome.steps.flatMap((step) => step.source_utterance_ids ?? []),
    ]);
    if (sources.size) record.source_utterance_ids = [...sources];
  }
  return finalizeResult(session, operationId, outcome.affected, outcome.warnings, extra);
}
