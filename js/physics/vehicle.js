/**
 * The vehicle: the four-wheel kernel plus everything that is not physics.
 *
 * Free of three.js on purpose. `Car` is a thin adapter that copies this state onto
 * an `Object3D`, and the tests drive this module directly, so a lap in Node
 * exercises exactly the code the browser runs.
 *
 * What lives here rather than in the kernel:
 *
 *   - **The sim clock.** Frame time in, fixed `DT` steps out, and a pose
 *     interpolated between the last two states for the renderer. See fixedStep.js.
 *   - **The keyboard.** Pedals from key states, a steering ramp, and the driver
 *     model that stands in for a foot — a keyboard has no analogue axis, and this
 *     car spins its wheels at full throttle and locks all four at full brake,
 *     both correctly.
 *   - **Barriers.** The kernel knows about the surface under each wheel, not about
 *     walls; the circuit's barrier test is a track concern.
 *   - **Mirrored fields.** `x`, `z`, `yaw`, `omega` and the rest are copied out of
 *     the flat state vector once per frame, so the renderer and the dashboard read
 *     plain properties and the kernel keeps a single flat authoritative state.
 *
 * World velocity is stored as plain XZ components. The car faces −Z at yaw 0, so
 * `forward = (−sin yaw, −cos yaw)` and `right = (cos yaw, −sin yaw)`.
 */

import {
  createCar, step as kernelStep, resetCar, setSpawn, warmUp,
  launch as kernelLaunch, rebaseToGround,
} from './kernel.js';
import { createClock, resetClock, pump, DT, lerp } from './fixedStep.js';
import { packInput, recordStep } from './replay.js';
import {
  createDriverState, resetDriver, tractionThrottle, brakeModulation,
  createSteerState, steerRamp, maxSteerAt, drsAllowed, MAX_STEER_DEG,
} from './driver.js';
import * as ST from './state.js';
import { WHEEL_RADIUS } from './wheel.js';

/** Below this forward speed, "reverse" means reverse rather than brake. */
export const REVERSE_THRESHOLD = 0.5;
export const REVERSE_THROTTLE = -0.25;
export { WHEEL_RADIUS } from './wheel.js';
export { maxSteerAt, MAX_STEER_DEG } from './driver.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function createVehicle({ x = 0, z = 0, yaw = 0, warm = true } = {}) {
  const car = createCar({ x, z, yaw });
  if (warm) warmUp(car);
  const v = {
    /** The kernel's car, including its flat state vector at `car.S`. */
    car,
    S: car.S,

    // Mirrored once per frame, for the renderer and the dashboard.
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
    gear: 1,
    rpm: 0,
    drs: false,

    spawn: { x, z, yaw },
    resets: 0,

    clock: createClock(),
    /** Pose one sim step back, for render interpolation. */
    prev: { x, z, yaw },
    pedals: { throttle: 0, brake: false },

    driver: createDriverState(),
    steering: createSteerState(),
    /** Whether the driver model modulates the pedals. Off for a wheel and pedals. */
    aids: true,

    /** Set to a recording to capture inputs on the sim clock. See replay.js. */
    recorder: null,
    /** Set to a callback to observe every sim step — telemetry, trajectory diff. */
    observer: null,
  };
  mirror(v);
  return v;
}

/**
 * Place the car. `track` is optional but wanted: without it the suspension keeps
 * whatever ground datum it had, and dropping the car onto a part of the circuit
 * several metres higher is a several-metre step into springs that resolve
 * millimetres.
 */
export function setPose(v, x, z, yaw, track = null) {
  setSpawn(v.car, x, z, yaw);
  v.spawn = { x, z, yaw };
  v.prev.x = x; v.prev.z = z; v.prev.yaw = yaw;
  if (track) rebaseToGround(v.car, track);
  mirror(v);
}

/** Zero motion and snap back to the spawn pose without counting as a physics reset. */
export function resetVehicle(v, track = null) {
  resetCar(v.car);
  if (track) rebaseToGround(v.car, track);
  warmUp(v.car);
  resetDriver(v.driver);
  v.steering.smooth = 0;
  v.steering.angle = 0;
  v.steerAngle = 0;
  v.steerSmooth = 0;
  v.braking = false;
  v.wheelSpin = 0;
  v.prev.x = v.spawn.x;
  v.prev.z = v.spawn.z;
  v.prev.yaw = v.spawn.yaw;
  resetClock(v.clock);
  mirror(v);
}

