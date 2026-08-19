// Shared F1 vehicle constants — imported by the four-wheel kernel and UI.

export const MU = { tarmac: 1.6, kerb: 1.2, grass: 0.35 };

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
