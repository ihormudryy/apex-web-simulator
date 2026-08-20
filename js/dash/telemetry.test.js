// js/dash/telemetry.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTelemetry, formatLapTime, formatDelta, formatSector,
} from './telemetry.js';
import {
  createVehicle, launchVehicle, advance, forwardSpeed,
} from '../physics/vehicle.js';
import { MU } from '../physics/constants.js';

const LAP = 5891;
const DT = 1 / 60;

/** A car parked at a chosen lap fraction, with whatever state a test needs. */
function fakeCar(over = {}) {
  const car = {
    vehicle: Object.assign(createVehicle(), over.vehicle),
    input: Object.assign(
      { forward: false, reverse: false, left: false, right: false, brake: false },
      over.input),
  };
  return car;
}

/** A track whose lap fraction the test drives directly. */
function fakeTrack(surface = 'tarmac') {
  return {
    t: 0,
    surface,
    lateral: 0,
    query() {
      return {
        t: this.t, surface: this.surface, lateral: this.lateral,
        halfWidth: 8, wallLimit: 24, index: Math.round(this.t * 4000),
        tangent: { x: 0, z: 1 }, normal: { x: 1, z: 0 },
      };
    },
  };
}

/** Run `laps` laps at a fixed pace, optionally varying the pace per lap. */
function driveLaps(telemetry, car, track, laps, secondsPerLap) {
  let last = null;
  for (let lap = 0; lap < laps; lap++) {
    const seconds = typeof secondsPerLap === 'function' ? secondsPerLap(lap) : secondsPerLap;
    const frames = Math.round(seconds / DT);
    for (let f = 0; f < frames; f++) {
      track.t = (f + 1) / frames;          // one lap's worth of progress
      if (track.t >= 1) track.t -= 1;      // wrap at the line
      last = telemetry.sample(car, track, DT);
    }
  }
  return last;
}

test('a lap is counted when the lap fraction wraps', () => {
  const telemetry = createTelemetry({ lapLength: LAP });
  const snapshot = driveLaps(telemetry, fakeCar(), fakeTrack(), 2, 100);
  assert.equal(snapshot.lapCount, 2, 'two laps should have been counted');
  assert.ok(Math.abs(snapshot.lastLapTime - 100) < 0.5,
    `last lap read ${snapshot.lastLapTime}`);
});

test('jitter over the line does not count as a lap', () => {
  const telemetry = createTelemetry({ lapLength: LAP, minLapTime: 20 });
  const car = fakeCar();
  const track = fakeTrack();
  // Rock back and forth across the timing line for a few seconds.
  for (let f = 0; f < 300; f++) {
    track.t = f % 2 === 0 ? 0.999 : 0.001;
    telemetry.sample(car, track, DT);
  }
  const snapshot = telemetry.sample(car, track, DT);
  assert.equal(snapshot.lapCount, 0, 'crossing the line back and forth is not a lap');
});

test('the best lap is the quickest one, not the last one', () => {
  const telemetry = createTelemetry({ lapLength: LAP });
  // 100 s, then 90 s, then 110 s.
  const snapshot = driveLaps(telemetry, fakeCar(), fakeTrack(), 3,
    lap => [100, 90, 110][lap]);
  assert.ok(Math.abs(snapshot.bestLapTime - 90) < 0.5, `best read ${snapshot.bestLapTime}`);
  assert.ok(Math.abs(snapshot.lastLapTime - 110) < 0.5, `last read ${snapshot.lastLapTime}`);
});

test('delta compares against the best lap at the same point on the track', () => {
  const telemetry = createTelemetry({ lapLength: LAP });
  const car = fakeCar();
  const track = fakeTrack();

  driveLaps(telemetry, car, track, 1, 100);          // sets the reference
  // Halfway round a 120 s lap the car is 20% of a lap's time down on a 100 s lap.
  let snapshot = null;
  const frames = Math.round(120 / DT);
  for (let f = 0; f < frames / 2; f++) {
    track.t = (f + 1) / frames;
    snapshot = telemetry.sample(car, track, DT);
  }
  assert.ok(snapshot.delta !== null, 'no delta after a reference lap');
  // At half distance: 60 s elapsed against the reference's 50 s.
  assert.ok(Math.abs(snapshot.delta - 10) < 1.5,
    `delta at half distance read ${snapshot.delta.toFixed(2)} s, expected about +10`);
});

