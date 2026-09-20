import { useEffect, useMemo, useRef, useState } from "react";
import { BASE_WIDTH, BASE_HEIGHT, MIN_ZOOM, MAX_ZOOM, ZOOM_STEP, canvasTransform, panForAnchor } from "./viewport.js";
import { clamp } from "./geometry.js";

export function useCanvasView(shellRef, canvasRef, { pan, setPan, zoom, setZoom }) {
  const [viewport, setViewport] = useState({ width: BASE_WIDTH, height: BASE_HEIGHT });
  const interactionRef = useRef(null);
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return undefined;
    const update = () => setViewport({ width: shell.clientWidth, height: shell.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(shell);
    return () => observer.disconnect();
  }, []);

  const transform = useMemo(() => canvasTransform(viewport, zoom, pan), [pan, viewport, zoom]);

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
        setPan(panForAnchor(current.viewport, nextZoom, { x: screenX, y: screenY }, { x: worldX, y: worldY }));
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

  return { viewport, transform };
}
