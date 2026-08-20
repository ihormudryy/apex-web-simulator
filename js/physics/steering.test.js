import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCar, step, warmUp, launch, forwardSpeed, lateralG, sideslipOf, yawRate,
} from './kernel.js';
import { maxSteerAt, MAX_STEER_DEG } from './driver.js';

const DT = 1 / 600;
const DEG = Math.PI / 180;
const FLAT = {
  query: () => ({ surface: 'tarmac', lateral: 0, wallLimit: 1e9, normal: { x: 0, z: 0 } }),
};

/**
 * Steer angle at which the car reaches its best sustained lateral acceleration,
 * found by sweeping well past the lock the car is given.
 */
function usableSteer(speedKmh, { maxDeg = 30, stepDeg = 0.5, hold = 3.0 } = {}) {
  const v = speedKmh / 3.6;
  let best = 0;
  let atSteer = 0;
  for (let deg = stepDeg; deg <= maxDeg; deg += stepDeg) {
    const car = createCar({});
    warmUp(car);
    launch(car, v);
    let sumAy = 0;
    let n = 0;
    const total = Math.round(hold / DT);
    for (let s = 0; s < total; s++) {
      const throttle = Math.max(0, Math.min(1, (v - forwardSpeed(car)) * 0.6));
      step(car, { throttle, brake: 0, steer: deg * DEG }, FLAT, DT);
      if (s > total * 0.75) { sumAy += lateralG(car); n++; }
    }
    const ay = sumAy / n;
    if (Math.abs(sideslipOf(car)) < 0.25 && forwardSpeed(car) > v * 0.85 && ay > best) {
      best = ay;
      atSteer = deg;
    }
  }
  return { ay: best, steer: atSteer };
}

// ---------------------------------------------------------------------------
// The reported symptom: "steering feels weird, the car is dragged when
// steering smoothly through a corner."
// ---------------------------------------------------------------------------

test('the steering lock is matched to what the front axle can use, at every speed', () => {
  // The fault this pins: a lock far wider than the front axle can use means the
  // top of the wheel's travel is past the tyre's peak slip angle, where MORE
  // steering gives LESS yaw and more scrub. Measured at 2.7x too much lock at
  // 250 km/h and 1.5x at 100, which is a car that stops responding a third of the
  // way into the wheel and then just ploughs.
  //
  // Some over-range is wanted — a car you cannot make understeer is an arcade
  // car, and a driver must be able to ask for too much. But it has to be a margin
  // rather than most of the travel.
  for (const kmh of [60, 100, 150, 250]) {
    const { steer } = usableSteer(kmh);
    const lock = maxSteerAt(kmh / 3.6) / DEG;
    const ratio = lock / steer;
    assert.ok(
      ratio > 1.05 && ratio < 1.9,
      `${kmh} km/h: ${lock.toFixed(1)} deg of lock for ${steer.toFixed(1)} deg of usable `
      + `steer (${ratio.toFixed(2)}x)`,
    );
  }
});

test('the lock is not STARVED at low speed either', () => {
  // The same curve was wrong in the other direction at the bottom: it had already
  // faded to 16.3 deg by 40 km/h, out of a mechanical 18, so a slow corner felt
  // like the car would not rotate.
  //
  // Note this does NOT assert the car can reach its tyre limit at 40 km/h. It
  // cannot, and should not: the measured usable angle there is 28.5 deg, past any
  // real F1 rack, so a slow hairpin is geometry-limited. That is true of the real
  // car — it is why Monaco needs a special rack. What is wrong is fading below the
  // mechanical limit at a speed where the extra lock is still worth having.
  const lock = maxSteerAt(40 / 3.6) / DEG;
  assert.ok(
    lock >= MAX_STEER_DEG * 0.9,
    `40 km/h: faded to ${lock.toFixed(1)} deg of a mechanical ${MAX_STEER_DEG}`,
  );
});

/** Sustained yaw rate at a fraction of the available lock. */
function yawAt(speedKmh, fraction) {
  const v = speedKmh / 3.6;
  const steer = maxSteerAt(v) * fraction;
  const car = createCar({});
  warmUp(car);
  launch(car, v);
  let sumYaw = 0;
  let n = 0;
  const total = Math.round(3.5 / DT);
  for (let s = 0; s < total; s++) {
    const throttle = Math.max(0, Math.min(1, (v - forwardSpeed(car)) * 0.6));
    step(car, { throttle, brake: 0, steer }, FLAT, DT);
    if (s > total * 0.75) { sumYaw += Math.abs(yawRate(car)); n++; }
  }
  return sumYaw / n;
}

test('turning MORE never gives LESS yaw within the available lock', () => {
  // This is the felt fault, stated as the property that matters.
  //
  // The Ackermann ratio is the wrong measure: at the grip limit it is necessarily
  // low, because the front axle is carrying real slip. At 150 km/h and 2.42 g the
  // arithmetic ceiling is 0.41, so a test demanding more than that asks for more
  // than physics allows.
  //
  // What a driver actually feels is monotonicity. With the old lock, yaw at
  // 150 km/h peaked at 5.9 deg and then FELL — 0.574 rad/s down to 0.471 at full
  // lock — so the last half of the wheel's travel took rotation away and added
  // scrub. That is "smooth steering drags it".
  for (const kmh of [100, 150, 250]) {
    const samples = [0.4, 0.55, 0.7, 0.85, 1].map(f => yawAt(kmh, f));
    const peak = Math.max(...samples);
    const atFull = samples[samples.length - 1];
    assert.ok(
      atFull >= peak * 0.9,
      `${kmh} km/h: yaw peaks at ${peak.toFixed(3)} rad/s and falls to `
      + `${atFull.toFixed(3)} at full lock — the top of the wheel takes rotation away`,
    );
  }
});

test('the lock still lets the driver ask for more than the car can give', () => {
  // Trimming the lock must not turn it into a limiter. Understeer has to be
  // reachable, or the car drives itself.
  for (const kmh of [100, 250]) {
    const { steer } = usableSteer(kmh);
    const lock = maxSteerAt(kmh / 3.6) / DEG;
    assert.ok(lock > steer, `${kmh} km/h: ${lock.toFixed(1)} deg cannot exceed the ${steer.toFixed(1)} deg limit`);
  }
});

test('lock falls monotonically with speed and stays physical', () => {
  let prev = Infinity;
  for (let v = 0; v <= 120; v += 2) {
    const lock = maxSteerAt(v) / DEG;
    assert.ok(lock <= prev + 1e-9, `lock rose from ${prev} to ${lock} at ${v} m/s`);
    assert.ok(lock > 0.5, `lock collapsed to ${lock} deg at ${v} m/s`);
    assert.ok(lock <= MAX_STEER_DEG + 1e-9, `lock ${lock} exceeds the mechanical limit`);
    prev = lock;
  }
});

test('the mechanical lock is what an F1 front wheel can actually turn', () => {
  assert.ok(MAX_STEER_DEG >= 18 && MAX_STEER_DEG <= 30, `${MAX_STEER_DEG} deg`);
  assert.ok(Math.abs(maxSteerAt(0) / DEG - MAX_STEER_DEG) < 1e-9, 'at rest it must be the full lock');
});
