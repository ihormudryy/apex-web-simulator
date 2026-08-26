// js/race/aiDriver.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DIFFICULTY, DIFFICULTY_ORDER, createAiState, driveAi } from './aiDriver.js';
import { buildRacingLine } from './racingLine.js';
import { buildCenterline } from '../track/centerline.js';
import { SILVERSTONE_WAYPOINTS } from '../track/silverstoneWaypoints.js';
import { MU } from '../physics/constants.js';
import { maxSteerAt } from '../physics/driver.js';
import {
  createVehicle, setPose, advance, updateSteering, forwardSpeed,
} from '../physics/vehicle.js';
import { surfaceHeight, surfaceRoughness, verticalCurvature } from '../track/elevation.js';

const DT = 1 / 60;

/** The circuit as the physics sees it, with its own query cursor. */
function circuit() {
  const centerline = buildCenterline(SILVERSTONE_WAYPOINTS, 4000);
  let hint = 0, wheelHint = 0;
  return {
    centerline,
    query(x, z) { const r = centerline.query(x, z, hint); hint = r.index; return r; },
    queryWheel(x, z, out) {
      const q = centerline.query(x, z, wheelHint);
      wheelHint = q.index;
      out.surface = q.surface;
      out.mu = MU[q.surface] ?? MU.grass;
      out.height = surfaceHeight(q, centerline.length);
      out.roughness = surfaceRoughness(q);
      out.curvature = verticalCurvature(q.t, centerline.length);
      out.nx = 0; out.nz = 0;
      return out;
    },
  };
}

function runLaps(levelId, seconds) {
  const track = circuit();
  const line = buildRacingLine(track.centerline.samples);
  const s = track.centerline.samples[0];
  const car = createVehicle({ warm: true });
  setPose(car, s.x, s.z, Math.atan2(-s.tx, -s.tz), track);
  const ai = createAiState(levelId);
  const input = { forward: false, reverse: false, left: false, right: false, brake: false };
  let offRoad = 0, laps = 0, prevT = 0, lapStart = 0, topSpeed = 0;
  const lapTimes = [];
  const frames = Math.round(seconds / DT);
  for (let f = 0; f < frames; f++) {
    driveAi(ai, car, line, input);
    updateSteering(car, input, DT);
    advance(car, input, track, DT);
    topSpeed = Math.max(topSpeed, forwardSpeed(car));
    const q = track.query(car.x, car.z);
    if (Math.abs(q.lateral) > q.halfWidth + 1) offRoad++;
    if (q.t < prevT - 0.5 && f * DT - lapStart > 20) {
      laps++; lapTimes.push(f * DT - lapStart); lapStart = f * DT;
    }
    prevT = q.t;
  }
  return { offRoad, frames, laps, lapTimes, resets: car.resets, topSpeed };
}

test('every difficulty completes a lap without leaving the road', () => {
  for (const id of DIFFICULTY_ORDER) {
    const r = runLaps(id, 320);
    assert.equal(r.resets, 0, `${id}: physics went non-finite`);
    assert.ok(r.laps >= 1, `${id}: completed no laps in 320 s`);
    assert.ok(r.offRoad / r.frames < 0.02,
      `${id}: off the road for ${(100 * r.offRoad / r.frames).toFixed(1)}% of the run`);
  }
});

/**
 * `runLaps` above drives with `rival = null`, which is exactly the blind spot
 * that let a stable-looking `ace` ship with an absorbing off-road state: the
 * defend/avoid aim-point nudge only engages with a rival present, and a
 * follower sitting a car-width to one side with a close, breathing gap (3-9 m,
 * the commonest race position) is enough to walk `ace` past its instability
 * cliff — see aiDriver.js's `defendBudget`. Same bound as the rival-less test.
 */
function runLapsWithRival(levelId, seconds) {
  const track = circuit();
  const line = buildRacingLine(track.centerline.samples);
  const s = track.centerline.samples[0];
  const car = createVehicle({ warm: true });
  setPose(car, s.x, s.z, Math.atan2(-s.tx, -s.tz), track);
  const ai = createAiState(levelId);
  const input = { forward: false, reverse: false, left: false, right: false, brake: false };
  // A follower one car-width to the side whose gap breathes between 3 and
  // 9 m over ~17 s — never a constant, knife-edge bias, but the commonest
  // race position. This exact period/side is one of the reviewer's worst
  // measured configurations for `ace` (85.5% of the run off-road).
  const rival = { x: 0, z: 0, lateralGap: -1.5, aheadGap: -6 };
  const period = 17;
  let offRoad = 0;
  const frames = Math.round(seconds / DT);
  for (let f = 0; f < frames; f++) {
    rival.x = car.x;
    rival.z = car.z;
    rival.aheadGap = -(6 + 3 * Math.sin((2 * Math.PI * (f * DT)) / period));
    driveAi(ai, car, line, input, rival);
    updateSteering(car, input, DT);
    advance(car, input, track, DT);
    const q = track.query(car.x, car.z);
    if (Math.abs(q.lateral) > q.halfWidth + 1) offRoad++;
  }
  return { offRoad, frames, resets: car.resets };
}

test('every difficulty completes a lap without leaving the road, with a rival present', () => {
  for (const id of DIFFICULTY_ORDER) {
    const r = runLapsWithRival(id, 200);
    assert.equal(r.resets, 0, `${id}: physics went non-finite with a rival present`);
    assert.ok(r.offRoad / r.frames < 0.02,
      `${id}: off the road for ${(100 * r.offRoad / r.frames).toFixed(1)}% of the run `
      + 'with a rival present');
  }
});