/** Put the car on the road at a speed, for a measurement or a hot start. */
export function launchVehicle(v, mps) {
  kernelLaunch(v.car, mps);
  mirror(v);
}

/** Copy the flat state out into the plain fields the render layer reads. */
function mirror(v) {
  const S = v.car.S;
  v.x = S[ST.S_X];
  v.z = S[ST.S_Z];
  v.yaw = S[ST.S_YAW];
  v.vx = S[ST.S_VX];
  v.vz = S[ST.S_VZ];
  v.av = S[ST.S_AV];
  v.axPrev = S[ST.S_A_LONG];
  v.ayPrev = S[ST.S_A_LAT];
  for (let i = 0; i < 4; i++) v.omega[i] = S[ST.S_OMEGA + i];
  v.gear = S[ST.S_GEAR];
  v.rpm = v.car.out.rpm;
  v.drs = S[ST.S_DRS] > 0.5;
  v.resets = v.car.resets;
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
  steerRamp(v.steering, input.left, input.right, forwardSpeed(v), dt);
  v.steerSmooth = v.steering.smooth;
  v.steerAngle = v.steering.angle;
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
 * The frame time never reaches the integrator. It goes into an accumulator and
 * whole `DT` steps come out. `renderPose` is what the scene graph should read.
 */
export function advance(v, input, track, dt) {
  const { brake, throttle } = resolvePedals(v, input);
  if (typeof input.steer === 'number') {
    v.steerAngle = input.steer;
    v.steering.angle = input.steer;
  }
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
      simStep(v, throttle, brake, track, Boolean(input.drs));
      if (v.observer) v.observer(v);
    },
    () => snapshotPose(v),
  );
  mirror(v);
}

function snapshotPose(v) {
  const S = v.car.S;
  v.prev.x = S[ST.S_X];
  v.prev.z = S[ST.S_Z];
  v.prev.yaw = S[ST.S_YAW];
}

/**
 * Pose to draw: the two most recent sim states blended by the leftover fraction of
 * a step. Without this, a 60 Hz display sampling a 600 Hz sim shows a step pattern
 * of 10, 10, 11 states per frame, which reads as micro-stutter even though the
 * physics is perfectly smooth.
 *
 * Yaw is blended linearly rather than by shortest arc on purpose: it accumulates
 * without wrapping, and one step of yaw is at most a few milliradians.
 */
export function renderPose(v, out = { x: 0, z: 0, yaw: 0 }) {
  const t = v.clock.alpha;
  const S = v.car.S;
  out.x = lerp(v.prev.x, S[ST.S_X], t);
  out.z = lerp(v.prev.z, S[ST.S_Z], t);
  out.yaw = lerp(v.prev.yaw, S[ST.S_YAW], t);
  return out;
}

/** One fixed `DT` step. Called only from the accumulator, or from a replay. */
function simStep(v, throttle, brake, track, drsHeld) {
  const S = v.car.S;
  const vLong = S[ST.S_VX] * -Math.sin(S[ST.S_YAW]) + S[ST.S_VZ] * -Math.cos(S[ST.S_YAW]);

  // The driver model stands in for a foot. A keyboard cannot modulate, and this
  // car both spins its wheels at full throttle and locks all four at full brake —
  // correctly, which is exactly why something has to sit in between.
  const demandT = Math.max(0, throttle);
  const appliedT = v.aids
    ? tractionThrottle(v.driver, S, demandT, vLong, DT)
    : demandT;
  const brakeDemand = brake ? 1 : 0;
  const appliedB = v.aids
    ? brakeModulation(v.driver, S, brakeDemand, vLong, DT)
    : brakeDemand;

  kernelStep(v.car, {
    // A negative throttle is the reverse crawl, which bypasses the traction model.
    throttle: throttle < 0 ? throttle : appliedT,
    brake: appliedB,
    steer: v.steerAngle,
    drs: drsHeld && drsAllowed(vLong, brake),
  }, track, DT);

  // Barriers. The kernel knows the surface under each wheel; walls belong to the
  // circuit, so the test happens where the circuit is known.
  const sample = track.query(S[ST.S_X], S[ST.S_Z]);
  if (sample.wallLimit !== undefined && Math.abs(sample.lateral) > sample.wallLimit) {
    const sign = sample.lateral > 0 ? -1 : 1;
    const penetration = Math.abs(sample.lateral) - sample.wallLimit;
    applyWallImpulse(v, sample.normal.x, sample.normal.z, sign, penetration);
  }

  // Wheel rotation for the renderer, accumulated over the frame.
  v.wheelSpin += DT * 0.5 * (S[ST.S_OMEGA + ST.RL] + S[ST.S_OMEGA + ST.RR]);
}

