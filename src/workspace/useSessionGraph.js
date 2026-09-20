import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { layoutHierarchy } from "../canvas/graphLayout.js";
import { canConnect } from "../connectionGesture.js";
import { BASE_HEIGHT, BASE_WIDTH } from "../canvas/viewport.js";
import { FLUID_PHYSICS_SETTINGS, captureFluidRestLengths, stepFluidPhysics } from "../fluidPhysics.js";
import { clamp, withWobble } from "../fluidMaterial.js";
import { applyConnectionGrowthMotion, buildConnectionPopTransition, connectionEdgeKey, connectionEndpointKey, connectionMatches, confirmPendingConnectionEdge } from "../session/connectionMotion.js";
import { proposalVisuals, visualizeSession } from "../session/presentation.js";

// Browser-owned motion. Canonical positions only enter through applySnapshot;
// animation frames and dragging always advance the refs, never a rendered snapshot.
export function useSessionGraph({ viewMode, reducedMotion, showSuggestions }) {
  const [nodes, setNodes] = useState([]);
  const [edges, setEdges] = useState([]);
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  const committedPositionsRef = useRef(new Map());
  const organicPositionsRef = useRef(new Map());
  const connectionPopQueueRef = useRef([]);
  const manualPopKeysRef = useRef(new Set());
  const pendingManualConnectionsRef = useRef(new Map());
  const [proposalPositions, setProposalPositions] = useState(() => new Map());
  const proposalNodesRef = useRef([]);
  const proposalEdgesRef = useRef([]);
  const proposalDragStartRef = useRef(new Map());

  const [session, setSession] = useState(null);
  const reducedMotionRef = useRef(reducedMotion);
  const showSuggestionsRef = useRef(showSuggestions);
  reducedMotionRef.current = reducedMotion;
  showSuggestionsRef.current = showSuggestions;

  const touchGraph = useCallback((nextNodes, nextEdges = edgesRef.current) => {
    nodesRef.current = nextNodes;
    edgesRef.current = nextEdges;
    setNodes(nextNodes);
    setEdges(nextEdges);
  }, []);

  const reset = useCallback(() => {
    committedPositionsRef.current = new Map();
    organicPositionsRef.current.clear();
    connectionPopQueueRef.current = [];
    manualPopKeysRef.current.clear();
    pendingManualConnectionsRef.current.clear();
    proposalDragStartRef.current.clear();
    proposalNodesRef.current = [];
    proposalEdgesRef.current = [];
    setProposalPositions(new Map());
    touchGraph([], []);
  }, [touchGraph]);

  const applySnapshot = useCallback((snapshot, { animateNew = true } = {}) => {
    const motionEnabled = animateNew && !reducedMotionRef.current;
    const visual = visualizeSession(
      snapshot,
      nodesRef.current,
      edgesRef.current,
      committedPositionsRef.current,
      undefined,
      { animateNew: motionEnabled },
    );
    let nextNodes = visual.nodes;
    visual.addedEdges.forEach((edge) => {
      const pendingKey = connectionEndpointKey(edge);
      const pendingManual = pendingManualConnectionsRef.current.get(pendingKey);
      if (pendingManual) {
        Object.assign(edge, confirmPendingConnectionEdge(edge, pendingManual));
        pendingManualConnectionsRef.current.delete(pendingKey);
        return;
      }
      if (motionEnabled) {
        nextNodes = applyConnectionGrowthMotion(nextNodes, edge);
      }
    });

    const confirmedEndpointKeys = new Set(visual.edges.map(connectionEndpointKey));
    pendingManualConnectionsRef.current.forEach((pending, key) => {
      if (!confirmedEndpointKeys.has(key)) visual.edges.push(pending.edge);
    });

    if (motionEnabled) {
      const nextNodeIds = new Set(nextNodes.map((node) => node.id));
      let transitionNodes = [
        ...nextNodes,
        ...nodesRef.current.filter((node) => !node.ghost && !nextNodeIds.has(node.id)),
      ];
      visual.removedEdges.forEach((edge) => {
        if (edge.pending) return;
        const key = connectionEdgeKey(edge);
        const wasManual = manualPopKeysRef.current.delete(key);
        const alreadyPopping = connectionPopQueueRef.current.some((pop) => (
          performance.now() < pop.start + pop.duration
          && connectionMatches(edge, {
            id: pop.edgeId,
            from: pop.aId,
            to: pop.bId,
          })
        ));
        if (wasManual || alreadyPopping) return;
        const transition = buildConnectionPopTransition(transitionNodes, edge, {}, {
          eventId: `canonical:${snapshot.revision}:${key}`,
        });
        transitionNodes = transition.nodes;
        if (transition.pop) connectionPopQueueRef.current.push(transition.pop);
      });
      const transitionedById = new Map(transitionNodes.map((node) => [node.id, node]));
      nextNodes = nextNodes.map((node) => transitionedById.get(node.id) ?? node);
    } else {
      visual.removedEdges.forEach((edge) => {
        if (!edge.pending) manualPopKeysRef.current.delete(connectionEdgeKey(edge));
      });
    }

    const nextEdges = captureFluidRestLengths(nextNodes, visual.edges, {});
    committedPositionsRef.current = visual.committedPositions;
    nodesRef.current = nextNodes;
    edgesRef.current = nextEdges;
    setSession(snapshot);
    setNodes(nextNodes);
    setEdges(nextEdges);
  }, []);

  useEffect(() => {
    if (viewMode !== "clusters") return;
    let animationFrame;
    let lastTime = performance.now();
    const animate = (now) => {
      const frameStep = clamp((now - lastTime) / 16.67, 0.35, 2);
      lastTime = now;
      const presentationNodes = showSuggestionsRef.current
        ? [...nodesRef.current, ...proposalNodesRef.current]
        : nodesRef.current;
      const presentationEdges = showSuggestionsRef.current
        ? [...edgesRef.current, ...proposalEdgesRef.current]
        : edgesRef.current;
      const result = stepFluidPhysics(presentationNodes, presentationEdges, {
            frameStep,
            width: BASE_WIDTH,
            height: BASE_HEIGHT,
            settings: FLUID_PHYSICS_SETTINGS,
            includeGhosts: true,
          });
      if (result.active) {
        const nextNodes = result.nodes.filter((node) => !node.ghost);
        const nextProposalNodes = result.nodes.filter((node) => node.ghost);
        nodesRef.current = nextNodes;
        setNodes(nextNodes);
        if (showSuggestionsRef.current) {
          proposalNodesRef.current = nextProposalNodes;
          setProposalPositions(new Map(nextProposalNodes.map((node) => [node.id, node])));
        }
      }
      animationFrame = window.requestAnimationFrame(animate);
    };
    animationFrame = window.requestAnimationFrame(animate);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [viewMode]);

  useEffect(() => {
    if (viewMode !== "hierarchy" || !session?.id) return;
    const next = layoutHierarchy(nodesRef.current, edgesRef.current);
    nodesRef.current = next;
    setNodes(next);
  }, [session?.id, session?.nodes?.length, session?.edges?.length, viewMode]);

  const pendingProposals = useMemo(() => (
    (session?.proposals ?? []).filter((proposal) => proposal.status === "pending" || proposal.status === "stale")
  ), [session?.proposals]);
  const ghostVisuals = useMemo(
    () => proposalVisuals(pendingProposals, nodes, proposalPositions),
    [pendingProposals, nodes, proposalPositions],
  );
  proposalNodesRef.current = ghostVisuals.ghostNodes;
  const previousProposalEdges = new Map(proposalEdgesRef.current.map((edge) => [edge.id, edge]));
  const retainedProposalEdges = ghostVisuals.ghostEdges.map((edge) => {
    const previous = previousProposalEdges.get(edge.id);
    return previous?.rest ? { ...edge, rest: previous.rest, restDx: previous.restDx, restDy: previous.restDy } : edge;
  });
  const physicalProposalEdges = captureFluidRestLengths(
    [...nodes, ...ghostVisuals.ghostNodes],
    retainedProposalEdges,
    { includeGhosts: true },
  );
  proposalEdgesRef.current = physicalProposalEdges;
  const mapNodes = useMemo(
    () => (showSuggestions ? [...nodes, ...ghostVisuals.ghostNodes] : nodes),
    [ghostVisuals.ghostNodes, nodes, showSuggestions],
  );
  const mapEdges = useMemo(
    () => (showSuggestions ? [...edges, ...physicalProposalEdges] : edges),
    [edges, physicalProposalEdges, showSuggestions],
  );

  const updateMovingNode = (id, update) => {
    const proposal = proposalNodesRef.current.some((node) => node.id === id);
    const current = proposal ? proposalNodesRef.current : nodesRef.current;
    const node = current.find((candidate) => candidate.id === id);
    if (!node) return null;
    const updated = update(node);
    const next = current.map((candidate) => candidate.id === id ? updated : candidate);
    if (proposal) {
      proposalNodesRef.current = next;
      setProposalPositions(new Map(next.map((candidate) => [candidate.id, candidate])));
    } else touchGraph(next);
    return updated;
  };

  const startMoveNode = (id) => updateMovingNode(id, (node) => {
    if (node.ghost) proposalDragStartRef.current.set(id, node);
    return { ...node, dragging: true, vx: 0, vy: 0, shadeVx: 0, shadeVy: 0 };
  });
  const moveNode = (id, x, y) => updateMovingNode(id, (node) => ({
    ...node, x, y, dragging: true, vx: 0, vy: 0, shadeVx: x - node.x, shadeVy: y - node.y,
  }));
  const finishMoveNode = (id, vx, vy, moved) => {
    proposalDragStartRef.current.delete(id);
    const release = 0.08 + (1 - FLUID_PHYSICS_SETTINGS.viscosity) * 0.08;
    return updateMovingNode(id, (node) => {
      const released = {
        ...node, dragging: false,
        vx: moved ? clamp(vx, -24, 24) * release : 0,
        vy: moved ? clamp(vy, -24, 24) * release : 0,
        shadeVx: 0, shadeVy: 0,
      };
      return moved ? released : withWobble(released, 1, 0, 0.082);
    });
  };
  const cancelMoveNode = (id) => {
    const start = proposalDragStartRef.current.get(id);
    proposalDragStartRef.current.delete(id);
    updateMovingNode(id, (node) => ({ ...(start ?? node), dragging: false, vx: 0, vy: 0, shadeVx: 0, shadeVy: 0 }));
  };

  const connectTarget = async (sourceId, targetId, perform) => {
    if (!canConnect(sourceId, targetId, nodesRef.current, edgesRef.current)) return;
    const pendingKey = connectionEndpointKey({ from: sourceId, to: targetId });
    const startedAt = performance.now();
    const pendingEdge = {
      id: `pending:${pendingKey}:${startedAt}`,
      from: sourceId,
      to: targetId,
      bend: 0,
      createdAt: startedAt,
      pending: true,
      ghost: false,
    };
    const nextNodes = applyConnectionGrowthMotion(
      nodesRef.current,
      pendingEdge,
      { reducedMotion: reducedMotionRef.current },
    );
    const nextEdges = captureFluidRestLengths(
      nextNodes,
      [...edgesRef.current, pendingEdge],
      {},
    );
    const visualPendingEdge = nextEdges.find((edge) => edge.id === pendingEdge.id) ?? pendingEdge;
    pendingManualConnectionsRef.current.set(pendingKey, {
      edge: visualPendingEdge,
      startedAt,
    });
    touchGraph(nextNodes, nextEdges);
    try {
      await perform({ type: "connect_bubbles", from_reference: sourceId, to_reference: targetId });
      return true;
    } finally {
      const unresolved = pendingManualConnectionsRef.current.get(pendingKey);
      if (unresolved?.edge.id === pendingEdge.id) {
        pendingManualConnectionsRef.current.delete(pendingKey);
        touchGraph(
          nodesRef.current,
          edgesRef.current.filter((edge) => edge.id !== pendingEdge.id),
        );
      }
    }
  };

  const removeConnection = (session, edge, motion, perform, showToast) => {
    const canonicalEdge = session?.edges?.find((candidate) => (
      connectionMatches(candidate, edge)
    ));
    if (!canonicalEdge) return false;
    const key = connectionEdgeKey(canonicalEdge);
    manualPopKeysRef.current.add(key);
    const pendingPop = [...connectionPopQueueRef.current].reverse().find((pop) => (
      connectionMatches(canonicalEdge, {
        id: pop.edgeId,
        from: pop.aId,
        to: pop.bId,
      })
    ));
    if (pendingPop) pendingPop.hideUntilResolved = true;
    const transition = buildConnectionPopTransition(nodesRef.current, canonicalEdge, motion, {
      reducedMotion: reducedMotionRef.current,
      includePop: false,
    });
    touchGraph(transition.nodes);
    perform({ type: "delete_connection", edge_id: canonicalEdge.id })
      .then(() => showToast("Connection popped"), (error) => showToast(error.message))
      .finally(() => {
        manualPopKeysRef.current.delete(key);
        if (pendingPop) pendingPop.hideUntilResolved = false;
      });
    return true;
  };

  const applyViewLayout = (nextMode) => {
    if (nextMode === "hierarchy") {
      nodesRef.current.forEach((node) => organicPositionsRef.current.set(node.id, { x: node.x, y: node.y }));
      const next = layoutHierarchy(nodesRef.current, edgesRef.current);
      nodesRef.current = next;
      setNodes(next);
    } else {
      const next = nodesRef.current.map((node) => ({ ...node, ...(organicPositionsRef.current.get(node.id) ?? {}) }));
      nodesRef.current = next;
      setNodes(next);
    }
  };

  return {
    nodes, edges, nodesRef, edgesRef, proposalNodesRef, connectionPopQueueRef,
    pendingProposals, ghostVisuals, mapNodes, mapEdges, applySnapshot, reset,
    startMoveNode, moveNode, finishMoveNode, cancelMoveNode, connectTarget, removeConnection, applyViewLayout,
  };
}
