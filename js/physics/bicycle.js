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
export const BRAKE_DEMAND = 18000;
export const ENGINE_FX_MIN = -2000;
export const ENGINE_FX_MAX = 14000;
export const PACEJKA_B = 12;
export const PACEJKA_C = 1.35;

const IZ = MASS * WB * WB * 0.12;

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function pacejkaFy(dLat, alpha) {
  return dLat * Math.sin(PACEJKA_C * Math.atan(PACEJKA_B * alpha));
}

function clipFriction(fx, fy, maxF) {
  const mag = Math.hypot(fx, fy);
  if (mag <= maxF || mag === 0) return { fx, fy };
  const s = maxF / mag;
  return { fx: fx * s, fy: fy * s };
}

export function step(state, input, sample, dt) {
  const { vx, vy, av, axPrev } = state;
  const { throttle, brake, steer } = input;

  const v = Math.abs(vx);
  const mu = MU[sample.surface] ?? MU.grass;

  const Fd = 0.5 * RHO * v * v * CDA;
  const FL = 0.5 * RHO * v * v * CLA;

  const FzF = Math.max(200, MASS * G * LR / WB + 0.4 * FL - MASS * axPrev * H_CG / WB);
  const FzR = Math.max(200, MASS * G * LF / WB + 0.6 * FL + MASS * axPrev * H_CG / WB);

  const dLatF = mu * FzF;
  const dLatR = mu * FzR;

  const vxSafe = Math.abs(vx) < 0.1 ? (vx >= 0 ? 0.1 : -0.1) : vx;
  const alphaF = Math.atan2(vy + av * LF, vxSafe) - steer;
  const alphaR = Math.atan2(vy - av * LR, vxSafe);

  const FyF = pacejkaFy(dLatF, alphaF);
  const FyR = pacejkaFy(dLatR, alphaR);

  let FxEng = 0;
  if (throttle > 0) {
    FxEng = clamp(POWER / Math.max(Math.abs(vx), 3), ENGINE_FX_MIN, ENGINE_FX_MAX) * throttle;
  } else if (throttle < 0 && Math.abs(vx) < 8) {
    FxEng = throttle * 4000;
  }

  let FxBrk = 0;
  if (brake && Math.abs(vx) > 0.3) {
    FxBrk = -Math.sign(vx) * BRAKE_DEMAND;
  }

  const FxDrag = -Math.sign(vx) * Fd;

  let FxRF = FxEng + FxBrk * 0.4 + FxDrag * 0.4;
  let FxRR = FxBrk * 0.6 + FxDrag * 0.6;

  const clippedF = clipFriction(FxRF, FyF, dLatF);
  FxRF = clippedF.fx;
  const FyFClipped = clippedF.fy;

  const clippedR = clipFriction(FxRR, FyR, dLatR);
  FxRR = clippedR.fx;
  const FyRClipped = clippedR.fy;

  const Fx = FxRF + FxRR;
  const Fy = FyFClipped + FyRClipped;

  let newVx = vx + dt * Fx / MASS;
  let newVy = vy + dt * Fy / MASS;
  let newAv = av + dt * (FyFClipped * LF - FyRClipped * LR) / IZ;
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
