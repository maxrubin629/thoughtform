export {
  applyConnectionGrowthMotion,
  buildConnectionPopTransition,
} from "../connectionVisualMotion.js";

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

export function connectionEndpointKey(edge) {
  const from = String(edge?.from ?? edge?.a ?? "");
  const to = String(edge?.to ?? edge?.b ?? "");
  return from < to ? `${from}:${to}` : `${to}:${from}`;
}

export function confirmPendingConnectionEdge(edge, pending) {
  if (!edge || !pending?.edge || !Number.isFinite(pending.startedAt)) return edge;
  return {
    ...pending.edge,
    ...edge,
    createdAt: pending.startedAt,
    pending: false,
  };
}
