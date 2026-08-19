// Gear and engine speed for the dashboard.
//
// The simulation has no gearbox — `bicycle.js` puts power straight through the
// rear axle as `POWER / v`. This module exists purely so the dash can show a gear
// and a tacho, and it is a pure function of road speed: nothing here feeds back
// into the physics. Shifting is instantaneous and costs nothing, because there is
// no drivetrain to model.

import { WHEEL_RADIUS } from '../physics/vehicle.js';

/** Engine revolutions per wheel revolution, first to eighth. */
export const RATIOS = [29.4, 23.2, 18.4, 14.5, 11.5, 9.1, 7.2, 5.7];

export const IDLE_RPM = 4000;
/** Where the shift light goes blue and the next gear is picked. */
export const SHIFT_RPM = 14200;
export const REDLINE_RPM = 15000;
/** First shift light comes on here. */
export const LIGHTS_FROM_RPM = 11500;
/** Power-on downshift: hold a taller gear until the engine is this slow. */
export const DOWNSHIFT_RPM = 8200;

const CIRCUMFERENCE = 2 * Math.PI * WHEEL_RADIUS;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Engine speed in a given gear, clamped to the instrument's range.
 * @param {number} speedMs road speed, m/s
 * @param {number} gear 1-based
 */
export function rpmFor(speedMs, gear) {
  const ratio = RATIOS[clamp(gear, 1, RATIOS.length) - 1];
  const wheelRevsPerSecond = Math.abs(speedMs) / CIRCUMFERENCE;
  return clamp(wheelRevsPerSecond * ratio * 60, IDLE_RPM, REDLINE_RPM);
}

/**
 * Lowest gear that keeps the engine under the shift point — which is what a
 * driver on an upshift-only run would be holding at this speed.
 */
export function gearFor(speedMs) {
  let gear = 1;
  while (gear < RATIOS.length && rpmFor(speedMs, gear) > SHIFT_RPM) gear++;
  return gear;
}

/**
 * Sequential box with hysteresis. `gearFor` always picks the shortest legal
 * ratio, so a lift-off downshift slams the revs back up. This holds the current
 * gear while coasting and only shortens on power once rpm has fallen.
 *
 * @param {number} prev 1-based gear from the last frame
 * @param {number} speedMs
 * @param {{ throttle?: number }} [load]
 */
export function advanceGear(prev, speedMs, { throttle = 0 } = {}) {
  const max = RATIOS.length;
  if (Math.abs(speedMs) < 0.35) return 1;
  let gear = clamp(prev || 1, 1, max);

  while (gear < max && rpmFor(speedMs, gear) > SHIFT_RPM) gear++;

  if (throttle > 0.22) {
    while (gear > 1 && rpmFor(speedMs, gear) < DOWNSHIFT_RPM) {
      if (rpmFor(speedMs, gear - 1) > SHIFT_RPM) break;
      gear--;
    }
  }
  return gear;
}

/** 0 before the lights come on, 1 at the shift point. Drives the LED row. */
export function shiftFraction(rpm) {
  return clamp((rpm - LIGHTS_FROM_RPM) / (SHIFT_RPM - LIGHTS_FROM_RPM), 0, 1);
}
