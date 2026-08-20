import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createClock, resetClock, pump, DT, SIM_HZ, MAX_CATCHUP, MAX_STEPS, lerp,
} from './fixedStep.js';

test('one second of frames takes SIM_HZ steps however the frames are chopped', () => {
  for (const fps of [24, 30, 60, 75, 144, 165]) {
    const clock = createClock();
    let steps = 0;
    for (let i = 0; i < fps; i++) pump(clock, 1 / fps, () => steps++);
    // The accumulator carries at most one step of float residue across a second.
    assert.ok(
      Math.abs(steps - SIM_HZ) <= 1,
      `${fps} fps took ${steps} steps, expected ~${SIM_HZ}`,
    );
  }
});

test('the trajectory is identical at 30, 60 and 144 fps', () => {
  const run = fps => {
    const clock = createClock();
    let x = 0;
    for (let i = 0; i < fps * 2; i++) pump(clock, 1 / fps, () => { x += DT * 10; });
    return x;
  };
  const a = run(30);
  const b = run(60);
  const c = run(144);
  // Same integrand, same step size — only the step *count* can differ, and only
  // by the residue in the accumulator.
  assert.ok(Math.abs(a - b) < DT * 10 * 2, `30 fps ${a} vs 60 fps ${b}`);
  assert.ok(Math.abs(b - c) < DT * 10 * 2, `60 fps ${b} vs 144 fps ${c}`);
});

test('a stalled frame is clamped instead of demanding a thousand steps', () => {
  const clock = createClock();
  let steps = 0;
  pump(clock, 5.0, () => steps++);
  assert.ok(steps <= MAX_STEPS, `${steps} steps for a 5 s frame`);
  assert.ok(clock.dropped > 4.8, 'the excess wall time is reported as dropped');
});

test('a frame shorter than DT takes no step but still advances alpha', () => {
  const clock = createClock();
  let steps = 0;
  const taken = pump(clock, DT * 0.4, () => steps++);
  assert.equal(taken, 0);
  assert.equal(steps, 0);
  assert.ok(clock.alpha > 0.39 && clock.alpha < 0.41, `alpha ${clock.alpha}`);
});

test('alpha stays in [0, 1)', () => {
  const clock = createClock();
  for (const dt of [0.001, 0.016, 0.0007, 0.033, 0.05, 0.0001]) {
    pump(clock, dt, () => {});
    assert.ok(clock.alpha >= 0 && clock.alpha < 1, `alpha ${clock.alpha} for dt ${dt}`);
  }
});

test('beforeStep runs once per step, so the snapshot trails by exactly one', () => {
  const clock = createClock();
  let value = 0;
  let snapshot = -1;
  pump(clock, 1 / 60, () => { value++; }, () => { snapshot = value; });
  assert.equal(snapshot, value - 1, 'snapshot must be the state one step back');
});

test('a non-finite or zero frame time takes no steps', () => {
  const clock = createClock();
  let steps = 0;
  pump(clock, 0, () => steps++);
  pump(clock, -1, () => steps++);
  pump(clock, NaN, () => steps++);
  assert.equal(steps, 0);
});

test('resetClock clears the accumulator so a respawn does not inherit time', () => {
  const clock = createClock();
  pump(clock, 0.007, () => {});
  assert.ok(clock.accumulator > 0);
  resetClock(clock);
  assert.equal(clock.accumulator, 0);
  assert.equal(clock.simTime, 0);
});

test('MAX_CATCHUP is long enough for a slow frame and short enough to not spiral', () => {
  assert.ok(MAX_CATCHUP >= 4 / 60, 'must absorb a few dropped frames');
  assert.ok(MAX_CATCHUP <= 0.25, 'longer than this and catch-up is itself a hitch');
});

test('lerp interpolates the endpoints', () => {
  assert.equal(lerp(2, 4, 0), 2);
  assert.equal(lerp(2, 4, 1), 4);
  assert.equal(lerp(2, 4, 0.5), 3);
});
