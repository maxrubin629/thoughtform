import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import { PROPOSAL_OPERATION_SCHEMA } from "./mapTools.mjs";
import { jsonSchemaFormat, strictObjectSchema } from "./aiProtocol.mjs";
import { completedUserTurns, preferencesAllowCurator } from "./curatorScheduler.mjs";

export { createCuratorScheduler } from "./curatorScheduler.mjs";

export const CURATOR_SYSTEM = `You are Thoughtform's silent creative curator. You inspect the current canonical mind map and a bounded window of recent conversation, then decide whether one genuinely useful new direction is worth the user's attention.

You are proposal-only. Never claim that an operation was applied, never address the user, and never mutate state directly. The product presents all assistant-side work under the single user-facing identity Partner; “curator” is an internal actor label only.

Rules:
- Think beyond transcription. Look for a missing implication, productive tension, unstated assumption, alternative, or non-obvious connection that the user has not already expressed.
- Prefer no proposal to a weak, obvious, repetitive, or merely paraphrased idea. Returning an empty operations array should be common.
- Surface only the single strongest direction and use at most three operations that form one understandable atomic review card.
- Ground the direction in actual map content. Transcript evidence identifies the recent context that inspired it; it does not mean the proposed idea must repeat that text.
- Use create_bubble, edit_bubble, revisit_bubble, connect_bubbles, delete_bubble, or delete_connection. Fill irrelevant nullable fields with null and excluded with false.
- Do not duplicate an existing node or connection. Do not target missing endpoints, a pending/ghost node, or the protected starting anchor for deletion.
- Parked bubbles were deliberately kept aside. Do not propose changes to them or new connections to them.
- Treat deletion and reinterpretation conservatively. If evidence is weak or ambiguous, omit that operation.
- Every evidence entry must pair a completed utterance id with one exact quote from that utterance. The server resolves its character span.
- Rationale should be one concise user-facing sentence and should not mention internal orchestration, schemas, revisions, or model names.`;

export const CURATOR_EVIDENCE_SCHEMA = strictObjectSchema({
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
});

export const CURATOR_PROPOSAL_SCHEMA = strictObjectSchema({
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
    maxItems: 3,
    items: PROPOSAL_OPERATION_SCHEMA,
    description: "A reviewable atomic batch. Return an empty array when no worthwhile proposal exists.",
  },
});

export function isCuratorEnabled(env = process.env) {
  return String(env.THOUGHTFORM_CURATOR_ENABLED ?? "true").toLowerCase() === "true";
}

export function shouldRunCurator(snapshot, { minimumUserTurns = 2, maximumSurfacedProposals = 3 } = {}) {
  if (!snapshot || !Number.isInteger(snapshot.revision)) return false;
  if (!preferencesAllowCurator(snapshot)) return false;
  if (completedUserTurns(snapshot).length < minimumUserTurns) return false;
  const proposals = snapshot.proposals ?? [];
  if (proposals.some((proposal) => proposal?.status === "pending")) return false;
  const surfaced = proposals.filter((proposal) => proposal?.actor === "curator").length;
  return surfaced < maximumSurfacedProposals;
}

function compactSnapshot(snapshot) {
  return {
    id: snapshot.id,
    title: snapshot.title,
    revision: snapshot.revision,
    transcript: (snapshot.transcript ?? []).slice(-8),
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
  const fields = ["node_id", "from", "to", "edge_id", "text", "parent", "quote", "utterance_id"];
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
  const parked = new Set((snapshot.nodes ?? []).filter((node) => node.parked).map((node) => node.id));
  if (result.operations.some((operation) => (
    [operation.node_id, operation.from, operation.to, operation.parent].some((id) => parked.has(id))
  ))) return null;
  return {
    id: idFactory("proposal"),
    status: "pending",
    base_revision: snapshot.revision,
    actor: "curator",
    rationale: String(result.rationale ?? "A possible map refinement").trim(),
    evidence: resolveEvidence(result.evidence, snapshot.transcript),
    operations: result.operations.slice(0, 3).map((operation) => normalizeOperation(operation, idFactory)),
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
  const model = env.OPENAI_CURATOR_MODEL ?? "gpt-5.6-terra";
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
        reasoning: { effort: "medium" },
        instructions: CURATOR_SYSTEM,
        input: JSON.stringify(compactSnapshot(snapshot)),
        text: jsonSchemaFormat("thoughtform_curator_proposal", CURATOR_PROPOSAL_SCHEMA),
      });

      return normalizeProposal(parseOutput(response), snapshot, { now, idFactory });
    },
  };
}
