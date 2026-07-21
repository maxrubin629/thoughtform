import { clamp } from "../fluidMaterial.js";
import { radiusForThought, wrapThought } from "../thoughtSizing.js";
import { connectionEdgeKey } from "./connectionMotion.js";

const ACTOR_LABELS = {
  you: "You",
  partner: "Partner",
  curator: "Partner",
};

function monotonicNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function heatAtForClock(value, now) {
  if (!value) return undefined;
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) return undefined;
  return now - Math.max(Date.now() - epoch, 0);
}

function visualSources(sources = []) {
  return sources.map((source) => ({
    utteranceId: source.utterance_id,
    span: [source.start, source.end],
    quote: source.quote,
  }));
}

export function visualizeSession(
  session,
  previousNodes = [],
  previousEdges = [],
  previousCommittedPositions = new Map(),
  now = monotonicNow(),
  { animateNew = true } = {},
) {
  const oldNodes = new Map(previousNodes.filter((node) => !node.ghost).map((node) => [node.id, node]));
  const oldEdges = new Map(previousEdges.filter((edge) => !edge.ghost).map((edge) => [edge.id ?? `${edge.from}:${edge.to}`, edge]));
  const committedPositions = new Map();

  const nodes = (session?.nodes ?? []).map((node) => {
    const previous = oldNodes.get(node.id);
    const committed = previousCommittedPositions.get(node.id);
    const serverMoved = !committed || committed.x !== node.x || committed.y !== node.y;
    const heatAt = heatAtForClock(node.heat_at, now);
    const lines = wrapThought(node.text);
    const initialFallback = node.depth === 0 ? 82 : 46;
    const targetR = radiusForThought(lines, previous?.r ?? initialFallback, false);
    committedPositions.set(node.id, { x: node.x, y: node.y });
    const visualNode = {
      ...(previous ?? {}),
      id: node.id,
      text: node.text,
      lines,
      depth: clamp(node.depth ?? 2, 0, 4),
      x: previous && !serverMoved ? previous.x : node.x,
      y: previous && !serverMoved ? previous.y : node.y,
      r: previous?.text === node.text ? previous?.r ?? targetR : targetR,
      targetR,
      vx: previous?.vx ?? 0,
      vy: previous?.vy ?? 0,
      heatAt,
      sources: visualSources(node.sources),
      provenance: node.sources?.length ? "Transcript source" : `Added by ${ACTOR_LABELS[node.created_by] ?? "Partner"}`,
      createdBy: node.created_by,
      createdAt: previous?.createdAt ?? (animateNew ? now : now - 2_000),
      updatedAt: node.updated_at,
      ghost: false,
    };
    return visualNode;
  });

  let newEdgeIndex = 0;
  const addedEdges = [];
  const edges = (session?.edges ?? []).map((edge) => {
    const key = edge.id ?? `${edge.from}:${edge.to}`;
    const previous = oldEdges.get(key);
    const createdAt = previous?.createdAt
      ?? (animateNew ? now + newEdgeIndex * 160 : now - 2_000);
    if (!previous) newEdgeIndex += 1;
    const visualEdge = {
      ...(previous ?? {}),
      id: edge.id,
      from: edge.from,
      to: edge.to,
      createdBy: edge.created_by,
      createdAt,
      bend: previous?.bend ?? 0,
      ghost: false,
    };
    if (!previous) addedEdges.push(visualEdge);
    return visualEdge;
  });

  const nextEdgeKeys = new Set(edges.map(connectionEdgeKey));
  const removedEdges = previousEdges
    .filter((edge) => !edge.ghost && !nextEdgeKeys.has(connectionEdgeKey(edge)));

  return { nodes, edges, committedPositions, addedEdges, removedEdges };
}

function operationType(operation) {
  return operation.type ?? operation.kind ?? operation.action;
}

function operationEndpoints(operation) {
  return {
    from: operation.from
      ?? operation.from_id
      ?? operation.source_id
      ?? operation.parent
      ?? operation.parent_id
      ?? operation.parent_reference,
    to: operation.to ?? operation.to_id ?? operation.target_id ?? operation.node_id,
  };
}

export function proposalVisuals(proposals = [], nodes = []) {
  const committed = new Map(nodes.filter((node) => !node.ghost).map((node) => [node.id, node]));
  const ghostNodes = [];
  const ghostEdges = [];

  proposals.filter((proposal) => proposal.status === "pending").forEach((proposal, proposalIndex) => {
    (proposal.operations ?? []).filter((operation) => !operation.excluded).forEach((operation, operationIndex) => {
      const type = operationType(operation);
      const endpoints = operationEndpoints(operation);
      if (type === "connect_bubbles" || type === "connect" || type === "create_edge") {
        if (committed.has(endpoints.from) && committed.has(endpoints.to)) {
          ghostEdges.push({
            id: `proposal-edge-${proposal.id}-${operation.id ?? operationIndex}`,
            from: endpoints.from,
            to: endpoints.to,
            bend: 14 + operationIndex * 5,
            ghost: true,
            proposalId: proposal.id,
          });
        }
        return;
      }
      if (type !== "create_bubble" && type !== "create_node") return;
      const parent = committed.get(endpoints.from);
      const ghostId = operation.node_id ?? `proposal-node-${proposal.id}-${operation.id ?? operationIndex}`;
      const angle = -0.75 + proposalIndex * 0.52 + operationIndex * 0.7;
      const radius = 58;
      const x = Number.isFinite(operation.x)
        ? operation.x
        : clamp((parent?.x ?? 730) + Math.cos(angle) * ((parent?.r ?? 60) + 135), radius + 24, 1576 - radius - 24);
      const y = Number.isFinite(operation.y)
        ? operation.y
        : clamp((parent?.y ?? 500) + Math.sin(angle) * ((parent?.r ?? 60) + 135), radius + 120, 920 - radius - 24);
      ghostNodes.push({
        id: ghostId,
        x,
        y,
        r: radius,
        depth: clamp((parent?.depth ?? 1) + 1, 1, 4),
        lines: wrapThought(operation.text ?? "Partner suggestion"),
        ghost: true,
        proposalId: proposal.id,
      });
      if (parent) {
        ghostEdges.push({
          id: `proposal-edge-${proposal.id}-${operation.id ?? operationIndex}`,
          from: parent.id,
          to: ghostId,
          bend: 14,
          ghost: true,
          proposalId: proposal.id,
        });
      }
    });
  });

  return { ghostNodes, ghostEdges };
}

export function actorLabel(actor) {
  return ACTOR_LABELS[actor] ?? "Partner";
}

export function activityLabel(record) {
  if (record.label) return record.label;
  const type = operationType(record).replaceAll?.("_", " ") ?? "Updated the map";
  return type.charAt(0).toUpperCase() + type.slice(1);
}

export function proposalOperationLabel(operation) {
  const type = operationType(operation);
  const labels = {
    create_bubble: `Add “${operation.text ?? "thought"}”`,
    create_node: `Add “${operation.text ?? "thought"}”`,
    edit_bubble: `Edit ${operation.node_id ?? "a bubble"}`,
    connect_bubbles: "Connect two bubbles",
    connect: "Connect two bubbles",
    delete_bubble: `Delete ${operation.node_id ?? "a bubble"}`,
    delete_connection: "Remove a connection",
    disconnect: "Remove a connection",
  };
  return labels[type] ?? activityLabel(operation);
}
