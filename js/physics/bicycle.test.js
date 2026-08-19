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

test('lateral tire force restores positive sideslip', () => {
  const dt = 0.01;
  const s = step({ vx: 40, vy: 1, av: 0, axPrev: 0 },
    { throttle: 0, brake: false, steer: 0 }, tarmac, dt);
  assert.ok(s.fy < 0, `fy=${s.fy} should oppose +vy sideslip`);
  assert.ok(s.vy < 1, `vy grew to ${s.vy}`);
});

test('straight reverse crawl stays laterally neutral', () => {
  const dt = 0.01;
  const s = step({ vx: -1, vy: 0, av: 0, axPrev: 0 },
    { throttle: -0.25, brake: false, steer: 0 }, tarmac, dt);
  assert.ok(Math.abs(s.fy) < 100, `fy=${s.fy}`);
  assert.ok(Math.abs(s.vy) < 0.01, `vy=${s.vy}`);
});

test('drive force uses rear longitudinal budget', () => {
  const dt = 0.01;
  const s = step({ vx: 3, vy: 0, av: 0, axPrev: 0 },
    { throttle: 1, brake: false, steer: 0 }, tarmac, dt);
  const fx = (s.vx - 3) / dt * MASS;
  const frontOnly = 1.6 * MASS * 9.81 * 0.46;
  assert.ok(fx > frontOnly * 1.02, `fx=${fx} capped at front grip ${frontOnly}`);
});

test('reverse steering reverses lateral and yaw response', () => {
  const dt = 0.01;
  const input = { throttle: 0, brake: false, steer: 0.1 };
  const base = { vy: 0, av: 0, axPrev: 0 };
  const f = step({ ...base, vx: 1 }, input, tarmac, dt);
  const r = step({ ...base, vx: -1 }, input, tarmac, dt);
  assert.ok(f.fy * r.fy < 0, `fy same sign: forward=${f.fy} reverse=${r.fy}`);
  assert.ok(f.av * r.av < 0, `yaw same sign: forward=${f.av} reverse=${r.av}`);
});
