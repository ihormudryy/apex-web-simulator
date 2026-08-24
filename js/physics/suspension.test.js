import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  UNSPRUNG_MASS, SPRUNG_MASS, I_PITCH, I_ROLL, TRACK,
  K_SPRING_FRONT, K_SPRING_REAR,
  C_BUMP_FRONT, C_REBOUND_FRONT, DIGRESSIVE_KNEE,
  ARB_FRONT, ARB_REAR, K_ROLL_FRONT, K_ROLL_REAR, ROLL_STIFFNESS_FRONT_SHARE,
  H_ROLL, RC_HEIGHT_FRONT, RC_HEIGHT_REAR, ROLL_AXIS_AT_CG,
  K_HEAVE_FRONT, HEAVE_GAP, heaveForce,
  BUMP_STOP_GAP_FRONT, DROOP_TRAVEL_FRONT, bumpStopForce, bumpStopRate,
  damperForce, damperRate, suspensionForce,
  RIDE_HEIGHT_FRONT, RIDE_HEIGHT_REAR, MAX_ROLL, MAX_PITCH,
  createSuspensionState, resetSuspension, step, solve7,
  rideFrequency, wheelHopFrequency, FZ_STATIC, CORNER_AX, CORNER_AY,
} from './suspension.js';
import {
  wheelNormalLoads, totalLateralTransfer, LATERAL_TRANSFER_FRONT_SHARE,
  LATERAL_ARM_FRONT, LATERAL_ARM_REAR,
} from './loadTransfer.js';
import { MASS, G, H_CG } from './constants.js';

const DT = 1 / 600;
const DEG = Math.PI / 180;
const FLAT = [0, 0, 0, 0];
const DOWNFORCE_300 = 2000 * G;

/** Run to steady state under a constant load and return the state. */
function settle(load, seconds = 3, dt = DT) {
  const s = createSuspensionState();
  const full = { ground: FLAT, ...load };
  for (let i = 0; i < Math.round(seconds / dt); i++) step(s, full, dt);
  return s;
}

// ---------------------------------------------------------------------------
// The numbers that justify the design
// ---------------------------------------------------------------------------

test('ride frequencies are F1-stiff, not road-car soft', () => {
  assert.ok(rideFrequency(true) > 5 && rideFrequency(true) < 8, `${rideFrequency(true)} Hz front`);
  assert.ok(rideFrequency(false) > 4 && rideFrequency(false) < 7, `${rideFrequency(false)} Hz rear`);
  assert.ok(rideFrequency(true) > rideFrequency(false), 'front must be stiffer than rear');
});

test('the wheel-hop mode is fast enough to need the implicit integrator', () => {
  const hz = wheelHopFrequency();
  assert.ok(hz > 15 && hz < 25, `${hz.toFixed(1)} Hz`);
  // This is the number in the plan's stability warning. If it drops, the
  // justification for the 7x7 solve goes with it.
  assert.ok(2 * Math.PI * hz > 100, 'wheel hop must be over 100 rad/s');
});

test('unsprung mass is realistic for an 18-inch wheel, and is not negligible', () => {
  assert.ok(UNSPRUNG_MASS > 15 && UNSPRUNG_MASS < 30, `${UNSPRUNG_MASS} kg`);
  assert.equal(SPRUNG_MASS, MASS - 4 * UNSPRUNG_MASS);
  assert.ok(SPRUNG_MASS > 0.8 * MASS);
});

test('inertias are those of a long narrow car', () => {
  assert.ok(I_PITCH > I_ROLL * 4, 'pitch inertia must dominate roll inertia');
});

// ---------------------------------------------------------------------------
// Force laws
// ---------------------------------------------------------------------------

test('dampers are asymmetric — rebound stiffer than bump', () => {
  assert.ok(C_REBOUND_FRONT > C_BUMP_FRONT);
  assert.ok(Math.abs(damperForce(-0.01, 0)) > Math.abs(damperForce(0.01, 0)));
});

