/**
 * Ground-effect aerodynamics, 2022–2026.
 *
 * This is the defining characteristic of the era, and the thing that makes the car
 * feel modern rather than like an older car with new paint. On these cars the
 * floor and diffuser generate the majority of the downforce, and that contribution
 * is a strong, **non-monotonic** function of ride height: as the floor approaches
 * the ground the venturi accelerates the flow and downforce rises — until the
 * underbody stalls, and it collapses.
 *
 * Three things follow from modelling it that way rather than as a constant:
 *
 *   - **Aero balance moves on its own.** Separate front and rear contributions,
 *     each on its own ride height, means the centre of pressure travels with
 *     pitch, rake and speed. That is why the car understeers into a fast corner
 *     under braking, and it is most of what the car tells the driver as speed
 *     rises. A single lumped downforce number cannot express any of it.
 *
 *   - **Porpoising emerges.** Couple a ride-height-dependent ClA to a real
 *     suspension and the 2022 season's signature instability appears without
 *     being asked for: more downforce, lower ride height, more downforce, the
 *     floor stalls, downforce collapses, the car rises, the flow reattaches, and
 *     round again at 5–10 Hz. This makes an unusually good self-check — if
 *     porpoising does *not* appear at speed on a stiff setup, something is being
 *     applied as a constant somewhere.
 *
 *     It needs one thing beyond the ride-height curve, though, and it is easy to
 *     miss: the **aerodynamic lag**. With downforce responding instantaneously to
 *     ride height, the curve's negative stiffness can only produce two outcomes —
 *     if it exceeds the suspension rate the car slams onto the plank and stays
 *     there, and if it does not, the car settles quietly. Neither is a limit
 *     cycle. What makes it oscillate is that the underbody flow takes time to
 *     respond: the floor is ~3 m long, so at 320 km/h the flow field needs ~35 ms
 *     to re-establish, and separation happens faster than reattachment. That
 *     phase lag is what pumps the cycle.
 *
 *   - **Sparks and the plank are physics, not an effect.** The ride-height model
 *     already knows when the floor is on the ground.
 *
 * The sharpness of the stall is the point. A linear ClA gives you a fast car, not
 * a ground-effect car.
 */

import { RHO, WB, LF, LR } from './constants.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---------------------------------------------------------------------------
// Coefficients
// ---------------------------------------------------------------------------

/**
 * Downforce is split into a wing part, which barely cares about ride height, and
 * a floor part, which cares about almost nothing else.
 *
 * Sized so that at the ride heights the car actually settles at, total ClA comes
 * out near 4.6 — the value the reference downforce figures were built on — while
 * the *maximum* is higher, because the car is never quite at the optimum on both
 * axles at once. That gap is where the balance movement lives.
 */
/**
 * The front/rear split sets the aero balance, and the balance was the biggest
 * measured realism gap left in the car: ~40% front at speed where a real 2022
 * car runs 44-46%, with the front axle saturating (1.00 of its capability used
 * against the rear's 0.63) while a third of the rear's grip went untouched.
 * Terminal high-speed understeer, and no setup lever could reach it because the
 * wings are what set the split.
 *
 * The front wing was 0.55, and 0.65 is a measured bound, not a preference. Two
 * sweeps disagree about where the edge is and the stricter one wins:
 *
 * Steady-state cornering says go to 0.85 — peak lateral improves at every speed
 * up to there (2.42/3.39 g at 150/250 km/h becomes 2.53/3.64) and only collapses
 * beyond 1.0. But the TRANSIENT is the binding constraint: braking drops the
 * front ride height, the front floor gains, and the balance runs further forward
 * exactly when the driver is turning in. Trail-braking sideslip against the
 * wing, measured:
 *
 *     wingF   trail-brake sideslip   1.4 g autopilot lap
 *      0.55        3.0 deg              clean, 7 deg max
 *      0.65        6.5 deg              clean, 9 deg max     <- here
 *      0.70       10.4 deg              clean, 13 deg max
 *      0.75       14.2 deg              lurid, 16 deg max
 *      0.85       20.1 deg              SPINS, 16% off road
 *
 * Real corner-entry rotation is a few degrees of sideslip; 10+ is a moment and
 * 20 is a spin a keyboard cannot catch. 0.65 doubles the entry rotation — the
 * pointiness on the brakes these cars are known for — and keeps it catchable.
 *
 * Two directions that measured worse, kept so nobody retries them blind: taking
 * the shift out of the REAR wing collapses the car at speed (2.55 g at 150 but
 * 1.59 at 250 — the rear needs its downforce), and going past ~0.70 buys 1-2% of
 * skid-pad grip for entry behaviour a driver cannot use. The residual balance
 * gap to a real car's 44-46% is not reachable by wing split alone in this model;
 * it needs more rear axle authority (grip or yaw damping) first.
 */
