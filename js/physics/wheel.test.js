import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  peakGrip, combineSlip, combinedSlipForces, slipRatio, slipAngle,
  WHEEL_RADIUS, WHEEL_INERTIA,
  magicFormula, pacejkaLateral, pacejkaLongitudinal,
  PACEJKA_B, PACEJKA_C, PACEJKA_E, PACEJKA_BX, ALPHA_PEAK, KAPPA_PEAK,
  ALPHA_PEAK_TARGET, KAPPA_PEAK_TARGET,
  relaxationLength, lagSlip, SIGMA_LAT, SIGMA_LONG,
  pneumaticTrail, aligningTorque, pacejkaMz, TRAIL_0, CASTER_TRAIL,
  createTyreState, gripFromTemperature, gripFromWear, gripScale, tyreTemperature,
  thermalStep, wearStep, slipPower, T_OPT, T_AMBIENT, GRIP_FLOOR,
  camberThrust, STATIC_CAMBER_FRONT, tyreVerticalForce, TYRE_K,
  wheelAngularStep, lockTorque,
} from './wheel.js';
import { wheelNormalLoads, TRACK_HALF } from './loadTransfer.js';
import { MASS, G } from './constants.js';

const DEG = Math.PI / 180;
const DT = 1 / 600;

// ---------------------------------------------------------------------------
// Magic Formula
// ---------------------------------------------------------------------------

test('peak grip grows sub-linearly with vertical load', () => {
  const low = peakGrip(1.6, 3000);
  const high = peakGrip(1.6, 6000);
  assert.ok(high < low * 2, `doubling load more than doubled grip: ${low} → ${high}`);
  assert.ok(high > low * 1.2);
});

test('peak grip scales linearly with the temperature/wear multiplier', () => {
  assert.ok(Math.abs(peakGrip(1.6, 4000, 0.5) - peakGrip(1.6, 4000) * 0.5) < 1e-9);
});

test('the lateral curve peaks where it was asked to, not where B happened to put it', () => {
  assert.ok(
    Math.abs(ALPHA_PEAK - ALPHA_PEAK_TARGET) < 0.3 * DEG,
    `peak at ${(ALPHA_PEAK / DEG).toFixed(2)} deg, wanted ${(ALPHA_PEAK_TARGET / DEG).toFixed(2)}`,
  );
});

test('peak slip angle is in the range a real slick peaks in', () => {
  const deg = ALPHA_PEAK / DEG;
  assert.ok(deg > 5 && deg < 9, `${deg.toFixed(2)} deg is not a racing slick`);
});

test('the longitudinal curve peaks earlier than the lateral one', () => {
  assert.ok(Math.abs(KAPPA_PEAK - KAPPA_PEAK_TARGET) < 0.005);
  assert.ok(KAPPA_PEAK < Math.tan(ALPHA_PEAK), 'wheelspin must arrive before a slide');
});

test('force falls away past the peak, but not off a cliff', () => {
  const at = s => magicFormula(1, PACEJKA_B, PACEJKA_C, PACEJKA_E, s);
  assert.ok(at(ALPHA_PEAK) > at(ALPHA_PEAK * 2), 'must fall past the peak');
  assert.ok(at(ALPHA_PEAK * 2) > 0.88, 'a 12% drop at twice peak slip is a slick');
  assert.ok(at(ALPHA_PEAK * 3) > 0.8, 'a departure must be recoverable, not terminal');
});

test('cornering stiffness is the right order for an F1 front', () => {
  // dFy/dα at zero slip is D·B·C. Per degree, at a typical loaded front.
  const d = peakGrip(1.6, 5000);
  const perDeg = d * PACEJKA_B * PACEJKA_C * DEG;
  assert.ok(perDeg > 1500 && perDeg < 4000, `${perDeg.toFixed(0)} N/deg`);
});

