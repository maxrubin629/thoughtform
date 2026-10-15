import test from 'node:test';
import assert from 'node:assert/strict';
import { lassoIntersectsNode } from './lassoSelection.js';
const square = [{x:0,y:0},{x:100,y:0},{x:100,y:100},{x:0,y:100}];
test('lasso selects enclosed lobes, boundary intersections, and a lobe surrounding the lasso', () => {
  assert.equal(lassoIntersectsNode(square, {x:50,y:50,r:2}), true);
  assert.equal(lassoIntersectsNode(square, {x:105,y:50,r:6}), true);
  assert.equal(lassoIntersectsNode(square, {x:50,y:50,r:100}), true);
  assert.equal(lassoIntersectsNode(square, {x:120,y:50,r:6}), false);
});
test('lasso respects concave gaps and its implicit closing edge', () => {
  const l = [{x:0,y:0},{x:100,y:0},{x:100,y:20},{x:20,y:20},{x:20,y:100},{x:0,y:100}];
  assert.equal(lassoIntersectsNode(l, {x:70,y:70,r:5}), false);
  assert.equal(lassoIntersectsNode(l, {x:-2,y:50,r:3}), true);
});
test('lasso works in translated world coordinates and rejects unfinished paths', () => {
  const shifted = square.map(p => ({x:p.x-500,y:p.y+700}));
  assert.equal(lassoIntersectsNode(shifted, {x:-450,y:750,r:4}), true);
  assert.equal(lassoIntersectsNode(square.slice(0,2), {x:50,y:0,r:4}), false);
});
