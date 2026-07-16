import { useEffect, useMemo, useRef, useState } from "react";
import {
  IconAdjustments,
  IconAffiliate,
  IconArrowsMaximize,
  IconClock,
  IconFocusCentered,
  IconGridDots,
  IconStack2,
  IconLink,
  IconMicrophone,
  IconMinus,
  IconPlus,
  IconSearch,
  IconSettings,
  IconShare3,
  IconSparkles,
  IconStar,
  IconTrash,
} from "@tabler/icons-react";
import { BASE_HEIGHT, BASE_WIDTH, initialEdges, initialNodes } from "./mapData.js";

const paperPalette = {
  background: "#eaf3f3",
  node: "#fb806c",
  nodeText: "#1d1c1b",
  ghost: "#e76f5c",
};

const nocturnePalette = {
  background: "#080914",
  node: "#cf5d4c",
  nodeText: "#fff1df",
  ghost: "#c76553",
};

function drawWrappedText(ctx, lines, x, y, radius, palette, ghost) {
  const size = radius > 90 ? 21 : radius > 60 ? 15 : radius > 45 ? 12 : 10;
  ctx.fillStyle = ghost ? palette.ghost : palette.nodeText;
  ctx.font = `${radius > 85 ? 500 : 600} ${size}px Manrope`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const lineHeight = size * 1.22;
  const start = y - ((lines.length - 1) * lineHeight) / 2;
  lines.forEach((line, index) => ctx.fillText(line, x, start + index * lineHeight, radius * 1.62));
}

function cubicPoint(from, to, t, bend) {
  const dx = to.x - from.x;
  const oneMinusT = 1 - t;
  const c1 = { x: from.x + dx * 0.36, y: from.y + bend };
  const c2 = { x: from.x + dx * 0.64, y: to.y - bend };
  return {
    x: oneMinusT ** 3 * from.x + 3 * oneMinusT ** 2 * t * c1.x + 3 * oneMinusT * t ** 2 * c2.x + t ** 3 * to.x,
    y: oneMinusT ** 3 * from.y + 3 * oneMinusT ** 2 * t * c1.y + 3 * oneMinusT * t ** 2 * c2.y + t ** 3 * to.y,
  };
}

function drawOrganicBridge(ctx, from, to, color, bend) {
  const neck = Math.max(5.5, Math.min(from.r, to.r) * 0.13);
  const fromFlare = Math.min(31, from.r * 0.42);
  const toFlare = Math.min(27, to.r * 0.42);
  ctx.beginPath();
  for (let index = 0; index <= 48; index += 1) {
    const t = index / 48;
    const point = cubicPoint(from, to, t, bend);
    const radius = neck + (fromFlare - neck) * (1 - t) ** 4 + (toFlare - neck) * t ** 4;
    ctx.moveTo(point.x + radius, point.y);
    ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
  }
  ctx.fillStyle = color;
  ctx.fill();
}

