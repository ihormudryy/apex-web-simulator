// js/physics/lap.test.js
//
// Integration cover for "can this circuit actually be driven?". Drives the same
// vehicle module the browser drives, over the same centerline the mesh is built
// from, so a track edit that makes a corner impossible fails here rather than in
// somebody's hands.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createVehicle, setPose, advance, updateSteering, forwardSpeed, lateralSpeed,
} from './vehicle.js';
import { WB } from './constants.js';
import { buildCenterline } from '../track/centerline.js';
import { SILVERSTONE_WAYPOINTS } from '../track/silverstoneWaypoints.js';

const DT = 1 / 60;
const MAX_STEER = 18 * Math.PI / 180;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const wrap = a => {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
};

function silverstone() {
  const centerline = buildCenterline(SILVERSTONE_WAYPOINTS, 4000);
  let hint = 0;
  return {
    centerline,
    query(x, z) {
      const r = centerline.query(x, z, hint);
      hint = r.index;
      return r;
    },
  };
}

function spawnedCar(track) {
  const s = track.centerline.samples[0];
  const car = createVehicle();
  setPose(car, s.x, s.z, Math.atan2(-s.tx, -s.tz));
  return car;
}

// Input belongs to whoever is driving, not to the vehicle state.
const noInput = () =>
  ({ forward: false, reverse: false, left: false, right: false, brake: false });

/**
 * Autopilot: pure-pursuit steering, a braking profile off the curvature ahead,
 * and a lift in corners.
 *
 * Targets 1.4 g, a little inside what the tyres give at these speeds, because the
 * point of these tests is the track and the vehicle rather than the driver. Above
 * roughly 1.8 g it starts running wide at Abbey — as it should, since it is then
 * asking for more grip than exists.
 */
function makeDriver({ latG = 1.4, topSpeed = 45, brakeG = 3.0 } = {}) {
  return function drive(car, input, track) {
    const { samples, spacing } = track.centerline;
    const n = samples.length;
    const here = track.query(car.x, car.z);
    const v = Math.max(forwardSpeed(car), 1);
    const step = Math.max(1, Math.round(6 / spacing));

    // Slowest speed any curvature between here and a braking distance ahead allows.
    let target = topSpeed;
    const horizon = Math.round((30 + v * v / (2 * brakeG * 9.81)) / spacing);
    for (let d = 0; d < horizon; d += step) {
      const a = samples[(here.index + d) % n];
      const b = samples[(here.index + d + step) % n];
      const turn = Math.acos(clamp(a.tx * b.tx + a.tz * b.tz, -1, 1));
      if (turn < 1e-6) continue;
      const radius = (step * spacing) / turn;
      const cornerSpeed = Math.sqrt(latG * 9.81 * radius);
      target = Math.min(target,
        Math.sqrt(cornerSpeed * cornerSpeed + 2 * brakeG * 9.81 * d * spacing));
    }

    // Pure pursuit: the arc through a point `L` ahead has curvature 2·sin(err)/L,
    // and Ackermann turns that into a steer angle. Nothing to tune.
    const L = Math.max(12, 0.9 * v);
    const aim = samples[(here.index + Math.max(1, Math.round(L / spacing))) % n];
    const dx = aim.x - car.x, dz = aim.z - car.z;
    const dist = Math.max(Math.hypot(dx, dz), 1);
    const err = wrap(Math.atan2(-dx, -dz) - car.yaw);
    const steer = Math.atan(WB * 2 * Math.sin(err) / dist);

    // steerSmooth is negative for a left turn; servo the boolean keys onto it.
    const want = clamp(-steer / MAX_STEER, -1, 1);
    input.left = car.steerSmooth > want + 0.02;
    input.right = car.steerSmooth < want - 0.02;

    const lateralUse = Math.abs(car.av) * v / (latG * 9.81);
    input.forward = v < target && lateralUse < 0.55;
    input.brake = v > target * 1.05;
    input.reverse = false;

    updateSteering(car, input, DT);
    advance(car, input, track, DT);
    return here;
  };
}

