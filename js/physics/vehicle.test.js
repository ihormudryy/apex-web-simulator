// js/physics/vehicle.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createVehicle, advance, updateSteering, resolvePedals,
  forwardSpeed, lateralSpeed, travelYaw, speed, REVERSE_THRESHOLD, renderPose,
} from './vehicle.js';
import { WB } from './constants.js';
import { MAX_CATCHUP, DT as SIM_DT } from './fixedStep.js';
import * as SIM from './state.js';

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
  // The ceiling is the accumulator's catch-up budget: time past it is dropped,
  // so the sim runs slow for a moment rather than teleporting the car.
  assert.ok(
    moved < 60 * MAX_CATCHUP + 1,
    `car jumped ${moved.toFixed(1)} m on one frame`,
  );
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
  // Poison the *authoritative* state. `car.vx` is now a field mirrored out of the
  // flat vector once per frame, so writing it would be overwritten and prove
  // nothing.
  car.car.S[SIM.S_VX] = NaN;
  advance(car, keys(), flat, DT);
  assert.equal(car.resets, 1);
  // Near-exact rather than exact: the reset happens inside the step that detects
  // the poison, and the rest of that frame's steps still run on the healthy car.
  assert.ok(Math.abs(car.x - 10) < 1e-4, `x ${car.x}`);
  assert.ok(Math.abs(car.z - 20) < 1e-4, `z ${car.z}`);
  assert.ok(Math.abs(car.yaw - 0.5) < 1e-6, `yaw ${car.yaw}`);
  assert.ok(Math.abs(car.vx) < 1e-3, `vx ${car.vx}`);
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

test('a settled crawl with the wheel turned follows the Ackermann arc', () => {
  // The counterpart to the test above: at a crawl the car should still steer, and
  // steer by the amount the geometry dictates rather than pivoting.
  //
  // What it must NOT assert is that the yaw rate tracks Ackermann *instantly*.
  // Relaxation length says the opposite: the lag is sigma/v, which at 1.5 m/s is
  // 0.23 s, and that is precisely why cars feel vague in slow corners. Checking
  // instantaneous samples during the transient reported 0.42x and looked like a
  // broken model. What is true, and worth pinning, is that once the lag has
  // settled the geometry holds.
  const car = createVehicle({});
  const crawl = 1.8;
  const ratios = [];
  for (let f = 0; f < 20 * 60; f++) {
    const fwd = forwardSpeed(car);
    const input = keys({ forward: fwd < crawl, left: true });
    updateSteering(car, input, DT);
    advance(car, input, flat, DT);
    // Discard the first three seconds: the steering ramp and the tyre lag are
    // both still moving.
    if (f < 3 * 60) continue;
    const ackermann = fwd * Math.tan(Math.abs(car.steerAngle)) / WB;
    if (ackermann < 1e-3) continue;
    ratios.push(Math.abs(car.av) / ackermann);
  }
  assert.ok(ratios.length > 300, `only ${ratios.length} settled samples`);
  const meanRatio = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  assert.ok(
    meanRatio > 0.85 && meanRatio < 1.15,
    `a settled crawl yawed at ${meanRatio.toFixed(3)}x the Ackermann rate`,
  );
});

/** Drive a scripted lap of inputs, chopping the same total time into `fps` frames. */
function scripted(fps, seconds = 3) {
  const car = createVehicle({});
  const frames = Math.round(fps * seconds);
  for (let i = 0; i < frames; i++) {
    const t = i / fps;
    // A shape with throttle, coasting, braking and steering in both directions, so
    // the comparison exercises every branch in the kernel.
    const input = keys({
      forward: t < 1.2 || (t > 2.0 && t < 2.5),
      brake: t >= 1.6 && t < 2.0,
      left: t > 0.5 && t < 1.5,
      right: t > 2.2,
    });
    updateSteering(car, input, 1 / fps);
    advance(car, input, flat, 1 / fps);
  }
  return car;
}

test('the trajectory barely depends on frame rate — 30, 60 and 144 fps agree', () => {
  const a = scripted(30);
  const b = scripted(60);
  const c = scripted(144);
  // Steering is still integrated on frame dt (it is a driver model, not physics),
  // so these are not bit-identical; the physics itself is, given the same steer.
  for (const [label, ref, other] of [['60 vs 30', b, a], ['60 vs 144', b, c]]) {
    const gap = Math.hypot(ref.x - other.x, ref.z - other.z);
    const path = Math.hypot(ref.x, ref.z);
    assert.ok(
      gap < Math.max(1.0, path * 0.02),
      `${label}: ${gap.toFixed(2)} m apart on a ${path.toFixed(0)} m path`,
    );
  }
});

test('identical input at identical frame times is bit-exact, run to run', () => {
  const a = scripted(60);
  const b = scripted(60);
  for (const k of ['x', 'z', 'yaw', 'vx', 'vz', 'av']) {
    assert.equal(a[k], b[k], `${k} drifted between two identical runs`);
  }
});

test('sim time tracks wall time to within one step, on any frame pattern', () => {
  // A pathological but realistic pattern: vsync misses and recoveries. Whatever
  // the shape, the accumulator must neither gain nor lose time — anything else is
  // a sim that runs fast or slow depending on the machine it is on.
  const patterns = {
    steady: [1 / 60],
    jittery: [1 / 60, 1 / 30, 1 / 144, 1 / 60, 1 / 20, 1 / 240],
    fast: [1 / 240],
  };
  for (const [label, pattern] of Object.entries(patterns)) {
    const car = createVehicle({});
    let wall = 0;
    for (let i = 0; wall < 2; i++) {
      const dt = pattern[i % pattern.length];
      advance(car, keys({ forward: true }), flat, dt);
      wall += dt;
    }
    const gap = Math.abs(car.clock.simTime - wall);
    assert.ok(gap < SIM_DT, `${label}: sim time is ${gap.toFixed(5)} s off wall time`);
  }
});

test('renderPose interpolates between the last two sim states', () => {
  const car = launched(50);
  advance(car, keys({ forward: true }), flat, 1 / 60);
  const pose = renderPose(car);
  const lo = Math.min(car.prev.z, car.z);
  const hi = Math.max(car.prev.z, car.z);
  assert.ok(pose.z >= lo && pose.z <= hi, `${pose.z} outside [${lo}, ${hi}]`);
  // And it must not be reading the raw state, which is what caused the stutter.
  assert.notEqual(car.prev.z, car.z, 'a frame at 60 fps must take several steps');
});

test('renderPose writes into a caller-supplied object, allocating nothing', () => {
  const car = launched(50);
  advance(car, keys({ forward: true }), flat, 1 / 60);
  const out = { x: 0, z: 0, yaw: 0 };
  assert.equal(renderPose(car, out), out, 'must return the same object it was given');
});