test('there is no delta until a lap has been completed', () => {
  const telemetry = createTelemetry({ lapLength: LAP });
  const car = fakeCar();
  const track = fakeTrack();
  track.t = 0.4;
  const snapshot = telemetry.sample(car, track, DT);
  assert.equal(snapshot.delta, null);
  assert.equal(snapshot.bestLapTime, null);
});

test('reversing back over the trace does not rewrite the reference', () => {
  const telemetry = createTelemetry({ lapLength: LAP, deltaBuckets: 100 });
  const car = fakeCar();
  const track = fakeTrack();
  driveLaps(telemetry, car, track, 1, 100);
  const reference = telemetry.state.bestTrace.slice();

  // Drive forward, then back, then forward again over the same stretch.
  for (const t of [0.1, 0.2, 0.3, 0.2, 0.1, 0.2, 0.3, 0.4]) {
    track.t = t;
    telemetry.sample(car, track, DT);
  }
  assert.deepEqual(Array.from(telemetry.state.bestTrace), Array.from(reference),
    'the stored best-lap trace must not change while driving another lap');
  const bucket30 = telemetry.state.trace[30];
  const bucket40 = telemetry.state.trace[40];
  assert.ok(Number.isFinite(bucket30) && Number.isFinite(bucket40));
  assert.ok(bucket40 > bucket30, 'the current trace should still increase with distance');
});

test('sector splits add up to the lap time', () => {
  const telemetry = createTelemetry({ lapLength: LAP, sectors: 3 });
  const snapshot = driveLaps(telemetry, fakeCar(), fakeTrack(), 2, 90);
  const splits = snapshot.bestSectorTimes;
  assert.ok(splits.every(s => Number.isFinite(s)), `incomplete splits ${splits}`);
  const total = splits.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - snapshot.bestLapTime) < 0.5,
    `splits total ${total.toFixed(2)} against a ${snapshot.bestLapTime.toFixed(2)} lap`);
});

/** A car that has actually been driven, so the kernel's loads and aero are live. */
function drivenCar(speedMs, track) {
  const car = fakeCar();
  launchVehicle(car.vehicle, speedMs);
  for (let i = 0; i < 240; i++) {
    // Hold the speed rather than accelerating away from it.
    const forward = forwardSpeed(car.vehicle) < speedMs;
    advance(car.vehicle, { forward, left: false, right: false, brake: false }, track, DT);
  }
  return car;
}

test('the grip limit grows with downforce', () => {
  const telemetry = createTelemetry({ lapLength: LAP });
  const track = fakeTrack();
  // Driven rather than hand-posed: the grip limit now comes from the kernel's own
  // per-corner loads, so it only means anything once the car has been stepped and
  // the aero has loaded it.
  const slow = telemetry.sample(drivenCar(10, track), track, DT);
  const fast = telemetry.sample(drivenCar(80, track), track, DT);
  // Bounded against MU rather than a literal: at walking pace the grip limit is
  // essentially the friction coefficient. It lands a little above it, because the
  // rear tyres are the wider ones — the four-corner average of the axle scales is
  // 1.075, and that is a real property of the car rather than slack in the test.
  assert.ok(
    slow.gripLimitG > MU.tarmac * 0.95 && slow.gripLimitG < MU.tarmac * 1.2,
    `at 10 m/s the limit should be near mu (${MU.tarmac}), got ${slow.gripLimitG}`,
  );
  assert.ok(fast.gripLimitG > 4, `at 80 m/s the tyres should carry over 4 g, got ${fast.gripLimitG}`);
});

