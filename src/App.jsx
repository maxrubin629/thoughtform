import { useEffect, useMemo, useRef, useState } from "react";
import {
  IconAdjustments,
  IconAffiliate,
  IconArrowBackUp,
  IconArrowForwardUp,
  IconArrowRight,
  IconBulb,
  IconCheck,
  IconClock,
  IconEye,
  IconFocusCentered,
  IconGridDots,
  IconHierarchy2,
  IconLink,
  IconMap2,
  IconMarquee,
  IconMessageCircle,
  IconMicrophone,
  IconMinus,
  IconPencil,
  IconPlus,
  IconSearch,
  IconSend,
  IconSettings,
  IconSparkles,
  IconStack2,
  IconStar,
  IconTrash,
  IconUser,
  IconX,
} from "@tabler/icons-react";
import paperTextureUrl from "./assets/paper-texture.png";
import {
  CONNECTION_CREATE_CONTACT_PROGRESS,
  CONNECTION_CREATE_DURATION,
  CONNECTION_CREATE_RETURN_DELAY,
  CONNECTION_POP_DURATION,
  DEFAULT_MATERIAL_SETTINGS,
  buildFluidVisualNodes,
  clamp,
  drawFluidConnectionPop,
  drawFluidMaterial,
  findFluidConnectionHit,
  findGrowthPlacement,
  getConnectionPopImpactTimes,
  withWobble,
} from "./fluidMaterial.js";
import {
  FLUID_PHYSICS_SETTINGS,
  captureFluidRestLengths,
  stepFluidPhysics,
} from "./fluidPhysics.js";
import {
  BASE_HEIGHT,
  BASE_WIDTH,
  aiPrompts,
  initialEdges,
  initialNodes,
  voiceThoughts,
} from "./mapData.js";

const initialFluidEdges = captureFluidRestLengths(initialNodes, initialEdges, { reset: true });
const MIN_ZOOM = 0.72;
const MAX_ZOOM = 1.36;
const ZOOM_STEP = 0.08;

const paperMaterialSettings = {
  ...DEFAULT_MATERIAL_SETTINGS,
  bridgeWidth: 0.62,
  flare: 0.29,
  filletReach: 0.22,
};