test('a hard ground step does not launch the chassis into the sky', () => {
  // Deviation-coordinate suspension cancels gravity at equilibrium. When a kerb
  // punches the car airborne, that cancellation used to leave the SPRUNG mass
  // weightless — upward velocity from the hit never came back, and zc ran away
  // to metres. Rejoining from the grass looked like a 1 m suspension.
  const s = createSuspensionState();
  const ground = [0, 0, 0, 0];
  const load = { ground, aeroFront: 0, aeroRear: 0, ax: 0, ay: 0 };
  for (let i = 0; i < Math.round(2 / DT); i++) step(s, load, DT);
  ground.fill(0.05);
  for (let i = 0; i < Math.round(2 / DT); i++) step(s, load, DT);
  const err = Math.abs(s.zc - 0.05);
  assert.ok(err < 0.03, `chassis at ${(s.zc * 1000).toFixed(0)} mm after a 50 mm step (want ~50)`);
  assert.ok(Math.abs(s.vc) < 0.2, `still flying at vc=${s.vc.toFixed(2)} m/s`);
});

test('even a half-metre cliff settles back onto the road', () => {
  const s = createSuspensionState();
  const ground = [0, 0, 0, 0];
  const load = { ground, aeroFront: 0, aeroRear: 0, ax: 0, ay: 0 };
  for (let i = 0; i < Math.round(1 / DT); i++) step(s, load, DT);
  ground.fill(0.5);
  for (let i = 0; i < Math.round(3 / DT); i++) step(s, load, DT);
  assert.ok(
    Math.abs(s.zc - 0.5) < 0.08,
    `chassis escaped to ${(s.zc * 1000).toFixed(0)} mm after a 500 mm step`,
  );
});

test('bump damping is digressive, so a sharp kerb hit is not fought', () => {
  const slow = damperForce(DIGRESSIVE_KNEE * 0.5, 0) / (DIGRESSIVE_KNEE * 0.5);
  const fast = damperForce(DIGRESSIVE_KNEE * 8, 0) / (DIGRESSIVE_KNEE * 8);
  assert.ok(fast < slow * 0.8, `effective rate ${fast.toFixed(0)} vs ${slow.toFixed(0)}`);
  assert.ok(damperRate(1.0, 0) < damperRate(0.01, 0));
});

test('rebound damping stays linear, so the car settles after a step', () => {
  // Digressive rebound was the "boing after rejoining": the unload after a kerb
  // ran at 35% of the rebound rate and the platform rang for seconds.
  const slow = damperForce(-DIGRESSIVE_KNEE * 0.5, 0) / (-DIGRESSIVE_KNEE * 0.5);
  const fast = damperForce(-DIGRESSIVE_KNEE * 8, 0) / (-DIGRESSIVE_KNEE * 8);
  assert.ok(
    Math.abs(fast - slow) / slow < 0.05,
    `rebound digressed: ${fast.toFixed(0)} vs ${slow.toFixed(0)}`,
  );
  assert.ok(Math.abs(damperRate(-1.0, 0) - damperRate(-0.01, 0)) < 1);
});

test('the platform settles after a kerb-sized ground drop instead of bouncing on', () => {
  const s = createSuspensionState();
  const ground = [0.05, 0.05, 0.05, 0.05];
  const load = { ground, aeroFront: 6000, aeroRear: 9000, ax: 0, ay: 0 };
  for (let i = 0; i < Math.round(2 / DT); i++) step(s, load, DT);
  // Rejoin from runoff climbs the outer ramp over a few tenths, not as a cliff.
  const rampSteps = Math.round(0.25 / DT);
  for (let i = 0; i < rampSteps; i++) {
    const h = 0.05 * (1 - (i + 1) / rampSteps);
    ground.fill(h);
    step(s, load, DT);
  }
  ground.fill(0);
  const heave = [];
  for (let i = 0; i < Math.round(1.5 / DT); i++) {
    step(s, load, DT);
    heave.push(s.zc);
  }
  const late = heave.slice(Math.round(0.4 / DT));
  const p2p = (Math.max(...late) - Math.min(...late)) * 1000;
  assert.ok(p2p < 10, `still ringing ${p2p.toFixed(1)} mm peak-to-peak after rejoin`);
});

test('damper force opposes motion and vanishes at rest', () => {
  assert.equal(damperForce(0, 0), 0);
  assert.ok(damperForce(0.05, 0) > 0);
  assert.ok(damperForce(-0.05, 0) < 0);
});