test('lateral force opposes slip angle, longitudinal follows slip ratio', () => {
  assert.ok(pacejkaLateral(5000, 0.05) < 0, 'positive slip angle must give negative Fy');
  assert.ok(pacejkaLateral(5000, -0.05) > 0);
  assert.ok(pacejkaLongitudinal(5000, 0.05) > 0, 'positive slip ratio must drive');
  assert.ok(pacejkaLongitudinal(5000, -0.05) < 0);
});

test('zero slip gives zero force', () => {
  assert.equal(Math.abs(pacejkaLateral(5000, 0)), 0);
  assert.equal(Math.abs(pacejkaLongitudinal(5000, 0)), 0);
});

// ---------------------------------------------------------------------------
// Relaxation length
// ---------------------------------------------------------------------------

test('force lags slip by a distance, not by a time', () => {
  // The same 1 m of travel must produce the same fraction of the step, whatever
  // the speed it was covered at. That is what "relaxation length" means.
  const fractionAfter1m = speed => {
    let lag = 0;
    const dt = 1 / 6000;
    for (let d = 0; d < 1; d += speed * dt) lag = lagSlip(lag, 1, speed, SIGMA_LAT, dt);
    return lag;
  };
  const slow = fractionAfter1m(10);
  const fast = fractionAfter1m(80);
  assert.ok(Math.abs(slow - fast) < 0.02, `${slow.toFixed(3)} vs ${fast.toFixed(3)}`);
});

test('one relaxation length of travel gets ~63% of the way there', () => {
  let lag = 0;
  const v = 50;
  const dt = 1 / 6000;
  const steps = Math.round(SIGMA_LAT / v / dt);
  for (let i = 0; i < steps; i++) lag = lagSlip(lag, 1, v, SIGMA_LAT, dt);
  assert.ok(Math.abs(lag - (1 - Math.exp(-1))) < 0.02, `${lag.toFixed(4)}`);
});

test('the lag is slower at low speed — this is why slow corners feel vague', () => {
  const after = (v, t) => {
    let lag = 0;
    for (let s = 0; s < t; s += DT) lag = lagSlip(lag, 1, v, SIGMA_LAT, DT);
    return lag;
  };
  // At 60 m/s a tyre travels a relaxation length in 6 ms, so 20 ms is already
  // fully built up; at 5 m/s it is a quarter of the way there.
  const slow = after(5, 0.02);
  const fast = after(60, 0.02);
  assert.ok(slow < fast * 0.5, `${slow.toFixed(3)} at 5 m/s vs ${fast.toFixed(3)} at 60`);
});

test('the lag is unconditionally stable — no ringing at any step size', () => {
  for (const dt of [1 / 600, 1 / 60, 1 / 10, 1, 10]) {
    let lag = 0;
    for (let i = 0; i < 50; i++) lag = lagSlip(lag, 1, 90, SIGMA_LAT, dt);
    assert.ok(lag >= 0 && lag <= 1.0000001, `dt=${dt} gave ${lag}`);
  }
});

test('a stationary tyre does not relax at all', () => {
  assert.equal(lagSlip(0, 1, 0, SIGMA_LAT, DT), 0);
});

test('longitudinal relaxation is shorter than lateral', () => {
  assert.ok(SIGMA_LONG < SIGMA_LAT);
  assert.ok(SIGMA_LAT >= 0.2 && SIGMA_LAT <= 0.6, 'plan gives 0.2-0.6 m for slicks');
});

test('relaxation length shortens under load', () => {
  assert.ok(relaxationLength(6000) < relaxationLength(2000));
});

// ---------------------------------------------------------------------------
// Combined slip
// ---------------------------------------------------------------------------

test('combined slip stays inside the friction circle', () => {
  const d = 5000;
  const { fx, fy } = combineSlip(d * 0.9, d * 0.9, d);
  assert.ok(Math.hypot(fx, fy) <= d * 1.001);
});

test('MF combined slip never exceeds the peak, at any slip combination', () => {
  const d = 5000;
  const out = { fx: 0, fy: 0 };
  for (let k = -0.6; k <= 0.6; k += 0.02) {
    for (let a = -0.6; a <= 0.6; a += 0.02) {
      combinedSlipForces(d, k, a, out);
      assert.ok(
        Math.hypot(out.fx, out.fy) <= d * 1.0001,
        `kappa=${k.toFixed(2)} alpha=${a.toFixed(2)} gave ${Math.hypot(out.fx, out.fy).toFixed(0)} > ${d}`,
      );
    }
  }
});

