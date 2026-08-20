import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createVehicle, setPose, advance, forwardSpeed, launchVehicle, telemetryOf,
  replayStep,
} from './vehicle.js';
import { createRecording, replay } from './replay.js';
import * as ST from './state.js';

const DT = 1 / 60;
const keys = over => ({
  forward: false, reverse: false, left: false, right: false, brake: false, ...over,
});

/** A corridor in the real centreline convention: lateral = -(x), normal +x. */
const corridor = limit => ({
  query: x => ({
    surface: 'tarmac', lateral: -x, wallLimit: limit,
    normal: { x: 1, z: 0 }, halfWidth: limit, t: 0, index: 0,
  }),
});

/** Drive the car sideways into the wall at a given closing speed. */
function crash(closingMs, { headOn = false } = {}) {
  const track = corridor(8);
  const car = createVehicle({});
  // Facing -Z; the wall is at +x. Head-on: face +x (yaw -90deg).
  //
  // The sideways case starts almost touching the wall. Warm slicks kill a
  // sideways drift at ~2 g, so a car started mid-track arrives at the wall having
  // already stopped sliding — the first version of this fixture tested that the
  // tyres work, not that the wall does.
  setPose(car, headOn ? 0 : 8 - 1.1, 0, headOn ? -Math.PI / 2 : 0, track);
  const S = car.car.S;
  if (headOn) {
    launchVehicle(car, closingMs);
  } else {
    S[ST.S_VX] = closingMs;   // pure sideways drift into the wall
  }
  for (let f = 0; f < 60 * 4; f++) advance(car, keys(), track, DT);
  return car;
}

test('a light brush costs nothing', () => {
  const car = crash(1.2);
  assert.equal(telemetryOf(car).damage.total, 0);
});

test('a medium hit damages the car and it still drives', () => {
  const car = crash(9);
  const d = telemetryOf(car).damage;
  assert.ok(d.total > 0.02, `a 32 km/h wall hit left ${d.total.toFixed(3)}`);
  assert.equal(d.terminal, false, 'but it is not over');
  // It must still accelerate.
  const before = forwardSpeed(car);
  for (let f = 0; f < 60 * 2; f++) advance(car, keys({ forward: true }), corridor(8), DT);
  assert.ok(forwardSpeed(car) > before + 5, 'the damaged car must still pull away');
});

test('a heavy head-on is terminal, and a terminal car cannot continue', () => {
  const car = crash(26, { headOn: true });
  const d = telemetryOf(car).damage;
  assert.ok(d.terminal, `a ~94 km/h head-on read ${JSON.stringify(d)}`);
  // The engine is cut: full throttle must not accelerate it.
  const track = corridor(8);
  setPose(car, -4, 0, 0, track);      // point it down the corridor, clear of the wall
  const v0 = forwardSpeed(car);
  for (let f = 0; f < 60 * 3; f++) advance(car, keys({ forward: true }), track, DT);
  assert.ok(
    forwardSpeed(car) < v0 + 1,
    `a terminal car accelerated from ${v0.toFixed(1)} to ${forwardSpeed(car).toFixed(1)} m/s`,
  );
});

test('damage accumulates across separate hits until the car is finished', () => {
  const track = corridor(8);
  const car = createVehicle({});
  setPose(car, 0, 0, 0, track);
  const S = car.car.S;
  let hits = 0;
  while (!telemetryOf(car).damage.terminal && hits < 40) {
    S[ST.S_X] = 6.5;
    S[ST.S_VX] = 12;
    S[ST.S_VZ] = 0;
    S[ST.S_AV] = 0;
    for (let f = 0; f < 30; f++) advance(car, keys(), track, DT);
    hits++;
  }
  assert.ok(hits > 2, `terminal after only ${hits} hits at 43 km/h — too fragile`);
  assert.ok(hits < 40, 'never became terminal — damage does not accumulate');
});

test('a damaged front corner makes the car pull', () => {
  const track = corridor(500);
  const car = createVehicle({});
  setPose(car, 0, 0, 0, track);
  car.car.S[ST.S_DMG_WHEEL] = 0.6;       // bent front-left
  launchVehicle(car, 40);
  for (let f = 0; f < 60 * 2; f++) advance(car, keys({ forward: true }), track, DT);
  assert.ok(
    Math.abs(car.car.S[ST.S_AV]) > 0.02,
    `a bent corner should pull, yaw rate ${car.car.S[ST.S_AV]}`,
  );
});

test('a broken wing costs front downforce, felt as less front grip', () => {
  const track = corridor(500);
  const grip = wingDmg => {
    const car = createVehicle({});
    setPose(car, 0, 0, 0, track);
    car.car.S[ST.S_DMG_WING] = wingDmg;
    launchVehicle(car, 60);
    for (let f = 0; f < 60 * 2; f++) advance(car, keys({ forward: true }), track, DT);
    return telemetryOf(car).downforce;
  };
  const healthy = grip(0);
  const broken = grip(1);
  assert.ok(broken < healthy * 0.97, `downforce ${healthy.toFixed(0)} -> ${broken.toFixed(0)} N`);
});

test('a replayed crash is still a crash — damage is state, not a side effect', () => {
  const track = corridor(8);
  const drive = createVehicle({});
  setPose(drive, 8 - 1.1, 0, 0, track);
  drive.recorder = createRecording(8192);
  drive.car.S[ST.S_VX] = 10;
  for (let f = 0; f < 60 * 3; f++) advance(drive, keys(), track, DT);
  const damaged = telemetryOf(drive).damage.total;
  assert.ok(damaged > 0, 'the recorded run must actually crash');

  const ghost = createVehicle({});
  setPose(ghost, 8 - 1.1, 0, 0, track);
  ghost.car.S[ST.S_VX] = 10;
  replay(drive.recorder, input => replayStep(ghost, input, track));
  assert.equal(
    telemetryOf(ghost).damage.total, damaged,
    'the replay must reproduce the damage bit-exactly',
  );
});
