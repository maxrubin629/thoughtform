import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import { applyOperation } from "./sessionOperations.mjs";
import {
  DEFAULT_MAP_CONTROLLER_MODEL,
  MAP_CONTROLLER_EVIDENCE_SCHEMA,
  MAP_CONTROLLER_OUTPUT_SCHEMA,
  MAP_CONTROLLER_SYSTEM,
  SEARCH_TRANSCRIPT_TOOL,
  MapControllerError,
  assertEvidenceWithinWatermark,
  buildMapControllerEnvelope,
  developerEvidenceInput,
  mapControllerOutputFormat,
  mapControllerResponseFunctionCalls,
  parseAndValidateMapControllerResponse,
  searchTranscript,
} from "./mapControllerProtocol.mjs";
import { createMapControllerScheduler } from "./mapControllerScheduler.mjs";

export {
  DEFAULT_MAP_CONTROLLER_MODEL,
  MAP_CONTROLLER_EVIDENCE_SCHEMA,
  MAP_CONTROLLER_OUTPUT_SCHEMA,
  MAP_CONTROLLER_SYSTEM,
  SEARCH_TRANSCRIPT_TOOL,
  MapControllerError,
  createMapControllerScheduler,
  searchTranscript,
};

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

function safePart(value) {
  return String(value ?? "id").replace(/[^A-Za-z0-9_-]/g, "-").replace(/^-+/, "") || "id";
}

function nowDate(now) {
  const value = now();
  return value instanceof Date ? value : new Date(value);
}

function operationReference(value, temporary) {
  if (typeof value !== "string") return value;
  const candidates = [value, value.replace(/^temp:/, ""), value.replace(/^\$/, "")];
  for (const candidate of candidates) {
    if (temporary.has(candidate)) return temporary.get(candidate);
  }
  return value;
}

function operationWithResolvedEvidence(operation, temporary, assignedNodeId) {
  const resolved = {
    type: operation.type,
    ...(operation.text !== null && operation.text !== undefined ? { text: operation.text } : {}),
    ...(operation.node_id ? { node_id: operationReference(operation.node_id, temporary) } : {}),
    ...(operation.from ? { from: operationReference(operation.from, temporary) } : {}),
    ...(operation.to ? { to: operationReference(operation.to, temporary) } : {}),
    ...(operation.parent ? { parent: operationReference(operation.parent, temporary) } : {}),
    ...(assignedNodeId && operation.type !== "set_central_idea" ? { node_id: assignedNodeId } : {}),
  };
  if (operation.evidence?.length) resolved.sources = operation.evidence;
  return resolved;
}

function assignTemporaryNodes(operations, temporary, allocateNodeId) {
  return operations.map((operation) => {
    const createsNode = operation.type === "create_bubble"
      || (operation.type === "set_central_idea" && operation.text && !operation.node_id);
    let assignedNodeId = null;
    if (createsNode) {
      assignedNodeId = operation.node_id || allocateNodeId();
      if (operation.temp_id) {
        if (temporary.has(operation.temp_id)) {
          throw new MapControllerError(`Duplicate temporary reference ${operation.temp_id}.`, { code: "invalid_output" });
        }
        temporary.set(operation.temp_id, assignedNodeId);
      }
    } else if (operation.temp_id) {
      throw new MapControllerError("temp_id is valid only for an operation that creates a bubble.", {
        code: "invalid_output",
      });
    }
    return { operation, assignedNodeId };
  });
}

