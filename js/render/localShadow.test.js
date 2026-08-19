import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localShadowLightPose } from './localShadow.js';

test('shadow light sits along the sun from the car, frustum covers the radius', () => {
  const pose = localShadowLightPose(
    { x: 10, y: 0, z: 20 },
    { x: 0, y: 1, z: 0 },
    { distance: 80, radius: 40 }
  );
  assert.equal(pose.light.x, 10);
  assert.equal(pose.light.y, 80);
  assert.equal(pose.light.z, 20);
  assert.deepEqual(pose.target, { x: 10, y: 0, z: 20 });
  assert.equal(pose.left, -40);
  assert.equal(pose.right, 40);
  assert.equal(pose.top, 40);
  assert.equal(pose.bottom, -40);
  assert.ok(pose.near < 80);
  assert.ok(pose.far > 80);
  assert.ok(pose.far - pose.near > 80);
});

test('oblique sun keeps the same distance from the car', () => {
  const sun = { x: 0.6, y: 0.8, z: 0 };
  const pose = localShadowLightPose({ x: 0, y: 0, z: 0 }, sun, { distance: 100, radius: 40 });
  const d = Math.hypot(pose.light.x, pose.light.y, pose.light.z);
  assert.ok(Math.abs(d - 100) < 1e-9);
  assert.ok(Math.abs(pose.light.x / pose.light.y - 0.6 / 0.8) < 1e-9);
});