const palettes = {
  paper: {
    material: "#f78269",
    materialByDepth: ["#f5795c", "#f8846b", "#f9937d", "#f9a08c", "#f5aa98"],
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

const panelMeta = {
  maps: { eyebrow: "Workspace", title: "Your maps", icon: IconMap2, side: "left" },
  search: { eyebrow: "Find", title: "Search this map", icon: IconSearch, side: "left" },
  history: { eyebrow: "Timeline", title: "Map history", icon: IconClock, side: "left" },
  profile: { eyebrow: "Local profile", title: "MR", icon: IconUser, side: "left" },
  ai: { eyebrow: "Creative partner", title: "Ask this map", icon: IconSparkles, side: "right" },
  layouts: { eyebrow: "One graph", title: "Switch the view", icon: IconHierarchy2, side: "right" },
  overview: { eyebrow: "Working artifact", title: "Map overview", icon: IconGridDots, side: "right" },
  layers: { eyebrow: "Visibility", title: "Canvas layers", icon: IconStack2, side: "right" },
  settings: { eyebrow: "Preferences", title: "Thoughtform settings", icon: IconSettings, side: "right" },
  composer: { eyebrow: "Complete thought", title: "Add to the map", icon: IconPencil, side: "right" },
};

function cloneNodes(nodes) {
  return nodes.map((node) => ({ ...node, lines: [...node.lines] }));
}

function cloneEdges(edges) {
  return edges.map((edge) => ({ ...edge }));
}

function nodeLabel(node) {
  return node?.lines?.join(" ") ?? "Thought";
}

function wrapThought(value, maxLength = 18) {
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return ["New thought"];
  const lines = [];
  let current = "";
  words.forEach((word) => {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxLength && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  });
  if (current) lines.push(current);
  return lines;
}

function radiusForThought(lines, fallbackRadius, ghost = false) {
  const longestLine = Math.max(...lines.map((line) => line.length), 1);
  const characterCount = lines.reduce((sum, line) => sum + line.length, 0);
  const contentRadius = Math.max(
    ghost ? 52 : 36,
    longestLine * 3.55,
    Math.sqrt(characterCount) * 10.5,
    22 + lines.length * 8,
  );
  return clamp(Math.max(fallbackRadius, contentRadius), ghost ? 52 : 36, ghost ? 78 : 82);
}

function formatTimer(seconds) {
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
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

function layoutHierarchy(nodes, edges) {
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

function IconButton({
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

function FloatingPanel({ panel, onClose, children }) {
  const meta = panelMeta[panel];
  const PanelIcon = meta.icon;
  return (
    <aside
      className={`floating-panel panel-${meta.side}`}
      role="dialog"
      aria-modal="false"
      aria-label={meta.title}
      data-testid={`${panel}-panel`}
    >
      <header className="panel-header">
        <div className="panel-title-mark"><PanelIcon /></div>
        <div>
          <span>{meta.eyebrow}</span>
          <h2>{meta.title}</h2>
        </div>
        <IconButton label={`Close ${meta.title}`} onClick={onClose} className="panel-close">
          <IconX />
        </IconButton>
      </header>
      <div className="panel-body">{children}</div>
    </aside>
  );
}

function ToggleRow({ label, description, checked, onChange, disabled = false }) {
  return (
    <label className={`toggle-row ${disabled ? "is-disabled" : ""}`}>
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <i aria-hidden="true" />
    </label>
  );
}

function MindMap({
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
  onArmConnect,
  onConnectTarget,
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
}) {
  const canvasRef = useRef(null);
  const shellRef = useRef(null);
  const textureRef = useRef(null);
  const dragRef = useRef(null);
  const activePointersRef = useRef(new Map());
  const interactionRef = useRef(null);
  const poppingConnectionsRef = useRef([]);
  const lastConnectionPopRef = useRef(null);
  const [viewport, setViewport] = useState({ width: BASE_WIDTH, height: BASE_HEIGHT });
  const [fontReady, setFontReady] = useState(false);
  const [textureReady, setTextureReady] = useState(false);
  const [marqueeRect, setMarqueeRect] = useState(null);
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
    if (marqueeActive) return;
    if (dragRef.current?.type === "marquee") dragRef.current = null;
    setMarqueeRect(null);
  }, [marqueeActive]);

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
    if (!canvas) return undefined;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(viewport.width * dpr);
    canvas.height = Math.round(viewport.height * dpr);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    const ctx = canvas.getContext("2d");
    let frame = 0;

    const draw = (now) => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, viewport.width, viewport.height);
      ctx.save();
      ctx.translate(transform.offsetX, transform.offsetY);
      ctx.scale(transform.scale, transform.scale);

      const visualNodes = buildFluidVisualNodes(renderedNodes, now, reducedMotion);
      renderedEdges.filter((edge) => edge.ghost).forEach((edge) => {
        const from = visualNodes.get(edge.from);
        const to = renderedNodes.find((node) => node.id === edge.to);
        if (from && to) drawGhostTether(ctx, from, to, edge.bend ?? 0, palette.ghost);
      });

      if (concept === "nocturne") {
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
      }

      drawFluidMaterial(ctx, visualNodes, renderedEdges, {
        color: palette.material,
        colorForNode: (node) => palette.materialByDepth[clamp(node.depth ?? 0, 0, palette.materialByDepth.length - 1)],
        now,
        reducedMotion,
        settings: paperMaterialSettings,
      });

      if (concept === "paper" && textureRef.current) {
        const pattern = ctx.createPattern(textureRef.current, "repeat");
        if (pattern) {
          ctx.save();
          ctx.globalCompositeOperation = "source-atop";
          ctx.globalAlpha = 0.035;
          ctx.fillStyle = pattern;
          ctx.fillRect(0, 0, BASE_WIDTH, BASE_HEIGHT);
          ctx.restore();
        }
      }

      poppingConnectionsRef.current = poppingConnectionsRef.current.filter((pop) => {
        const progress = clamp((now - pop.start) / pop.duration, 0, 1);
        if (progress >= 1) return false;
        const a = visualNodes.get(pop.aId) ?? pop.a;
        const b = visualNodes.get(pop.bId) ?? pop.b;
        const fill = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
        fill.addColorStop(0, palette.materialByDepth[clamp(a.depth ?? 0, 0, palette.materialByDepth.length - 1)]);
        fill.addColorStop(1, palette.materialByDepth[clamp(b.depth ?? 0, 0, palette.materialByDepth.length - 1)]);
        drawFluidConnectionPop(ctx, a, b, paperMaterialSettings, pop, progress, fill);
        return true;
      });

      renderedNodes.filter((node) => node.ghost).forEach((node) => {
        drawWobblyCircle(ctx, node);
        ctx.fillStyle = palette.ghostFill;
        ctx.fill();
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = palette.ghost;
        ctx.stroke();
        ctx.setLineDash([]);
      });

      renderedNodes.forEach((node) => {
        if (!selectedIdSet.has(node.id)) return;
        const visual = visualNodes.get(node.id) ?? node;
        ctx.save();
        ctx.beginPath();
        ctx.arc(visual.x, visual.y, visual.r + 7 / transform.scale, 0, Math.PI * 2);
        ctx.setLineDash([5 / transform.scale, 4 / transform.scale]);
        ctx.lineWidth = 2 / transform.scale;
        ctx.strokeStyle = concept === "nocturne" ? "rgba(255, 181, 158, 0.94)" : "rgba(132, 59, 45, 0.9)";
        ctx.stroke();
        ctx.restore();
      });

      const connecting = visualNodes.get(connectFromId);
      if (connecting) {
        ctx.beginPath();
        ctx.arc(connecting.x, connecting.y, connecting.r + 8, 0, Math.PI * 2);
        ctx.setLineDash([5, 4]);
        ctx.lineWidth = 1.4;
        ctx.strokeStyle = palette.ink;
        ctx.stroke();
        ctx.setLineDash([]);
      }

      renderedNodes.forEach((node) => {
        const visual = visualNodes.get(node.id) ?? node;
        drawWrappedText(ctx, node, visual.x, visual.y, palette, showProvenance);
      });

      ctx.restore();
      const animatingMaterial = !reducedMotion && renderedNodes.some((node) => (
        (node.createdAt != null && now - node.createdAt < 900)
        || (node.wobbleEndAt != null
          ? now < node.wobbleEndAt + 80
          : node.wobbleStart != null && now - node.wobbleStart < 760)
      )) || (!reducedMotion && renderedEdges.some((edge) => (
        edge.createdAt != null && now - edge.createdAt < CONNECTION_CREATE_DURATION + 80
      ))) || poppingConnectionsRef.current.length > 0;
      if (animatingMaterial) frame = window.requestAnimationFrame(draw);
    };

    frame = window.requestAnimationFrame(draw);
    return () => window.cancelAnimationFrame(frame);
  }, [
    concept,
    connectFromId,
    fontReady,
    palette,
    reducedMotion,
    renderedEdges,
    renderedNodes,
    selectedId,
    selectedIdSet,
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

  const hitConnection = (point) => findFluidConnectionHit(point, renderedNodes, renderedEdges);

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
      paperMaterialSettings,
    );
    const seedText = `${connection.link.from}:${connection.link.to}`;
    const seed = [...seedText].reduce((value, character) => (
      ((value * 31) + character.charCodeAt(0)) >>> 0
    ), Math.round(now));
    poppingConnectionsRef.current.push({
      aId: connection.a.id,
      bId: connection.b.id,
      a: { ...connection.a, radius: connection.a.radius ?? connection.a.r },
      b: { ...connection.b, radius: connection.b.radius ?? connection.b.r },
      hitT: connection.hit.t,
      seed,
      start: now,
      duration,
    });
    onRemoveConnection(connection.link, {
      hitT: connection.hit.t,
      sourceImpactAt: impacts.source,
      targetImpactAt: impacts.target,
    });
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

  const handlePointerDown = (event) => {
    if (event.button !== 0) return;
    activePointersRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
      pointerType: event.pointerType,
    });
    const touches = touchPointers();
    if (event.pointerType === "touch" && touches.length >= 2) {
      if (dragRef.current?.type === "node") onMoveCancel(dragRef.current.id);
      if (dragRef.current?.type === "marquee") setMarqueeRect(null);
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
      setMarqueeRect({ left: x, top: y, width: 0, height: 0 });
      dragRef.current = {
        type: "marquee",
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
    if (connectFromId && hit) {
      if (!hit.ghost && hit.id !== connectFromId) onConnectTarget(hit.id);
      return;
    }
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
    if (!drag) return;
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
    if (Math.hypot(point.x - drag.startX, point.y - drag.startY) > 5) drag.moved = true;
    onMoveNode(
      drag.id,
      clamp(point.x - drag.offsetX, 30, BASE_WIDTH - 30),
      clamp(point.y - drag.offsetY, 30, BASE_HEIGHT - 30),
    );
  };

  const handlePointerEnd = (event) => {
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
    if (drag.type === "marquee") {
      if (event.type === "pointercancel") onSelectMany([]);
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
    dragRef.current = null;
  };

  const handleDoubleClick = (event) => {
    if (marqueeActive) return;
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
  const actionX = selected
    ? clamp(transform.offsetX + (selected.x + selected.r - (selected.r > 100 ? 12 : 0)) * transform.scale, 94, viewport.width - 54)
    : 0;
  const actionY = selected
    ? clamp(transform.offsetY + selected.y * transform.scale, 116, viewport.height - 116)
    : 0;

  return (
    <div
      className={`map-shell ${marqueeActive ? "is-marquee" : ""}`}
      ref={shellRef}
      data-marquee-active={marqueeActive ? "true" : "false"}
      data-selected-count={selectedIds.length}
      data-zoom={zoom.toFixed(2)}
      data-pan-x={Math.round(pan.x)}
      data-pan-y={Math.round(pan.y)}
    >
      <canvas
        ref={canvasRef}
        aria-label="Interactive organic idea map. Drag thoughts to move them. Double-click empty space to create a freeform thought. Use two fingers, a trackpad, or the empty canvas to pan."
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onDoubleClick={handleDoubleClick}
      />

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

      {selected && (
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
          ) : (
            <>
              <IconButton label="Add child thought" onClick={() => onAdd(selected.id)} testId="add-thought">
                <IconPlus />
              </IconButton>
              <IconButton label="Generate child ideas" onClick={() => onAskAI(selected.id)} testId="node-ai">
                <IconSparkles />
              </IconButton>
              <IconButton
                label={connectFromId === selected.id ? "Cancel connection" : "Connect thought"}
                active={connectFromId === selected.id}
                onClick={() => onArmConnect(selected.id)}
                testId="connect-thought"
              >
                <IconLink />
              </IconButton>
              <IconButton label="Delete thought" onClick={() => onDelete(selected.id)} className="danger-action" testId="delete-thought">
                <IconTrash />
              </IconButton>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function App() {
  const concept = new URLSearchParams(window.location.search).get("concept") === "nocturne" ? "nocturne" : "paper";
  const [nodes, setNodes] = useState(() => cloneNodes(initialNodes));
  const [edges, setEdges] = useState(() => cloneEdges(initialFluidEdges));
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  const nextIdRef = useRef(1);
  const organicPositionsRef = useRef(new Map(initialNodes.map((node) => [node.id, { x: node.x, y: node.y }])));
  const [selectedId, setSelectedId] = useState("root");
  const [selectedIds, setSelectedIds] = useState(["root"]);
  const [marqueeActive, setMarqueeActive] = useState(false);
  const [activePanel, setActivePanel] = useState(null);
  const [composer, setComposer] = useState(null);
  const [composerValue, setComposerValue] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [aiQuery, setAiQuery] = useState("");
  const [aiMode, setAiMode] = useState("quiet");
  const [viewMode, setViewMode] = useState("clusters");
  const viewModeRef = useRef(viewMode);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [showSuggestions, setShowSuggestions] = useState(true);
  const [showProvenance, setShowProvenance] = useState(false);
  const [showPrivateIsland, setShowPrivateIsland] = useState(true);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [focusId, setFocusId] = useState(null);
  const [connectFromId, setConnectFromId] = useState(null);
  const [favorite, setFavorite] = useState(true);
  const [listening, setListening] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [voiceIndex, setVoiceIndex] = useState(0);
  const [toast, setToast] = useState("");
  const [history, setHistory] = useState(() => [{
    label: "Opened map",
    nodes: cloneNodes(initialNodes),
    edges: cloneEdges(initialFluidEdges),
    time: "Now",
  }]);
  const [historyIndex, setHistoryIndex] = useState(0);

  const selectOne = (id) => {
    setSelectedId(id);
    setSelectedIds(id ? [id] : []);
  };

  const selectMany = (ids) => {
    const nextIds = [...new Set(ids)];
    setSelectedId(null);
    setSelectedIds((current) => (
      current.length === nextIds.length && current.every((id, index) => id === nextIds[index])
        ? current
        : nextIds
    ));
  };

  // Physics and graph actions update these refs before mirroring into React state.
  // Syncing them back from a committed render can rewind a newer animation frame,
  // which becomes a visible two-frame shake on high-refresh displays.
  useEffect(() => { viewModeRef.current = viewMode; }, [viewMode]);
  useEffect(() => {
    let animationFrame;
    let lastTime = performance.now();
    const animatePhysics = (now) => {
      if (viewModeRef.current !== "clusters") {
        lastTime = now;
        animationFrame = window.requestAnimationFrame(animatePhysics);
        return;
      }
      const frameStep = clamp((now - lastTime) / 16.67, 0.35, 2);
      lastTime = now;
      const result = stepFluidPhysics(nodesRef.current, edgesRef.current, {
        frameStep,
        width: BASE_WIDTH,
        height: BASE_HEIGHT,
        settings: FLUID_PHYSICS_SETTINGS,
      });
      if (result.active) {
        nodesRef.current = result.nodes;
        setNodes(result.nodes);
        if (viewModeRef.current === "clusters") {
          result.nodes.forEach((node) => {
            if (!node.ghost) organicPositionsRef.current.set(node.id, { x: node.x, y: node.y });
          });
        }
      }
      animationFrame = window.requestAnimationFrame(animatePhysics);
    };
    animationFrame = window.requestAnimationFrame(animatePhysics);
    return () => window.cancelAnimationFrame(animationFrame);
  }, []);
  useEffect(() => {
    if (!listening) return undefined;
    const timer = window.setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [listening]);
  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(""), 2800);
    return () => window.clearTimeout(timer);
  }, [toast]);
  const selected = nodes.find((node) => node.id === selectedId);
  const visibleNodes = showPrivateIsland ? nodes : nodes.filter((node) => !node.island);
  const searchResults = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return nodes.filter((node) => !node.ghost).slice(0, 7);
    return nodes.filter((node) => nodeLabel(node).toLowerCase().includes(query)).slice(0, 9);
  }, [nodes, searchQuery]);
  const timer = formatTimer(seconds);
  const committedCount = nodes.filter((node) => !node.ghost).length;
  const suggestionCount = nodes.filter((node) => node.ghost).length;
  const deletableSelectionCount = selectedIds.filter((id) => id !== "root").length;

  const showToast = (message) => setToast(message);

  const pushHistory = (label, nextNodes, nextEdges) => {
    const snapshot = {
      label,
      nodes: cloneNodes(nextNodes),
      edges: cloneEdges(nextEdges),
      time: new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date()),
    };
    const nextHistory = [...history.slice(0, historyIndex + 1), snapshot].slice(-18);
    setHistory(nextHistory);
    setHistoryIndex(nextHistory.length - 1);
  };

  const applyGraph = (nextNodes, nextEdges, label, { rebasePhysics = false } = {}) => {
    const physicsEdges = captureFluidRestLengths(nextNodes, nextEdges, { reset: rebasePhysics });
    nodesRef.current = nextNodes;
    edgesRef.current = physicsEdges;
    setNodes(nextNodes);
    setEdges(physicsEdges);
    if (label) pushHistory(label, nextNodes, physicsEdges);
  };

  function restoreHistory(index) {
    const snapshot = history[index];
    if (!snapshot) return;
    const nextNodes = cloneNodes(snapshot.nodes);
    const nextEdges = captureFluidRestLengths(nextNodes, cloneEdges(snapshot.edges));
    nodesRef.current = nextNodes;
    edgesRef.current = nextEdges;
    setNodes(nextNodes);
    setEdges(nextEdges);
    setHistoryIndex(index);
    selectOne(nextNodes.some((node) => node.id === selectedId) ? selectedId : "root");
    showToast(snapshot.label);
  }

  function undo() {
    if (historyIndex > 0) restoreHistory(historyIndex - 1);
  }

  function redo() {
    if (historyIndex < history.length - 1) restoreHistory(historyIndex + 1);
  }

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        setActivePanel(null);
        setConnectFromId(null);
        if (marqueeActive) {
          setMarqueeActive(false);
          selectOne(null);
        }
      }
      const target = event.target;
      const editingText = target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target.isContentEditable;
      if (
        marqueeActive
        && selectedIds.length
        && !editingText
        && (event.key === "Delete" || event.key === "Backspace")
      ) {
        event.preventDefault();
        deleteSelectedThoughts();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [history, historyIndex, marqueeActive, selectedId, selectedIds]);

  const togglePanel = (panel) => {
    if (marqueeActive) {
      setMarqueeActive(false);
      selectOne(null);
    }
    setActivePanel((current) => current === panel ? null : panel);
    if (panel !== "composer") setComposer(null);
  };

  const toggleMarquee = () => {
    setMarqueeActive((current) => !current);
    setActivePanel(null);
    setComposer(null);
    setConnectFromId(null);
    selectOne(null);
  };

  const startMoveNode = (id) => {
    const next = nodesRef.current.map((node) => node.id === id ? {
      ...node,
      dragging: true,
      vx: 0,
      vy: 0,
    } : node);
    nodesRef.current = next;
    setNodes(next);
  };

  const moveNode = (id, x, y) => {
    const next = nodesRef.current.map((node) => node.id === id ? {
      ...node,
      x,
      y,
      dragging: true,
      vx: 0,
      vy: 0,
    } : node);
    nodesRef.current = next;
    setNodes(next);
    if (viewMode === "clusters") organicPositionsRef.current.set(id, { x, y });
  };

  const finishMoveNode = (id, vx, vy, moved) => {
    const release = 0.08 + (1 - FLUID_PHYSICS_SETTINGS.viscosity) * 0.08;
    const next = nodesRef.current.map((node) => {
      if (node.id !== id) return node;
      const released = {
        ...node,
        dragging: false,
        vx: moved ? clamp(vx, -24, 24) * release : 0,
        vy: moved ? clamp(vy, -24, 24) * release : 0,
      };
      return moved ? released : withWobble(released, 1, 0, 0.082);
    });
    nodesRef.current = next;
    setNodes(next);
    if (moved) {
      pushHistory(`Moved “${nodeLabel(next.find((node) => node.id === id))}”`, next, edgesRef.current);
    }
  };

  const cancelMoveNode = (id) => {
    const next = nodesRef.current.map((node) => node.id === id ? {
      ...node,
      dragging: false,
      vx: 0,
      vy: 0,
    } : node);
    nodesRef.current = next;
    setNodes(next);
  };

  const addThought = (text, parentId, options = {}) => {
    const parent = nodesRef.current.find((node) => node.id === parentId && !node.ghost)
      ?? nodesRef.current.find((node) => node.id === "root");
    if (!parent) return null;
    const id = `${options.ghost ? "ghost" : "thought"}-${Date.now()}-${nextIdRef.current++}`;
    const lines = wrapThought(text);
    const baseRadius = options.ghost ? 52 : clamp(parent.r * 0.52, 36, 58);
    const radius = radiusForThought(lines, baseRadius, Boolean(options.ghost));
    const placement = findGrowthPlacement(parent, radius, nodesRef.current, edgesRef.current, BASE_WIDTH, BASE_HEIGHT);
    const createdAt = performance.now();
    const node = {
      id,
      x: placement.x,
      y: placement.y,
      r: radius,
      depth: clamp((parent.depth ?? 0) + 1, 1, 4),
      lines,
      ghost: Boolean(options.ghost),
      provenance: options.provenance,
      createdAt,
    };
    const edge = {
      from: parent.id,
      to: id,
      bend: 0,
      ghost: Boolean(options.ghost),
      createdAt,
    };
    const nextNodes = [...nodesRef.current, node];
    const nextEdges = [...edgesRef.current, edge];
    applyGraph(nextNodes, nextEdges, options.ghost ? "AI proposed a thought" : "Added a thought");
    if (viewMode === "clusters") organicPositionsRef.current.set(id, { x: node.x, y: node.y });
    selectOne(id);
    if (options.ghost) setShowSuggestions(true);
    return id;
  };

  const spawnFreeformThought = (x, y) => {
    const lines = ["New thought"];
    const radius = radiusForThought(lines, 46, false);
    const id = `thought-${Date.now()}-${nextIdRef.current++}`;
    const node = {
      id,
      x: clamp(x, radius + 20, BASE_WIDTH - radius - 20),
      y: clamp(y, radius + 20, BASE_HEIGHT - radius - 20),
      r: radius,
      depth: 0,
      lines,
      provenance: "You",
      createdAt: performance.now(),
      vx: 0,
      vy: 0,
      dragging: false,
    };
    const nextNodes = [...nodesRef.current, node];
    applyGraph(nextNodes, edgesRef.current, "Added a freeform thought");
    if (viewMode === "clusters") organicPositionsRef.current.set(id, { x: node.x, y: node.y });
    setFocusId(null);
    selectOne(id);
    showToast("New thought added");
  };

  const openComposer = (parentId) => {
    setComposer({ mode: "add", parentId });
    setComposerValue("");
    setActivePanel("composer");
  };

  const openEditor = (id) => {
    const node = nodesRef.current.find((candidate) => candidate.id === id);
    if (!node || node.ghost) return;
    setComposer({ mode: "edit", id });
    setComposerValue(nodeLabel(node));
    setActivePanel("composer");
  };

  const submitComposer = (event) => {
    event.preventDefault();
    const value = composerValue.trim();
    if (!value || !composer) return;
    if (composer.mode === "edit") {
      const next = nodesRef.current.map((node) => {
        if (node.id !== composer.id) return node;
        const lines = wrapThought(value);
        return { ...node, lines, r: radiusForThought(lines, node.r, false) };
      });
      applyGraph(next, edgesRef.current, "Edited a thought");
      selectOne(composer.id);
      showToast("Thought updated");
    } else {
      addThought(value, composer.parentId, { provenance: "You" });
      showToast("Thought added to the map");
    }
    setActivePanel(null);
    setComposer(null);
    setComposerValue("");
  };

  const createSuggestion = (prompt = aiQuery) => {
    const text = prompt.trim();
    if (!text) return;
    const parentId = selected && !selected.ghost ? selected.id : "root";
    addThought(text, parentId, { ghost: true, provenance: "AI suggestion" });
    setAiQuery("");
    setActivePanel(null);
    showToast("AI suggestion added for review");
  };

  const acceptGhost = (id) => {
    const createdAt = performance.now();
    const nextNodes = nodesRef.current.map((node) => node.id === id
      ? { ...node, ghost: false, provenance: "AI suggestion · accepted", createdAt }
      : node);
    const nextEdges = edgesRef.current.map((edge) => edge.to === id
      ? { ...edge, ghost: false, createdAt }
      : edge);
    applyGraph(nextNodes, nextEdges, "Accepted an AI suggestion");
    selectOne(id);
    showToast("Suggestion accepted");
  };

  const dismissGhost = (id) => {
    const nextNodes = nodesRef.current.filter((node) => node.id !== id);
    const nextEdges = edgesRef.current.filter((edge) => edge.from !== id && edge.to !== id);
    applyGraph(nextNodes, nextEdges, "Dismissed an AI suggestion");
    selectOne("root");
    showToast("Suggestion dismissed");
  };

  const deleteThought = (id) => {
    if (id === "root") {
      showToast("The starting thought anchors this map");
      return;
    }
    const nextNodes = nodesRef.current.filter((node) => node.id !== id);
    const nextEdges = edgesRef.current.filter((edge) => edge.from !== id && edge.to !== id);
    applyGraph(nextNodes, nextEdges, "Removed a thought");
    organicPositionsRef.current.delete(id);
    selectOne("root");
    showToast("Thought removed");
  };

  const deleteSelectedThoughts = () => {
    const selectedSet = new Set(selectedIds);
    selectedSet.delete("root");
    if (!selectedSet.size) {
      showToast("The starting thought anchors this map");
      return;
    }
    const nextNodes = nodesRef.current.filter((node) => !selectedSet.has(node.id));
    const nextEdges = edgesRef.current.filter((edge) => (
      !selectedSet.has(edge.from) && !selectedSet.has(edge.to)
    ));
    applyGraph(
      nextNodes,
      nextEdges,
      selectedSet.size === 1 ? "Removed a selected thought" : `Removed ${selectedSet.size} selected thoughts`,
    );
    selectedSet.forEach((id) => organicPositionsRef.current.delete(id));
    if (focusId && selectedSet.has(focusId)) setFocusId(null);
    setConnectFromId(null);
    selectMany([]);
    const rootWasSelected = selectedIds.includes("root");
    showToast(`${selectedSet.size} ${selectedSet.size === 1 ? "thought" : "thoughts"} removed${rootWasSelected ? "; starting thought kept" : ""}`);
  };

  const armConnection = (id) => {
    setConnectFromId((current) => current === id ? null : id);
    showToast(connectFromId === id ? "Connection cancelled" : "Choose another thought to connect");
  };

  const connectTarget = (targetId) => {
    if (!connectFromId || connectFromId === targetId) return;
    const source = nodesRef.current.find((node) => node.id === connectFromId);
    const target = nodesRef.current.find((node) => node.id === targetId);
    if (!source || !target || source.ghost || target.ghost) {
      setConnectFromId(null);
      showToast("Accept a proposal before connecting it");
      return;
    }
    const exists = edgesRef.current.some((edge) => (
      (edge.from === connectFromId && edge.to === targetId)
      || (edge.from === targetId && edge.to === connectFromId)
    ));
    if (exists) {
      setConnectFromId(null);
      showToast("Those thoughts are already connected");
      return;
    }
    const dx = (target?.x ?? 0) - (source?.x ?? 0);
    const dy = (target?.y ?? 0) - (source?.y ?? 0);
    const createdAt = performance.now();
    const targetImpactAt = createdAt
      + CONNECTION_CREATE_DURATION * CONNECTION_CREATE_CONTACT_PROGRESS;
    const sourceReturnAt = targetImpactAt + CONNECTION_CREATE_RETURN_DELAY;
    const nextNodes = reducedMotion ? nodesRef.current : nodesRef.current.map((node) => {
      if (node.id === connectFromId) {
        const launched = withWobble(
          node,
          dx,
          dy,
          0.064,
          { startAt: createdAt, travel: 0.14 },
        );
        return withWobble(
          launched,
          -dx,
          -dy,
          0.038,
          { startAt: sourceReturnAt, travel: 0.11, append: true },
        );
      }
      if (node.id === targetId) return withWobble(
        node,
        dx,
        dy,
        0.105,
        { startAt: targetImpactAt, travel: 0.32 },
      );
      return node;
    });
    const nextEdges = [...edgesRef.current, {
      from: connectFromId,
      to: targetId,
      bend: 0,
      createdAt,
    }];
    applyGraph(nextNodes, nextEdges, "Connected two thoughts");
    setConnectFromId(null);
    selectOne(targetId);
    showToast("Thoughts connected");
  };

  const removeConnection = (targetEdge, motion = {}) => {
    const source = nodesRef.current.find((node) => node.id === targetEdge.from);
    const target = nodesRef.current.find((node) => node.id === targetEdge.to);
    if (!source || !target) return;
    const hitT = clamp(motion.hitT ?? 0.5, 0, 1);
    const hitX = source.x + (target.x - source.x) * hitT;
    const hitY = source.y + (target.y - source.y) * hitT;
    const sourceAmplitude = 0.036 + (1 - hitT) * 0.016;
    const targetAmplitude = 0.036 + hitT * 0.016;
    const matches = (edge) => (
      (edge.from === targetEdge.from && edge.to === targetEdge.to)
      || (edge.from === targetEdge.to && edge.to === targetEdge.from)
    );
    const nextEdges = edgesRef.current.filter((edge) => !matches(edge));
    const nextNodes = nodesRef.current.map((node) => {
      if (node.id === source.id) return withWobble(
        node,
        source.x - hitX,
        source.y - hitY,
        sourceAmplitude,
        { startAt: motion.sourceImpactAt, travel: 0.13 },
      );
      if (node.id === target.id) return withWobble(
        node,
        target.x - hitX,
        target.y - hitY,
        targetAmplitude,
        { startAt: motion.targetImpactAt, travel: 0.13 },
      );
      return node;
    });
    applyGraph(nextNodes, nextEdges, "Removed a connection");
    setConnectFromId(null);
    showToast("Connection popped");
  };

  const toggleVoice = () => {
    if (!listening) {
      setSeconds(0);
      setListening(true);
      showToast("Listening for a complete thought…");
      return;
    }
    setListening(false);
    const text = voiceThoughts[voiceIndex % voiceThoughts.length];
    const parentId = selected && !selected.ghost ? selected.id : "root";
    addThought(text, parentId, { provenance: "Voice · complete thought" });
    setVoiceIndex((value) => value + 1);
    showToast("Complete thought added to the map");
  };

  const changeLayout = (nextMode) => {
    if (nextMode === viewMode) {
      setActivePanel(null);
      return;
    }
    let nextNodes;
    if (nextMode === "hierarchy") {
      nodesRef.current.forEach((node) => organicPositionsRef.current.set(node.id, { x: node.x, y: node.y }));
      nextNodes = layoutHierarchy(nodesRef.current, edgesRef.current);
    } else {
      nextNodes = nodesRef.current.map((node) => ({ ...node, ...(organicPositionsRef.current.get(node.id) ?? {}) }));
    }
    applyGraph(nextNodes, edgesRef.current, `Switched to ${nextMode} view`, { rebasePhysics: true });
    setViewMode(nextMode);
    setPan({ x: 0, y: 0 });
    setZoom(1);
    setActivePanel(null);
    showToast(`${nextMode === "clusters" ? "Cluster" : "Hierarchy"} view`);
  };

  const toggleFocus = () => {
    if (focusId) {
      setFocusId(null);
      showToast("Showing the full map");
    } else {
      setFocusId(selectedId ?? "root");
      showToast(`Focused on “${nodeLabel(selected ?? nodes.find((node) => node.id === "root"))}”`);
    }
  };

  const panelContent = () => {
    if (!activePanel) return null;
    if (activePanel === "maps") {
      return (
        <>
          <button type="button" className="map-row is-current" onClick={() => setActivePanel(null)}>
            <span className="map-row-icon"><IconAffiliate /></span>
            <span><strong>Thinking visible</strong><small>{committedCount} thoughts · Local</small></span>
            <IconCheck />
          </button>
          <div className="panel-note"><IconEye /><span>Saved locally on this device. Nothing is shared unless you choose to export it.</span></div>
        </>
      );
    }
    if (activePanel === "search") {
      return (
        <>
          <label className="search-field">
            <IconSearch />
            <input autoFocus value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Search thoughts…" />
          </label>
          <div className="panel-list search-results">
            {searchResults.map((node) => (
              <button type="button" key={node.id} onClick={() => {
                selectOne(node.id);
                setActivePanel(null);
                setFocusId(null);
              }}>
                <span>{nodeLabel(node)}</span><IconArrowRight />
              </button>
            ))}
            {!searchResults.length && <p className="empty-state">No matching thoughts yet.</p>}
          </div>
        </>
      );
    }
    if (activePanel === "history") {
      return (
        <>
          <div className="history-actions">
            <IconButton label="Undo" onClick={undo} disabled={historyIndex <= 0}><IconArrowBackUp /></IconButton>
            <IconButton label="Redo" onClick={redo} disabled={historyIndex >= history.length - 1}><IconArrowForwardUp /></IconButton>
          </div>
          <div className="panel-list history-list">
            {[...history].reverse().slice(0, 8).map((entry, reverseIndex) => {
              const index = history.length - 1 - reverseIndex;
              return (
                <button type="button" key={`${entry.label}-${index}`} className={index === historyIndex ? "is-current" : ""} onClick={() => restoreHistory(index)}>
                  <span><strong>{entry.label}</strong><small>{entry.time}</small></span>
                  {index === historyIndex ? <IconCheck /> : <IconClock />}
                </button>
              );
            })}
          </div>
        </>
      );
    }
    if (activePanel === "profile") {
      return (
        <>
          <div className="profile-card"><span>MR</span><div><strong>Solo workspace</strong><small>Private by default</small></div></div>
          <div className="panel-note"><IconUser /><span>Multi-speaker maps can layer onto this same graph later without changing the solo-first flow.</span></div>
        </>
      );
    }
    if (activePanel === "ai") {
      return (
        <>
          <div className="segmented-control" aria-label="AI presence">
            <button type="button" className={aiMode === "quiet" ? "is-active" : ""} onClick={() => setAiMode("quiet")}>Quiet</button>
            <button type="button" className={aiMode === "proactive" ? "is-active" : ""} onClick={() => setAiMode("proactive")}>Proactive</button>
          </div>
          <p className="panel-description">
            {aiMode === "quiet" ? "AI waits until you ask, then proposes changes for review." : "AI surfaces occasional ghost branches while you think."}
          </p>
          <div className="prompt-list">
            {aiPrompts.map((prompt) => (
              <button type="button" key={prompt} onClick={() => createSuggestion(prompt)}><IconBulb /><span>{prompt}</span><IconArrowRight /></button>
            ))}
          </div>
          <form className="ask-form" onSubmit={(event) => { event.preventDefault(); createSuggestion(); }}>
            <input value={aiQuery} onChange={(event) => setAiQuery(event.target.value)} placeholder="Ask the map…" />
            <IconButton type="submit" label="Send question" disabled={!aiQuery.trim()}><IconSend /></IconButton>
          </form>
        </>
      );
    }
    if (activePanel === "layouts") {
      return (
        <div className="view-options">
          <button type="button" className={viewMode === "clusters" ? "is-current" : ""} onClick={() => changeLayout("clusters")}>
            <IconAffiliate /><span><strong>Clusters</strong><small>Organic, spatial thinking</small></span><IconCheck />
          </button>
          <button type="button" className={viewMode === "hierarchy" ? "is-current" : ""} onClick={() => changeLayout("hierarchy")}>
            <IconHierarchy2 /><span><strong>Hierarchy</strong><small>The same graph, left to right</small></span><IconCheck />
          </button>
        </div>
      );
    }
    if (activePanel === "overview") {
      return (
        <>
          <div className="map-stats"><span><strong>{committedCount}</strong><small>Thoughts</small></span><span><strong>{edges.filter((edge) => !edge.ghost).length}</strong><small>Links</small></span><span><strong>{suggestionCount}</strong><small>Proposals</small></span></div>
          <article className="synthesis-card">
            <div><span>Working synthesis</span><IconMessageCircle /></div>
            <p>This map explores a private, voice-first thinking space where complete thoughts become flexible structure. AI helps surface connections and alternative framings, but every change remains yours to accept.</p>
          </article>
          <button type="button" className="wide-action" onClick={() => showToast("Synthesis refreshed from the current map")}><IconSparkles /><span>Refresh synthesis</span></button>
        </>
      );
    }
    if (activePanel === "layers") {
      return (
        <>
          <ToggleRow label="AI proposals" description="Show ghost branches awaiting review" checked={showSuggestions} onChange={setShowSuggestions} />
          <ToggleRow label="Provenance" description="Reveal where each thought came from" checked={showProvenance} onChange={setShowProvenance} />
          <ToggleRow label="Loose notes" description="Show the separate private-note island" checked={showPrivateIsland} onChange={setShowPrivateIsland} />
        </>
      );
    }
    if (activePanel === "settings") {
      return (
        <>
          <ToggleRow label="Complete-thought detection" description="Create nodes at semantic turn boundaries" checked onChange={() => {}} disabled />
          <ToggleRow label="Reduced motion" description="Remove lobe wobble and pulse animation" checked={reducedMotion} onChange={setReducedMotion} />
          <ToggleRow label="Show AI proposals" description="Keep pending changes visible on the canvas" checked={showSuggestions} onChange={setShowSuggestions} />
          <div className="panel-note"><IconAdjustments /><span>Voice states mirror semantic turn detection; live audio and model calls are intentionally mocked in this frontend prototype.</span></div>
        </>
      );
    }
    if (activePanel === "composer") {
      return (
        <form className="composer-form" onSubmit={submitComposer}>
          <label>
            <span>{composer?.mode === "edit" ? "Thought" : "What belongs next?"}</span>
            <textarea autoFocus rows="4" value={composerValue} onChange={(event) => setComposerValue(event.target.value)} placeholder="Finish the thought…" />
          </label>
          <div><small>Double-click any lobe to edit it later.</small><IconButton type="submit" label={composer?.mode === "edit" ? "Save thought" : "Add thought"} disabled={!composerValue.trim()}><IconArrowRight /></IconButton></div>
        </form>
      );
    }
    return null;
  };

  return (
    <main className={`app-shell ${concept}`}>
      <MindMap
        concept={concept}
        nodes={visibleNodes}
        edges={edges}
        selectedId={selectedId}
        selectedIds={selectedIds}
        onSelect={selectOne}
        onSelectMany={selectMany}
        onMoveStart={startMoveNode}
        onMoveNode={moveNode}
        onMoveEnd={finishMoveNode}
        onMoveCancel={cancelMoveNode}
        onEdit={openEditor}
        onAdd={openComposer}
        onAskAI={(id) => { selectOne(id); setActivePanel("ai"); }}
        onArmConnect={armConnection}
        onConnectTarget={connectTarget}
        onSpawnFreeform={spawnFreeformThought}
        onDelete={deleteThought}
        onAcceptGhost={acceptGhost}
        onDismissGhost={dismissGhost}
        onRemoveConnection={removeConnection}
        connectFromId={connectFromId}
        zoom={zoom}
        setZoom={setZoom}
        pan={pan}
        setPan={setPan}
        showSuggestions={showSuggestions}
        showProvenance={showProvenance}
        focusId={focusId}
        reducedMotion={reducedMotion}
        marqueeActive={marqueeActive}
      />

      <nav className="side-rail" aria-label="Workspace tools">
        <IconButton label="Maps" active={activePanel === "maps"} onClick={() => togglePanel("maps")} testId="maps-tool"><IconAffiliate /></IconButton>
        {concept === "nocturne" && (
          <>
            <IconButton label="Rectangle select" active={marqueeActive} pressed={marqueeActive} onClick={toggleMarquee} testId="marquee-tool"><IconMarquee /></IconButton>
            <IconButton label="Ask AI" active={activePanel === "ai"} onClick={() => togglePanel("ai")} testId="ai-tool"><IconSparkles /></IconButton>
            <IconButton label="Switch graph view" active={activePanel === "layouts"} onClick={() => togglePanel("layouts")} testId="layout-tool"><IconHierarchy2 /></IconButton>
          </>
        )}
        <IconButton label="Search" active={activePanel === "search"} onClick={() => togglePanel("search")} testId="search-tool"><IconSearch /></IconButton>
        <IconButton label={focusId ? "Show full map" : "Focus selected branch"} active={Boolean(focusId)} onClick={toggleFocus} testId="focus-tool"><IconFocusCentered /></IconButton>
        <IconButton label="History" active={activePanel === "history"} onClick={() => togglePanel("history")} testId="history-tool"><IconClock /></IconButton>
        {concept === "paper" && (
          <>
            <IconButton label={favorite ? "Remove favorite" : "Add favorite"} pressed={favorite} onClick={() => { setFavorite((value) => !value); showToast(favorite ? "Removed from favorites" : "Added to favorites"); }} testId="favorite-tool"><IconStar /></IconButton>
            <IconButton label="Account" active={activePanel === "profile"} onClick={() => togglePanel("profile")} className="avatar-button rail-bottom" testId="profile-tool">MR</IconButton>
          </>
        )}
        <IconButton label="Settings" active={activePanel === "settings"} onClick={() => togglePanel("settings")} className={concept === "nocturne" ? "rail-bottom" : ""} testId="settings-tool"><IconSettings /></IconButton>
      </nav>

      {concept === "paper" && (
        <div className="top-dock" aria-label="Canvas modes">
          <IconButton label="Rectangle select" active={marqueeActive} pressed={marqueeActive} onClick={toggleMarquee} testId="marquee-tool"><IconMarquee /></IconButton>
          <IconButton label="Ask AI" active={activePanel === "ai"} onClick={() => togglePanel("ai")} testId="ai-tool"><IconSparkles /></IconButton>
          <IconButton label="Switch graph view" active={activePanel === "layouts"} onClick={() => togglePanel("layouts")} testId="layout-tool"><IconAffiliate /></IconButton>
          <IconButton label="Map overview and synthesis" active={activePanel === "overview"} onClick={() => togglePanel("overview")} testId="overview-tool"><IconGridDots /></IconButton>
          <IconButton label="Layers" active={activePanel === "layers"} onClick={() => togglePanel("layers")} testId="layers-tool"><IconStack2 /></IconButton>
          <IconButton label="Canvas settings" active={activePanel === "settings"} onClick={() => togglePanel("settings")} testId="canvas-settings-tool"><IconSettings /></IconButton>
        </div>
      )}

      {marqueeActive && selectedIds.length > 0 && (
        <div
          className="selection-toolbar"
          role="toolbar"
          aria-label="Rectangle selection actions"
          data-testid="selection-toolbar"
          data-deletable-count={deletableSelectionCount}
        >
          <span role="status">
            {selectedIds.length} selected{selectedIds.includes("root") ? " · starting thought protected" : ""}
          </span>
          <IconButton
            label={`Delete ${deletableSelectionCount} selected ${deletableSelectionCount === 1 ? "thought" : "thoughts"}`}
            disabled={deletableSelectionCount === 0}
            onClick={deleteSelectedThoughts}
            className="danger-action"
            testId="delete-selection"
          >
            <IconTrash />
          </IconButton>
        </div>
      )}

      {activePanel && (
        <FloatingPanel panel={activePanel} onClose={() => { setActivePanel(null); setComposer(null); }}>
          {panelContent()}
        </FloatingPanel>
      )}

      {listening && (
        <div className="voice-caption" role="status" aria-live="polite">
          <span />
          <p>Listening for a complete thought…</p>
          <small>{voiceThoughts[voiceIndex % voiceThoughts.length]}</small>
        </div>
      )}

      {concept === "nocturne" && !listening && (
        <div className="nocturne-companion-caption" aria-label="AI companion prompt">
          <p><span />Keep going, this is getting interesting…</p>
          <small>What if we explored the flow a bit more?</small>
        </div>
      )}

      <div className={`voice-control ${listening ? "is-listening" : ""}`}>
        <span className="voice-timer">{timer}</span>
        <IconButton
          label={listening ? "Finish thought" : "Start voice capture"}
          pressed={listening}
          onClick={toggleVoice}
          testId="voice-control"
        >
          {listening ? <IconCheck /> : <IconMicrophone />}
        </IconButton>
      </div>

      <div className="zoom-controls" aria-label="Canvas zoom">
        <IconButton label="Center map" onClick={() => { setPan({ x: 0, y: 0 }); setZoom(1); }} testId="center-map"><IconFocusCentered /></IconButton>
        <IconButton label="Zoom out" onClick={() => setZoom((value) => clamp(value - ZOOM_STEP, MIN_ZOOM, MAX_ZOOM))} testId="zoom-out"><IconMinus /></IconButton>
        <span>{Math.round(zoom * 100)}%</span>
        <IconButton label="Zoom in" onClick={() => setZoom((value) => clamp(value + ZOOM_STEP, MIN_ZOOM, MAX_ZOOM))} testId="zoom-in"><IconPlus /></IconButton>
      </div>

      {connectFromId && (
        <div className={`connect-hint ${listening ? "is-raised" : ""}`} role="status"><IconLink /><span>Select another lobe to connect</span><IconButton label="Cancel connection" onClick={() => setConnectFromId(null)}><IconX /></IconButton></div>
      )}

      {toast && <div className="toast" role="status" aria-live="polite">{toast}</div>}
    </main>
  );
}
