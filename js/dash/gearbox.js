/**
 * Instrument-facing gearbox readouts.
 *
 * This module used to *invent* a gearbox. The simulation had none — power went
 * straight through the rear axle as `POWER / v` — so the dash needed something to
 * show, and it derived a gear and a tacho from road speed through a table of
 * ratios that existed nowhere else. Shifting was instantaneous and cost nothing,
 * because there was no drivetrain to model.
 *
 * There is now. `powertrain.js` owns the ratios, the shift logic and the shift
 * time, and the kernel reports the gear it is actually in and the rpm the crank is
 * actually turning. So what is left here is what an instrument genuinely adds:
 * where the shift lights come on, and what a gear reads as on a display.
 *
 * `rpmFor` survives for one caller — an rpm estimate from road speed is still the
 * right fallback for anything holding a snapshot without a live driveline.
 */

import {
  GEAR_RATIOS, FINAL_DRIVE, IDLE_RPM, LIMITER_RPM, SHIFT_UP_RPM, SHIFT_DOWN_RPM,
  totalRatio, TOP_GEAR,
} from '../physics/powertrain.js';
import { WHEEL_RADIUS } from '../physics/wheel.js';

export { IDLE_RPM, TOP_GEAR } from '../physics/powertrain.js';
export const REDLINE_RPM = LIMITER_RPM;
export const SHIFT_RPM = SHIFT_UP_RPM;
export const DOWNSHIFT_RPM = SHIFT_DOWN_RPM;
/** First shift light comes on here. */
export const LIGHTS_FROM_RPM = 10500;

/** Engine revolutions per wheel revolution, first to eighth. From the real box. */
export const RATIOS = GEAR_RATIOS.map(r => r * FINAL_DRIVE);

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Engine speed in a given gear from road speed, clamped to the instrument range.
 *
 * A geometric estimate, not the truth: the truth is `snapshot.rpm`, which comes
 * from the driven wheels through the engaged ratio and includes clutch slip and
 * wheelspin. Two things this cannot know about, and both are visible — a car
 * spinning its rears reads high, and a car at a standstill in gear reads idle.
 */
export function rpmFor(speedMs, gear) {
  const ratio = Math.abs(totalRatio(clamp(gear, 1, TOP_GEAR)));
  const wheelOmega = Math.abs(speedMs) / WHEEL_RADIUS;
  return clamp(wheelOmega * ratio * 60 / (2 * Math.PI), IDLE_RPM, REDLINE_RPM);
}

/** Lowest gear that keeps the engine under the shift point at this road speed. */
export function gearFor(speedMs) {
  let gear = 1;
  while (gear < TOP_GEAR && rpmFor(speedMs, gear) > SHIFT_RPM) gear++;
  return gear;
}

/**
 * Sequential box with hysteresis, for a caller with only a road speed.
 *
 * `gearFor` always picks the shortest legal ratio, so a lift-off downshift slams
 * the revs back up. This holds the current gear while coasting and only shortens
 * on power once rpm has fallen.
 */
export function advanceGear(prev, speedMs, { throttle = 0 } = {}) {
  if (Math.abs(speedMs) < 0.35) return 1;
  let gear = clamp(prev || 1, 1, TOP_GEAR);

  while (gear < TOP_GEAR && rpmFor(speedMs, gear) > SHIFT_RPM) gear++;

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
