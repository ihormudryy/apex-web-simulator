import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLA_WING_FRONT, CLA_FLOOR_FRONT, CLA_WING_REAR, CLA_FLOOR_REAR,
  H_OPT_FRONT, H_OPT_REAR, H_STALL_FRONT, H_STALL_REAR, VENTURI_EXPONENT,
  CDA_BODY, CDA_REAR_WING, CDA_REAR_WING_DRS, CDA_INDUCED_K, DRS_CLA_LOSS,
  YAW_CLA_LOSS, YAW_CLA_FLOOR, YAW_CDA_GAIN, RIDE_AERO_TAU,
  CYA_BODY, X_CP, K_PLANK, PLANK_FRICTION,
  AERO_LAG_LENGTH, REATTACH_LAG_FACTOR, lagFloor, filterRideHeights,
  floorFactor, clAtRideHeight, optimumRideHeight,
  createAeroState, groundEffect, drs, dragArea, aeroPitchMoment,
} from './aero.js';
import {
  createSuspensionState, step as suspStep, RIDE_HEIGHT_FRONT, RIDE_HEIGHT_REAR,
} from './suspension.js';
import { RHO, G, WB } from './constants.js';

const DT = 1 / 600;
const FLAT = [0, 0, 0, 0];
const DEG = Math.PI / 180;

const at = (o, c) => groundEffect(o, {
  speed: 0, rideFront: 0.02, rideRear: 0.05, sideslip: 0, yawRate: 0, drs: false, ...c,
});

// ---------------------------------------------------------------------------
// The floor curve
// ---------------------------------------------------------------------------

test('the floor peaks at its optimum ride height', () => {
  const peak = floorFactor(H_OPT_FRONT, H_OPT_FRONT, H_STALL_FRONT);
  assert.ok(Math.abs(peak - 1) < 1e-9);
  assert.ok(floorFactor(H_OPT_FRONT * 2, H_OPT_FRONT, H_STALL_FRONT) < peak);
  assert.ok(floorFactor(H_OPT_FRONT * 0.5, H_OPT_FRONT, H_STALL_FRONT) < peak);
});

test('downforce RISES as the floor approaches the ground — the venturi', () => {
  let prev = 0;
  for (let h = 0.06; h >= H_OPT_FRONT; h -= 0.002) {
    const f = floorFactor(h, H_OPT_FRONT, H_STALL_FRONT);
    assert.ok(f > prev, `factor fell from ${prev} to ${f} at h=${h}`);
    prev = f;
  }
});

test('and then COLLAPSES below the optimum — not a linear ClA', () => {
  const peak = floorFactor(H_OPT_FRONT, H_OPT_FRONT, H_STALL_FRONT);
  const stalled = floorFactor(H_OPT_FRONT - H_STALL_FRONT * 0.6, H_OPT_FRONT, H_STALL_FRONT);
  assert.ok(stalled < peak * 0.7, `only fell to ${stalled.toFixed(2)} of peak`);
  assert.equal(floorFactor(H_OPT_FRONT - H_STALL_FRONT, H_OPT_FRONT, H_STALL_FRONT), 0);
});

test('the collapse is sharper than the gain — attachment is progressive, separation is not', () => {
  const d = 0.004;
  const above = 1 - floorFactor(H_OPT_FRONT + d, H_OPT_FRONT, H_STALL_FRONT);
  const below = 1 - floorFactor(H_OPT_FRONT - d, H_OPT_FRONT, H_STALL_FRONT);
  assert.ok(below > above, `${d * 1000} mm below costs ${below.toFixed(3)}, above only ${above.toFixed(3)}`);
});

test('a floor on the ground makes no downforce at all', () => {
  assert.equal(floorFactor(0, H_OPT_FRONT, H_STALL_FRONT), 0);
  assert.equal(floorFactor(-0.01, H_OPT_FRONT, H_STALL_FRONT), 0);
});

test('the optima sit inside the range the car operates in', () => {
  // If they sat below it, the curve would be monotonic in practice and the whole
  // model would reduce to a slightly curved constant.
  assert.ok(H_OPT_FRONT > 0 && H_OPT_FRONT < RIDE_HEIGHT_FRONT);
  assert.ok(H_OPT_REAR > 0 && H_OPT_REAR < RIDE_HEIGHT_REAR);
  assert.equal(optimumRideHeight(true), H_OPT_FRONT);
  assert.equal(optimumRideHeight(false), H_OPT_REAR);
});

