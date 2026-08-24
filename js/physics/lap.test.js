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
  telemetryOf,
} from './vehicle.js';
import { WB, MU } from './constants.js';
import { maxSteerAt } from './driver.js';
import {
  surfaceHeight, surfaceRoughness, verticalCurvature,
} from '../track/elevation.js';
import { buildCenterline } from '../track/centerline.js';
import { SILVERSTONE_WAYPOINTS } from '../track/silverstoneWaypoints.js';

const DT = 1 / 60;
/** A "lap" quicker than this is the start-line seam, not a lap. */
const MIN_LAP_TIME = 20;
const MAX_STEER = 18 * Math.PI / 180;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const wrap = a => {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
};

/**
 * The circuit as the physics sees it.
 *
 * `elevated` adds the three-dimensional surface — elevation, banking, the
 * drainage crown, bumps and kerb profiles — through the same `queryWheel` the
 * browser uses. A separate hint cursor from `query`, because the four wheels are
 * within two metres of each other and sharing one with the chassis query made
 * every wheel walk the ring from wherever the chassis last looked.
 */
function silverstone({ elevated = false } = {}) {
  const centerline = buildCenterline(SILVERSTONE_WAYPOINTS, 4000);
  let hint = 0;
  let wheelHint = 0;
  const track = {
    centerline,
    query(x, z) {
      const r = centerline.query(x, z, hint);
      hint = r.index;
      return r;
    },
  };
  if (elevated) {
    track.queryWheel = (x, z, out) => {
      const q = centerline.query(x, z, wheelHint);
      wheelHint = q.index;
      out.surface = q.surface;
      out.mu = MU[q.surface] ?? MU.grass;
      out.height = surfaceHeight(q, centerline.length);
      out.roughness = surfaceRoughness(q);
      out.curvature = verticalCurvature(q.t, centerline.length);
      out.nx = 0;
      out.nz = 0;
      return out;
    };
  }
  return track;
}

