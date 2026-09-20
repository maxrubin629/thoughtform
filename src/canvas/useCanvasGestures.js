import { useEffect, useRef, useState } from "react";
import { clamp, findFluidConnectionHit } from "../fluidMaterial.js";
import { lassoIntersectsNode } from "../lassoSelection.js";
import { connectionTargetAt, connectionBud } from "../connectionGesture.js";
import { BASE_WIDTH, BASE_HEIGHT, MIN_ZOOM, MAX_ZOOM, panForAnchor } from "./viewport.js";

export function useCanvasGestures(
  canvasRef,
  { renderedNodes, renderedEdges },
  { viewport, transform },
  { connectionIsPopping, popConnection },
  {
    edges, zoom, setZoom, pan, setPan, marqueeActive, lassoActive, controlsHidden,
    connectFromId, onCancelConnect, onActionsChange, onSelect, onSelectMany,
    onMoveStart, onMoveNode, onMoveEnd, onMoveCancel, onConnect, onEdit, onSpawnFreeform,
  },
) {
  const dragRef = useRef(null);
  const longPressRef = useRef(null);
  const suppressBudClickRef = useRef(false);
  const activePointersRef = useRef(new Map());
  const lastConnectionPopRef = useRef(null);
  const [marqueeRect, setMarqueeRect] = useState(null);
  const [lassoPoints, setLassoPoints] = useState([]);
  const [hoveredNodeId, setHoveredNodeId] = useState(null);
  const [connectionPreview, setConnectionPreview] = useState(null);
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
  const rememberPointer = (event) => activePointersRef.current.set(event.pointerId, {
    x: event.clientX, y: event.clientY, pointerType: event.pointerType,
  });

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
    rememberPointer(event);
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
    rememberPointer(event);
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

  const moveGesture = {
    "touch-gesture": (event, drag) => {
      const touches = touchPointers();
      if (touches.length < 2) return;
      const centroid = touchCentroid(touches);
      const rect = canvasRef.current.getBoundingClientRect();
      const nextZoom = clamp(
        drag.startZoom * (touchDistance(touches) / drag.startDistance),
        MIN_ZOOM,
        MAX_ZOOM,
      );
      setPan(panForAnchor(viewport, nextZoom,
        { x: centroid.x - rect.left, y: centroid.y - rect.top },
        { x: drag.worldX, y: drag.worldY }));
      setZoom(nextZoom);
      event.preventDefault();
    },
    "connect": (event, drag) => {
      updateConnection(event, drag);
      event.preventDefault();
    },
    "lasso": (event, drag) => {
      const point = screenToWorld(event.clientX, event.clientY);
      const last = drag.points.at(-1);
      if (Math.hypot(point.x - last.x, point.y - last.y) * transform.scale >= 2) {
        drag.points.push(point);
        setLassoPoints([...drag.points]);
        onSelectMany(renderedNodes.filter((node) => lassoIntersectsNode(drag.points, node)).map((node) => node.id));
      }
      event.preventDefault();
    },
    "marquee": (event, drag) => {
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
    },
    "pan": (event, drag) => {
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 5) {
        drag.moved = true;
      }
      setPan({
        x: drag.panX + event.clientX - drag.startX,
        y: drag.panY + event.clientY - drag.startY,
      });
    },
    node: (event, drag) => {
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
    },
  };

  const handlePointerMove = (event) => {
    if (activePointersRef.current.has(event.pointerId)) {
      rememberPointer(event);
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
    if (drag.type === "touch-gesture" || drag.pointerId === event.pointerId) {
      moveGesture[drag.type]?.(event, drag);
    }
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

  return {
    marqueeRect, lassoPoints, hoveredNodeId, setHoveredNodeId, connectionPreview,
    suppressBudClickRef, beginConnection, hitNode, screenToWorld,
    handlePointerDown, handlePointerMove, handlePointerEnd, handleLostCapture,
    handlePointerLeave, handleDoubleClick,
  };
}
