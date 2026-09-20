import { UNTITLED_SESSION_TITLE } from "./constants.mjs";
import {
  BATCH_TYPES, SAFE_ID, SessionOperationError, TranscriptPendingError,
  canonicalType, actorOf, originOf, allocateId, selectionIds, resolveNodeReference,
  textField, finiteNumber, nonnegativeInteger, nodeRef, edgeRef, sourceRef, targetRef,
} from "./operationInput.mjs";
import { exactSources, appendSources, enforceUtteranceBubbleLimit, operationProvenance } from "./provenance.mjs";

const rootNode = (session) => session.nodes.find(({ depth }) => depth === 0) ?? session.nodes[0];
const matchingNode = (session, text) => session.nodes.find((node) => node.text.trim().toLocaleLowerCase() === text.toLocaleLowerCase());
const connection = (session, from, to) => session.edges.find((edge) => (
  (edge.from === from && edge.to === to) || (edge.from === to && edge.to === from)
));
const ideaText = (operation) => textField(operation.text ?? operation.idea_text ?? operation.label, "text");
const parentRef = (operation) => operation.parent ?? operation.parent_id ?? operation.parent_reference;

function referencedNode(session, reference, context) {
  const id = resolveNodeReference(session, reference, context.selection);
  return session.nodes.find((node) => node.id === id);
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
  const anchor = rootNode(session);
  const ring = session.nodes.filter((node) => !session.edges.some((edge) => edge.to === node.id)).length;
  const angle = -0.85 + ring * 2.1;
  return {
    x: Math.max(90, Math.min(width - 90, anchor.x + Math.cos(angle) * 310)),
    y: Math.max(150, Math.min(height - 90, anchor.y + Math.sin(angle) * 310)),
  };
}

function assignDepthsFromRoot(session, rootId) {
  const neighbors = new Map(session.nodes.map(({ id }) => [id, []]));
  for (const { from, to } of session.edges) {
    neighbors.get(from).push(to);
    neighbors.get(to).push(from);
  }
  const depths = new Map([[rootId, 0]]);
  const queue = [rootId];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    for (const neighbor of neighbors.get(current)) {
      if (depths.has(neighbor)) continue;
      depths.set(neighbor, depths.get(current) + 1);
      queue.push(neighbor);
    }
  }
  for (const node of session.nodes) node.depth = depths.get(node.id) ?? Math.max(1, node.depth ?? 1);
  for (const edge of session.edges) {
    if (depths.get(edge.from) > depths.get(edge.to)) [edge.from, edge.to] = [edge.to, edge.from];
  }
}

function newNodeId(session, requestedId, context, description = "proposed") {
  const id = requestedId ?? allocateId(session, "node", context, context.reservedIds);
  if (!SAFE_ID.test(String(id)) || session.nodes.some((node) => node.id === id)) {
    throw new SessionOperationError(`The ${description} bubble ID is invalid or already exists.`, {
      code: "duplicate_node_id", status: 409, details: { node_id: id },
    });
  }
  return id;
}

function addNode(session, fields, context) {
  const node = { ...fields, created_by: context.actor, created_at: context.timestamp, updated_at: context.timestamp };
  session.nodes.push(node);
  context.reservedIds.add(node.id);
  return node;
}

function addConnection(session, from, to, context, requestedId) {
  const id = requestedId ?? allocateId(session, "edge", context, context.reservedIds);
  if (!SAFE_ID.test(String(id)) || session.edges.some((edge) => edge.id === id)) {
    throw new SessionOperationError("The connection ID is invalid or already exists.", {
      code: "duplicate_edge_id", status: 409,
    });
  }
  session.edges.push({ id, from, to, created_by: context.actor, created_at: context.timestamp });
  context.reservedIds.add(id);
  return id;
}

function removeNodes(session, ids) {
  const deleted = new Set(ids);
  const incident = (edge) => deleted.has(edge.from) || deleted.has(edge.to);
  const affected = [...ids, ...session.edges.filter(incident).map(({ id }) => id)];
  session.nodes = session.nodes.filter((node) => !deleted.has(node.id));
  session.edges = session.edges.filter((edge) => !incident(edge));
  return { changed: deleted.size > 0, affected };
}

function revisitNode(session, node, operation, context) {
  appendSources(node, exactSources(session, operation));
  node.heat_at = context.timestamp;
  node.updated_at = context.timestamp;
  return { affected: [node.id], effective_type: "revisit_bubble" };
}

