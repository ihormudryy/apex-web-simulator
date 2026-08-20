import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SETUP_SCHEMA, defaultSetup, sanitizeSetup, applySetup, describeSetup,
  cornerLoads, FUEL_REFERENCE, PRESSURE_REF_FRONT, PRESSURE_REF_REAR,
} from './setup.js';
import {
  K_SPRING_FRONT, K_SPRING_REAR, ARB_FRONT, ARB_REAR,
  RIDE_HEIGHT_FRONT, RIDE_HEIGHT_REAR, ROLL_STIFFNESS_FRONT_SHARE,
} from './suspension.js';
import { LATERAL_TRANSFER_FRONT_SHARE } from './loadTransfer.js';
import { CLA_WING_FRONT, CLA_WING_REAR } from './aero.js';
import { MU_SCALE_FRONT, MU_SCALE_REAR } from './wheel.js';
import { MASS, G } from './constants.js';
import {
  createCar, step, warmUp, launch, forwardSpeed, yawRate, lateralG,
} from './kernel.js';

const DT = 1 / 600;
const FLAT = {
  query: () => ({
    surface: 'tarmac', lateral: 0, wallLimit: 1e9, normal: { x: 0, z: 0 },
  }),
};

// ---------------------------------------------------------------------------
// The schema
// ---------------------------------------------------------------------------

test('every parameter has a range, a step and a stated effect', () => {
  for (const p of SETUP_SCHEMA) {
    assert.ok(p.key && p.label, `${JSON.stringify(p)} needs a key and a label`);
    assert.ok(p.max > p.min, `${p.key} has an empty range`);
    assert.ok(p.step > 0 && p.step <= p.max - p.min, `${p.key} step ${p.step}`);
    assert.ok(p.default >= p.min && p.default <= p.max, `${p.key} default out of range`);
    assert.ok(p.effect && p.effect.length > 20, `${p.key} does not say what it does`);
  }
});

test('the keys are unique', () => {
  const keys = SETUP_SCHEMA.map(p => p.key);
  assert.equal(new Set(keys).size, keys.length);
});

// ---------------------------------------------------------------------------
// The defaults are the tuning
// ---------------------------------------------------------------------------

test('the default setup reproduces the constants the car was tuned against', () => {
  // If this drifts, every reference figure in the plan is being measured against
  // a different car than the one the constants describe.
  const a = applySetup(defaultSetup());
  assert.ok(Math.abs(a.kSpringFront - K_SPRING_FRONT) < 1000, `${a.kSpringFront}`);
  assert.ok(Math.abs(a.kSpringRear - K_SPRING_REAR) < 1000, `${a.kSpringRear}`);
  assert.ok(Math.abs(a.arbFront - ARB_FRONT) < 1e-6);
  assert.ok(Math.abs(a.arbRear - ARB_REAR) < 1e-6);
  assert.ok(Math.abs(a.rideHeightFront - RIDE_HEIGHT_FRONT) < 1e-9);
  assert.ok(Math.abs(a.rideHeightRear - RIDE_HEIGHT_REAR) < 1e-9);
  assert.ok(Math.abs(a.claWingFront - CLA_WING_FRONT) < 1e-9);
  assert.ok(Math.abs(a.claWingRear - CLA_WING_REAR) < 1e-9);
  assert.ok(Math.abs(a.cdaWings) < 1e-9, 'the default must add no drag');
  assert.ok(Math.abs(a.muScaleFront - MU_SCALE_FRONT) < 1e-9);
  assert.ok(Math.abs(a.muScaleRear - MU_SCALE_REAR) < 1e-9);
  assert.equal(a.mass, MASS, 'and must be the reference mass');
});

test('the default roll stiffness split matches the constant it derives from', () => {
  const a = applySetup(defaultSetup());
  assert.ok(Math.abs(a.rollShareFront - ROLL_STIFFNESS_FRONT_SHARE) < 1e-6);
  const share = a.lateralArmFront / (a.lateralArmFront + a.lateralArmRear);
  assert.ok(Math.abs(share - LATERAL_TRANSFER_FRONT_SHARE) < 1e-6);
});

test('MASS is the car at the reference fuel load, not the dry car', () => {
  assert.equal(applySetup({ ...defaultSetup(), fuel: FUEL_REFERENCE }).mass, MASS);
  assert.ok(applySetup({ ...defaultSetup(), fuel: 5 }).mass < MASS - 90);
  assert.ok(applySetup({ ...defaultSetup(), fuel: 110 }).mass > MASS);
});

// ---------------------------------------------------------------------------
// Sanitisation
// ---------------------------------------------------------------------------

