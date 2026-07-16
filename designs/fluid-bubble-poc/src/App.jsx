import { useEffect, useMemo, useRef, useState } from "react";
import { IconLink, IconPlus, IconRefresh, IconTrash } from "@tabler/icons-react";

const ORANGE = "#ff6b45";
const ORANGE_ACTIVE = "#f25432";
const INK = "#2f241f";

const DEFAULT_SETTINGS = {
  viscosity: 0.64,
  elasticity: 0.52,
  repulsion: 0.48,
  springLength: 1,
  damping: 0.58,
  bridgeWidth: 0.34,
  flare: 0.76,
  filletReach: 0.68,
  slenderSpan: 0.28,
};

const PRESETS = {
  Water: {
    viscosity: 0.28,
    elasticity: 0.68,
    repulsion: 0.3,
    springLength: 1.08,
    damping: 0.28,
    bridgeWidth: 0.22,
    flare: 0.52,
    filletReach: 0.36,
    slenderSpan: 0.14,
  },
  Jelly: DEFAULT_SETTINGS,
  Honey: {
    viscosity: 0.9,
    elasticity: 0.34,
    repulsion: 0.7,
    springLength: 0.94,
    damping: 0.84,
    bridgeWidth: 0.58,
    flare: 0.92,
    filletReach: 0.88,
    slenderSpan: 0.46,
  },
};

const SLIDERS = [
  {
    key: "viscosity",
    label: "Viscosity",
    hint: "How much moving bubbles deform",
    min: 0.1,
    max: 0.95,
    step: 0.01,
  },
  {
    key: "elasticity",
    label: "Elasticity",
    hint: "Springiness of joined bubbles",
    min: 0.05,
    max: 1,
    step: 0.01,
  },
  {
    key: "repulsion",
    label: "Repulsion",
    hint: "How firmly bubbles resist crowding",
    min: 0,
    max: 1,
    step: 0.01,
  },
  {
    key: "springLength",
    label: "Spring length",
    hint: "Equilibrium distance of joined bubbles",
    min: 0.65,
    max: 1.35,
    step: 0.01,
    unit: "×",
  },
  {
    key: "damping",
    label: "Damping",
    hint: "How quickly the system settles",
    min: 0.05,
    max: 0.95,
    step: 0.01,
  },
  {
    key: "bridgeWidth",
    label: "Neck width",
    hint: "Thickness at the narrow midpoint",
    min: 0.15,
    max: 1,
    step: 0.01,
  },
  {
    key: "flare",
    label: "Endpoint flare",
    hint: "How broadly the web joins each bubble",
    min: 0,
    max: 1,
    step: 0.01,
  },
  {
    key: "filletReach",
    label: "Fillet reach",
    hint: "How far the smooth bubble blend extends",
    min: 0,
    max: 1,
    step: 0.01,
  },
  {
    key: "slenderSpan",
    label: "Slender span",
    hint: "How much of the middle stays narrow",
    min: 0,
    max: 1,
    step: 0.01,
  },
];

function createInitialNodes(width, height) {
  const compact = width < 740;
  const specs = compact
    ? [
        [0.3, 0.25, 62],
        [0.64, 0.25, 46],
        [0.46, 0.51, 54],
        [0.7, 0.66, 44],
        [0.28, 0.72, 50],
      ]
    : [
        [0.23, 0.3, 72],
        [0.46, 0.24, 52],
        [0.43, 0.54, 62],
        [0.67, 0.44, 58],
        [0.76, 0.68, 48],
        [0.3, 0.74, 54],
      ];

  return specs.map(([x, y, radius], index) => ({
    id: index + 1,
    x: width * x,
    y: height * y,
    vx: 0,
    vy: 0,
    radius: compact ? radius * 0.84 : radius,
    dragging: false,
  }));
}

function createLink(a, b) {
  const restDx = b.x - a.x;
  const restDy = b.y - a.y;
  return {
    a: a.id,
    b: b.id,
    rest: Math.hypot(restDx, restDy),
    restDx,
    restDy,
  };
}

function createInitialLinks(nodes) {
  return [
    [1, 2],
    [1, 3],
    [3, 4],
    [3, 6],
    [4, 5],
  ].flatMap(([aId, bId]) => {
    const a = nodes.find((node) => node.id === aId);
    const b = nodes.find((node) => node.id === bId);
    return a && b ? [createLink(a, b)] : [];
  });
}

