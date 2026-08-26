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
 * These numbers are not free to move independently, and the interaction is
 * NOT a simple threshold. Sweeping `latG` from 1.30 to 1.47 g in 0.01 steps,
 * driving 200 s solo laps, twice — once scaling `brakeG` with `latG`, once
 * holding `brakeG` at `ace`'s shipped 1.80 — turns up scattered unstable
 * notches spread across the WHOLE range, not a threshold with safe territory
 * below it:
 *
 *     brakeG scaled with latG:   unstable at 1.41 (85.8% off-road),
 *                                1.45 (3.0%). 1.40 clean.
 *     brakeG held at 1.80:       unstable at 1.34 (6.5%), 1.36 (4.0%),
 *                                1.37 (85.6%), 1.40 (16.7%), 1.43 (12.8%),
 *                                1.45 (17.2%).
 *
 * Both sweeps are CLEAN at 1.46 AND 1.47 — there is no cliff at 1.46, despite
 * `INSTABILITY_CLIFF_G` below being set to that value. `ace`'s 1.44 is not
 * "0.02 g of margin below a cliff" — it is a lucky clean notch that happens
 * to survive both sweep methods, which is the actual reason it has passed
 * every check on this branch. Which values are unstable even depends on
 * whether `brakeG` scales with `latG` — an incidental methodology choice —
 * which is the signature of a fragile nonlinear interaction between the
 * braking/steering model and specific corner geometry, NOT a grip limit with
 * a clean boundary. The underlying instability is UNDIAGNOSED: located and
 * avoided by picking a notch that measures clean, not understood. Any future
 * change to the car, the tyres, the racing line, or the circuit can reshuffle
 * which values are clean, so these constants must be re-swept before being
 * trusted again, not assumed to still hold.
 *
 * `defendBudget` below computes a level's "headroom" as `1.46 - latG` and
 * scales the defend/avoid budget down as that headroom shrinks, on the
 * premise that less headroom means less safety margin. That premise is FALSE
 * by the sweep data above: 1.34 g and 1.37 g have far MORE headroom under
 * 1.46 than `ace`'s 1.44 g, yet both are badly unstable (6.5% and 85.6%
 * off-road) while `ace` is clean. `defendBudget` is a CONSERVATIVE HEURISTIC,
 * not a derivation from a known safety boundary — it happens to floor
 * `ace`'s budget to zero, and that specific outcome was checked empirically
 * (below), but the "headroom under 1.46" reasoning it is built on does not
 * actually track which values are stable.
 *
 * That heuristic exists because of a real, measured failure: with a rival
 * present (a follower one car-width to the side, gap breathing 3-9 m, the
 * commonest race position), the unscaled defend/avoid aim-point nudge put
 * `ace` off the road in 4 of 10 realistic configurations — 2 of those at
 * 84-86% of the run, the other 2 at 18.8% and 1.6% — all beginning at the
 * same corner ~29 s in, and none of the 4 ever recovered once off — an
 * absorbing state, not a wobble, since `driveAi` never sets `reverse`.
 * `defendBudget` fixes that, verifiably: `pro` was measured clean — 0%
 * off-road — at the FULL `DEFEND_MAX_OFFSET` budget across every one of the
 * reviewer's ten realistic-chase configurations, so `pro`'s figure is known
 * safe under that specific test, whatever the reason. `ace`'s 0.02 g
 * "headroom" (9.5% of `pro`'s) falls below the heuristic's usable floor, so
 * it gets NO defend/avoid nudge at all — while `pro` and `club` keep the
 * full budget. See `aiDriver.test.js`'s "with a rival present" test, which
 * drives every difficulty through this exact scenario and is what should
 * have caught the original failure before it shipped.
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
 * for a cautious one. `pro` sits in the cautious band; `ace`, held at a
 * `latG`/`brakeG` pair chosen because it measures clean rather than because
 * it is close to some known limit, lands about 7 s off the flat-out figure
 * rather than matching it, and CANNOT currently be brought closer: pushing
 * `brakeG` up (to shorten the braking phase and hold speed longer) does not
 * help — it shrinks the planning horizon (see `HORIZON_PAD` below), and per
 * the sweep data above the nearby values are as likely to land on one of the
 * scattered unstable notches as to gain pace. That gap is reported plainly
 * rather than tuned away.
 *
 * `pro` and `ace` reaching under 100% of their own `topSpeed` is real and
 * was checked directly, not assumed: re-running each with `topSpeed` raised
 * far past 92 (100, 120, 150 — nothing on the circuit is that fast) leaves
 * the speed actually reached UNCHANGED to the decimetre (`ace`: 81.2 m/s at
 * every one of those caps; `pro`: 80.5 m/s at every one). Neither level is
 * being held back by its own `topSpeed` value or by anything left over from
 * the two speed-planner bugs fixed in this module's history (see the
 * `driveAi` comment) — raising `topSpeed` far past the real cap and seeing no
 * change only rules out topSpeed-coupling, though; it cannot distinguish
 * Silverstone's longest straight and the car's own acceleration curve from
 * conservatism in the planner's own braking horizon (`HORIZON_PAD` below) as
 * the reason `pro`/`ace` fall short of it, so that split is asserted, not
 * measured. `club` alone reaches ~100% because its cap (70) sits below the
 * real ceiling everywhere on the lap; `pro` and `ace` do not, and no amount
 * of retuning `latG`/`brakeG`/`topSpeed` within the stable range closes that
 * gap further.
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
 * simply drives the rival off its own line. "Bounded" alone is not the same
 * as "safe": see `defendBudget` — `DEFEND_MAX_OFFSET` is a per-effect cap, not
 * a guarantee about what the combined defend+avoid nudge does to a level
 * whose own `latG` sits on one of the scattered unstable notches documented
 * on `DIFFICULTY` above.
 */
