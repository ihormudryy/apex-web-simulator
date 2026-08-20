import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRecording, recordStep, recordingLength, recordingWrapped, recordingAt,
  resetRecording, replay, packInput, unpackInput,
  serializeRecording, deserializeRecording,
  FLAG_FORWARD, FLAG_BRAKE, FLAG_DRS,
} from './replay.js';
import {
  createVehicle, advance, replayStep, updateSteering,
} from './vehicle.js';

const flat = {
  query: () => ({
    surface: 'tarmac', wallLimit: 1e9, lateral: 0,
    normal: { x: 1, z: 0 }, tangent: { x: 0, z: 1 },
    halfWidth: 100, index: 0, t: 0,
  }),
};
const keys = over => ({
  forward: false, reverse: false, left: false, right: false, brake: false, ...over,
});

test('packing and unpacking an input round-trips every flag', () => {
  const cases = [
    {}, { forward: true }, { brake: true }, { left: true, right: true },
    { forward: true, reverse: true, brake: true, left: true, right: true, drs: true },
  ];
  for (const c of cases) {
    const round = unpackInput(packInput(keys(c)));
    for (const k of ['forward', 'reverse', 'brake', 'left', 'right']) {
      assert.equal(round[k], Boolean(c[k]), `${k} in ${JSON.stringify(c)}`);
    }
    assert.equal(round.drs, Boolean(c.drs));
  }
});

test('the flags fit in a byte, which is what the ring stores', () => {
  const all = packInput({
    forward: 1, reverse: 1, brake: 1, left: 1, right: 1, drs: 1,
  });
  assert.ok(all <= 255, `packed flags ${all} do not fit a Uint8Array`);
  assert.ok((all & FLAG_FORWARD) && (all & FLAG_BRAKE) && (all & FLAG_DRS));
});

test('a recording reads back oldest-first', () => {
  const rec = createRecording(8);
  for (let i = 0; i < 5; i++) recordStep(rec, i, i * 0.01);
  assert.equal(recordingLength(rec), 5);
  assert.equal(recordingWrapped(rec), false);
  for (let k = 0; k < 5; k++) {
    assert.ok(Math.abs(recordingAt(rec, k).steer - k * 0.01) < 1e-6, `sample ${k}`);
  }
});

test('a wrapped ring keeps the most recent window, still oldest-first', () => {
  const rec = createRecording(4);
  for (let i = 0; i < 10; i++) recordStep(rec, 0, i);
  assert.equal(recordingLength(rec), 4);
  assert.ok(recordingWrapped(rec));
  // Steps 6..9 are what survives.
  for (let k = 0; k < 4; k++) {
    assert.equal(recordingAt(rec, k).steer, 6 + k, `wrapped sample ${k}`);
  }
});

test('resetRecording empties it', () => {
  const rec = createRecording(4);
  recordStep(rec, FLAG_FORWARD, 0.1);
  resetRecording(rec);
  assert.equal(recordingLength(rec), 0);
  assert.equal(rec.flags[0], 0);
});

test('replay visits every step once, in order', () => {
  const rec = createRecording(16);
  for (let i = 0; i < 6; i++) recordStep(rec, FLAG_FORWARD, i);
  const seen = [];
  const n = replay(rec, input => seen.push(input.steer));
  assert.equal(n, 6);
  assert.deepEqual(seen, [0, 1, 2, 3, 4, 5]);
});

test('serialising a recording round-trips through JSON', () => {
  const rec = createRecording(32);
  for (let i = 0; i < 20; i++) recordStep(rec, i % 64, Math.sin(i) * 0.3);
  const round = deserializeRecording(JSON.parse(JSON.stringify(serializeRecording(rec))));
  assert.equal(recordingLength(round), 20);
  for (let k = 0; k < 20; k++) {
    const a = recordingAt(rec, k);
    const b = recordingAt(round, k);
    assert.equal(b.forward, a.forward, `flags at ${k}`);
    // Float32 in, Float32 out — this is exact, not approximate.
    assert.equal(b.steer, a.steer, `steer at ${k}`);
  }
});

test('an unknown recording version is refused rather than misread', () => {
  assert.throws(() => deserializeRecording({ version: 99 }), /version/);
});

// ---------------------------------------------------------------------------
// The property the whole module exists for.
// ---------------------------------------------------------------------------

test('replaying a recorded run reproduces the trajectory bit-exactly', () => {
  const drive = createVehicle({});
  drive.recorder = createRecording(4096);
  for (let i = 0; i < 180; i++) {
    const t = i / 60;
    const input = keys({
      forward: t < 1.5,
      brake: t >= 2.0 && t < 2.4,
      left: t > 0.4 && t < 1.2,
      right: t > 2.5,
    });
    updateSteering(drive, input, 1 / 60);
    advance(drive, input, flat, 1 / 60);
  }

  const ghost = createVehicle({});
  const steps = replay(drive.recorder, input => replayStep(ghost, input, flat));

  assert.ok(steps > 1500, `only ${steps} steps recorded for 3 s at 600 Hz`);
  for (const k of ['x', 'z', 'yaw', 'vx', 'vz', 'av', 'axPrev', 'ayPrev']) {
    assert.equal(
      ghost[k], drive[k],
      `${k}: replay ${ghost[k]} != recorded ${drive[k]}`,
    );
  }
});

test('a replay is exact after a JSON round trip, so it survives a file', () => {
  const drive = createVehicle({});
  drive.recorder = createRecording(2048);
  for (let i = 0; i < 120; i++) {
    const input = keys({ forward: true, left: i > 40 });
    updateSteering(drive, input, 1 / 60);
    advance(drive, input, flat, 1 / 60);
  }
  const blob = JSON.parse(JSON.stringify(serializeRecording(drive.recorder)));
  const ghost = createVehicle({});
  replay(deserializeRecording(blob), input => replayStep(ghost, input, flat));
  assert.equal(ghost.x, drive.x);
  assert.equal(ghost.z, drive.z);
  assert.equal(ghost.yaw, drive.yaw);
});

test('two replays of the same recording agree with each other', () => {
  const rec = createRecording(1024);
  const drive = createVehicle({});
  drive.recorder = rec;
  for (let i = 0; i < 60; i++) advance(drive, keys({ forward: true }), flat, 1 / 60);

  const run = () => {
    const car = createVehicle({});
    replay(rec, input => replayStep(car, input, flat));
    return car;
  };
  const a = run();
  const b = run();
  assert.equal(a.x, b.x);
  assert.equal(a.vz, b.vz);
});

test('recording costs nothing when no recorder is attached', () => {
  const car = createVehicle({});
  assert.equal(car.recorder, null);
  advance(car, keys({ forward: true }), flat, 1 / 60);
  assert.ok(Number.isFinite(car.vz));
});

test('the observer hook fires once per sim step', () => {
  const car = createVehicle({});
  let n = 0;
  car.observer = () => n++;
  advance(car, keys({ forward: true }), flat, 1 / 60);
  assert.equal(n, car.clock.steps, `${n} observations for ${car.clock.steps} steps`);
  assert.ok(n >= 9, `expected ~10 steps at 600 Hz in a 60 fps frame, got ${n}`);
});
