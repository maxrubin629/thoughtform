import { randomUUID } from "node:crypto";
import { UNTITLED_SESSION_TITLE, validateSession } from "./sessionStore.mjs";

const ACTORS = new Set(["you", "partner", "curator"]);
const OPERATION_ORIGINS = new Set(["ui", "realtime", "map_controller"]);
const SPEAKERS = new Set(["you", "partner"]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
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
const PROPOSABLE_TYPES = new Set([
  "create_bubble",
  "edit_bubble",
  "revisit_bubble",
  "connect_bubbles",
  "delete_bubble",
  "delete_connection",
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

function canonicalType(type) {
  const clean = String(type ?? "").trim();
  if (!clean) throw new SessionOperationError("Operation type is required.", { code: "missing_operation_type" });
  return TYPE_ALIASES.get(clean) ?? clean;
}

function textField(value, field, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
    throw new SessionOperationError(`${field} must be a${allowEmpty ? "" : " non-empty"} string.`, {
      code: `invalid_${field}`,
      details: { field },
    });
  }
  return allowEmpty ? value : value.trim();
}

function finiteNumber(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new SessionOperationError(`${field} must be a finite number.`, {
      code: `invalid_${field}`,
      details: { field },
    });
  }
  return value;
}

function nonnegativeInteger(value, field) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new SessionOperationError(`${field} must be a non-negative integer.`, {
      code: `invalid_${field}`,
      details: { field },
    });
  }
  return number;
}

function originOf(operation) {
  const origin = operation.origin ?? "ui";
  if (!OPERATION_ORIGINS.has(origin)) {
    throw new SessionOperationError("origin must be ui, realtime, or map_controller.", { code: "invalid_origin" });
  }
  return origin;
}

function actorOf(operation) {
  const origin = originOf(operation);
  if (origin === "realtime" || origin === "map_controller") return "partner";
  const actor = operation.actor ?? "you";
  if (!ACTORS.has(actor)) {
    throw new SessionOperationError("actor must be you, partner, or curator.", { code: "invalid_actor" });
  }
  return actor;
}

function isoNow(now) {
  const value = typeof now === "function" ? now() : (now ?? new Date());
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new SessionOperationError("Invalid operation timestamp.");
  return date.toISOString();
}

function allIds(session) {
  return new Set([
    ...session.transcript.map(({ id }) => id),
    ...session.nodes.map(({ id }) => id),
    ...session.edges.map(({ id }) => id),
    ...session.proposals.map(({ id }) => id),
    ...session.operations.map(({ id }) => id),
    ...session.proposals.flatMap((proposal) => proposal.operations.map(({ id }) => id)),
  ]);
}