export const CLA_WING_FRONT = 0.65;
export const CLA_FLOOR_FRONT = 1.55;
export const CLA_WING_REAR = 1.05;
export const CLA_FLOOR_REAR = 1.85;

/**
 * Ride height at which each end of the floor works best, m.
 *
 * These sit *inside* the range the car operates in, which is what allows the
 * front to cross into stall at speed. Put them below the operating range and the
 * floor curve is monotonic in practice, porpoising never appears, and the whole
 * model reduces to a slightly curved constant.
 */
export const H_OPT_FRONT = 0.012;
export const H_OPT_REAR = 0.038;
/** How far below the optimum the floor takes to stall completely, m. */
export const H_STALL_FRONT = 0.010;
export const H_STALL_REAR = 0.022;
/** How fast the floor gains as it approaches the optimum from above. */
export const VENTURI_EXPONENT = 0.5;

/**
 * Aerodynamic lag.
 *
 * The floor's flow field does not follow ride height instantly — the length of
 * the underbody has to re-establish, which takes roughly `L / v`. At 320 km/h
 * that is about 35 ms.
 *
 * Separation is faster than reattachment, by roughly a factor of three. That
 * asymmetry is not decoration: a symmetric lag stores and returns energy, where an
 * asymmetric one pumps it, and pumping is what sustains the cycle rather than
 * letting the dampers eat it.
 */
export const AERO_LAG_LENGTH = 3.2;
export const REATTACH_LAG_FACTOR = 3.0;

/** Drag. Body, rear wing (which DRS opens), and lift-induced. */
export const CDA_BODY = 0.75;
export const CDA_REAR_WING = 0.30;
export const CDA_REAR_WING_DRS = 0.16;
export const CDA_INDUCED_K = 0.0236;

/**
 * DRS removes a third of the rear wing's downforce and nearly half its drag, for
 * a ~14% reduction in total CdA — about +15 km/h on top speed, which is the real
 * figure. Tuning it by drag alone overshoots badly: the induced-drag term falls
 * too, so the two compound.
 */
export const DRS_CLA_LOSS = 0.35;

/**
 * Yaw sensitivity. Downforce falls in yaw, so a sliding car loses grip on top of
 * losing direction — and drag rises, which is why a slide costs so much time.
 */
export const YAW_CLA_LOSS = 2.2;
export const YAW_CLA_FLOOR = 0.4;
export const YAW_CDA_GAIN = 1.5;

/**
 * Body side force, and where it acts.
 *
 * The centre of pressure sits behind the CoG, which makes the bodywork a
 * weathervane: it produces a restoring moment in sideslip *and* a damping moment
 * in yaw rate, because a yawing car has sideslip at the centre of pressure even
 * when the CoG does not.
 *
 * This is what replaces the `av *= 1 - dt·1.2` that used to stand in for
 * directional damping. That term was a fixed first-order decay independent of
 * speed, load and tyre state — it could not represent either mechanism, and it
 * was distorting the moment balance that decides where the car departs.
 */
export const CYA_BODY = 1.2;
export const X_CP = -0.22 * WB;

/**
 * Skid plank. Titanium on a carbon floor, on a very stiff structure, so contact is
 * abrupt. This produces a real vertical force spike — and the sparks.
 */
export const K_PLANK = 8e6;
export const PLANK_FRICTION = 0.25;

