import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import { PROPOSAL_OPERATION_SCHEMA } from "./realtime.mjs";

export const CURATOR_SYSTEM = `You are Thoughtform's silent background map curator. You inspect a complete canonical conversation and mind-map snapshot and may propose a small, coherent batch of improvements for review.

You are proposal-only. Never claim that an operation was applied, never address the user, and never mutate state directly. The product presents all assistant-side work under the single user-facing identity Partner; “curator” is an internal actor label only.

Rules:
- Ground every proposal in actual node ids, edge ids, and completed transcript evidence from the snapshot.
- Prefer no proposal to a weak one. Return an empty operations array when the map needs no useful structural change.
- Propose at most five operations that form one understandable atomic review card.
- Use create_bubble, edit_bubble, revisit_bubble, connect_bubbles, delete_bubble, or delete_connection. Fill irrelevant nullable fields with null and excluded with false.
- Do not duplicate an existing node or connection. Do not target missing endpoints, a pending/ghost node, or the protected starting anchor for deletion.
- Treat deletion and reinterpretation conservatively. If evidence is weak or ambiguous, omit that operation.
- Every evidence entry must pair a completed utterance id with one exact quote from that utterance. The server resolves its character span.
- Rationale should be one concise user-facing sentence and should not mention internal orchestration, schemas, revisions, or model names.`;

export const CURATOR_EVIDENCE_SCHEMA = {
  type: "object",
  properties: {
    utterance_id: {
      type: "string",
      minLength: 1,
      description: "The id of the completed transcript utterance containing the quote.",
    },
    quote: {
      type: "string",
      minLength: 1,
      description: "An exact, uniquely occurring quote copied from that utterance.",
    },
  },
  required: ["utterance_id", "quote"],
  additionalProperties: false,
};

export const CURATOR_PROPOSAL_SCHEMA = {
  type: "object",
  properties: {
    rationale: {
      type: "string",
      description: "One concise user-facing sentence explaining the proposed batch.",
    },
    evidence: {
      type: "array",
      items: CURATOR_EVIDENCE_SCHEMA,
      description: "Completed utterance ids paired with exact transcript quotes supporting the batch.",
    },
    operations: {
      type: "array",
      maxItems: 5,
      items: PROPOSAL_OPERATION_SCHEMA,
      description: "A reviewable atomic batch. Return an empty array when no worthwhile proposal exists.",
    },
  },
  required: ["rationale", "evidence", "operations"],
  additionalProperties: false,
};

export function isCuratorEnabled(env = process.env) {
  return String(env.THOUGHTFORM_CURATOR_ENABLED ?? "false").toLowerCase() === "true";
}

export function shouldRunCurator(snapshot, { minimumUserTurns = 2 } = {}) {
  if (!snapshot || !Number.isInteger(snapshot.revision)) return false;
  const completedUserTurns = (snapshot.transcript ?? [])
    .filter((utterance) => utterance?.speaker === "you" && utterance?.text?.trim())
    .length;
  if (completedUserTurns < minimumUserTurns) return false;
  return !(snapshot.proposals ?? []).some((proposal) => proposal?.status === "pending");
}

function compactSnapshot(snapshot) {
  return {
    id: snapshot.id,
    title: snapshot.title,
    revision: snapshot.revision,
    transcript: snapshot.transcript ?? [],
    nodes: snapshot.nodes ?? [],
    edges: snapshot.edges ?? [],
    proposals: snapshot.proposals ?? [],
    selection: snapshot.ui_context?.selected_node_ids ?? snapshot.selected_node_ids ?? [],
  };
}

function parseOutput(response) {
  if (typeof response?.output_text !== "string" || !response.output_text.trim()) {
    throw new Error("Curator returned no structured output");
  }
  try {
    return JSON.parse(response.output_text);
  } catch {
    throw new Error("Curator returned invalid structured output");
  }
}

function normalizeOperation(operation, idFactory) {
  const fields = [
    "node_id",
    "from",
    "to",
    "edge_id",
    "text",
    "parent",
    "quote",
    "utterance_id",
  ];
  const normalized = {
    id: operation?.id?.trim() || idFactory("proposal_operation"),
    type: operation?.type,
    excluded: Boolean(operation?.excluded),
    depth: Number.isInteger(operation?.depth) ? operation.depth : null,
    x: Number.isFinite(operation?.x) ? operation.x : null,
    y: Number.isFinite(operation?.y) ? operation.y : null,
  };
  fields.forEach((field) => {
    normalized[field] = typeof operation?.[field] === "string" && operation[field].trim()
      ? operation[field].trim()
      : null;
  });
  return normalized;
}

