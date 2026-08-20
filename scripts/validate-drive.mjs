#!/usr/bin/env node
/**
 * Driving-feel validation: the simulated test drive.
 *
 *   npm run validate:drive
 *
 * `validate` checks the car's numbers; this checks its behaviour — the things a
 * driver feels and a reference table cannot express. Braking: threshold stops,
 * lockup without aids, steering authority under braking and none with the fronts
 * locked, cold carbon, fade, brake-by-wire consistency, stability. Steering:
 * step response, understeer gradient, slalom phase, release, trail braking,
 * power oversteer, hairpin radius.
 *
 * Methodology note that cost a morning: the car must be SETTLED at speed before
 * a manoeuvre is measured. `launch()` teleports the speed, which applies two
 * tonnes of downforce as a step — the suspension overshoots, the loads spike,
 * and the first half-second reports wheel lockup and 7 g peaks that do not
 * exist. Every probe here settles for two seconds under its own power first.
 *
 * A reporting tool, like validate-physics: the verdicts flag what to look at,
 * they are not a red/green gate.
 */
import {
  createCar, step, warmUp, launch, forwardSpeed, yawRate, sideslipOf,
} from '../js/physics/kernel.js';
import {
  createDriverState, brakeModulation, maxSteerAt,
} from '../js/physics/driver.js';
import * as ST from '../js/physics/state.js';
import { BATTERY_CAPACITY } from '../js/physics/powertrain.js';
import { WB } from '../js/physics/constants.js';

const DT = 1 / 600;
const G = 9.81;
const DEG = Math.PI / 180;
const FLAT = { query: () => ({ surface: 'tarmac', lateral: 0, wallLimit: 1e9, normal: { x: 0, z: 0 } }) };
const C = { ok: '\x1b[32m', warn: '\x1b[33m', dim: '\x1b[2m', end: '\x1b[0m' };
const verdict = ok => (ok ? `${C.ok}ok${C.end}` : `${C.warn}check${C.end}`);

function settled(kmh, mutate = null) {
  const car = createCar({});
  warmUp(car);
  if (mutate) mutate(car);
  const v = kmh / 3.6;
  launch(car, v);
  for (let i = 0; i < 1200; i++) {
    step(car, { throttle: hold(car, v), brake: 0, steer: 0 }, FLAT, DT);
  }
  return car;
}
const hold = (car, v) => Math.max(0, Math.min(1, (v - forwardSpeed(car)) * 0.6));

function stop(car, { aided = true, steerDeg = 0 } = {}) {
  const drv = createDriverState();
  let t = 0;
  let dist = 0;
  let lockMs = 0;
  let peakG = 0;
  let yawTotal = 0;
  const v0 = forwardSpeed(car);
  while (forwardSpeed(car) > 0.8 && t < 15) {
    const vLong = forwardSpeed(car);
    const brake = aided ? brakeModulation(drv, car.S, 1, vLong, DT) : 1;
    step(car, { throttle: 0, brake, steer: steerDeg * DEG }, FLAT, DT);
    // Lock only counts above walking pace. Below ~11 km/h the modulation hands
    // back to the full pedal and the wheels lock as the car crawls the last few
    // metres — which is what real cars do at the end of a stop, and flagging it
    // made every clean stop read as a locked one.
    if (vLong > 3 && Math.min(car.out.slipRatio[0], car.out.slipRatio[1]) < -0.5) lockMs += DT * 1000;
    peakG = Math.max(peakG, -car.out.aLong / G);
    yawTotal += Math.abs(yawRate(car)) * DT;
    dist += vLong * DT;
    t += DT;
  }
  return { dist, t, peakG, lockMs, yawDeg: yawTotal / DEG, avgG: v0 * v0 / (2 * dist) / G };
}

console.log('\n  Test drive — braking');
console.log(`  ${C.dim}${'-'.repeat(68)}${C.end}`);
const stops = {};
for (const [kmh, ref] of [[100, 17], [200, 65], [300, 125]]) {
  const r = stop(settled(kmh));
  stops[kmh] = r;
  const within = Math.abs(r.dist / ref - 1) < 0.35;
  console.log(
    `  ${String(kmh).padStart(3)}-0 threshold stop   ${r.dist.toFixed(1).padStart(6)} m  (ref ${ref})  `
    + `peak ${r.peakG.toFixed(1)} g  lock ${r.lockMs.toFixed(0)} ms  ${verdict(within && r.lockMs < 30)}`);
}
{
  const raw = stop(settled(200), { aided: false });
  const cost = raw.dist / stops[200].dist - 1;
  console.log(
    `  no aid: fronts lock      ${raw.dist.toFixed(1).padStart(6)} m  `
    + `(+${(100 * cost).toFixed(0)}% for the lockup)  ${verdict(raw.lockMs > 150 && cost > 0.1)}`);
  const lockedSteer = stop(settled(200), { aided: false, steerDeg: 4 });
  const aidedSteer = stop(settled(200), { steerDeg: 4 });
  console.log(
    `  4 deg steer in the stop: locked car turns ${lockedSteer.yawDeg.toFixed(0)} deg, `
    + `threshold car ${aidedSteer.yawDeg.toFixed(0)} deg  ${verdict(lockedSteer.yawDeg < aidedSteer.yawDeg * 0.15)}`);
}
{
  const cold = stop(settled(200, car => {
    for (let i = 0; i < 4; i++) { car.S[ST.S_BRAKE_T + i] = 60; car.brakes.discT[i] = 60; }
  }));
  console.log(
    `  cold carbon (60 C)       ${cold.dist.toFixed(1).padStart(6)} m  `
    + `(+${(100 * (cold.dist / stops[200].dist - 1)).toFixed(0)}% vs warm)  ${verdict(cold.dist > stops[200].dist * 1.3)}`);
  const empty = stop(settled(200, car => { car.S[ST.S_SOC] = 0; car.ers.soc = 0; }));
  const full = stop(settled(200, car => { car.S[ST.S_SOC] = BATTERY_CAPACITY; car.ers.soc = BATTERY_CAPACITY; }));
  console.log(
    `  BBW, battery empty/full  ${empty.dist.toFixed(1)} / ${full.dist.toFixed(1)} m  `
    + `${verdict(Math.abs(empty.dist - full.dist) < 2)}`);
}
{
  const car = settled(250);
  const drv = createDriverState();
  let t = 0;
  let maxSS = 0;
  while (forwardSpeed(car) > 2 && t < 12) {
    const brake = brakeModulation(drv, car.S, 1, forwardSpeed(car), DT);
    step(car, { throttle: 0, brake, steer: t < 0.5 ? 1.5 * DEG : 0 }, FLAT, DT);
    maxSS = Math.max(maxSS, Math.abs(sideslipOf(car)));
    t += DT;
  }
  console.log(`  disturbed max stop       sideslip peaks ${(maxSS / DEG).toFixed(1)} deg  ${verdict(maxSS < 4 * DEG)}`);
}

