/**
 * Car setup — the parameters a driver is allowed to change between runs.
 *
 * The physics modules were written against module constants, which is right for
 * things that are true about the car and wrong for things somebody is meant to
 * adjust. The distinction matters more here than usual, because the plan's whole
 * argument for roll stiffness distribution was that it is *the primary balance
 * tool* — and a balance tool that cannot be moved is a claim rather than a tool.
 *
 * So this is the set of numbers that move, with the ranges they may move over and
 * the defaults that reproduce the constants the reference figures were measured
 * against. `applySetup` derives everything the subsystems need from them.
 *
 * Free of three.js, and every derived quantity is a pure function of the setup, so
 * a change cannot half-apply.
 */

import {
  K_SPRING_FRONT, K_SPRING_REAR, ARB_FRONT, ARB_REAR,
  RIDE_HEIGHT_FRONT, RIDE_HEIGHT_REAR, TRACK,
  RC_HEIGHT_FRONT, RC_HEIGHT_REAR, H_ROLL,
} from './suspension.js';
import { CLA_WING_FRONT, CLA_WING_REAR } from './aero.js';
import { TYRE_K, MU_SCALE_FRONT, MU_SCALE_REAR } from './wheel.js';
import { LF, LR, WB, H_CG, MASS, G } from './constants.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Every adjustable parameter, with its range and what moving it does.
 *
 * `steps` is what a setup screen offers — real cars adjust in clicks, not
 * continuously, and a click is a unit a driver can talk about.
 */
export const SETUP_SCHEMA = [
  {
    key: 'frontWing', label: 'Front wing', unit: '', min: 0, max: 20, step: 1,
    default: 10,
    effect: 'More front downforce. Turn-in bites, and the rear follows less well.',
  },
  {
    key: 'rearWing', label: 'Rear wing', unit: '', min: 0, max: 20, step: 1,
    default: 10,
    effect: 'More rear downforce and more drag. Stability for top speed.',
  },
  {
    key: 'arbFront', label: 'Front anti-roll bar', unit: '', min: 1, max: 11, step: 1,
    default: 6,
    effect: 'Stiffer front bar moves roll stiffness forward: more understeer.',
  },
  {
    key: 'arbRear', label: 'Rear anti-roll bar', unit: '', min: 1, max: 11, step: 1,
    default: 4,
    effect: 'Stiffer rear bar moves it back: more rotation, less stability.',
  },
  {
    key: 'springFront', label: 'Front spring', unit: 'N/mm', min: 180, max: 340, step: 10,
    default: Math.round(K_SPRING_FRONT / 1000),
    effect: 'Platform control against kerb and bump compliance.',
  },
  {
    key: 'springRear', label: 'Rear spring', unit: 'N/mm', min: 140, max: 280, step: 10,
    default: Math.round(K_SPRING_REAR / 1000),
    effect: 'Traction on exit against ride height control.',
  },
  {
    key: 'rideFront', label: 'Front ride height', unit: 'mm', min: 20, max: 45, step: 1,
    default: Math.round(RIDE_HEIGHT_FRONT * 1000),
    effect: 'Lower runs the floor closer to its optimum — until it stalls.',
  },
  {
    key: 'rideRear', label: 'Rear ride height', unit: 'mm', min: 60, max: 110, step: 2,
    default: Math.round(RIDE_HEIGHT_REAR * 1000),
    effect: 'Rake. Sets where the aero balance sits and how it moves.',
  },
  {
    key: 'brakeBias', label: 'Brake bias', unit: '% front', min: 50, max: 66, step: 0.5,
    default: 58,
    effect: 'Forward locks the fronts and kills turn-in; back locks the rears.',
  },
  {
    key: 'diffLock', label: 'Differential', unit: '% locked', min: 0, max: 100, step: 5,
    default: 55,
    effect: 'Locked drives both rears together: traction, at the cost of rotation.',
  },
  {
    key: 'pressureFront', label: 'Front tyre pressure', unit: 'psi', min: 20, max: 27, step: 0.5,
    default: 23,
    effect: 'Higher is a smaller, harder contact patch: less grip, quicker response.',
  },
  {
    key: 'pressureRear', label: 'Rear tyre pressure', unit: 'psi', min: 18, max: 25, step: 0.5,
    default: 21,
    effect: 'Same trade at the driven end, where traction is decided.',
  },
  {
    key: 'fuel', label: 'Fuel', unit: 'kg', min: 5, max: 110, step: 5,
    default: 100,
    effect: 'Mass. A kilo is worth roughly three hundredths of a second a lap.',
  },
];

export function defaultSetup() {
  const setup = {};
  for (const p of SETUP_SCHEMA) setup[p.key] = p.default;
  return setup;
}

/** Clamp every value into range, and drop anything not in the schema. */
export function sanitizeSetup(input = {}) {
  const setup = defaultSetup();
  for (const p of SETUP_SCHEMA) {
    if (typeof input[p.key] === 'number' && Number.isFinite(input[p.key])) {
      setup[p.key] = clamp(input[p.key], p.min, p.max);
    }
  }
  return setup;
}

/** The reference pressure, at which a tyre performs as the tyre model says. */
/** Fuel load `MASS` corresponds to. See `applySetup`. */
export const FUEL_REFERENCE = 100;

export const PRESSURE_REF_FRONT = 23;
export const PRESSURE_REF_REAR = 21;
/**
 * How much grip a psi is worth.
 *
 * Over-pressure shrinks the contact patch and raises the local pressure in it,
 * both of which cost peak grip; under-pressure grows it and costs response and
 * heat. Modelled as a peak either side of the reference rather than a straight
 * line, because a straight line makes minimum pressure optimal and turns a real
 * trade into a free choice.
 */
