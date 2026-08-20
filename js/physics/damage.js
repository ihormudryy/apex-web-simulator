/**
 * Damage: what a wall costs.
 *
 * The rule that shapes everything here is that damage must arrive through the
 * same channels the physics already listens to — grip, aero, alignment, torque —
 * so a damaged car is not a flag that says "drive badly", it is a car whose
 * front wing is missing and whose left-rear toe link is bent, behaving exactly
 * as those facts imply. The plan's phrase for effects was "one model, two
 * outputs"; damage is the same idea run backwards.
 *
 * Four systems, each 0..1, each living in the state vector so a replayed crash
 * is still a crash:
 *
 *   - **Front wing** — nose impacts. Costs front downforce, so the felt symptom
 *     is high-speed understeer that was not there before the hit.
 *   - **Floor** — scraping and side impacts. Costs floor downforce and adds
 *     drag.
 *   - **Suspension, per corner** — corner impacts. Bends alignment (the car
 *     pulls), costs that tyre's grip, and at 1.0 the corner is broken: the
 *     wheel jams, and the car is effectively over.
 *
 * The kernel goes terminal — engine cut — when a corner breaks or the total
 * passes `TERMINAL_TOTAL`. Esc (reset) repairs, as it already restores
 * everything else.
 */

import * as ST from './state.js';

/** Below this closing speed a touch is cosmetic. m/s into the wall. */
export const IMPACT_FREE = 1.5;
/**
 * Scaling: a 15 m/s (54 km/h) normal hit on the nose takes about half the wing;
 * a 25 m/s hit breaks whatever it lands on outright. Quadratic in the closing
 * speed past the free threshold, because impact energy is.
 */
export const WING_SEVERITY_FULL = 19;
export const SUSPENSION_SEVERITY_FULL = 22;
export const FLOOR_SEVERITY_FULL = 30;

/** Scraping along the wall sands the floor and bodywork down slowly. */
export const SCRAPE_RATE = 0.010;          // damage per second at 10 m/s of scrape

/** How much a dead system costs. */
export const WING_CLA_LOSS = 0.85;         // of the front wing's ClA
export const FLOOR_CLA_LOSS = 0.45;        // of the floor's ClA
export const FLOOR_CDA_GAIN = 0.22;        // broken bodywork is a parachute
export const WHEEL_GRIP_LOSS = 0.55;       // of that corner's grip
export const TOE_PULL = 0.05;              // rad of alignment error at full damage

/** The car is finished past this, or when any corner reaches 1. */
export const TERMINAL_TOTAL = 2.4;

const clamp01 = v => Math.max(0, Math.min(1, v));
const sq = v => v * v;

/**
 * Apply one impact to the state vector.
 *
 * @param {Float64Array} S the car's state
 * @param {number} severity closing speed into the wall, m/s
 * @param {number} corner 0 nose-left, 1 nose-right, 2 tail-left, 3 tail-right
 * @returns {number} total damage added, for effects and the HUD
 */
export function applyImpact(S, severity, corner) {
  if (!(severity > IMPACT_FREE) || corner < 0) return 0;
  const over = severity - IMPACT_FREE;
  const isNose = corner < 2;
  // The impacted corner maps to the wheel on that corner of the car.
  const wheel = isNose ? corner : corner;   // FL,FR,RL,RR share the ordering

  let added = 0;
  if (isNose) {
    const d = sq(over / (WING_SEVERITY_FULL - IMPACT_FREE));
    added += bump(S, ST.S_DMG_WING, d);
  } else {
    // Tail hits work the floor and diffuser as well as the corner.
    const d = sq(over / (FLOOR_SEVERITY_FULL - IMPACT_FREE));
    added += bump(S, ST.S_DMG_FLOOR, d);
  }
  const ds = sq(over / (SUSPENSION_SEVERITY_FULL - IMPACT_FREE));
  added += bump(S, ST.S_DMG_WHEEL + wheel, ds);
  return added;
}

/** Scraping along the wall, applied per step. */
export function applyScrape(S, scrapeSpeed, dt) {
  if (!(scrapeSpeed > 0.5)) return 0;
  return bump(S, ST.S_DMG_FLOOR, SCRAPE_RATE * (scrapeSpeed / 10) * dt);
}

function bump(S, index, amount) {
  const before = S[index];
  S[index] = clamp01(before + amount);
  return S[index] - before;
}

/** Total damage, 0..6. */
export function totalDamage(S) {
  return S[ST.S_DMG_WING] + S[ST.S_DMG_FLOOR]
    + S[ST.S_DMG_WHEEL] + S[ST.S_DMG_WHEEL + 1]
    + S[ST.S_DMG_WHEEL + 2] + S[ST.S_DMG_WHEEL + 3];
}

/** Finished: a broken corner, or enough accumulated that nothing works. */
export function isTerminal(S) {
  for (let i = 0; i < 4; i++) {
    if (S[ST.S_DMG_WHEEL + i] >= 1) return true;
  }
  return totalDamage(S) >= TERMINAL_TOTAL;
}

/**
 * The physics-facing effects, written into `out` so the kernel allocates
 * nothing. Every field is a modifier on a channel the kernel already has.
 */
export function damageEffects(S, out) {
  out.wingScale = 1 - WING_CLA_LOSS * S[ST.S_DMG_WING];
  out.floorScale = 1 - FLOOR_CLA_LOSS * S[ST.S_DMG_FLOOR];
  out.cdaExtra = FLOOR_CDA_GAIN * S[ST.S_DMG_FLOOR];
  for (let i = 0; i < 4; i++) {
    const d = S[ST.S_DMG_WHEEL + i];
    out.gripScale[i] = 1 - WHEEL_GRIP_LOSS * d;
    // Bent alignment: toe error pulling toward the damaged side. Left wheels
    // (negative body y) toe the car left; right wheels right.
    out.toe[i] = TOE_PULL * d * (i % 2 === 0 ? 1 : -1);
    out.locked[i] = d >= 1;
  }
  out.terminal = isTerminal(S);
  return out;
}

export function createDamageEffects() {
  return {
    wingScale: 1,
    floorScale: 1,
    cdaExtra: 0,
    gripScale: [1, 1, 1, 1],
    toe: [0, 0, 0, 0],
    locked: [false, false, false, false],
    terminal: false,
  };
}
