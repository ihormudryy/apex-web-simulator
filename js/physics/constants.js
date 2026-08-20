// Shared F1 vehicle constants — imported by the four-wheel kernel and UI.

/**
 * Peak friction coefficients at the reference load.
 *
 * Tarmac was 1.6, which was tuned against a model with no wheel locking, no
 * per-axle tyre difference and a lumped friction clip. Measured properly against
 * the reference table it caps the car at 1.93 g of lateral and 1.6 g of braking,
 * where the targets are 2.2 g and 2.3 g. A warm F1 slick is commonly put at
 * 1.7-2.0 at racing loads, so 1.85 is inside the credible range and is what the
 * reference figures actually need.
 */
export const MU = { tarmac: 1.85, kerb: 1.35, grass: 0.40 };

export const MASS = 800;
export const WB = 3.3928;
export const LF = WB * 0.54;
export const LR = WB * 0.46;
export const POWER = 650000;
export const RHO = 1.225;
export const CDA = 1.55;
export const CLA = 4.6;
export const G = 9.81;
export const H_CG = 0.32;
/** Track half-width — centre of each tyre from the car centreline [m]. */
export const TRACK_HALF = 0.8;

export const BRAKE_DEMAND = 30000;
export const BRAKE_BIAS_FRONT = 0.58;
export const ENGINE_BRAKE = 2500;
export const ENGINE_BRAKE_SPEED = 20;
export const ROLLING_RESISTANCE = 0.015;
export const ENGINE_FX_MAX = 14000;
export const REVERSE_FX = 4000;
export const REVERSE_SPEED_LIMIT = 8;

export const V_RELAX = 2;
export const V_CREEP = 0.4;

export const IZ = MASS * WB * WB * 0.12;