function allocateId(session, kind, context, reserved = new Set()) {
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

function selectionIds(selection, operation) {
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

function occurrenceOffsets(haystack, needle) {
  const offsets = [];
  let cursor = 0;
  while (cursor <= haystack.length - needle.length) {
    const found = haystack.indexOf(needle, cursor);
    if (found < 0) break;
    offsets.push(found);
    cursor = found + Math.max(needle.length, 1);
  }
  return offsets;
}

/** Resolve a model-supplied quote to one and only one exact transcript span. */
export function resolveQuoteSpan(session, request = {}) {
  const nested = request.source && typeof request.source === "object" ? request.source : {};
  const quote = request.quote
    ?? request.transcript_quote
    ?? request.source_quote
    ?? nested.quote;
  const utteranceId = request.utterance_id ?? nested.utterance_id;
  const realtimeItemId = request.realtime_item_id ?? nested.realtime_item_id;
  if (typeof quote !== "string" || !quote.length) {
    throw new SessionOperationError("A non-empty transcript quote is required for provenance.", {
      code: "missing_quote",
      retryable: true,
    });
  }

  let candidates = session.transcript;
  if (utteranceId) {
    candidates = session.transcript.filter((utterance) => utterance.id === utteranceId);
    if (!candidates.length) {
      throw new SessionOperationError(`Transcript utterance “${utteranceId}” does not exist.`, {
        code: "utterance_not_found",
        status: 404,
        retryable: true,
        details: { utterance_id: utteranceId },
      });
    }
  } else if (realtimeItemId) {
    candidates = session.transcript.filter((utterance) => utterance.realtime_item_id === realtimeItemId);
    if (!candidates.length) throw new TranscriptPendingError(realtimeItemId);
  }

  const matches = candidates.flatMap((utterance) => (
    occurrenceOffsets(utterance.text, quote).map((start) => ({
      utterance_id: utterance.id,
      start,
      end: start + quote.length,
      quote,
    }))
  ));
  if (!matches.length) {
    throw new SessionOperationError("The quote was not found verbatim in the completed transcript.", {
      code: "quote_not_found",
      status: 422,
      retryable: true,
      details: { quote, utterance_id: utteranceId, realtime_item_id: realtimeItemId },
    });
  }
  if (matches.length > 1) {
    throw new SessionOperationError("The quote occurs more than once; provide the utterance ID and a unique quote.", {
      code: "ambiguous_quote",
      status: 422,
      retryable: true,
      details: { quote, matches },
    });
  }
  return matches[0];
}

function exactSource(session, request) {
  const nested = request.source && typeof request.source === "object" ? request.source : null;
  const quote = request.quote ?? request.transcript_quote ?? request.source_quote ?? nested?.quote;
  if (quote === undefined || quote === null || quote === "") return null;

  if (nested && Number.isInteger(nested.start) && Number.isInteger(nested.end) && nested.utterance_id) {
    const utterance = session.transcript.find(({ id }) => id === nested.utterance_id);
    if (!utterance
      || nested.start < 0
      || nested.end < nested.start
      || nested.end > utterance.text.length
      || utterance.text.slice(nested.start, nested.end) !== quote) {
      throw new SessionOperationError("The supplied provenance span is not exact.", {
        code: "invalid_source_span",
        status: 422,
        retryable: true,
      });
    }
    return {
      utterance_id: nested.utterance_id,
      start: nested.start,
      end: nested.end,
      quote,
    };
  }
  return resolveQuoteSpan(session, { ...request, quote });
}

function exactSources(session, request) {
  const candidates = [];
  const sources = arrayField(request.sources, "sources");
  sources.forEach((source) => candidates.push(exactSource(session, { source, quote: source?.quote })));
  const source = exactSource(session, request);
  if (source) candidates.push(source);
  if (request.quotes !== undefined) {
    arrayField(request.quotes, "quotes").forEach((quote) => {
      if (typeof quote !== "string" || !quote.trim()) {
        throw new SessionOperationError("quotes must contain non-empty exact transcript quotes.", {
          code: "invalid_quotes",
        });
      }
      candidates.push(resolveQuoteSpan(session, { ...request, quote }));
    });
  }
  const seen = new Set();
  return candidates.filter((source) => {
    if (!source) return false;
    const key = `${source.utterance_id}:${source.start}:${source.end}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function arrayField(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new SessionOperationError(`${field} must be an array.`, {
      code: `invalid_${field}`,
      details: { field },
    });
  }
  return value;
}

function operationProvenance(session, operation) {
  const sourceUtteranceIds = new Set();
  const addUtteranceId = (id) => {
    if (typeof id === "string" && id) sourceUtteranceIds.add(id);
  };
  arrayField(operation.source_utterance_ids, "source_utterance_ids").forEach(addUtteranceId);
  addUtteranceId(operation.utterance_id);
  addUtteranceId(operation.source?.utterance_id);
  arrayField(operation.sources, "sources").forEach((source) => addUtteranceId(source?.utterance_id));
  exactSources(session, operation).forEach((source) => addUtteranceId(source.utterance_id));

  const sourceRealtimeItemId = operation.source_realtime_item_id
    ?? operation.realtime_item_id
    ?? operation.source?.realtime_item_id
    ?? null;
  if (sourceRealtimeItemId) {
    session.transcript
      .filter((utterance) => utterance.realtime_item_id === sourceRealtimeItemId)
      .forEach((utterance) => sourceUtteranceIds.add(utterance.id));
  }
  const inferredRealtimeItems = new Set(
    [...sourceUtteranceIds]
      .map((id) => session.transcript.find((utterance) => utterance.id === id)?.realtime_item_id)
      .filter(Boolean),
  );
  const resolvedRealtimeItemId = sourceRealtimeItemId
    ?? (inferredRealtimeItems.size === 1 ? [...inferredRealtimeItems][0] : null);
  return {
    ...(sourceUtteranceIds.size ? { source_utterance_ids: [...sourceUtteranceIds] } : {}),
    ...(resolvedRealtimeItemId ? { source_realtime_item_id: resolvedRealtimeItemId } : {}),
  };
}

function appendSource(node, source) {
  if (!source) return false;
  const duplicate = node.sources.some((existing) => (
    existing.utterance_id === source.utterance_id
    && existing.start === source.start
    && existing.end === source.end
  ));
  if (!duplicate) node.sources.push(source);
  return !duplicate;
}

function appendSources(node, sources) {
  return sources.reduce((changed, source) => appendSource(node, source) || changed, false);
}

function enforceUtteranceBubbleLimit(session, sources) {
  const utteranceIds = new Set(sources.map(({ utterance_id: id }) => id));
  for (const utteranceId of utteranceIds) {
    const sourcedBubbleCount = session.nodes.filter((candidate) => (
      candidate.sources.some((candidateSource) => candidateSource.utterance_id === utteranceId)
    )).length;
    if (sourcedBubbleCount >= 3) {
      throw new SessionOperationError("A completed utterance can contribute at most three bubbles.", {
        code: "utterance_bubble_limit",
        status: 409,
        retryable: true,
        details: { utterance_id: utteranceId, maximum: 3 },
      });
    }
  }
}

function anchorId(session) {
  return session.nodes.find(({ depth }) => depth === 0)?.id ?? session.nodes[0]?.id ?? null;
}

function edgeExists(session, from, to) {
  return session.edges.some((edge) => (
    (edge.from === from && edge.to === to)
    || (edge.from === to && edge.to === from)
  ));
}

function nodeRef(operation) {
  return operation.node_id
    ?? operation.nodeId
    ?? operation.node_reference
    ?? operation.nodeReference
    ?? operation.target
    ?? operation.id_reference;
}

function edgeRef(operation) {
  return operation.edge_id ?? operation.edgeId ?? operation.connection_id ?? operation.connectionId;
}

function sourceRef(operation) {
  return operation.from
    ?? operation.from_id
    ?? operation.from_reference
    ?? operation.fromReference
    ?? operation.source_id
    ?? operation.source;
}

function targetRef(operation) {
  return operation.to
    ?? operation.to_id
    ?? operation.to_reference
    ?? operation.toReference
    ?? operation.target_id
    ?? operation.target;
}

function defaultNodePosition(session, parent) {
  const width = 1576;
  const height = 1000;
  if (!session.nodes.length) return { x: width * 0.33, y: height * 0.5 };
  if (parent) {
    const siblingCount = session.edges.filter((edge) => edge.from === parent.id).length;
    const angle = (siblingCount - 1) * 0.62;
    return {
      x: Math.min(width - 90, parent.x + Math.cos(angle) * 225),
      y: Math.max(150, Math.min(height - 90, parent.y + Math.sin(angle) * 225)),
    };
  }
  const anchor = session.nodes.find((node) => node.depth === 0) ?? session.nodes[0];
  const ring = session.nodes.filter((node) => !session.edges.some((edge) => edge.to === node.id)).length;
  const angle = -0.85 + ring * 2.1;
  return {
    x: Math.max(90, Math.min(width - 90, anchor.x + Math.cos(angle) * 310)),
    y: Math.max(150, Math.min(height - 90, anchor.y + Math.sin(angle) * 310)),
  };
}

function assignDepthsFromRoot(session, rootId) {
  const depths = new Map([[rootId, 0]]);
  const queue = [rootId];
  while (queue.length) {
    const current = queue.shift();
    const nextDepth = depths.get(current) + 1;
    session.edges.forEach((edge) => {
      let neighbor = null;
      if (edge.from === current) neighbor = edge.to;
      else if (edge.to === current) neighbor = edge.from;
      if (neighbor && !depths.has(neighbor)) {
        depths.set(neighbor, nextDepth);
        queue.push(neighbor);
      }
    });
  }
  session.nodes.forEach((node) => {
    node.depth = depths.get(node.id) ?? Math.max(1, node.depth ?? 1);
  });
  session.edges.forEach((edge) => {
    const fromDepth = depths.get(edge.from);
    const toDepth = depths.get(edge.to);
    if (fromDepth !== undefined && toDepth !== undefined && fromDepth > toDepth) {
      [edge.from, edge.to] = [edge.to, edge.from];
    }
  });
}

function mutateGraph(session, operation, context) {
  const type = canonicalType(operation.type);
  const actor = actorOf(operation);
  const timestamp = context.timestamp;
  const selection = { selected_node_ids: selectionIds(context.selection, operation) };
  const affected = [];
  const warnings = [];

  if (type === "create_bubble") {
    const text = textField(operation.text ?? operation.idea_text ?? operation.label, "text");
    const existing = session.nodes.find((node) => node.text.trim().toLocaleLowerCase() === text.toLocaleLowerCase());
    if (existing) {
      if (context.fromProposal) {
        throw new SessionOperationError("A bubble with the same idea already exists.", {
          code: "duplicate_node",
          status: 409,
          details: { node_id: existing.id },
        });
      }
      appendSources(existing, exactSources(session, operation));
      existing.heat_at = timestamp;
      existing.updated_at = timestamp;
      affected.push(existing.id);
      warnings.push("Repeated idea revisited the existing bubble instead of creating a duplicate.");
      return { changed: true, affected, warnings, effective_type: "revisit_bubble" };
    }

    let parent = null;
    const parentReference = operation.parent ?? operation.parent_id ?? operation.parent_reference;
    if (parentReference !== undefined && parentReference !== null && parentReference !== "") {
      const parentId = resolveNodeReference(session, parentReference, selection);
      parent = session.nodes.find(({ id }) => id === parentId);
    }
    const position = defaultNodePosition(session, parent);
    const nodeId = operation.node_id ?? operation.nodeId
      ?? allocateId(session, "node", context, context.reservedIds);
    if (!SAFE_ID.test(String(nodeId)) || session.nodes.some(({ id }) => id === nodeId)) {
      throw new SessionOperationError("The proposed bubble ID is invalid or already exists.", {
        code: "duplicate_node_id",
        status: 409,
        details: { node_id: nodeId },
      });
    }
    const sources = exactSources(session, operation);
    enforceUtteranceBubbleLimit(session, sources);
    const node = {
      id: nodeId,
      text,
      depth: operation.depth === undefined || operation.depth === null
        ? (parent ? parent.depth + 1 : (session.nodes.length ? 1 : 0))
        : nonnegativeInteger(operation.depth, "depth"),
      x: operation.x === undefined || operation.x === null ? position.x : finiteNumber(operation.x, "x"),
      y: operation.y === undefined || operation.y === null ? position.y : finiteNumber(operation.y, "y"),
      ...(operation.heat_at ? { heat_at: new Date(operation.heat_at).toISOString() } : {}),
      sources,
      created_by: actor,
      created_at: timestamp,
      updated_at: timestamp,
    };
    session.nodes.push(node);
    affected.push(node.id);
    context.reservedIds.add(node.id);
    if (parent) {
      const edgeId = allocateId(session, "edge", context, context.reservedIds);
      session.edges.push({
        id: edgeId,
        from: parent.id,
        to: node.id,
        created_by: actor,
        created_at: timestamp,
      });
      context.reservedIds.add(edgeId);
      affected.push(edgeId);
    }
    if ((!session.title.trim() || session.title === UNTITLED_SESSION_TITLE) && session.nodes.length === 1) {
      session.title = text.length > 72 ? `${text.slice(0, 69).trimEnd()}…` : text;
    }
    return { changed: true, affected, warnings, effective_type: type };
  }

  if (type === "edit_bubble") {
    const id = resolveNodeReference(session, nodeRef(operation), selection);
    const node = session.nodes.find((candidate) => candidate.id === id);
    const text = textField(operation.text ?? operation.idea_text ?? operation.label, "text");
    const sourceAdded = appendSources(node, exactSources(session, operation));
    const textChanged = node.text !== text;
    node.text = text;
    if (textChanged || sourceAdded) node.updated_at = timestamp;
    affected.push(id);
    if (!textChanged && !sourceAdded) warnings.push("The bubble already has that text and provenance.");
    return { changed: textChanged || sourceAdded, affected, warnings, effective_type: type };
  }

  if (type === "set_central_idea") {
    const reference = nodeRef(operation);
    const hasReference = typeof reference === "string" && reference.trim().length > 0;
    const hasText = typeof operation.text === "string" && operation.text.trim().length > 0;
    if (hasReference === hasText) {
      throw new SessionOperationError(
        "set_central_idea requires either one existing bubble reference or new bubble text, but not both.",
        { code: "invalid_central_idea_target" },
      );
    }

    const beforeNodes = new Map(session.nodes.map((node) => [node.id, JSON.stringify(node)]));
    const beforeEdges = new Map(session.edges.map((edge) => [edge.id, JSON.stringify(edge)]));
    const previousRoot = session.nodes.find(({ depth }) => depth === 0) ?? session.nodes[0] ?? null;
    let central;
    let sourceAdded = false;
    if (hasReference) {
      const id = resolveNodeReference(session, reference, selection);
      central = session.nodes.find((node) => node.id === id);
      sourceAdded = appendSources(central, exactSources(session, operation));
      if (previousRoot && previousRoot.id !== central.id) {
        const priorPosition = { x: previousRoot.x, y: previousRoot.y };
        previousRoot.x = central.x;
        previousRoot.y = central.y;
        central.x = priorPosition.x;
        central.y = priorPosition.y;
      }
    } else {
      const text = textField(operation.text, "text");
      const sources = exactSources(session, operation);
      const existing = session.nodes.find((node) => node.text.trim().toLocaleLowerCase() === text.toLocaleLowerCase());
      if (existing) {
        central = existing;
        sourceAdded = appendSources(central, sources);
        if (previousRoot && previousRoot.id !== central.id) {
          const priorPosition = { x: previousRoot.x, y: previousRoot.y };
          previousRoot.x = central.x;
          previousRoot.y = central.y;
          central.x = priorPosition.x;
          central.y = priorPosition.y;
        }
        warnings.push("The matching existing bubble became the central idea instead of creating a duplicate.");
      } else {
        enforceUtteranceBubbleLimit(session, sources);
        const nodeId = operation.node_id ?? operation.nodeId
          ?? allocateId(session, "node", context, context.reservedIds);
        if (!SAFE_ID.test(String(nodeId)) || session.nodes.some(({ id }) => id === nodeId)) {
          throw new SessionOperationError("The central bubble ID is invalid or already exists.", {
            code: "duplicate_node_id",
            status: 409,
            details: { node_id: nodeId },
          });
        }
        const rootPosition = previousRoot
          ? { x: previousRoot.x, y: previousRoot.y }
          : defaultNodePosition(session, null);
        central = {
          id: nodeId,
          text,
          depth: 0,
          x: rootPosition.x,
          y: rootPosition.y,
          sources,
          created_by: actor,
          created_at: timestamp,
          updated_at: timestamp,
        };
        session.nodes.push(central);
        context.reservedIds.add(nodeId);
        if (previousRoot) {
          const supportPosition = defaultNodePosition(session, central);
          previousRoot.x = supportPosition.x;
          previousRoot.y = supportPosition.y;
        }
      }
    }

    const alreadyCentral = previousRoot?.id === central.id;
    assignDepthsFromRoot(session, central.id);
    const changedIds = session.nodes
      .filter((node) => beforeNodes.get(node.id) !== JSON.stringify(node))
      .map(({ id }) => id);
    const changedEdgeIds = session.edges
      .filter((edge) => beforeEdges.get(edge.id) !== JSON.stringify(edge))
      .map(({ id }) => id);
    session.nodes.forEach((node) => {
      if (changedIds.includes(node.id)) node.updated_at = timestamp;
    });
    affected.push(...(changedIds.length ? changedIds : [central.id]), ...changedEdgeIds);
    if (alreadyCentral) warnings.push("That bubble is already the central idea.");
    return { changed: changedIds.length > 0 || sourceAdded, affected, warnings, effective_type: type };
  }

  if (type === "revisit_bubble") {
    const id = resolveNodeReference(session, nodeRef(operation), selection);
    const node = session.nodes.find((candidate) => candidate.id === id);
    appendSources(node, exactSources(session, operation));
    node.heat_at = timestamp;
    node.updated_at = timestamp;
    affected.push(id);
    return { changed: true, affected, warnings, effective_type: type };
  }

  if (type === "connect_bubbles") {
    const from = resolveNodeReference(session, sourceRef(operation), selection);
    const to = resolveNodeReference(session, targetRef(operation), selection);
    if (from === to) {
      throw new SessionOperationError("A bubble cannot connect to itself.", { code: "self_connection" });
    }
    if (edgeExists(session, from, to)) {
      throw new SessionOperationError("Those bubbles are already connected.", {
        code: "duplicate_edge",
        status: 409,
        details: { from, to },
      });
    }
    const edgeId = operation.edge_id ?? operation.edgeId
      ?? allocateId(session, "edge", context, context.reservedIds);
    if (!SAFE_ID.test(String(edgeId)) || session.edges.some(({ id }) => id === edgeId)) {
      throw new SessionOperationError("The connection ID is invalid or already exists.", {
        code: "duplicate_edge_id",
        status: 409,
      });
    }
    session.edges.push({ id: edgeId, from, to, created_by: actor, created_at: timestamp });
    context.reservedIds.add(edgeId);
    affected.push(edgeId, from, to);
    return { changed: true, affected, warnings, effective_type: type };
  }

  if (type === "delete_bubble") {
    const id = resolveNodeReference(session, nodeRef(operation), selection);
    if (id === anchorId(session)) {
      throw new SessionOperationError("The starting anchor cannot be deleted.", {
        code: "anchor_protected",
        status: 409,
        details: { node_id: id },
      });
    }
    const incident = session.edges.filter((edge) => edge.from === id || edge.to === id);
    session.nodes = session.nodes.filter((node) => node.id !== id);
    session.edges = session.edges.filter((edge) => edge.from !== id && edge.to !== id);
    affected.push(id, ...incident.map(({ id: edgeId }) => edgeId));
    return { changed: true, affected, warnings, effective_type: type };
  }

  if (type === "delete_connection") {
    let id = edgeRef(operation);
    if (!id && sourceRef(operation) && targetRef(operation)) {
      const from = resolveNodeReference(session, sourceRef(operation), selection);
      const to = resolveNodeReference(session, targetRef(operation), selection);
      id = session.edges.find((edge) => (
        (edge.from === from && edge.to === to) || (edge.from === to && edge.to === from)
      ))?.id;
    }
    const edge = session.edges.find((candidate) => candidate.id === id);
    if (!edge) {
      throw new SessionOperationError(`Connection “${String(id)}” does not exist.`, {
        code: "edge_not_found",
        status: 404,
        details: { edge_id: id },
      });
    }
    session.edges = session.edges.filter((candidate) => candidate.id !== edge.id);
    affected.push(edge.id, edge.from, edge.to);
    return { changed: true, affected, warnings, effective_type: type };
  }

  if (type === "move_bubble") {
    const id = resolveNodeReference(session, nodeRef(operation), selection);
    const node = session.nodes.find((candidate) => candidate.id === id);
    const x = finiteNumber(operation.x, "x");
    const y = finiteNumber(operation.y, "y");
    const changed = node.x !== x || node.y !== y;
    node.x = x;
    node.y = y;
    if (changed) node.updated_at = timestamp;
    affected.push(id);
    if (!changed) warnings.push("The bubble is already at that position.");
    return { changed, affected, warnings, effective_type: type };
  }

  if (type === "bulk_delete_bubbles") {
    const references = operation.node_ids ?? operation.nodeIds ?? selection.selected_node_ids;
    if (!Array.isArray(references) || !references.length) {
      throw new SessionOperationError("bulk_delete_bubbles requires node_ids or a non-empty selection.", {
        code: "missing_node_references",
      });
    }
    const ids = [...new Set(references.map((reference) => resolveNodeReference(session, reference, selection)))];
    const anchor = anchorId(session);
    const deletable = ids.filter((id) => id !== anchor);
    if (ids.includes(anchor)) warnings.push("The starting anchor was preserved.");
    const deletedEdges = session.edges.filter((edge) => deletable.includes(edge.from) || deletable.includes(edge.to));
    session.nodes = session.nodes.filter((node) => !deletable.includes(node.id));
    session.edges = session.edges.filter((edge) => !deletable.includes(edge.from) && !deletable.includes(edge.to));
    affected.push(...deletable, ...deletedEdges.map(({ id }) => id));
    return { changed: deletable.length > 0, affected, warnings, effective_type: type };
  }

  throw new SessionOperationError(`Unsupported map operation “${type}”.`, {
    code: "unsupported_operation",
    details: { type },
  });
}

function currentHistory(session) {
  const latest = [...session.operations].reverse()
    .find((operation) => Array.isArray(operation.history_entry_ids));
  if (latest) return [...latest.history_entry_ids];
  return session.operations.filter((operation) => operation.undoable).map(({ id }) => id);
}

function graphState(session) {
  return {
    nodes: structuredClone(session.nodes),
    edges: structuredClone(session.edges),
  };
}

function entityChanges(before, after) {
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

function proposalChanges(before, after) {
  const prior = new Map(before.map((proposal) => [proposal.id, proposal]));
  const next = new Map(after.map((proposal) => [proposal.id, proposal]));
  return [...new Set([...prior.keys(), ...next.keys()])]
    .filter((id) => JSON.stringify(prior.get(id)) !== JSON.stringify(next.get(id)))
    .map((id) => ({
      id,
      before: prior.has(id) ? structuredClone(prior.get(id)) : null,
      after: next.has(id) ? structuredClone(next.get(id)) : null,
    }));
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

function findReplay(session, operation) {
  if (operation.call_id) {
    return session.operations.find((record) => record.call_id === operation.call_id) ?? null;
  }
  return null;
}

function replayResult(session, record) {
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
  session.operations.forEach((operation) => {
    delete operation.history_entry_ids;
  });
  session.operations.push({
    ...record,
    history_entry_ids: [...history],
  });
}

function finalizeResult(session, operationId, affected, warnings, extra = {}) {
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

function transcriptOperation(session, operation, context) {
  const realtimeItemId = operation.realtime_item_id;
  if (realtimeItemId) {
    const existing = session.transcript.find((utterance) => utterance.realtime_item_id === realtimeItemId);
    if (existing) {
      const record = [...session.operations].reverse().find((candidate) => (
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

function validateEvidenceItem(session, item) {
  if (!item || typeof item !== "object") {
    throw new SessionOperationError("Proposal evidence entries must be transcript spans.", {
      code: "invalid_proposal_evidence",
    });
  }
  if (Number.isInteger(item.start) && Number.isInteger(item.end) && item.utterance_id) {
    return exactSource(session, { source: item, quote: item.quote });
  }
  return resolveQuoteSpan(session, item);
}

function normalizeProposalOperation(session, proposed, context, reserved) {
  if (!proposed || typeof proposed !== "object") {
    throw new SessionOperationError("Each proposal operation must be an object.", {
      code: "invalid_proposal_operation",
    });
  }
  const type = canonicalType(proposed.type);
  if (!PROPOSABLE_TYPES.has(type)) {
    throw new SessionOperationError(`“${type}” is not allowed in a proposal.`, {
      code: "unsupported_proposal_operation",
      details: { type },
    });
  }
  const normalized = { ...structuredClone(proposed), type };
  normalized.id = proposed.id && SAFE_ID.test(String(proposed.id))
    ? String(proposed.id)
    : allocateId(session, "proposal-operation", context, reserved);
  if (reserved.has(normalized.id)) {
    throw new SessionOperationError("Proposal operation IDs must be unique.", {
      code: "duplicate_proposal_operation_id",
    });
  }
  reserved.add(normalized.id);
  normalized.excluded = Boolean(proposed.excluded);
  delete normalized.actor;
  delete normalized.outcome;

  const selection = { selected_node_ids: selectionIds(context.selection, context.operation) };
  const resolveProposalNode = (reference) => (
    context.proposedNodeIds?.has(reference)
      ? reference
      : resolveNodeReference(session, reference, selection)
  );
  if (type === "create_bubble") {
    normalized.text = textField(proposed.text ?? proposed.idea_text ?? proposed.label, "text");
    normalized.node_id = proposed.node_id && SAFE_ID.test(String(proposed.node_id))
      ? String(proposed.node_id)
      : allocateId(session, "node", context, reserved);
    if (session.nodes.some(({ id }) => id === normalized.node_id) || reserved.has(normalized.node_id)) {
      throw new SessionOperationError("A proposed bubble ID is invalid or duplicated.", {
        code: "duplicate_node_id",
      });
    }
    reserved.add(normalized.node_id);
    context.proposedNodeIds?.add(normalized.node_id);
    const parent = proposed.parent ?? proposed.parent_id ?? proposed.parent_reference;
    if (parent) normalized.parent = resolveProposalNode(parent);
  } else if (type === "connect_bubbles") {
    normalized.from = resolveProposalNode(sourceRef(proposed));
    normalized.to = resolveProposalNode(targetRef(proposed));
  } else if (type === "delete_connection") {
    const edgeId = edgeRef(proposed);
    if (edgeId) normalized.edge_id = String(edgeId);
    else {
      normalized.from = resolveProposalNode(sourceRef(proposed));
      normalized.to = resolveProposalNode(targetRef(proposed));
    }
  } else {
    normalized.node_id = resolveNodeReference(session, nodeRef(proposed), selection);
    if (type === "edit_bubble") normalized.text = textField(proposed.text ?? proposed.idea_text ?? proposed.label, "text");
  }
  const sources = exactSources(session, proposed);
  if (sources.length) {
    normalized.sources = sources;
    delete normalized.quote;
    delete normalized.transcript_quote;
    delete normalized.source_quote;
    delete normalized.utterance_id;
    delete normalized.realtime_item_id;
  }
  return normalized;
}

export function validateProposal(session, proposal) {
  if (!proposal || typeof proposal !== "object") {
    throw new SessionOperationError("Proposal is required.", { code: "invalid_proposal" });
  }
  if (!Array.isArray(proposal.operations) || !proposal.operations.length) {
    throw new SessionOperationError("A proposal must contain at least one operation.", {
      code: "empty_proposal",
    });
  }
  const context = {
    timestamp: proposal.created_at ?? new Date().toISOString(),
    idFactory: null,
    selection: {},
    operation: proposal,
    reservedIds: new Set(),
  };
  proposal.evidence?.forEach((item) => validateEvidenceItem(session, item));
  proposal.operations.forEach((item) => normalizeProposalOperation(session, item, context, context.reservedIds));
  return proposal;
}

function proposeChanges(session, operation, context) {
  const rawOperations = operation.operations ?? operation.changes;
  if (!Array.isArray(rawOperations) || !rawOperations.length) {
    throw new SessionOperationError("propose_changes requires a non-empty operations array.", {
      code: "empty_proposal",
    });
  }
  const reserved = new Set();
  const proposedNodeIds = new Set();
  const preparedOperations = rawOperations.map((proposed) => {
    if (canonicalType(proposed?.type) !== "create_bubble") return proposed;
    const prepared = { ...proposed };
    prepared.node_id ??= allocateId(session, "node", context, proposedNodeIds);
    if (!SAFE_ID.test(String(prepared.node_id))
      || proposedNodeIds.has(prepared.node_id)
      || session.nodes.some(({ id }) => id === prepared.node_id)) {
      throw new SessionOperationError("A proposed bubble ID is invalid or duplicated.", {
        code: "duplicate_node_id",
      });
    }
    proposedNodeIds.add(prepared.node_id);
    return prepared;
  });
  const proposalContext = { ...context, operation, proposedNodeIds };
  const proposalOperations = preparedOperations.map((proposed) => (
    normalizeProposalOperation(session, proposed, proposalContext, reserved)
  ));
  const evidence = (operation.evidence ?? []).map((item) => validateEvidenceItem(session, item));
  const proposalId = operation.proposal_id ?? operation.id;
  const id = proposalId && SAFE_ID.test(String(proposalId))
    ? String(proposalId)
    : allocateId(session, "proposal", context, reserved);
  if (session.proposals.some((proposal) => proposal.id === id)) {
    throw new SessionOperationError("That proposal already exists.", {
      code: "duplicate_proposal_id",
      status: 409,
      details: { proposal_id: id },
    });
  }
  const proposal = {
    id,
    status: "pending",
    base_revision: operation.base_revision === undefined
      ? session.revision
      : nonnegativeInteger(operation.base_revision, "base_revision"),
    actor: actorOf(operation),
    rationale: textField(operation.rationale ?? "", "rationale", { allowEmpty: true }),
    evidence,
    operations: proposalOperations,
    created_at: context.timestamp,
  };
  session.proposals.push(proposal);
  return { changed: true, affected: [id], warnings: [], proposal };
}

function pendingProposal(session, operation) {
  const id = operation.proposal_id ?? operation.proposalId ?? operation.id_reference;
  const proposal = session.proposals.find((candidate) => candidate.id === id);
  if (!proposal) {
    throw new SessionOperationError(`Proposal “${String(id)}” does not exist.`, {
      code: "proposal_not_found",
      status: 404,
      details: { proposal_id: id },
    });
  }
  if (proposal.status !== "pending") {
    throw new SessionOperationError(`Proposal “${id}” is ${proposal.status}, not pending.`, {
      code: "proposal_not_pending",
      status: 409,
      details: { proposal_id: id, status: proposal.status },
    });
  }
  return proposal;
}

function excludeProposalOperation(session, operation) {
  const proposal = pendingProposal(session, operation);
  const operationId = operation.proposal_operation_id
    ?? operation.operation_id
    ?? operation.proposalOperationId;
  const proposed = proposal.operations.find((candidate) => candidate.id === operationId);
  if (!proposed) {
    throw new SessionOperationError(`Proposal operation “${String(operationId)}” does not exist.`, {
      code: "proposal_operation_not_found",
      status: 404,
    });
  }
  const excluded = operation.excluded === undefined ? true : Boolean(operation.excluded);
  const changed = proposed.excluded !== excluded;
  proposed.excluded = excluded;
  return {
    changed,
    affected: [proposal.id, proposed.id],
    warnings: changed ? [] : [excluded ? "That operation was already excluded." : "That operation was already included."],
  };
}

function dismissProposal(session, operation) {
  const id = operation.proposal_id ?? operation.proposalId ?? operation.id_reference;
  const proposal = session.proposals.find((candidate) => candidate.id === id);
  if (!proposal) {
    throw new SessionOperationError(`Proposal “${String(id)}” does not exist.`, {
      code: "proposal_not_found",
      status: 404,
      details: { proposal_id: id },
    });
  }
  if (proposal.status !== "pending" && proposal.status !== "stale") {
    throw new SessionOperationError(`Proposal “${id}” is ${proposal.status} and cannot be dismissed.`, {
      code: "proposal_not_dismissible",
      status: 409,
      details: { proposal_id: id, status: proposal.status },
    });
  }
  proposal.status = "dismissed";
  return { changed: true, affected: [proposal.id], warnings: [] };
}

const STALE_PROPOSAL_CODES = new Set([
  "node_not_found",
  "edge_not_found",
  "duplicate_edge",
  "self_connection",
  "anchor_protected",
  "duplicate_node",
  "duplicate_node_id",
  "quote_not_found",
  "utterance_not_found",
  "invalid_source_span",
  "utterance_bubble_limit",
]);

function acceptProposal(session, operation, context) {
  const proposal = pendingProposal(session, operation);
  const affected = [proposal.id];
  const warnings = [];
  let acceptedCount = 0;
  let connectionIndex = 0;
  const animationDelays = {};

  for (const proposed of proposal.operations) {
    if (proposed.excluded) {
      proposed.outcome = "excluded";
      warnings.push(`Excluded proposal operation ${proposed.id}.`);
      continue;
    }
    try {
      const result = mutateGraph(session, {
        ...proposed,
        type: proposed.type,
        actor: proposal.actor,
      }, { ...context, fromProposal: true });
      if (!result.changed) {
        proposed.outcome = "stale";
        warnings.push(`Dropped proposal operation ${proposed.id} because it no longer changes the map.`);
        continue;
      }
      proposed.outcome = "accepted";
      acceptedCount += 1;
      affected.push(...result.affected);
      warnings.push(...result.warnings);
      if (canonicalType(proposed.type) === "connect_bubbles") {
        const edgeId = result.affected.find((id) => session.edges.some((edge) => edge.id === id));
        if (edgeId) animationDelays[edgeId] = connectionIndex * 160;
        connectionIndex += 1;
      }
    } catch (error) {
      if (!(error instanceof SessionOperationError) || !STALE_PROPOSAL_CODES.has(error.code)) throw error;
      proposed.outcome = "stale";
      warnings.push(`Dropped proposal operation ${proposed.id}: ${error.message}`);
    }
  }
  proposal.status = acceptedCount ? "accepted" : "stale";
  if (!acceptedCount) warnings.push("The proposal is fully stale; no valid operation remains.");
  return {
    changed: acceptedCount > 0,
    affected,
    warnings,
    proposal,
    proposal_status: proposal.status,
    connection_animation_delays: animationDelays,
  };
}

function operationResultRecord({ operationId, type, actor, operation, timestamp, baseRevision, session, affected, warnings, undoable, change, history }) {
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
    ...(change ? { change } : {}),
    ...operationProvenance(session, operation),
  };
  appendRecord(session, record, history);
}

function undoOrRedo(session, operation, context, direction) {
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

  if (type === "append_utterance") return transcriptOperation(session, operation, context);
  if (type === "undo_map_change") return undoOrRedo(session, operation, context, "undo");
  if (type === "redo_map_change") return undoOrRedo(session, operation, context, "redo");

  const actor = actorOf(operation);
  const operationId = allocateId(session, "operation", context, context.reservedIds);
  context.reservedIds.add(operationId);
  const baseRevision = session.revision;
  const beforeGraph = graphState(session);
  const beforeProposals = structuredClone(session.proposals);
  let outcome;
  let historyAction = false;
  let extra = {};

  if (type === "propose_changes") {
    outcome = proposeChanges(session, operation, context);
  } else if (type === "exclude_proposal_operation") {
    outcome = excludeProposalOperation(session, operation);
  } else if (type === "dismiss_proposal") {
    outcome = dismissProposal(session, operation);
  } else if (type === "accept_proposal") {
    outcome = acceptProposal(session, operation, context);
    historyAction = outcome.changed;
    extra = {
      proposal_status: outcome.proposal_status,
      connection_animation_delays: outcome.connection_animation_delays,
    };
  } else {
    outcome = mutateGraph(session, operation, context);
    historyAction = outcome.changed;
    if (outcome.effective_type && outcome.effective_type !== type) {
      extra.effective_type = outcome.effective_type;
    }
  }

  session.revision += 1;
  session.updated_at = context.timestamp;
  const beforeHistory = currentHistory(session);
  const history = historyAction
    ? [...beforeHistory.slice(0, session.history_cursor), operationId]
    : beforeHistory;
  if (historyAction) session.history_cursor = history.length;
  const afterGraph = graphState(session);
  const changes = proposalChanges(beforeProposals, session.proposals);
  const change = historyAction ? {
    nodes: entityChanges(beforeGraph.nodes, afterGraph.nodes),
    edges: entityChanges(beforeGraph.edges, afterGraph.edges),
    proposals: changes,
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
  return finalizeResult(session, operationId, outcome.affected, outcome.warnings, extra);
}

export const applySessionOperation = applyOperation;
