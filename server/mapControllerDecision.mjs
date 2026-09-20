import { applyOperation } from "./sessionOperations.mjs";
import { MapControllerError, assertEvidenceWithinWatermark } from "./mapControllerProtocol.mjs";

export class MapControllerRevisionConflict extends MapControllerError {
  constructor(expected, actual) {
    super(`Map revision changed from ${expected} to ${actual} while the controller was running.`, {
      code: "revision_conflict",
      retryable: true,
    });
    this.expected_revision = expected;
    this.current_revision = actual;
  }
}

export function safePart(value) {
  return String(value ?? "id").replace(/[^A-Za-z0-9_-]/g, "-").replace(/^-+/, "") || "id";
}

function operationReference(value, temporary) {
  if (typeof value !== "string") return value;
  const candidates = [value, value.replace(/^temp:/, ""), value.replace(/^\$/, "")];
  for (const candidate of candidates) {
    if (temporary.has(candidate)) return temporary.get(candidate);
  }
  return value;
}

/** Allocate every temporary id before resolving references, including forward references. */
function prepareOperations(operations, temporary, allocateNodeId) {
  const assignedIds = operations.map((operation) => {
    const createsNode = operation.type === "create_bubble"
      || (operation.type === "set_central_idea" && operation.text && !operation.node_id);
    if (!createsNode) {
      if (operation.temp_id) throw new MapControllerError("temp_id is valid only for an operation that creates a bubble.", {
        code: "invalid_output",
      });
      return null;
    }
    const nodeId = operation.node_id || allocateNodeId();
    if (operation.temp_id) {
      if (temporary.has(operation.temp_id)) {
        throw new MapControllerError(`Duplicate temporary reference ${operation.temp_id}.`, { code: "invalid_output" });
      }
      temporary.set(operation.temp_id, nodeId);
    }
    return nodeId;
  });
  return operations.map((operation, index) => {
    const resolved = { type: operation.type };
    if (operation.text !== null && operation.text !== undefined) resolved.text = operation.text;
    for (const field of ["node_id", "from", "to", "parent"]) {
      if (operation[field]) resolved[field] = operationReference(operation[field], temporary);
    }
    if (assignedIds[index]) {
      resolved[operation.type === "set_central_idea" ? "new_node_id" : "node_id"] = assignedIds[index];
    }
    if (operation.evidence?.length) resolved.sources = operation.evidence;
    return resolved;
  });
}

export function applyControllerDecision(current, decision, {
  baseRevision,
  start,
  watermark,
  runId,
  now,
  allowedUtteranceIds,
}) {
  if (current.preferences?.mapping_paused) return current;
  if (current.revision !== baseRevision || current.map_controller.processed_transcript_count !== start) {
    throw new MapControllerRevisionConflict(baseRevision, current.revision);
  }
  const parked = new Set(current.nodes.filter((node) => node.parked).map((node) => node.id));
  const operations = [...decision.operations, ...(decision.proposal?.operations ?? [])];
  if (operations.some((operation) => (
    [operation.node_id, operation.from, operation.to, operation.parent].some((id) => parked.has(id))
  ))) {
    throw new MapControllerError("Parked thoughts are kept aside and cannot be changed by automatic mapping.", { code: "invalid_output" });
  }
  assertEvidenceWithinWatermark(decision, allowedUtteranceIds);
  let next = structuredClone(current);
  let serial = 0;
  const temporary = new Map();
  const reducerId = (kind) => `${safePart(runId)}-${safePart(kind)}-${++serial}`;
  const allocateNodeId = () => reducerId("node");
  const preparedDirect = prepareOperations(decision.operations, temporary, allocateNodeId);
  const commit = (suffix, operation) => {
    next = applyOperation(next, {
      ...operation,
      actor: "partner",
      origin: "map_controller",
      call_id: `map-controller-${safePart(runId)}-${suffix}`,
      expected_revision: next.revision,
    }, { now, idFactory: reducerId }).session;
  };

  if (preparedDirect.length) {
    commit("direct", { type: "apply_map_batch", label: "Organized a thought", operations: preparedDirect });
  }
  if (current.nodes.some((node) => node.parked
    && JSON.stringify(node) !== JSON.stringify(next.nodes.find(({ id }) => id === node.id)))) {
    throw new MapControllerError("Automatic mapping must preserve thoughts that the user kept aside, including the previous central idea.", { code: "invalid_output" });
  }

  if (decision.proposal) {
    const proposalTemporary = new Map(temporary);
    const proposed = prepareOperations(decision.proposal.operations, proposalTemporary, allocateNodeId);
    commit("proposal", {
      type: "propose_changes",
      base_revision: baseRevision,
      rationale: decision.proposal.rationale,
      evidence: decision.proposal.evidence,
      operations: proposed,
    });
  }

  const successAt = new Date(now()).toISOString();
  next.map_controller = {
    processed_transcript_count: watermark,
    last_run_id: runId,
    last_success_at: successAt,
    last_error: null,
  };
  next.updated_at = successAt;
  return next;
}