test('grass reports less grip than tarmac at the same speed', () => {
  const telemetry = createTelemetry({ lapLength: LAP });
  const tarmacTrack = fakeTrack('tarmac');
  const grassTrack = fakeTrack('grass');
  const onTarmac = telemetry.sample(drivenCar(30, tarmacTrack), tarmacTrack, DT);
  const onGrass = telemetry.sample(drivenCar(30, grassTrack), grassTrack, DT);
  assert.ok(onGrass.gripLimitG < onTarmac.gripLimitG / 3);
  assert.equal(onGrass.offTrack, true);
  assert.equal(onTarmac.offTrack, false);
});

test('a left turn reads as negative lateral g, a right turn positive', () => {
  const telemetry = createTelemetry({ lapLength: LAP });
  const track = fakeTrack();
  const left = telemetry.sample(fakeCar({ vehicle: { vz: -40, av: 0.5 } }), track, DT);
  const right = telemetry.sample(fakeCar({ vehicle: { vz: -40, av: -0.5 } }), track, DT);
  assert.ok(left.latG < -1, `left turn read ${left.latG}`);
  assert.ok(right.latG > 1, `right turn read ${right.latG}`);
});

test('a parked car produces no NaNs and no sideslip', () => {
  const telemetry = createTelemetry({ lapLength: LAP });
  const snapshot = telemetry.sample(fakeCar(), fakeTrack(), DT);
  for (const [key, value] of Object.entries(snapshot)) {
    if (typeof value === 'number') {
      assert.ok(Number.isFinite(value), `${key} is ${value}`);
    }
  }
  assert.equal(snapshot.slipDeg, 0);
  assert.equal(snapshot.speedKmh, 0);
  assert.equal(snapshot.gear, 1);
});

test('reverse shows an R rather than first gear', () => {
  const telemetry = createTelemetry({ lapLength: LAP });
  const snapshot = telemetry.sample(
    fakeCar({ vehicle: { vz: 4 }, input: { reverse: true } }), fakeTrack(), DT);
  assert.equal(snapshot.gear, 'R');
  assert.equal(snapshot.reversing, true);
});

test('steering reads +1 to the right and -1 to the left', () => {
  // Posed as `steerSmooth` — the fraction of the lock available at this speed —
  // because that is what the readout now reports. Dividing the road-wheel ANGLE by
  // the lock at rest meant a display that could not pass 0.4 at 150 km/h however
  // hard the wheel was turned, once the lock curve stopped being a straight line.
  const telemetry = createTelemetry({ lapLength: LAP });
  const track = fakeTrack();
  const left = telemetry.sample(fakeCar({ vehicle: { steerSmooth: -1 } }), track, DT);
  const right = telemetry.sample(fakeCar({ vehicle: { steerSmooth: 1 } }), track, DT);
  const centre = telemetry.sample(fakeCar({ vehicle: { steerSmooth: 0 } }), track, DT);
  assert.ok(Math.abs(left.steer + 1) < 1e-9, `left read ${left.steer}`);
  assert.ok(Math.abs(right.steer - 1) < 1e-9, `right read ${right.steer}`);
  assert.ok(Math.abs(centre.steer) < 1e-9, `centre read ${centre.steer}`);
});

test('peak g holds above the instantaneous value, then bleeds away', () => {
  const telemetry = createTelemetry({ lapLength: LAP });
  const track = fakeTrack();
  telemetry.sample(fakeCar({ vehicle: { vz: -40, av: 0.6 } }), track, DT);
  const held = telemetry.state.peakG;
  assert.ok(held > 2, `peak did not register, ${held}`);
  const parked = fakeCar();
  for (let f = 0; f < 60; f++) telemetry.sample(parked, track, DT);
  assert.ok(telemetry.state.peakG < held, 'peak should decay');
  assert.ok(telemetry.state.peakG > 0, 'peak should decay gradually, not snap to zero');
});

