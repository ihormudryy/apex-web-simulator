/**
 * Suspension — the vertical subsystem.
 *
 * Seven degrees of freedom: chassis heave, pitch and roll, plus one vertical DOF
 * per wheel. The unsprung masses are not optional decoration. They are what
 * makes a kerb strike upset the platform, what makes the tyre load fluctuate over
 * a bump, and what creates the wheel-hop mode that decides how this has to be
 * integrated.
 *
 * Modern F1 is extremely stiff, because ride height controls the floor and the
 * floor is the car. Wheel rates are 200–300 N/mm, travel is 20–30 mm, and the car
 * runs on its bump stops at speed. This is not softened to feel nice.
 *
 * ## Why this is integrated the way it is
 *
 *     wheel-hop ≈ sqrt(k_tyre / m_unsprung) = sqrt(310000 / 22) ≈ 119 rad/s ≈ 19 Hz
 *     damper rate ≈ c / m_unsprung ≈ 8500 / 22 ≈ 386 s⁻¹
 *
 * Explicit Euler on the damper needs `dt < 2/386 = 5.2 ms`, which at 600 Hz is
 * only a factor of three of margin — and it evaporates the moment somebody stiffens
 * a damper or lightens an upright, which is exactly what a setup screen invites.
 *
 * So the whole 7-DOF system is advanced **linearly implicitly**:
 *
 *     (M − dt·C + dt²·K) Δu = dt · F(q, u)
 *
 * with `C` the damping Jacobian and `K` the stiffness Jacobian. That is
 * unconditionally stable in both the spring and the damper terms, whatever the
 * step and whatever the rates. It costs one dense 7×7 solve — about 200 flops,
 * or 120k flops a second at 600 Hz, which is nothing.
 *
 * ## Coordinates
 *
 * Everything is a displacement from *static equilibrium*, positive up. Gravity is
 * therefore already balanced and never appears: only changes drive motion —
 * downforce, the inertial moments from cornering and braking, and the road
 * surface moving under the wheels. That makes the system linear, keeps the static
 * case exactly at rest, and means a bug shows up as drift from zero.
 */

import { TYRE_K, TYRE_C, tyreVerticalForce } from './wheel.js';
import { MASS, G, LF, LR, WB, H_CG, TRACK_HALF } from './constants.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---------------------------------------------------------------------------
// Masses
// ---------------------------------------------------------------------------

/**
 * Unsprung mass per corner: wheel, tyre, upright, brake and half the links.
 * The 2022+ 18" wheel is heavier than the 13" it replaced, which is part of why
 * these cars are worse over kerbs.
 */
export const UNSPRUNG_MASS = 22;
export const SPRUNG_MASS = MASS - 4 * UNSPRUNG_MASS;
/** Pitch and roll inertia of the sprung mass. An F1 car is long and very narrow. */
export const I_PITCH = 1100;
export const I_ROLL = 120;

export const TRACK = 2 * TRACK_HALF;

// ---------------------------------------------------------------------------
// Rates
// ---------------------------------------------------------------------------

/**
 * Wheel rates, N/m. Front is stiffer than rear, which with the ride frequencies
 * below is what gives the car its platform control.
 *
 *   front: sqrt(260000 / 163) / 2π = 6.4 Hz
 *   rear:  sqrt(200000 / 192) / 2π = 5.1 Hz
 *
 * Road cars run 1–2 Hz. These numbers look absurd and are correct.
 */
export const K_SPRING_FRONT = 260000;
export const K_SPRING_REAR = 200000;

/**
 * Damping, N·s/m, split bump/rebound. Rebound is stiffer than bump — the standard
 * arrangement, and what stops the car pattering after a kerb instead of settling.
 * Digressive: the rate falls at high shaft speed so that a sharp input passes
 * through the damper rather than being fought by it, which is why a kerb does not
 * throw the car.
 */
export const C_BUMP_FRONT = 4600;
export const C_REBOUND_FRONT = 8500;
export const C_BUMP_REAR = 3800;
export const C_REBOUND_REAR = 7000;
/** Shaft speed at which the digressive knee sits, m/s. */
export const DIGRESSIVE_KNEE = 0.08;
export const DIGRESSIVE_SLOPE = 0.35;