function resolveEvidence(evidence, transcript) {
  const utterances = new Map((transcript ?? []).map((utterance) => [utterance.id, utterance]));
  const seen = new Set();
  return (evidence ?? []).flatMap((item) => {
    const utterance = utterances.get(item?.utterance_id);
    const quote = typeof item?.quote === "string" ? item.quote : "";
    if (!utterance || !quote) return [];
    const start = utterance.text.indexOf(quote);
    if (start < 0 || utterance.text.indexOf(quote, start + 1) >= 0) return [];
    const key = `${utterance.id}:${start}:${quote.length}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{
      utterance_id: utterance.id,
      start,
      end: start + quote.length,
      quote,
    }];
  });
}

function normalizeProposal(result, snapshot, { now, idFactory }) {
  if (!Array.isArray(result?.operations) || result.operations.length === 0) return null;
  return {
    id: idFactory("proposal"),
    status: "pending",
    base_revision: snapshot.revision,
    actor: "curator",
    rationale: String(result.rationale ?? "A possible map refinement").trim(),
    evidence: resolveEvidence(result.evidence, snapshot.transcript),
    operations: result.operations.slice(0, 5).map((operation) => normalizeOperation(operation, idFactory)),
    created_at: now().toISOString(),
  };
}

export function createCurator({
  env = process.env,
  client,
  now = () => new Date(),
  idFactory = (prefix) => `${prefix}_${randomUUID()}`,
  minimumUserTurns = 2,
} = {}) {
  const enabled = isCuratorEnabled(env);
  const model = env.OPENAI_CURATOR_MODEL ?? env.OPENAI_MODEL ?? "gpt-5.6";
  let openai = client;

  return {
    enabled,
    model,
    shouldRun: (snapshot) => enabled && shouldRunCurator(snapshot, { minimumUserTurns }),
    async propose(snapshot) {
      if (!enabled || !shouldRunCurator(snapshot, { minimumUserTurns })) return null;
      if (!openai) {
        if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required when the curator is enabled");
        openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
      }

      const response = await openai.responses.create({
        model,
        reasoning: { effort: "low" },
        instructions: CURATOR_SYSTEM,
        input: JSON.stringify(compactSnapshot(snapshot)),
        text: {
          format: {
            type: "json_schema",
            name: "thoughtform_curator_proposal",
            strict: true,
            schema: CURATOR_PROPOSAL_SCHEMA,
          },
        },
      });

      return normalizeProposal(parseOutput(response), snapshot, { now, idFactory });
    },
  };
}

// The server can call notify(sessionId) after a completed user turn. Debouncing
// happens per session; the latest canonical snapshot is loaded only when idle.
export function createCuratorScheduler({
  curator,
  loadSnapshot,
  onProposal,
  onError = (error) => console.error(error),
  idleMs = 1_500,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (!curator || typeof loadSnapshot !== "function" || typeof onProposal !== "function") {
    throw new TypeError("Curator scheduler requires curator, loadSnapshot, and onProposal");
  }
  const timers = new Map();
  const lastRunFingerprint = new Map();

  const snapshotFingerprint = (snapshot) => {
    const latestUserTurn = [...(snapshot.transcript ?? [])]
      .reverse()
      .find((utterance) => utterance?.speaker === "you");
    return `${snapshot.revision}:${snapshot.transcript?.length ?? 0}:${latestUserTurn?.id ?? "none"}`;
  };

  const cancel = (sessionId) => {
    const timer = timers.get(sessionId);
    if (timer !== undefined) clearTimer(timer);
    timers.delete(sessionId);
  };

  const notify = (sessionId) => {
    cancel(sessionId);
    if (!curator.enabled) return false;
    const timer = setTimer(async () => {
      timers.delete(sessionId);
      try {
        const snapshot = await loadSnapshot(sessionId);
        const fingerprint = snapshotFingerprint(snapshot);
        if (!curator.shouldRun(snapshot) || lastRunFingerprint.get(sessionId) === fingerprint) return;
        const proposal = await curator.propose(snapshot);
        lastRunFingerprint.set(sessionId, fingerprint);
        if (proposal) await onProposal(sessionId, proposal);
      } catch (error) {
        onError(error, sessionId);
      }
    }, idleMs);
    timers.set(sessionId, timer);
    return true;
  };

  const dispose = () => {
    [...timers.keys()].forEach(cancel);
  };

  return { notify, cancel, dispose };
}