test('times format the way a timing screen shows them', () => {
  assert.equal(formatLapTime(101.234), '1:41.234');
  assert.equal(formatLapTime(59.5), '0:59.500');
  assert.equal(formatLapTime(60), '1:00.000');
  assert.equal(formatLapTime(null), '--:--.---');
  assert.equal(formatDelta(0.421), '+0.421');
  assert.equal(formatDelta(-0.312), '-0.312');
  assert.equal(formatDelta(0), '+0.000');
  assert.equal(formatDelta(null), '--.---');
  assert.equal(formatSector(28.4), '28.400');
  assert.equal(formatSector(null), '--.---');
});

test('the delta moves smoothly instead of stepping between buckets', () => {
  const telemetry = createTelemetry({ lapLength: LAP });
  const car = fakeCar();
  const track = fakeTrack();
  driveLaps(telemetry, car, track, 1, 100);      // reference lap

  // Second lap at the same pace: the delta should hover near zero and never jump.
  const frames = Math.round(100 / DT);
  let previous = null, previousLap = null, worstJump = 0, worstDelta = 0;
  for (let f = 0; f < frames; f++) {
    track.t = (f + 1) / frames;
    if (track.t >= 1) track.t -= 1;
    const snapshot = telemetry.sample(car, track, DT);
    if (snapshot.delta === null) continue;
    worstDelta = Math.max(worstDelta, Math.abs(snapshot.delta));
    // Crossing the line legitimately resets the delta; that is not a jump.
    if (previous !== null && snapshot.lapCount === previousLap) {
      worstJump = Math.max(worstJump, Math.abs(snapshot.delta - previous));
    }
    previous = snapshot.delta;
    previousLap = snapshot.lapCount;
  }
  // Reading the raw bucket made this sawtooth by up to a bucket's worth of time.
  assert.ok(worstJump < 0.05, `delta jumped by ${worstJump.toFixed(3)} s in one frame`);
  assert.ok(worstDelta < 0.5, `delta drifted to ${worstDelta.toFixed(3)} s at identical pace`);
});

test('a slower lap reports a positive delta that grows with distance', () => {
  const telemetry = createTelemetry({ lapLength: LAP });
  const car = fakeCar();
  const track = fakeTrack();
  driveLaps(telemetry, car, track, 1, 100);

  const frames = Math.round(110 / DT);       // 10% slower
  const atQuarter = [];
  const atNinety = [];
  for (let f = 0; f < frames; f++) {
    track.t = (f + 1) / frames;
    if (track.t >= 1) track.t -= 1;
    const snapshot = telemetry.sample(car, track, DT);
    if (snapshot.delta === null) continue;
    if (Math.abs(snapshot.lapFraction - 0.25) < 0.002) atQuarter.push(snapshot.delta);
    if (Math.abs(snapshot.lapFraction - 0.90) < 0.002) atNinety.push(snapshot.delta);
  }
  assert.ok(atQuarter.length && atNinety.length, 'never sampled the reference points');
  const quarter = atQuarter[0], ninety = atNinety[0];
  // A lap 10 s slower overall is 2.5 s down at a quarter distance and 9 s at 90%.
  assert.ok(Math.abs(quarter - 2.5) < 0.6, `quarter distance read ${quarter.toFixed(2)}`);
  assert.ok(Math.abs(ninety - 9) < 0.8, `ninety percent read ${ninety.toFixed(2)}`);
  assert.ok(ninety > quarter, 'the deficit should grow as the lap goes on');
});

test('crossing the line resets the delta rather than carrying a lap over', () => {
  const telemetry = createTelemetry({ lapLength: LAP });
  const car = fakeCar();
  const track = fakeTrack();
  driveLaps(telemetry, car, track, 2, 100);
  // Just after the line, the new lap has barely started and so has its deficit.
  track.t = 0.001;
  const snapshot = telemetry.sample(car, track, DT);
  assert.ok(Math.abs(snapshot.delta) < 1,
    `delta just after the line read ${snapshot.delta.toFixed(2)} s`);
});
