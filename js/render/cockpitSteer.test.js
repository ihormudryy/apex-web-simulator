import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STEER_WHEEL_LOCK, cockpitSteerAngle, followSteerAngle,
} from './cockpitSteer.js';

test('full right lock turns the wheel clockwise from the driver', () => {
  assert.equal(cockpitSteerAngle(1), STEER_WHEEL_LOCK);
});

test('full left lock is the opposite twist', () => {
  assert.equal(cockpitSteerAngle(-1), -STEER_WHEEL_LOCK);
});

test('straight ahead leaves the wheel centred', () => {
  assert.equal(cockpitSteerAngle(0), 0);
});

test('the rim eases toward the target instead of snapping', () => {
  const target = cockpitSteerAngle(1);
  const dt = 1 / 60;
  const a = followSteerAngle(0, target, dt);
  const b = followSteerAngle(a, target, dt);
  assert.ok(a > 0 && a < target, `first step ${a} should be between 0 and ${target}`);
  assert.ok(b > a && b < target, `second step ${b} should keep closing`);
});

test('a zero dt leaves the rim where it is', () => {
  assert.equal(followSteerAngle(0.4, 1, 0), 0.4);
});