test('out-of-range values are clamped, not accepted', () => {
  const s = sanitizeSetup({ frontWing: 1e6, fuel: -50, brakeBias: 200 });
  for (const p of SETUP_SCHEMA) {
    assert.ok(s[p.key] >= p.min && s[p.key] <= p.max, `${p.key} = ${s[p.key]}`);
  }
});

test('garbage and unknown keys are dropped', () => {
  const s = sanitizeSetup({ frontWing: NaN, rearWing: 'lots', nonsense: 1 });
  assert.equal(s.frontWing, defaultSetup().frontWing);
  assert.equal(s.rearWing, defaultSetup().rearWing);
  assert.equal(s.nonsense, undefined);
});

test('applySetup on nothing at all is the default setup', () => {
  assert.deepEqual(applySetup(undefined).setup, defaultSetup());
  assert.deepEqual(applySetup({}).setup, defaultSetup());
});

// ---------------------------------------------------------------------------
// Each lever does what it says
// ---------------------------------------------------------------------------

test('the anti-roll bars move the roll stiffness distribution', () => {
  // The plan's claim is that this is THE primary balance tool. A tool that cannot
  // be moved is a claim rather than a tool, which is what it was.
  const stiffFront = applySetup({ ...defaultSetup(), arbFront: 11, arbRear: 1 });
  const stiffRear = applySetup({ ...defaultSetup(), arbFront: 1, arbRear: 11 });
  assert.ok(
    stiffFront.rollShareFront - stiffRear.rollShareFront > 0.06,
    `only ${((stiffFront.rollShareFront - stiffRear.rollShareFront) * 100).toFixed(1)} points of range`,
  );
});

test('and therefore the lateral load transfer split', () => {
  const share = a => a.lateralArmFront / (a.lateralArmFront + a.lateralArmRear);
  const stiffFront = share(applySetup({ ...defaultSetup(), arbFront: 11, arbRear: 1 }));
  const stiffRear = share(applySetup({ ...defaultSetup(), arbFront: 1, arbRear: 11 }));
  assert.ok(stiffFront > stiffRear + 0.05, `${stiffFront} vs ${stiffRear}`);
});

test('springs move roll stiffness too, which is why they are a balance tool as well', () => {
  const softRear = applySetup({ ...defaultSetup(), springRear: 140 });
  const stiffRear = applySetup({ ...defaultSetup(), springRear: 280 });
  assert.ok(softRear.rollShareFront > stiffRear.rollShareFront);
});

test('a wing click changes downforce and, at the rear, drag', () => {
  const base = applySetup(defaultSetup());
  const bigRear = applySetup({ ...defaultSetup(), rearWing: 20 });
  assert.ok(bigRear.claWingRear > base.claWingRear + 0.4);
  assert.ok(bigRear.cdaWings > 0.15, 'a big rear wing must cost real drag');

  const bigFront = applySetup({ ...defaultSetup(), frontWing: 20 });
  assert.ok(bigFront.claWingFront > base.claWingFront + 0.25);
  assert.ok(bigFront.cdaWings < bigRear.cdaWings, 'a front wing costs much less drag');
});

test('a wing can be removed without going negative', () => {
  const none = applySetup({ ...defaultSetup(), frontWing: 0, rearWing: 0 });
  assert.ok(none.claWingFront >= 0 && none.claWingRear >= 0);
});

test('ride height reaches the suspension in metres', () => {
  const low = applySetup({ ...defaultSetup(), rideFront: 20, rideRear: 60 });
  assert.ok(Math.abs(low.rideHeightFront - 0.020) < 1e-9);
  assert.ok(Math.abs(low.rideHeightRear - 0.060) < 1e-9);
});

test('tyre pressure is a peak, not a ramp — minimum pressure is not free', () => {
  // A straight line would make the lowest pressure optimal and turn a real trade
  // into an obvious choice.
  const at = psi => applySetup({ ...defaultSetup(), pressureFront: psi }).muScaleFront;
  const ref = at(PRESSURE_REF_FRONT);
  assert.ok(at(PRESSURE_REF_FRONT - 3) < ref, 'under-pressure must cost grip');
  assert.ok(at(PRESSURE_REF_FRONT + 3) < ref, 'and so must over-pressure');
  assert.ok(ref >= at(20) && ref >= at(27));
});

test('pressure moves the tyre spring rate as well as its grip', () => {
  const soft = applySetup({ ...defaultSetup(), pressureRear: 18 });
  const hard = applySetup({ ...defaultSetup(), pressureRear: 25 });
  assert.ok(hard.tyreKRear > soft.tyreKRear * 1.1, `${soft.tyreKRear} vs ${hard.tyreKRear}`);
  assert.ok(soft.tyreKRear > 0);
});

