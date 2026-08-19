// js/track/centerline.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCenterline } from './centerline.js';
import { SILVERSTONE_WAYPOINTS } from './silverstoneWaypoints.js';

const box = [
  { x: 0, z: 0, halfWidth: 6, runoff: 8 },
  { x: 100, z: 0, halfWidth: 6, runoff: 8 },
  { x: 100, z: 50, halfWidth: 6, runoff: 8 },
  { x: 0, z: 50, halfWidth: 6, runoff: 8 },
];

test('closed loop length is perimeter', () => {
  const c = buildCenterline(box, 400);
  assert.ok(Math.abs(c.length - 300) / 300 < 0.08);
});

test('on-center is tarmac, 7m off is kerb, 20m off is grass', () => {
  const c = buildCenterline(box, 400);
  const mid = c.query(50, 0);
  assert.equal(mid.surface, 'tarmac');
  const kerb = c.query(50, 6.5);
  assert.equal(kerb.surface, 'kerb');
  const grass = c.query(50, 20);
  assert.equal(grass.surface, 'grass');
  assert.ok(grass.wallLimit > 10);
});

test('lateral positive is right of +X travel on bottom edge', () => {
  const c = buildCenterline(box, 400);
  const left = c.query(50, 6.5);
  assert.ok(left.lateral < 0, 'left of travel should be negative lateral');
  const right = c.query(50, -6.5);
  assert.ok(right.lateral > 0, 'right of travel should be positive lateral');
});

test('Silverstone GP length is 5.891 km ± 5%', () => {
  const c = buildCenterline(SILVERSTONE_WAYPOINTS, 4000);
  assert.ok(c.length > 5596 && c.length < 6186, `length ${c.length}`);
});