test('at peak slip ratio and peak slip angle together, the tyre is at its limit — not 1.41x it', () => {
  const d = 5000;
  const out = combinedSlipForces(d, KAPPA_PEAK, ALPHA_PEAK, { fx: 0, fy: 0 });
  const mag = Math.hypot(out.fx, out.fy);
  assert.ok(mag > d * 0.9 && mag <= d * 1.0001, `${mag.toFixed(0)} of ${d}`);
});

test('combined slip reduces to pure slip on each axis', () => {
  const d = 5000;
  const pureX = combinedSlipForces(d, KAPPA_PEAK, 0, { fx: 0, fy: 0 });
  assert.ok(Math.abs(pureX.fy) < 1e-9, 'no slip angle must mean no lateral force');
  assert.ok(pureX.fx > d * 0.95);

  const pureY = combinedSlipForces(d, 0, ALPHA_PEAK, { fx: 0, fy: 0 });
  assert.ok(Math.abs(pureY.fx) < 1e-9);
  assert.ok(pureY.fy < -d * 0.95, 'positive slip angle gives negative Fy');
});

test('asking for drive mid-corner costs lateral force — a real trade, not a free one', () => {
  const d = 5000;
  const cornering = combinedSlipForces(d, 0, ALPHA_PEAK, { fx: 0, fy: 0 });
  const both = combinedSlipForces(d, KAPPA_PEAK * 0.7, ALPHA_PEAK, { fx: 0, fy: 0 });
  assert.ok(Math.abs(both.fy) < Math.abs(cornering.fy), 'drive must eat into cornering');
  assert.ok(both.fx > 0, 'and must actually deliver some drive');
});

test('combinedSlipForces writes into the object it is given and allocates nothing', () => {
  const out = { fx: 0, fy: 0 };
  assert.equal(combinedSlipForces(5000, 0.1, 0.1, out), out);
});

test('slip ratio is zero when wheel speed matches road speed', () => {
  const v = 30;
  assert.ok(Math.abs(slipRatio(v, v / WHEEL_RADIUS)) < 1e-9);
});

test('a locked wheel at speed has slip ratio -1', () => {
  assert.ok(Math.abs(slipRatio(40, 0) + 1) < 1e-9);
});

test('slip angle is bounded even as the car stops', () => {
  assert.ok(Math.abs(slipAngle(5, 0)) < Math.PI / 2, 'the vRelax floor must hold');
});

// ---------------------------------------------------------------------------
// Self-aligning torque
// ---------------------------------------------------------------------------

test('pneumatic trail starts near 40 mm and collapses as the tyre saturates', () => {
  assert.ok(Math.abs(pneumaticTrail(0) - TRAIL_0) < 1e-9);
  assert.ok(pneumaticTrail(ALPHA_PEAK) < TRAIL_0 * 0.6, 'must be well down by the peak');
  assert.ok(pneumaticTrail(ALPHA_PEAK * 2) < 0, 'and must reverse past it');
});

test('trail collapse means Mz peaks BEFORE the tyre does — this is the warning', () => {
  const d = 5000;
  let mzPeakAt = 0;
  let mzPeak = 0;
  let fyPeakAt = 0;
  let fyPeak = 0;
  for (let a = 0.002; a < 0.4; a += 0.002) {
    const fy = -pacejkaLateral(d, a);
    const mz = Math.abs(aligningTorque(pacejkaLateral(d, a), a));
    if (fy > fyPeak) { fyPeak = fy; fyPeakAt = a; }
    if (mz > mzPeak) { mzPeak = mz; mzPeakAt = a; }
  }
  assert.ok(
    mzPeakAt < fyPeakAt,
    `Mz peaks at ${(mzPeakAt / DEG).toFixed(1)} deg, Fy at ${(fyPeakAt / DEG).toFixed(1)} — `
    + 'the wheel must go light before the grip goes',
  );
});

