/**
 * The rival's driver. Emits the same input object the keyboard does.
 *
 * That constraint is the whole design: the AI gets no privileged access to the
 * physics, so anything it can do the player can do, and a change to the car
 * changes both of them identically. It steers by pure pursuit against the
 * racing line and plans speed from the curvature ahead.
 *
 * Two traps, both already paid for in `lap.test.js`:
 *
 *   - The steering target must be normalised by the lock available AT THIS
 *     SPEED, not the lock at rest. `steerSmooth` is a fraction of the current
 *     lock, so dividing by the rest value asks for a road-wheel angle 2.5x too
 *     small at 150 km/h and the car quietly runs wide.
 *   - Braking must be PLANNED at well under the car's peak. Planning at the
 *     3 g the car can actually pull arrives at the Village and Loop hairpins
 *     far too fast, because braking continues into corner entry where the
 *     friction circle is already spending grip on turning.
 *
 * Pure and allocation-free: `out` is mutated in place.
 */

import { WB, G } from '../physics/constants.js';
import { maxSteerAt } from '../physics/driver.js';
import { forwardSpeed } from '../physics/vehicle.js';
import { nearestOnLine } from './racingLine.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const wrap = a => {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
};

/**
 * Levels scale the DRIVER's budget, never the car. The rival is always in the
 * same machine the player is and simply uses less of it.
 *
 * `latG` and `brakeG` are planning figures, deliberately under the car's true
 * limit for the reason in the header.
 *
 * These numbers are not free to move independently. Sweeping `latG` at a
 * fixed `brakeG` ratio (below) turns up a narrow, chaotic instability band
 * starting around 1.46 g and getting worse through 1.50-1.55 before a small
 * partial recovery — a specific corner (one of the surveyed hairpins) sits
 * right at the edge of available grip there, and a hundredth of a g either
 * side is the difference between a clean 0%-off-road lap and the car
 * spending double-digit to 50%+ of a run stuck in the scenery. This band has
 * not moved across two rounds of fixes to the speed planner below — onset is
 * still ~1.46 g, with the sweep numbers matching to within 0.1 s and 0.1
 * percentage points before and after both fixes — so it is a property of the
 * corner and the braking/steering model, not an artefact of either bug.
 * `ace` is set at 1.44, with deliberate margin below that cliff rather than
 * pushed up against it, so it stays robust to the small aim-point nudges the
 * defend/avoid logic adds when a rival is nearby.
 *
 * MEASURED best lap over 420 s on the shipped Silverstone circuit, 0% of
 * every run spent off the road (throwaway calibration script, re-run after
 * any change to the driver, the racing line, or the car):
 *
 *     club   157.5 s   latG 1.00   brakeG 1.25   topSpeed 70   reaches 100.1% of topSpeed
 *     pro    144.8 s   latG 1.25   brakeG 1.56   topSpeed 85   reaches  94.7% of topSpeed
 *     ace    137.8 s   latG 1.44   brakeG 1.80   topSpeed 92   reaches  88.2% of topSpeed
 *
 * `lap.test.js` records ~131 s for a flat-out quasi-static planner and ~150 s
 * for a cautious one. `pro` sits in the cautious band; `ace`, held back from
 * the instability cliff, lands about 7 s off the flat-out figure rather than
 * matching it, and CANNOT currently be brought closer: pushing `brakeG` up
 * (to shorten the braking phase and hold speed longer) does not help — it
 * shrinks the planning horizon (see `HORIZON_PAD` below) and pushes `ace`
 * straight into the instability band instead of gaining pace. That gap is
 * reported plainly rather than tuned away.
 *
 * `pro` and `ace` reaching under 100% of their own `topSpeed` is real and
 * was checked directly, not assumed: re-running each with `topSpeed` raised
 * far past 92 (100, 120, 150 — nothing on the circuit is that fast) leaves
 * the speed actually reached UNCHANGED to the decimetre (`ace`: 81.2 m/s at
 * every one of those caps; `pro`: 80.5 m/s at every one). Neither level is
 * being held back by its own `topSpeed` value or by anything left over from
 * the two speed-planner bugs fixed in this module's history (see the
 * `driveAi` comment) — the ceiling is Silverstone's longest straight and the
 * car's own acceleration curve, which no driver-side number changes. `club`
 * alone reaches ~100% because its cap (70) sits below that real ceiling
 * everywhere on the lap; `pro` and `ace` do not, and no amount of retuning
 * `latG`/`brakeG`/`topSpeed` within the stable range closes that gap further.
 */