test('bump stops do nothing inside the gap and a great deal outside it', () => {
  assert.equal(bumpStopForce(BUMP_STOP_GAP_FRONT * 0.9, 0), 0);
  assert.ok(bumpStopForce(BUMP_STOP_GAP_FRONT + 0.005, 0) > 10000);
  assert.ok(bumpStopRate(BUMP_STOP_GAP_FRONT * 0.9, 0) === 0);
});

test('bump stops are progressive, not linear', () => {
  const a = bumpStopForce(BUMP_STOP_GAP_FRONT + 0.002, 0);
  const b = bumpStopForce(BUMP_STOP_GAP_FRONT + 0.004, 0);
  assert.ok(b > a * 2, 'a packer gets stiffer the harder it is hit');
});

test('droop stops resist extension — without them an airborne corner has no limit', () => {
  assert.equal(bumpStopForce(-DROOP_TRAVEL_FRONT * 0.9, 0), 0);
  const f = bumpStopForce(-DROOP_TRAVEL_FRONT - 0.005, 0);
  assert.ok(f < -10000, `droop force ${f} must pull the chassis down`);
  assert.ok(bumpStopRate(-DROOP_TRAVEL_FRONT - 0.005, 0) > 0);
});

test('spring travel plus tyre deflection is the 20-30 mm a modern F1 car has', () => {
  // The tyre is in series with the spring and takes the larger share, so the gap
  // itself is smaller than the total travel figure.
  const tyreShare = (FZ_STATIC[0] + 0.4 * DOWNFORCE_300 / 2) / 310000;
  const total = BUMP_STOP_GAP_FRONT + tyreShare;
  assert.ok(total > 0.02 && total < 0.045, `${(total * 1000).toFixed(1)} mm of travel`);
  assert.ok(BUMP_STOP_GAP_FRONT < RIDE_HEIGHT_FRONT, 'the gap must be reachable at all');
});

test('heave elements act on symmetric compression only', () => {
  assert.equal(heaveForce(HEAVE_GAP * 0.5, true), 0, 'nothing inside the gap');
  assert.ok(heaveForce(HEAVE_GAP + 0.01, true) > 0);
  assert.ok(heaveForce(-(HEAVE_GAP + 0.01), true) < 0, 'and works in extension too');
  assert.ok(K_HEAVE_FRONT > 0);
});

test('a heave spring adds no roll stiffness — that is the point of it', () => {
  // Pure roll leaves axle compression at zero, so the third spring never picks up.
  const s = settle({ ay: 2 * G, aeroFront: 0.4 * DOWNFORCE_300, aeroRear: 0.6 * DOWNFORCE_300 });
  const axleFront = 0.5 * (s.compression[0] + s.compression[1]);
  const rollPart = 0.5 * (s.compression[0] - s.compression[1]);
  assert.ok(Math.abs(rollPart) > Math.abs(axleFront) * 0.1, 'the roll must be visible');
});

test('suspensionForce sums the spring, damper, stops, heave and bar', () => {
  const compression = 0.005;
  const bare = suspensionForce(compression, 0, 0, 0, 0);
  assert.ok(Math.abs(bare - K_SPRING_FRONT * compression) < 1e-6);
  assert.ok(suspensionForce(compression, 0.05, 0, 0, 0) > bare, 'damping must add');
  assert.ok(suspensionForce(compression, 0, 0, 0, 0.02) !== bare, 'the bar must act on roll');
});

// ---------------------------------------------------------------------------
// Roll stiffness distribution — the balance lever
// ---------------------------------------------------------------------------

test('roll stiffness is biased forward, which is what makes the car stable', () => {
  assert.ok(K_ROLL_FRONT > K_ROLL_REAR);
  assert.ok(
    ROLL_STIFFNESS_FRONT_SHARE > 0.5 && ROLL_STIFFNESS_FRONT_SHARE < 0.7,
    `${(ROLL_STIFFNESS_FRONT_SHARE * 100).toFixed(1)}%`,
  );
});

test('the bars are what move the distribution — springs alone are not enough', () => {
  const springOnly = 0.5 * K_SPRING_FRONT * TRACK * TRACK;
  const springShare = springOnly / (springOnly + 0.5 * K_SPRING_REAR * TRACK * TRACK);
  assert.ok(
    Math.abs(ROLL_STIFFNESS_FRONT_SHARE - springShare) > 0.01,
    'the anti-roll bars must actually change the distribution',
  );
  assert.ok(ARB_FRONT > ARB_REAR, 'a forward bar bias is the understeer setting');
});

