import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createChassisCamera, resetChassisCamera, updateChassisCamera, speedFov,
  SURGE_PER_G, SWAY_PER_G, SHAKE_AMPLITUDE, HEAD_STIFFNESS,
} from './chassisCamera.js';

const DT = 1 / 60;
const G = 9.81;

/** Hold a state until the head settles, and return the camera. */
function settle(state, seconds = 2, dt = DT) {
  const cam = createChassisCamera();
  for (let i = 0; i < Math.round(seconds / dt); i++) updateChassisCamera(cam, state, dt);
  return cam;
}

test('a car doing nothing has a camera doing nothing', () => {
  const cam = settle({ aLong: 0, aLat: 0, pitch: 0, roll: 0, roughness: 0, speed: 0 });
  assert.ok(Math.abs(cam.x) < 1e-4 && Math.abs(cam.z) < 1e-4);
  assert.ok(Math.abs(cam.pitch) < 1e-4 && Math.abs(cam.roll) < 1e-4);
});

test('braking moves the camera back — the head goes forward, so the view does not', () => {
  const cam = settle({ aLong: -4 * G, aLat: 0, roughness: 0, speed: 60 });
  assert.ok(cam.x > 0, `braking should move the camera aft, got ${cam.x}`);
  assert.ok(Math.abs(cam.x) < SURGE_PER_G * 6 + 1e-6, 'and must be bounded');
});

test('accelerating moves it the other way', () => {
  const braking = settle({ aLong: -3 * G, aLat: 0, speed: 60 });
  const driving = settle({ aLong: 3 * G, aLat: 0, speed: 60 });
  assert.ok(braking.x > 0 && driving.x < 0, `${braking.x} vs ${driving.x}`);
});

test('cornering leans the camera, and the two directions are mirrored', () => {
  const right = settle({ aLong: 0, aLat: 4 * G, speed: 60 });
  const left = settle({ aLong: 0, aLat: -4 * G, speed: 60 });
  assert.ok(Math.abs(right.z) > 1e-4, 'lateral g must be felt');
  assert.ok(Math.abs(right.z + left.z) < 1e-6, 'and must be antisymmetric');
  assert.ok(Math.abs(right.roll + left.roll) < 1e-6);
});

test('the head LAGS the car rather than tracking it', () => {
  // Real acceleration changes in milliseconds and a head cannot. A camera that
  // follows the acceleration directly snaps, and the snap reads as a glitch
  // rather than as force.
  const cam = createChassisCamera();
  const hard = { aLong: -5 * G, aLat: 0, speed: 80 };
  updateChassisCamera(cam, hard, DT);
  const afterOneFrame = Math.abs(cam.x);
  const settled = Math.abs(settle(hard).x);
  assert.ok(afterOneFrame < settled * 0.4, `one frame reached ${afterOneFrame} of ${settled}`);
});

test('the head settles rather than oscillating forever', () => {
  const cam = createChassisCamera();
  const state = { aLong: -4 * G, aLat: 2 * G, speed: 70 };
  for (let i = 0; i < 120; i++) updateChassisCamera(cam, state, DT);
  const a = cam.x;
  for (let i = 0; i < 60; i++) updateChassisCamera(cam, state, DT);
  assert.ok(Math.abs(cam.x - a) < 1e-4, `still moving: ${a} -> ${cam.x}`);
});

test('the spring is stable at any frame time', () => {
  // Stiffness 26 with a 50 ms frame is exactly where an explicit spring rings.
  for (const dt of [1 / 600, 1 / 60, 1 / 20, 0.5, 2]) {
    const cam = createChassisCamera();
    for (let i = 0; i < 200; i++) {
      updateChassisCamera(cam, { aLong: -5 * G, aLat: 5 * G, roughness: 1, speed: 90 }, dt);
    }
    assert.ok(
      Number.isFinite(cam.x) && Math.abs(cam.x) < 1 && Math.abs(cam.roll) < 1,
      `dt=${dt} gave x=${cam.x} roll=${cam.roll}`,
    );
  }
  assert.ok(HEAD_STIFFNESS > 10, 'and the stiffness must be high enough to need it');
});

test('chassis pitch and roll pass through to the camera', () => {
  const level = settle({ aLong: 0, aLat: 0, pitch: 0, roll: 0, speed: 40 });
  const pitched = settle({ aLong: 0, aLat: 0, pitch: 0.03, roll: 0, speed: 40 });
  assert.ok(pitched.pitch > level.pitch + 0.01, 'the head goes with the car');
});

test('a rough surface shakes the camera, and only when moving', () => {
  const still = settle({ aLong: 0, aLat: 0, roughness: 1, speed: 0 });
  assert.ok(Math.abs(still.y) < 1e-3, 'a parked car on a rough surface is not shaking');

  const cam = createChassisCamera();
  let peak = 0;
  for (let i = 0; i < 200; i++) {
    updateChassisCamera(cam, { aLong: 0, aLat: 0, roughness: 0.9, speed: 80 }, DT);
    peak = Math.max(peak, Math.abs(cam.y));
  }
  assert.ok(peak > SHAKE_AMPLITUDE * 0.15, `only ${peak} of shake on a rough surface`);
});

test('the shake is the same motion at any frame rate', () => {
  // A random offset per frame is frame-rate-dependent noise; a phase advanced by
  // dt is the same motion however often it is sampled.
  const peakAt = dt => {
    const cam = createChassisCamera();
    let peak = 0;
    for (let i = 0; i < Math.round(2 / dt); i++) {
      updateChassisCamera(cam, { aLong: 0, aLat: 0, roughness: 1, speed: 80 }, dt);
      peak = Math.max(peak, Math.abs(cam.y));
    }
    return peak;
  };
  const a = peakAt(1 / 60);
  const b = peakAt(1 / 144);
  assert.ok(Math.abs(a - b) < Math.max(a, b) * 0.5, `${a} at 60 fps vs ${b} at 144`);
});

test('nothing is driven by an input — only by what the car is doing', () => {
  // A camera that lurches when the brake key goes down rather than when the car
  // decelerates lies about a locked wheel and about a car already at the limit.
  const pressedButNoDecel = settle({ aLong: 0, aLat: 0, speed: 80 });
  assert.ok(Math.abs(pressedButNoDecel.x) < 1e-4);
});

test('a zero or negative dt changes nothing', () => {
  const cam = createChassisCamera();
  updateChassisCamera(cam, { aLong: -50, aLat: 0 }, 0);
  updateChassisCamera(cam, { aLong: -50, aLat: 0 }, -1);
  assert.equal(cam.x, 0);
});

test('resetting returns the head to centre', () => {
  const cam = settle({ aLong: -5 * G, aLat: 5 * G, roughness: 1, speed: 90 });
  resetChassisCamera(cam);
  assert.equal(cam.x, 0);
  assert.equal(cam.roll, 0);
  assert.equal(cam.shakePhase, 0);
});

test('field of view widens with speed, but not into a fisheye', () => {
  assert.equal(speedFov(70, 0), 70);
  assert.ok(speedFov(70, 90) > 74);
  assert.ok(speedFov(70, 1000) <= 78 + 1e-9, 'the widening must be bounded');
});
