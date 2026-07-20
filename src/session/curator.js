// The simulated background curator (the gpt-5.6-sol role): looks at the whole
// map between conversational beats and proposes structure — never applies it.
// Every proposal is a batch of ops pinned to the map revision it was computed
// against, with a human-readable rationale and transcript evidence. Accepting
// rebases against the live map first; ops whose referents moved on are
// dropped, and an empty rebase means the proposal is stale.
//
// Replace `analyzeMap` with a model call through the Thoughtform MCP; the
// proposal contract (baseRev + ops + rationale + evidence) stays the same.

import { informativeTokens, overlapScore } from "./condense.js";

const THINKING_DELAY_MS = 1100;
const MAX_OPS = 3;

let proposalCounter = 0;

function bubbleTokens(node) {
  return informativeTokens((node.lines ?? []).join(" "));
}

function evidenceOf(...nodes) {
  const ids = [];
  nodes.forEach((node) => {
    (node.sources ?? []).forEach((sourceRef) => {
      if (!ids.includes(sourceRef.utteranceId)) ids.push(sourceRef.utteranceId);
    });
  });
  return ids;
}

function analyzeMap(nodes, edges) {
  const committed = nodes.filter((node) => !node.ghost);
  if (committed.length < 3) return null;
  const tokens = new Map(committed.map((node) => [node.id, bubbleTokens(node)]));
  const degree = new Map();
  const linked = new Set();
  edges.forEach((edge) => {
    if (edge.ghost) return;
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
    linked.add(`${edge.from}:${edge.to}`);
    linked.add(`${edge.to}:${edge.from}`);
  });
  const ops = [];
  const spokenFor = new Set();

  // Unplaced bubbles (the anchor included — it can be the stranded one when
  // later ideas cluster among themselves): find each a best-evidence home.
  committed.forEach((node) => {
    if (ops.length >= MAX_OPS) return;
    if ((degree.get(node.id) ?? 0) > 0 || spokenFor.has(node.id)) return;
    let best = null;
    committed.forEach((candidate) => {
      if (candidate.id === node.id || spokenFor.has(candidate.id)) return;
      const score = overlapScore(tokens.get(node.id), tokens.get(candidate.id));
      const placed = (degree.get(candidate.id) ?? 0) > 0;
      const rank = score + (placed ? 0.5 : 0);
      if (rank > (best?.rank ?? 0.4)) best = { candidate, score, rank };
    });
    // Fallback: nothing shares vocabulary — offer the biggest other bubble.
    const home = best?.candidate
      ?? committed.filter((candidate) => candidate.id !== node.id)
        .sort((a, b) => (b.r ?? 0) - (a.r ?? 0))[0];
    if (!home) return;
    spokenFor.add(node.id);
    spokenFor.add(home.id);
    ops.push({
      type: "connect",
      from: home.id,
      to: node.id,
      reason: best?.score
        ? `“${node.lines.join(" ")}” shares its subject with “${home.lines.join(" ")}”`
        : `“${node.lines.join(" ")}” is floating free — it may belong with “${home.lines.join(" ")}”`,
      evidence: evidenceOf(node, home),
    });
  });

  // Related-but-unlinked pairs elsewhere in the map.
  for (let a = 0; a < committed.length && ops.length < MAX_OPS; a += 1) {
    for (let b = a + 1; b < committed.length && ops.length < MAX_OPS; b += 1) {
      const nodeA = committed[a];
      const nodeB = committed[b];
      if (linked.has(`${nodeA.id}:${nodeB.id}`)) continue;
      if ((degree.get(nodeA.id) ?? 0) === 0 || (degree.get(nodeB.id) ?? 0) === 0) continue;
      if (ops.some((op) => op.to === nodeB.id || op.to === nodeA.id)) continue;
      const score = overlapScore(tokens.get(nodeA.id), tokens.get(nodeB.id));
      if (score >= 2) {
        ops.push({
          type: "connect",
          from: nodeA.id,
          to: nodeB.id,
          reason: `“${nodeA.lines.join(" ")}” and “${nodeB.lines.join(" ")}” may be the same thread`,
          evidence: evidenceOf(nodeA, nodeB),
        });
      }
    }
  }

  return ops.length ? ops : null;
}

export function runCurator({ nodes, edges, rev }) {
  return new Promise((resolve) => {
    window.setTimeout(() => {
      const ops = analyzeMap(nodes, edges);
      if (!ops) {
        resolve(null);
        return;
      }
      proposalCounter += 1;
      resolve({
        id: `proposal-${proposalCounter}`,
        actor: "curator",
        baseRev: rev,
        ops,
        rationale: ops.map((op) => op.reason).join(". "),
        evidence: [...new Set(ops.flatMap((op) => op.evidence))],
        status: "pending",
      });
    }, THINKING_DELAY_MS);
  });
}

// Drops ops whose referents no longer exist or that duplicate a live edge.
// Called at accept time — the map may have moved since baseRev.
export function rebaseProposal(proposal, nodes, edges) {
  const alive = new Set(nodes.filter((node) => !node.ghost).map((node) => node.id));
  const linked = new Set();
  edges.forEach((edge) => {
    if (edge.ghost) return;
    linked.add(`${edge.from}:${edge.to}`);
    linked.add(`${edge.to}:${edge.from}`);
  });
  const accepted = new Set();
  return proposal.ops.filter((op) => {
    const key = String(op.from) < String(op.to)
      ? `${op.from}:${op.to}`
      : `${op.to}:${op.from}`;
    const valid = op.type === "connect"
      && op.from !== op.to
      && alive.has(op.from)
      && alive.has(op.to)
      && !linked.has(`${op.from}:${op.to}`)
      && !accepted.has(key);
    if (valid) accepted.add(key);
    return valid;
  });
}
