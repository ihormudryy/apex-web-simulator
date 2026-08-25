import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createStartLights, armStartLights, resetStartLights, advanceStartLights,
  startInputLocked, jumpStartExpired,
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
  armStartLights(s);
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
  armStartLights(s);
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
  armStartLights(s);
  run(s, 2.5); // three lights on
  advanceStartLights(s, 1 / 120, true);
  assert.equal(s.phase, 'jump');
  assert.equal(startInputLocked(s), true, 'a jump start does not unlock the pedals');
  assert.equal(jumpStartExpired(s), false);
  run(s, JUMP_SHOWN + 0.05);
  assert.ok(jumpStartExpired(s), 'the verdict expires into a grid reset');

  const clean = createStartLights(() => 0.5);
  armStartLights(clean);
  run(clean, FIRST_LIGHT_DELAY + 4 * LIGHT_INTERVAL + clean.hold + 0.05);
  advanceStartLights(clean, 1 / 120, true);
  assert.equal(clean.phase, 'green', 'throttle after lights out is just racing');
});

test('input stays locked through the whole sequence', () => {
  const s = createStartLights(() => 0.5);
  armStartLights(s);
  for (let t = 0; t < FIRST_LIGHT_DELAY + 4 * LIGHT_INTERVAL + s.hold - 0.05; t += 1 / 120) {
    advanceStartLights(s, 1 / 120, false);
    assert.equal(startInputLocked(s), true, `locked at ${t.toFixed(2)}s`);
  }
});

test('the sequence does not begin until it is armed', () => {
  const s = createStartLights(() => 0.5);
  assert.equal(s.phase, 'idle');
  for (let i = 0; i < 60; i++) advanceStartLights(s, 1 / 60, false);
  assert.equal(s.phase, 'idle', 'the lights started on their own');
  assert.equal(s.lit, 0);
  assert.equal(startInputLocked(s), true, 'the car should be held on the grid while idle');
});

test('arming starts the sequence, and lights come on one per second', () => {
  const s = createStartLights(() => 0.5);
  armStartLights(s);
  assert.equal(s.phase, 'sequence');
  const step = 1 / 120;
  const runTo = seconds => { let t = 0; while (t < seconds) { advanceStartLights(s, step, false); t += step; } };
  runTo(FIRST_LIGHT_DELAY + 0.01);
  assert.equal(s.lit, 1);
  runTo(FIRST_LIGHT_DELAY + 4 * LIGHT_INTERVAL + 0.01);
  assert.equal(s.lit, 5);
});

test('a jump start returns to idle so the player must re-arm', () => {
  const s = createStartLights(() => 0.5);
  armStartLights(s);
  advanceStartLights(s, 0.1, true);
  assert.equal(s.phase, 'jump');
  let t = 0;
  while (t < JUMP_SHOWN + 0.1) { advanceStartLights(s, 1 / 120, false); t += 1 / 120; }
  assert.equal(jumpStartExpired(s), true);
  resetStartLights(s);
  assert.equal(s.phase, 'idle');
});

test('the hold is not learnable, but is reproducible from a seed', () => {
  const seeded = () => { let n = 0; return () => ((n = (n * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff); };
  const a = createStartLights(seeded());
  const b = createStartLights(seeded());
  assert.equal(a.hold, b.hold, 'same seed gave a different hold');
  const c = createStartLights(() => 0.0);
  const d = createStartLights(() => 1.0);
  assert.notEqual(c.hold, d.hold, 'the hold does not depend on the rng at all');
});
