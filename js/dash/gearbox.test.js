// js/dash/gearbox.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RATIOS, IDLE_RPM, SHIFT_RPM, REDLINE_RPM, LIGHTS_FROM_RPM,
  rpmFor, gearFor, shiftFraction, advanceGear,
} from './gearbox.js';

test('gear never falls as speed rises', () => {
  let previous = 0;
  for (let v = 0; v <= 95; v += 0.25) {
    const gear = gearFor(v);
    assert.ok(gear >= previous, `gear dropped from ${previous} to ${gear} at ${v} m/s`);
    previous = gear;
  }
});

test('the whole speed range is covered by the eight ratios', () => {
  assert.equal(gearFor(0), 1);
  assert.equal(gearFor(1), 1);
  // Top speed is about 86 m/s, which should be top gear and near the shift point.
  assert.equal(gearFor(86), RATIOS.length);
  assert.ok(rpmFor(86, RATIOS.length) > LIGHTS_FROM_RPM,
    `top gear at top speed only pulls ${rpmFor(86, RATIOS.length)} rpm`);
});

test('engine speed stays inside the instrument range at every speed', () => {
  for (let v = 0; v <= 120; v += 0.5) {
    const rpm = rpmFor(v, gearFor(v));
    assert.ok(rpm >= IDLE_RPM && rpm <= REDLINE_RPM, `${rpm} rpm at ${v} m/s`);
  }
});

test('the gear selected keeps the engine under the shift point', () => {
  // Above the shift point the model would have changed up already, except in top.
  for (let v = 0; v <= 86; v += 0.5) {
    const gear = gearFor(v);
    if (gear < RATIOS.length) {
      assert.ok(rpmFor(v, gear) <= SHIFT_RPM,
        `${rpmFor(v, gear)} rpm in ${gear}${gear === 1 ? 'st' : 'th'} at ${v} m/s`);
    }
  }
});

test('an upshift drops the revs rather than raising them', () => {
  // Compared at each gear's own operating speed. At an arbitrary speed both the
  // current and the next gear can be pinned to the redline by the display clamp,
  // which would make them read equal.
  for (let gear = 1; gear < RATIOS.length; gear++) {
    let v = null;
    for (let probe = 0.5; probe <= 90; probe += 0.5) {
      if (gearFor(probe) === gear) { v = probe; }
    }
    assert.ok(v !== null, `no speed selects gear ${gear}`);
    const before = rpmFor(v, gear);
    const after = rpmFor(v, gear + 1);
    if (after <= IDLE_RPM) continue;   // bottom of the instrument range
    assert.ok(after < before,
      `changing ${gear}->${gear + 1} at ${v} m/s went ${before} -> ${after} rpm`);
  }
});

test('shift lights are dark until the revs come up, and full at the shift point', () => {
  assert.equal(shiftFraction(IDLE_RPM), 0);
  assert.equal(shiftFraction(LIGHTS_FROM_RPM), 0);
  assert.equal(shiftFraction(SHIFT_RPM), 1);
  assert.equal(shiftFraction(REDLINE_RPM), 1);
  const middle = shiftFraction((LIGHTS_FROM_RPM + SHIFT_RPM) / 2);
  assert.ok(middle > 0.4 && middle < 0.6, `mid-range fraction ${middle}`);
});

test('reverse and standstill read as idle, not as a stalled engine', () => {
  assert.equal(rpmFor(0, 1), IDLE_RPM);
  assert.equal(rpmFor(-5, 1), rpmFor(5, 1));
});

test('coasting does not downshift as speed falls', () => {
  const v0 = 70;
  let gear = gearFor(v0);
  assert.ok(gear >= 6, `top-end gear ${gear}`);
  for (let v = v0; v >= 20; v -= 2) {
    const next = advanceGear(gear, v, { throttle: 0 });
    assert.ok(next >= gear, `coasted from ${gear} to ${next} at ${v} m/s`);
    gear = next;
  }
});

test('power-on at low speed does downshift after the revs have fallen', () => {
  const held = advanceGear(8, 25, { throttle: 0 });
  assert.equal(held, 8);
  const pull = advanceGear(8, 25, { throttle: 1 });
  assert.ok(pull < 8, `still in ${pull} after asking for drive at 25 m/s`);
});