function createBubble(session, operation, context) {
  const text = ideaText(operation);
  // Manual creation names a new object; transcript mapping reuses semantic ideas.
  const distinct = context.actor === "you" && !context.fromProposal && operation.create_distinct === true;
  const existing = !distinct && matchingNode(session, text);
  if (existing) {
    if (context.fromProposal) {
      throw new SessionOperationError("A bubble with the same idea already exists.", {
        code: "duplicate_node", status: 409, details: { node_id: existing.id },
      });
    }
    return {
      ...revisitNode(session, existing, operation, context),
      warnings: ["Repeated idea revisited the existing bubble instead of creating a duplicate."],
    };
  }
  const reference = parentRef(operation);
  const parent = reference === undefined || reference === null || reference === ""
    ? null : referencedNode(session, reference, context);
  const position = defaultNodePosition(session, parent);
  const id = newNodeId(session, operation.node_id ?? operation.nodeId, context);
  const sources = exactSources(session, operation);
  enforceUtteranceBubbleLimit(session, sources);
  const node = addNode(session, {
    id,
    text,
    depth: operation.depth == null ? (parent ? parent.depth + 1 : Number(session.nodes.length > 0)) : nonnegativeInteger(operation.depth, "depth"),
    x: operation.x == null ? position.x : finiteNumber(operation.x, "x"),
    y: operation.y == null ? position.y : finiteNumber(operation.y, "y"),
    ...(operation.heat_at ? { heat_at: new Date(operation.heat_at).toISOString() } : {}),
    sources,
  }, context);
  const affected = [node.id];
  if (parent) affected.push(addConnection(session, parent.id, node.id, context));
  if ((!session.title.trim() || session.title === UNTITLED_SESSION_TITLE) && session.nodes.length === 1) {
    session.title = text.length > 72 ? `${text.slice(0, 69).trimEnd()}…` : text;
  }
  return { affected };
}

function editBubble(session, operation, context) {
  const node = referencedNode(session, nodeRef(operation), context);
  const text = ideaText(operation);
  const sourceAdded = appendSources(node, exactSources(session, operation));
  const changed = node.text !== text || sourceAdded;
  node.text = text;
  if (changed) node.updated_at = context.timestamp;
  return { changed, affected: [node.id], warnings: changed ? [] : ["The bubble already has that text and provenance."] };
}

function setCentralIdea(session, operation, context) {
  const reference = nodeRef(operation);
  const hasReference = typeof reference === "string" && reference.trim().length > 0;
  const hasText = typeof operation.text === "string" && operation.text.trim().length > 0;
  if (hasReference === hasText) {
    throw new SessionOperationError("set_central_idea requires either one existing bubble reference or new bubble text, but not both.", {
      code: "invalid_central_idea_target",
    });
  }
  const beforeNodes = new Map(session.nodes.map((node) => [node.id, JSON.stringify(node)]));
  const beforeEdges = new Map(session.edges.map((edge) => [edge.id, JSON.stringify(edge)]));
  const previousRoot = rootNode(session);
  const text = hasText ? textField(operation.text, "text") : null;
  let central = hasReference ? referencedNode(session, reference, context) : matchingNode(session, text);
  const warnings = [];
  if (central) {
    appendSources(central, exactSources(session, operation));
    if (previousRoot && previousRoot !== central && !previousRoot.pinned && !central.pinned) {
      [previousRoot.x, central.x] = [central.x, previousRoot.x];
      [previousRoot.y, central.y] = [central.y, previousRoot.y];
    }
    if (hasText) warnings.push("The matching existing bubble became the central idea instead of creating a duplicate.");
  } else {
    const sources = exactSources(session, operation);
    enforceUtteranceBubbleLimit(session, sources);
    const id = newNodeId(session, operation.new_node_id, context, "central");
    const position = previousRoot && !previousRoot.pinned
      ? { x: previousRoot.x, y: previousRoot.y } : defaultNodePosition(session, previousRoot);
    central = addNode(session, { id, text, depth: 0, ...position, sources }, context);
    if (previousRoot && !previousRoot.pinned) Object.assign(previousRoot, defaultNodePosition(session, central));
  }
  assignDepthsFromRoot(session, central.id);
  const changedNodes = session.nodes.filter((node) => beforeNodes.get(node.id) !== JSON.stringify(node));
  const changedEdges = session.edges.filter((edge) => beforeEdges.get(edge.id) !== JSON.stringify(edge));
  for (const node of changedNodes) node.updated_at = context.timestamp;
  if (previousRoot === central) warnings.push("That bubble is already the central idea.");
  return {
    changed: changedNodes.length > 0,
    affected: [...(changedNodes.length ? changedNodes.map(({ id }) => id) : [central.id]), ...changedEdges.map(({ id }) => id)],
    warnings,
  };
}

function connectBubbles(session, operation, context) {
  const from = resolveNodeReference(session, sourceRef(operation), context.selection);
  const to = resolveNodeReference(session, targetRef(operation), context.selection);
  if (from === to) throw new SessionOperationError("A bubble cannot connect to itself.", { code: "self_connection" });
  if (connection(session, from, to)) {
    throw new SessionOperationError("Those bubbles are already connected.", {
      code: "duplicate_edge", status: 409, details: { from, to },
    });
  }
  return { affected: [addConnection(session, from, to, context, operation.edge_id ?? operation.edgeId), from, to] };
}

function deleteBubble(session, operation, context) {
  const id = resolveNodeReference(session, nodeRef(operation), context.selection);
  if (id === rootNode(session)?.id) {
    throw new SessionOperationError("The starting anchor cannot be deleted.", {
      code: "anchor_protected", status: 409, details: { node_id: id },
    });
  }
  return removeNodes(session, [id]);
}

