/**
 * Four-corner normal loads.
 *
 * The interesting part is the lateral split. The previous version applied one
 * lateral transfer term equally to both axles, which meant the car had **no
 * balance adjustment at all** — no setup lever for understeer or oversteer,
 * because moving grip between the axles was impossible by construction.
 *
 * Roll stiffness distribution front-to-rear is the primary balance tool on a real
 * car, so the split has to come from the suspension rather than being assumed
 * even. Each axle takes:
 *
 *     ΔFz_axle = (m·ay / t) · [ share_axle · h_roll  +  (l_other / L) · z_rc_axle ]
 *
 * Two mechanisms, and they behave differently. The first is **elastic**: the body
 * rolls, the springs and bars resist, and the axle that resists harder carries
 * more of the transfer — this is the part a setup screen can change. The second is
 * **geometric**: transfer that goes straight through the suspension links from the
 * roll centre without rolling the body at all — instant, and not adjustable
 * without changing the geometry.
 *
 * Because the two bracket terms sum to `h_roll + z_roll_axis = h_cg`, total
 * lateral transfer is exactly `m·ay·h_cg / t` however the split is set. That is
 * worth stating as an invariant: a change to roll distribution must move load
 * *between* the axles and never create or destroy any.
 */

import { G, H_CG, LF, LR, MASS, WB, TRACK_HALF } from './constants.js';
import {
  ROLL_STIFFNESS_FRONT_SHARE, RC_HEIGHT_FRONT, RC_HEIGHT_REAR, H_ROLL, TRACK,
} from './suspension.js';

export { TRACK_HALF } from './constants.js';

const FZ_MIN = 200;

/** Aero split, front/rear. Superseded by aero.js once ride height drives it. */
export const AERO_SPLIT_FRONT = 0.4;

/**
 * The bracket terms above, precomputed. Front and rear together equal `H_CG`,
 * which is what conserves total transfer.
 */
export const LATERAL_ARM_FRONT =
  ROLL_STIFFNESS_FRONT_SHARE * H_ROLL + (LR / WB) * RC_HEIGHT_FRONT;
export const LATERAL_ARM_REAR =
  (1 - ROLL_STIFFNESS_FRONT_SHARE) * H_ROLL + (LF / WB) * RC_HEIGHT_REAR;

/** Front share of lateral load transfer. The balance lever, as one number. */
export const LATERAL_TRANSFER_FRONT_SHARE =
  LATERAL_ARM_FRONT / (LATERAL_ARM_FRONT + LATERAL_ARM_REAR);

/**
 * Four-corner normal loads from longitudinal/lateral acceleration and aero.
 *
 * @param {number} axPrev longitudinal accel at CoG [m/s²], + forward
 * @param {number} ayPrev lateral accel at CoG [m/s²], + right
 * @param {number} aeroLift total downforce [N]
 * @param {number} aeroSplitFront fraction of downforce on the front axle
 * @returns {[number, number, number, number]} Fz FL, FR, RL, RR
 */
export function wheelNormalLoads(
  axPrev, ayPrev, aeroLift, aeroSplitFront = AERO_SPLIT_FRONT, tune = null,
) {
  // The arms are what the roll-stiffness setting moves, so they come from the
  // setup when there is one. Without one, the baseline constants.
  const armFront = tune?.lateralArmFront ?? LATERAL_ARM_FRONT;
  const armRear = tune?.lateralArmRear ?? LATERAL_ARM_REAR;
  const mass = tune?.mass ?? MASS;
  const fzStaticF = mass * G * LR / WB;
  const fzStaticR = mass * G * LF / WB;

  const deltaLong = (mass * axPrev * H_CG) / WB;
  const fzF = fzStaticF - deltaLong + aeroSplitFront * aeroLift;
  const fzR = fzStaticR + deltaLong + (1 - aeroSplitFront) * aeroLift;

  // Split by roll stiffness rather than evenly. A positive `ayPrev` is rightward
  // acceleration, which loads the left-hand wheels — the outside of a right turn.
  const q = (mass * ayPrev) / TRACK;
  const deltaLatF = q * armFront;
  const deltaLatR = q * armRear;

  return [
    Math.max(FZ_MIN, fzF / 2 + deltaLatF),
    Math.max(FZ_MIN, fzF / 2 - deltaLatF),
    Math.max(FZ_MIN, fzR / 2 + deltaLatR),
    Math.max(FZ_MIN, fzR / 2 - deltaLatR),
  ];
}

/** Total lateral transfer, for the invariant test and for telemetry. */
export function totalLateralTransfer(ay) {
  return (MASS * ay * H_CG) / TRACK;
}

export { TRACK };
