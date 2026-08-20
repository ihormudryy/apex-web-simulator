// Planar F1 model with four-corner load transfer and load-sensitive peak grip.

import { wheelNormalLoads } from './loadTransfer.js';
import { peakGrip, WHEEL_RADIUS } from './wheel.js';

export { TRACK_HALF } from './loadTransfer.js';
export { WHEEL_RADIUS } from './wheel.js';

export const MU = { tarmac: 1.85, kerb: 1.35, grass: 0.40 };

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
// Off-throttle driveline drag, at and above `ENGINE_BRAKE_SPEED`. The engine is
// on the rear axle, so this is a rear tyre force and shares the rear friction
// budget. It scales with speed the way real engine braking scales with rpm —
// applying the full figure at walking pace makes the car feel anchored.
export const ENGINE_BRAKE = 2500;
export const ENGINE_BRAKE_SPEED = 20;
export const ROLLING_RESISTANCE = 0.015;
export const ENGINE_FX_MAX = 14000;
export const REVERSE_FX = 4000;
/** Reverse is a recovery crawl, so drive cuts out once it is rolling this fast. */
export const REVERSE_SPEED_LIMIT = 8;
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

/**
 * Split an axle's grip between cornering and drive: cornering first, drive from
 * whatever is left on the friction ellipse.
 *
 * There is no wheel-speed state here, so the longitudinal force is a *demand* —
 * the engine asks for `POWER/v` capped at `ENGINE_FX_MAX`, which below about
 * 46 m/s is more than the rear tyres can transmit. Scaling both components down
 * together, as a plain friction-circle clip does, made a cornering car on the
 * throttle surrender 35-40% of its rear lateral force to a drive force the
 * contact patch could never have delivered — the car cornered as if on ice.
 *
 * Sizing the drive force to the grip left after cornering is what really happens
 * once a tyre starts to spin, and it keeps the loss where it belongs: you cannot
 * accelerate hard mid-corner, but asking for it no longer costs you the corner.
 *
 * Straight-line performance is untouched: with no cornering force the whole
 * circle is available, so a launch is traction-limited exactly as before.
 */
function allocateGrip(fxDemand, fy, maxF) {
  const lateral = Math.min(Math.abs(fy), maxF);
  const fxMax = Math.sqrt(Math.max(0, maxF * maxF - lateral * lateral));
  return {
    fx: clamp(fxDemand, -fxMax, fxMax),
    fy: Math.sign(fy) * lateral,
  };
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
  const { vx, vy, av, axPrev, ayPrev = 0 } = state;
  const { throttle, brake, steer } = input;

  // Aero follows the whole velocity vector, not just the forward component, so a
  // big slide keeps its drag and its downforce.
  const speed = Math.hypot(vx, vy);
  const mu = MU[sample.surface] ?? MU.grass;

  const q = 0.5 * RHO * speed * speed;
  const Fd = q * CDA;
  const FL = q * CLA;

  // Lateral load transfer only once the car is moving — at rest ayPrev would
  // redistribute grip across the track and let a steered wheel yaw the body.
  const ayEff = Math.abs(vx) > V_RELAX ? ayPrev : 0;
  const fzW = wheelNormalLoads(axPrev, ayEff, FL);
  const FzF = fzW[0] + fzW[1];
  const FzR = fzW[2] + fzW[3];

  const dLatF = peakGrip(mu, fzW[0]) + peakGrip(mu, fzW[1]);
  const dLatR = peakGrip(mu, fzW[2]) + peakGrip(mu, fzW[3]);

  const vxMag = Math.max(Math.abs(vx), V_RELAX);
  // +av is Three.js yaw-left (rotation.y). Front then moves toward -y, rear toward +y.
  const frontLat = vy - av * LF;
  const rearLat = vy + av * LR;

  // Slip angle in the steered wheel's own frame. Adding `steer` to the slip angle
  // as a flat term instead made a turned wheel produce its full lateral force at
  // any speed at all — 5.7 kN at walking pace, the same as at 40 m/s — so a car
  // rolling to a stop with lock on pivoted on the spot instead of coming to rest.
  // The steer's real contribution to slip is `vx·sin δ`, which fades with speed.
  const sinSteer = Math.sin(steer);
  const cosSteer = Math.cos(steer);
  const wheelLat = vx * sinSteer + frontLat * cosSteer;
  const wheelLong = vx * cosSteer - frontLat * sinSteer;

  const alphaF = Math.atan2(wheelLat, Math.max(Math.abs(wheelLong), V_RELAX));
  const alphaR = Math.atan2(rearLat, vxMag);

  const FyF = pacejkaFy(dLatF, alphaF);
  const FyR = pacejkaFy(dLatR, alphaR);

  const moving = Math.abs(vx) > V_CREEP;

  let FxEng = 0;
  if (throttle > 0) {
    FxEng = Math.min(POWER / Math.max(Math.abs(vx), 3), ENGINE_FX_MAX) * throttle;
  } else if (throttle < 0) {
    FxEng = vx > -REVERSE_SPEED_LIMIT ? throttle * REVERSE_FX : 0;
  } else if (moving) {
    const fade = Math.min(1, Math.abs(vx) / ENGINE_BRAKE_SPEED);
    FxEng = -Math.sign(vx) * ENGINE_BRAKE * fade;
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

  const gripF = allocateGrip(FxRF, FyF, dLatF);
  FxRF = gripF.fx;
  const FyFClipped = gripF.fy;

  const gripR = allocateGrip(FxRR, FyR, dLatR);
  FxRR = gripR.fx;
  const FyRClipped = gripR.fy;

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
  const newAyPrev = dt > 0 ? (newVy - vy) / dt : ayPrev;

  return {
    vx: newVx,
    vy: newVy,
    av: newAv,
    axPrev: newAxPrev,
    ayPrev: newAyPrev,
    fx: Fx,
    fy: Fy,
  };
}
