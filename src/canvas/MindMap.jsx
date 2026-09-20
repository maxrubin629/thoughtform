import { useMemo, useRef } from "react";
import { getFocusIds } from "./graphLayout.js";
import { MapSurface } from "./MapSurface.jsx";
import { useCanvasView } from "./useCanvasView.js";
import { useCanvasGestures } from "./useCanvasGestures.js";
import { useCanvasRenderer } from "./useCanvasRenderer.js";
import { useConnectionPops } from "./useConnectionPops.js";

// Canonical graph data flows down; only gesture callbacks write map changes.
// Transient painting, camera movement, and pointer state stay browser-local.
export function MindMap(props) {
  const refs = {
    shellRef: useRef(null),
    canvasRef: useRef(null),
    underlayCanvasRef: useRef(null),
    shaderCanvasRef: useRef(null),
  };
  const { nodes, edges, focusId, showSuggestions } = props;
  const graph = useMemo(() => {
    const focusIds = getFocusIds(focusId, edges);
    const renderedNodes = nodes.filter((node) => (showSuggestions || !node.ghost) && (!focusIds || focusIds.has(node.id)));
    const ids = new Set(renderedNodes.map((node) => node.id));
    return { renderedNodes, renderedEdges: edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)) };
  }, [nodes, edges, focusId, showSuggestions]);
  const view = useCanvasView(refs.shellRef, refs.canvasRef, props);
  const pops = useConnectionPops(props);
  const gestures = useCanvasGestures(refs.canvasRef, graph, view, pops, props);
  const shaderAvailable = useCanvasRenderer(refs, graph, view, gestures, pops, props);
  return <MapSurface props={props} refs={refs} graph={graph} view={view} gestures={gestures} shaderAvailable={shaderAvailable} />;
}