export const DEFEND_MAX_OFFSET = 1.6;
export const DEFEND_RANGE = 25;
/** Keep at least this much clear of a car alongside, m. */
export const ALONGSIDE_CLEARANCE = 2.4;

/**
 * NOT a validated instability threshold, despite the name — see the sweep
 * data on `DIFFICULTY` above. Both 1.46 and 1.47 measured CLEAN in every
 * sweep run; the unstable values are scattered across the whole 1.30-1.47
 * range instead, and which ones are unstable depends on whether `brakeG`
 * scales with `latG` in the sweep. This value is kept because it is the
 * anchor `defendBudget` already shipped with: it is what makes `ace`'s
 * computed "headroom" come out at 0.02 g, small enough to floor its budget
 * to zero — and THAT specific outcome (ace gets zero, pro/club keep full
 * budget) was checked empirically, see `aiDriver.test.js`'s "with a rival
 * present" test. It is not evidence that grip runs out at 1.46 g; treat the
 * name as legacy of the incorrect cliff model this constant was designed
 * under, not as a fact about the car.
 */
const INSTABILITY_CLIFF_G = 1.46;
/**
 * `pro`'s gap under `INSTABILITY_CLIFF_G` (0.21 g), used as the calibration
 * reference for `defendBudget` below. This is NOT "0.21 g of headroom makes
 * `pro` safe" — the sweep data on `DIFFICULTY` above shows levels with far
 * MORE of this gap (1.34 g, 1.37 g) that are badly unstable. It is simply the
 * fact that `pro` was measured clean — 0% off-road — at the FULL
 * `DEFEND_MAX_OFFSET` budget across every one of the reviewer's ten
 * realistic-chase configurations. `defendBudget` uses this as an anchor for a
 * conservative heuristic, not as proof that this gap predicts stability.
 */
const CALIBRATED_HEADROOM_G = INSTABILITY_CLIFF_G - DIFFICULTY.pro.latG;