test('the wings keep working when the floor has stalled', () => {
  assert.ok(clAtRideHeight(0, true) >= CLA_WING_FRONT - 1e-9);
  assert.ok(clAtRideHeight(0, false) >= CLA_WING_REAR - 1e-9);
  assert.ok(CLA_FLOOR_FRONT > CLA_WING_FRONT, 'the floor must be the bigger share');
  assert.ok(CLA_FLOOR_REAR > CLA_WING_REAR);
});

test('total ClA at the optima is a realistic 2022+ figure', () => {
  const total = clAtRideHeight(H_OPT_FRONT, true) + clAtRideHeight(H_OPT_REAR, false);
  assert.ok(total > 4 && total < 6, `ClA ${total}`);
});

// ---------------------------------------------------------------------------
// Downforce and drag against the reference figures
// ---------------------------------------------------------------------------

test('downforce at 300 km/h is near the 2000 kg reference figure', () => {
  const s = createAeroState();
  // At the ride heights the car settles at, from the coupled sweep.
  at(s, { speed: 300 / 3.6, rideFront: 0.0076, rideRear: 0.0426 });
  const kg = s.downforce / G;
  assert.ok(Math.abs(kg - 2000) < 2000 * 0.2, `${kg.toFixed(0)} kg at 300 km/h`);
});

test('downforce scales with the square of speed', () => {
  const s = createAeroState();
  at(s, { speed: 40, rideFront: 0.02, rideRear: 0.05 });
  const low = s.downforce;
  at(s, { speed: 80, rideFront: 0.02, rideRear: 0.05 });
  assert.ok(Math.abs(s.downforce / low - 4) < 0.01, 'must be quadratic at fixed ride height');
});

test('dynamic pressure is the textbook value', () => {
  const s = createAeroState();
  at(s, { speed: 50 });
  assert.ok(Math.abs(s.q - 0.5 * RHO * 2500) < 1e-6);
});

test('CdA is near the 1.55 reference and grows with downforce', () => {
  assert.ok(Math.abs(dragArea(4.6) - 1.55) < 0.1, `${dragArea(4.6)}`);
  assert.ok(dragArea(5.0) > dragArea(4.0), 'induced drag must follow ClA');
  assert.ok(CDA_INDUCED_K > 0);
});

test('drag is zero at rest and quadratic in speed', () => {
  const s = createAeroState();
  at(s, { speed: 0 });
  assert.equal(s.drag, 0);
  at(s, { speed: 30 });
  const a = s.drag;
  at(s, { speed: 60 });
  assert.ok(Math.abs(s.drag / a - 4) < 0.01);
});

// ---------------------------------------------------------------------------
// Aero balance
// ---------------------------------------------------------------------------

test('aero balance MOVES with ride height — a lumped number cannot do this', () => {
  const s = createAeroState();
  at(s, { speed: 80, rideFront: 0.020, rideRear: 0.060 });
  const high = s.balanceFront;
  at(s, { speed: 80, rideFront: 0.004, rideRear: 0.035 });
  const low = s.balanceFront;
  assert.ok(
    Math.abs(high - low) > 0.04,
    `balance barely moved: ${(high * 100).toFixed(1)}% to ${(low * 100).toFixed(1)}%`,
  );
});

test('the balance moves FORWARD as the front floor approaches its optimum', () => {
  const s = createAeroState();
  at(s, { speed: 80, rideFront: 0.030, rideRear: 0.050 });
  const tall = s.balanceFront;
  at(s, { speed: 80, rideFront: H_OPT_FRONT, rideRear: 0.050 });
  assert.ok(s.balanceFront > tall, 'closing the front gap must load the front');
});

test('the balance moves REARWARD once the front floor stalls', () => {
  const s = createAeroState();
  at(s, { speed: 80, rideFront: H_OPT_FRONT, rideRear: 0.040 });
  const best = s.balanceFront;
  at(s, { speed: 80, rideFront: 0.002, rideRear: 0.040 });
  assert.ok(s.balanceFront < best, 'a stalled front floor must cost front downforce');
});

test('the stall flags say which end has separated', () => {
  const s = createAeroState();
  at(s, { speed: 80, rideFront: 0.004, rideRear: 0.060 });
  assert.equal(s.stalledFront, true);
  assert.equal(s.stalledRear, false);
});

