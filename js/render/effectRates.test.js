import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  smokeRate, SMOKE_POWER_THRESHOLD,
  sparkRate, SPARK_MIN_SPEED,
  markIntensity, MARK_SLIP_THRESHOLD,
  brakeHaze, exhaustHaze, cameraShake,
} from './effectRates.js';

// ---------------------------------------------------------------------------
// Smoke
// ---------------------------------------------------------------------------

test('smoke follows slip POWER, not slip speed', () => {
  // A lightly loaded tyre spinning fast makes little smoke; a heavily loaded one
  // sliding slowly makes a lot. Keying it to speed alone gets both backwards.
  const fastLight = smokeRate(20, 800, 90);
  const slowHeavy = smokeRate(4, 8000, 90);
  assert.ok(slowHeavy > fastLight, `${slowHeavy} vs ${fastLight}`);
});

test('a rolling tyre makes no smoke', () => {
  assert.equal(smokeRate(0, 5000, 90), 0);
  assert.equal(smokeRate(0.2, 4000, 90), 0);
});

test('a locked wheel at speed smokes fully', () => {
  assert.ok(smokeRate(25, 6000, 120) > 0.9);
});

test('an overheated tyre smokes for less slip', () => {
  const cool = smokeRate(3, 5000, 90);
  const hot = smokeRate(3, 5000, 160);
  assert.ok(hot > cool, `hot ${hot} should exceed cool ${cool}`);
});

test('smoke is bounded to 0..1 at absurd inputs', () => {
  for (const [slip, load, t] of [[1e6, 1e6, 300], [-50, 5000, 90], [10, -5000, 90]]) {
    const r = smokeRate(slip, load, t);
    assert.ok(r >= 0 && r <= 1, `${r} for ${slip}, ${load}, ${t}`);
  }
});

// ---------------------------------------------------------------------------
// Sparks
// ---------------------------------------------------------------------------

test('a plank resting on the ground in the pit lane does not spark', () => {
  assert.equal(sparkRate(8000, 0), 0);
  assert.equal(sparkRate(8000, SPARK_MIN_SPEED), 0);
});

test('grinding the plank at speed does spark', () => {
  assert.ok(sparkRate(5000, 83) > 0.5, 'the shower comes from speed as well as contact');
});

test('no contact means no sparks however fast the car is going', () => {
  assert.equal(sparkRate(0, 90), 0);
  assert.equal(sparkRate(-100, 90), 0);
});

test('spark rate rises with both force and speed, and is bounded', () => {
  assert.ok(sparkRate(6000, 90) > sparkRate(2000, 90));
  assert.ok(sparkRate(6000, 90) > sparkRate(6000, 40));
  assert.ok(sparkRate(1e9, 1e9) <= 1);
});

// ---------------------------------------------------------------------------
// Tyre marks
// ---------------------------------------------------------------------------

test('a tyre marks the road long before it smokes', () => {
  // This is what makes a racing line build up over a session from cars that are
  // not sliding. A threshold set at the smoking point would never lay one down.
  const gentle = 1.2;
  assert.ok(markIntensity(gentle, 5000) > 0, 'gentle cornering must mark the road');
  assert.equal(smokeRate(gentle, 5000, 90), 0, 'and must not smoke');
});

test('a tyre rolling straight leaves nothing', () => {
  assert.equal(markIntensity(0, 5000), 0);
  assert.equal(markIntensity(MARK_SLIP_THRESHOLD, 5000), 0);
});

test('marks scale with load — a loaded tyre lays more rubber', () => {
  assert.ok(markIntensity(3, 7000) > markIntensity(3, 2000));
});

test('mark intensity is bounded', () => {
  assert.ok(markIntensity(1e6, 1e6) <= 1);
  assert.ok(markIntensity(5, 5000) >= 0);
});

// ---------------------------------------------------------------------------
// Haze
// ---------------------------------------------------------------------------

test('brake haze needs heat, and dies in the airflow', () => {
  assert.equal(brakeHaze(200, 15), 0, 'a cool duct does not shimmer');
  assert.equal(brakeHaze(500, 0), 0, 'blanket-warm discs at rest are not a smoke plume');
  assert.equal(brakeHaze(800, 0), 0, 'no airflow, no visible haze');
  const slowing = brakeHaze(800, 15);
  const flatOut = brakeHaze(800, 90);
  assert.ok(slowing > 0, 'hot discs at low speed must haze');
  assert.ok(slowing > flatOut * 2, `haze should be strongest as the car slows: ${slowing} vs ${flatOut}`);
});

test('exhaust haze follows engine load', () => {
  assert.equal(exhaustHaze(0, 12000), 0);
  assert.ok(exhaustHaze(1, 12000) > exhaustHaze(1, 5000));
  assert.ok(exhaustHaze(1, 15000) <= 1);
});

// ---------------------------------------------------------------------------
// Camera shake
// ---------------------------------------------------------------------------

test('the camera shakes with acceleration and with a bad surface', () => {
  const calm = cameraShake(0, 0, 0, 80);
  const cornering = cameraShake(0, 40, 0, 80);
  const bumpy = cameraShake(0, 0, 0.9, 80);
  assert.ok(calm < 0.05, `a smooth straight should be calm, got ${calm}`);
  assert.ok(cornering > calm, 'lateral g must be felt');
  assert.ok(bumpy > calm, 'and so must a rough surface');
});

test('a rough surface at a standstill does not shake the camera', () => {
  assert.ok(cameraShake(0, 0, 1, 0) < 0.05);
});

test('shake is bounded, so a crash does not throw the camera away', () => {
  assert.ok(cameraShake(200, 200, 1, 200) <= 1.5);
});
