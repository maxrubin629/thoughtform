import { clamp } from "../fluidMaterial.js";
import { BASE_HEIGHT, BASE_WIDTH } from "../mapData.js";
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

const PROPOSAL_GAP = 20;

function boundedProposalPoint(x, y, radius) {
  return {
    x: clamp(x, radius + 24, BASE_WIDTH - radius - 24),
    y: clamp(y, radius + 120, BASE_HEIGHT - radius - 24),
  };
}

function proposalPointIsClear(point, radius, occupied) {
  return occupied.every((node) => (
    Math.hypot(point.x - node.x, point.y - node.y)
      >= radius + (node.r ?? 0) + PROPOSAL_GAP
  ));
}

function findProposalPoint(parent, radius, baseAngle, preferred, occupied) {
  const candidates = [boundedProposalPoint(preferred.x, preferred.y, radius)];
  const origin = parent ?? { x: BASE_WIDTH / 2, y: BASE_HEIGHT / 2, r: 0 };
  const firstDistance = (origin.r ?? 0) + radius + 70;
  const angleOffsets = [0, -0.55, 0.55, -1.1, 1.1, -1.65, 1.65, Math.PI];
  [firstDistance, firstDistance + 110, firstDistance + 220].forEach((distance) => {
    angleOffsets.forEach((offset) => {
      candidates.push(boundedProposalPoint(
        origin.x + Math.cos(baseAngle + offset) * distance,
        origin.y + Math.sin(baseAngle + offset) * distance,
        radius,
      ));
    });
  });

  const step = radius * 2 + PROPOSAL_GAP;
  for (let y = radius + 120; y <= BASE_HEIGHT - radius - 24; y += step) {
    for (let x = radius + 24; x <= BASE_WIDTH - radius - 24; x += step) {
      candidates.push({ x, y });
    }
  }

  return candidates.find((candidate) => proposalPointIsClear(candidate, radius, occupied))
    ?? candidates[0];
}