console.log('\n  Test drive — steering');
console.log(`  ${C.dim}${'-'.repeat(68)}${C.end}`);
for (const kmh of [100, 150, 250]) {
  const v = kmh / 3.6;
  const steer = maxSteerAt(v) * 0.6;
  const car = settled(kmh);
  const series = [];
  for (let i = 0; i < 600 * 2.5; i++) {
    step(car, { throttle: hold(car, v), brake: 0, steer }, FLAT, DT);
    series.push(Math.abs(yawRate(car)));
  }
  const ss = series.slice(-300).reduce((a, b) => a + b, 0) / 300;
  const rise = (series.findIndex(y => y > ss * 0.9) - series.findIndex(y => y > ss * 0.1)) * DT * 1000;
  const overshoot = Math.max(...series.slice(0, 600)) / ss - 1;
  console.log(
    `  step steer @ ${String(kmh).padStart(3)}        rises in ${rise.toFixed(0).padStart(4)} ms, `
    + `overshoot ${(100 * overshoot).toFixed(0).padStart(3)}%  ${verdict(rise < 300 && overshoot < 0.45)}`);
}
{
  // Understeer gradient over the linear range at 150 km/h.
  const v = 150 / 3.6;
  const pts = [];
  for (const frac of [0.15, 0.45]) {
    const car = settled(150);
    const steer = maxSteerAt(v) * frac;
    let sy = 0;
    let n = 0;
    for (let i = 0; i < 600 * 4; i++) {
      step(car, { throttle: hold(car, v), brake: 0, steer }, FLAT, DT);
      if (i > 600 * 3) { sy += Math.abs(yawRate(car)); n++; }
    }
    const yaw = sy / n;
    pts.push({ ay: yaw * forwardSpeed(car) / G, extra: (steer - WB * yaw / forwardSpeed(car)) / DEG });
  }
  const k = (pts[1].extra - pts[0].extra) / (pts[1].ay - pts[0].ay);
  console.log(`  understeer gradient      K = ${k.toFixed(2)} deg/g  ${verdict(k > 0.1 && k < 2)}`);
}
{
  // Trail braking: rotation with the brakes on, without a spin.
  const car = settled(250);
  const drv = createDriverState();
  const steer = maxSteerAt(250 / 3.6) * 0.5;
  let maxSS = 0;
  let maxYaw = 0;
  while (forwardSpeed(car) > 150 / 3.6) {
    const brake = brakeModulation(drv, car.S, 0.7, forwardSpeed(car), DT);
    step(car, { throttle: 0, brake, steer }, FLAT, DT);
    maxSS = Math.max(maxSS, Math.abs(sideslipOf(car)));
    maxYaw = Math.max(maxYaw, Math.abs(yawRate(car)));
  }
  console.log(
    `  trail braking 250->150   yaw ${maxYaw.toFixed(2)} rad/s, sideslip ${(maxSS / DEG).toFixed(1)} deg  `
    + `${verdict(maxSS < 8 * DEG && maxYaw > 0.3)}`);
}
{
  // Power-on oversteer without the aid, caught on the lift.
  const v = 120 / 3.6;
  const car = settled(120);
  const steer = maxSteerAt(v) * 0.5;
  for (let i = 0; i < 600 * 2; i++) step(car, { throttle: hold(car, v), brake: 0, steer }, FLAT, DT);
  let maxSS = 0;
  for (let i = 0; i < 600 * 1.2; i++) {
    step(car, { throttle: 1, brake: 0, steer }, FLAT, DT);
    maxSS = Math.max(maxSS, Math.abs(sideslipOf(car)));
  }
  for (let i = 0; i < 600 * 2; i++) step(car, { throttle: 0, brake: 0, steer: steer * 0.3 }, FLAT, DT);
  const after = Math.abs(sideslipOf(car));
  console.log(
    `  full power, no TC        rear steps to ${(maxSS / DEG).toFixed(0)} deg, `
    + `lift recovers to ${(after / DEG).toFixed(1)} deg  ${verdict(maxSS > 5 * DEG && after < 6 * DEG)}`);
}
console.log(`\n  ${C.dim}every manoeuvre settles the car at speed first — a teleported launch applies`);
console.log(`  downforce as a step and the transient reads as lockup that is not there${C.end}\n`);