function MindMap({ concept, nodes, edges, selectedId, setSelectedId, zoom, showSuggestions }) {
  const canvasRef = useRef(null);
  const shellRef = useRef(null);
  const [viewport, setViewport] = useState({ width: 1440, height: 1024 });
  const [fontReady, setFontReady] = useState(false);
  const palette = concept === "paper" ? paperPalette : nocturnePalette;

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
    document.fonts.ready.then(() => setFontReady(true));
  }, []);

  const transform = useMemo(() => {
    const scale = Math.min(viewport.width / BASE_WIDTH, viewport.height / BASE_HEIGHT) * zoom;
    return {
      scale,
      offsetX: (viewport.width - BASE_WIDTH * scale) / 2,
      offsetY: (viewport.height - BASE_HEIGHT * scale) / 2,
    };
  }, [viewport, zoom]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(viewport.width * dpr);
    canvas.height = Math.round(viewport.height * dpr);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, viewport.width, viewport.height);
    ctx.fillStyle = palette.background;
    ctx.fillRect(0, 0, viewport.width, viewport.height);
    ctx.save();
    ctx.translate(transform.offsetX, transform.offsetY);
    ctx.scale(transform.scale, transform.scale);

    const visibleNodes = nodes.filter((node) => showSuggestions || !node.ghost);
    const nodeMap = new Map(visibleNodes.map((node) => [node.id, node]));

    edges.forEach(([fromId, toId]) => {
      const from = nodeMap.get(fromId);
      const to = nodeMap.get(toId);
      if (!from || !to) return;
      const ghost = Boolean(to.ghost);
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const quietBend = Math.abs(dy) < 28 ? (((fromId.length + toId.length) % 2 ? 1 : -1) * Math.min(62, Math.abs(dx) * 0.14)) : 0;
      if (ghost) {
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.bezierCurveTo(from.x + dx * 0.36, from.y + quietBend, from.x + dx * 0.64, to.y - quietBend, to.x, to.y);
        ctx.lineCap = "round";
        ctx.lineWidth = 2;
        ctx.strokeStyle = palette.ghost;
        ctx.setLineDash([5, 5]);
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        drawOrganicBridge(ctx, from, to, palette.node, quietBend);
      }
    });

    visibleNodes.forEach((node) => {
      const selected = node.id === selectedId;
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.r, 0, Math.PI * 2);
      if (node.ghost) {
        ctx.setLineDash([6, 5]);
        ctx.lineWidth = 2;
        ctx.strokeStyle = palette.ghost;
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        ctx.fillStyle = palette.node;
        if (concept === "nocturne") {
          ctx.shadowColor = selected ? "rgba(255, 124, 90, .78)" : "rgba(220, 86, 66, .18)";
          ctx.shadowBlur = selected ? 22 : 8;
        } else if (selected) {
          ctx.shadowColor = "rgba(224, 101, 79, .20)";
          ctx.shadowBlur = 13;
        }
        ctx.fill();
        ctx.shadowBlur = 0;
        if (selected) {
          ctx.lineWidth = concept === "nocturne" ? 2 : 1.25;
          ctx.strokeStyle = concept === "nocturne" ? "#ff9b78" : "#f36f5c";
          ctx.stroke();
        }
      }
      drawWrappedText(ctx, node.lines, node.x, node.y - (node.meta ? 10 : 0), node.r, palette, node.ghost);
      if (node.meta) {
        ctx.fillStyle = node.ghost ? palette.ghost : palette.nodeText;
        ctx.globalAlpha = 0.7;
        ctx.font = "500 10px Manrope";
        ctx.textAlign = "center";
        ctx.fillText(node.meta, node.x, node.y + 67);
        ctx.globalAlpha = 1;
      }
    });
    ctx.restore();
  }, [concept, edges, fontReady, nodes, palette, selectedId, showSuggestions, transform, viewport]);

  const handlePointerDown = (event) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const x = (event.clientX - rect.left - transform.offsetX) / transform.scale;
    const y = (event.clientY - rect.top - transform.offsetY) / transform.scale;
    const hit = [...nodes]
      .reverse()
      .find((node) => (showSuggestions || !node.ghost) && Math.hypot(node.x - x, node.y - y) <= node.r);
    setSelectedId(hit?.id ?? null);
  };

  return (
    <div className="map-shell" ref={shellRef}>
      <canvas ref={canvasRef} onPointerDown={handlePointerDown} aria-label="Interactive organic idea map" />
    </div>
  );
}

function IconButton({ label, children, active = false, onClick, className = "" }) {
  return (
    <button className={`icon-button ${active ? "is-active" : ""} ${className}`} aria-label={label} title={label} onClick={onClick}>
      {children}
    </button>
  );
}

