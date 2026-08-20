/**
 * Driver model and input aids.
 *
 * **Not physics.** Everything here sits between an input device and the kernel,
 * and the kernel behaves identically whether or not it is used. The distinction
 * matters, because it is the difference between a car that cannot spin its wheels
 * and a car whose driver chooses not to.
 *
 * Two reasons it has to exist:
 *
 *   - **A keyboard has one throttle position.** An F1 car at full throttle from
 *     rest spins its wheels — correctly, and the kernel does. With a digital
 *     throttle there is no way to not do that, so a car with 600 kW is simply
 *     undriveable from the keyboard without something standing in for the foot.
 *
 *   - **The reference figures assume a driver.** "0–100 km/h ~2.6 s (traction
 *     limited)" describes an optimally modulated launch. Measured with the
 *     throttle pinned, the same car takes 6.0 s, and almost all of the difference
 *     is wheelspin. Measuring against a target that assumes modulation, without
 *     modelling modulation, measures the wrong thing.
 *
 * Real F1 has no traction control. What it has is a driver, and this is a crude
 * one: it targets the slip ratio the tyre makes most force at, which is what a
 * good launch does.
 */

import { KAPPA_PEAK } from './wheel.js';
import * as ST from './state.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Slip ratio to aim for. The peak of the longitudinal curve, near enough. */
export const TARGET_SLIP = KAPPA_PEAK;
/** Proportional and integral gains on the throttle cut. */
export const TC_KP = 2.2;
export const TC_KI = 9.0;
/** How fast the cut recovers when there is no slip to correct. */
export const TC_RELEASE = 3.0;

export function createDriverState() {
  return { cut: 0, slip: 0, brakeCut: 0, brakeSlip: 0 };
}

export function resetDriver(d) {
  d.cut = 0;
  d.slip = 0;
  d.brakeCut = 0;
  d.brakeSlip = 0;
}

/**
 * Throttle to apply, given what the driver asked for.
 *
 * A PI controller on the rear slip ratio, with the integrator carrying the steady
 * cut. Proportional alone chatters at 600 Hz — the correction arrives, the slip
 * drops, the correction is removed, and the slip returns — which reads as a
 * misfire rather than as a launch.
 *
 * @param {object} d from `createDriverState`
 * @param {Float64Array} S the car's state vector
 * @param {number} demand what the input device asked for, 0..1
 * @param {number} vLong forward speed, m/s
 * @param {number} dt seconds
 * @returns {number} throttle to hand the kernel
 */
export function tractionThrottle(d, S, demand, vLong, dt) {
  if (demand <= 0) {
    d.cut = 0;
    d.slip = 0;
    return demand;
  }

  // The slipping wheel is the one that matters: the differential means one
  // spinning rear takes drive from the other.
  const rl = slipOf(S, ST.RL, vLong);
  const rr = slipOf(S, ST.RR, vLong);
  const slip = Math.max(rl, rr);
  d.slip = slip;

  const excess = (slip - TARGET_SLIP) / TARGET_SLIP;
  if (excess > 0) {
    d.cut = clamp(d.cut + TC_KI * excess * dt, 0, 1);
  } else {
    // Ease off, rather than releasing the cut the instant slip is in range.
    d.cut = clamp(d.cut - TC_RELEASE * dt, 0, 1);
  }
  const proportional = Math.max(0, excess) * TC_KP;
  return demand * clamp(1 - d.cut - proportional, 0, 1);
}

function slipOf(S, wheel, vLong) {
  const omega = S[ST.S_OMEGA + wheel];
  const surface = Math.abs(vLong);
  const denom = Math.max(surface, 2);
  return (omega * 0.334 - surface) / denom;
}

/**
 * Steering ramp for a keyboard, which has no analogue axis either.
 *
 * Kept here rather than in the kernel for the same reason: the kernel takes a road
 * wheel angle, and how that angle came about is the input layer's problem. Lock
 * falls with speed, as it does on the real car.
 */
export const MAX_STEER_DEG = 18;
export const STEER_RATE = 2.5;
export const STEER_SPEED_FADE = 12;

export function steerRamp(state, left, right, vLong, dt) {
  const rate = STEER_RATE * dt;
  const target = (left ? -1 : 0) + (right ? 1 : 0);
  if (target === 0) {
    const back = Math.min(rate, Math.abs(state.smooth));
    state.smooth += state.smooth > 0 ? -back : back;
  } else if (target > state.smooth) {
    state.smooth += rate;
  } else {
    state.smooth -= rate;
  }
  state.smooth = clamp(state.smooth, -1, 1);
  const maxSteer = maxSteerAt(Math.abs(vLong));
  state.angle = -state.smooth * maxSteer;
  return state.angle;
}

/** Steering lock available at a speed, radians. */
export function maxSteerAt(speedMs) {
  return (MAX_STEER_DEG - STEER_SPEED_FADE * clamp(speedMs / 80, 0, 1)) * Math.PI / 180;
}

export function createSteerState() {
  return { smooth: 0, angle: 0 };
}

/**
 * DRS eligibility. On a real car this is zone-and-gap gated; here it is simply a
 * speed threshold, because there is nobody to be within a second of.
 */
export const DRS_MIN_SPEED = 60;
export const drsAllowed = (vLong, braking) => vLong > DRS_MIN_SPEED && !braking;

/**
 * Threshold braking.
 *
 * F1 has no ABS, and this is not ABS — it is the same crude driver, modulating the
 * pedal to hold the wheels near the slip ratio the tyre makes most force at.
 *
 * It has to exist for the same two reasons the throttle version does. A keyboard
 * brake is on or off, and full pedal on this car is comfortably past the lock
 * threshold: the brakes can apply 4 kN·m to a front wheel that needs 1.9 kN·m to
 * lock it, so a digital brake locks all four instantly. A locked tyre still makes
 * about 74% of peak force, so the car does stop — 26% slower, with no steering,
 * which is neither the reference figure nor anything a driver would do.
 */
export const BRAKE_KI = 9.0;
export const BRAKE_KP = 2.0;
export const BRAKE_RELEASE = 4.0;
/** Below this there is nothing left to modulate; just stop the car. */
export const BRAKE_MODULATE_ABOVE = 3;

export function brakeModulation(d, S, demand, vLong, dt) {
  if (demand <= 0) {
    d.brakeCut = 0;
    d.brakeSlip = 0;
    return demand;
  }
  const surface = Math.abs(vLong);
  if (surface < BRAKE_MODULATE_ABOVE) return demand;

  // The most-locked wheel is the one that matters — it is the one that has stopped
  // steering, or stopped resisting yaw.
  let worst = 0;
  for (let i = 0; i < 4; i++) {
    const lock = -slipOf(S, i, vLong);
    if (lock > worst) worst = lock;
  }
  d.brakeSlip = worst;

  const excess = (worst - TARGET_SLIP) / TARGET_SLIP;
  if (excess > 0) {
    d.brakeCut = clamp(d.brakeCut + BRAKE_KI * excess * dt, 0, 1);
  } else {
    d.brakeCut = clamp(d.brakeCut - BRAKE_RELEASE * dt, 0, 1);
  }
  const proportional = Math.max(0, excess) * BRAKE_KP;
  return demand * clamp(1 - d.brakeCut - proportional, 0, 1);
}