/**
 * Anti-roll bars, N·m/rad of body roll. These are the primary balance tool: with
 * the springs alone the front carries 56.5% of roll stiffness, and the bars move
 * that to 58.7%. Raising the front bar pushes the car toward understeer.
 */
export const ARB_FRONT = 60000;
export const ARB_REAR = 20000;

/**
 * Heave elements — the third springs. They act on symmetric compression only, so
 * they control ride height without adding roll stiffness. This is how these cars
 * separate platform control from balance, and it has no road-car analogue.
 */
export const K_HEAVE_FRONT = 150000;
export const K_HEAVE_REAR = 120000;
/** Heave travel before the third spring picks up, m. */
export const HEAVE_GAP = 0.006;

/**
 * Bump stops. Travel is tiny and the car rides them at speed, so these are part
 * of the working suspension rather than a crash protection of last resort.
 */
/**
 * Bump-stop gaps, m. Smaller than the ride height might suggest, because the
 * *tyre* takes a larger share of the available travel than the spring does: at
 * 2600 kg of downforce a front corner deflects the tyre by 22 mm against the
 * spring's 15, so a 20 mm gap was never reached — the floor grounded first and
 * the packers never came into play at all.
 */
export const BUMP_STOP_GAP_FRONT = 0.012;
export const BUMP_STOP_GAP_REAR = 0.020;
export const K_BUMP_STOP = 2.4e6;

/**
 * Droop limit — how far a corner can extend before the damper reaches the end of
 * its stroke and the pushrod goes into tension.
 *
 * Not optional, and easy to leave out. Without it, an unloaded inside wheel lets
 * that corner extend without limit, so the chassis rolls freely the moment a tyre
 * comes off the ground: 4 g of lateral with no downforce produced 500 degrees of
 * body roll rather than the car simply riding on two wheels.
 */
export const DROOP_TRAVEL_FRONT = 0.030;
export const DROOP_TRAVEL_REAR = 0.035;
export const K_DROOP_STOP = 1.8e6;

/** Static ride heights, m — floor to ground, with rake. */
export const RIDE_HEIGHT_FRONT = 0.030;
export const RIDE_HEIGHT_REAR = 0.080;

/**
 * Attitude limits, radians. These are the edge of the model, not a physical part.
 *
 * The corner geometry here is linearised about upright (`zc + ax·pitch + ay·roll`),
 * which is accurate to a fraction of a millimetre over the couple of degrees a
 * modern F1 car actually moves, and meaningless well beyond that. An input that
 * asks for more — 4 g of lateral with no downforce, say, which on a real car is a
 * rollover — otherwise produced hundreds of degrees of body roll and a chassis
 * that climbed steadily into the air, because a linear model has no way to tip
 * over and no way to stop.
 *
 * So the attitude is clamped and `attitudeLimited` is raised. A car that reaches
 * this is either being asked something impossible or has a bug upstream; either
 * way, silently integrating nonsense is the worst of the available options.
 */
export const MAX_ROLL = 8 * Math.PI / 180;
export const MAX_PITCH = 6 * Math.PI / 180;

// ---------------------------------------------------------------------------
// Roll stiffness — the balance lever
// ---------------------------------------------------------------------------

/**
 * Roll stiffness per axle: the springs acting through the track, plus the bar.
 *
 * `0.5·k·t²` is the spring contribution: each wheel moves `t/2·φ`, so the moment
 * is `2 · k · (t/2)φ · (t/2) = 0.5·k·t²·φ`.
 */
export const K_ROLL_FRONT = 0.5 * K_SPRING_FRONT * TRACK * TRACK + ARB_FRONT;
export const K_ROLL_REAR = 0.5 * K_SPRING_REAR * TRACK * TRACK + ARB_REAR;
export const ROLL_STIFFNESS_FRONT_SHARE = K_ROLL_FRONT / (K_ROLL_FRONT + K_ROLL_REAR);

/** Roll-centre heights, m. Low, as F1 runs them. */
export const RC_HEIGHT_FRONT = 0.035;
export const RC_HEIGHT_REAR = 0.055;

/** Roll-axis height under the CoG, and the CoG's height above it. */
export const ROLL_AXIS_AT_CG =
  RC_HEIGHT_FRONT + (RC_HEIGHT_REAR - RC_HEIGHT_FRONT) * (LF / WB);
