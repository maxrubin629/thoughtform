import test from 'node:test';
import assert from 'node:assert/strict';
import { BASE_HEIGHT, BASE_WIDTH } from './mapData.js';
import {
  CAMERA_BASE_SCALE, DEFAULT_CAMERA_ZOOM, MAX_CAMERA_ZOOM, MIN_CAMERA_ZOOM,
  cameraCenteredOn, cameraTransform, fitMapCamera, initialMapCamera,
  revealNodeCamera, zoomCameraAt,
} from './mapCamera.js';

const desktop = { width: 1440, height: 900 };
const mobile = { width: 390, height: 844 };
const desktopCanvas = { left: 84, top: 120, right: 1416, bottom: 760 };
const mobileCanvas = { left: 76, top: 168, right: 378, bottom: 710 };
const nearlyEqual = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9,
  `${actual} should equal ${expected}`);
function screenPoint(camera, point, viewport) {
  const transform = cameraTransform(viewport, camera.zoom, camera.pan);
  return { x: point.x * transform.scale + transform.offsetX, y: point.y * transform.scale + transform.offsetY };
}
function worldPoint(camera, point, viewport) {
  const transform = cameraTransform(viewport, camera.zoom, camera.pan);
  return { x: (point.x - transform.offsetX) / transform.scale, y: (point.y - transform.offsetY) / transform.scale };
}
function assertVisible(camera, node, viewport, rect, padding = 0) {
  const point = screenPoint(camera, node, viewport);
  const radius = node.r * camera.zoom * CAMERA_BASE_SCALE;
  assert.ok(point.x - radius >= rect.left + padding - 1e-9);
  assert.ok(point.x + radius <= rect.right - padding + 1e-9);
  assert.ok(point.y - radius >= rect.top + padding - 1e-9);
  assert.ok(point.y + radius <= rect.bottom - padding + 1e-9);
}

test('the whole zoom range uses the compact baseline on desktop and mobile, with reversible world coordinates', () => {
  for (const viewport of [desktop, mobile]) {
    for (const zoom of [MIN_CAMERA_ZOOM, DEFAULT_CAMERA_ZOOM, 1, MAX_CAMERA_ZOOM]) {
      const camera = { zoom, pan: { x: 73, y: -42 } };
      const transform = cameraTransform(viewport, camera.zoom, camera.pan);
      assert.equal(transform.scale, zoom * CAMERA_BASE_SCALE);
      nearlyEqual(transform.offsetX, (viewport.width - BASE_WIDTH * zoom * CAMERA_BASE_SCALE) / 2 + 73);
      nearlyEqual(transform.offsetY, (viewport.height - BASE_HEIGHT * zoom * CAMERA_BASE_SCALE) / 2 - 42);
      const start = { x: 490, y: 312 };
      const end = { x: 590, y: 312 };
      const pixelStart = screenPoint(camera, start, viewport);
      nearlyEqual(screenPoint(camera, end, viewport).x - pixelStart.x, 100 * zoom * CAMERA_BASE_SCALE);
      const restored = worldPoint(camera, pixelStart, viewport);
      nearlyEqual(restored.x, start.x);
      nearlyEqual(restored.y, start.y);
    }
  }
});

test('pointer zoom preserves its world anchor and clamps both limits', () => {
  const camera = { zoom: 1, pan: { x: 85, y: -27 } };
  const pointer = { x: 241, y: 317 };
  const anchor = worldPoint(camera, pointer, mobile);
  for (const requested of [1.7, 0.1, 8]) {
    const changed = zoomCameraAt(camera, requested, pointer, mobile);
    assert.equal(changed.zoom, Math.max(MIN_CAMERA_ZOOM, Math.min(MAX_CAMERA_ZOOM, requested)));
    const result = screenPoint(changed, anchor, mobile);
    nearlyEqual(result.x, pointer.x);
    nearlyEqual(result.y, pointer.y);
  }
  assert.equal(zoomCameraAt(camera, 1, pointer, mobile), camera);
});

test('centering uses the unobstructed rectangle rather than the full viewport', () => {
  const point = { x: 431, y: 612 };
  const camera = cameraCenteredOn(point, desktop, desktopCanvas, 1.3);
  const rendered = screenPoint(camera, point, desktop);
  nearlyEqual(rendered.x, (desktopCanvas.left + desktopCanvas.right) / 2);
  nearlyEqual(rendered.y, (desktopCanvas.top + desktopCanvas.bottom) / 2);
});