export function App() {
  const concept = new URLSearchParams(window.location.search).get("concept") === "nocturne" ? "nocturne" : "paper";
  const [nodes, setNodes] = useState(initialNodes);
  const [edges, setEdges] = useState(initialEdges);
  const [selectedId, setSelectedId] = useState("root");
  const [zoom, setZoom] = useState(1);
  const [showSuggestions, setShowSuggestions] = useState(true);
  const [listening, setListening] = useState(false);
  const [seconds, setSeconds] = useState(62);

  useEffect(() => {
    if (!listening) return undefined;
    const timer = window.setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [listening]);

  const selected = nodes.find((node) => node.id === selectedId);
  const timer = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;

  const addChild = () => {
    if (!selected) return;
    const id = `new-${Date.now()}`;
    const siblingCount = edges.filter(([from]) => from === selected.id).length;
    const next = {
      id,
      x: Math.min(1320, selected.x + selected.r + 110),
      y: Math.max(80, Math.min(940, selected.y + (siblingCount % 2 === 0 ? 95 : -105))),
      r: Math.max(34, selected.r * 0.48),
      lines: ["New child", "idea"],
    };
    setNodes((items) => [...items, next]);
    setEdges((items) => [...items, [selected.id, id]]);
    setSelectedId(id);
  };

  const removeSelected = () => {
    if (!selected || selected.id === "root") return;
    setNodes((items) => items.filter((node) => node.id !== selected.id));
    setEdges((items) => items.filter(([from, to]) => from !== selected.id && to !== selected.id));
    setSelectedId("root");
  };

  return (
    <main className={`app-shell ${concept}`}>
      <MindMap
        concept={concept}
        nodes={nodes}
        edges={edges}
        selectedId={selectedId}
        setSelectedId={setSelectedId}
        zoom={zoom}
        showSuggestions={showSuggestions}
      />

      <nav className="side-rail" aria-label="Workspace tools">
        <IconButton label="Maps" active><IconAffiliate /></IconButton>
        <IconButton label="Ask AI" onClick={() => setShowSuggestions((value) => !value)} active={showSuggestions}><IconSparkles /></IconButton>
        <IconButton label="Connections"><IconShare3 /></IconButton>
        <IconButton label="Search"><IconSearch /></IconButton>
        <IconButton label="Focus"><IconFocusCentered /></IconButton>
        <IconButton label="History"><IconClock /></IconButton>
        {concept === "paper" && <IconButton label="Favorite"><IconStar /></IconButton>}
        <IconButton label="Settings" className="rail-bottom"><IconSettings /></IconButton>
      </nav>

      {concept === "paper" && (
        <div className="top-dock" aria-label="Canvas modes">
          <IconButton label="Ask AI" onClick={() => setShowSuggestions((value) => !value)} active={showSuggestions}><IconSparkles /></IconButton>
          <IconButton label="Structure"><IconAffiliate /></IconButton>
          <IconButton label="Overview"><IconGridDots /></IconButton>
          <IconButton label="Layers"><IconStack2 /></IconButton>
          <IconButton label="Canvas settings"><IconAdjustments /></IconButton>
        </div>
      )}

      {selected && !selected.ghost && (
        <div
          className="node-actions"
          style={{
            left: `calc(${((selected.x + selected.r + 14) / BASE_WIDTH) * 100}% + 0px)`,
            top: `${(selected.y / BASE_HEIGHT) * 100}%`,
          }}
        >
          <IconButton label="Add child" onClick={addChild}><IconPlus /></IconButton>
          <IconButton label="Generate child ideas" onClick={() => setShowSuggestions(true)}><IconSparkles /></IconButton>
          <IconButton label="Connect"><IconLink /></IconButton>
          <IconButton label="Delete" onClick={removeSelected}><IconTrash /></IconButton>
        </div>
      )}

      {concept === "nocturne" && (
        <div className="live-caption" aria-live="polite">
          <span className="status-dot" />
          <p>Keep going, this is getting interesting…</p>
          <p>What if we explored the flow a bit more?</p>
        </div>
      )}

      <div className={`voice-control ${listening ? "is-listening" : ""}`}>
        <span className="voice-timer">{timer}</span>
        <IconButton label={listening ? "Stop listening" : "Start listening"} onClick={() => setListening((value) => !value)}>
          <IconMicrophone />
        </IconButton>
      </div>

      <div className="zoom-controls" aria-label="Canvas zoom">
        <IconButton label="Center map" onClick={() => setZoom(1)}><IconFocusCentered /></IconButton>
        <IconButton label="Zoom out" onClick={() => setZoom((value) => Math.max(0.78, value - 0.08))}><IconMinus /></IconButton>
        <span>{Math.round(zoom * 100)}%</span>
        <IconButton label="Zoom in" onClick={() => setZoom((value) => Math.min(1.25, value + 0.08))}><IconPlus /></IconButton>
        {concept === "nocturne" && <IconButton label="Fit overview"><IconArrowsMaximize /></IconButton>}
      </div>
    </main>
  );
}