test('each difficulty gets close to its own top speed on this circuit', () => {
  // The bug this guards against had two layers, both in the speed planner:
  // first, rescaling `level.topSpeed` itself by a cornering ratio (fixed);
  // then, deriving corner speed from `line.speed`, which bakes in the racing
  // line's OWN 92 m/s constant on every straight and got the same cornering
  // ratio applied to it — a second instance of the same category error one
  // level down (also fixed: the planner now derives corner speed from
  // `line.curvature` and this level's own `latG`/`topSpeed`, never touching
  // `line.speed`). Both were invisible to the other tests here, because all
  // three levels still scaled down together and kept their relative order.
  //
  // Thresholds are set below the measured fraction of `topSpeed` reached
  // AFTER both fixes (club 100.1%, pro 94.7%, ace 88.2% — see the
  // DIFFICULTY doc comment in aiDriver.js), not below the bug's own output:
  // the round-1 thresholds were picked with margin under an 88% for `ace`
  // that was itself still suppressed by the second bug, so they would have
  // passed even a partial regression back toward it. These were checked
  // against a genuinely correct measurement instead — raising `topSpeed`
  // far past 92 for `pro` and `ace` left the speed each one actually reached
  // unchanged, confirming neither is bottlenecked by any leftover scaling
  // defect; the ~10-12 percentage-point gap from 100% is Silverstone's
  // straight length and the car's own acceleration curve, not tunable away.
  const minFraction = { club: 0.95, pro: 0.90, ace: 0.85 };
  for (const id of DIFFICULTY_ORDER) {
    const r = runLaps(id, 420);
    const fraction = r.topSpeed / DIFFICULTY[id].topSpeed;
    assert.ok(fraction >= minFraction[id],
      `${id}: reached only ${r.topSpeed.toFixed(1)} m/s, `
      + `${(100 * fraction).toFixed(0)}% of its ${DIFFICULTY[id].topSpeed} m/s cap`);
  }
});

test('a harder level is a faster level', () => {
  const times = DIFFICULTY_ORDER.map(id => Math.min(...runLaps(id, 420).lapTimes));
  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i] < times[i - 1],
      `${DIFFICULTY_ORDER[i]} (${times[i].toFixed(1)} s) is not faster than `
      + `${DIFFICULTY_ORDER[i - 1]} (${times[i - 1].toFixed(1)} s)`);
  }
});

test('the driver never asks for more lock than it has at this speed', () => {
  const track = circuit();
  const line = buildRacingLine(track.centerline.samples);
  const s = track.centerline.samples[0];
  const car = createVehicle({ warm: true });
  setPose(car, s.x, s.z, Math.atan2(-s.tx, -s.tz), track);
  const ai = createAiState('ace');
  const input = { forward: false, reverse: false, left: false, right: false, brake: false };
  for (let f = 0; f < 6000; f++) {
    driveAi(ai, car, line, input);
    updateSteering(car, input, DT);
    advance(car, input, track, DT);
    const lock = maxSteerAt(Math.abs(forwardSpeed(car)));
    assert.ok(Math.abs(car.steerAngle) <= lock + 1e-9,
      `steer ${car.steerAngle} exceeds lock ${lock} at ${forwardSpeed(car).toFixed(1)} m/s`);
  }
});

test('the racing line is quicker than the centerline for the same driver', () => {
  // The point of generating a line at all. If this fails, the relaxation is
  // producing something smooth but slow and the AI may as well use the middle
  // of the road.
  const track = circuit();
  const line = buildRacingLine(track.centerline.samples);
  const flat = buildRacingLine(track.centerline.samples, { iterations: 0 });
  const best = (l) => {
    const t = circuit();
    const s = t.centerline.samples[0];
    const car = createVehicle({ warm: true });
    setPose(car, s.x, s.z, Math.atan2(-s.tx, -s.tz), t);
    const ai = createAiState('pro');
    const input = { forward: false, reverse: false, left: false, right: false, brake: false };
    let prevT = 0, lapStart = 0;
    const times = [];
    for (let f = 0; f < Math.round(420 / DT); f++) {
      driveAi(ai, car, l, input);
      updateSteering(car, input, DT);
      advance(car, input, t, DT);
      const q = t.query(car.x, car.z);
      if (q.t < prevT - 0.5 && f * DT - lapStart > 20) {
        times.push(f * DT - lapStart); lapStart = f * DT;
      }
      prevT = q.t;
    }
    return times.length ? Math.min(...times) : Infinity;
  };
  const onLine = best(line);
  const onFlat = best(flat);
  assert.ok(onLine < onFlat,
    `racing line ${onLine.toFixed(1)} s is not quicker than centerline ${onFlat.toFixed(1)} s`);
});

test('a rival alongside is not steered into', () => {
  const track = circuit();
  const line = buildRacingLine(track.centerline.samples);
  const s = track.centerline.samples[600];
  const car = createVehicle({ warm: true });
  setPose(car, s.x, s.z, Math.atan2(-s.tx, -s.tz), track);
  const ai = createAiState('pro');
  const input = { forward: false, reverse: false, left: false, right: false, brake: false };
  // A rival exactly alongside, 2 m to the AI's right.
  const alongside = { x: s.x + s.nx * 2, z: s.z + s.nz * 2, lateralGap: 2, aheadGap: 0 };
  for (let f = 0; f < 240; f++) {
    driveAi(ai, car, line, input, alongside);
    updateSteering(car, input, DT);
    advance(car, input, track, DT);
    const dist = Math.hypot(car.x - alongside.x, car.z - alongside.z);
    assert.ok(dist > 1.4, `closed to ${dist.toFixed(2)} m on a car alongside`);
  }
});
