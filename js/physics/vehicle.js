// Vehicle state and integration around the bicycle kernel.
//
// Free of Three.js on purpose: `Car` is a thin adapter that copies this state
// onto an Object3D, and the tests drive this module directly, so a lap in Node
// exercises exactly the code the browser runs.
//
// World velocity is stored as plain XZ components. The car faces -Z at yaw 0, so
// `forward = (-sin yaw, -cos yaw)` and `right = (cos yaw, -sin yaw)`.

import { step } from './bicycle.js';
import { createClock, resetClock, pump, DT, lerp } from './fixedStep.js';
import { packInput, recordStep } from './replay.js';

/** Below this forward speed, "reverse" means reverse rather than brake. */
export const REVERSE_THRESHOLD = 0.5;
export const REVERSE_THROTTLE = -0.25;
/** Tyre rolling radius, metres. Shared with the tacho. */
export const WHEEL_RADIUS = 0.334;
const MAX_STEER_DEG = 18;
const STEER_RATE = 2.5;

const DEG2RAD = Math.PI / 180;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function createVehicle({ x = 0, z = 0, yaw = 0 } = {}) {
  return {
    x, z, yaw,
    vx: 0, vz: 0,
    av: 0,
    axPrev: 0,
    ayPrev: 0,
    omega: [0, 0, 0, 0],
    steerAngle: 0,
    steerSmooth: 0,
    braking: false,
    wheelSpin: 0,
    spawn: { x, z, yaw },
    resets: 0,
    // The sim clock, kept per-vehicle so a replay harness can drive several cars
    // independently without them sharing an accumulator.
    clock: createClock(),
    // Pose one sim step back, for render interpolation. The renderer must never
    // read `x`/`z`/`yaw` directly or it re-introduces the stutter the fixed step
    // exists to remove.
    prev: { x, z, yaw },
    pedals: { throttle: 0, brake: false },
    /** Set to a recording to capture inputs on the sim clock. See replay.js. */
    recorder: null,
    /** Set to a callback to observe every sim step — telemetry, trajectory diff. */
    observer: null,
  };
}

export function setPose(v, x, z, yaw) {
  v.x = x; v.z = z; v.yaw = yaw;
  v.prev.x = x; v.prev.z = z; v.prev.yaw = yaw;
  v.spawn = { x, z, yaw };
}

/** Zero motion and snap back to the spawn pose without counting as a physics reset. */
export function resetVehicle(v) {
  v.vx = 0;
  v.vz = 0;
  v.av = 0;
  v.axPrev = 0;
  v.ayPrev = 0;
  v.omega = [0, 0, 0, 0];
  v.steerAngle = 0;
  v.steerSmooth = 0;
  v.braking = false;
  v.wheelSpin = 0;
  v.x = v.spawn.x;
  v.z = v.spawn.z;
  v.yaw = v.spawn.yaw;
  v.prev.x = v.spawn.x;
  v.prev.z = v.spawn.z;
  v.prev.yaw = v.spawn.yaw;
  resetClock(v.clock);
}

export const speed = v => Math.hypot(v.vx, v.vz);

export const forwardSpeed = v =>
  v.vx * -Math.sin(v.yaw) + v.vz * -Math.cos(v.yaw);

export const lateralSpeed = v =>
  v.vx * Math.cos(v.yaw) + v.vz * -Math.sin(v.yaw);

/** Heading the car is actually travelling in, falling back to its facing when parked. */
export function travelYaw(v) {
  if (v.vx * v.vx + v.vz * v.vz < 0.16) return v.yaw;
  return Math.atan2(-v.vx, -v.vz);
}

export function updateSteering(v, input, dt) {
  const rate = STEER_RATE * dt;
  const target = (input.left ? -1 : 0) + (input.right ? 1 : 0);
  if (target === 0) {
    const back = Math.min(rate, Math.abs(v.steerSmooth));
    v.steerSmooth += v.steerSmooth > 0 ? -back : back;
  } else if (target > v.steerSmooth) {
    v.steerSmooth += rate;
  } else {
    v.steerSmooth -= rate;
  }
  v.steerSmooth = clamp(v.steerSmooth, -1, 1);
  const fwd = Math.abs(forwardSpeed(v));
  const maxSteer = (MAX_STEER_DEG - 12 * clamp(fwd / 80, 0, 1)) * DEG2RAD;
  v.steerAngle = -v.steerSmooth * maxSteer;
}

/**
 * Map keys onto pedals. Holding "reverse" while rolling forward has to brake:
 * gating it to a low-speed crawl leaves the key doing nothing at all at speed.
 */
export function resolvePedals(v, input) {
  const wantReverse = input.reverse && !input.forward;
  const rolling = forwardSpeed(v) > REVERSE_THRESHOLD;
  return {
    brake: Boolean(input.brake || (wantReverse && rolling)),
    throttle: input.forward ? 1 : (wantReverse && !rolling ? REVERSE_THROTTLE : 0),
  };
}

/**
 * Advance one rendered frame's worth of sim time.
 *
 * The frame time never reaches the integrator. It goes into an accumulator, and
 * whole `DT` steps come out — see fixedStep.js for why that is worth the extra
 * indirection. `renderPose` is what the scene graph should read.
 */