function spawnedCar(track) {
  const s = track.centerline.samples[0];
  const car = createVehicle();
  setPose(car, s.x, s.z, Math.atan2(-s.tx, -s.tz), track);
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
function makeDriver({ latG = 1.4, topSpeed = 45, brakeG = 1.8 } = {}) {
  return function drive(car, input, track) {
    const { samples, spacing } = track.centerline;
    const n = samples.length;
    const here = track.query(car.x, car.z);
    const v = Math.max(forwardSpeed(car), 1);
    const step = Math.max(1, Math.round(6 / spacing));

    // Slowest speed any curvature between here and a braking distance ahead
    // allows. `brakeG` is the PLANNING deceleration, deliberately well under
    // what the car can pull in a straight line: braking continues into the
    // corner entry where the friction circle is already spending grip on
    // turning, and planning at the car's peak 3 g meant arriving at the
    // surveyed Village/Loop hairpins 80 km/h too fast, every lap.
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
    //
    // Normalised by the lock available AT THIS SPEED, not the lock at rest.
    // `steerSmooth` is a fraction of the current lock, so dividing by the rest
    // value asked for a road-wheel angle 2.5x smaller than intended at 150 km/h
    // and the autopilot quietly ran wide. It was always wrong; narrowing the lock
    // curve is what made it visible.
    const want = clamp(-steer / maxSteerAt(v), -1, 1);
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

function runLaps(seconds, options = {}) {
  const track = silverstone({ elevated: options.elevated });
  const car = spawnedCar(track);
  const input = noInput();
  const drive = makeDriver(options);
  const stats = {
    laps: 0, lapTimes: [], frames: 0, offRoad: 0, wallFrames: 0,
    worstLateral: 0, worstSlip: 0, topSpeed: 0,
    surfaces: { tarmac: 0, kerb: 0, grass: 0 },
    minRide: Infinity, maxRide: -Infinity, plankFrames: 0, bumpStopFrames: 0,
    minLoad: Infinity, maxLoad: 0, minGround: Infinity, maxGround: -Infinity,
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
    const sim = telemetryOf(car);
    stats.minRide = Math.min(stats.minRide, sim.rideFront);
    stats.maxRide = Math.max(stats.maxRide, sim.rideFront);
    stats.minGround = Math.min(stats.minGround, sim.groundHeight);
    stats.maxGround = Math.max(stats.maxGround, sim.groundHeight);
    if (sim.plankContact) stats.plankFrames++;
    if (sim.onBumpStop) stats.bumpStopFrames++;
    const totalLoad = sim.fz[0] + sim.fz[1] + sim.fz[2] + sim.fz[3];
    stats.minLoad = Math.min(stats.minLoad, totalLoad);
    stats.maxLoad = Math.max(stats.maxLoad, totalLoad);
    if (Math.abs(q.lateral) > q.halfWidth + 1) stats.offRoad++;
    if (Math.abs(q.lateral) > q.wallLimit) stats.wallFrames++;
    // Same guard the dashboard uses (`minLapTime`, telemetry.js): `t` is a ring
    // coordinate, so a car sitting on the start line reads 0.9999 one step and
    // 0.0001 the next. Without the guard that seam counts as a completed lap.
    if (q.t < prevT - 0.5 && f * DT - lapStart > MIN_LAP_TIME) {
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
  // Point it at the outside wall and pin the throttle. Through setPose — writing
  // `car.yaw` directly has been dead since the kernel rewrite (it is a mirrored
  // field), so this test spent months testing a crash at the first corner
  // instead of the head-on it describes.
  setPose(car, car.x, car.z, Math.atan2(-start.normal.x, -start.normal.z), track);
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
  // And a head-on at speed is not free any more.
  const sim = telemetryOf(car);
  assert.ok(sim.damage.total > 0.1, `a pinned head-on left only ${sim.damage.total.toFixed(2)} damage`);
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

// ---------------------------------------------------------------------------
// The same circuit, in three dimensions
// ---------------------------------------------------------------------------

test('the elevated circuit can be lapped, and the car stays on the road', () => {
  // Longer than the flat lap needs: elevation, bumps and the crown cost real time,
  // which is the point of having them.
  const stats = runLaps(170, { elevated: true });
  assert.equal(stats.resets, 0, `${stats.resets} physics resets on the 3D surface`);
  assert.ok(stats.laps >= 1, `only ${stats.laps} laps in 120 s`);
  assert.ok(
    stats.offRoad / stats.frames < 0.06,
    `off the road for ${(100 * stats.offRoad / stats.frames).toFixed(1)}% of the lap`,
  );
});

test('driving the 3D surface keeps the platform inside its working range', () => {
  const stats = runLaps(120, { elevated: true });
  // Ride height must move — a flat ribbon would hold it constant — but the car
  // must not be launched into the air by its own circuit.
  assert.ok(stats.maxRide - stats.minRide > 0.004, 'the surface must reach the car at all');
  assert.ok(
    stats.maxRide < 0.17,
    `the car reached ${(stats.maxRide * 1000).toFixed(0)} mm of ride height — it is flying`,
  );
  assert.ok(stats.minLoad > 500, `the car went nearly airborne: ${stats.minLoad.toFixed(0)} N`);
});

test('the elevation is actually under the car', () => {
  const stats = runLaps(120, { elevated: true });
  assert.ok(
    stats.maxGround - stats.minGround > 4,
    `only ${(stats.maxGround - stats.minGround).toFixed(1)} m of elevation seen in a lap`,
  );
});

test('the flat and elevated circuits give lap times within a few percent', () => {
  // Elevation, bumps and a drainage crown should cost a little time, not change
  // the car into something else. A big divergence means the surface is fighting
  // the suspension rather than being driven over.
  // 200 s: a lap is ~131 s flat out, and the planner's early braking for the
  // surveyed hairpins puts a cautious lap in the 150s — 150 s of sim time
  // stopped covering a full lap.
  const flat = runLaps(200, {});
  const bumpy = runLaps(200, { elevated: true });
  assert.ok(flat.laps >= 1 && bumpy.laps >= 1, 'both must complete a lap');
  const a = Math.min(...flat.lapTimes);
  const b = Math.min(...bumpy.lapTimes);
  assert.ok(
    b > a * 0.9 && b < a * 1.25,
    `flat ${a.toFixed(1)} s against elevated ${b.toFixed(1)} s`,
  );
});
