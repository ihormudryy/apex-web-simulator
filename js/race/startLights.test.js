import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createStartLights, advanceStartLights, startInputLocked, jumpStartExpired,
  FIRST_LIGHT_DELAY, LIGHT_INTERVAL, HOLD_MIN, HOLD_RANGE, GREEN_SHOWN, JUMP_SHOWN,
} from './startLights.js';

/** Run the sequence at a fixed step, recording when each light came on. */
function run(s, seconds, dt = 1 / 120, throttle = () => false) {
  const litAt = [];
  for (let t = 0; t < seconds; t += dt) {
    const before = s.lit;
    advanceStartLights(s, dt, throttle(t, s));
    if (s.lit > before) for (let n = before + 1; n <= s.lit; n++) litAt[n] = t;
  }
  return litAt;
}

test('five lights come on one per second, in order', () => {
  const s = createStartLights(() => 0.5);
  const litAt = run(s, FIRST_LIGHT_DELAY + 4 * LIGHT_INTERVAL + 0.5);
  assert.equal(s.lit, 5);
  for (let n = 1; n <= 5; n++) {
    const expected = FIRST_LIGHT_DELAY + (n - 1) * LIGHT_INTERVAL;
    assert.ok(Math.abs(litAt[n] - expected) < 0.02, `light ${n} at ${litAt[n]}s vs ${expected}s`);
  }
});

test('the hold is random within bounds and not learnable from the constants alone', () => {
  assert.equal(createStartLights(() => 0).hold, HOLD_MIN);
  assert.equal(createStartLights(() => 1).hold, HOLD_MIN + HOLD_RANGE);
  const a = createStartLights(() => 0.1).hold;
  const b = createStartLights(() => 0.9).hold;
  assert.ok(a !== b, 'different rolls give different holds');
});

test('lights go out together after the hold, then the gantry hides', () => {
  const s = createStartLights(() => 0.5);
  const hold = s.hold;
  run(s, FIRST_LIGHT_DELAY + 4 * LIGHT_INTERVAL + hold + 0.05);
  assert.equal(s.phase, 'green');
  assert.equal(s.lit, 0, 'all five go out at once');
  assert.equal(startInputLocked(s), false, 'pedals live at lights out');
  run(s, GREEN_SHOWN + 0.05);
  assert.equal(s.phase, 'done');
});

test('throttle before lights out is a jump start; after, it is racing', () => {
  const s = createStartLights(() => 0.5);
  run(s, 2.5); // three lights on
  advanceStartLights(s, 1 / 120, true);
  assert.equal(s.phase, 'jump');
  assert.equal(startInputLocked(s), true, 'a jump start does not unlock the pedals');
  assert.equal(jumpStartExpired(s), false);
  run(s, JUMP_SHOWN + 0.05);
  assert.ok(jumpStartExpired(s), 'the verdict expires into a grid reset');

  const clean = createStartLights(() => 0.5);
  run(clean, FIRST_LIGHT_DELAY + 4 * LIGHT_INTERVAL + clean.hold + 0.05);
  advanceStartLights(clean, 1 / 120, true);
  assert.equal(clean.phase, 'green', 'throttle after lights out is just racing');
});

test('input stays locked through the whole sequence', () => {
  const s = createStartLights(() => 0.5);
  for (let t = 0; t < FIRST_LIGHT_DELAY + 4 * LIGHT_INTERVAL + s.hold - 0.05; t += 1 / 120) {
    advanceStartLights(s, 1 / 120, false);
    assert.equal(startInputLocked(s), true, `locked at ${t.toFixed(2)}s`);
  }
});