function linkKey(a, b) {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function smoothstep(value) {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

function bridgeMetrics(a, b, settings) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 0.001) return null;

  const ux = dx / distance;
  const uy = dy / distance;
  const px = -uy;
  const py = ux;
  const smallestRadius = Math.min(a.radius, b.radius);
  const endpointHalfWidth = clamp(
    smallestRadius * (0.38 + settings.flare * 0.42),
    5,
    smallestRadius * 0.8,
  );
  const waistHalfWidth = clamp(
    smallestRadius * (0.035 + settings.bridgeWidth * 0.17),
    3,
    endpointHalfWidth * 0.52,
  );
  const edgeA = Math.sqrt(Math.max(a.radius ** 2 - endpointHalfWidth ** 2, 0));
  const edgeB = Math.sqrt(Math.max(b.radius ** 2 - endpointHalfWidth ** 2, 0));
  const start = { x: a.x + ux * edgeA, y: a.y + uy * edgeA };
  const end = { x: b.x - ux * edgeB, y: b.y - uy * edgeB };
  const bridgeLength = (end.x - start.x) * ux + (end.y - start.y) * uy;
  if (bridgeLength <= 0.5) return null;
  const midpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  const halfSlenderSpan =
    bridgeLength * (0.025 + clamp(settings.slenderSpan, 0, 1) * 0.24);
  const leftWaist = {
    x: midpoint.x - ux * halfSlenderSpan,
    y: midpoint.y - uy * halfSlenderSpan,
  };
  const rightWaist = {
    x: midpoint.x + ux * halfSlenderSpan,
    y: midpoint.y + uy * halfSlenderSpan,
  };

  return {
    distance,
    ux,
    uy,
    px,
    py,
    start,
    end,
    midpoint,
    leftWaist,
    rightWaist,
    edgeA,
    edgeB,
    endpointHalfWidth,
    waistHalfWidth,
    smallestRadius,
  };
}