// ---------------------------------------------------------------------------
// The floor curve
// ---------------------------------------------------------------------------

/**
 * Floor effectiveness against ride height, 0..1, peaking at `hOpt`.
 *
 * Above the optimum: `(hOpt/h)^p` — rising as the gap closes and the venturi
 * accelerates. Below it: a quadratic collapse to nothing over `hStall`. The
 * asymmetry is the physics. Flow attachment is progressive; separation is not.
 */
export function floorFactor(h, hOpt, hStall) {
  if (!(h > 0)) return 0;
  if (h >= hOpt) return (hOpt / h) ** VENTURI_EXPONENT;
  const x = (hOpt - h) / hStall;
  return Math.max(0, 1 - x * x);
}

/**
 * ClA for one axle at a given ride height.
 *
 * Exported on its own because it is the curve worth plotting when the car feels
 * wrong at speed, and because the capability probe looks for it.
 */
export function clAtRideHeight(h, front) {
  const wing = front ? CLA_WING_FRONT : CLA_WING_REAR;
  const floor = front ? CLA_FLOOR_FRONT : CLA_FLOOR_REAR;
  const hOpt = front ? H_OPT_FRONT : H_OPT_REAR;
  const hStall = front ? H_STALL_FRONT : H_STALL_REAR;
  return wing + floor * floorFactor(h, hOpt, hStall);
}

/** Ride heights at which each axle's floor is at its best. For tests and setup. */
export const optimumRideHeight = front => (front ? H_OPT_FRONT : H_OPT_REAR);

// ---------------------------------------------------------------------------
// The full aero state
// ---------------------------------------------------------------------------

/** Everything `groundEffect` writes. Allocated once and reused. */
export function createAeroState() {
  return {
    q: 0,
    /** Lagged floor effectiveness, 0..1. The state that makes porpoising possible. */
    floorLagFront: 1, floorLagRear: 1,
    claFront: 0, claRear: 0, claTotal: 0,
    fzFront: 0, fzRear: 0, downforce: 0,
    cdA: 0, drag: 0,
    sideForce: 0, yawMoment: 0,
    balanceFront: 0.4,
    plankFront: 0, plankRear: 0, plankDrag: 0,
    /** Contact speed at the plank, for sparks and for audio. */
    plankContact: false,
    stalledFront: false, stalledRear: false,
  };
}

/**
 * Compute the whole aerodynamic state, in place.
 *
 * @param {object} out from `createAeroState`
 * @param {object} c conditions:
 *   `speed` m/s along the velocity vector (not the forward component — a big
 *   slide keeps its drag and its downforce);
 *   `rideFront`, `rideRear` m, from the suspension;
 *   `sideslip` rad;
 *   `yawRate` rad/s;
 *   `drs` boolean;
 *   `activeAero` boolean (2026).
 */
