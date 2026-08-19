// js/physics/bicycle.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { step, MASS } from './bicycle.js';

const tarmac = { surface: 'tarmac', wallLimit: 20, lateral: 0, normal: { x: 1, z: 0 } };

test('straight-line pull exceeds 83 m/s', () => {
  let s = { vx: 1, vy: 0, av: 0, axPrev: 0 };
  const dt = 1 / 120;
  for (let i = 0; i < 120 * 25; i++) {
    s = step(s, { throttle: 1, brake: false, steer: 0 }, tarmac, dt);
  }
  assert.ok(s.vx >= 83, `vx=${s.vx}`);
});

test('grass μ is lower than tarmac at 40 m/s 2° slip', () => {
  const slip = 2 * Math.PI / 180;
  const a = step({ vx: 40, vy: 40 * Math.tan(slip), av: 0, axPrev: 0 },
    { throttle: 0, brake: false, steer: 0 }, tarmac, 0.008);
  const g = step({ vx: 40, vy: 40 * Math.tan(slip), av: 0, axPrev: 0 },
    { throttle: 0, brake: false, steer: 0 }, { ...tarmac, surface: 'grass' }, 0.008);
  assert.ok(Math.abs(a.fy) > Math.abs(g.fy) * 2);
});