/**
 * One sim step from a recorded input, for replay. Bypasses the accumulator: a
 * replay is a sequence of steps, not a sequence of frames, which is precisely what
 * makes it reproducible.
 */
export function replayStep(v, input, track) {
  if (typeof input.steer === 'number') {
    v.steerAngle = input.steer;
    v.steering.angle = input.steer;
  }
  const { brake, throttle } = resolvePedals(v, input);
  v.braking = brake || throttle < 0;
  v.pedals.throttle = throttle;
  v.pedals.brake = brake;
  snapshotPose(v);
  simStep(v, throttle, brake, track, Boolean(input.drs));
  v.clock.simTime += DT;
  if (v.observer) v.observer(v);
  mirror(v);
}

export function applyWallImpulse(v, nx, nz, sign, penetration) {
  const S = v.car.S;
  S[ST.S_X] -= sign * penetration * nx;
  S[ST.S_Z] -= sign * penetration * nz;
  const vDotN = S[ST.S_VX] * nx + S[ST.S_VZ] * nz;
  if (vDotN * sign > 0) {
    S[ST.S_VX] -= vDotN * nx * 1.2;
    S[ST.S_VZ] -= vDotN * nz * 1.2;
    S[ST.S_AV] *= 0.5;
  }
  mirror(v);
}

/** Everything the dashboard, the audio and the effects want, in one place. */
export function telemetryOf(v) {
  const S = v.car.S;
  const out = v.car.out;
  return {
    gear: S[ST.S_GEAR],
    rpm: out.rpm,
    clutch: out.clutch,
    boost: S[ST.S_BOOST],
    soc: S[ST.S_SOC],
    drs: S[ST.S_DRS] > 0.5,
    downforce: out.downforce,
    drag: out.drag,
    steerTorque: out.steerTorque,
    plankContact: out.plankContact,
    onBumpStop: out.onBumpStop,
    rideFront: v.car.suspension.rideFront,
    rideRear: v.car.suspension.rideRear,
    groundHeight: out.groundHeight,
    gradeLong: out.gradeLong,
    gradeLat: out.gradeLat,
    roughness: out.roughness,
    /**
     * World height of the chassis reference point.
     *
     * `zc` is the chassis position relative to the suspension's ground datum, and
     * because the suspension is fed raw wheel heights it tracks the *whole*
     * elevation change since the car was placed — at Village that is nearly 4 m.
     * So `groundHeight + zc` double-counts the hill, and the car ends up four
     * metres under the road with the camera inside the ground looking at grey.
     */
    chassisY: v.car.datum + v.car.suspension.zc,
    /**
     * The suspension's own vertical motion, with the terrain taken out. This is
     * squat and dive — millimetres — and it is what a camera or a ride-height
     * readout wants. `zc` on its own is metres of hillside.
     */
    heave: v.car.suspension.zc - (out.groundHeight - v.car.datum),
    pitch: v.car.suspension.pitch,
    roll: v.car.suspension.roll,
    fz: out.fz,
    slipRatio: out.slipRatio,
    slipAngle: out.slipAngle,
    slipSpeed: out.slipSpeed,
    tyreT: [
      S[ST.S_TYRE_SURFACE_T], S[ST.S_TYRE_SURFACE_T + 1],
      S[ST.S_TYRE_SURFACE_T + 2], S[ST.S_TYRE_SURFACE_T + 3],
    ],
    tyreWear: [
      S[ST.S_TYRE_WEAR], S[ST.S_TYRE_WEAR + 1],
      S[ST.S_TYRE_WEAR + 2], S[ST.S_TYRE_WEAR + 3],
    ],
    brakeT: [
      S[ST.S_BRAKE_T], S[ST.S_BRAKE_T + 1],
      S[ST.S_BRAKE_T + 2], S[ST.S_BRAKE_T + 3],
    ],
  };
}
