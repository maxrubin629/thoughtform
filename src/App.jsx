import { useEffect, useMemo, useRef, useState } from "react";
import { IconCheck, IconLink, IconParking, IconPin, IconPinnedOff, IconPencil, IconPlus, IconQuote, IconSparkles, IconTrash, IconX } from "@tabler/icons-react";
import { lassoIntersectsNode } from "./lassoSelection.js";
import { canConnect, connectionTargetAt, connectionBud, connectionPreviewPath } from "./connectionGesture.js";
import paperTextureUrl from "./assets/paper-texture.png";
import {
  CONNECTION_CREATE_DURATION,
  CONNECTION_POP_DURATION,
  PAPER_MATERIAL_SETTINGS,
  buildFluidVisualNodes,
  clamp,
  drawFluidConnectionPop,
  drawFluidMaterial,
  findFluidConnectionHit,
  getConnectionPopImpactTimes,
} from "./fluidMaterial.js";
import { createFluidShaderRenderer } from "./fluidShaderRenderer.js";
import { BASE_HEIGHT, BASE_WIDTH } from "./mapData.js";

const MIN_ZOOM = 0.72;
const MAX_ZOOM = 1.36;

const palettes = {
  paper: {
    material: "#f78269",
    materialByDepth: ["#f78269", "#f78269", "#f78269", "#f78269", "#f78269"],
    ink: "#251d1a",
    ghost: "#dc6d58",
    ghostFill: "rgba(245, 132, 109, 0.08)",
  },
  nocturne: {
    material: "#cc5d4b",
    materialByDepth: ["#d85e4c", "#d96552", "#dc6d59", "#df7560", "#e27d68"],
    ink: "#fff1df",
    ghost: "#e47b62",
    ghostFill: "rgba(228, 123, 98, 0.08)",
  },
};

function nodeLabel(node) {
  return node?.lines?.join(" ") ?? "Thought";
}

function getFocusIds(focusId, edges) {
  if (!focusId) return null;
  const included = new Set([focusId]);
  let changed = true;
  while (changed) {
    changed = false;
    edges.forEach(({ from, to }) => {
      if (included.has(from) && !included.has(to)) {
        included.add(to);
        changed = true;
      }
    });
  }
  let cursor = focusId;
  const visitedAncestors = new Set();
  while (cursor && !visitedAncestors.has(cursor)) {
    visitedAncestors.add(cursor);
    const incoming = edges.find((edge) => edge.to === cursor);
    cursor = incoming?.from;
    if (cursor) included.add(cursor);
  }
  return included;
}

export function layoutHierarchy(nodes, edges) {
  const committed = nodes.filter((node) => !node.ghost);
  const byDepth = new Map();
  committed.forEach((node) => {
    const depth = clamp(node.depth ?? 0, 0, 4);
    byDepth.set(depth, [...(byDepth.get(depth) ?? []), node]);
  });
  const positions = new Map();
  byDepth.forEach((items, depth) => {
    const top = depth === 0 ? 300 : 175;
    const bottom = depth === 0 ? 720 : 805;
    const step = items.length <= 1 ? 0 : (bottom - top) / (items.length - 1);
    items.forEach((node, index) => {
      positions.set(node.id, {
        x: depth === 0 ? 285 : 430 + depth * 225,
        y: items.length === 1 ? (top + bottom) / 2 : top + index * step,
      });
    });
  });
  return nodes.map((node) => {
    if (!node.ghost) return { ...node, ...(positions.get(node.id) ?? {}) };
    const incoming = edges.find((edge) => edge.to === node.id);
    const parent = positions.get(incoming?.from);
    const parentNode = nodes.find((candidate) => candidate.id === incoming?.from);
    if (!parent || !parentNode) return node;
    const siblings = nodes.filter((candidate) => (
      candidate.ghost && edges.some((edge) => edge.from === parentNode.id && edge.to === candidate.id)
    ));
    const siblingIndex = Math.max(siblings.findIndex((candidate) => candidate.id === node.id), 0);
    const siblingOffset = (siblingIndex - (siblings.length - 1) / 2) * (node.r * 1.7 + 22);
    return {
      ...node,
      x: clamp(parent.x + parentNode.r + node.r + 48, node.r + 20, BASE_WIDTH - node.r - 20),
      y: clamp(parent.y + siblingOffset, 175 + node.r, 805 - node.r),
    };
  });
}