test('some self-centring survives past the limit, via mechanical trail', () => {
  const mz = aligningTorque(pacejkaLateral(5000, 0.5), 0.5);
  assert.ok(Math.abs(mz) > 1, 'a saturated tyre must not go completely dead');
  assert.ok(CASTER_TRAIL > 0);
});

test('Mz opposes the slip that generated it', () => {
  const alpha = 0.04;
  const mz = aligningTorque(pacejkaLateral(5000, alpha), alpha);
  assert.ok(mz > 0, 'positive slip angle must give a restoring moment');
  assert.equal(pacejkaMz, aligningTorque, 'the Mz alias must be the same function');
});

test('trail grows with load, so a loaded front weighs heavier in the hands', () => {
  assert.ok(pneumaticTrail(0.02, 6000) > pneumaticTrail(0.02, 2000));
});

// ---------------------------------------------------------------------------
// Thermal and wear
// ---------------------------------------------------------------------------

test('grip peaks in a window and falls off both sides', () => {
  assert.ok(Math.abs(gripFromTemperature(T_OPT) - 1) < 1e-9);
  assert.ok(gripFromTemperature(40) < 0.85, 'cold must cost real grip');
  assert.ok(gripFromTemperature(150) <= GRIP_FLOOR + 1e-9, 'overheated must be gone');
  assert.ok(gripFromTemperature(85) > 0.97, 'and there must be a usable band');
});

test('the window is asymmetric — hot fails faster than cold', () => {
  const coldSide = gripFromTemperature(T_OPT - 30);
  const hotSide = gripFromTemperature(T_OPT + 30);
  assert.ok(hotSide < coldSide, 'graining is a cliff, cold is a shoulder');
});

test('grip never goes to zero, or a cold tyre would be undriveable', () => {
  for (const T of [-40, 0, 25, 300, 1000]) {
    assert.ok(gripFromTemperature(T) >= GRIP_FLOOR - 1e-9, `${T}C`);
  }
});

test('a cold tyre warms up, and lands in the operating window on a fast lap', () => {
  const tyre = createTyreState();
  assert.ok(tyre.surfaceT < 40, 'must start cold');
  // A fast lap: mixed cornering and straights.
  for (let i = 0; i < 600 * 120; i++) {
    const cornering = (i % 6000) < 2100;
    const v = cornering ? 66 : 78;
    const fz = cornering ? 6000 : 4200;
    const sp = cornering
      ? slipPower(1500, 5200, 0.6, v * Math.sin(0.055))
      : slipPower(600, 700, 0.05, 0.3);
    thermalStep(tyre, sp, fz, v, DT);
  }
  assert.ok(
    tyre.surfaceT > 70 && tyre.surfaceT < 125,
    `a fast lap should leave the surface in the window, got ${tyre.surfaceT.toFixed(0)}C`,
  );
  assert.ok(gripScale(tyre) > 0.94, `grip ${gripScale(tyre).toFixed(3)} after warm-up`);
});

test('the surface responds within a corner, the carcass over a stint', () => {
  const tyre = createTyreState(90);
  tyre.carcassT = 90;
  const before = { s: tyre.surfaceT, c: tyre.carcassT };
  // Three seconds of hard cornering.
  for (let i = 0; i < 600 * 3; i++) thermalStep(tyre, 30000, 6000, 60, DT);
  const dS = tyre.surfaceT - before.s;
  const dC = tyre.carcassT - before.c;
  assert.ok(dS > 8, `surface only moved ${dS.toFixed(1)}K in a corner`);
  assert.ok(dC < dS * 0.25, `carcass moved ${dC.toFixed(1)}K — far too fast for its mass`);
});

test('a tyre cools when the abuse stops', () => {
  const tyre = createTyreState(140);
  tyre.carcassT = 120;
  for (let i = 0; i < 600 * 30; i++) thermalStep(tyre, 0, 4000, 70, DT);
  assert.ok(tyre.surfaceT < 130, `cooled to ${tyre.surfaceT.toFixed(0)}C`);
});

