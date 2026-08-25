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

test('each difficulty gets close to its own top speed on this circuit', () => {
  // The bug this guards against: an earlier version rescaled `level.topSpeed`
  // itself by the cornering ratio instead of only the curvature-derived term,
  // so a level's straight-line cap was silently clipped down too. That was
  // invisible to the other tests here, because all three levels still scaled
  // down together and kept their relative order. Thresholds are set below
  // the measured post-fix fraction of `topSpeed` reached on Silverstone's
  // straights (club 100%, pro 95%, ace 88% — see the DIFFICULTY doc comment
  // in aiDriver.js for the full measurement and why `ace` alone tops out
  // under 90%: its `topSpeed` sits above the corner-scaled ceiling the
  // planner's own nearest-station lookahead already imposes, a genuine
  // property of the circuit and the driver model, not a bug), with margin
  // for run-to-run noise but tight enough to catch the same class of
  // regression: the pre-fix numbers were club 79%, pro 88%.
  const minFraction = { club: 0.90, pro: 0.90, ace: 0.75 };
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