function applyControllerDecision(current, decision, {
  baseRevision,
  start,
  watermark,
  runId,
  now,
  allowedUtteranceIds,
}) {
  if (current.revision !== baseRevision) throw new MapControllerRevisionConflict(baseRevision, current.revision);
  if (current.map_controller.processed_transcript_count !== start) {
    throw new MapControllerRevisionConflict(baseRevision, current.revision);
  }
  assertEvidenceWithinWatermark(decision, allowedUtteranceIds);
  let next = structuredClone(current);
  let serial = 0;
  const temporary = new Map();
  const reducerId = (kind) => `${safePart(runId)}-${safePart(kind)}-${++serial}`;
  const allocateNodeId = () => reducerId("node");
  const direct = assignTemporaryNodes(decision.operations, temporary, allocateNodeId);
  const preparedDirect = direct.map(({ operation, assignedNodeId }) => ({
    operation: operationWithResolvedEvidence(operation, temporary, assignedNodeId),
    assignedNodeId,
  }));

  for (const [index, prepared] of preparedDirect.entries()) {
    const { operation, assignedNodeId } = prepared;
    let assignedNodeReturned = false;
    const operationIdFactory = (kind) => {
      if (kind === "node" && assignedNodeId && !assignedNodeReturned) {
        assignedNodeReturned = true;
        return assignedNodeId;
      }
      return reducerId(kind);
    };
    const result = applyOperation(next, {
      ...operation,
      actor: "partner",
      origin: "map_controller",
      call_id: `map-controller-${safePart(runId)}-direct-${index + 1}`,
      expected_revision: next.revision,
    }, { now, idFactory: operationIdFactory });
    next = result.session;
  }

  if (decision.proposal) {
    const proposalTemporary = new Map(temporary);
    const proposed = assignTemporaryNodes(decision.proposal.operations, proposalTemporary, allocateNodeId)
      .map(({ operation, assignedNodeId }) => (
        operationWithResolvedEvidence(operation, proposalTemporary, assignedNodeId)
      ));
    const result = applyOperation(next, {
      type: "propose_changes",
      actor: "partner",
      origin: "map_controller",
      call_id: `map-controller-${safePart(runId)}-proposal`,
      expected_revision: next.revision,
      base_revision: baseRevision,
      rationale: decision.proposal.rationale,
      evidence: decision.proposal.evidence,
      operations: proposed,
    }, { now, idFactory: reducerId });
    next = result.session;
  }

  const successAt = nowDate(now).toISOString();
  next.map_controller = {
    processed_transcript_count: watermark,
    last_run_id: runId,
    last_success_at: successAt,
    last_error: null,
  };
  next.updated_at = successAt;
  return next;
}

function transientCode(error) {
  return error?.code ?? error?.status ?? error?.name ?? "map_controller_error";
}

