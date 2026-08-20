import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setSunLightDirection } from './sunLightDirection.js';

test('sun light sits opposite travel direction, shining toward the origin', () => {
  const sunLight = {
    position: {
      x: 0, y: 0, z: 0,
      copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; },
      multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; },
    },
    target: {
      position: { set(x, y, z) { this.x = x; this.y = y; this.z = z; }, x: 1, y: 1, z: 1 },
      updateMatrixWorld() {},
    },
  };
  const sunDir = { x: 0.2, y: 0.9, z: 0.1 };

  setSunLightDirection(sunLight, sunDir, 100);

  assert.ok(Math.abs(sunLight.position.x - 20) < 1e-6);
  assert.ok(Math.abs(sunLight.position.y - 90) < 1e-6);
  assert.equal(sunLight.target.position.x, 0);
  assert.equal(sunLight.target.position.y, 0);
  assert.equal(sunLight.target.position.z, 0);
});