test('the aero pitch moment follows the front/rear split', () => {
  assert.ok(aeroPitchMoment(10000, 0) < 0, 'front load must pitch the nose down');
  assert.ok(aeroPitchMoment(0, 10000) > 0, 'rear load must pitch it up');
  assert.equal(Math.abs(aeroPitchMoment(0, 0)), 0);
});

// ---------------------------------------------------------------------------
// DRS
// ---------------------------------------------------------------------------

test('DRS sheds rear downforce and much more drag', () => {
  const s = createAeroState();
  at(s, { speed: 90, rideFront: 0.008, rideRear: 0.040 });
  const closed = { cla: s.claTotal, cda: s.cdA, rear: s.claRear, front: s.claFront };
  at(s, { speed: 90, rideFront: 0.008, rideRear: 0.040, drs: true });
  assert.ok(s.claRear < closed.rear, 'rear ClA must fall');
  assert.equal(s.claFront, closed.front, 'and the front wing must not be touched');
  const dragDrop = 1 - s.cdA / closed.cda;
  const claDrop = 1 - s.claTotal / closed.cla;
  assert.ok(dragDrop > claDrop, 'DRS must cost less downforce than it saves drag');
});

test('the DRS drag reduction is the ~14% that gives about +15 km/h', () => {
  const closed = dragArea(4.6, false);
  const open = dragArea(4.6 - DRS_CLA_LOSS, true);
  const reduction = 1 - open / closed;
  assert.ok(reduction > 0.10 && reduction < 0.18, `${(reduction * 100).toFixed(1)}%`);
  // Top speed goes as the cube root of the drag ratio.
  const gain = 330 * ((closed / open) ** (1 / 3) - 1);
  assert.ok(gain > 8 && gain < 22, `DRS would give +${gain.toFixed(0)} km/h`);
});

test('DRS cannot take the rear wing below its stalled floor', () => {
  assert.ok(drs(CLA_WING_REAR * 0.3, true) > 0, 'must not go negative');
  assert.equal(drs(3.0, false), 3.0, 'and must do nothing when closed');
});

test('opening DRS also opens the rear wing drag term', () => {
  assert.ok(CDA_REAR_WING_DRS < CDA_REAR_WING);
});

// ---------------------------------------------------------------------------
// Yaw
// ---------------------------------------------------------------------------

test('a sliding car loses downforce as well as direction', () => {
  const s = createAeroState();
  at(s, { speed: 80, sideslip: 0 });
  const straight = s.downforce;
  at(s, { speed: 80, sideslip: 12 * DEG });
  assert.ok(s.downforce < straight * 0.95, `${s.downforce} vs ${straight}`);
});

test('and gains drag, which is why a slide costs so much time', () => {
  const s = createAeroState();
  at(s, { speed: 80, sideslip: 0 });
  const straight = s.cdA;
  at(s, { speed: 80, sideslip: 15 * DEG });
  assert.ok(s.cdA > straight, 'drag must rise in yaw');
  assert.ok(YAW_CDA_GAIN > 0);
});

test('the yaw downforce loss has a floor — a spinning car is not weightless', () => {
  const s = createAeroState();
  at(s, { speed: 80, sideslip: 90 * DEG });
  assert.ok(s.claTotal > 0, `ClA ${s.claTotal} in a full spin`);
  assert.ok(YAW_CLA_FLOOR > 0.2 && YAW_CLA_FLOOR < 0.7);
});

test('yaw loss is symmetric in slide direction', () => {
  const s = createAeroState();
  at(s, { speed: 80, sideslip: 0.2 });
  const left = s.downforce;
  at(s, { speed: 80, sideslip: -0.2 });
  assert.ok(Math.abs(s.downforce - left) < 1e-9);
});

// ---------------------------------------------------------------------------
// Body side force and yaw damping — replacing the fudge
// ---------------------------------------------------------------------------

test('the body weathervanes: sideslip produces a restoring yaw moment', () => {
  const s = createAeroState();
  at(s, { speed: 60, sideslip: 0.1, yawRate: 0 });
  assert.ok(s.sideForce < 0, 'sliding right must be opposed');
  // A leftward force behind the CoG yaws the nose right, into the slide.
  assert.ok(s.yawMoment < 0, `yaw moment ${s.yawMoment} must oppose the sideslip`);
  at(s, { speed: 60, sideslip: -0.1, yawRate: 0 });
  assert.ok(s.yawMoment > 0, 'and must be antisymmetric');
});

