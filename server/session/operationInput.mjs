import { randomUUID } from "node:crypto";
import { ACTORS, OPERATION_ORIGINS, SAFE_ID } from "./constants.mjs";
export { SPEAKERS, SAFE_ID } from "./constants.mjs";

const TYPE_ALIASES = new Map([
  ["create", "create_bubble"],
  ["create_node", "create_bubble"],
  ["edit", "edit_bubble"],
  ["edit_node", "edit_bubble"],
  ["set_root", "set_central_idea"],
  ["set_central", "set_central_idea"],
  ["promote_to_root", "set_central_idea"],
  ["revisit", "revisit_bubble"],
  ["revisit_node", "revisit_bubble"],
  ["connect", "connect_bubbles"],
  ["connect_nodes", "connect_bubbles"],
  ["disconnect", "delete_connection"],
  ["disconnect_bubbles", "delete_connection"],
  ["delete_edge", "delete_connection"],
  ["delete_node", "delete_bubble"],
  ["move_node", "move_bubble"],
  ["bulk_delete", "bulk_delete_bubbles"],
  ["create_proposal", "propose_changes"],
  ["exclude_proposal_op", "exclude_proposal_operation"],
  ["accept", "accept_proposal"],
  ["dismiss", "dismiss_proposal"],
  ["undo", "undo_map_change"],
  ["redo", "redo_map_change"],
]);
export const PROPOSABLE_TYPES = new Set([
  "create_bubble",
  "edit_bubble",
  "revisit_bubble",
  "connect_bubbles",
  "delete_bubble",
  "delete_connection",
]);
export const BATCH_TYPES = new Set([
  ...PROPOSABLE_TYPES, "set_central_idea", "move_bubble", "bulk_delete_bubbles",
  "set_node_pinned", "set_node_parked",
]);

export class SessionOperationError extends Error {
  constructor(message, { code = "invalid_operation", status = 400, retryable = false, details } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    if (details !== undefined) this.details = details;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export class RevisionConflictError extends SessionOperationError {
  constructor(expectedRevision, session) {
    super(`Expected revision ${expectedRevision}, but the session is at revision ${session.revision}.`, {
      code: "revision_conflict",
      status: 409,
      details: {
        expected_revision: expectedRevision,
        current_revision: session.revision,
      },
    });
    this.current_revision = session.revision;
    this.snapshot = structuredClone(session);
  }
}

export class TranscriptPendingError extends SessionOperationError {
  constructor(realtimeItemId) {
    super("The referenced utterance has not finished transcribing yet.", {
      code: "transcript_pending",
      status: 409,
      retryable: true,
      details: { realtime_item_id: realtimeItemId },
    });
  }
}

export function canonicalType(type) {
  const clean = String(type ?? "").trim();
  if (!clean) throw new SessionOperationError("Operation type is required.", { code: "missing_operation_type" });
  return TYPE_ALIASES.get(clean) ?? clean;
}

function invalidField(field, expectation) {
  throw new SessionOperationError(`${field} must be ${expectation}.`, { code: `invalid_${field}`, details: { field } });
}

export function textField(value, field, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
    invalidField(field, allowEmpty ? "a string" : "a non-empty string");
  }
  return allowEmpty ? value : value.trim();
}

export function finiteNumber(value, field) {
  if (!Number.isFinite(value)) invalidField(field, "a finite number");
  return value;
}

export function nonnegativeInteger(value, field) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) invalidField(field, "a non-negative integer");
  return number;
}

export function originOf(operation) {
  const origin = operation.origin ?? "ui";
  if (!OPERATION_ORIGINS.has(origin)) {
    throw new SessionOperationError("origin must be ui, realtime, or map_controller.", { code: "invalid_origin" });
  }
  return origin;
}

export function actorOf(operation) {
  const origin = originOf(operation);
  if (origin === "realtime" || origin === "map_controller") return "partner";
  const actor = operation.actor ?? "you";
  if (!ACTORS.has(actor)) {
    throw new SessionOperationError("actor must be you, partner, or curator.", { code: "invalid_actor" });
  }
  return actor;
}

export function isoNow(now) {
  const value = typeof now === "function" ? now() : (now ?? new Date());
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new SessionOperationError("Invalid operation timestamp.");
  return date.toISOString();
}

function allIds(session) {
  const entities = [session.transcript, session.nodes, session.edges, session.proposals, session.operations];
  return new Set([...entities.flat(), ...session.proposals.flatMap((proposal) => proposal.operations)].map(({ id }) => id));
}

export function allocateId(session, kind, context, reserved = new Set()) {
  const occupied = allIds(session);
  reserved.forEach((id) => occupied.add(id));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const supplied = context.idFactory
      ? context.idFactory(kind)
      : `${kind}-${randomUUID()}`;
    const candidate = String(supplied ?? "").trim();
    const id = SAFE_ID.test(candidate)
      ? candidate
      : `${kind}-${randomUUID()}`;
    if (!occupied.has(id)) return id;
  }
  throw new SessionOperationError(`Could not allocate a unique ${kind} ID.`, { code: "id_allocation_failed" });
}

export function selectionIds(selection, operation) {
  const value = operation.selected_node_ids
    ?? selection?.selected_node_ids
    ?? selection?.selectedNodeIds
    ?? selection;
  return Array.isArray(value) ? [...new Set(value.map(String))] : [];
}

export function resolveNodeReference(session, reference, selection = {}) {
  if (reference === "$selected") {
    const selected = selectionIds(selection, {});
    if (selected.length !== 1) {
      throw new SessionOperationError(
        selected.length
          ? "“$selected” requires exactly one selected bubble, but multiple bubbles are selected."
          : "“$selected” requires exactly one selected bubble, but none is selected.",
        {
          code: "selection_clarification_required",
          status: 409,
          retryable: true,
          details: { selected_node_ids: selected },
        },
      );
    }
    reference = selected[0];
  }
  if (typeof reference !== "string" || !reference.trim()) {
    throw new SessionOperationError("A bubble reference is required.", { code: "missing_node_reference" });
  }
  const node = session.nodes.find(({ id }) => id === reference);
  if (!node) {
    throw new SessionOperationError(`Bubble “${reference}” does not exist.`, {
      code: "node_not_found",
      status: 404,
      details: { node_id: reference },
    });
  }
  return node.id;
}

export function arrayField(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) invalidField(field, "an array");
  return value;
}

// Model callers use both canonical field names and their documented aliases.
const referenceReader = (...fields) => (operation) => (
  fields.map((field) => operation[field]).find((value) => value != null) ?? operation[fields.at(-1)]
);
export const nodeRef = referenceReader("node_id", "nodeId", "node_reference", "nodeReference", "target", "id_reference");
export const edgeRef = referenceReader("edge_id", "edgeId", "connection_id", "connectionId");
export const sourceRef = referenceReader("from", "from_id", "from_reference", "fromReference", "source_id", "source");
export const targetRef = referenceReader("to", "to_id", "to_reference", "toReference", "target_id", "target");