export const H_ROLL = H_CG - ROLL_AXIS_AT_CG;

// ---------------------------------------------------------------------------
// Corner geometry
// ---------------------------------------------------------------------------

/**
 * Lever arms: chassis corner displacement is `zc + ax·pitch + ay·roll`.
 *
 * Order is FL, FR, RL, RR, matching loadTransfer.js. Pitch is positive nose-up;
 * roll is positive with the right side going down, so the left arms are positive.
 */
export const CORNER_AX = [LF, LF, -LR, -LR];
export const CORNER_AY = [TRACK_HALF, -TRACK_HALF, TRACK_HALF, -TRACK_HALF];
const IS_FRONT = [true, true, false, false];

/**
 * Rates come off the state, not the module, so a setup change reaches the springs.
 *
 * The constants remain the defaults and the reference figures are still measured
 * against them — but a balance tool that cannot be moved is a claim rather than a
 * tool, and roll stiffness distribution is the one the plan calls primary.
 */
const kSpring = (s, i) => (IS_FRONT[i] ? s.kSpringFront : s.kSpringRear);
const arbOf = (s, i) => (IS_FRONT[i] ? s.arbFront : s.arbRear);
const bumpGap = i => (IS_FRONT[i] ? BUMP_STOP_GAP_FRONT : BUMP_STOP_GAP_REAR);
const droopGap = i => (IS_FRONT[i] ? DROOP_TRAVEL_FRONT : DROOP_TRAVEL_REAR);

/** Static corner loads, N. Aero-free, so this is the datum the coordinates use. */
export const FZ_STATIC = [
  (MASS * G * LR / WB) / 2, (MASS * G * LR / WB) / 2,
  (MASS * G * LF / WB) / 2, (MASS * G * LF / WB) / 2,
];

// ---------------------------------------------------------------------------
// Force laws
// ---------------------------------------------------------------------------

/**
 * Damper force at a given shaft speed, N. Digressive and asymmetric.
 *
 * @param {number} rate shaft speed, m/s. Positive = compressing.
 */
export function damperForce(rate, i) {
  const bump = IS_FRONT[i] ? C_BUMP_FRONT : C_BUMP_REAR;
  const rebound = IS_FRONT[i] ? C_REBOUND_FRONT : C_REBOUND_REAR;
  const c = rate > 0 ? bump : rebound;
  const v = Math.abs(rate);
  // Linear to the knee, then a shallower slope, so a kerb is not fought.
  const effective = v <= DIGRESSIVE_KNEE
    ? v
    : DIGRESSIVE_KNEE + (v - DIGRESSIVE_KNEE) * DIGRESSIVE_SLOPE;
  return Math.sign(rate) * c * effective;
}

/** Effective damping rate at a shaft speed — the Jacobian entry, N·s/m. */
export function damperRate(rate, i) {
  const bump = IS_FRONT[i] ? C_BUMP_FRONT : C_BUMP_REAR;
  const rebound = IS_FRONT[i] ? C_REBOUND_FRONT : C_REBOUND_REAR;
  const c = rate > 0 ? bump : rebound;
  return Math.abs(rate) <= DIGRESSIVE_KNEE ? c : c * DIGRESSIVE_SLOPE;
}

/**
 * Travel-limit force, N. Positive resists compression past the bump stop;
 * negative resists extension past the droop limit. Zero in between, which is
 * where the suspension normally works — except at speed, where these cars sit on
 * the packers and this term is most of the wheel rate.
 */
export function bumpStopForce(compression, i) {
  const over = compression - bumpGap(i);
  // Quadratic rather than linear: a packer gets stiffer the harder it is hit.
  if (over > 0) return K_BUMP_STOP * over * (1 + 40 * over);
  const under = -compression - droopGap(i);
  if (under > 0) return -K_DROOP_STOP * under * (1 + 40 * under);
  return 0;
}

export function bumpStopRate(compression, i) {
  const over = compression - bumpGap(i);
  if (over > 0) return K_BUMP_STOP * (1 + 80 * over);
  const under = -compression - droopGap(i);
  if (under > 0) return K_DROOP_STOP * (1 + 80 * under);
  return 0;
}

