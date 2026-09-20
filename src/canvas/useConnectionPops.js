import { useEffect, useRef } from "react";
import { CONNECTION_POP_DURATION } from "../fluidMaterial.js";
import { buildConnectionPopTransition, connectionEdgeKey, connectionMatches } from "../session/connectionMotion.js";

function popMatchesEdge(pop, edge) {
  return connectionMatches(edge, { id: pop.edgeId, from: pop.aId, to: pop.bId });
}

export function useConnectionPops({ edges, connectionPopQueueRef, reducedMotion, onRemoveConnection }) {
  const internalQueue = useRef([]);
  const poppingConnectionsRef = connectionPopQueueRef ?? internalQueue;
  const previousEdgeKeys = useRef(new Set());
  const connectionIsPopping = (edge, now = performance.now()) => (
    Boolean(connectionPopQueueRef) && poppingConnectionsRef.current.some((pop) => (
      (pop.hideUntilResolved || now < pop.start + pop.duration) && popMatchesEdge(pop, edge)
    ))
  );

  useEffect(() => {
    if (!reducedMotion) return;
    const now = performance.now();
    poppingConnectionsRef.current = poppingConnectionsRef.current
      .filter((pop) => pop.hideUntilResolved)
      .map((pop) => ({ ...pop, start: now - 1, duration: 1 }));
  }, [poppingConnectionsRef, reducedMotion]);

  useEffect(() => {
    const committed = edges.filter((edge) => !edge.ghost);
    const restored = committed.filter((edge) => !previousEdgeKeys.current.has(connectionEdgeKey(edge)));
    if (connectionPopQueueRef && restored.length) {
      poppingConnectionsRef.current = poppingConnectionsRef.current.filter((pop) => (
        !restored.some((edge) => popMatchesEdge(pop, edge))
      ));
    }
    previousEdgeKeys.current = new Set(committed.map(connectionEdgeKey));
  }, [connectionPopQueueRef, edges, poppingConnectionsRef]);

  const popConnection = (connection) => {
    const { pop, impacts } = buildConnectionPopTransition(
      [connection.a, connection.b],
      connection.link,
      { hitT: connection.hit.t, angleLimits: connection.angleLimits },
      { duration: reducedMotion ? 1 : CONNECTION_POP_DURATION },
    );
    poppingConnectionsRef.current.push(pop);
    const accepted = onRemoveConnection(connection.link, {
      hitT: pop.hitT,
      sourceImpactAt: impacts.source,
      targetImpactAt: impacts.target,
    });
    if (accepted === false) {
      poppingConnectionsRef.current = poppingConnectionsRef.current.filter((entry) => entry !== pop);
    }
  };

  return { poppingConnectionsRef, connectionIsPopping, popConnection };
}
