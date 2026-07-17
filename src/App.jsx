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
  DEFAULT_MATERIAL_SETTINGS,
  buildFluidVisualNodes,
  clamp,
  drawFluidMaterial,
  findGrowthPlacement,
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

const paperMaterialSettings = {
  ...DEFAULT_MATERIAL_SETTINGS,
  bridgeWidth: 0.62,
  flare: 0.29,
  filletReach: 0.22,
};

const palettes = {
  paper: {
    material: "#ff735b",
    ink: "#251d1a",
    ghost: "#dc6d58",
    ghostFill: "rgba(245, 132, 109, 0.08)",
  },
  nocturne: {
    material: "#cc5d4b",
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

function wrapThought(value, maxLength = 20) {
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
  return lines.slice(0, 4);
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
  while (cursor) {
    const incoming = edges.find((edge) => edge.to === cursor);
    cursor = incoming?.from;
    if (cursor) included.add(cursor);
  }
  return included;
}

function layoutHierarchy(nodes) {
  const committed = nodes.filter((node) => !node.ghost);
  const byDepth = new Map();
  committed.forEach((node) => {
    const depth = clamp(node.depth ?? 0, 0, 4);
    byDepth.set(depth, [...(byDepth.get(depth) ?? []), node]);
  });
  const positions = new Map();
  byDepth.forEach((items, depth) => {
    const top = depth === 0 ? 300 : 105;
    const bottom = depth === 0 ? 760 : 905;
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
    const incoming = initialEdges.find((edge) => edge.to === node.id);
    const parent = positions.get(incoming?.from);
    return parent ? { ...node, x: parent.x + 150, y: parent.y - 80 } : node;
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
  const size = root ? 22 : node.r > 58 ? 15.5 : node.r > 43 ? 11.5 : 10.2;
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
  onSelect,
  onMoveStart,
  onMoveNode,
  onMoveEnd,
  onMoveCancel,
  onEdit,
  onAdd,
  onAskAI,
  onArmConnect,
  onConnectTarget,
  onDelete,
  onAcceptGhost,
  onDismissGhost,
  connectFromId,
  zoom,
  setZoom,
  pan,
  setPan,
  showSuggestions,
  showProvenance,
  focusId,
  reducedMotion,
}) {
  const canvasRef = useRef(null);
  const shellRef = useRef(null);
  const textureRef = useRef(null);
  const dragRef = useRef(null);
  const activePointersRef = useRef(new Map());
  const panRef = useRef(pan);
  const [viewport, setViewport] = useState({ width: BASE_WIDTH, height: BASE_HEIGHT });
  const [fontReady, setFontReady] = useState(false);
  const [textureReady, setTextureReady] = useState(false);
  const palette = palettes[concept];
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
    panRef.current = pan;
  }, [pan]);

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

      drawFluidMaterial(ctx, visualNodes, renderedEdges, {
        color: palette.material,
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
        || (node.wobbleStart != null && now - node.wobbleStart < 760)
      ));
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

  const touchPointers = () => [...activePointersRef.current.values()]
    .filter((pointer) => pointer.pointerType === "touch");

  const touchCentroid = (pointers) => ({
    x: pointers.reduce((sum, pointer) => sum + pointer.x, 0) / pointers.length,
    y: pointers.reduce((sum, pointer) => sum + pointer.y, 0) / pointers.length,
  });

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
      const centroid = touchCentroid(touches);
      dragRef.current = {
        type: "touch-pan",
        startX: centroid.x,
        startY: centroid.y,
        panX: panRef.current.x,
        panY: panRef.current.y,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }
    const point = screenToWorld(event.clientX, event.clientY);
    const hit = hitNode(point);
    if (connectFromId && hit && hit.id !== connectFromId) {
      onConnectTarget(hit.id);
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
      onSelect(null);
      dragRef.current = {
        type: "pan",
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        panX: pan.x,
        panY: pan.y,
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
    if (drag.type === "touch-pan") {
      const touches = touchPointers();
      if (touches.length < 2) return;
      const centroid = touchCentroid(touches);
      setPan({
        x: drag.panX + centroid.x - drag.startX,
        y: drag.panY + centroid.y - drag.startY,
      });
      event.preventDefault();
      return;
    }
    if (drag.pointerId !== event.pointerId) return;
    if (drag.type === "pan") {
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
    if (drag.type === "touch-pan") {
      const touches = touchPointers();
      if (touches.length >= 2) {
        const centroid = touchCentroid(touches);
        drag.startX = centroid.x;
        drag.startY = centroid.y;
        drag.panX = panRef.current.x;
        drag.panY = panRef.current.y;
      } else {
        dragRef.current = null;
      }
      return;
    }
    if (drag.pointerId !== event.pointerId) return;
    if (drag.type === "node") {
      if (event.type === "pointercancel") onMoveCancel(drag.id);
      else onMoveEnd(drag.id, drag.vx, drag.vy, drag.moved);
    }
    dragRef.current = null;
  };

  const handleWheel = (event) => {
    event.preventDefault();
    if (event.ctrlKey) {
      setZoom((value) => clamp(value + (event.deltaY < 0 ? 0.06 : -0.06), 0.72, 1.36));
      return;
    }
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.height : 1;
    const deltaX = event.shiftKey && event.deltaX === 0 ? event.deltaY : event.deltaX;
    const deltaY = event.shiftKey && event.deltaX === 0 ? 0 : event.deltaY;
    setPan((current) => ({
      x: current.x - deltaX * unit,
      y: current.y - deltaY * unit,
    }));
  };

  const handleDoubleClick = (event) => {
    const hit = hitNode(screenToWorld(event.clientX, event.clientY));
    if (hit && !hit.ghost) onEdit(hit.id);
  };

  const selected = renderedNodes.find((node) => node.id === selectedId);
  const actionX = selected
    ? clamp(transform.offsetX + (selected.x + selected.r - (selected.r > 100 ? 12 : 0)) * transform.scale, 94, viewport.width - 54)
    : 0;
  const actionY = selected
    ? clamp(transform.offsetY + selected.y * transform.scale, 116, viewport.height - 116)
    : 0;

  return (
    <div className="map-shell" ref={shellRef}>
      <canvas
        ref={canvasRef}
        aria-label="Interactive organic idea map. Drag thoughts to move them. Use two fingers, a trackpad, or the empty canvas to pan."
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onDoubleClick={handleDoubleClick}
        onWheel={handleWheel}
      />

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
  const [seconds, setSeconds] = useState(62);
  const [voiceIndex, setVoiceIndex] = useState(0);
  const [toast, setToast] = useState("");
  const [history, setHistory] = useState(() => [{
    label: "Opened map",
    nodes: cloneNodes(initialNodes),
    edges: cloneEdges(initialFluidEdges),
    time: "Now",
  }]);
  const [historyIndex, setHistoryIndex] = useState(0);

  useEffect(() => { nodesRef.current = nodes; }, [nodes]);
  useEffect(() => { edgesRef.current = edges; }, [edges]);
  useEffect(() => { viewModeRef.current = viewMode; }, [viewMode]);
  useEffect(() => {
    let animationFrame;
    let lastTime = performance.now();
    const animatePhysics = (now) => {
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
  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        setActivePanel(null);
        setConnectFromId(null);
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

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
    setSelectedId(nextNodes.some((node) => node.id === selectedId) ? selectedId : "root");
    showToast(snapshot.label);
  }

  function undo() {
    if (historyIndex > 0) restoreHistory(historyIndex - 1);
  }

  function redo() {
    if (historyIndex < history.length - 1) restoreHistory(historyIndex + 1);
  }

  const togglePanel = (panel) => {
    setActivePanel((current) => current === panel ? null : panel);
    if (panel !== "composer") setComposer(null);
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
    const radius = options.ghost ? 52 : clamp(parent.r * 0.52, 36, 58);
    const placement = findGrowthPlacement(parent, radius, nodesRef.current, edgesRef.current, BASE_WIDTH, BASE_HEIGHT);
    const node = {
      id,
      x: placement.x,
      y: placement.y,
      r: radius,
      depth: clamp((parent.depth ?? 0) + 1, 1, 4),
      lines: wrapThought(text),
      ghost: Boolean(options.ghost),
      provenance: options.provenance,
      createdAt: performance.now(),
    };
    const edge = {
      from: parent.id,
      to: id,
      bend: 0,
      ghost: Boolean(options.ghost),
    };
    const nextNodes = [...nodesRef.current, node];
    const nextEdges = [...edgesRef.current, edge];
    applyGraph(nextNodes, nextEdges, options.ghost ? "AI proposed a thought" : "Added a thought");
    if (viewMode === "clusters") organicPositionsRef.current.set(id, { x: node.x, y: node.y });
    setSelectedId(id);
    setShowSuggestions(true);
    return id;
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
      const next = nodesRef.current.map((node) => node.id === composer.id ? { ...node, lines: wrapThought(value) } : node);
      applyGraph(next, edgesRef.current, "Edited a thought");
      setSelectedId(composer.id);
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
    const nextNodes = nodesRef.current.map((node) => node.id === id
      ? { ...node, ghost: false, provenance: "AI suggestion · accepted", createdAt: performance.now() }
      : node);
    const nextEdges = edgesRef.current.map((edge) => edge.to === id ? { ...edge, ghost: false } : edge);
    applyGraph(nextNodes, nextEdges, "Accepted an AI suggestion");
    setSelectedId(id);
    showToast("Suggestion accepted");
  };

  const dismissGhost = (id) => {
    const nextNodes = nodesRef.current.filter((node) => node.id !== id);
    const nextEdges = edgesRef.current.filter((edge) => edge.from !== id && edge.to !== id);
    applyGraph(nextNodes, nextEdges, "Dismissed an AI suggestion");
    setSelectedId("root");
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
    setSelectedId("root");
    showToast("Thought removed");
  };

  const armConnection = (id) => {
    setConnectFromId((current) => current === id ? null : id);
    showToast(connectFromId === id ? "Connection cancelled" : "Choose another thought to connect");
  };

  const connectTarget = (targetId) => {
    if (!connectFromId || connectFromId === targetId) return;
    const exists = edgesRef.current.some((edge) => (
      (edge.from === connectFromId && edge.to === targetId)
      || (edge.from === targetId && edge.to === connectFromId)
    ));
    if (exists) {
      setConnectFromId(null);
      showToast("Those thoughts are already connected");
      return;
    }
    const source = nodesRef.current.find((node) => node.id === connectFromId);
    const target = nodesRef.current.find((node) => node.id === targetId);
    const dx = (target?.x ?? 0) - (source?.x ?? 0);
    const dy = (target?.y ?? 0) - (source?.y ?? 0);
    const nextNodes = nodesRef.current.map((node) => (
      node.id === connectFromId || node.id === targetId ? withWobble(node, dx, dy, 0.07) : node
    ));
    const nextEdges = [...edgesRef.current, { from: connectFromId, to: targetId, bend: 0 }];
    applyGraph(nextNodes, nextEdges, "Connected two thoughts");
    setConnectFromId(null);
    setSelectedId(targetId);
    showToast("Thoughts connected");
  };

  const toggleVoice = () => {
    if (!listening) {
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
      nextNodes = layoutHierarchy(nodesRef.current);
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
                setSelectedId(node.id);
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
        onSelect={setSelectedId}
        onMoveStart={startMoveNode}
        onMoveNode={moveNode}
        onMoveEnd={finishMoveNode}
        onMoveCancel={cancelMoveNode}
        onEdit={openEditor}
        onAdd={openComposer}
        onAskAI={(id) => { setSelectedId(id); setActivePanel("ai"); }}
        onArmConnect={armConnection}
        onConnectTarget={connectTarget}
        onDelete={deleteThought}
        onAcceptGhost={acceptGhost}
        onDismissGhost={dismissGhost}
        connectFromId={connectFromId}
        zoom={zoom}
        setZoom={setZoom}
        pan={pan}
        setPan={setPan}
        showSuggestions={showSuggestions}
        showProvenance={showProvenance}
        focusId={focusId}
        reducedMotion={reducedMotion}
      />

      <nav className="side-rail" aria-label="Workspace tools">
        <IconButton label="Maps" active={activePanel === "maps"} onClick={() => togglePanel("maps")} testId="maps-tool"><IconAffiliate /></IconButton>
        <IconButton label="Search" active={activePanel === "search"} onClick={() => togglePanel("search")} testId="search-tool"><IconSearch /></IconButton>
        <IconButton label={focusId ? "Show full map" : "Focus selected branch"} active={Boolean(focusId)} onClick={toggleFocus} testId="focus-tool"><IconFocusCentered /></IconButton>
        <IconButton label="History" active={activePanel === "history"} onClick={() => togglePanel("history")} testId="history-tool"><IconClock /></IconButton>
        <IconButton label={favorite ? "Remove favorite" : "Add favorite"} pressed={favorite} onClick={() => { setFavorite((value) => !value); showToast(favorite ? "Removed from favorites" : "Added to favorites"); }} testId="favorite-tool"><IconStar /></IconButton>
        <IconButton label="Account" active={activePanel === "profile"} onClick={() => togglePanel("profile")} className="avatar-button rail-bottom" testId="profile-tool">MR</IconButton>
        <IconButton label="Settings" active={activePanel === "settings"} onClick={() => togglePanel("settings")} testId="settings-tool"><IconSettings /></IconButton>
      </nav>

      <div className="top-dock" aria-label="Canvas modes">
        <IconButton label="Ask AI" active={activePanel === "ai"} onClick={() => togglePanel("ai")} testId="ai-tool"><IconSparkles /></IconButton>
        <IconButton label="Switch graph view" active={activePanel === "layouts"} onClick={() => togglePanel("layouts")} testId="layout-tool"><IconAffiliate /></IconButton>
        <IconButton label="Map overview and synthesis" active={activePanel === "overview"} onClick={() => togglePanel("overview")} testId="overview-tool"><IconGridDots /></IconButton>
        <IconButton label="Layers" active={activePanel === "layers"} onClick={() => togglePanel("layers")} testId="layers-tool"><IconStack2 /></IconButton>
        <IconButton label="Canvas settings" active={activePanel === "settings"} onClick={() => togglePanel("settings")} testId="canvas-settings-tool"><IconSettings /></IconButton>
      </div>

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
        <IconButton label="Zoom out" onClick={() => setZoom((value) => clamp(value - 0.08, 0.72, 1.36))} testId="zoom-out"><IconMinus /></IconButton>
        <span>{Math.round(zoom * 100)}%</span>
        <IconButton label="Zoom in" onClick={() => setZoom((value) => clamp(value + 0.08, 0.72, 1.36))} testId="zoom-in"><IconPlus /></IconButton>
      </div>

      {connectFromId && (
        <div className="connect-hint" role="status"><IconLink /><span>Select another lobe to connect</span><IconButton label="Cancel connection" onClick={() => setConnectFromId(null)}><IconX /></IconButton></div>
      )}

      {toast && <div className="toast" role="status" aria-live="polite">{toast}</div>}
    </main>
  );
}
