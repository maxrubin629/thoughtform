import {
  CONNECTION_CREATE_CONTACT_PROGRESS,
  CONNECTION_CREATE_DURATION,
  CONNECTION_CREATE_RETURN_DELAY,
  CONNECTION_POP_DURATION,
  PAPER_MATERIAL_SETTINGS,
  clamp,
  getConnectionPopImpactTimes,
  withWobble,
} from "../fluidMaterial.js";

function monotonicNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

export function connectionEdgeKey(edge) {
  if (edge?.id) return `id:${edge.id}`;
  const from = String(edge?.from ?? edge?.a ?? "");
  const to = String(edge?.to ?? edge?.b ?? "");
  return from < to ? `ends:${from}:${to}` : `ends:${to}:${from}`;
}

export function connectionMatches(left, right) {
  if (!left || !right) return false;
  if (left.id && right.id && left.id === right.id) return true;
  const leftFrom = left.from ?? left.a;
  const leftTo = left.to ?? left.b;
  const rightFrom = right.from ?? right.a;
  const rightTo = right.to ?? right.b;
  return (
    (leftFrom === rightFrom && leftTo === rightTo)
    || (leftFrom === rightTo && leftTo === rightFrom)
  );
}

export function applyConnectionGrowthMotion(nodes, edge, { reducedMotion = false } = {}) {
  if (reducedMotion || !edge) return nodes;
  const source = nodes.find((node) => node.id === edge.from);
  const target = nodes.find((node) => node.id === edge.to);
  if (!source || !target) return nodes;

  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const createdAt = edge.createdAt ?? monotonicNow();
  const targetImpactAt = createdAt
    + CONNECTION_CREATE_DURATION * CONNECTION_CREATE_CONTACT_PROGRESS;
  const sourceReturnAt = targetImpactAt + CONNECTION_CREATE_RETURN_DELAY;

  return nodes.map((node) => {
    if (node.id === source.id) {
      const launched = withWobble(
        node,
        dx,
        dy,
        0.064,
        { startAt: createdAt, travel: 0.14, append: true },
      );
      return withWobble(
        launched,
        -dx,
        -dy,
        0.038,
        { startAt: sourceReturnAt, travel: 0.11, append: true },
      );
    }
    if (node.id === target.id) return withWobble(
      node,
      dx,
      dy,
      0.105,
      { startAt: targetImpactAt, travel: 0.32, append: true },
    );
    return node;
  });
}

export function buildConnectionPopTransition(
  nodes,
  edge,
  motion = {},
  {
    reducedMotion = false,
    includePop = true,
    eventId,
    start = monotonicNow(),
    duration = CONNECTION_POP_DURATION,
  } = {},
) {
  const source = nodes.find((node) => node.id === edge?.from);
  const target = nodes.find((node) => node.id === edge?.to);
  if (!source || !target) return { nodes, pop: null, impacts: null };

  const hitT = clamp(motion.hitT ?? 0.5, 0, 1);
  const impacts = motion.sourceImpactAt != null && motion.targetImpactAt != null
    ? { source: motion.sourceImpactAt, target: motion.targetImpactAt }
    : getConnectionPopImpactTimes(
        start,
        hitT,
        duration,
        { ...source, radius: source.radius ?? source.r },
        { ...target, radius: target.radius ?? target.r },
        PAPER_MATERIAL_SETTINGS,
      );

  if (reducedMotion) return { nodes, pop: null, impacts };

  const hitX = source.x + (target.x - source.x) * hitT;
  const hitY = source.y + (target.y - source.y) * hitT;
  const sourceAmplitude = 0.036 + (1 - hitT) * 0.016;
  const targetAmplitude = 0.036 + hitT * 0.016;
  const nextNodes = nodes.map((node) => {
    if (node.id === source.id) return withWobble(
      node,
      source.x - hitX,
      source.y - hitY,
      sourceAmplitude,
      { startAt: impacts.source, travel: 0.13, append: true },
    );
    if (node.id === target.id) return withWobble(
      node,
      target.x - hitX,
      target.y - hitY,
      targetAmplitude,
      { startAt: impacts.target, travel: 0.13, append: true },
    );
    return node;
  });

  if (!includePop) return { nodes: nextNodes, pop: null, impacts };
  const seedText = `${edge.from}:${edge.to}`;
  const seed = [...seedText].reduce((value, character) => (
    ((value * 31) + character.charCodeAt(0)) >>> 0
  ), Math.round(start));
  return {
    nodes: nextNodes,
    impacts,
    pop: {
      id: eventId ?? `pop:${connectionEdgeKey(edge)}:${start}`,
      edgeId: edge.id,
      aId: source.id,
      bId: target.id,
      a: { ...source, radius: source.radius ?? source.r },
      b: { ...target, radius: target.radius ?? target.r },
      hitT,
      seed,
      start,
      duration,
    },
  };
}