test('the thermal integrator is stable at frame-sized steps, not just sim-sized', () => {
  // K_CONDUCTION / C_SURFACE is ~28 s^-1: explicit Euler diverges by 1/120 s.
  // Backward Euler must not, or a debug build at 30 fps would explode.
  for (const dt of [1 / 600, 1 / 120, 1 / 30, 1, 5]) {
    const tyre = createTyreState();
    for (let i = 0; i < 200; i++) thermalStep(tyre, 40000, 6000, 60, dt);
    assert.ok(
      Number.isFinite(tyre.surfaceT) && tyre.surfaceT > 0 && tyre.surfaceT < 2000,
      `dt=${dt} gave ${tyre.surfaceT}`,
    );
  }
});

test('temperatures settle to ambient with no work and no speed', () => {
  const tyre = createTyreState(200);
  tyre.carcassT = 200;
  for (let i = 0; i < 600 * 3000; i++) thermalStep(tyre, 0, 0, 0, DT, T_AMBIENT);
  // Track conduction holds it a little above air, which is correct.
  assert.ok(tyre.surfaceT > T_AMBIENT && tyre.surfaceT < 60, `${tyre.surfaceT.toFixed(1)}C`);
});

test('tyreTemperature reports the surface, which is what the driver feels', () => {
  const tyre = createTyreState(88);
  assert.equal(tyreTemperature(tyre), tyre.surfaceT);
});

test('slip power is zero when nothing is sliding', () => {
  assert.equal(slipPower(5000, 5000, 0, 0), 0);
});

test('wear accumulates with slip and degrades peak grip', () => {
  const tyre = createTyreState(100);
  for (let i = 0; i < 600 * 600; i++) wearStep(tyre, 25000, DT);
  assert.ok(tyre.wear > 0.02, `only ${(tyre.wear * 100).toFixed(2)}% wear in 10 min of sliding`);
  assert.ok(gripFromWear(tyre.wear) < 1);
  assert.ok(gripFromWear(1) > 0.6, 'a dead tyre is slow, not frictionless');
});

test('wear runs away faster once the tyre is overheated', () => {
  const cool = createTyreState(90);
  const hot = createTyreState(150);
  for (let i = 0; i < 600 * 60; i++) {
    wearStep(cool, 25000, DT);
    wearStep(hot, 25000, DT);
  }
  assert.ok(hot.wear > cool.wear * 2, `${hot.wear} vs ${cool.wear}`);
});

test('wear is bounded at 1', () => {
  const tyre = createTyreState(200);
  for (let i = 0; i < 20000; i++) wearStep(tyre, 1e9, DT);
  assert.equal(tyre.wear, 1);
});

test('gripScale folds temperature and wear into one multiplier', () => {
  const tyre = createTyreState(T_OPT);
  tyre.wear = 0.5;
  assert.ok(Math.abs(gripScale(tyre) - gripFromWear(0.5)) < 1e-9);
});

// ---------------------------------------------------------------------------
// Camber and vertical stiffness
// ---------------------------------------------------------------------------

test('camber thrust acts in the direction the tyre leans, and scales with load', () => {
  const light = camberThrust(2000, STATIC_CAMBER_FRONT);
  const heavy = camberThrust(6000, STATIC_CAMBER_FRONT);
  assert.ok(light < 0, 'negative camber must give negative thrust');
  assert.ok(Math.abs(heavy) > Math.abs(light));
});

test('static camber is in the range F1 runs', () => {
  const deg = -STATIC_CAMBER_FRONT / DEG;
  assert.ok(deg >= 2.5 && deg <= 4.5, `${deg} deg of front camber`);
});

test('camber thrust is a bias, not a grip source — a few hundred newtons', () => {
  assert.ok(Math.abs(camberThrust(4500, STATIC_CAMBER_FRONT)) < 600);
  assert.ok(Math.abs(camberThrust(4500, STATIC_CAMBER_FRONT)) > 100);
});