function drawFluidBridge(ctx, a, b, settings) {
  const metrics = bridgeMetrics(a, b, settings);
  if (!metrics) return false;

  const {
    ux,
    uy,
    px,
    py,
    start,
    end,
    leftWaist,
    rightWaist,
    edgeA,
    edgeB,
    endpointHalfWidth,
    waistHalfWidth,
  } = metrics;
  const leftLength = Math.hypot(leftWaist.x - start.x, leftWaist.y - start.y);
  const rightLength = Math.hypot(end.x - rightWaist.x, end.y - rightWaist.y);
  const sourceTangentLength = Math.min(
    leftLength * 0.82,
    metrics.smallestRadius * (0.34 + settings.filletReach * 1.08),
  );
  const targetTangentLength = Math.min(
    rightLength * 0.82,
    metrics.smallestRadius * (0.34 + settings.filletReach * 1.08),
  );
  const waistHandleFactor = 0.12 + settings.filletReach * 0.22;

  const tangent = (along, across) => ({
    x: ux * along + px * across,
    y: uy * along + py * across,
  });
  const aTopTangent = tangent(endpointHalfWidth / a.radius, -edgeA / a.radius);
  const aBottomTangent = tangent(endpointHalfWidth / a.radius, edgeA / a.radius);
  const bTopTangent = tangent(endpointHalfWidth / b.radius, edgeB / b.radius);
  const bBottomTangent = tangent(endpointHalfWidth / b.radius, -edgeB / b.radius);

  const aTop = {
    x: start.x + px * endpointHalfWidth,
    y: start.y + py * endpointHalfWidth,
  };
  const aBottom = {
    x: start.x - px * endpointHalfWidth,
    y: start.y - py * endpointHalfWidth,
  };
  const bTop = {
    x: end.x + px * endpointHalfWidth,
    y: end.y + py * endpointHalfWidth,
  };
  const bBottom = {
    x: end.x - px * endpointHalfWidth,
    y: end.y - py * endpointHalfWidth,
  };
  const leftWaistTop = {
    x: leftWaist.x + px * waistHalfWidth,
    y: leftWaist.y + py * waistHalfWidth,
  };
  const rightWaistTop = {
    x: rightWaist.x + px * waistHalfWidth,
    y: rightWaist.y + py * waistHalfWidth,
  };
  const leftWaistBottom = {
    x: leftWaist.x - px * waistHalfWidth,
    y: leftWaist.y - py * waistHalfWidth,
  };
  const rightWaistBottom = {
    x: rightWaist.x - px * waistHalfWidth,
    y: rightWaist.y - py * waistHalfWidth,
  };

  ctx.beginPath();
  ctx.moveTo(aTop.x, aTop.y);
  ctx.bezierCurveTo(
    aTop.x + aTopTangent.x * sourceTangentLength,
    aTop.y + aTopTangent.y * sourceTangentLength,
    leftWaistTop.x - ux * leftLength * waistHandleFactor,
    leftWaistTop.y - uy * leftLength * waistHandleFactor,
    leftWaistTop.x,
    leftWaistTop.y,
  );
  ctx.bezierCurveTo(
    rightWaistTop.x - ux * Math.max(4, metrics.distance * 0.02),
    rightWaistTop.y - uy * Math.max(4, metrics.distance * 0.02),
    rightWaistTop.x - ux * Math.max(2, metrics.distance * 0.01),
    rightWaistTop.y - uy * Math.max(2, metrics.distance * 0.01),
    rightWaistTop.x,
    rightWaistTop.y,
  );
  ctx.bezierCurveTo(
    rightWaistTop.x + ux * rightLength * waistHandleFactor,
    rightWaistTop.y + uy * rightLength * waistHandleFactor,
    bTop.x - bTopTangent.x * targetTangentLength,
    bTop.y - bTopTangent.y * targetTangentLength,
    bTop.x,
    bTop.y,
  );
  ctx.lineTo(bBottom.x, bBottom.y);
  ctx.bezierCurveTo(
    bBottom.x - bBottomTangent.x * targetTangentLength,
    bBottom.y - bBottomTangent.y * targetTangentLength,
    rightWaistBottom.x + ux * rightLength * waistHandleFactor,
    rightWaistBottom.y + uy * rightLength * waistHandleFactor,
    rightWaistBottom.x,
    rightWaistBottom.y,
  );
  ctx.bezierCurveTo(
    leftWaistBottom.x + ux * Math.max(2, metrics.distance * 0.01),
    leftWaistBottom.y + uy * Math.max(2, metrics.distance * 0.01),
    leftWaistBottom.x + ux * Math.max(4, metrics.distance * 0.02),
    leftWaistBottom.y + uy * Math.max(4, metrics.distance * 0.02),
    leftWaistBottom.x,
    leftWaistBottom.y,
  );
  ctx.bezierCurveTo(
    leftWaistBottom.x - ux * leftLength * waistHandleFactor,
    leftWaistBottom.y - uy * leftLength * waistHandleFactor,
    aBottom.x + aBottomTangent.x * sourceTangentLength,
    aBottom.y + aBottomTangent.y * sourceTangentLength,
    aBottom.x,
    aBottom.y,
  );
  ctx.closePath();
  ctx.fill();
  return true;
}

function distanceToSegment(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (!lengthSquared) return { distance: Math.hypot(point.x - a.x, point.y - a.y), t: 0 };
  const t = clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared, 0, 1);
  const x = a.x + dx * t;
  const y = a.y + dy * t;
  return { distance: Math.hypot(point.x - x, point.y - y), t };
}

function formatSetting(slider, value) {
  if (slider.unit) return `${value.toFixed(2)}${slider.unit}`;
  return value.toFixed(2);
}

