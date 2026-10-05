import { BASE_HEIGHT, BASE_WIDTH } from './mapData.js';

export const MIN_CAMERA_ZOOM = 0.25;
export const MAX_CAMERA_ZOOM = 3;
export const DEFAULT_CAMERA_ZOOM = 1;
export const CAMERA_BASE_SCALE = 0.675;

const clampZoom = (zoom, min = MIN_CAMERA_ZOOM, max = MAX_CAMERA_ZOOM) =>
  Math.min(max, Math.max(min, zoom));

function insetRect(rect, padding) {
  const insetX = Math.min(Math.max(0, padding), Math.max(0, rect.right - rect.left) / 2);
  const insetY = Math.min(Math.max(0, padding), Math.max(0, rect.bottom - rect.top) / 2);
  return {
    left: rect.left + insetX,
    top: rect.top + insetY,
    right: rect.right - insetX,
    bottom: rect.bottom - insetY,
  };
}

// Displayed zoom is relative to the compact design scale, independent of viewport.
export function cameraTransform(viewport, zoom, pan) {
  const scale = zoom * CAMERA_BASE_SCALE;
  return {
    scale,
    offsetX: (viewport.width - BASE_WIDTH * scale) / 2 + pan.x,
    offsetY: (viewport.height - BASE_HEIGHT * scale) / 2 + pan.y,
  };
}

export function cameraCenteredOn(point, viewport, rect, zoom = DEFAULT_CAMERA_ZOOM) {
  const boundedZoom = clampZoom(zoom);
  const scale = boundedZoom * CAMERA_BASE_SCALE;
  return {
    zoom: boundedZoom,
    pan: {
      x: (rect.left + rect.right) / 2 - point.x * scale - (viewport.width - BASE_WIDTH * scale) / 2,
      y: (rect.top + rect.bottom) / 2 - point.y * scale - (viewport.height - BASE_HEIGHT * scale) / 2,
    },
  };
}

export function zoomCameraAt(camera, nextZoom, point, viewport) {
  const zoom = clampZoom(nextZoom);
  if (zoom === camera.zoom) return camera;
  const transform = cameraTransform(viewport, camera.zoom, camera.pan);
  const world = {
    x: (point.x - transform.offsetX) / transform.scale,
    y: (point.y - transform.offsetY) / transform.scale,
  };
  return cameraCenteredOn(world, viewport, {
    left: point.x,
    right: point.x,
    top: point.y,
    bottom: point.y,
  }, zoom);
}

export function fitMapCamera(nodes, viewport, rect, {
  padding = 24,
  maxZoom = DEFAULT_CAMERA_ZOOM,
  minZoom = MIN_CAMERA_ZOOM,
} = {}) {
  const minimum = clampZoom(minZoom);
  const maximum = clampZoom(maxZoom, minimum);
  if (!nodes.length) {
    return cameraCenteredOn({ x: BASE_WIDTH / 2, y: BASE_HEIGHT / 2 }, viewport, rect,
      clampZoom(DEFAULT_CAMERA_ZOOM, minimum, maximum));
  }
  const bounds = nodes.reduce((result, node) => ({
    left: Math.min(result.left, node.x - node.r),
    top: Math.min(result.top, node.y - node.r),
    right: Math.max(result.right, node.x + node.r),
    bottom: Math.max(result.bottom, node.y + node.r),
  }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
  const available = insetRect(rect, padding);
  const zoom = clampZoom(Math.min(
    (available.right - available.left) / Math.max(1, bounds.right - bounds.left),
    (available.bottom - available.top) / Math.max(1, bounds.bottom - bounds.top),
  ) / CAMERA_BASE_SCALE, minimum, maximum);
  return cameraCenteredOn({
    x: (bounds.left + bounds.right) / 2,
    y: (bounds.top + bounds.bottom) / 2,
  }, viewport, rect, zoom);
}

export function initialMapCamera(nodes, rootId, viewport, rect) {
  const overview = fitMapCamera(nodes, viewport, rect);
  if (!nodes.length || overview.zoom >= DEFAULT_CAMERA_ZOOM * 0.85) return overview;
  const root = nodes.find(node => node.id === rootId) || nodes[0];
  return cameraCenteredOn(root, viewport, rect);
}

export function revealNodeCamera(camera, node, viewport, rect, { padding = 16 } = {}) {
  if (!node) return camera;
  const available = insetRect(rect, padding);
  const diameter = node.r * 2 * CAMERA_BASE_SCALE;
  const fittingZoom = Math.min(
    (available.right - available.left) / diameter,
    (available.bottom - available.top) / diameter,
  );
  if (camera.zoom > fittingZoom) {
    return cameraCenteredOn(node, viewport, rect, clampZoom(fittingZoom));
  }
  const transform = cameraTransform(viewport, camera.zoom, camera.pan);
  const x = node.x * transform.scale + transform.offsetX;
  const y = node.y * transform.scale + transform.offsetY;
  const r = node.r * transform.scale;
  const dx = x - r < available.left ? available.left - (x - r)
    : x + r > available.right ? available.right - (x + r) : 0;
  const dy = y - r < available.top ? available.top - (y - r)
    : y + r > available.bottom ? available.bottom - (y + r) : 0;
  if (!dx && !dy) return camera;
  return { zoom: camera.zoom, pan: { x: camera.pan.x + dx, y: camera.pan.y + dy } };
}
