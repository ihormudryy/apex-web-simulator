// js/physics/vehicle.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createVehicle, advance, updateSteering, resolvePedals,
  forwardSpeed, lateralSpeed, travelYaw, speed, REVERSE_THRESHOLD,
} from './vehicle.js';
import { WB } from './bicycle.js';

const DT = 1 / 60;
const flat = {
  query: () => ({
    surface: 'tarmac', wallLimit: 1e9, lateral: 0,
    normal: { x: 1, z: 0 }, tangent: { x: 0, z: 1 },
    halfWidth: 100, index: 0, t: 0,
  }),
};
const keys = over => ({ forward: false, reverse: false, left: false, right: false, brake: false, ...over });

function launched(speedMs, yaw = 0) {
  const car = createVehicle({ yaw });
  // yaw 0 faces -Z, so forward motion is -Z.
  car.vz = -speedMs;
  return car;
}

test('the reverse key brakes while the car is still rolling forward', () => {
  const car = launched(40);
  const pedals = resolvePedals(car, keys({ reverse: true }));
  assert.equal(pedals.brake, true, 'holding reverse at 40 m/s must brake');
  assert.equal(pedals.throttle, 0, 'and must not also drive');
});

test('the reverse key reverses once the car has all but stopped', () => {
  const car = launched(REVERSE_THRESHOLD * 0.5);
  const pedals = resolvePedals(car, keys({ reverse: true }));
  assert.equal(pedals.brake, false);
  assert.ok(pedals.throttle < 0, `throttle ${pedals.throttle} should be a reverse crawl`);
});

test('holding reverse from speed actually slows the car down', () => {
  const car = launched(40);
  const input = keys({ reverse: true });
  for (let f = 0; f < 60 * 4; f++) {
    updateSteering(car, input, DT);
    advance(car, input, flat, DT);
  }
  // Previously the reverse branch was gated to |vx| < 8, so this key lit the
  // brake lights and did nothing else: the car merely coasted to ~32 m/s.
  assert.ok(forwardSpeed(car) < 2,
    `still doing ${forwardSpeed(car).toFixed(1)} m/s after 4 s of reverse`);
  assert.equal(car.braking, true, 'brake lights should be on');
});

test('throttle and brake together do not double up', () => {
  const car = launched(40);
  const pedals = resolvePedals(car, keys({ forward: true, reverse: true }));
  assert.equal(pedals.throttle, 1, 'forward wins over reverse');
  assert.equal(pedals.brake, false);
});

test('substep count follows the frame time so a slow frame stays convergent', () => {
  // A 20 fps frame and a 60 fps frame must reach the same place after the same
  // simulated time, or a frame-rate dip changes the handling.
  const fast = launched(0);
  const slow = launched(0);
  const input = keys({ forward: true });
  for (let f = 0; f < 60; f++) { updateSteering(fast, input, 1 / 60); advance(fast, input, flat, 1 / 60); }
  for (let f = 0; f < 20; f++) { updateSteering(slow, input, 1 / 20); advance(slow, input, flat, 1 / 20); }
  const gap = Math.abs(forwardSpeed(fast) - forwardSpeed(slow)) / forwardSpeed(fast);
  assert.ok(gap < 0.05, `60 fps reached ${forwardSpeed(fast).toFixed(2)} m/s, 20 fps ${forwardSpeed(slow).toFixed(2)}`);
});

test('an over-long frame is clamped rather than teleporting the car', () => {
  const car = launched(60);
  const input = keys({ forward: true });
  const before = { x: car.x, z: car.z };
  advance(car, input, flat, 10);            // a ten second stall
  const moved = Math.hypot(car.x - before.x, car.z - before.z);
  assert.ok(moved < 60 * 0.05 + 1, `car jumped ${moved.toFixed(1)} m on one frame`);
  assert.equal(car.resets, 0);
});