/**
 * Heave-element force, N, from symmetric compression of an axle. Acts on both
 * corners of the axle equally and contributes nothing to roll.
 */
export function heaveForce(axleCompression, front) {
  const over = Math.abs(axleCompression) - HEAVE_GAP;
  if (over <= 0) return 0;
  const k = front ? K_HEAVE_FRONT : K_HEAVE_REAR;
  return Math.sign(axleCompression) * k * over;
}

/**
 * Total suspension force at one corner, N, pushing the chassis up.
 *
 * Exported because the capability probe looks for it and because it is the thing
 * a setup screen wants to plot.
 */
export function suspensionForce(compression, rate, i, axleCompression = 0, roll = 0, tune = DEFAULT_TUNE) {
  // The bar reacts body roll, opposing it, shared between the two corners.
  const arbForce = -Math.sign(CORNER_AY[i]) * arbOf(tune, i) * roll / TRACK;
  return kSpring(tune, i) * compression
    + damperForce(rate, i)
    + bumpStopForce(compression, i)
    + heaveForce(axleCompression, IS_FRONT[i])
    + arbForce;
}

/** The baseline rates, so every entry point works without a setup. */
export const DEFAULT_TUNE = {
  kSpringFront: K_SPRING_FRONT,
  kSpringRear: K_SPRING_REAR,
  arbFront: ARB_FRONT,
  arbRear: ARB_REAR,
  rideHeightFront: RIDE_HEIGHT_FRONT,
  rideHeightRear: RIDE_HEIGHT_REAR,
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * All seven positions and seven velocities, plus the outputs the rest of the sim
 * reads. Allocated once per car; `step` mutates it and returns nothing.
 */
export function createSuspensionState(tune = DEFAULT_TUNE) {
  return {
    /** Setup-dependent rates. See `applySetup` in setup.js. */
    kSpringFront: tune.kSpringFront ?? K_SPRING_FRONT,
    kSpringRear: tune.kSpringRear ?? K_SPRING_REAR,
    arbFront: tune.arbFront ?? ARB_FRONT,
    arbRear: tune.arbRear ?? ARB_REAR,
    rideHeightFront: tune.rideHeightFront ?? RIDE_HEIGHT_FRONT,
    rideHeightRear: tune.rideHeightRear ?? RIDE_HEIGHT_REAR,
    // Positions: heave, pitch, roll, then the four wheels.
    zc: 0, pitch: 0, roll: 0,
    zw: [0, 0, 0, 0],
    // Velocities.
    vc: 0, vPitch: 0, vRoll: 0,
    vw: [0, 0, 0, 0],
    /** Outputs. */
    fz: [FZ_STATIC[0], FZ_STATIC[1], FZ_STATIC[2], FZ_STATIC[3]],
    compression: [0, 0, 0, 0],
    rideFront: tune.rideHeightFront ?? RIDE_HEIGHT_FRONT,
    rideRear: tune.rideHeightRear ?? RIDE_HEIGHT_REAR,
    /** True while any corner is on its bump stop — the car is riding the packers. */
    onBumpStop: false,
    /** True while the body attitude is against the small-angle limit. */
    attitudeLimited: false,
    /** Scratch, so the solve allocates nothing. */
    _A: new Float64Array(49),
    _b: new Float64Array(7),
    _f: new Float64Array(7),
  };
}

export function resetSuspension(s) {
  s.zc = 0; s.pitch = 0; s.roll = 0;
  s.vc = 0; s.vPitch = 0; s.vRoll = 0;
  for (let i = 0; i < 4; i++) {
    s.zw[i] = 0;
    s.vw[i] = 0;
    s.fz[i] = FZ_STATIC[i];
    s.compression[i] = 0;
  }
  s.rideFront = s.rideHeightFront;
  s.rideRear = s.rideHeightRear;
  s.onBumpStop = false;
  s.attitudeLimited = false;
}

// ---------------------------------------------------------------------------
// The step
// ---------------------------------------------------------------------------

/**
 * Advance the vertical system by `dt`.
 *
 * @param {object} s state from `createSuspensionState`
 * @param {object} load external inputs, all deltas from static:
 *   `aeroFront`, `aeroRear` downforce in N (positive presses the car down);
 *   `ax`, `ay` chassis acceleration in m/s² for the inertial moments;
 *   `ground` four ground displacements in m, positive up.
 * @param {number} dt seconds.
 */
export function step(s, load, dt) {
  const { aeroFront = 0, aeroRear = 0, ax = 0, ay = 0, ground } = load;

  // ---- assemble the generalised forces at the current state ----------------
  const f = s._f;
  f.fill(0);

  // Aero presses the chassis down at the front and rear aero centres.
  f[0] -= aeroFront + aeroRear;
  f[1] -= aeroFront * LF - aeroRear * LR;

  // Inertial moments. Pitch is positive nose-up and roll is positive right-down,
  // so braking (`ax` negative) must give a negative pitch and cornering right
  // (`ay` positive) must roll the car onto its left side — a negative roll.
  //
  // The d'Alembert force on the sprung mass is `−m·a` acting at CoG height. In
  // the nose-up convention that is `+m·ax·h` about the pitch axis, which is the
  // opposite sign to the one this line had at first: the car rose at the front
  // under 5 g of braking and squatted at the rear.
  f[1] += SPRUNG_MASS * ax * H_CG;
  f[2] -= SPRUNG_MASS * ay * H_ROLL;

  const axleFront = 0.5 * (s.compression[0] + s.compression[1]);
  const axleRear = 0.5 * (s.compression[2] + s.compression[3]);

  for (let i = 0; i < 4; i++) {
    const ax_i = CORNER_AX[i];
    const ay_i = CORNER_AY[i];
    const zci = s.zc + ax_i * s.pitch + ay_i * s.roll;
    const vci = s.vc + ax_i * s.vPitch + ay_i * s.vRoll;

    const compression = s.zw[i] - zci;
    const rate = s.vw[i] - vci;
    s.compression[i] = compression;

    const fs = suspensionForce(
      compression, rate, i, IS_FRONT[i] ? axleFront : axleRear, s.roll, s);

    // Suspension pushes the chassis up and the wheel down.
    f[0] += fs;
    f[1] += fs * ax_i;
    f[2] += fs * ay_i;
    f[3 + i] -= fs;

    // Tyre. Deflection is the static amount, plus the road coming up, less the
    // wheel rising. One-sided: an airborne wheel carries nothing.
    const staticDeflection = FZ_STATIC[i] / TYRE_K;
    const g = ground ? ground[i] : 0;
    const deflection = staticDeflection + g - s.zw[i];
    const ft = tyreVerticalForce(deflection, -s.vw[i]);
    s.fz[i] = ft;
    // Reported as a load; as a force on the wheel it is the *change* from static,
    // because gravity is already balanced in these coordinates.
    f[3 + i] += ft - FZ_STATIC[i];
  }

  // ---- assemble (M − dt·C + dt²·K) ----------------------------------------
  const A = s._A;
  A.fill(0);
  A[0 * 7 + 0] = SPRUNG_MASS;
  A[1 * 7 + 1] = I_PITCH;
  A[2 * 7 + 2] = I_ROLL;
  for (let i = 0; i < 4; i++) A[(3 + i) * 7 + (3 + i)] = UNSPRUNG_MASS;

  const h2 = dt * dt;
  for (let i = 0; i < 4; i++) {
    const ax_i = CORNER_AX[i];
    const ay_i = CORNER_AY[i];
    const vci = s.vc + ax_i * s.vPitch + ay_i * s.vRoll;
    const rate = s.vw[i] - vci;

    // Suspension acts along the relative coordinate `zw − zc − ax·pitch − ay·roll`,
    // so its Jacobian is the outer product of that gradient with itself.
    const kEff = kSpring(s, i) + bumpStopRate(s.compression[i], i);
    const cEff = damperRate(rate, i);
    const w = dt * cEff + h2 * kEff;
    const grad = [-1, -ax_i, -ay_i, 0, 0, 0, 0];
    grad[3 + i] = 1;
    for (let r = 0; r < 7; r++) {
      if (grad[r] === 0) continue;
      for (let c = 0; c < 7; c++) {
        if (grad[c] === 0) continue;
        A[r * 7 + c] += w * grad[r] * grad[c];
      }
    }

    // Tyre acts between the wheel and the road, so only the wheel's own row.
    const loaded = s.fz[i] > 0;
    if (loaded) {
      A[(3 + i) * 7 + (3 + i)] += dt * TYRE_C + h2 * TYRE_K;
    }
  }

  // ---- solve for the velocity increment ----------------------------------
  const b = s._b;
  for (let r = 0; r < 7; r++) b[r] = dt * f[r];
  solve7(A, b);

  s.vc += b[0];
  s.vPitch += b[1];
  s.vRoll += b[2];
  for (let i = 0; i < 4; i++) s.vw[i] += b[3 + i];

  s.zc += dt * s.vc;
  s.pitch += dt * s.vPitch;
  s.roll += dt * s.vRoll;
  for (let i = 0; i < 4; i++) s.zw[i] += dt * s.vw[i];

  // Keep the body inside the range the linearised geometry is valid over. The
  // rate is zeroed as well as the angle, or the state stays hard against the stop
  // with a velocity that resumes the divergence the moment the load eases.
  s.attitudeLimited = false;
  if (Math.abs(s.roll) > MAX_ROLL) {
    s.roll = Math.sign(s.roll) * MAX_ROLL;
    s.vRoll = 0;
    s.attitudeLimited = true;
  }
  if (Math.abs(s.pitch) > MAX_PITCH) {
    s.pitch = Math.sign(s.pitch) * MAX_PITCH;
    s.vPitch = 0;
    s.attitudeLimited = true;
  }

  // ---- outputs -----------------------------------------------------------
  // Ride height is the floor, which follows the chassis, over the road.
  const gF = ground ? 0.5 * (ground[0] + ground[1]) : 0;
  const gR = ground ? 0.5 * (ground[2] + ground[3]) : 0;
  s.rideFront = s.rideHeightFront + (s.zc + LF * s.pitch) - gF;
  s.rideRear = s.rideHeightRear + (s.zc - LR * s.pitch) - gR;

  s.onBumpStop = false;
  for (let i = 0; i < 4; i++) {
    if (s.compression[i] > bumpGap(i) || -s.compression[i] > droopGap(i)) {
      s.onBumpStop = true;
      break;
    }
  }
}

/**
 * Dense 7×7 Gaussian elimination with partial pivoting, in place. `b` is
 * overwritten with the solution.
 *
 * Written out rather than pulled from a library because it runs 600 times a
 * second and must not allocate. Partial pivoting is not optional: a wheel in the
 * air zeroes its tyre term, and without pivoting that is a small diagonal entry
 * next to large coupling terms.
 */
export function solve7(A, b) {
  const n = 7;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    let best = Math.abs(A[col * n + col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(A[r * n + col]);
      if (v > best) { best = v; pivot = r; }
    }
    if (best < 1e-12) continue;      // singular column: leave this DOF alone
    if (pivot !== col) {
      for (let c = 0; c < n; c++) {
        const t = A[col * n + c];
        A[col * n + c] = A[pivot * n + c];
        A[pivot * n + c] = t;
      }
      const t = b[col];
      b[col] = b[pivot];
      b[pivot] = t;
    }
    const d = A[col * n + col];
    for (let r = col + 1; r < n; r++) {
      const m = A[r * n + col] / d;
      if (m === 0) continue;
      for (let c = col; c < n; c++) A[r * n + c] -= m * A[col * n + c];
      b[r] -= m * b[col];
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    let sum = b[r];
    for (let c = r + 1; c < n; c++) sum -= A[r * n + c] * b[c];
    const d = A[r * n + r];
    b[r] = Math.abs(d) < 1e-12 ? 0 : sum / d;
  }
  return b;
}

/** Undamped natural frequencies, Hz — the numbers that justify the integrator. */
export function rideFrequency(front) {
  const k = front ? K_SPRING_FRONT : K_SPRING_REAR;
  const share = front ? LR / WB : LF / WB;
  const cornerMass = SPRUNG_MASS * share / 2;
  return Math.sqrt(k / cornerMass) / (2 * Math.PI);
}

export function wheelHopFrequency() {
  return Math.sqrt(TYRE_K / UNSPRUNG_MASS) / (2 * Math.PI);
}

export { clamp as _clamp };