/**
 * Below this fraction of `CALIBRATED_HEADROOM_G`, `defendBudget` floors to
 * zero instead of asymptoting toward it. This is a heuristic knob tuned to
 * one known failure, not a derived safety threshold — see `DIFFICULTY`'s
 * header for why "headroom under `INSTABILITY_CLIFF_G`" does not actually
 * track instability in general. Measured: even a ~1 cm constant offset (from
 * scaling the budget by headroom² instead of flooring it below this
 * fraction) eventually tipped `ace` off the same corner, at the same time,
 * regardless of how the follower's gap moved — because a rival within
 * `DEFEND_RANGE` saturates `defendBias` at its clamp for almost the entire
 * time a follower is present, so the "small" nudge a smooth scale leaves
 * behind is not small in duration, only in amplitude. The floor exists to
 * zero that residual for the one case that broke, `ace`; it is not derived
 * from a general grip-margin argument.
 */
const MIN_USABLE_HEADROOM_FRACTION = 0.25;

/**
 * Total defend+avoid aim-point offset a level is allowed, in metres.
 *
 * C1: the unscaled nudge (up to `DEFEND_MAX_OFFSET` from defending, plus more
 * from `alongsideAvoid`) was enough to walk `ace` — sitting on a `latG` that
 * turned out to be one of the scattered unstable notches once nudged off its
 * measured-clean line, not on some known edge of grip — into an absorbing
 * off-road state (see `DIFFICULTY` above for the sweep data). There is no
 * known metres-to-g conversion for the nudge, and no validated grip boundary
 * to convert against: the instability is UNDIAGNOSED, located and avoided by
 * sweeping, not understood. Absent that, this scales the budget by
 * `1.46 - latG` relative to `pro`'s same figure: full budget at `pro`'s
 * figure or more, shrinking linearly down to `MIN_USABLE_HEADROOM_FRACTION`,
 * then floored to zero. This is a CONSERVATIVE HEURISTIC, not a derivation
 * from a known safety boundary — the sweep data shows levels with MORE of
 * this "headroom" (1.34 g, 1.37 g) that are badly unstable, so headroom
 * under 1.46 does not actually predict stability. It happens to floor
 * `ace`'s budget to zero, and THAT specific outcome is verified empirically,
 * not just by construction — see `aiDriver.test.js`'s "with a rival present"
 * test, which runs the same realistic-chase scenario that broke `ace` before
 * this fix, at every level. Treat this function as "known to zero `ace`'s
 * budget and keep `pro`/`club` at full budget, and nothing more" — not as a
 * physically-grounded margin calculation.
 */
function defendBudget(level) {
  const headroom = Math.max(0, INSTABILITY_CLIFF_G - level.latG);
  const fraction = headroom / CALIBRATED_HEADROOM_G;
  if (fraction < MIN_USABLE_HEADROOM_FRACTION) return 0;
  return DEFEND_MAX_OFFSET * clamp(fraction, 0, 1);
}

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
  const brakeA = level.brakeG * G;
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
    // Defending and avoiding both push the same aim point along the same
    // normal, so it is their SUM that matters to stability, not either one
    // bounded in isolation — clamp the combined offset to this level's
    // headroom-scaled budget (see `defendBudget`) so no combination of the
    // two effects can walk a level onto one of the scattered unstable
    // notches documented on `DIFFICULTY` above.
    const total = clamp(defendBias(rival) + alongsideAvoid(car, rival),
      -defendBudget(level), defendBudget(level));
    if (total !== 0) {
      // Push the aim point sideways, along the local line normal.
      const nx = -(line.z[(ahead + 1) % n] - line.z[ahead]);
      const nz = (line.x[(ahead + 1) % n] - line.x[ahead]);
      const len = Math.hypot(nx, nz) || 1;
      aimX += (nx / len) * total;
      aimZ += (nz / len) * total;
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
  const lateralUse = Math.abs(car.av) * v / (level.latG * G);
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