test('yaw RATE alone produces a damping moment, with no sideslip at all', () => {
  const s = createAeroState();
  at(s, { speed: 60, sideslip: 0, yawRate: 1.0 });
  assert.ok(Math.abs(s.yawMoment) > 1, 'a yawing car must be damped by its bodywork');
  const positive = s.yawMoment;
  at(s, { speed: 60, sideslip: 0, yawRate: -1.0 });
  assert.ok(s.yawMoment * positive < 0, 'and the damping must oppose the rate');
});

test('aero yaw damping grows with speed, unlike the constant it replaces', () => {
  const s = createAeroState();
  at(s, { speed: 30, sideslip: 0, yawRate: 1 });
  const slow = Math.abs(s.yawMoment);
  at(s, { speed: 90, sideslip: 0, yawRate: 1 });
  assert.ok(Math.abs(s.yawMoment) > slow * 2, `${slow.toFixed(0)} vs ${Math.abs(s.yawMoment).toFixed(0)}`);
});

test('the centre of pressure is behind the CoG, or the car would be unstable', () => {
  assert.ok(X_CP < 0, 'ahead of the CoG makes a weathervane that points backwards');
  assert.ok(Math.abs(X_CP) < WB / 2, 'and it must be on the car');
  assert.ok(CYA_BODY > 0);
});

test('there is no side force at rest', () => {
  const s = createAeroState();
  at(s, { speed: 0, sideslip: 0.3, yawRate: 2 });
  assert.equal(Math.abs(s.sideForce), 0);
  assert.equal(Math.abs(s.yawMoment), 0);
});

// ---------------------------------------------------------------------------
// Skid plank
// ---------------------------------------------------------------------------

test('the plank does nothing until the floor is on the ground', () => {
  const s = createAeroState();
  at(s, { speed: 80, rideFront: 0.001, rideRear: 0.03 });
  assert.equal(s.plankFront, 0);
  assert.equal(s.plankContact, false);
});

test('a grounded floor gives a real force spike, and it pushes UP', () => {
  const s = createAeroState();
  at(s, { speed: 80, rideFront: -0.002, rideRear: 0.03 });
  assert.ok(s.plankFront > 5000, `only ${s.plankFront} N of plank force`);
  assert.equal(s.plankContact, true);
  assert.ok(K_PLANK > 1e6, 'titanium on a stiff floor is not compliant');
});

test('the plank drags as well as pushes — sparks cost time', () => {
  const s = createAeroState();
  at(s, { speed: 80, rideFront: -0.003, rideRear: -0.001 });
  assert.ok(s.plankDrag > 0);
  assert.ok(Math.abs(s.plankDrag - PLANK_FRICTION * (s.plankFront + s.plankRear)) < 1e-6);
});

test('the plank reports which end is down, so sparks come from the right place', () => {
  const s = createAeroState();
  at(s, { speed: 80, rideFront: 0.01, rideRear: -0.004 });
  assert.equal(s.plankFront, 0);
  assert.ok(s.plankRear > 0);
});

// ---------------------------------------------------------------------------
// Aerodynamic lag
// ---------------------------------------------------------------------------

test('the floor takes time to respond, and less time at speed', () => {
  const slow = lagFloor(1, 0, 20, 0.01);
  const fast = lagFloor(1, 0, 90, 0.01);
  assert.ok(fast < slow, 'a faster car re-establishes its flow field sooner');
  assert.ok(slow < 1 && slow > 0, 'and the response must actually lag');
});

test('separation is faster than reattachment — the asymmetry that pumps the cycle', () => {
  const separating = 1 - lagFloor(1, 0, 90, 0.01);
  const reattaching = lagFloor(0, 1, 90, 0.01);
  assert.ok(separating > reattaching * 2, `${separating.toFixed(3)} vs ${reattaching.toFixed(3)}`);
  assert.ok(REATTACH_LAG_FACTOR > 1);
});

test('the lag time constant is the floor length over the airspeed', () => {
  const tau = AERO_LAG_LENGTH / 90;
  const afterTau = 1 - lagFloor(1, 0, 90, tau);
  assert.ok(Math.abs(afterTau - (1 - Math.exp(-1))) < 0.02, `${afterTau.toFixed(4)}`);
});

test('the lag is stable and bounded at any step size', () => {
  for (const dt of [DT, 1 / 30, 1, 100]) {
    let v = 1;
    for (let i = 0; i < 200; i++) v = lagFloor(v, 0, 90, dt);
    assert.ok(v >= 0 && v <= 1, `dt=${dt} gave ${v}`);
  }
});