export function App() {
  const canvasRef = useRef(null);
  const stageRef = useRef(null);
  const hoverButtonRef = useRef(null);
  const nodesRef = useRef([]);
  const linksRef = useRef([]);
  const sizeRef = useRef({ width: 0, height: 0, dpr: 1 });
  const settingsRef = useRef(DEFAULT_SETTINGS);
  const dragRef = useRef(null);
  const connectSourceRef = useRef(null);
  const pendingConnectionRef = useRef(null);
  const poppingLinksRef = useRef([]);
  const hoveredNodeRef = useRef(null);
  const selectedIdRef = useRef(null);
  const nextIdRef = useRef(7);

  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [selectedId, setSelectedId] = useState(null);
  const [connectSourceId, setConnectSourceId] = useState(null);
  const [hoveredNodeId, setHoveredNodeId] = useState(null);
  const [bubbleCount, setBubbleCount] = useState(6);
  const [linkCount, setLinkCount] = useState(5);
  const [notice, setNotice] = useState("Hover a bubble to reveal its join control");

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  const settingsCode = useMemo(
    () =>
      JSON.stringify(
        Object.fromEntries(
          Object.entries(settings).map(([key, value]) => [
            key,
            Number.isInteger(value) ? value : Number(value.toFixed(2)),
          ]),
        ),
        null,
        2,
      ),
    [settings],
  );

  function clearConnectionIntent() {
    connectSourceRef.current = null;
    pendingConnectionRef.current = null;
    setConnectSourceId(null);
  }

  function clearHover() {
    hoveredNodeRef.current = null;
    setHoveredNodeId(null);
  }

  function resetScene() {
    const { width, height } = sizeRef.current;
    if (!width || !height) return;
    nodesRef.current = createInitialNodes(width, height);
    linksRef.current = createInitialLinks(nodesRef.current);
    poppingLinksRef.current = [];
    nextIdRef.current = nodesRef.current.length + 1;
    setBubbleCount(nodesRef.current.length);
    setLinkCount(linksRef.current.length);
    setSelectedId(null);
    clearConnectionIntent();
    clearHover();
    setNotice("Scene reset");
  }

  function addBubble() {
    const { width, height } = sizeRef.current;
    if (!width || !height) return;
    const id = nextIdRef.current++;
    const angle = id * 1.91;
    const spread = 34 + (id % 4) * 18;
    nodesRef.current.push({
      id,
      x: clamp(width * 0.5 + Math.cos(angle) * spread, 70, width - 70),
      y: clamp(height * 0.48 + Math.sin(angle) * spread, 70, height - 70),
      vx: Math.cos(angle) * 1.4,
      vy: Math.sin(angle) * 1.4,
      radius: 42 + (id % 3) * 6,
      dragging: false,
    });
    setBubbleCount(nodesRef.current.length);
    setSelectedId(id);
    setNotice(`Bubble ${id} added`);
  }

  function deleteSelected() {
    if (selectedId == null) return;
    nodesRef.current = nodesRef.current.filter((node) => node.id !== selectedId);
    linksRef.current = linksRef.current.filter(
      (link) => link.a !== selectedId && link.b !== selectedId,
    );
    if (connectSourceRef.current === selectedId) clearConnectionIntent();
    if (hoveredNodeRef.current === selectedId) clearHover();
    setBubbleCount(nodesRef.current.length);
    setLinkCount(linksRef.current.length);
    setSelectedId(null);
    setNotice("Bubble removed");
  }

  function armConnection(nodeId) {
    connectSourceRef.current = nodeId;
    setConnectSourceId(nodeId);
    setSelectedId(nodeId);
    clearHover();
    setNotice(`Bubble ${nodeId} armed — click another bubble to join`);
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) return undefined;
    const ctx = canvas.getContext("2d");
    let animationFrame = 0;
    let lastTime = performance.now();

    const resize = () => {
      const bounds = stage.getBoundingClientRect();
      const previous = sizeRef.current;
      const width = Math.max(320, bounds.width);
      const height = Math.max(480, bounds.height);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      sizeRef.current = { width, height, dpr };

      if (nodesRef.current.length === 0) {
        nodesRef.current = createInitialNodes(width, height);
        linksRef.current = createInitialLinks(nodesRef.current);
        nextIdRef.current = nodesRef.current.length + 1;
        setBubbleCount(nodesRef.current.length);
        setLinkCount(linksRef.current.length);
      } else if (previous.width && previous.height) {
        const scaleX = width / previous.width;
        const scaleY = height / previous.height;
        nodesRef.current.forEach((node) => {
          node.x *= scaleX;
          node.y *= scaleY;
        });
        linksRef.current.forEach((link) => {
          link.restDx *= scaleX;
          link.restDy *= scaleY;
          link.rest = Math.hypot(link.restDx, link.restDy);
        });
      }
    };

    const observer = new ResizeObserver(resize);
    observer.observe(stage);
    resize();

    const getPointer = (event) => {
      const bounds = canvas.getBoundingClientRect();
      return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    };

    const findNode = (point) => {
      for (let index = nodesRef.current.length - 1; index >= 0; index -= 1) {
        const node = nodesRef.current[index];
        if (Math.hypot(point.x - node.x, point.y - node.y) <= node.radius + 7) return node;
      }
      return null;
    };

    const findLink = (point) => {
      for (let index = linksRef.current.length - 1; index >= 0; index -= 1) {
        const link = linksRef.current[index];
        const a = nodesRef.current.find((node) => node.id === link.a);
        const b = nodesRef.current.find((node) => node.id === link.b);
        if (!a || !b) continue;
        const hit = distanceToSegment(point, a, b);
        const hitWidth = Math.max(12, Math.min(a.radius, b.radius) * 0.26);
        if (hit.t > 0.14 && hit.t < 0.86 && hit.distance <= hitWidth) return { link, a, b };
      }
      return null;
    };

    const updateHover = (node) => {
      const id = node?.id ?? null;
      if (hoveredNodeRef.current === id) return;
      hoveredNodeRef.current = id;
      setHoveredNodeId(id);
    };

    const startConnection = (sourceId, targetId, now) => {
      if (sourceId === targetId) {
        clearConnectionIntent();
        setNotice("Join cancelled");
        return;
      }
      const key = linkKey(sourceId, targetId);
      if (linksRef.current.some((link) => linkKey(link.a, link.b) === key)) {
        clearConnectionIntent();
        setSelectedId(targetId);
        setNotice(`Bubbles ${sourceId} and ${targetId} are already joined`);
        return;
      }
      pendingConnectionRef.current = {
        sourceId,
        targetId,
        start: now,
        duration: 520,
      };
      setSelectedId(targetId);
      setNotice(`Bubble ${sourceId} is flowing toward bubble ${targetId}`);
    };

    const popConnection = ({ link, a, b }, now) => {
      linksRef.current = linksRef.current.filter(
        (candidate) => linkKey(candidate.a, candidate.b) !== linkKey(link.a, link.b),
      );
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.max(Math.hypot(dx, dy), 1);
      const impulse = 1.8 + settingsRef.current.elasticity * 2.4;
      if (!a.dragging) {
        a.vx -= (dx / distance) * impulse;
        a.vy -= (dy / distance) * impulse;
      }
      if (!b.dragging) {
        b.vx += (dx / distance) * impulse;
        b.vy += (dy / distance) * impulse;
      }
      poppingLinksRef.current.push({
        a: { x: a.x, y: a.y, radius: a.radius },
        b: { x: b.x, y: b.y, radius: b.radius },
        start: now,
        duration: 380,
      });
      setLinkCount(linksRef.current.length);
      setNotice(`Connection popped between bubbles ${link.a} and ${link.b}`);
    };

    const onPointerDown = (event) => {
      const point = getPointer(event);
      const node = findNode(point);
      const now = performance.now();

      if (connectSourceRef.current != null) {
        if (node) {
          startConnection(connectSourceRef.current, node.id, now);
        } else {
          clearConnectionIntent();
          setSelectedId(null);
          setNotice("Join cancelled");
        }
        return;
      }

      if (!node) {
        const connection = findLink(point);
        if (connection) {
          popConnection(connection, now);
        } else {
          setSelectedId(null);
        }
        return;
      }

      setSelectedId(node.id);
      node.dragging = true;
      dragRef.current = {
        id: node.id,
        pointerId: event.pointerId,
        targetX: point.x,
        targetY: point.y,
        offsetX: point.x - node.x,
        offsetY: point.y - node.y,
        lastX: point.x,
        lastY: point.y,
        lastTime: now,
        throwVx: 0,
        throwVy: 0,
      };
      updateHover(null);
      canvas.setPointerCapture(event.pointerId);
      setNotice(`Dragging bubble ${node.id}`);
    };

    const onPointerMove = (event) => {
      const point = getPointer(event);
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) {
        if (connectSourceRef.current == null) updateHover(findNode(point));
        return;
      }
      const now = performance.now();
      const frameScale = 16.67 / Math.max(now - drag.lastTime, 1);
      drag.throwVx = clamp((point.x - drag.lastX) * frameScale, -24, 24);
      drag.throwVy = clamp((point.y - drag.lastY) * frameScale, -24, 24);
      drag.targetX = point.x;
      drag.targetY = point.y;
      drag.lastX = point.x;
      drag.lastY = point.y;
      drag.lastTime = now;
    };

    const endDrag = (event) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const node = nodesRef.current.find((candidate) => candidate.id === drag.id);
      if (node) {
        node.dragging = false;
        const release = 0.08 + (1 - settingsRef.current.viscosity) * 0.08;
        node.vx = drag.throwVx * release;
        node.vy = drag.throwVy * release;
      }
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      dragRef.current = null;
      setNotice("Released — watch the system settle");
    };

    const onDoubleClick = (event) => {
      const point = getPointer(event);
      if (findNode(point) || findLink(point)) return;
      const id = nextIdRef.current++;
      nodesRef.current.push({
        id,
        x: point.x,
        y: point.y,
        vx: 0,
        vy: 0,
        radius: 46,
        dragging: false,
      });
      setBubbleCount(nodesRef.current.length);
      setSelectedId(id);
      setNotice(`Bubble ${id} added`);
    };

    const onKeyDown = (event) => {
      if (event.key === "Escape" && connectSourceRef.current != null) {
        clearConnectionIntent();
        setNotice("Join cancelled");
      }
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);
    canvas.addEventListener("dblclick", onDoubleClick);
    window.addEventListener("keydown", onKeyDown);

    const animate = (now) => {
      const settingsNow = settingsRef.current;
      const { width, height, dpr } = sizeRef.current;
      const frameStep = clamp((now - lastTime) / 16.67, 0.35, 2);
      lastTime = now;
      const nodes = nodesRef.current;
      const linkMap = new Map(linksRef.current.map((link) => [linkKey(link.a, link.b), link]));

      for (let i = 0; i < nodes.length; i += 1) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j += 1) {
          const b = nodes[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const distance = Math.max(Math.hypot(dx, dy), 0.001);
          const ux = dx / distance;
          const uy = dy / distance;
          const combinedRadius = a.radius + b.radius;
          const savedLink = linkMap.get(linkKey(a.id, b.id));

          if (savedLink) {
            const desiredDistance = savedLink.rest * settingsNow.springLength;
            const stretch = distance - desiredDistance;
            const springForce = stretch * (0.0025 + settingsNow.elasticity * 0.013);
            if (!a.dragging) {
              a.vx += ux * springForce * frameStep;
              a.vy += uy * springForce * frameStep;
            }
            if (!b.dragging) {
              b.vx -= ux * springForce * frameStep;
              b.vy -= uy * springForce * frameStep;
            }
          }

          const minimumDistance =
            combinedRadius * (0.88 + settingsNow.repulsion * 0.2) + settingsNow.repulsion * 10;
          if (distance < minimumDistance) {
            const repel =
              (minimumDistance - distance) * (0.008 + settingsNow.repulsion * 0.032);
            if (!a.dragging) {
              a.vx -= ux * repel * frameStep;
              a.vy -= uy * repel * frameStep;
            }
            if (!b.dragging) {
              b.vx += ux * repel * frameStep;
              b.vy += uy * repel * frameStep;
            }
          }
        }
      }

      const dampingFactor = Math.pow(1 - settingsNow.damping * 0.085, frameStep);
      const drag = dragRef.current;
      nodes.forEach((node) => {
        if (drag && node.id === drag.id) {
          const edgePadding = node.radius + 8;
          node.x = clamp(drag.targetX - drag.offsetX, edgePadding, width - edgePadding);
          node.y = clamp(drag.targetY - drag.offsetY, edgePadding, height - edgePadding);
          node.vx = 0;
          node.vy = 0;
          return;
        }

        node.vx *= dampingFactor;
        node.vy *= dampingFactor;
        node.x += node.vx * frameStep;
        node.y += node.vy * frameStep;

        const edgePadding = node.radius + 8;
        if (node.x < edgePadding) {
          node.x = edgePadding;
          node.vx *= -0.24;
        } else if (node.x > width - edgePadding) {
          node.x = width - edgePadding;
          node.vx *= -0.24;
        }
        if (node.y < edgePadding) {
          node.y = edgePadding;
          node.vy *= -0.24;
        } else if (node.y > height - edgePadding) {
          node.y = height - edgePadding;
          node.vy *= -0.24;
        }
      });

      const hovered = nodes.find((node) => node.id === hoveredNodeRef.current);
      if (hovered && hoverButtonRef.current) {
        hoverButtonRef.current.style.left = `${hovered.x + hovered.radius * 0.72}px`;
        hoverButtonRef.current.style.top = `${hovered.y - hovered.radius * 0.72}px`;
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = ORANGE;

      linksRef.current.forEach((link) => {
        const a = nodes.find((node) => node.id === link.a);
        const b = nodes.find((node) => node.id === link.b);
        if (a && b) drawFluidBridge(ctx, a, b, settingsNow);
      });

      const pending = pendingConnectionRef.current;
      if (pending) {
        const source = nodes.find((node) => node.id === pending.sourceId);
        const target = nodes.find((node) => node.id === pending.targetId);
        if (!source || !target) {
          clearConnectionIntent();
        } else {
          const rawProgress = clamp((now - pending.start) / pending.duration, 0, 1);
          const progress = smoothstep(rawProgress);
          const dx = target.x - source.x;
          const dy = target.y - source.y;
          const distance = Math.max(Math.hypot(dx, dy), 1);
          const ux = dx / distance;
          const uy = dy / distance;
          const smallestRadius = Math.min(source.radius, target.radius);
          const startDistance = source.radius * 0.72;
          const travelDistance = startDistance + (distance - startDistance) * progress;
          const head = {
            x: source.x + ux * travelDistance,
            y: source.y + uy * travelDistance,
            radius: smallestRadius * (0.18 + progress * 0.18),
          };
          ctx.save();
          ctx.globalAlpha = clamp(rawProgress * 2.4, 0, 1);
          drawFluidBridge(ctx, source, head, {
            ...settingsNow,
            flare: settingsNow.flare * (0.45 + progress * 0.55),
          });
          ctx.beginPath();
          ctx.arc(head.x, head.y, head.radius, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();

          if (rawProgress >= 1) {
            linksRef.current.push(createLink(source, target));
            setLinkCount(linksRef.current.length);
            pendingConnectionRef.current = null;
            connectSourceRef.current = null;
            setConnectSourceId(null);
            setNotice(`Bubbles ${source.id} and ${target.id} joined`);
          }
        }
      }

      poppingLinksRef.current = poppingLinksRef.current.filter((pop) => {
        const rawProgress = clamp((now - pop.start) / pop.duration, 0, 1);
        if (rawProgress >= 1) return false;
        const progress = smoothstep(rawProgress);
        const midpoint = { x: (pop.a.x + pop.b.x) / 2, y: (pop.a.y + pop.b.y) / 2 };
        ctx.save();
        ctx.globalAlpha = 1 - progress;
        ctx.fillStyle = ORANGE;
        drawFluidBridge(ctx, pop.a, pop.b, {
          ...settingsNow,
          bridgeWidth: settingsNow.bridgeWidth * (1 - progress * 0.92),
          flare: settingsNow.flare * (1 - progress * 0.72),
        });
        ctx.lineWidth = 2.5 * (1 - progress);
        ctx.strokeStyle = ORANGE_ACTIVE;
        ctx.beginPath();
        ctx.arc(midpoint.x, midpoint.y, 7 + progress * 30, 0, Math.PI * 2);
        ctx.stroke();
        for (let index = 0; index < 4; index += 1) {
          const angle = index * (Math.PI / 2) + 0.42;
          const travel = progress * (22 + index * 3);
          ctx.beginPath();
          ctx.arc(
            midpoint.x + Math.cos(angle) * travel,
            midpoint.y + Math.sin(angle) * travel,
            3.2 * (1 - progress),
            0,
            Math.PI * 2,
          );
          ctx.fill();
        }
        ctx.restore();
        return true;
      });

      nodes.forEach((node) => {
        const speed = Math.hypot(node.vx, node.vy);
        const stretch = node.dragging
          ? 0
          : clamp(speed * 0.008 * settingsNow.viscosity, 0, 0.14);
        const angle = speed > 0.08 ? Math.atan2(node.vy, node.vx) : 0;
        const isSelected = node.id === selectedIdRef.current;
        const isConnectSource = node.id === connectSourceRef.current;

        ctx.save();
        ctx.translate(node.x, node.y);
        ctx.rotate(angle);
        ctx.beginPath();
        ctx.ellipse(
          0,
          0,
          node.radius * (1 + stretch),
          node.radius * (1 - stretch * 0.52),
          0,
          0,
          Math.PI * 2,
        );
        ctx.fillStyle = isSelected ? ORANGE_ACTIVE : ORANGE;
        ctx.fill();
        ctx.restore();

        if (isSelected || isConnectSource) {
          ctx.beginPath();
          ctx.arc(node.x, node.y, node.radius + 7, 0, Math.PI * 2);
          ctx.strokeStyle = isConnectSource ? "#8d3824" : "rgba(75, 43, 32, 0.45)";
          ctx.lineWidth = isConnectSource ? 2.2 : 1.5;
          ctx.setLineDash(isConnectSource ? [5, 5] : []);
          ctx.stroke();
          ctx.setLineDash([]);
        }

        ctx.fillStyle = INK;
        ctx.font = `${node.radius >= 58 ? 15 : 13}px Manrope, system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(`Bubble ${node.id}`, node.x, node.y);
      });

      animationFrame = requestAnimationFrame(animate);
    };

    animationFrame = requestAnimationFrame(animate);

    return () => {
      observer.disconnect();
      cancelAnimationFrame(animationFrame);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", endDrag);
      canvas.removeEventListener("pointercancel", endDrag);
      canvas.removeEventListener("dblclick", onDoubleClick);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  async function copySettings() {
    try {
      await navigator.clipboard.writeText(settingsCode);
      setNotice("Settings copied to clipboard");
    } catch {
      setNotice("Clipboard unavailable — settings are visible below");
    }
  }

  const hoveredNode = nodesRef.current.find((node) => node.id === hoveredNodeId);

  return (
    <main className="prototype-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Interaction study</p>
          <h1>Fluid bubble lab</h1>
        </div>
        <div className="scene-stats" aria-label="Scene statistics">
          <span>{bubbleCount} bubbles</span>
          <span>{linkCount} saved links</span>
        </div>
      </header>

      <section className="workspace" aria-label="Fluid bubble prototype">
        <div className="canvas-column">
          <div className="canvas-toolbar" aria-label="Bubble controls">
            <button type="button" aria-label="Add bubble" title="Add bubble" onClick={addBubble}>
              <IconPlus size={18} stroke={1.8} />
            </button>
            <button
              type="button"
              aria-label="Delete selected bubble"
              title="Delete selected bubble"
              onClick={deleteSelected}
              disabled={selectedId == null}
            >
              <IconTrash size={18} stroke={1.8} />
            </button>
            <button
              type="button"
              className="quiet"
              aria-label="Reset scene"
              title="Reset scene"
              onClick={resetScene}
            >
              <IconRefresh size={18} stroke={1.8} />
            </button>
          </div>

          <div
            className={`stage${connectSourceId != null ? " is-joining" : ""}`}
            ref={stageRef}
            onPointerLeave={() => {
              if (!dragRef.current) clearHover();
            }}
          >
            <canvas
              ref={canvasRef}
              role="application"
              aria-label="Interactive fluid bubbles. Drag bubbles, hover a bubble to reveal its join control, and click a neck to pop it."
            />
            {hoveredNode && connectSourceId == null && (
              <button
                ref={hoverButtonRef}
                type="button"
                className="node-connect-button"
                aria-label={`Connect from Bubble ${hoveredNode.id}`}
                title={`Join from Bubble ${hoveredNode.id}`}
                style={{
                  left: hoveredNode.x + hoveredNode.radius * 0.62,
                  top: hoveredNode.y - hoveredNode.radius * 0.62,
                }}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => armConnection(hoveredNode.id)}
              >
                <IconLink size={18} stroke={2} />
              </button>
            )}
            <div className="stage-help">
              <span aria-live="polite">
                {connectSourceId != null
                  ? `Bubble ${connectSourceId} armed — click another bubble to join`
                  : notice}
              </span>
              <span>Drag to reposition · Hover to join · Click a neck to pop</span>
            </div>
          </div>
        </div>

        <aside className="control-panel" aria-label="Fluid settings">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Tune the feel</p>
              <h2>Material settings</h2>
            </div>
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setSettings(DEFAULT_SETTINGS);
                setNotice("Material settings restored");
              }}
            >
              Defaults
            </button>
          </div>

          <div className="presets" aria-label="Material presets">
            {Object.entries(PRESETS).map(([name, values]) => (
              <button
                type="button"
                key={name}
                onClick={() => {
                  setSettings(values);
                  setNotice(`${name} preset applied`);
                }}
              >
                {name}
              </button>
            ))}
          </div>

          <div className="sliders">
            {SLIDERS.map((slider) => (
              <label className="slider-row" key={slider.key}>
                <span className="slider-copy">
                  <span>
                    <strong>{slider.label}</strong>
                    <output>{formatSetting(slider, settings[slider.key])}</output>
                  </span>
                  <small>{slider.hint}</small>
                </span>
                <input
                  type="range"
                  aria-label={slider.label}
                  min={slider.min}
                  max={slider.max}
                  step={slider.step}
                  value={settings[slider.key]}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    setSettings((current) => ({ ...current, [slider.key]: value }));
                  }}
                />
              </label>
            ))}
          </div>

          <div className="settings-output">
            <div>
              <span>Current settings</span>
              <button type="button" className="text-button" onClick={copySettings}>Copy</button>
            </div>
            <pre>{settingsCode}</pre>
          </div>
        </aside>
      </section>
    </main>
  );
}