function drawWobblyCircle(ctx, node) {
  const points = 48;
  ctx.beginPath();
  for (let index = 0; index <= points; index += 1) {
    const angle = (index / points) * Math.PI * 2;
    const wobble = 1
      + Math.sin(angle * 3 + node.id.length) * 0.055
      + Math.sin(angle * 5 + node.id.length * 0.7) * 0.025;
    const x = node.x + Math.cos(angle) * node.r * wobble;
    const y = node.y + Math.sin(angle) * node.r * wobble;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function drawHoverGlow(ctx, node, concept, scale) {
  const radiusX = node.radiusX ?? node.radius ?? node.r;
  const radiusY = node.radiusY ?? node.radius ?? node.r;
  const spread = 24 / scale;
  const outerX = radiusX + spread;
  const outerY = radiusY + spread;
  const edge = Math.min(radiusX / outerX, radiusY / outerY);
  const color = concept === "nocturne" ? "255, 164, 121" : "255, 174, 138";

  // A continuous falloff beneath the material, with no stroked outer boundary.
  ctx.save();
  ctx.translate(node.x, node.y);
  ctx.rotate(node.rotation ?? 0);
  ctx.scale(outerX, outerY);
  const glow = ctx.createRadialGradient(0, 0, edge, 0, 0, 1);
  glow.addColorStop(0, `rgba(${color}, 0.56)`);
  glow.addColorStop(0.35, `rgba(${color}, 0.30)`);
  glow.addColorStop(0.7, `rgba(${color}, 0.07)`);
  glow.addColorStop(1, `rgba(${color}, 0)`);
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(0, 0, 1, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawSelectionContour(ctx, node, concept, scale) {
  const radiusX = (node.radiusX ?? node.radius ?? node.r) + 7 / scale;
  const radiusY = (node.radiusY ?? node.radius ?? node.r) + 7 / scale;
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(node.x, node.y, radiusX, radiusY, node.rotation ?? 0, 0, Math.PI * 2);
  ctx.lineWidth = 2 / scale;
  ctx.strokeStyle = concept === "nocturne"
    ? "rgba(255, 181, 158, 0.94)"
    : "rgba(132, 59, 45, 0.9)";
  ctx.stroke();
  ctx.restore();
}

function boundaryRadius(node, angle) {
  if (node.ghost) {
    const seed = String(node.id).length;
    const wobble = 1
      + Math.sin(angle * 3 + seed) * 0.055
      + Math.sin(angle * 5 + seed * 0.7) * 0.025;
    return node.r * wobble;
  }

  const radiusX = node.radiusX ?? node.radius ?? node.r;
  const radiusY = node.radiusY ?? node.radius ?? node.r;
  const localAngle = angle - (node.rotation ?? 0);
  const xTerm = Math.cos(localAngle) / Math.max(radiusX, 0.001);
  const yTerm = Math.sin(localAngle) / Math.max(radiusY, 0.001);
  return 1 / Math.max(Math.hypot(xTerm, yTerm), 0.001);
}

function exteriorBoundaryPoint(node, angle) {
  const radius = boundaryRadius(node, angle) + 0.85;
  return {
    x: node.x + Math.cos(angle) * radius,
    y: node.y + Math.sin(angle) * radius,
  };
}

function drawGhostTether(ctx, from, to, bend, color) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const centerAngle = Math.atan2(dy, dx);
  const start = exteriorBoundaryPoint(from, centerAngle);
  const end = exteriorBoundaryPoint(to, centerAngle + Math.PI);
  const gapX = end.x - start.x;
  const gapY = end.y - start.y;
  const gap = Math.max(Math.hypot(gapX, gapY), 1);
  const ux = gapX / gap;
  const uy = gapY / gap;
  const px = -uy;
  const py = ux;
  const handle = gap * 0.32;
  const bendOffset = clamp(bend, -gap * 0.16, gap * 0.16);
  const controlA = {
    x: start.x + ux * handle + px * bendOffset,
    y: start.y + uy * handle + py * bendOffset,
  };
  const controlB = {
    x: end.x - ux * handle + px * bendOffset,
    y: end.y - uy * handle + py * bendOffset,
  };
  const traceTether = () => {
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.bezierCurveTo(controlA.x, controlA.y, controlB.x, controlB.y, end.x, end.y);
  };

  ctx.save();
  traceTether();
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.28;
  ctx.lineWidth = 0.8;
  ctx.lineCap = "round";
  ctx.stroke();

  traceTether();
  ctx.globalAlpha = 1;
  ctx.lineWidth = 1.7;
  ctx.lineCap = "round";
  ctx.setLineDash([1.4, 4.6]);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = color;
  [start, end].forEach((point) => {
    ctx.beginPath();
    ctx.arc(point.x, point.y, 0.9, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.restore();
}

function drawWrappedText(ctx, node, x, y, palette, showProvenance) {
  const root = node.r > 100;
  const baseSize = root ? 22 : node.r > 72 ? 13.5 : node.r > 58 ? 12.5 : node.r > 43 ? 11.5 : 10.2;
  const verticalFit = (node.r * 1.48) / Math.max(node.lines.length * 1.22, 1);
  const size = root ? baseSize : clamp(Math.min(baseSize, verticalFit), 9.2, baseSize);
  const weight = root ? 400 : 500;
  ctx.fillStyle = node.ghost ? palette.ghost : palette.ink;
  ctx.font = `${weight} ${size}px Manrope, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const lineHeight = size * (root ? 1.3 : 1.22);
  const textY = y - (node.meta ? 11 : showProvenance && node.provenance ? 5 : 0);
  const start = textY - ((node.lines.length - 1) * lineHeight) / 2;
  node.lines.forEach((line, index) => {
    ctx.fillText(line, x, start + index * lineHeight, node.r * 1.65);
  });
  if (node.meta) {
    ctx.globalAlpha = 0.68;
    ctx.font = "500 10px Manrope, sans-serif";
    ctx.fillText(node.meta, x, y + node.r * 0.53);
    ctx.globalAlpha = 1;
  }
  if (showProvenance && node.provenance) {
    ctx.globalAlpha = 0.58;
    ctx.font = "500 8.5px Manrope, sans-serif";
    ctx.fillText(node.provenance, x, y + node.r * 0.56);
    ctx.globalAlpha = 1;
  }
}

export function IconButton({
  label,
  children,
  type = "button",
  active = false,
  pressed,
  disabled = false,
  onClick,
  className = "",
  testId,
}) {
  return (
    <button
      type={type}
      className={`icon-button ${active ? "is-active" : ""} ${className}`}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
    >
      {children}
    </button>
  );
}

export function MindMap({
  concept,
  nodes,
  edges,
  selectedId,
  selectedIds,
  onSelect,
  onSelectMany,
  onMoveStart,
  onMoveNode,
  onMoveEnd,
  onMoveCancel,
  onEdit,
  onAdd,
  onAskAI,
  onPin,
  onPark,
  onSources,
  controlsHidden = false,
  onArmConnect,
  onCancelConnect,
  onConnect,
  actionsNodeId,
  onActionsChange,
  rootId,
  onSpawnFreeform,
  onDelete,
  onAcceptGhost,
  onDismissGhost,
  onRemoveConnection,
  connectFromId,
  zoom,
  setZoom,
  pan,
  setPan,
  showSuggestions,
  showProvenance,
  focusId,
  reducedMotion,
  marqueeActive,
  lassoActive = false,
  connectionPopQueueRef,
}) {
  const canvasRef = useRef(null);
  const underlayCanvasRef = useRef(null);
  const shaderCanvasRef = useRef(null);
  const shaderRendererRef = useRef(null);
  const materialRasterRef = useRef(null);
  const motionRasterRef = useRef(null);
  const shellRef = useRef(null);
  const textureRef = useRef(null);
  const dragRef = useRef(null);
  const longPressRef = useRef(null);
  const suppressBudClickRef = useRef(false);
  const bubbleMenuRef = useRef(null);
  const activePointersRef = useRef(new Map());
  const interactionRef = useRef(null);
  const internalPoppingConnectionsRef = useRef([]);
  const poppingConnectionsRef = connectionPopQueueRef ?? internalPoppingConnectionsRef;
  const previousRenderedEdgeKeysRef = useRef(new Set());
  const lastConnectionPopRef = useRef(null);
  const [viewport, setViewport] = useState({ width: BASE_WIDTH, height: BASE_HEIGHT });
  const [fontReady, setFontReady] = useState(false);
  const [textureReady, setTextureReady] = useState(false);
  const [shaderAvailable, setShaderAvailable] = useState(false);
  const [marqueeRect, setMarqueeRect] = useState(null);
  const [lassoPoints, setLassoPoints] = useState([]);
  const [hoveredNodeId, setHoveredNodeId] = useState(null);
  const [connectionPreview, setConnectionPreview] = useState(null);
  const palette = palettes[concept];
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const focusIds = useMemo(() => getFocusIds(focusId, edges), [edges, focusId]);
  const renderedNodes = useMemo(
    () => nodes.filter((node) => (showSuggestions || !node.ghost) && (!focusIds || focusIds.has(node.id))),
    [focusIds, nodes, showSuggestions],
  );
  const renderedIds = useMemo(() => new Set(renderedNodes.map((node) => node.id)), [renderedNodes]);
  const renderedEdges = useMemo(
    () => edges.filter((edge) => renderedIds.has(edge.from) && renderedIds.has(edge.to)),
    [edges, renderedIds],
  );

  const connectionIsPopping = (edge, now = performance.now()) => (
    Boolean(connectionPopQueueRef) && poppingConnectionsRef.current.some((pop) => {
      if (!pop.hideUntilResolved && now >= pop.start + pop.duration) return false;
      if (pop.edgeId && edge.id && pop.edgeId === edge.id) return true;
      return (
        (pop.aId === edge.from && pop.bId === edge.to)
        || (pop.aId === edge.to && pop.bId === edge.from)
      );
    })
  );

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return undefined;
    const update = () => setViewport({ width: shell.clientWidth, height: shell.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(shell);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (marqueeActive) setHoveredNodeId(null);
    if (["marquee", "lasso", "connect"].includes(dragRef.current?.type)) dragRef.current = null;
    setConnectionPreview(null);
    setMarqueeRect(null);
    setLassoPoints([]);
  }, [marqueeActive, lassoActive]);

  useEffect(() => {
    const cancel = (event) => {
      if (event.type !== "blur" && event.key !== "Escape") return;
      if (dragRef.current?.type === "connect") dragRef.current = null;
      suppressBudClickRef.current = true;
      window.clearTimeout(longPressRef.current);
      setConnectionPreview(null);
      onActionsChange(null);
    };
    window.addEventListener("keydown", cancel);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keydown", cancel);
      window.removeEventListener("blur", cancel);
      window.clearTimeout(longPressRef.current);
    };
  }, [onActionsChange]);

  useEffect(() => {
    if (!actionsNodeId && !connectFromId) return undefined;
    bubbleMenuRef.current?.querySelector('button:not(:disabled)')?.focus();
    const close = (event) => {
      if (!event.target.closest('.bubble-menu, [data-testid="thought-more-actions"], .connection-bud')) {
        onActionsChange(null);
        if (connectFromId) onCancelConnect();
      }
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [actionsNodeId, connectFromId, onActionsChange, onCancelConnect]);

  useEffect(() => {
    if (reducedMotion) {
      const now = performance.now();
      poppingConnectionsRef.current = poppingConnectionsRef.current
        .filter((pop) => pop.hideUntilResolved)
        .map((pop) => ({ ...pop, start: now - 1, duration: 1 }));
    }
  }, [poppingConnectionsRef, reducedMotion]);

  useEffect(() => {
    const edgeKey = (edge) => {
      if (edge.id) return `id:${edge.id}`;
      return String(edge.from) < String(edge.to)
        ? `ends:${edge.from}:${edge.to}`
        : `ends:${edge.to}:${edge.from}`;
    };
    const committedEdges = edges.filter((edge) => !edge.ghost);
    const previousKeys = previousRenderedEdgeKeysRef.current;
    const restoredEdges = committedEdges.filter((edge) => !previousKeys.has(edgeKey(edge)));
    if (connectionPopQueueRef && restoredEdges.length && poppingConnectionsRef.current.length) {
      poppingConnectionsRef.current = poppingConnectionsRef.current.filter((pop) => (
        !restoredEdges.some((edge) => (
          (pop.edgeId && edge.id && pop.edgeId === edge.id)
          || (pop.aId === edge.from && pop.bId === edge.to)
          || (pop.aId === edge.to && pop.bId === edge.from)
        ))
      ));
    }
    previousRenderedEdgeKeysRef.current = new Set(committedEdges.map(edgeKey));
  }, [connectionPopQueueRef, edges, poppingConnectionsRef]);

  useEffect(() => {
    Promise.all([
      document.fonts.load("400 22px Manrope"),
      document.fonts.load("500 15px Manrope"),
    ]).then(() => setFontReady(true));
    const image = new Image();
    image.onload = () => {
      textureRef.current = image;
      setTextureReady(true);
    };
    image.src = paperTextureUrl;
  }, []);

  useEffect(() => {
    if (concept !== "paper" || !shaderCanvasRef.current) {
      shaderRendererRef.current?.dispose();
      shaderRendererRef.current = null;
      setShaderAvailable(false);
      return undefined;
    }

    const renderer = createFluidShaderRenderer(shaderCanvasRef.current, {
      onAvailabilityChange: setShaderAvailable,
    });
    shaderRendererRef.current = renderer;
    setShaderAvailable(Boolean(renderer?.available));

    return () => {
      renderer?.dispose();
      if (shaderRendererRef.current === renderer) shaderRendererRef.current = null;
      setShaderAvailable(false);
    };
  }, [concept]);

  const transform = useMemo(() => {
    const fit = Math.min(viewport.width / BASE_WIDTH, viewport.height / BASE_HEIGHT);
    const scale = fit * zoom;
    return {
      scale,
      offsetX: (viewport.width - BASE_WIDTH * scale) / 2 + pan.x,
      offsetY: (viewport.height - BASE_HEIGHT * scale) / 2 + pan.y,
    };
  }, [pan, viewport, zoom]);

  useEffect(() => {
    interactionRef.current = { pan, transform, viewport, zoom };
  }, [pan, transform, viewport, zoom]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const handleNativeWheel = (event) => {
      event.preventDefault();
      const current = interactionRef.current;
      if (!current) return;
      if (event.ctrlKey) {
        const rect = canvas.getBoundingClientRect();
        const screenX = event.clientX - rect.left;
        const screenY = event.clientY - rect.top;
        const worldX = (screenX - current.transform.offsetX) / current.transform.scale;
        const worldY = (screenY - current.transform.offsetY) / current.transform.scale;
        const nextZoom = clamp(
          current.zoom + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP),
          MIN_ZOOM,
          MAX_ZOOM,
        );
        const fit = Math.min(current.viewport.width / BASE_WIDTH, current.viewport.height / BASE_HEIGHT);
        const nextScale = fit * nextZoom;
        const centeredX = (current.viewport.width - BASE_WIDTH * nextScale) / 2;
        const centeredY = (current.viewport.height - BASE_HEIGHT * nextScale) / 2;
        setPan({
          x: screenX - centeredX - worldX * nextScale,
          y: screenY - centeredY - worldY * nextScale,
        });
        setZoom(nextZoom);
        return;
      }
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? current.viewport.height : 1;
      const deltaX = event.shiftKey && event.deltaX === 0 ? event.deltaY : event.deltaX;
      const deltaY = event.shiftKey && event.deltaX === 0 ? 0 : event.deltaY;
      setPan((value) => ({
        x: value.x - deltaX * unit,
        y: value.y - deltaY * unit,
      }));
    };
    canvas.addEventListener("wheel", handleNativeWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", handleNativeWheel);
  }, [setPan, setZoom]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const underlayCanvas = underlayCanvasRef.current;
    if (!canvas || !underlayCanvas) return undefined;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    [canvas, underlayCanvas].forEach((layer) => {
      layer.width = Math.round(viewport.width * dpr);
      layer.height = Math.round(viewport.height * dpr);
      layer.style.width = `${viewport.width}px`;
      layer.style.height = `${viewport.height}px`;
    });
    const ctx = canvas.getContext("2d");
    const underlayCtx = underlayCanvas.getContext("2d");
    const renderer = shaderRendererRef.current;
    const paperShaderActive = concept === "paper" && shaderAvailable && renderer?.available;
    const shaderDpr = Math.min(window.devicePixelRatio || 1, 1.5);
    let materialCtx = null;
    let motionCtx = null;
    if (paperShaderActive) {
      renderer.resize(viewport.width, viewport.height, shaderDpr);
      if (!materialRasterRef.current) materialRasterRef.current = document.createElement("canvas");
      if (!motionRasterRef.current) motionRasterRef.current = document.createElement("canvas");
      const materialRaster = materialRasterRef.current;
      const motionRaster = motionRasterRef.current;
      [materialRaster, motionRaster].forEach((raster) => {
        if (
          raster.width !== shaderCanvasRef.current.width
          || raster.height !== shaderCanvasRef.current.height
        ) {
          raster.width = shaderCanvasRef.current.width;
          raster.height = shaderCanvasRef.current.height;
        }
      });
      materialCtx = materialRaster.getContext("2d");
      motionCtx = motionRaster.getContext("2d");
    }
    let frame = 0;
    let materialDirty = true;
    let wasAnimating = false;

    const clearLayer = (context, layer) => {
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, layer.width, layer.height);
    };

    const beginWorld = (context, ratio) => {
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.save();
      context.translate(transform.offsetX, transform.offsetY);
      context.scale(transform.scale, transform.scale);
    };

    const drawTethers = (context, visualNodes) => {
      renderedEdges.filter((edge) => edge.ghost).forEach((edge) => {
        const from = visualNodes.get(edge.from);
        const to = renderedNodes.find((node) => node.id === edge.to);
        if (from && to) drawGhostTether(context, from, to, edge.bend ?? 0, palette.ghost);
      });
    };

    const drawRevisitGlow = (context, visualNodes, now) => {
      if (reducedMotion) return;
      visualNodes.forEach((node) => {
        if (node.ghost || node.heatAt == null) return;
        const progress = clamp((now - node.heatAt) / 900, 0, 1);
        if (progress <= 0 || progress >= 1) return;
        const alpha = Math.sin(progress * Math.PI) * 0.16;
        const radius = Math.max(node.radiusX, node.radiusY) * (1.08 + progress * 0.12);
        const glow = context.createRadialGradient(
          node.x,
          node.y,
          Math.max(node.radius * 0.82, 1),
          node.x,
          node.y,
          radius,
        );
        glow.addColorStop(0, `rgba(247, 130, 105, ${alpha})`);
        glow.addColorStop(1, "rgba(247, 130, 105, 0)");
        context.fillStyle = glow;
        context.beginPath();
        context.arc(node.x, node.y, radius, 0, Math.PI * 2);
        context.fill();
      });
    };

    const drawCommittedMaterial = (context, visualNodes, now) => {
      const materialEdges = renderedEdges.filter((edge) => !connectionIsPopping(edge, now));
      drawFluidMaterial(context, visualNodes, materialEdges, {
        color: palette.material,
        colorForNode: (node) => concept === "paper"
          ? palette.material
          : palette.materialByDepth[clamp(node.depth ?? 0, 0, palette.materialByDepth.length - 1)],
        now,
        reducedMotion,
        settings: PAPER_MATERIAL_SETTINGS,
      });
    };

    const applyPaperGrain = (context) => {
      if (!textureRef.current) return;
      const pattern = context.createPattern(textureRef.current, "repeat");
      if (!pattern) return;
      context.save();
      context.globalCompositeOperation = "source-atop";
      context.globalAlpha = 0.035;
      context.fillStyle = pattern;
      context.fillRect(0, 0, BASE_WIDTH, BASE_HEIGHT);
      context.restore();
    };

    const drawConnectionPops = (context, visualNodes, now) => {
      poppingConnectionsRef.current = poppingConnectionsRef.current.filter((pop) => {
        const progress = clamp((now - pop.start) / pop.duration, 0, 1);
        if (progress >= 1) return Boolean(pop.hideUntilResolved);
        const a = visualNodes.get(pop.aId) ?? pop.a;
        const b = visualNodes.get(pop.bId) ?? pop.b;
        const fill = context.createLinearGradient(a.x, a.y, b.x, b.y);
        const colorA = concept === "paper"
          ? palette.material
          : palette.materialByDepth[clamp(a.depth ?? 0, 0, palette.materialByDepth.length - 1)];
        const colorB = concept === "paper"
          ? palette.material
          : palette.materialByDepth[clamp(b.depth ?? 0, 0, palette.materialByDepth.length - 1)];
        fill.addColorStop(0, colorA);
        fill.addColorStop(1, colorB);
        drawFluidConnectionPop(context, a, b, PAPER_MATERIAL_SETTINGS, pop, progress, fill);
        return true;
      });
    };

    const drawMotionField = (context, visualNodes) => {
      visualNodes.forEach((node) => {
        if (node.ghost || node.motionShadeStrength <= 0) return;
        const strength = clamp(node.motionShadeStrength, 0, 1);
        const red = Math.round(clamp(node.motionShadeX * 0.5 + 0.5, 0, 1) * 255);
        const green = Math.round(clamp(node.motionShadeY * 0.5 + 0.5, 0, 1) * 255);
        const radius = Math.max(node.radiusX, node.radiusY) * 1.72;
        const centerAlpha = Math.min(0.82, strength * 0.9);
        const field = context.createRadialGradient(
          node.x,
          node.y,
          Math.max(node.radius * 0.18, 1),
          node.x,
          node.y,
          radius,
        );
        field.addColorStop(0, `rgba(${red}, ${green}, 255, ${centerAlpha})`);
        field.addColorStop(0.58, `rgba(${red}, ${green}, 255, ${centerAlpha * 0.72})`);
        field.addColorStop(1, `rgba(${red}, ${green}, 255, 0)`);
        context.fillStyle = field;
        context.beginPath();
        context.arc(node.x, node.y, radius, 0, Math.PI * 2);
        context.fill();
      });
    };

    const drawGhostsSelectionAndText = (context, visualNodes) => {
      renderedNodes.filter((node) => node.ghost).forEach((node) => {
        drawWobblyCircle(context, node);
        context.fillStyle = palette.ghostFill;
        context.fill();
        context.setLineDash([4, 4]);
        context.lineWidth = 1.5;
        context.strokeStyle = palette.ghost;
        context.stroke();
        context.setLineDash([]);
      });

      renderedNodes.forEach((node) => {
        if (!selectedIdSet.has(node.id)) return;
        const visual = visualNodes.get(node.id) ?? node;
        drawSelectionContour(context, visual, concept, transform.scale);
      });

      renderedNodes.forEach((node) => {
        const visual = visualNodes.get(node.id) ?? node;
        drawWrappedText(context, node, visual.x, visual.y, palette, showProvenance);
      });
    };

    const hasMaterialAnimation = (now) => (
      (!reducedMotion && renderedNodes.some((node) => (
        (node.createdAt != null && now - node.createdAt < 900)
        || (node.heatAt != null && now - node.heatAt < 900)
        || (node.wobbleEndAt != null
          ? now < node.wobbleEndAt + 80
          : node.wobbleStart != null && now - node.wobbleStart < 760)
      )))
      || (!reducedMotion && renderedEdges.some((edge) => (
        edge.createdAt != null && now - edge.createdAt < CONNECTION_CREATE_DURATION + 80
      )))
      || poppingConnectionsRef.current.some((pop) => now < pop.start + pop.duration)
    );

    const draw = (now) => {
      const animatingBeforeDraw = hasMaterialAnimation(now);
      const needsFinalMaterialFrame = wasAnimating && !animatingBeforeDraw;

      clearLayer(ctx, canvas);
      clearLayer(underlayCtx, underlayCanvas);

      const visualNodes = buildFluidVisualNodes(renderedNodes, now, reducedMotion);
      if (concept === "paper") {
        beginWorld(underlayCtx, dpr);
        drawTethers(underlayCtx, visualNodes);
        drawRevisitGlow(underlayCtx, visualNodes, now);
        const hoveredNode = visualNodes.get(connectionPreview?.targetId ?? hoveredNodeId);
        if (hoveredNode && !marqueeActive) {
          drawHoverGlow(underlayCtx, hoveredNode, concept, transform.scale);
        }

        if (paperShaderActive) {
          underlayCtx.restore();
          if (materialDirty || animatingBeforeDraw || needsFinalMaterialFrame) {
            clearLayer(materialCtx, materialRasterRef.current);
            clearLayer(motionCtx, motionRasterRef.current);
            beginWorld(materialCtx, shaderDpr);
            drawCommittedMaterial(materialCtx, visualNodes, now);
            applyPaperGrain(materialCtx);
            drawConnectionPops(materialCtx, visualNodes, now);
            materialCtx.restore();
            beginWorld(motionCtx, shaderDpr);
            drawMotionField(motionCtx, visualNodes);
            motionCtx.restore();
            renderer.update(materialRasterRef.current, motionRasterRef.current);
          }
          renderer.render();
        } else {
          drawCommittedMaterial(underlayCtx, visualNodes, now);
          applyPaperGrain(underlayCtx);
          drawConnectionPops(underlayCtx, visualNodes, now);
          underlayCtx.restore();
        }

        beginWorld(ctx, dpr);
        drawGhostsSelectionAndText(ctx, visualNodes);
        ctx.restore();
      } else {
        beginWorld(ctx, dpr);
        drawTethers(ctx, visualNodes);
        const root = visualNodes.get("root");
        if (root) {
          const halo = ctx.createRadialGradient(root.x, root.y, root.r * 0.72, root.x, root.y, root.r * 1.48);
          halo.addColorStop(0, "rgba(255, 112, 82, 0.22)");
          halo.addColorStop(0.58, "rgba(255, 94, 68, 0.09)");
          halo.addColorStop(1, "rgba(255, 78, 55, 0)");
          ctx.fillStyle = halo;
          ctx.beginPath();
          ctx.arc(root.x, root.y, root.r * 1.48, 0, Math.PI * 2);
          ctx.fill();
        }
        const hoveredNode = visualNodes.get(connectionPreview?.targetId ?? hoveredNodeId);
        if (hoveredNode && !marqueeActive) {
          drawHoverGlow(ctx, hoveredNode, concept, transform.scale);
        }
        drawCommittedMaterial(ctx, visualNodes, now);
        drawConnectionPops(ctx, visualNodes, now);
        drawGhostsSelectionAndText(ctx, visualNodes);
        ctx.restore();
      }

      materialDirty = false;
      const animatingAfterDraw = hasMaterialAnimation(now);
      wasAnimating = animatingAfterDraw;
      if (animatingAfterDraw) {
        frame = window.requestAnimationFrame(draw);
      }
    };

    frame = window.requestAnimationFrame(draw);
    return () => window.cancelAnimationFrame(frame);
  }, [
    concept,
    connectFromId,
    connectionPreview,
    fontReady,
    hoveredNodeId,
    marqueeActive,
    palette,
    reducedMotion,
    renderedEdges,
    renderedNodes,
    selectedIdSet,
    shaderAvailable,
    showProvenance,
    textureReady,
    transform,
    viewport,
  ]);

  const screenToWorld = (clientX, clientY) => {
    const rect = canvasRef.current.getBoundingClientRect();
    return {
      x: (clientX - rect.left - transform.offsetX) / transform.scale,
      y: (clientY - rect.top - transform.offsetY) / transform.scale,
    };
  };

  const hitNode = (point) => [...renderedNodes]
    .reverse()
    .find((node) => Math.hypot(node.x - point.x, node.y - point.y) <= node.r + 4);

  const hitConnection = (point) => findFluidConnectionHit(
    point,
    renderedNodes,
    renderedEdges.filter((edge) => !connectionIsPopping(edge)),
  );

  const nodesIntersectingRect = (start, end) => {
    const left = Math.min(start.x, end.x);
    const right = Math.max(start.x, end.x);
    const top = Math.min(start.y, end.y);
    const bottom = Math.max(start.y, end.y);
    return renderedNodes.filter((node) => {
      const closestX = clamp(node.x, left, right);
      const closestY = clamp(node.y, top, bottom);
      return Math.hypot(node.x - closestX, node.y - closestY) <= node.r;
    }).map((node) => node.id);
  };

  const popConnection = (connection) => {
    const now = performance.now();
    const duration = reducedMotion ? 1 : CONNECTION_POP_DURATION;
    const impacts = getConnectionPopImpactTimes(
      now,
      connection.hit.t,
      duration,
      connection.a,
      connection.b,
      PAPER_MATERIAL_SETTINGS,
    );
    const seedText = `${connection.link.from}:${connection.link.to}`;
    const seed = [...seedText].reduce((value, character) => (
      ((value * 31) + character.charCodeAt(0)) >>> 0
    ), Math.round(now));
    const pop = {
      edgeId: connection.link.id,
      aId: connection.a.id,
      bId: connection.b.id,
      a: { ...connection.a, radius: connection.a.radius ?? connection.a.r },
      b: { ...connection.b, radius: connection.b.radius ?? connection.b.r },
      hitT: connection.hit.t,
      seed,
      start: now,
      duration,
    };
    poppingConnectionsRef.current.push(pop);
    const accepted = onRemoveConnection(connection.link, {
      hitT: connection.hit.t,
      sourceImpactAt: impacts.source,
      targetImpactAt: impacts.target,
    });
    if (accepted === false) {
      const index = poppingConnectionsRef.current.indexOf(pop);
      if (index >= 0) poppingConnectionsRef.current.splice(index, 1);
    }
  };

  const touchPointers = () => [...activePointersRef.current.values()]
    .filter((pointer) => pointer.pointerType === "touch");

  const touchCentroid = (pointers) => ({
    x: pointers.reduce((sum, pointer) => sum + pointer.x, 0) / pointers.length,
    y: pointers.reduce((sum, pointer) => sum + pointer.y, 0) / pointers.length,
  });

  const touchDistance = (pointers) => {
    if (pointers.length < 2) return 1;
    return Math.max(Math.hypot(pointers[0].x - pointers[1].x, pointers[0].y - pointers[1].y), 1);
  };

  const beginTouchGesture = (pointers) => {
    const centroid = touchCentroid(pointers);
    const rect = canvasRef.current.getBoundingClientRect();
    return {
      type: "touch-gesture",
      startDistance: touchDistance(pointers),
      startZoom: zoom,
      worldX: (centroid.x - rect.left - transform.offsetX) / transform.scale,
      worldY: (centroid.y - rect.top - transform.offsetY) / transform.scale,
    };
  };

  const beginConnection = (event, source) => {
    if (event.button !== 0 || marqueeActive || source.ghost) return;
    event.preventDefault();
    event.stopPropagation();
    window.clearTimeout(longPressRef.current);
    suppressBudClickRef.current = false;
    onSelect(source.id);
    onActionsChange(null);
    if (connectFromId) onCancelConnect();
    activePointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY, pointerType: event.pointerType });
    if (touchPointers().length > 1) {
      suppressBudClickRef.current = true;
      if (dragRef.current?.type === "node") onMoveCancel(dragRef.current.id);
      setConnectionPreview(null);
      dragRef.current = beginTouchGesture(touchPointers());
    } else {
      const point = screenToWorld(event.clientX, event.clientY);
      dragRef.current = { type: "connect", id: source.id, pointerId: event.pointerId, startClientX: event.clientX, startClientY: event.clientY };
      setConnectionPreview({ sourceId: source.id, point, targetId: null });
    }
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const updateConnection = (event, drag) => {
    const point = screenToWorld(event.clientX, event.clientY);
    const target = connectionTargetAt(point, drag.id, renderedNodes, edges, 12 / transform.scale);
    if (Math.hypot(event.clientX - drag.startClientX, event.clientY - drag.startClientY) > 5) suppressBudClickRef.current = true;
    setConnectionPreview({ sourceId: drag.id, point, targetId: target?.id ?? null });
    return target;
  };

  const handlePointerDown = (event) => {
    if (event.button !== 0 || controlsHidden) return;
    window.clearTimeout(longPressRef.current);
    activePointersRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
      pointerType: event.pointerType,
    });
    const touches = touchPointers();
    if (event.pointerType === "touch" && touches.length >= 2) {
      suppressBudClickRef.current = true;
      setConnectionPreview(null);
      if (dragRef.current?.type === "node") onMoveCancel(dragRef.current.id);
      if (["marquee", "lasso"].includes(dragRef.current?.type)) { setMarqueeRect(null); setLassoPoints([]); onSelectMany([]); }
      dragRef.current = beginTouchGesture(touches);
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }
    const point = screenToWorld(event.clientX, event.clientY);
    if (marqueeActive) {
      const rect = canvasRef.current.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      onSelectMany([]);
      if (lassoActive) setLassoPoints([point]);
      else setMarqueeRect({ left: x, top: y, width: 0, height: 0 });
      dragRef.current = {
        type: lassoActive ? "lasso" : "marquee",
        points: [point],
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startWorld: point,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }
    const hit = hitNode(point);
    if (hit) {
      onSelect(hit.id);
      onMoveStart(hit.id);
      dragRef.current = {
        type: "node",
        id: hit.id,
        pointerId: event.pointerId,
        startX: point.x,
        startY: point.y,
        offsetX: point.x - hit.x,
        offsetY: point.y - hit.y,
        lastX: point.x,
        lastY: point.y,
        lastAt: performance.now(),
        vx: 0,
        vy: 0,
        moved: false,
      };
      if (event.pointerType === "touch" && !hit.ghost) {
        longPressRef.current = window.setTimeout(() => {
          if (dragRef.current?.type !== "node" || dragRef.current.moved) return;
          onMoveCancel(hit.id);
          dragRef.current = null;
          onActionsChange(hit.id);
        }, 550);
      }
    } else {
      const connectionHit = hitConnection(point);
      if (!connectionHit) onSelect(null);
      dragRef.current = {
        type: "pan",
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        panX: pan.x,
        panY: pan.y,
        moved: false,
        connectionHit,
      };
    }
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event) => {
    if (activePointersRef.current.has(event.pointerId)) {
      activePointersRef.current.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
        pointerType: event.pointerType,
      });
    }
    const drag = dragRef.current;
    if (!drag) {
      if (event.pointerType !== "touch" && !marqueeActive) {
        const point = screenToWorld(event.clientX, event.clientY);
        const hovered = hitNode(point);
        const previous = renderedNodes.find((node) => node.id === hoveredNodeId);
        if (!hovered && previous && !previous.ghost) {
          const bud = connectionBud(previous, renderedNodes, transform, viewport);
          const rect = canvasRef.current.getBoundingClientRect();
          if (Math.hypot(event.clientX - rect.left - bud.x, event.clientY - rect.top - bud.y) <= 30) return;
        }
        setHoveredNodeId((current) => current === hovered?.id ? current : hovered?.id ?? null);
      }
      return;
    }
    if (drag.type === "touch-gesture") {
      const touches = touchPointers();
      if (touches.length < 2) return;
      const centroid = touchCentroid(touches);
      const rect = canvasRef.current.getBoundingClientRect();
      const nextZoom = clamp(
        drag.startZoom * (touchDistance(touches) / drag.startDistance),
        MIN_ZOOM,
        MAX_ZOOM,
      );
      const fit = Math.min(viewport.width / BASE_WIDTH, viewport.height / BASE_HEIGHT);
      const nextScale = fit * nextZoom;
      const centeredX = (viewport.width - BASE_WIDTH * nextScale) / 2;
      const centeredY = (viewport.height - BASE_HEIGHT * nextScale) / 2;
      setPan({
        x: centroid.x - rect.left - centeredX - drag.worldX * nextScale,
        y: centroid.y - rect.top - centeredY - drag.worldY * nextScale,
      });
      setZoom(nextZoom);
      event.preventDefault();
      return;
    }
    if (drag.pointerId !== event.pointerId) return;
    if (drag.type === "connect") {
      updateConnection(event, drag);
      event.preventDefault();
      return;
    }
    if (drag.type === "lasso") {
      const point = screenToWorld(event.clientX, event.clientY);
      const last = drag.points.at(-1);
      if (Math.hypot(point.x - last.x, point.y - last.y) * transform.scale >= 2) {
        drag.points.push(point);
        setLassoPoints([...drag.points]);
        onSelectMany(renderedNodes.filter((node) => lassoIntersectsNode(drag.points, node)).map((node) => node.id));
      }
      event.preventDefault();
      return;
    }
    if (drag.type === "marquee") {
      const rect = canvasRef.current.getBoundingClientRect();
      const startX = drag.startClientX - rect.left;
      const startY = drag.startClientY - rect.top;
      const currentX = event.clientX - rect.left;
      const currentY = event.clientY - rect.top;
      const point = screenToWorld(event.clientX, event.clientY);
      setMarqueeRect({
        left: Math.min(startX, currentX),
        top: Math.min(startY, currentY),
        width: Math.abs(currentX - startX),
        height: Math.abs(currentY - startY),
      });
      onSelectMany(nodesIntersectingRect(drag.startWorld, point));
      event.preventDefault();
      return;
    }
    if (drag.type === "pan") {
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 5) {
        drag.moved = true;
      }
      setPan({
        x: drag.panX + event.clientX - drag.startX,
        y: drag.panY + event.clientY - drag.startY,
      });
      return;
    }
    const point = screenToWorld(event.clientX, event.clientY);
    const now = performance.now();
    const elapsed = Math.max(now - drag.lastAt, 1);
    drag.vx = ((point.x - drag.lastX) / elapsed) * 16.67;
    drag.vy = ((point.y - drag.lastY) / elapsed) * 16.67;
    drag.lastX = point.x;
    drag.lastY = point.y;
    drag.lastAt = now;
    if (Math.hypot(point.x - drag.startX, point.y - drag.startY) > 5) {
      drag.moved = true;
      window.clearTimeout(longPressRef.current);
    }
    onMoveNode(
      drag.id,
      clamp(point.x - drag.offsetX, 30, BASE_WIDTH - 30),
      clamp(point.y - drag.offsetY, 30, BASE_HEIGHT - 30),
    );
  };

  const handlePointerEnd = (event) => {
    window.clearTimeout(longPressRef.current);
    const drag = dragRef.current;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    activePointersRef.current.delete(event.pointerId);
    if (!drag) return;
    if (drag.type === "touch-gesture") {
      const touches = touchPointers();
      if (touches.length >= 2) {
        dragRef.current = beginTouchGesture(touches);
      } else {
        dragRef.current = null;
      }
      return;
    }
    if (drag.pointerId !== event.pointerId) return;
    if (drag.type === "connect") {
      const target = event.type === "pointercancel" ? null : updateConnection(event, drag);
      if (event.type === "pointercancel") suppressBudClickRef.current = true;
      setConnectionPreview(null);
      dragRef.current = null;
      if (target && suppressBudClickRef.current) {
        suppressBudClickRef.current = true;
        onConnect(drag.id, target.id);
      }
      return;
    }
    if (drag.type === "marquee" || drag.type === "lasso") {
      if (event.type === "pointercancel") onSelectMany([]);
      else if (drag.type === "lasso") {
        const points = [...drag.points, screenToWorld(event.clientX, event.clientY)];
        onSelectMany(renderedNodes.filter((node) => lassoIntersectsNode(points, node)).map((node) => node.id));
      }
      setLassoPoints([]);
      setMarqueeRect(null);
      dragRef.current = null;
      return;
    }
    if (drag.type === "pan" && drag.connectionHit && !drag.moved && event.type !== "pointercancel") {
      lastConnectionPopRef.current = {
        x: event.clientX,
        y: event.clientY,
        at: performance.now(),
      };
      popConnection(drag.connectionHit);
    }
    if (drag.type === "node") {
      if (event.type === "pointercancel") onMoveCancel(drag.id);
      else onMoveEnd(drag.id, drag.vx, drag.vy, drag.moved);
    }
    if (event.pointerType !== "touch") {
      const hovered = event.type === "pointercancel"
        ? null
        : hitNode(screenToWorld(event.clientX, event.clientY));
      setHoveredNodeId(hovered?.id ?? null);
    }
    dragRef.current = null;
  };

  const handlePointerLeave = (event) => {
    if (event.relatedTarget?.closest?.('.connection-bud')) return;
    if (!dragRef.current) setHoveredNodeId(null);
  };

  const handleLostCapture = (event) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    handlePointerEnd({ type: "pointercancel", pointerId: event.pointerId, pointerType: event.pointerType, currentTarget: event.currentTarget, clientX: event.clientX, clientY: event.clientY });
  };

  const handleDoubleClick = (event) => {
    if (marqueeActive || controlsHidden) return;
    const point = screenToWorld(event.clientX, event.clientY);
    const hit = hitNode(point);
    if (hit) {
      if (!hit.ghost) onEdit(hit.id);
      return;
    }
    const recentPop = lastConnectionPopRef.current;
    if (
      recentPop
      && performance.now() - recentPop.at < 500
      && Math.hypot(event.clientX - recentPop.x, event.clientY - recentPop.y) < 14
    ) return;
    if (connectFromId || hitConnection(point)) return;
    onSpawnFreeform(point.x, point.y);
  };

  const selected = renderedNodes.find((node) => node.id === selectedId);
  const budNode = renderedNodes.find((node) => node.id === (connectionPreview?.sourceId ?? hoveredNodeId)) ?? selected;
  const bud = budNode && !budNode.ghost ? connectionBud(budNode, renderedNodes, transform, viewport) : null;
  const previewSource = renderedNodes.find((node) => node.id === connectionPreview?.sourceId);
  const previewTarget = renderedNodes.find((node) => node.id === connectionPreview?.targetId);
  const previewHit = connectionPreview ? hitNode(connectionPreview.point) : null;
  const connectionHint = previewTarget ? "Release to connect" : previewHit?.ghost ? "Accept this suggestion first" : previewHit && previewHit.id !== previewSource?.id ? "Already connected" : "Drag onto an existing thought";
  let previewEnd = connectionPreview?.point;
  if (previewSource && previewTarget) {
    const angle = Math.atan2(previewSource.y - previewTarget.y, previewSource.x - previewTarget.x);
    previewEnd = { x: previewTarget.x + Math.cos(angle) * previewTarget.r, y: previewTarget.y + Math.sin(angle) * previewTarget.r };
  }
  const menuNode = renderedNodes.find((node) => node.id === (connectFromId ?? actionsNodeId));
  const menuX = menuNode ? clamp(transform.offsetX + menuNode.x * transform.scale, 120, Math.max(120, viewport.width - 120)) : 0;
  const menuY = menuNode ? clamp(transform.offsetY + (menuNode.y + menuNode.r) * transform.scale + 18, 80, Math.max(80, viewport.height - 240)) : 0;
  const closeMenu = () => { onActionsChange(null); if (connectFromId) onCancelConnect(); };
  const menuAction = (action) => { closeMenu(); action(menuNode.id); };
  const actionX = selected
    ? clamp(transform.offsetX + (selected.x + selected.r - (selected.r > 100 ? 12 : 0)) * transform.scale, 94, viewport.width - 54)
    : 0;
  const actionY = selected
    ? clamp(transform.offsetY + selected.y * transform.scale, 116, viewport.height - 116)
    : 0;

  return (
    <div
      className={`map-shell ${marqueeActive ? "is-marquee" : ""} ${connectionPreview ? "is-connecting" : ""}`}
      ref={shellRef}
      data-selection-mode={marqueeActive ? (lassoActive ? "lasso" : "rectangle") : "none"}
      data-marquee-active={marqueeActive ? "true" : "false"}
      data-selected-count={selectedIds.length}
      data-zoom={zoom.toFixed(2)}
      data-pan-x={Math.round(pan.x)}
      data-pan-y={Math.round(pan.y)}
      data-material-renderer={concept === "paper" && shaderAvailable ? "webgl2" : "canvas2d"}
      data-connecting-from={connectionPreview?.sourceId ?? ""}
      data-connection-target={connectionPreview?.targetId ?? ""}
    >
      <canvas
        ref={underlayCanvasRef}
        className="map-underlay-canvas"
        aria-hidden="true"
      />
      <canvas
        ref={shaderCanvasRef}
        className={`material-shader-canvas ${concept === "paper" && shaderAvailable ? "is-active" : ""}`}
        aria-hidden="true"
      />
      <canvas
        ref={canvasRef}
        className="map-interaction-canvas"
        aria-label="Interactive organic idea map. Drag a thought to move it; drag its outer handle to connect it. Right-click or long-press a thought for actions. Double-click empty space to create a freeform thought. Use two fingers, a trackpad, or the empty canvas to pan."
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onLostPointerCapture={handleLostCapture}
        onPointerLeave={handlePointerLeave}
        onDoubleClick={handleDoubleClick}
        onContextMenu={(event) => {
          const hit = hitNode(screenToWorld(event.clientX, event.clientY));
          if (marqueeActive || controlsHidden || !hit || hit.ghost) return;
          event.preventDefault();
          onSelect(hit.id);
          onActionsChange(hit.id);
        }}
      />

      {previewSource && previewEnd && <svg className="connection-preview" viewBox={`0 0 ${viewport.width} ${viewport.height}`} aria-hidden="true" data-testid="connection-preview">
        <path transform={`translate(${transform.offsetX} ${transform.offsetY}) scale(${transform.scale})`} d={connectionPreviewPath(previewSource, previewEnd, transform.scale)} fill={palette.material} />
      </svg>}

      {connectionPreview && <div className="connection-drag-hint" role="status" style={{ left: clamp(transform.offsetX + connectionPreview.point.x * transform.scale, 160, Math.max(160, viewport.width - 160)), top: clamp(transform.offsetY + connectionPreview.point.y * transform.scale + 28, 80, viewport.height - 60) }}><IconLink /><span>{connectionHint}</span><kbd>esc</kbd></div>}

      {bud && !marqueeActive && !menuNode && !controlsHidden && <button
        type="button"
        className={`connection-bud ${connectionPreview ? "is-dragging" : ""}`}
        style={{ left: bud.x, top: bud.y }}
        data-testid="connection-bud"
        aria-label={`Connect from ${nodeLabel(budNode)}`}
        aria-describedby="connection-handle-help"
        aria-haspopup="menu"
        onPointerDown={(event) => beginConnection(event, budNode)}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onLostPointerCapture={handleLostCapture}
        onPointerEnter={() => setHoveredNodeId(budNode.id)}
        onPointerLeave={handlePointerLeave}
        onClick={(event) => {
          if (event.detail > 0 && suppressBudClickRef.current) return;
          onSelect(budNode.id);
          onArmConnect(budNode.id);
        }}
      ><span className="connection-bud-shape" aria-hidden="true"><IconLink stroke={1.7} /></span><span id="connection-handle-help" className="connection-handle-help" role="tooltip"><strong>Connect existing</strong><span>Drag to another thought</span></span></button>}

      {menuNode && !menuNode.ghost && !marqueeActive && <div
        ref={bubbleMenuRef}
        className="bubble-menu"
        role="menu"
        aria-label={connectFromId ? "Connect to a thought" : "Thought actions"}
        style={{ left: menuX, top: menuY }}
        onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) closeMenu(); }}
        onKeyDown={(event) => {
          if (!["ArrowDown", "ArrowUp", "Home", "End", "Escape"].includes(event.key)) return;
          event.preventDefault();
          event.stopPropagation();
          if (event.key === "Escape") { closeMenu(); window.requestAnimationFrame(() => shellRef.current?.querySelector('.connection-bud')?.focus()); return; }
          const items = [...event.currentTarget.querySelectorAll('button:not(:disabled)')];
          const index = items.indexOf(document.activeElement);
          const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
          items[next]?.focus();
        }}
      >
        {connectFromId ? <>
          <span className="bubble-menu-heading">Connect existing thought</span>
          {renderedNodes.filter((node) => canConnect(connectFromId, node.id, renderedNodes, edges)).map((node) => <button type="button" role="menuitem" key={node.id} onClick={() => { closeMenu(); onConnect(menuNode.id, node.id); }}>{nodeLabel(node)}</button>)}
          {!renderedNodes.some((node) => canConnect(connectFromId, node.id, renderedNodes, edges)) && <span className="bubble-menu-empty">{renderedNodes.filter((node) => !node.ghost).length < 2 ? "Add another thought to connect to." : "All visible thoughts are already connected to this one."}</span>}
          <button type="button" role="menuitem" onClick={closeMenu}><IconX />Cancel</button>
        </> : <>
          <button type="button" role="menuitem" data-testid="add-thought" onClick={() => menuAction(onAdd)}><IconPlus />New connected thought</button>
          <button type="button" role="menuitem" onClick={() => { onActionsChange(null); onArmConnect(menuNode.id); }}><IconLink />Connect existing…</button>
          <div className="bubble-menu-divider" role="separator" />
          <button type="button" role="menuitem" onClick={() => menuAction(onEdit)}><IconPencil />Edit thought</button>
          <button type="button" role="menuitem" data-testid="node-ai" onClick={() => menuAction(onAskAI)}><IconSparkles />Explore with Partner</button>
          <button type="button" role="menuitem" onClick={() => menuAction(onSources)}><IconQuote />View sources</button>
          <button type="button" role="menuitem" onClick={() => menuAction(onPin)}>{menuNode.pinned ? <IconPinnedOff /> : <IconPin />}{menuNode.pinned ? "Unpin position" : "Pin position"}</button>
          <button type="button" role="menuitem" onClick={() => menuAction(onPark)}><IconParking />{menuNode.parked ? "Bring thought back" : "Keep thought aside"}</button>
          <div className="bubble-menu-divider" role="separator" />
          <button type="button" role="menuitem" data-testid="delete-thought" className="danger-action" disabled={menuNode.id === rootId} onClick={() => menuAction(onDelete)}><IconTrash />Delete thought</button>
        </>}
      </div>}

      {lassoPoints.length > 1 && <svg className="lasso-overlay" viewBox={`0 0 ${viewport.width} ${viewport.height}`} aria-hidden="true" data-testid="lasso-outline">
        <polygon fillRule="evenodd" points={lassoPoints.map((point) => `${transform.offsetX + point.x * transform.scale},${transform.offsetY + point.y * transform.scale}`).join(" ")} />
      </svg>}

      {marqueeRect && (
        <div
          className="marquee-rectangle"
          data-testid="marquee-rectangle"
          style={marqueeRect}
          aria-hidden="true"
        />
      )}

      {renderedNodes.filter((node) => node.ghost).map((node) => (
        <button
          type="button"
          key={node.id}
          className="ghost-badge"
          style={{
            left: transform.offsetX + (node.x - node.r * 0.72) * transform.scale,
            top: transform.offsetY + (node.y + node.r * 0.58) * transform.scale,
          }}
          aria-label={`Review AI suggestion: ${nodeLabel(node)}`}
          title="Review AI suggestion"
          onClick={() => onSelect(node.id)}
        >
          <IconSparkles />
        </button>
      ))}

      {selected?.ghost && !marqueeActive && (
        <div
          className={`node-actions ${selected.ghost ? "ghost-actions" : ""}`}
          style={{ left: actionX, top: actionY }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {selected.ghost ? (
            <>
              <IconButton label="Accept AI suggestion" onClick={() => onAcceptGhost(selected.id)} testId="accept-suggestion">
                <IconCheck />
              </IconButton>
              <IconButton label="Dismiss AI suggestion" onClick={() => onDismissGhost(selected.id)} testId="dismiss-suggestion">
                <IconX />
              </IconButton>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