export const DIFFICULTY = {
  club: { id: 'club', label: 'Club', latG: 1.00, brakeG: 1.25, topSpeed: 70 },
  pro:  { id: 'pro',  label: 'Pro',  latG: 1.25, brakeG: 1.56, topSpeed: 85 },
  ace:  { id: 'ace',  label: 'Ace',  latG: 1.44, brakeG: 1.80, topSpeed: 92 },
};

export const DIFFICULTY_ORDER = ['club', 'pro', 'ace'];

/** How far ahead the speed planner looks, beyond the braking distance, m. */
const HORIZON_PAD = 30;
/** Pure-pursuit lookahead: metres, and seconds of travel. */
const LOOKAHEAD_MIN = 12;
const LOOKAHEAD_TIME = 0.9;
/** Deadband on the steering servo, in fractions of available lock. */
const STEER_DEADBAND = 0.02;
/** Lift off if the car is already using this much of its cornering budget. */
const LATERAL_LIFT = 0.55;
/** Brake once this much over the target speed. */
const BRAKE_MARGIN = 1.05;

/**
 * Defending: bias the aim point toward the inside when a car is close behind.
 * Bounded hard — this is racecraft, not blocking, and an unbounded version
 * simply drives the rival off its own line.
 */
export const DEFEND_MAX_OFFSET = 1.6;
export const DEFEND_RANGE = 25;
/** Keep at least this much clear of a car alongside, m. */
export const ALONGSIDE_CLEARANCE = 2.4;

export function createAiState(levelId = 'pro') {
  return { level: DIFFICULTY[levelId] ? levelId : 'pro', hint: 0, aim: 0 };
}

/**
 * @param {ReturnType<typeof createAiState>} ai mutated: carries the line cursor
 * @param {object} car a vehicle from `createVehicle`
 * @param {object} line from `buildRacingLine`
 * @param {{forward:boolean,reverse:boolean,left:boolean,right:boolean,brake:boolean}} out
 * @param {{x:number,z:number,lateralGap:number,aheadGap:number}|null} [rival]
 * @returns {typeof out}
 */
