/**
 * Pacejka magic-formula tyre forces with load sensitivity and combined slip.
 */

export const PACEJKA_B = 12;
export const PACEJKA_C = 1.35;

/** Exponent on Fz for peak grip — below 1.0 grip grows sub-linearly with load. */
export const LOAD_SENS_EXP = 0.85;
export const FZ_REF = 2000;

export const WHEEL_RADIUS = 0.334;
export const WHEEL_INERTIA = 1.5;

export function peakGrip(mu, fz) {
  const f = Math.max(fz, 50);
  return mu * f * (f / FZ_REF) ** (LOAD_SENS_EXP - 1);
}

export function pacejkaLateral(d, alpha) {
  return -d * Math.sin(PACEJKA_C * Math.atan(PACEJKA_B * alpha));
}

export function pacejkaLongitudinal(d, kappa) {
  return d * Math.sin(PACEJKA_C * Math.atan(PACEJKA_B * kappa));
}

/**
 * Combined-slip scaling: preserve direction, clip to the friction ellipse.
 *
 * @returns {{ fx: number, fy: number }}
 */
export function combineSlip(fxPure, fyPure, d) {
  const mag = Math.hypot(fxPure, fyPure);
  if (mag <= d || mag < 1e-6) return { fx: fxPure, fy: fyPure };
  const s = d / mag;
  return { fx: fxPure * s, fy: fyPure * s };
}

/**
 * @param {number} vLong contact-patch forward speed [m/s]
 * @param {number} omega wheel angular velocity [rad/s]
 * @param {number} vRelax denominator floor [m/s]
 */
export function slipRatio(vLong, omega, vRelax = 2) {
  const denom = Math.max(Math.abs(vLong), vRelax);
  return (omega * WHEEL_RADIUS - vLong) / denom;
}

export function slipAngle(vLat, vLong, vRelax = 2) {
  return Math.atan2(vLat, Math.max(Math.abs(vLong), vRelax));
}
