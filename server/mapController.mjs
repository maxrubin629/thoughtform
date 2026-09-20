import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import { applyControllerDecision, MapControllerRevisionConflict, safePart } from "./mapControllerDecision.mjs";
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
  MapControllerRevisionConflict,
  createMapControllerScheduler,
  searchTranscript,
};

function assertNotAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new Error("Map controller run cancelled.");
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
    const request = (input, previousResponseId) => openaiClient.responses.create({
      model,
      reasoning: { effort: "medium" },
      instructions: MAP_CONTROLLER_SYSTEM,
      input,
      ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
      ...(searchBudget.remaining > 0 ? { tools: [SEARCH_TRANSCRIPT_TOOL] } : {}),
      text: mapControllerOutputFormat(),
    }, { signal });
    let response = await request(developerEvidenceInput(envelope, repairMessage));
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
      response = await request([{ type: "function_call_output", call_id: call.call_id, output }], response.id);
    }
    return parseAndValidateMapControllerResponse(response);
  };

  return {
    model,
    async run(sessionId, { watermark: requestedWatermark, signal } = {}) {
      assertNotAborted(signal);
      const opening = await loadSnapshot(sessionId);
      if (opening.preferences?.mapping_paused) {
        return { decision: "no_change", skipped: true, paused: true, revision: opening.revision };
      }
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
        assertNotAborted(signal);
        const snapshot = await loadSnapshot(sessionId);
        if (snapshot.preferences?.mapping_paused) {
          return { decision: "no_change", skipped: true, paused: true, revision: snapshot.revision };
        }
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
          assertNotAborted(signal);
          const outcome = await transact(sessionId, (current) => {
            assertNotAborted(signal);
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
          if (persisted.preferences?.mapping_paused) {
            return { decision: "no_change", skipped: true, paused: true, revision: persisted.revision, session: persisted };
          }
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
      const at = new Date(now()).toISOString();
      return transact(sessionId, (current) => ({
        session: {
          ...current,
          updated_at: at,
          map_controller: {
            ...current.map_controller,
            last_error: {
              code: String(error?.code ?? error?.status ?? error?.name ?? "map_controller_error"),
              message: String(error?.message ?? "Map controller failed"),
              at,
            },
          },
        },
      }));
    },
  };
}
