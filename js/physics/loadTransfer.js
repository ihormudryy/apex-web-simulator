import { G, H_CG, LF, LR, MASS, WB } from './constants.js';

/** Track half-width — centre of each tyre from the car centreline [m]. */
export const TRACK_HALF = 0.8;

const FZ_MIN = 200;

/**
 * Four-corner normal loads from longitudinal/lateral acceleration and aero.
 *
 * @param {number} axPrev longitudinal accel at CoG [m/s²], + forward
 * @param {number} ayPrev lateral accel at CoG [m/s²], + right
 * @param {number} aeroLift total downforce [N]
 * @returns {[number, number, number, number]} Fz FL, FR, RL, RR
 */
export function wheelNormalLoads(axPrev, ayPrev, aeroLift) {
  const fzStaticF = MASS * G * LR / WB;
  const fzStaticR = MASS * G * LF / WB;

  const deltaLong = (MASS * axPrev * H_CG) / WB;
  const fzF = fzStaticF - deltaLong + 0.4 * aeroLift;
  const fzR = fzStaticR + deltaLong + 0.6 * aeroLift;

  const deltaLat = (MASS * ayPrev * H_CG) / (2 * TRACK_HALF);
  return [
    Math.max(FZ_MIN, fzF / 2 + deltaLat),
    Math.max(FZ_MIN, fzF / 2 - deltaLat),
    Math.max(FZ_MIN, fzR / 2 + deltaLat),
    Math.max(FZ_MIN, fzR / 2 - deltaLat),
  ];
}