test('lateral load transfer is now split by axle, not applied evenly', () => {
  const [fl, fr, rl, rr] = wheelNormalLoads(0, 10, 0);
  const dF = (fl - fr) / 2;
  const dR = (rl - rr) / 2;
  assert.ok(Math.abs(dF - dR) > 1, `front ${dF.toFixed(1)} N and rear ${dR.toFixed(1)} N are equal`);
  assert.ok(dF > dR, 'the stiffer axle must take more');
});

test('changing the split moves load between axles and never creates any', () => {
  for (const ay of [-12, -5, 0.5, 3, 10]) {
    const [fl, fr, rl, rr] = wheelNormalLoads(0, ay, 0);
    const total = (fl - fr) / 2 + (rl - rr) / 2;
    assert.ok(
      Math.abs(total - totalLateralTransfer(ay)) < 1e-6,
      `ay=${ay}: split total ${total.toFixed(2)} != ${totalLateralTransfer(ay).toFixed(2)}`,
    );
  }
});

test('the elastic and geometric arms sum to the CoG height', () => {
  assert.ok(Math.abs(LATERAL_ARM_FRONT + LATERAL_ARM_REAR - H_CG) < 1e-9);
  assert.ok(Math.abs(H_ROLL + ROLL_AXIS_AT_CG - H_CG) < 1e-9);
});

test('roll centres are as low as F1 runs them', () => {
  assert.ok(RC_HEIGHT_FRONT < 0.08 && RC_HEIGHT_REAR < 0.10);
  assert.ok(H_ROLL > 0.2, 'so nearly all transfer is elastic and therefore tunable');
});

test('the front share of lateral transfer follows the roll stiffness share', () => {
  assert.ok(LATERAL_TRANSFER_FRONT_SHARE > 0.5 && LATERAL_TRANSFER_FRONT_SHARE < 0.65);
});

test('the four static loads sum to the car weight and are rear-biased', () => {
  const sum = FZ_STATIC.reduce((a, b) => a + b);
  assert.ok(Math.abs(sum - MASS * G) < 1);
  assert.ok(FZ_STATIC[2] > FZ_STATIC[0], 'the engine is at the back');
});

// ---------------------------------------------------------------------------
// The step
// ---------------------------------------------------------------------------

test('an unloaded car sits exactly still — the coordinates are displacement from static', () => {
  const s = settle({}, 5);
  assert.equal(s.zc, 0);
  assert.equal(s.pitch, 0);
  assert.equal(s.roll, 0);
  for (let i = 0; i < 4; i++) {
    assert.ok(Math.abs(s.fz[i] - FZ_STATIC[i]) < 1, `corner ${i} drifted off static`);
  }
});

test('downforce compresses the car and closes the ride height', () => {
  const s = settle({ aeroFront: 0.4 * DOWNFORCE_300, aeroRear: 0.6 * DOWNFORCE_300 });
  assert.ok(s.rideFront < RIDE_HEIGHT_FRONT, 'the front must come down');
  assert.ok(s.rideRear < RIDE_HEIGHT_REAR, 'and so must the rear');
  assert.ok(s.rideFront > 0, 'but not through the floor at 300 km/h');
  const total = s.fz.reduce((a, b) => a + b);
  assert.ok(
    Math.abs(total - (MASS * G + DOWNFORCE_300)) < 200,
    `tyres carry ${(total / G).toFixed(0)} kg, expected ${((MASS * G + DOWNFORCE_300) / G).toFixed(0)}`,
  );
});

test('braking pitches the nose DOWN and loads the front', () => {
  const s = settle({
    ax: -5 * G, aeroFront: 0.4 * DOWNFORCE_300, aeroRear: 0.6 * DOWNFORCE_300,
  });
  assert.ok(s.pitch < 0, `pitch ${(s.pitch / DEG).toFixed(3)} deg must be nose-down`);
  assert.ok(s.rideFront < s.rideRear, 'the front must be lower than the rear');
});

test('accelerating pitches the nose UP', () => {
  const s = settle({ ax: 2 * G });
  assert.ok(s.pitch > 0, `pitch ${(s.pitch / DEG).toFixed(3)} deg must be nose-up`);
});