export const PRESSURE_GRIP_FALLOFF = 0.005;
/** Pressure moves the tyre's vertical stiffness too, which is most of the ride. */
export const PRESSURE_STIFFNESS_PER_PSI = 0.028;

/** Wing clicks to ClA. Ten clicks is the baseline the reference figures used. */
export const WING_CLA_PER_CLICK_FRONT = 0.035;
export const WING_CLA_PER_CLICK_REAR = 0.055;
/** A rear wing costs drag as well; a front wing barely does. */
export const WING_CDA_PER_CLICK_REAR = 0.020;
export const WING_CDA_PER_CLICK_FRONT = 0.004;

/** Anti-roll bar clicks to N·m/rad. Click 6 front / 4 rear is the baseline. */
export const ARB_PER_CLICK_FRONT = ARB_FRONT / 6;
export const ARB_PER_CLICK_REAR = ARB_REAR / 4;

/**
 * Everything the subsystems need, derived from a setup.
 *
 * One function, so a setup change cannot half-apply — which is the failure mode
 * that makes setup screens untrustworthy. Returned as a flat object of numbers the
 * kernel copies into place at the start of a step.
 */
export function applySetup(input) {
  const s = sanitizeSetup(input);

  const kSpringFront = s.springFront * 1000;
  const kSpringRear = s.springRear * 1000;
  const arbFront = s.arbFront * ARB_PER_CLICK_FRONT;
  const arbRear = s.arbRear * ARB_PER_CLICK_REAR;

  // Roll stiffness, and therefore the lateral load transfer split. This is the
  // chain the plan called the primary balance tool, end to end.
  const kRollFront = 0.5 * kSpringFront * TRACK * TRACK + arbFront;
  const kRollRear = 0.5 * kSpringRear * TRACK * TRACK + arbRear;
  const rollShareFront = kRollFront / (kRollFront + kRollRear);
  const lateralArmFront = rollShareFront * H_ROLL + (LR / WB) * RC_HEIGHT_FRONT;
  const lateralArmRear = (1 - rollShareFront) * H_ROLL + (LF / WB) * RC_HEIGHT_REAR;

  // Tyre pressure: a peak at the reference, falling either side.
  const gripFromPressure = (psi, ref) => {
    const d = psi - ref;
    return Math.max(0.85, 1 - PRESSURE_GRIP_FALLOFF * d * d);
  };
  const stiffnessFromPressure = (psi, ref) =>
    TYRE_K * (1 + PRESSURE_STIFFNESS_PER_PSI * (psi - ref));

  return {
    setup: s,

    // Suspension
    kSpringFront,
    kSpringRear,
    arbFront,
    arbRear,
    kRollFront,
    kRollRear,
    rollShareFront,
    lateralArmFront,
    lateralArmRear,
    rideHeightFront: s.rideFront / 1000,
    rideHeightRear: s.rideRear / 1000,

    // Aero
    claWingFront: Math.max(0, CLA_WING_FRONT
      + (s.frontWing - 10) * WING_CLA_PER_CLICK_FRONT),
    claWingRear: Math.max(0, CLA_WING_REAR
      + (s.rearWing - 10) * WING_CLA_PER_CLICK_REAR),
    cdaWings: (s.frontWing - 10) * WING_CDA_PER_CLICK_FRONT
      + (s.rearWing - 10) * WING_CDA_PER_CLICK_REAR,

    // Tyres
    muScaleFront: MU_SCALE_FRONT * gripFromPressure(s.pressureFront, PRESSURE_REF_FRONT),
    muScaleRear: MU_SCALE_REAR * gripFromPressure(s.pressureRear, PRESSURE_REF_REAR),
    tyreKFront: stiffnessFromPressure(s.pressureFront, PRESSURE_REF_FRONT),
    tyreKRear: stiffnessFromPressure(s.pressureRear, PRESSURE_REF_REAR),

    // Kernel
    brakeBiasFront: s.brakeBias / 100,
    diffLock: s.diffLock / 100,
    /**
     * `MASS` is the car at the reference 100 kg fuel load — that is what the
     * reference figures were measured at, and moving it would invalidate the
     * tuning rather than improve it. Fuel moves the mass relative to that.
     */
    mass: MASS + s.fuel - FUEL_REFERENCE,
  };
}

/**
 * A one-line description of what a setup will do, for the setup screen.
 *
 * Reports the derived quantities rather than the clicks, because "58.7% of roll
 * stiffness on the front axle" is the thing that decides the balance and "front
 * bar 6" is not.
 */
export function describeSetup(applied) {
  const a = applied;
  return {
    rollBalance: `${(a.rollShareFront * 100).toFixed(1)}% front roll stiffness`,
    transferBalance: `${(100 * a.lateralArmFront / (a.lateralArmFront + a.lateralArmRear)).toFixed(1)}% front load transfer`,
    rake: `${((a.rideHeightRear - a.rideHeightFront) * 1000).toFixed(0)} mm rake`,
    mass: `${a.mass.toFixed(0)} kg`,
    wings: `wing ClA ${(a.claWingFront + a.claWingRear).toFixed(2)}, drag ${a.cdaWings >= 0 ? '+' : ''}${a.cdaWings.toFixed(3)}`,
  };
}

/** Static corner loads for a given setup mass. */
export function cornerLoads(mass) {
  const front = (mass * G * LR / WB) / 2;
  const rear = (mass * G * LF / WB) / 2;
  return [front, front, rear, rear];
}

export { H_CG };
