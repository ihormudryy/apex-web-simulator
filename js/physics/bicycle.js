// Planar F1 bicycle model: two axles, a simplified Pacejka tyre, aero load and
// longitudinal load transfer. Car-local frame — `vx` forward, `vy` to the right.

export const MU = { tarmac: 1.6, kerb: 1.2, grass: 0.35 };

export const MASS = 800;
export const WB = 3.3928;
export const LF = WB * 0.54; // CoM → front axle
export const LR = WB * 0.46; // CoM → rear axle
export const POWER = 650000;
export const RHO = 1.225;
export const CDA = 1.55;
export const CLA = 4.6;
export const G = 9.81;
export const H_CG = 0.32;

// 30 kN of pedal on 800 kg is 3.8 g of pure brake. Loaded by 18 kN of downforce
// at 80 m/s the tyres can carry it, and aero drag takes the total past 4.9 g;
// at low speed the friction circle clips it back to a mechanical ~1.7 g.
export const BRAKE_DEMAND = 30000;
// Under 5 g the front axle carries ~14.5 kN against the rear's ~11.4 kN, so the
// bias has to sit forward of centre or the rear locks first.
export const BRAKE_BIAS_FRONT = 0.58;
// Off-throttle driveline drag. The engine is on the rear axle, so this is a rear
// tyre force and shares the rear friction budget.
export const ENGINE_BRAKE = 2500;
export const ROLLING_RESISTANCE = 0.015;
export const ENGINE_FX_MAX = 14000;
export const REVERSE_FX = 4000;
export const PACEJKA_B = 12;
export const PACEJKA_C = 1.35;

// Slip-angle relaxation speed. Dividing lateral velocity by the true `vx` sends
// the slip angle to ±90° as the car stops, which saturates the tyre and makes the
// integrator bang-bang: the lateral velocity then limit-cycles every substep
// instead of settling. Holding the denominator at 2 m/s keeps the low-speed
// response linear and convergent.
export const V_RELAX = 2;
// Below this the car is parked: no drive, no engine brake, and rolling resistance
// becomes a plain arrest so it does not creep forever.
export const V_CREEP = 0.4;

const IZ = MASS * WB * WB * 0.12;

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function pacejkaFy(dLat, alpha) {
  return -dLat * Math.sin(PACEJKA_C * Math.atan(PACEJKA_B * alpha));
}

function clipFriction(fx, fy, maxF) {
  const mag = Math.hypot(fx, fy);
  if (mag <= maxF || mag === 0) return { fx, fy };
  const s = maxF / mag;
  return { fx: fx * s, fy: fy * s };
}

/**
 * Advance the planar bicycle by `dt`.
 *
 * @param {{vx:number, vy:number, av:number, axPrev:number}} state car-local
 *   velocities, yaw rate, and the previous longitudinal acceleration (load transfer).
 * @param {{throttle:number, brake:boolean, steer:number}} input throttle in
 *   [-1, 1] (negative drives in reverse), steer in radians, positive = left.
 * @param {{surface:string}} sample surface under the car, for μ.
 * @param {number} dt seconds.
 */
export function step(state, input, sample, dt) {
  const { vx, vy, av, axPrev } = state;
  const { throttle, brake, steer } = input;

  // Aero follows the whole velocity vector, not just the forward component, so a
  // big slide keeps its drag and its downforce.
  const speed = Math.hypot(vx, vy);
  const mu = MU[sample.surface] ?? MU.grass;

  const q = 0.5 * RHO * speed * speed;
  const Fd = q * CDA;
  const FL = q * CLA;

  const FzF = Math.max(200, MASS * G * LR / WB + 0.4 * FL - MASS * axPrev * H_CG / WB);
  const FzR = Math.max(200, MASS * G * LF / WB + 0.6 * FL + MASS * axPrev * H_CG / WB);

  const dLatF = mu * FzF;
  const dLatR = mu * FzR;

  const vxMag = Math.max(Math.abs(vx), V_RELAX);
  const vxSign = Math.abs(vx) < 0.05 ? 0 : Math.sign(vx);
  // +av is Three.js yaw-left (rotation.y). Front then moves toward -y, rear toward +y.
  const alphaF = Math.atan2(vy - av * LF, vxMag) + vxSign * steer;
  const alphaR = Math.atan2(vy + av * LR, vxMag);

  const FyF = pacejkaFy(dLatF, alphaF);
  const FyR = pacejkaFy(dLatR, alphaR);

  const moving = Math.abs(vx) > V_CREEP;

  let FxEng = 0;
  if (throttle > 0) {
    FxEng = Math.min(POWER / Math.max(Math.abs(vx), 3), ENGINE_FX_MAX) * throttle;
  } else if (throttle < 0) {
    FxEng = throttle * REVERSE_FX;
  } else if (moving) {
    FxEng = -Math.sign(vx) * ENGINE_BRAKE;
  }

  const FxBrk = brake && moving ? -Math.sign(vx) * BRAKE_DEMAND : 0;

  // Rolling resistance is a contact-patch force, so it shares the friction circle.
  // Below the creep threshold it becomes a plain arrest: without it the car coasts
  // forever, since drag alone is a few newtons at walking pace.
  const rrF = ROLLING_RESISTANCE * FzF;
  const rrR = ROLLING_RESISTANCE * FzR;
  const rrSign = moving ? -Math.sign(vx) : -clamp(vx / Math.max(V_CREEP, 1e-6), -1, 1);

  let FxRF = FxBrk * BRAKE_BIAS_FRONT + rrSign * rrF;
  let FxRR = FxEng + FxBrk * (1 - BRAKE_BIAS_FRONT) + rrSign * rrR;

  const clippedF = clipFriction(FxRF, FyF, dLatF);
  FxRF = clippedF.fx;
  const FyFClipped = clippedF.fy;

  const clippedR = clipFriction(FxRR, FyR, dLatR);
  FxRR = clippedR.fx;
  const FyRClipped = clippedR.fy;

  // Aero acts on the body, not through the contact patches, so it is added after
  // the friction circle rather than clipped by it.
  const dragScale = speed > 1e-6 ? Fd / speed : 0;
  const FxAero = -dragScale * vx;
  const FyAero = -dragScale * vy;

  const Fx = FxRF + FxRR + FxAero;
  const Fy = FyFClipped + FyRClipped + FyAero;

  const newVx = vx + dt * Fx / MASS;
  const newVy = vy + dt * Fy / MASS;
  let newAv = av - dt * (FyFClipped * LF - FyRClipped * LR) / IZ;
  newAv *= 1 - Math.min(1, dt * 1.2);

  const newAxPrev = dt > 0 ? (newVx - vx) / dt : axPrev;

  return {
    vx: newVx,
    vy: newVy,
    av: newAv,
    axPrev: newAxPrev,
    fx: Fx,
    fy: Fy,
  };
}