test('cornering right rolls the car onto its left side and loads the left wheels', () => {
  const s = settle({
    ay: 4 * G, aeroFront: 0.4 * DOWNFORCE_300, aeroRear: 0.6 * DOWNFORCE_300,
  });
  assert.ok(s.roll < 0, 'positive lateral accel must give negative (left-down) roll');
  assert.ok(s.fz[0] > s.fz[1], 'front-left must load');
  assert.ok(s.fz[2] > s.fz[3], 'rear-left must load');
});

test('body roll at high lateral g is a degree or two, not a road car lean', () => {
  const s = settle({
    ay: 5 * G, aeroFront: 0.4 * DOWNFORCE_300, aeroRear: 0.6 * DOWNFORCE_300,
  });
  const deg = Math.abs(s.roll / DEG);
  assert.ok(deg > 0.3 && deg < 3, `${deg.toFixed(2)} deg of roll at 5 g`);
});

test('a wheel that leaves the ground carries nothing, and the car stays sane', () => {
  const s = settle({ ay: 4 * G });     // 4 g with no downforce lifts the inside
  assert.equal(s.fz[1], 0, 'the inside front must be off the ground');
  assert.ok(Number.isFinite(s.roll) && Number.isFinite(s.zc));
  assert.ok(s.attitudeLimited, 'and the model must say it has left its valid range');
  assert.ok(Math.abs(s.roll) <= MAX_ROLL + 1e-9);
});

test('the attitude limit is a stated boundary, not a silent clamp', () => {
  // An input that is physically a rollover. What matters is that the flag is set,
  // so a caller can tell "the car is at 8 degrees" from "the model gave up".
  const ok = settle({ ay: G, aeroFront: 4000, aeroRear: 6000 });
  assert.equal(ok.attitudeLimited, false, 'normal cornering must not trip it');
  assert.ok(MAX_ROLL > 5 * DEG, 'and the limit must be well outside the working range');
  assert.ok(MAX_PITCH > 3 * DEG);
});

test('a one-sided kerb strike upsets the platform and then settles', () => {
  const s = createSuspensionState();
  const kerb = [0.03, 0, 0.03, 0];
  let peakRoll = 0;
  for (let i = 0; i < 60; i++) step(s, { ground: kerb }, DT);
  for (let i = 0; i < 600; i++) {
    step(s, { ground: FLAT }, DT);
    peakRoll = Math.max(peakRoll, Math.abs(s.roll));
  }
  assert.ok(peakRoll > 0.2 * DEG, `a 30 mm kerb barely moved the car: ${(peakRoll / DEG).toFixed(3)} deg`);
  assert.ok(Math.abs(s.roll) < 0.05 * DEG, `never settled: ${(s.roll / DEG).toFixed(4)} deg`);
});

test('a kerb strike is felt through the tyre load, not just the geometry', () => {
  const s = createSuspensionState();
  let peak = 0;
  for (let i = 0; i < 200; i++) {
    step(s, { ground: [i > 30 && i < 90 ? 0.03 : 0, 0, 0, 0] }, DT);
    peak = Math.max(peak, s.fz[0]);
  }
  assert.ok(peak > FZ_STATIC[0] * 1.5, `load spiked only to ${peak.toFixed(0)} N from ${FZ_STATIC[0].toFixed(0)}`);
});

test('the car rides its bump stops at speed, and not at rest', () => {
  assert.equal(settle({}).onBumpStop, false, 'a parked car is not on its stops');
  const fast = settle({ aeroFront: 0.4 * DOWNFORCE_300, aeroRear: 0.6 * DOWNFORCE_300 });
  assert.ok(fast.onBumpStop, 'at 300 km/h a modern F1 car is on the packers');
});

test('the integrator is stable and consistent from 600 Hz down to 60 Hz', () => {
  const ref = settle({ aeroFront: 8000, aeroRear: 12000 }, 3, 1 / 600);
  for (const dt of [1 / 300, 1 / 120, 1 / 60]) {
    const s = settle({ aeroFront: 8000, aeroRear: 12000 }, 3, dt);
    assert.ok(
      Math.abs(s.rideFront - ref.rideFront) < 0.002,
      `dt=${dt.toFixed(4)}: ride ${(s.rideFront * 1000).toFixed(2)} mm vs ${(ref.rideFront * 1000).toFixed(2)}`,
    );
  }
});