function deleteConnection(session, operation, context) {
  let id = edgeRef(operation);
  if (!id && sourceRef(operation) && targetRef(operation)) {
    const from = resolveNodeReference(session, sourceRef(operation), context.selection);
    const to = resolveNodeReference(session, targetRef(operation), context.selection);
    id = connection(session, from, to)?.id;
  }
  const edge = session.edges.find((candidate) => candidate.id === id);
  if (!edge) {
    throw new SessionOperationError(`Connection “${String(id)}” does not exist.`, {
      code: "edge_not_found", status: 404, details: { edge_id: id },
    });
  }
  session.edges = session.edges.filter((candidate) => candidate.id !== id);
  return { affected: [edge.id, edge.from, edge.to] };
}

function moveBubble(session, operation, context) {
  const node = referencedNode(session, nodeRef(operation), context);
  const x = finiteNumber(operation.x, "x");
  const y = finiteNumber(operation.y, "y");
  const changed = node.x !== x || node.y !== y;
  Object.assign(node, { x, y });
  if (changed) node.updated_at = context.timestamp;
  return { changed, affected: [node.id], warnings: changed ? [] : ["The bubble is already at that position."] };
}

function bulkDeleteBubbles(session, operation, context) {
  const references = operation.node_ids ?? operation.nodeIds ?? context.selection.selected_node_ids;
  if (!Array.isArray(references) || !references.length) {
    throw new SessionOperationError("bulk_delete_bubbles requires node_ids or a non-empty selection.", { code: "missing_node_references" });
  }
  const ids = [...new Set(references.map((reference) => resolveNodeReference(session, reference, context.selection)))];
  const anchor = rootNode(session)?.id;
  return {
    ...removeNodes(session, ids.filter((id) => id !== anchor)),
    warnings: ids.includes(anchor) ? ["The starting anchor was preserved."] : [],
  };
}

function setNodeFlag(field) {
  return (session, operation, context) => {
    const node = referencedNode(session, nodeRef(operation), context);
    if (typeof operation[field] !== "boolean") {
      throw new SessionOperationError(`${field} must be a boolean.`, { code: `invalid_${field}` });
    }
    const changed = Boolean(node[field]) !== operation[field];
    if (changed) Object.assign(node, { [field]: operation[field], updated_at: context.timestamp });
    return { changed, affected: [node.id] };
  };
}

function applyMapBatch(session, operation, context) {
  if (!Array.isArray(operation.operations) || !operation.operations.length || operation.operations.length > 32) {
    throw new SessionOperationError("A map batch requires one to 32 graph operations.", { code: "invalid_map_batch" });
  }
  const outcome = { changed: false, affected: [], warnings: [], steps: [] };
  for (const child of operation.operations) {
    if (!child || typeof child !== "object" || !BATCH_TYPES.has(canonicalType(child.type))) {
      throw new SessionOperationError("Map batches may contain only graph changes.", { code: "invalid_map_batch" });
    }
    const nested = { ...child, actor: context.actor, origin: originOf(operation) };
    const realtimeItemId = nested.realtime_item_id ?? nested.source?.realtime_item_id;
    if (realtimeItemId && !session.transcript.some((utterance) => utterance.realtime_item_id === realtimeItemId)) {
      throw new TranscriptPendingError(realtimeItemId);
    }
    const result = mutateGraph(session, nested, context);
    outcome.changed ||= result.changed;
    outcome.affected.push(...result.affected);
    outcome.warnings.push(...result.warnings);
    outcome.steps.push({ type: result.effective_type, affected_ids: [...new Set(result.affected)], ...operationProvenance(session, nested) });
  }
  return outcome;
}

const GRAPH_HANDLERS = new Map([
  ["create_bubble", createBubble],
  ["edit_bubble", editBubble],
  ["set_central_idea", setCentralIdea],
  ["revisit_bubble", (session, operation, context) => revisitNode(session, referencedNode(session, nodeRef(operation), context), operation, context)],
  ["connect_bubbles", connectBubbles],
  ["delete_bubble", deleteBubble],
  ["delete_connection", deleteConnection],
  ["move_bubble", moveBubble],
  ["bulk_delete_bubbles", bulkDeleteBubbles],
  ["set_node_pinned", setNodeFlag("pinned")],
  ["set_node_parked", setNodeFlag("parked")],
  ["apply_map_batch", applyMapBatch],
]);

export function mutateGraph(session, operation, context) {
  const type = canonicalType(operation.type);
  const handler = GRAPH_HANDLERS.get(type);
  if (!handler) throw new SessionOperationError(`Unsupported map operation “${type}”.`, { code: "unsupported_operation", details: { type } });
  const inputSelection = context.inputSelection ?? context.selection;
  const result = handler(session, operation, {
    ...context,
    actor: actorOf(operation),
    inputSelection,
    selection: { selected_node_ids: selectionIds(inputSelection, operation) },
  });
  return { changed: true, warnings: [], effective_type: type, ...result };
}
