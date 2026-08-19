import { test } from 'node:test';
import assert from 'node:assert/strict';
import { peakGrip, combineSlip, slipRatio, WHEEL_RADIUS } from './wheel.js';
import { wheelNormalLoads, TRACK_HALF } from './loadTransfer.js';
import { MASS, G, WB, LF, LR } from './constants.js';

test('peak grip grows sub-linearly with vertical load', () => {
  const low = peakGrip(1.6, 3000);
  const high = peakGrip(1.6, 6000);
  assert.ok(high < low * 2, `doubling load more than doubled grip: ${low} → ${high}`);
  assert.ok(high > low * 1.2);
});

test('combined slip stays inside the friction circle', () => {
  const d = 5000;
  const { fx, fy } = combineSlip(d * 0.9, d * 0.9, d);
  assert.ok(Math.hypot(fx, fy) <= d * 1.001);
});

test('slip ratio is zero when wheel speed matches road speed', () => {
  const v = 30;
  assert.ok(Math.abs(slipRatio(v, v / WHEEL_RADIUS)) < 1e-9);
});

test('lateral load transfer shifts weight to the outside in a left turn', () => {
  const ay = -8;
  const [fl, fr, rl, rr] = wheelNormalLoads(0, ay, 0);
  assert.ok(fr > fl, 'right-front should load in a left turn');
  assert.ok(rr > rl, 'right-rear should load in a left turn');
  const total = fl + fr + rl + rr;
  assert.ok(Math.abs(total - MASS * G) < 50);
});

test('track half-width is realistic for F1', () => {
  assert.ok(TRACK_HALF > 0.7 && TRACK_HALF < 1.0);
});