test('an unloaded tyre generates no camber thrust', () => {
  assert.equal(Math.abs(camberThrust(0, STATIC_CAMBER_FRONT)), 0);
});

test('tyre vertical stiffness is in the 2022+ low-profile range', () => {
  assert.ok(TYRE_K >= 250000 && TYRE_K <= 350000, `${TYRE_K} N/m`);
});

test('a tyre off the ground pushes nothing, and is not sucked back down', () => {
  assert.equal(tyreVerticalForce(0), 0);
  assert.equal(tyreVerticalForce(-0.01), 0);
  assert.equal(tyreVerticalForce(-0.01, -5), 0, 'the damper must vanish with the spring');
});

test('tyre force never pulls, even on a fast rebound', () => {
  assert.ok(tyreVerticalForce(0.001, -100) >= 0);
});

test('static deflection under an F1 corner load is a few millimetres', () => {
  const fz = MASS * G / 4;
  const deflection = fz / TYRE_K;
  assert.ok(deflection > 0.003 && deflection < 0.02, `${(deflection * 1000).toFixed(1)} mm`);
});

// ---------------------------------------------------------------------------
// Wheel angular DOF
// ---------------------------------------------------------------------------

test('drive torque spins a wheel up from rest — which a target-speed solver cannot', () => {
  let omega = 0;
  for (let i = 0; i < 600; i++) omega = wheelAngularStep(omega, 800, 0, 0, DT);
  assert.ok(omega > 0, 'a stationary wheel must be spinnable by torque alone');
  assert.ok(Math.abs(omega - 800 / WHEEL_INERTIA) < 1, 'and by I·ω̇ = T');
});

test('tyre longitudinal force decelerates the wheel it acts on', () => {
  const free = wheelAngularStep(100, 0, 0, 0, DT);
  const loaded = wheelAngularStep(100, 0, 0, 4000, DT);
  assert.equal(free, 100);
  assert.ok(loaded < 100, 'drive force must be paid for out of wheel speed');
});

test('a locked wheel stops dead instead of chattering through zero', () => {
  let omega = 50;
  for (let i = 0; i < 600; i++) omega = wheelAngularStep(omega, 0, 5000, 0, DT);
  assert.equal(omega, 0, 'brake torque must arrest, not reverse');
});

test('brake torque cannot drive a stopped wheel backwards', () => {
  assert.equal(wheelAngularStep(0, 0, 1e6, 0, DT), 0);
});

test('brake torque slows a wheel spinning either way', () => {
  assert.ok(wheelAngularStep(50, 0, 300, 0, DT) < 50);
  assert.ok(wheelAngularStep(-50, 0, 300, 0, DT) > -50);
});

test('lock torque is the brake torque the friction limit allows', () => {
  const fz = 4500;
  const t = lockTorque(fz, 1.6);
  assert.ok(Math.abs(t - peakGrip(1.6, fz) * WHEEL_RADIUS) < 1e-9);
  assert.ok(t > 1000 && t < 5000, `${t.toFixed(0)} Nm`);
});

test('wheel inertia is physical for an F1 wheel and tyre', () => {
  assert.ok(WHEEL_INERTIA > 0.5 && WHEEL_INERTIA < 3, `${WHEEL_INERTIA} kg m^2`);
});

// ---------------------------------------------------------------------------
// Load transfer (unchanged, kept covered)
// ---------------------------------------------------------------------------

test('lateral load transfer shifts weight to the outside in a left turn', () => {
  const ay = -8;
  const [fl, fr, rl, rr] = wheelNormalLoads(0, ay, 0);
  assert.ok(fr > fl, 'right-front should load in a left turn');
  assert.ok(rr > rl, 'right-rear should load in a left turn');
  const total = fl + fr + rl + rr;
  assert.ok(Math.abs(total - MASS * G) < 50);
});

test('track half-width is realistic for F1', () => {
  assert.ok(TRACK_HALF > 0.7 && TRACK_HALF < 1.0);
});
