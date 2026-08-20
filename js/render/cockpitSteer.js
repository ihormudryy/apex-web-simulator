/** Peak cockpit-wheel twist at full lock, radians. Road-wheel angle is ~18°;
 *  the rim has to travel much further or the onboard view looks dead. */
export const STEER_WHEEL_LOCK = Math.PI * 0.55;

/** Exponential follow: closer to 0 = snappier. Softens the linear steer servo. */
export const STEER_WHEEL_FOLLOW = 0.04;

/**
 * Visual Z rotation for the steering wheel. `steerSmooth` is −1 left … +1 right.
 * Positive Z is clockwise as seen from the driver (looking toward −Z).
 */
export function cockpitSteerAngle(steerSmooth) {
  return steerSmooth * STEER_WHEEL_LOCK;
}

export function followSteerAngle(current, target, dt, stiffness = STEER_WHEEL_FOLLOW) {
  if (dt <= 0) return current;
  const t = 1 - Math.pow(stiffness, dt);
  return current + (target - current) * t;
}