export function createMapController({
  env = process.env,
  client,
  now = () => new Date(),
  idFactory = (kind) => `${kind}-${randomUUID()}`,
  loadSnapshot,
  transact,
  maxConflictReruns = 4,
} = {}) {
  if (typeof loadSnapshot !== "function" || typeof transact !== "function") {
    throw new TypeError("Map controller requires loadSnapshot and transact callbacks.");
  }
  const model = env.OPENAI_MAP_CONTROLLER_MODEL ?? DEFAULT_MAP_CONTROLLER_MODEL;
  let openai = client;

  const api = async () => {
    if (openai) return openai;
    if (!env.OPENAI_API_KEY) throw new MapControllerError("OPENAI_API_KEY is required for the map controller.", {
      code: "missing_api_key",
    });
    openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
    return openai;
  };

  const requestDecision = async (snapshot, envelope, searchBudget, signal, repairMessage = null) => {
    const openaiClient = await api();
    let response = await openaiClient.responses.create({
      model,
      reasoning: { effort: "low" },
      instructions: MAP_CONTROLLER_SYSTEM,
      input: developerEvidenceInput(envelope, repairMessage),
      ...(searchBudget.remaining > 0 ? { tools: [SEARCH_TRANSCRIPT_TOOL] } : {}),
      text: mapControllerOutputFormat(),
    }, { signal });
    while (searchBudget.remaining > 0) {
      const calls = mapControllerResponseFunctionCalls(response);
      if (!calls.length) break;
      if (calls.length !== 1) {
        throw new MapControllerError("Map controller may call search_transcript only once per round.", {
          code: "invalid_output",
        });
      }
      const call = calls[0];
      searchBudget.remaining -= 1;
      let query;
      try {
        ({ query } = JSON.parse(call.arguments));
      } catch (cause) {
        throw new MapControllerError("search_transcript received invalid arguments.", {
          code: "invalid_output",
          cause,
        });
      }
      const searchableTranscript = (snapshot.transcript ?? []).slice(0, envelope.transcript_watermark);
      const output = JSON.stringify({ matches: searchTranscript(searchableTranscript, query) });
      response = await openaiClient.responses.create({
        model,
        reasoning: { effort: "low" },
        instructions: MAP_CONTROLLER_SYSTEM,
        previous_response_id: response.id,
        input: [{ type: "function_call_output", call_id: call.call_id, output }],
        ...(searchBudget.remaining > 0 ? { tools: [SEARCH_TRANSCRIPT_TOOL] } : {}),
        text: mapControllerOutputFormat(),
      }, { signal });
    }
    return parseAndValidateMapControllerResponse(response);
  };

  return {
    model,
    async run(sessionId, { watermark: requestedWatermark, signal } = {}) {
      if (signal?.aborted) throw signal.reason ?? new Error("Map controller run cancelled.");
      const opening = await loadSnapshot(sessionId);
      const start = opening.map_controller.processed_transcript_count;
      const watermark = Math.min(
        requestedWatermark ?? opening.transcript.length,
        opening.transcript.length,
      );
      if (watermark <= start) {
        return { decision: "no_change", skipped: true, watermark, revision: opening.revision };
      }
      const runId = safePart(idFactory("map-controller-run"));
      let conflictCount = 0;
      let repairMessage = null;
      let repairUsed = false;
      const searchBudget = { remaining: 2 };

      while (true) {
        if (signal?.aborted) throw signal.reason ?? new Error("Map controller run cancelled.");
        const snapshot = await loadSnapshot(sessionId);
        if (snapshot.map_controller.processed_transcript_count >= watermark) {
          return { decision: "no_change", skipped: true, watermark, revision: snapshot.revision };
        }
        const envelope = buildMapControllerEnvelope(snapshot, start, watermark);
        const allowedUtteranceIds = new Set(
          (snapshot.transcript ?? []).slice(0, watermark).map(({ id }) => id),
        );
        try {
          const decision = await requestDecision(snapshot, envelope, searchBudget, signal, repairMessage);
          assertEvidenceWithinWatermark(decision, allowedUtteranceIds);
          if (signal?.aborted) throw signal.reason ?? new Error("Map controller run cancelled.");
          const outcome = await transact(sessionId, (current) => {
            if (signal?.aborted) throw signal.reason ?? new Error("Map controller run cancelled.");
            return {
              session: applyControllerDecision(current, decision, {
                baseRevision: snapshot.revision,
                start,
                watermark,
                runId,
                now,
                allowedUtteranceIds,
              }),
            };
          });
          const persisted = outcome?.session ?? outcome;
          return {
            decision: decision.decision,
            run_id: runId,
            watermark,
            revision: persisted.revision,
            session: persisted,
          };
        } catch (error) {
          if (error instanceof MapControllerRevisionConflict) {
            conflictCount += 1;
            if (conflictCount <= maxConflictReruns) {
              repairMessage = null;
              continue;
            }
            throw error;
          }
          const invalidDecision = error?.code === "invalid_output"
            || error?.code === "invalid_operation"
            || error?.name === "SessionOperationError";
          if (invalidDecision) {
            if (!repairUsed) {
              repairUsed = true;
              repairMessage = `Repair the prior invalid decision. Return a fresh complete decision. Server validation error: ${error.message}`;
              continue;
            }
            throw new MapControllerError(
              `Map controller decision remained invalid after one repair: ${error.message}`,
              { code: "controller_decision_invalid", cause: error, retryable: false },
            );
          }
          throw error;
        }
      }
    },
    async recordFailure(sessionId, error) {
      const at = nowDate(now).toISOString();
      return transact(sessionId, (current) => ({
        session: {
          ...current,
          updated_at: at,
          map_controller: {
            ...current.map_controller,
            last_error: {
              code: String(transientCode(error)),
              message: String(error?.message ?? "Map controller failed"),
              at,
            },
          },
        },
      }));
    },
  };
}
