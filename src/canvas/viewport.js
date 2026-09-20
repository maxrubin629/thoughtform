export const BASE_WIDTH = 1487;
export const BASE_HEIGHT = 1058;

export const MIN_ZOOM = 0.72;
export const MAX_ZOOM = 1.36;
export const ZOOM_STEP = 0.08;

export function canvasTransform(viewport, zoom, pan = { x: 0, y: 0 }) {
  const scale = Math.min(viewport.width / BASE_WIDTH, viewport.height / BASE_HEIGHT) * zoom;
  return {
    scale,
    offsetX: (viewport.width - BASE_WIDTH * scale) / 2 + pan.x,
    offsetY: (viewport.height - BASE_HEIGHT * scale) / 2 + pan.y,
  };
}

// Keep a world position under the same screen point as zoom changes.
export function panForAnchor(viewport, zoom, screen, world) {
  const { scale, offsetX, offsetY } = canvasTransform(viewport, zoom);
  return { x: screen.x - offsetX - world.x * scale, y: screen.y - offsetY - world.y * scale };
}