test('omitting dt gives the steady-state coefficient', () => {
  assert.equal(lagFloor(0.2, 0.9, 90, 0), 0.9);
});

// ---------------------------------------------------------------------------
// The acid test
// ---------------------------------------------------------------------------

/** Run the coupled aero/suspension system and report the ride-height cycle. */
function coupled(kmh, seconds = 8, ay = 0) {
  const s = createSuspensionState();
  const a = createAeroState();
  const load = { ground: FLAT, aeroFront: 0, aeroRear: 0, ay, ax: 0 };
  const cond = {
    speed: kmh / 3.6, rideFront: RIDE_HEIGHT_FRONT, rideRear: RIDE_HEIGHT_REAR,
    sideslip: 0, yawRate: 0, drs: false, dt: DT, ay,
  };
  const n = Math.round(seconds / DT);
  const tail = [];
  const dfTail = [];
  for (let i = 0; i < n; i++) {
    cond.rideFront = s.rideFront;
    cond.rideRear = s.rideRear;
    groundEffect(a, cond);
    // The plank pushes up, so it is subtracted from the downward aero load.
    load.aeroFront = a.fzFront - a.plankFront;
    load.aeroRear = a.fzRear - a.plankRear;
    load.ay = ay;
    suspStep(s, load, DT);
    if (i > n - 1800) {
      tail.push(s.rideFront);
      dfTail.push(a.downforce);
    }
  }
  const mean = tail.reduce((p, q) => p + q, 0) / tail.length;
  let crossings = 0;
  for (let i = 1; i < tail.length; i++) {
    if ((tail[i - 1] - mean) * (tail[i] - mean) < 0) crossings++;
  }
  const dfMean = dfTail.reduce((p, q) => p + q, 0) / dfTail.length;
  const dfStd = Math.sqrt(dfTail.reduce((p, q) => p + (q - dfMean) ** 2, 0) / dfTail.length);
  return {
    amplitude: (Math.max(...tail) - Math.min(...tail)) * 1000,
    hz: crossings / 2 / (tail.length * DT),
    rideFront: mean * 1000,
    downforce: a.downforce / G,
    dfStd,
  };
}

test('PORPOISING EMERGES at high speed — the acid test for a coupled model', () => {
  const fast = coupled(320);
  assert.ok(
    fast.amplitude > 1,
    `no porpoising at 320 km/h (${fast.amplitude.toFixed(2)} mm) — something is a constant`,
  );
  assert.ok(
    fast.hz > 4 && fast.hz < 12,
    `porpoising at ${fast.hz.toFixed(1)} Hz, expected the 5-10 Hz band`,
  );
});

test('and does NOT appear at low speed, where the floor is nowhere near stalling', () => {
  const slow = coupled(150);
  assert.ok(slow.amplitude < 1, `${slow.amplitude.toFixed(2)} mm of bouncing at 150 km/h`);
});

test('cornering at medium speed does not hunt downforce from roll-induced ride height', () => {
  const corner = coupled(110, 8, 1.2 * G);
  assert.ok(
    corner.amplitude < 2,
    `${corner.amplitude.toFixed(2)} mm ride bounce at 110 km/h with 1.2 g lateral`,
  );
  assert.ok(
    corner.dfStd < 800,
    `${(corner.dfStd / 1000).toFixed(2)} kN downforce std in cornering`,
  );
});

test('ride heights are low-passed before the floor curve sees them', () => {
  const a = createAeroState();
  filterRideHeights(a, 0.020, 0.050, DT);
  assert.ok(Math.abs(a.rideFilterFront - 0.020) < 1e-9);
  filterRideHeights(a, 0.010, 0.050, DT);
  assert.ok(a.rideFilterFront > 0.010 && a.rideFilterFront < 0.020);
  assert.ok(RIDE_AERO_TAU > 0.02 && RIDE_AERO_TAU < 0.06);
});

test('the coupled car settles at a plausible ride height and downforce', () => {
  const s = coupled(300);
  assert.ok(s.rideFront > 0 && s.rideFront < 20, `${s.rideFront.toFixed(1)} mm of front ride height`);
  assert.ok(
    Math.abs(s.downforce - 2000) < 2000 * 0.25,
    `${s.downforce.toFixed(0)} kg at 300 km/h`,
  );
});

test('groundEffect writes into the state it is given and allocates nothing', () => {
  const s = createAeroState();
  assert.equal(at(s, { speed: 50 }), s);
});