function runLaps(seconds, options) {
  const track = silverstone();
  const car = spawnedCar(track);
  const input = noInput();
  const drive = makeDriver(options);
  const stats = {
    laps: 0, lapTimes: [], frames: 0, offRoad: 0, wallFrames: 0,
    worstLateral: 0, worstSlip: 0, topSpeed: 0,
    surfaces: { tarmac: 0, kerb: 0, grass: 0 },
  };
  let prevT = 0, lapStart = 0;
  const frames = Math.round(seconds / DT);
  for (let f = 0; f < frames; f++) {
    const q = drive(car, input, track);
    stats.frames++;
    stats.surfaces[q.surface]++;
    stats.worstLateral = Math.max(stats.worstLateral, Math.abs(q.lateral));
    stats.topSpeed = Math.max(stats.topSpeed, forwardSpeed(car));
    if (Math.hypot(car.vx, car.vz) > 3) {
      stats.worstSlip = Math.max(stats.worstSlip,
        Math.abs(Math.atan2(lateralSpeed(car), forwardSpeed(car))));
    }
    if (Math.abs(q.lateral) > q.halfWidth + 1) stats.offRoad++;
    if (Math.abs(q.lateral) > q.wallLimit) stats.wallFrames++;
    if (q.t < prevT - 0.5) {
      stats.laps++;
      stats.lapTimes.push(f * DT - lapStart);
      lapStart = f * DT;
    }
    prevT = q.t;
  }
  stats.resets = car.resets;
  return stats;
}

test('the circuit can be lapped without leaving the road', () => {
  const stats = runLaps(460);
  assert.ok(stats.laps >= 2, `only completed ${stats.laps} lap(s) in 460 s`);
  assert.equal(stats.resets, 0, 'physics went non-finite and snapped back to spawn');
  assert.equal(stats.wallFrames, 0, `touched the barriers on ${stats.wallFrames} frames`);
  assert.equal(stats.offRoad, 0, `left the road on ${stats.offRoad} frames`);
  assert.equal(stats.surfaces.grass, 0, `${stats.surfaces.grass} frames on grass`);
});

test('a lapping car stays pointed where it is going', () => {
  const stats = runLaps(460);
  // The "drives like it is on ice" regression: the demand-based drive force used
  // to be scaled down together with the cornering force by the friction-circle
  // clip, so a car on the throttle threw away 35-40% of its rear grip to a drive
  // force the tyre could never deliver. Steady-state sideslip at 40 m/s was 16°.
  assert.ok(stats.worstSlip < 10 * Math.PI / 180,
    `peak sideslip ${(stats.worstSlip * 180 / Math.PI).toFixed(0)}° — the car is drifting, not cornering`);
  assert.ok(stats.worstLateral < 7,
    `wandered ${stats.worstLateral.toFixed(1)} m off the centerline`);
});

test('lap time matches the pace the driver targets', () => {
  const topSpeed = 45;
  const stats = runLaps(460, { topSpeed });
  const lap = 5891;
  for (const t of stats.lapTimes) {
    // Cannot beat holding the cap the whole way, and should not be 3x worse.
    assert.ok(t > lap / topSpeed, `lap ${t.toFixed(1)} s beats the ${topSpeed} m/s cap`);
    assert.ok(t < 3 * lap / topSpeed, `lap ${t.toFixed(1)} s is far off the pace`);
  }
  assert.ok(stats.topSpeed > 40, `never reached the cap, peaked at ${stats.topSpeed.toFixed(1)} m/s`);
});

test('the barriers contain a car driven straight at them', () => {
  const track = silverstone();
  const car = spawnedCar(track);
  const start = track.query(car.x, car.z);
  // Point it at the outside wall and pin the throttle.
  car.yaw = Math.atan2(-start.normal.x, -start.normal.z);
  const input = { ...noInput(), forward: true };
  let worst = 0;
  for (let f = 0; f < 60 * 30; f++) {
    updateSteering(car, input, DT);
    advance(car, input, track, DT);
    const q = track.query(car.x, car.z);
    worst = Math.max(worst, Math.abs(q.lateral) - q.wallLimit);
  }
  assert.equal(car.resets, 0, 'physics blew up against the barrier');
  assert.ok(worst < 1.5, `car pushed ${worst.toFixed(2)} m past the barrier`);
});

test('a car left alone on the grid stays on the grid', () => {
  const track = silverstone();
  const car = spawnedCar(track);
  const start = { x: car.x, z: car.z, yaw: car.yaw };
  const input = noInput();
  for (let f = 0; f < 60 * 30; f++) {
    updateSteering(car, input, DT);
    advance(car, input, track, DT);
  }
  const drift = Math.hypot(car.x - start.x, car.z - start.z);
  assert.ok(drift < 0.05, `drifted ${drift.toFixed(3)} m in 30 s with no input`);
  assert.ok(Math.abs(car.yaw - start.yaw) < 1e-3, `yawed ${car.yaw - start.yaw} rad`);
});