test('brake bias and the differential arrive as fractions', () => {
  const a = applySetup({ ...defaultSetup(), brakeBias: 62, diffLock: 80 });
  assert.ok(Math.abs(a.brakeBiasFront - 0.62) < 1e-9);
  assert.ok(Math.abs(a.diffLock - 0.80) < 1e-9);
});

test('corner loads follow the setup mass and stay rear-biased', () => {
  const light = cornerLoads(applySetup({ ...defaultSetup(), fuel: 5 }).mass);
  const heavy = cornerLoads(applySetup({ ...defaultSetup(), fuel: 110 }).mass);
  assert.ok(heavy[0] > light[0]);
  assert.ok(light[2] > light[0], 'the engine is at the back whatever the fuel load');
  assert.ok(Math.abs(light.reduce((a, b) => a + b) - 705 * G) < 20);
});

test('describeSetup reports the derived quantities, not the clicks', () => {
  // "58.7% of roll stiffness on the front axle" decides the balance; "front bar 6"
  // does not.
  const d = describeSetup(applySetup(defaultSetup()));
  assert.ok(/roll stiffness/.test(d.rollBalance));
  assert.ok(/load transfer/.test(d.transferBalance));
  assert.ok(/mm rake/.test(d.rake));
  assert.ok(/kg/.test(d.mass));
});

// ---------------------------------------------------------------------------
// And it reaches the car
// ---------------------------------------------------------------------------

/** Hold a steer angle at a speed and report the lateral g the car sustains. */
function corner(setup, steerDeg, speedMs = 55, seconds = 4) {
  const car = createCar({ setup });
  warmUp(car);
  launch(car, speedMs);
  const steer = steerDeg * Math.PI / 180;
  let sum = 0;
  let n = 0;
  const total = Math.round(seconds / DT);
  for (let i = 0; i < total; i++) {
    const throttle = forwardSpeed(car) < speedMs ? 0.4 : 0;
    step(car, { throttle, brake: 0, steer }, FLAT, DT);
    if (i > total * 0.6) { sum += lateralG(car); n++; }
  }
  return { ay: sum / n, yaw: yawRate(car), car };
}

test('a stiff front bar makes the car turn LESS than a stiff rear bar', () => {
  // The whole point of roll stiffness distribution, measured on the car rather
  // than asserted about the arithmetic.
  const understeer = corner({ ...defaultSetup(), arbFront: 11, arbRear: 1 }, 4);
  const oversteer = corner({ ...defaultSetup(), arbFront: 1, arbRear: 11 }, 4);
  assert.ok(
    oversteer.ay > understeer.ay,
    `stiff rear ${oversteer.ay.toFixed(3)} g should out-turn stiff front `
    + `${understeer.ay.toFixed(3)} g at the same steer angle`,
  );
});

test('a bigger rear wing costs top speed', () => {
  const run = setup => {
    const car = createCar({ setup });
    warmUp(car);
    launch(car, 60);
    for (let i = 0; i < 600 * 45; i++) {
      step(car, { throttle: 1, brake: 0, steer: 0, drs: false }, FLAT, DT);
    }
    return forwardSpeed(car) * 3.6;
  };
  const small = run({ ...defaultSetup(), rearWing: 2 });
  const big = run({ ...defaultSetup(), rearWing: 20 });
  assert.ok(small > big + 3, `small wing ${small.toFixed(0)} vs big ${big.toFixed(0)} km/h`);
});

test('less fuel accelerates harder', () => {
  const to100 = setup => {
    const car = createCar({ setup });
    warmUp(car);
    let t = 0;
    for (let i = 0; i < 600 * 20; i++) {
      step(car, { throttle: 0.35, brake: 0, steer: 0 }, FLAT, DT);
      t += DT;
      if (forwardSpeed(car) * 3.6 >= 100) return t;
    }
    return Infinity;
  };
  const light = to100({ ...defaultSetup(), fuel: 5 });
  const heavy = to100({ ...defaultSetup(), fuel: 110 });
  assert.ok(light < heavy, `light ${light.toFixed(2)} s vs heavy ${heavy.toFixed(2)} s`);
});

test('a setup change cannot half-apply', () => {
  // One derivation, so every subsystem sees the same setup or none of them do.
  const car = createCar({ setup: { ...defaultSetup(), springFront: 340, arbFront: 11 } });
  assert.ok(Math.abs(car.suspension.kSpringFront - 340000) < 1);
  assert.ok(Math.abs(car.suspension.arbFront - car.tune.arbFront) < 1e-9);
  assert.ok(Math.abs(car.tune.rollShareFront - (
    car.tune.kRollFront / (car.tune.kRollFront + car.tune.kRollRear))) < 1e-12);
});
