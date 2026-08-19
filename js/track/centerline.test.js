// js/track/centerline.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCenterline } from './centerline.js';

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
