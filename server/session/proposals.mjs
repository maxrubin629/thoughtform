import {
  PROPOSABLE_TYPES, SAFE_ID, SessionOperationError, canonicalType, actorOf, allocateId,
  selectionIds, resolveNodeReference, textField, nonnegativeInteger,
  nodeRef, edgeRef, sourceRef, targetRef,
} from "./operationInput.mjs";
import { exactSource, exactSources, resolveQuoteSpan } from "./provenance.mjs";
import { mutateGraph } from "./graph.mjs";

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

export function proposeChanges(session, operation, context) {
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

function findProposal(session, operation) {
  const id = operation.proposal_id ?? operation.proposalId ?? operation.id_reference;
  const proposal = session.proposals.find((candidate) => candidate.id === id);
  if (!proposal) {
    throw new SessionOperationError(`Proposal “${String(id)}” does not exist.`, {
      code: "proposal_not_found",
      status: 404,
      details: { proposal_id: id },
    });
  }
  return proposal;
}

function pendingProposal(session, operation) {
  const proposal = findProposal(session, operation);
  const id = proposal.id;
  if (proposal.status !== "pending") {
    throw new SessionOperationError(`Proposal “${id}” is ${proposal.status}, not pending.`, {
      code: "proposal_not_pending",
      status: 409,
      details: { proposal_id: id, status: proposal.status },
    });
  }
  return proposal;
}

export function excludeProposalOperation(session, operation) {
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

export function dismissProposal(session, operation) {
  const proposal = findProposal(session, operation);
  const id = proposal.id;
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

export function acceptProposal(session, operation, context) {
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
    extra: { proposal_status: proposal.status, connection_animation_delays: animationDelays },
  };
}