export function advance(v, input, track, dt) {
  // A replayed input carries the steer angle with it, because steering is
  // integrated on the frame clock and so cannot be reproduced from keys alone.
  if (typeof input.steer === 'number') v.steerAngle = input.steer;
  const { brake, throttle } = resolvePedals(v, input);
  // Brake lights follow brake or reverse, so they stay lit through the handover
  // from "reverse key is braking" to "reverse key is reversing".
  v.braking = brake || throttle < 0;
  v.pedals.throttle = throttle;
  v.pedals.brake = brake;
  v.wheelSpin = 0;

  const flags = v.recorder ? packInput(input) : 0;
  pump(
    v.clock, dt,
    () => {
      // Recorded *before* the step, so replaying the sequence reproduces the same
      // state transitions in the same order.
      if (v.recorder) recordStep(v.recorder, flags, v.steerAngle);
      simStep(v, throttle, brake, track);
      if (v.observer) v.observer(v);
    },
    () => snapshotPose(v),
  );
}

/**
 * One sim step from a recorded input, for replay. Bypasses the accumulator: a
 * replay is a sequence of steps, not a sequence of frames, which is precisely
 * what makes it reproducible.
 */
export function replayStep(v, input, track) {
  if (typeof input.steer === 'number') v.steerAngle = input.steer;
  const { brake, throttle } = resolvePedals(v, input);
  v.braking = brake || throttle < 0;
  v.pedals.throttle = throttle;
  v.pedals.brake = brake;
  snapshotPose(v);
  simStep(v, throttle, brake, track);
  v.clock.simTime += DT;
  if (v.observer) v.observer(v);
}

function snapshotPose(v) {
  v.prev.x = v.x;
  v.prev.z = v.z;
  v.prev.yaw = v.yaw;
}

/**
 * Pose to draw: the two most recent sim states blended by the leftover fraction
 * of a step. Without this, a 60 Hz display sampling a 600 Hz sim shows a step
 * pattern of 10, 10, 11, 10 states per frame, which reads as micro-stutter even
 * though the physics is perfectly smooth.
 *
 * Yaw is blended linearly rather than by shortest arc on purpose: it accumulates
 * without wrapping, and one step of yaw is at most a few milliradians.
 */
export function renderPose(v, out = { x: 0, z: 0, yaw: 0 }) {
  const t = v.clock.alpha;
  out.x = lerp(v.prev.x, v.x, t);
  out.z = lerp(v.prev.z, v.z, t);
  out.yaw = lerp(v.prev.yaw, v.yaw, t);
  return out;
}

/** One fixed `DT` step of the vehicle. Called only from the accumulator. */
function simStep(v, throttle, brake, track) {
  const h = DT;
  let sample = track.query(v.x, v.z);

  const sinY = Math.sin(v.yaw), cosY = Math.cos(v.yaw);
  const fwd = v.vx * -sinY + v.vz * -cosY;
  const lat = v.vx * cosY + v.vz * -sinY;

  const result = step(
    {
      vx: fwd, vy: lat, av: v.av,
      axPrev: v.axPrev, ayPrev: v.ayPrev,
    },
    { throttle, brake, steer: v.steerAngle },
    sample,
    h,
  );

  const accFwd = (result.vx - fwd) / h;
  const accLat = (result.vy - lat) / h;
  v.av = result.av;
  v.axPrev = result.axPrev;
  v.ayPrev = result.ayPrev;

  const rearSpin = result.vx / WHEEL_RADIUS;
  v.omega[2] = rearSpin;
  v.omega[3] = rearSpin;

  // Back to world along the same two basis vectors.
  v.vx += h * (-sinY * accFwd + cosY * accLat);
  v.vz += h * (-cosY * accFwd - sinY * accLat);

  v.x += h * v.vx;
  v.z += h * v.vz;
  v.yaw += h * v.av;

  if (!Number.isFinite(v.x) || !Number.isFinite(v.z) || !Number.isFinite(v.vx)) {
    resetToSpawn(v);
    return;
  }

  // Re-query after moving: the barrier test has to see where the car ended up.
  sample = track.query(v.x, v.z);
  if (Math.abs(sample.lateral) > sample.wallLimit) {
    const sign = sample.lateral > 0 ? -1 : 1;
    const penetration = Math.abs(sample.lateral) - sample.wallLimit;
    applyWallImpulse(v, sample.normal.x, sample.normal.z, sign, penetration);
  }

  v.wheelSpin += h * (v.omega[2] + v.omega[3]) * 0.5;
}

export function applyWallImpulse(v, nx, nz, sign, penetration) {
  v.x -= sign * penetration * nx;
  v.z -= sign * penetration * nz;
  const vDotN = v.vx * nx + v.vz * nz;
  if (vDotN * sign > 0) {
    v.vx -= vDotN * nx * 1.2;
    v.vz -= vDotN * nz * 1.2;
    v.av *= 0.5;
  }
}

function resetToSpawn(v) {
  resetVehicle(v);
  v.resets++;
}