test('initial overview includes full lobe radii on desktop but keeps the root readable on a phone', () => {
  const nodes = [
    { id: 'root', x: 400, y: 450, r: 110 },
    { id: 'child', x: 870, y: 620, r: 64 },
    { id: 'upper', x: 730, y: 290, r: 60 },
  ];
  const overview = initialMapCamera(nodes, 'root', desktop, desktopCanvas);
  assert.equal(overview.zoom, DEFAULT_CAMERA_ZOOM);
  nodes.forEach(node => assertVisible(overview, node, desktop, desktopCanvas, 24));
  const narrow = initialMapCamera(nodes, 'root', mobile, mobileCanvas);
  assert.equal(narrow.zoom, DEFAULT_CAMERA_ZOOM);
  const root = screenPoint(narrow, nodes[0], mobile);
  nearlyEqual(root.x, (mobileCanvas.left + mobileCanvas.right) / 2);
  nearlyEqual(root.y, (mobileCanvas.top + mobileCanvas.bottom) / 2);
  assert.deepEqual(initialMapCamera(nodes, 'missing', mobile, mobileCanvas), narrow);
  const fullFit = fitMapCamera(nodes, mobile, mobileCanvas);
  assert.ok(fullFit.zoom < DEFAULT_CAMERA_ZOOM * 0.85);
  nodes.forEach(node => assertVisible(fullFit, node, mobile, mobileCanvas, 24));
});

test('initial view accepts a slightly reduced overview and empty maps remain finite', () => {
  const nodes = [{ id: 'root', x: 600, y: 500, r: 300 / (DEFAULT_CAMERA_ZOOM * CAMERA_BASE_SCALE) }];
  const rect = { left: 100, top: 100, right: 1000, bottom: 700 };
  const initial = initialMapCamera(nodes, 'root', desktop, rect);
  nearlyEqual(initial.zoom, 0.92 * DEFAULT_CAMERA_ZOOM);
  assertVisible(initial, nodes[0], desktop, rect, 24);
  const empty = initialMapCamera([], null, mobile, mobileCanvas);
  assert.equal(empty.zoom, DEFAULT_CAMERA_ZOOM);
  assert.ok(Number.isFinite(empty.pan.x) && Number.isFinite(empty.pan.y));
  assert.deepEqual(fitMapCamera([], mobile, mobileCanvas), empty);
});

test('opening a wide drawer pans the selected lobe only as far as needed', () => {
  const node = { x: 1080, y: 480, r: 100 };
  const camera = { zoom: 1, pan: { x: 0, y: 0 } };
  const besideDrawer = { left: 84, top: 120, right: 948, bottom: 760 };
  const result = revealNodeCamera(camera, node, desktop, besideDrawer);
  assert.equal(result.zoom, camera.zoom);
  assert.equal(result.pan.y, camera.pan.y);
  const rendered = screenPoint(result, node, desktop);
  nearlyEqual(rendered.x + node.r * CAMERA_BASE_SCALE, besideDrawer.right - 16);
  assertVisible(result, node, desktop, besideDrawer, 16);
});

test('a short mobile sheet reduces zoom only enough to reveal the full selected lobe', () => {
  const node = { x: 1080, y: 480, r: 240 };
  const camera = cameraCenteredOn(node, mobile, mobileCanvas, 1);
  const aboveSheet = { left: 76, top: 168, right: 378, bottom: 340 };
  const result = revealNodeCamera(camera, node, mobile, aboveSheet);
  nearlyEqual(result.zoom, (172 - 32) / (480 * CAMERA_BASE_SCALE));
  assertVisible(result, node, mobile, aboveSheet, 16);
  const rendered = screenPoint(result, node, mobile);
  nearlyEqual(rendered.x, (aboveSheet.left + aboveSheet.right) / 2);
  nearlyEqual(rendered.y, (aboveSheet.top + aboveSheet.bottom) / 2);
});

test('revealing a visible lobe is an exact no-op and camera operations never mutate inputs', () => {
  const nodes = Object.freeze([
    Object.freeze({ id: 'root', x: 490, y: 460, r: 90 }),
    Object.freeze({ id: 'child', x: 730, y: 650, r: 55 }),
  ]);
  const camera = cameraCenteredOn(nodes[0], desktop, desktopCanvas);
  Object.freeze(camera.pan);
  Object.freeze(camera);
  assert.equal(revealNodeCamera(camera, nodes[0], desktop, desktopCanvas), camera);
  assert.equal(revealNodeCamera(camera, null, desktop, desktopCanvas), camera);
  const snapshot = JSON.stringify(nodes);
  fitMapCamera(nodes, mobile, mobileCanvas);
  initialMapCamera(nodes, 'root', mobile, mobileCanvas);
  revealNodeCamera(camera, nodes[1], mobile, mobileCanvas);
  zoomCameraAt(camera, 2, { x: 220, y: 420 }, desktop);
  assert.equal(JSON.stringify(nodes), snapshot);
});

test('an impossibly small reveal area centers the lobe at the minimum zoom', () => {
  const node = { x: 490, y: 460, r: 150 };
  const camera = { zoom: 1, pan: { x: 0, y: 0 } };
  const tiny = { left: 100, top: 200, right: 140, bottom: 240 };
  const result = revealNodeCamera(camera, node, mobile, tiny);
  assert.equal(result.zoom, MIN_CAMERA_ZOOM);
  const point = screenPoint(result, node, mobile);
  nearlyEqual(point.x, 120);
  nearlyEqual(point.y, 220);
});
