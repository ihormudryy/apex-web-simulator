import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  followDirectionalSun,
  HEMISPHERE_INTENSITY,
  RIM_INTENSITY,
  SHADOW_INTENSITY,
  SUN_INTENSITY,
} from './lightingBalance.js';

function fakeLight() {
  return {
    position: {
      x: 0, y: 0, z: 0,
      copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; },
      addScaledVector(v, s) {
        this.x += v.x * s;
        this.y += v.y * s;
        this.z += v.z * s;
        return this;
      },
    },
    target: {
      position: {
        x: 0, y: 0, z: 0,
        copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; },
      },
      updateMatrixWorld() {},
    },
  };
}

test('WebGPU fill is weaker than WebGL so the sun can punch shadows', () => {
  assert.ok(HEMISPHERE_INTENSITY.webgpu < HEMISPHERE_INTENSITY.webgl);
  assert.ok(RIM_INTENSITY.webgpu < RIM_INTENSITY.webgl);
  assert.ok(SUN_INTENSITY >= 2.5);
  assert.ok(SHADOW_INTENSITY >= 0.8);
});

test('directional sun stays above the camera anchor along the sun ray', () => {
  const light = fakeLight();
  const sunDir = { x: 0, y: 1, z: 0 };
  const anchor = { x: 120, y: 0, z: -40 };

  followDirectionalSun(light, sunDir, anchor, 200);

  assert.equal(light.target.position.x, 120);
  assert.equal(light.target.position.z, -40);
  assert.equal(light.position.x, 120);
  assert.equal(light.position.z, -40);
  assert.equal(light.position.y, 200);
});