test('the integrator does not diverge even at absurd step sizes', () => {
  // Not accurate at 20 Hz against a 19 Hz wheel-hop mode — that is Nyquist, not a
  // bug. But it must stay bounded, because an explicit scheme would not.
  for (const dt of [1 / 20, 1 / 10, 0.5]) {
    const s = settle({ aeroFront: 8000, aeroRear: 12000, ax: -20, ay: 10 }, 5, dt);
    assert.ok(Number.isFinite(s.zc) && Math.abs(s.zc) < 5, `dt=${dt} gave zc=${s.zc}`);
  }
});

test('resetSuspension returns the car to static', () => {
  const s = settle({ aeroFront: 9000, ay: 20 });
  resetSuspension(s);
  assert.equal(s.zc, 0);
  assert.equal(s.roll, 0);
  assert.equal(s.attitudeLimited, false);
  assert.equal(s.fz[0], FZ_STATIC[0]);
});

test('the step allocates nothing — the scratch arrays are reused', () => {
  const s = createSuspensionState();
  const A = s._A;
  const b = s._b;
  step(s, { ground: FLAT, aeroFront: 5000 }, DT);
  assert.equal(s._A, A);
  assert.equal(s._b, b);
});

test('corner lever arms put the front ahead and the left to one side', () => {
  assert.ok(CORNER_AX[0] > 0 && CORNER_AX[2] < 0, 'front positive, rear negative');
  assert.ok(CORNER_AY[0] > 0 && CORNER_AY[1] < 0, 'left and right must differ in sign');
  assert.equal(CORNER_AY[0], CORNER_AY[2], 'both left corners on the same side');
});

// ---------------------------------------------------------------------------
// The linear solver
// ---------------------------------------------------------------------------

test('solve7 solves a system it is given', () => {
  const A = new Float64Array(49);
  const b = new Float64Array(7);
  for (let i = 0; i < 7; i++) {
    A[i * 7 + i] = i + 2;
    b[i] = (i + 2) * (i + 1);
  }
  solve7(A, b);
  for (let i = 0; i < 7; i++) assert.ok(Math.abs(b[i] - (i + 1)) < 1e-9, `x${i}=${b[i]}`);
});

test('solve7 handles a system needing a row swap', () => {
  // Zero on the diagonal: without pivoting this divides by zero.
  const A = new Float64Array(49);
  const b = new Float64Array(7);
  A[0 * 7 + 1] = 2; A[1 * 7 + 0] = 3;
  for (let i = 2; i < 7; i++) A[i * 7 + i] = 1;
  b[0] = 4; b[1] = 9;
  solve7(A, b);
  assert.ok(Math.abs(b[0] - 3) < 1e-9, `x0=${b[0]}`);
  assert.ok(Math.abs(b[1] - 2) < 1e-9, `x1=${b[1]}`);
});

test('solve7 leaves a singular DOF alone instead of returning NaN', () => {
  const A = new Float64Array(49);
  const b = new Float64Array(7);
  for (let i = 1; i < 7; i++) A[i * 7 + i] = 1;
  b[0] = 5;                     // row 0 is entirely zero
  solve7(A, b);
  for (let i = 0; i < 7; i++) assert.ok(Number.isFinite(b[i]), `x${i} is ${b[i]}`);
});

test('a wheel left above the road settles back toward contact', () => {
  const s = createSuspensionState();
  s.zw[0] = 0.15;
  s.zw[1] = 0.15;
  const load = { ground: FLAT, ax: 0, ay: 0, gradeLong: 0 };
  for (let i = 0; i < Math.round(1 / DT); i++) step(s, load, DT);
  assert.ok(s.zw[0] < 0.05, `FL wheel still hovering at ${(s.zw[0] * 1000).toFixed(0)} mm`);
  assert.ok(s.zw[1] < 0.05, `FR wheel still hovering at ${(s.zw[1] * 1000).toFixed(0)} mm`);
});

