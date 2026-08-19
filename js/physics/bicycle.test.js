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

test('steady left steer curves left without excessive sideslip', () => {
  const dt = 1 / 240;
  const steer = 18 * Math.PI / 180;
  let state = { vx: 40, vy: 0, av: 0, axPrev: 0 };
  let worldVx = 0;
  let worldVz = -40;
  let x = 0;
  let z = 0;
  let yaw = 0;

  for (let i = 0; i < 3 / dt; i++) {
    const sinY = Math.sin(yaw);
    const cosY = Math.cos(yaw);
    state = {
      ...state,
      vx: cosY * -worldVz - sinY * worldVx,
      vy: sinY * -worldVz + cosY * worldVx,
    };
    const result = step(state,
      { throttle: 0, brake: false, steer }, tarmac, dt);

    const ax = (result.vx - state.vx) / dt;
    const ay = (result.vy - state.vy) / dt;
    worldVz -= dt * (cosY * ax + sinY * ay);
    worldVx += dt * (-sinY * ax + cosY * ay);
    x += dt * worldVx;
    z += dt * worldVz;
    yaw += dt * result.av;

    state = {
      vx: result.vx,
      vy: result.vy,
      av: result.av,
      axPrev: result.axPrev,
    };
  }

  const sideslip = Math.atan2(
    Math.sin(yaw) * -worldVz + Math.cos(yaw) * worldVx,
    Math.cos(yaw) * -worldVz - Math.sin(yaw) * worldVx,
  );
  assert.ok(x < -20, `left steer should curve toward -X, x=${x}, z=${z}`);
  assert.ok(Math.abs(sideslip) < 15 * Math.PI / 180,
    `sideslip=${sideslip * 180 / Math.PI}°`);
});

function worldToLocal(cvelX, cvelY, sinY, cosY) {
  return {
    x: cosY * cvelX - sinY * cvelY,
    y: sinY * cvelX + cosY * cvelY,
  };
}

function rotateYaw(localX, localY, sinY, cosY) {
  return {
    x: cosY * localX + sinY * localY,
    y: -sinY * localX + cosY * localY,
  };
}

test('full throttle at non-zero heading does not spin', () => {
  const yaw0 = 159.44 * Math.PI / 180;
  let yaw = yaw0;
  let cvelX = 0;
  let cvelY = 0;
  let av = 0;
  let axPrev = 0;
  const n = 4;
  const h = (1 / 60) / n;

  for (let f = 0; f < 180; f++) {
    for (let i = 0; i < n; i++) {
      const sinY = Math.sin(yaw);
      const cosY = Math.cos(yaw);
      const vel = worldToLocal(cvelX, cvelY, sinY, cosY);
      const result = step(
        { vx: vel.x, vy: vel.y, av, axPrev },
        { throttle: 1, brake: false, steer: 0 },
        tarmac,
        h
      );
      const accX = (result.vx - vel.x) / h;
      const accY = (result.vy - vel.y) / h;
      av = result.av;
      axPrev = result.axPrev;
      const a2d = rotateYaw(accX, accY, sinY, cosY);
      cvelX += h * a2d.x;
      cvelY += h * a2d.y;
      yaw += h * av;
    }
  }

  const dYawDeg = (yaw - yaw0) * 180 / Math.PI;
  const vel = worldToLocal(cvelX, cvelY, Math.sin(yaw), Math.cos(yaw));
  assert.ok(Math.abs(dYawDeg) < 5, `spun ${dYawDeg.toFixed(1)}° under throttle`);
  assert.ok(vel.x > 20, `did not accelerate, vx=${vel.x}`);
  assert.ok(Math.abs(vel.y) < 1, `sideslip vy=${vel.y}`);
});