export function driveAi(ai, car, line, out, rival = null) {
  const level = DIFFICULTY[ai.level] ?? DIFFICULTY.pro;
  const n = line.x.length;
  const v = Math.max(forwardSpeed(car), 1);

  const here = nearestOnLine(line, car.x, car.z, ai.hint);
  ai.hint = here;

  // --- speed: the slowest thing between here and a braking distance ahead ---
  const brakeA = level.brakeG * 9.81;
  const horizon = Math.round((HORIZON_PAD + (v * v) / (2 * brakeA)) / line.spacing);
  const step = Math.max(1, Math.round(4 / line.spacing));
  // Corner speed comes from `line.curvature`, not `line.speed`. `line.speed`
  // is precomputed at LINE_LAT_G *and* the line's own 92 m/s constant baked
  // in for the straights (curvature ~ 0 there, so `line.speed[i]` is just
  // that cap, carrying no curvature information at all) — it is a
  // convenience for whoever built the line, not a value this driver should
  // consume. An earlier version of this function multiplied `line.speed[i]`
  // by a cornering ratio meant to convert from LINE_LAT_G to this level's own
  // `latG`; that ratio landed on the baked-in 92 m/s cap on every straight
  // exactly as if it were curvature-derived, silently capping `pro` at 95.6%
  // of its own topSpeed and `ace` at 94.9% (`sqrt(latG/LINE_LAT_G)` evaluated
  // at the straight). Recomputing the corner limit directly from curvature
  // with THIS level's own `latG` and `topSpeed` — never referencing the
  // line's LINE_LAT_G or its 92 m/s constant — removes the category error
  // instead of relocating it. Do not reach for `line.speed` here again.
  let target = level.topSpeed;
  for (let d = 0; d < horizon; d += step) {
    const i = (here + d) % n;
    const cornerV = line.curvature[i] < 1e-6
      ? level.topSpeed
      : Math.min(level.topSpeed, Math.sqrt(level.latG * G / line.curvature[i]));
    // Speed we may be doing HERE and still slow to cornerV by then.
    const allowed = Math.sqrt(cornerV * cornerV + 2 * brakeA * d * line.spacing);
    if (allowed < target) target = allowed;
  }

  // --- steering: pure pursuit to a point on the line ahead ---
  const lookahead = Math.max(LOOKAHEAD_MIN, LOOKAHEAD_TIME * v);
  const ahead = (here + Math.max(1, Math.round(lookahead / line.spacing))) % n;
  let aimX = line.x[ahead];
  let aimZ = line.z[ahead];

  if (rival) {
    const bias = defendBias(rival);
    if (bias !== 0) {
      // Push the aim point sideways, along the local line normal.
      const nx = -(line.z[(ahead + 1) % n] - line.z[ahead]);
      const nz = (line.x[(ahead + 1) % n] - line.x[ahead]);
      const len = Math.hypot(nx, nz) || 1;
      aimX += (nx / len) * bias;
      aimZ += (nz / len) * bias;
    }
    const keep = alongsideAvoid(car, rival);
    if (keep !== 0) {
      const nx = -(line.z[(ahead + 1) % n] - line.z[ahead]);
      const nz = (line.x[(ahead + 1) % n] - line.x[ahead]);
      const len = Math.hypot(nx, nz) || 1;
      aimX += (nx / len) * keep;
      aimZ += (nz / len) * keep;
    }
  }

  const dx = aimX - car.x;
  const dz = aimZ - car.z;
  const dist = Math.max(Math.hypot(dx, dz), 1);
  const err = wrap(Math.atan2(-dx, -dz) - car.yaw);
  const steer = Math.atan(WB * 2 * Math.sin(err) / dist);

  // Normalised by the lock at THIS speed. steerSmooth is negative for a left turn.
  const want = clamp(-steer / maxSteerAt(v), -1, 1);
  out.left = car.steerSmooth > want + STEER_DEADBAND;
  out.right = car.steerSmooth < want - STEER_DEADBAND;

  // --- pedals ---
  const lateralUse = Math.abs(car.av) * v / (level.latG * 9.81);
  out.forward = v < target && lateralUse < LATERAL_LIFT;
  out.brake = v > target * BRAKE_MARGIN;
  out.reverse = false;
  return out;
}

/** Inside bias when a car is close behind, tapering to nothing by DEFEND_RANGE. */
export function defendBias(rival) {
  if (!rival || rival.aheadGap >= 0) return 0;          // not behind us
  const gap = -rival.aheadGap;
  if (gap > DEFEND_RANGE) return 0;
  const closeness = 1 - gap / DEFEND_RANGE;
  // Move toward the side the follower is on, to cover the inside.
  return clamp(Math.sign(rival.lateralGap) * closeness * DEFEND_MAX_OFFSET,
    -DEFEND_MAX_OFFSET, DEFEND_MAX_OFFSET);
}

/** Push away from a car alongside; zero once there is room. */
export function alongsideAvoid(car, rival) {
  const dx = rival.x - car.x;
  const dz = rival.z - car.z;
  const dist = Math.hypot(dx, dz);
  if (dist > ALONGSIDE_CLEARANCE || dist < 1e-6) return 0;
  const deficit = ALONGSIDE_CLEARANCE - dist;
  return -Math.sign(rival.lateralGap || 1) * deficit;
}
