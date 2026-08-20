import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGhostState, resetGhost, recordGhostStep, completeLap,
  advanceGhost, ghostProgress, ghostTime, saveGhost, loadGhost, GHOST_CAPACITY,
} from './ghost.js';
import { recordingLength } from './replay.js';
import { DT } from './fixedStep.js';
import {
  createVehicle, advance, replayStep, updateSteering, forwardSpeed,
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

/** Record `n` steps of a scripted input. */
function record(g, n, shape = i => keys({ forward: i < n * 0.7 })) {
  for (let i = 0; i < n; i++) recordGhostStep(g, shape(i), Math.sin(i / 400) * 0.1);
}

test('a fresh ghost has nothing to chase', () => {
  const g = createGhostState();
  assert.equal(g.best, null);
  assert.equal(g.active, false);
  assert.equal(ghostProgress(g), 0);
  assert.equal(saveGhost(g), null);
});

test('the first valid lap becomes the ghost', () => {
  const g = createGhostState();
  record(g, 6000);
  assert.equal(completeLap(g, 90), true);
  assert.equal(g.bestLapTime, 90);
  assert.ok(g.active, 'and it must start chasing');
  assert.equal(recordingLength(g.current), 0, 'and the live recording must restart');
});

test('only a quicker lap replaces it', () => {
  const g = createGhostState();
  record(g, 6000);
  completeLap(g, 90);
  record(g, 6000);
  assert.equal(completeLap(g, 92), false, 'a slower lap must not replace the ghost');
  assert.equal(g.bestLapTime, 90);
  record(g, 6000);
  assert.equal(completeLap(g, 88), true);
  assert.equal(g.bestLapTime, 88);
});

test('the stored ghost is a copy, not a reference to the live recording', () => {
  // The live recording is reset immediately afterwards, so a reference would leave
  // the ghost driving an empty lap.
  const g = createGhostState();
  record(g, 4000);
  completeLap(g, 90);
  const storedLength = recordingLength(g.best);
  record(g, 100);
  assert.equal(recordingLength(g.best), storedLength, 'the ghost changed under us');
  assert.ok(storedLength > 3000);
});

test('a lap quicker than the minimum is jitter over the line, not a lap', () => {
  const g = createGhostState();
  record(g, 500);
  assert.equal(completeLap(g, 3), false);
  assert.equal(g.best, null);
});

test('a lap that overflowed the buffer is refused', () => {
  // Letting the ring wrap would splice the end of the lap onto its beginning, and
  // a ghost that teleports is worse than no ghost.
  const g = createGhostState();
  g.current.written = GHOST_CAPACITY;
  recordGhostStep(g, keys({ forward: true }), 0);
  assert.equal(g.overflowed, true);
  assert.equal(completeLap(g, 90), false);
  assert.equal(g.best, null);
  assert.equal(g.overflowed, false, 'and the flag must clear for the next lap');
});

test('an empty lap is refused', () => {
  const g = createGhostState();
  assert.equal(completeLap(g, 90), false);
});

// ---------------------------------------------------------------------------
// Replaying it
// ---------------------------------------------------------------------------

test('the ghost is stepped by elapsed sim time, not by frames', () => {
  // This is what keeps it honest: if the player's frame rate drops, the ghost
  // slows with them rather than running away, and the gap on screen stays the gap
  // on the clock.
  const g = createGhostState();
  record(g, 6000);
  completeLap(g, 90);

  const atFrameRate = fps => {
    g.cursor = 0;
    g.elapsed = 0;
    g.active = true;
    let steps = 0;
    for (let i = 0; i < fps; i++) advanceGhost(g, 1 / fps, () => steps++);
    return steps;
  };
  const slow = atFrameRate(20);
  const fast = atFrameRate(144);
  assert.ok(Math.abs(slow - fast) <= 2, `20 fps took ${slow} steps, 144 fps ${fast}`);
  assert.ok(Math.abs(slow - 1 / DT) <= 2, 'one second of frames is one second of sim');
});

test('the ghost stops at the end of its lap and waits', () => {
  const g = createGhostState();
  record(g, 1200);
  completeLap(g, 90);
  let steps = 0;
  for (let i = 0; i < 200; i++) advanceGhost(g, 1 / 60, () => steps++);
  assert.equal(steps, 1200, `replayed ${steps} of 1200 recorded steps`);
  assert.equal(g.active, false, 'and must stop rather than loop');
  assert.ok(Math.abs(ghostProgress(g) - 1) < 1e-9);
});

test('a stalled frame does not replay the whole lap in one go', () => {
  const g = createGhostState();
  record(g, 20000);
  completeLap(g, 90);
  const steps = advanceGhost(g, 30, () => {});
  assert.ok(steps <= 240, `a 30 s frame replayed ${steps} steps at once`);
});

test('an inactive ghost does nothing', () => {
  const g = createGhostState();
  let steps = 0;
  advanceGhost(g, 1 / 60, () => steps++);
  assert.equal(steps, 0);
});

test('ghost time is its cursor in seconds', () => {
  const g = createGhostState();
  record(g, 600);
  completeLap(g, 90);
  // Real frames, not one long one: a single 0.5 s frame wants 300 sim steps and
  // hits the 240-step stall cap, which is the cap working rather than a fault.
  for (let i = 0; i < 30; i++) advanceGhost(g, 1 / 60, () => {});
  assert.ok(Math.abs(ghostTime(g) - 0.5) < DT * 4, `${ghostTime(g)}`);
});

test('a ghost lap survives being saved and loaded', () => {
  const g = createGhostState();
  record(g, 3000);
  completeLap(g, 87.5);
  const blob = JSON.parse(JSON.stringify(saveGhost(g)));

  const fresh = createGhostState();
  assert.equal(loadGhost(fresh, blob), true);
  assert.equal(fresh.bestLapTime, 87.5);
  assert.equal(recordingLength(fresh.best), recordingLength(g.best));
  assert.equal(loadGhost(fresh, null), false);
});

test('resetGhost forgets the lap', () => {
  const g = createGhostState();
  record(g, 3000);
  completeLap(g, 90);
  resetGhost(g);
  assert.equal(g.best, null);
  assert.equal(g.active, false);
});

// ---------------------------------------------------------------------------
// The property that makes it worth having
// ---------------------------------------------------------------------------

test('the ghost drives the same line the player drove', () => {
  // The whole claim: replaying the recorded inputs reproduces the trajectory, so
  // the car on screen is genuinely the lap that was set rather than an
  // approximation of it.
  const player = createVehicle({});
  const g = createGhostState();
  const script = i => {
    const t = i * DT;
    return keys({
      forward: t < 2.0 || (t > 3.0 && t < 4.0),
      brake: t >= 2.6 && t < 3.0,
      left: t > 0.8 && t < 2.2,
      right: t > 3.4,
    });
  };

  // Drive, recording on the sim clock through the vehicle's own recorder hook.
  let step = 0;
  player.recorder = g.current;
  for (let f = 0; f < 60 * 5; f++) {
    const input = script(step);
    updateSteering(player, input, 1 / 60);
    advance(player, input, flat, 1 / 60);
    step += player.clock.steps;
  }
  completeLap(g, 90);

  const ghostCar = createVehicle({});
  g.active = true;
  g.cursor = 0;
  g.elapsed = 0;
  // Give it plenty of frames to replay the whole lap.
  for (let f = 0; f < 60 * 20 && g.active; f++) {
    advanceGhost(g, 1 / 60, input => replayStep(ghostCar, input, flat));
  }

  const gap = Math.hypot(ghostCar.x - player.x, ghostCar.z - player.z);
  const path = Math.hypot(player.x, player.z);
  assert.ok(path > 20, `the player barely moved: ${path.toFixed(1)} m`);
  assert.ok(gap < 0.5, `the ghost ended ${gap.toFixed(2)} m from the player on a ${path.toFixed(0)} m lap`);
  assert.ok(
    Math.abs(forwardSpeed(ghostCar) - forwardSpeed(player)) < 0.5,
    'and at the same speed',
  );
});