export function proposalVisuals(proposals = [], nodes = [], localPositions = new Map()) {
  const committed = new Map(nodes.filter((node) => !node.ghost).map((node) => [node.id, node]));
  const ghostNodes = [];
  const ghostEdges = [];
  const occupied = [...committed.values()];

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
      const preferred = {
        x: Number.isFinite(operation.x)
          ? operation.x
          : (parent?.x ?? 730) + Math.cos(angle) * ((parent?.r ?? 60) + 135),
        y: Number.isFinite(operation.y)
          ? operation.y
          : (parent?.y ?? 500) + Math.sin(angle) * ((parent?.r ?? 60) + 135),
      };
      const local = localPositions.get(ghostId);
      const position = local
        ? boundedProposalPoint(local.x, local.y, radius)
        : findProposalPoint(parent, radius, angle, preferred, occupied);
      const ghostNode = {
        id: ghostId,
        x: position.x,
        y: position.y,
        r: radius,
        depth: clamp((parent?.depth ?? 1) + 1, 1, 4),
        lines: wrapThought(operation.text ?? "Partner suggestion"),
        ghost: true,
        proposalId: proposal.id,
        vx: Number.isFinite(local?.vx) ? local.vx : 0,
        vy: Number.isFinite(local?.vy) ? local.vy : 0,
        dragging: Boolean(local?.dragging),
        shadeVx: Number.isFinite(local?.shadeVx) ? local.shadeVx : 0,
        shadeVy: Number.isFinite(local?.shadeVy) ? local.shadeVy : 0,
        wobblePulses: local?.wobblePulses ?? [],
        wobbleEndAt: Number.isFinite(local?.wobbleEndAt) ? local.wobbleEndAt : 0,
      };
      ghostNodes.push(ghostNode);
      occupied.push(ghostNode);
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

const MODEL_ACTION_LABELS = {
  create_bubble: "Created a bubble",
  set_central_idea: "Changed the central idea",
  edit_bubble: "Edited a bubble",
  revisit_bubble: "Revisited a bubble",
  connect_bubbles: "Created a new connection",
  delete_bubble: "Removed a bubble",
  delete_connection: "Removed a connection",
  move_bubble: "Moved a bubble",
  bulk_delete_bubbles: "Removed bubbles",
  propose_changes: "Created a proposal",
  exclude_proposal_operation: "Updated a proposal",
  dismiss_proposal: "Dismissed a proposal",
  accept_proposal: "Accepted a proposal",
  undo_map_change: "Undid a map change",
  redo_map_change: "Redid a map change",
};

export function modelActionLabel(operation) {
  return MODEL_ACTION_LABELS[operationType(operation)] ?? null;
}

export function mapControllerPresentation(controller, { activeVisible = false } = {}) {
  if (!controller) return null;
  if (controller.status === "error") {
    return { kind: "error", label: "Map organization paused" };
  }
  if (activeVisible && (controller.status === "waiting" || controller.status === "running")) {
    return { kind: "active", label: "Organizing map…" };
  }
  return null;
}

export function createMapControllerActivityDelay({
  delayMs = 2_000,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
  onChange = () => {},
} = {}) {
  let current = { sessionId: null, active: false, visible: false };
  let timer = null;
  let token = null;

  const cancelTimer = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    token = null;
  };

  const emit = (next) => {
    current = next;
    onChange({ ...current });
    return current;
  };

  const update = (session) => {
    const sessionId = session?.id ?? null;
    const status = session?.map_controller?.status;
    const active = status === "waiting" || status === "running";
    if (active && current.active && current.sessionId === sessionId) return current;

    cancelTimer();
    if (!active) return emit({ sessionId, active: false, visible: false });

    emit({ sessionId, active: true, visible: false });
    const expected = {};
    token = expected;
    timer = setTimer(() => {
      if (token !== expected || !current.active || current.sessionId !== sessionId) return;
      timer = null;
      token = null;
      emit({ sessionId, active: true, visible: true });
    }, delayMs);
    return current;
  };

  return {
    update,
    state: () => ({ ...current }),
    dispose: () => {
      cancelTimer();
      current = { sessionId: null, active: false, visible: false };
    },
  };
}

function eventTime(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

export function buildConversationTimeline(transcript = [], operations = []) {
  const events = [
    ...transcript.map((utterance, index) => ({
      kind: "utterance",
      value: utterance,
      time: eventTime(utterance.completed_at),
      index,
    })),
    ...operations.flatMap((operation, index) => {
      if (operation.actor !== "partner" && operation.actor !== "curator") return [];
      const label = modelActionLabel(operation);
      if (!label) return [];
      return [{
        kind: "action",
        value: {
          id: operation.id,
          label,
          createdAt: operation.created_at ?? operation.at,
        },
        time: eventTime(operation.created_at ?? operation.at),
        index: transcript.length + index,
      }];
    }),
  ].sort((left, right) => left.time - right.time || left.index - right.index);

  const turns = [];
  let pendingActions = [];

  events.forEach((event) => {
    const current = turns.at(-1);
    if (event.kind === "action") {
      if (current?.speaker === "partner") current.actions.push(event.value);
      else pendingActions.push(event.value);
      return;
    }

    const utterance = event.value;
    if (current?.speaker === utterance.speaker) {
      current.utterances.push(utterance);
      if (utterance.speaker === "partner" && pendingActions.length) {
        current.actions.push(...pendingActions);
        pendingActions = [];
      }
      return;
    }

    const turn = {
      id: `turn-${utterance.id}`,
      speaker: utterance.speaker,
      utterances: [utterance],
      actions: utterance.speaker === "partner" ? pendingActions : [],
    };
    if (utterance.speaker === "partner") pendingActions = [];
    turns.push(turn);
  });

  if (pendingActions.length) {
    turns.push({
      id: `turn-action-${pendingActions[0].id}`,
      speaker: "partner",
      utterances: [],
      actions: pendingActions,
    });
  }

  return turns;
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