test('heading helpers agree with the -Z facing convention', () => {
  const car = launched(30, 0);
  assert.ok(Math.abs(forwardSpeed(car) - 30) < 1e-9, `forwardSpeed ${forwardSpeed(car)}`);
  assert.ok(Math.abs(lateralSpeed(car)) < 1e-9, `lateralSpeed ${lateralSpeed(car)}`);
  assert.ok(Math.abs(speed(car) - 30) < 1e-9);
  assert.ok(Math.abs(travelYaw(car)) < 1e-9, `travelYaw ${travelYaw(car)}`);

  // Yawed left by 90 degrees, forward is -X.
  const left = createVehicle({ yaw: Math.PI / 2 });
  left.vx = -30;
  assert.ok(Math.abs(forwardSpeed(left) - 30) < 1e-9, `forwardSpeed ${forwardSpeed(left)}`);
  assert.ok(Math.abs(travelYaw(left) - Math.PI / 2) < 1e-9, `travelYaw ${travelYaw(left)}`);
});

test('a parked car reports its facing as its travel direction', () => {
  const car = createVehicle({ yaw: 1.234 });
  assert.equal(travelYaw(car), 1.234);
});

test('steering is speed-sensitive', () => {
  const slow = launched(0);
  const fast = launched(80);
  const input = keys({ left: true });
  for (let f = 0; f < 120; f++) {
    updateSteering(slow, input, DT);
    updateSteering(fast, input, DT);
  }
  assert.ok(slow.steerAngle > 0, 'left input should give positive (left) steer');
  assert.ok(slow.steerAngle > fast.steerAngle * 2,
    `slow lock ${slow.steerAngle} vs fast ${fast.steerAngle}`);
});

test('non-finite state snaps back to the spawn pose', () => {
  const car = createVehicle({ x: 10, z: 20, yaw: 0.5 });
  car.vx = NaN;
  advance(car, keys(), flat, DT);
  assert.equal(car.resets, 1);
  assert.deepEqual([car.x, car.z, car.yaw], [10, 20, 0.5]);
  assert.equal(car.vx, 0);
});

test('a stopped car does not rotate however the wheel is turned', () => {
  // Turning the wheel used to add `steer` to the slip angle as a flat term, so a
  // turned front tyre made its full 5.7 kN of lateral force at any speed at all.
  // With no momentum to resist it, a car rolling to a stop with lock on pivoted
  // on the spot instead of coming to rest.
  for (const held of [{ left: true }, { right: true },
                      { left: true, brake: true }, { right: true, forward: false }]) {
    const car = launched(40);
    const idle = keys();
    for (let f = 0; f < 60 * 40; f++) {          // coast to a standstill
      updateSteering(car, idle, DT);
      advance(car, idle, flat, DT);
    }
    assert.ok(Math.abs(forwardSpeed(car)) < 0.01, `did not stop: ${forwardSpeed(car)}`);

    const input = keys(held);
    const yaw0 = car.yaw;
    let peakRate = 0;
    for (let f = 0; f < 60 * 20; f++) {
      updateSteering(car, input, DT);
      advance(car, input, flat, DT);
      peakRate = Math.max(peakRate, Math.abs(car.av));
    }
    const spun = Math.abs(car.yaw - yaw0) * 180 / Math.PI;
    const label = Object.keys(held).join('+');
    assert.ok(spun < 0.5, `${label} rotated a stopped car by ${spun.toFixed(2)}°`);
    assert.ok(peakRate * 180 / Math.PI < 1, `${label} reached ${(peakRate * 180 / Math.PI).toFixed(1)}°/s at a standstill`);
  }
});

test('creeping with the wheel turned follows the Ackermann arc', () => {
  // The counterpart to the test above: at a crawl the car should still steer, and
  // steer by the amount the geometry dictates rather than pivoting.
  const car = launched(0);
  const blip = keys({ forward: true, left: true });
  for (let f = 0; f < 12; f++) { updateSteering(car, blip, DT); advance(car, blip, flat, DT); }

  const input = keys({ left: true });
  let checked = 0;
  for (let f = 0; f < 60 * 6; f++) {
    updateSteering(car, input, DT);
    advance(car, input, flat, DT);
    const v = forwardSpeed(car);
    if (v < 0.3 || v > 2.5) continue;
    const ackermann = v * Math.tan(Math.abs(car.steerAngle)) / WB;
    if (ackermann < 1e-4) continue;
    const ratio = Math.abs(car.av) / ackermann;
    assert.ok(ratio > 0.85 && ratio < 1.2,
      `at ${v.toFixed(2)} m/s the yaw rate was ${ratio.toFixed(2)}x the Ackermann rate`);
    checked++;
  }
  assert.ok(checked > 100, `only ${checked} samples fell in the crawl band`);
});