export function groundEffect(out, c) {
  const speed = Math.abs(c.speed) || 0;
  const q = 0.5 * RHO * speed * speed;
  out.q = q;

  const hF = c.rideFront;
  const hR = c.rideRear;
  out.stalledFront = hF < H_OPT_FRONT;
  out.stalledRear = hR < H_OPT_REAR;

  // Target floor effectiveness, then the lagged value the car actually gets.
  const targetF = floorFactor(hF, H_OPT_FRONT, H_STALL_FRONT);
  const targetR = floorFactor(hR, H_OPT_REAR, H_STALL_REAR);
  const dt = c.dt || 0;
  out.floorLagFront = lagFloor(out.floorLagFront, targetF, speed, dt);
  out.floorLagRear = lagFloor(out.floorLagRear, targetR, speed, dt);

  // Wing ClA comes from the conditions when a setup supplies it, so a wing click
  // reaches the downforce. The floor is not adjustable — it is bodywork.
  const wingFront = c.claWingFront ?? CLA_WING_FRONT;
  const wingRear = c.claWingRear ?? CLA_WING_REAR;
  // `floorScale` is how floor damage arrives: a holed floor makes less of its
  // load at every ride height, front and rear together.
  const floorScale = c.floorScale ?? 1;
  let claFront = wingFront + CLA_FLOOR_FRONT * out.floorLagFront * floorScale;
  let claRear = wingRear + CLA_FLOOR_REAR * out.floorLagRear * floorScale;

  // DRS and active aero act on the rear wing only.
  const open = Boolean(c.drs) || Boolean(c.activeAero && c.drs);
  if (open) claRear = Math.max(wingRear * 0.4, claRear - DRS_CLA_LOSS);

  // Yaw. A sliding car loses downforce as well as direction.
  const beta = Math.abs(c.sideslip || 0);
  const yawScale = Math.max(YAW_CLA_FLOOR, 1 - YAW_CLA_LOSS * beta);
  claFront *= yawScale;
  claRear *= yawScale;

  out.claFront = claFront;
  out.claRear = claRear;
  out.claTotal = claFront + claRear;
  out.fzFront = q * claFront;
  out.fzRear = q * claRear;
  out.downforce = out.fzFront + out.fzRear;
  out.balanceFront = out.claTotal > 1e-9 ? claFront / out.claTotal : 0.4;

  // Drag: body, rear wing, induced, all scaled up in yaw.
  const wingDrag = (open ? CDA_REAR_WING_DRS : CDA_REAR_WING) + (c.cdaWings ?? 0);
  const induced = CDA_INDUCED_K * out.claTotal * out.claTotal;
  out.cdA = Math.max(0.2, (CDA_BODY + wingDrag + induced) * (1 + YAW_CDA_GAIN * beta));
  out.drag = q * out.cdA;

  // Body side force at the centre of pressure. The local sideslip there includes
  // the yaw rate, which is where directional damping comes from: lateral velocity
  // at a point `x` ahead of the CoG is `vy − r·x`, and X_CP is negative.
  const vRef = Math.max(speed, 1);
  const betaCp = (c.sideslip || 0) - (c.yawRate || 0) * X_CP / vRef;
  out.sideForce = -q * CYA_BODY * clamp(betaCp, -1, 1);
  // A force at `x` contributes `−F·x` to the yaw-left moment.
  out.yawMoment = -out.sideForce * X_CP;

  // Skid plank. Ride height is measured to the floor, so a negative value is the
  // plank on the ground.
  out.plankFront = hF < 0 ? -K_PLANK * hF : 0;
  out.plankRear = hR < 0 ? -K_PLANK * hR : 0;
  out.plankContact = out.plankFront > 0 || out.plankRear > 0;
  out.plankDrag = PLANK_FRICTION * (out.plankFront + out.plankRear);

  return out;
}

/**
 * Advance the lagged floor effectiveness by `dt`.
 *
 * Integrated in closed form for the same reason the tyre relaxation is: at speed
 * the rate is 25 s⁻¹ and rising, and an explicit step rings before it diverges. A
 * `dt` of zero snaps to the target, so a caller that only wants a steady-state
 * coefficient can omit it.
 */
export function lagFloor(current, target, speed, dt) {
  if (!(dt > 0)) return target;
  const tau = (AERO_LAG_LENGTH / Math.max(speed, 1))
    * (target > current ? REATTACH_LAG_FACTOR : 1);
  return current + (target - current) * (1 - Math.exp(-dt / tau));
}

/** DRS availability and effect, exported so the probe and the UI can find it. */
export function drs(claRear, open) {
  return open ? Math.max(CLA_WING_REAR * 0.4, claRear - DRS_CLA_LOSS) : claRear;
}

/** Total CdA at a given ClA. Handy for validating top speed analytically. */
export function dragArea(claTotal, open = false) {
  return CDA_BODY + (open ? CDA_REAR_WING_DRS : CDA_REAR_WING)
    + CDA_INDUCED_K * claTotal * claTotal;
}

/**
 * Aero pitch moment about the CoG from the front/rear split, N·m, nose-up
 * positive. This is the term that feeds the suspension and closes the porpoising
 * loop — without it the aero load is applied but never moves the platform.
 */
export function aeroPitchMoment(fzFront, fzRear) {
  return -(fzFront * LF - fzRear * LR);
}

export { LF as AERO_ARM_FRONT, LR as AERO_ARM_REAR };