test('inertial loads are low-pass filtered so tyre chatter does not ring the body', () => {
  const s = createSuspensionState();
  const ground = [0, 0, 0, 0];
  const load = { ground, aeroFront: 6000, aeroRear: 9000, ax: 0, ay: 0 };
  for (let i = 0; i < Math.round(2 / DT); i++) step(s, load, DT);
  const roll = [];
  for (let i = 0; i < Math.round(1.5 / DT); i++) {
    // Square-wave ay at ~100 Hz — tyre relaxation scale, not a real corner load.
    load.ay = (i % 12 < 6 ? 1 : -1) * 8 * G;
    step(s, load, DT);
    roll.push(s.roll);
  }
  const late = roll.slice(Math.round(0.5 / DT));
  const p2p = (Math.max(...late) - Math.min(...late)) * 180 / Math.PI;
  assert.ok(p2p < 0.35, `body roll rang ${p2p.toFixed(2)} deg under ay chatter`);
});

test('crest recovery stays off during cornering roll unload', () => {
  const s = createSuspensionState();
  // Settle into a right-hand corner load — roll extends the inside front.
  for (let i = 0; i < 400; i++) {
    step(s, { ground: FLAT, ax: 0, ay: 1.2 * G, gradeLong: 0 }, DT);
  }
  const rollBefore = s.roll;
  const pitchBefore = s.pitch;
  for (let i = 0; i < 120; i++) {
    step(s, { ground: FLAT, ax: 0, ay: 1.2 * G, gradeLong: 0 }, DT);
  }
  // Hover contact must not pull the platform into a high-frequency fight with roll.
  assert.ok(Math.abs(s.roll - rollBefore) < 0.4 * DEG,
    `roll moved ${((s.roll - rollBefore) / DEG).toFixed(2)} deg under sustained cornering`);
  assert.ok(Math.abs(s.pitch - pitchBefore) < 0.25 * DEG,
    `pitch moved ${((s.pitch - pitchBefore) / DEG).toFixed(2)} deg under sustained cornering`);
});

test('an unloaded front axle pitches toward the road plane instead of climbing', () => {
  const s = createSuspensionState();
  s.pitch = 3 * DEG;
  s.zw[0] = 0.15;
  s.zw[1] = 0.15;
  const grade = -2 * DEG;
  const load = { ground: FLAT, ax: 0, ay: 0, gradeLong: Math.tan(grade) };
  for (let i = 0; i < 8; i++) step(s, load, DT);
  assert.ok(s.pitch < 3 * DEG - 0.15 * DEG, `pitch stayed at ${(s.pitch / DEG).toFixed(2)} deg`);
});

// ---------------------------------------------------------------------------
// The heave speed cap has to clear the speed the road descends at.
//
// It did not, and the failure was invisible as a constant: the chassis is
// rate-limited to `MAX_HEAVE_SPEED`, the steepest part of this circuit falls
// faster than that at racing speed, and a car that cannot descend as fast as
// its own road falls behind by the difference every step until the heave hits
// `MAX_HEAVE` and the wheels are dragged off the ground.
// ---------------------------------------------------------------------------

test('the chassis may descend at least as fast as the steepest road, at top speed', async () => {
  const { MAX_HEAVE_SPEED } = await import('./suspension.js');
  const { elevationAt } = await import('../track/elevation.js');
  const { buildCenterline } = await import('../track/centerline.js');
  const { SILVERSTONE_WAYPOINTS } = await import('../track/silverstoneWaypoints.js');

  const cl = buildCenterline(SILVERSTONE_WAYPOINTS, 4000);
  const step = 0.5;
  let steepest = 0;
  for (let s = 0; s < cl.length; s += step) {
    const rise = elevationAt((s + step) / cl.length) - elevationAt(s / cl.length);
    steepest = Math.max(steepest, Math.abs(rise) / step);
  }
  // The car's terminal speed. Faster than it reaches in practice, which is the
  // point — the cap must not bind at the top of the range either.
  const TOP_SPEED = 90;
  const demanded = steepest * TOP_SPEED;
  assert.ok(MAX_HEAVE_SPEED > demanded,
    `road falls at ${demanded.toFixed(2)} m/s at ${TOP_SPEED} m/s `
    + `(${(steepest * 100).toFixed(2)}% gradient) but the chassis is capped at `
    + `${MAX_HEAVE_SPEED} m/s — the car cannot follow its own circuit`);
});
