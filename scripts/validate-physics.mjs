/**
 * Physics validation dashboard.
 *
 *   npm run validate
 *
 * Two questions, both of which need answering continuously while the vehicle
 * model is being rebuilt:
 *
 *   1. Does the car reproduce the numbers a 2022-2026 F1 car actually produces?
 *   2. Which of the systems a sim-grade car needs are present at all?
 *
 * Deliberately a reporting tool rather than a test. The reference targets are
 * approximate public figures and the model is under active reconstruction, so
 * failing them is expected for a while and does not belong in a red/green suite.
 * `reference.test.js` covers the measuring code itself, and stays green.
 */
import { runReference } from '../js/physics/reference.js';
import { createReferenceSim, OPEN_TARMAC } from '../js/physics/referenceSim.js';

const C = {
  pass: '\x1b[32m',
  off: '\x1b[33m',
  error: '\x1b[31m',
  dim: '\x1b[2m',
  off_: '\x1b[0m',
};

const tryImport = async path => {
  try {
    return await import(path);
  } catch {
    return null;
  }
};

const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
const rule = n => `${C.dim}${'-'.repeat(n)}${C.off_}`;

async function main() {
  const kernel = await tryImport('../js/physics/kernel.js');
  if (!kernel?.step) {
    console.error(`${C.error}Cannot load a physics kernel${C.off_}`);
    process.exit(1);
  }

  console.log('\n  Reference: 2022-2026 ground-effect F1 car');
  console.log(`  ${C.dim}${pad('quantity', 28)}${padL('model', 9)}${padL('target', 10)}  error${C.off_}`);
  console.log(`  ${rule(68)}`);

  const rows = runReference(createReferenceSim());
  let passes = 0;
  for (const r of rows) {
    if (r.verdict === 'pass') passes++;
    const colour = C[r.verdict];
    const measured = Number.isFinite(r.measured)
      ? r.measured.toFixed(Math.abs(r.measured) >= 100 ? 0 : 2)
      : '--';
    const err = Number.isFinite(r.error)
      ? `${r.error >= 0 ? '+' : ''}${(r.error * 100).toFixed(0)}%`
      : r.verdict;
    console.log(
      `  ${pad(r.label, 28)}${padL(measured, 9)}${padL(r.target + r.unit, 10)}  `
      + `${colour}${pad(err, 7)}${C.off_}`
      + (r.note ? ` ${C.dim}${r.note}${C.off_}` : ''),
    );
  }
  console.log(`\n  ${passes}/${rows.length} within tolerance`);

  const wheel = await tryImport('../js/physics/wheel.js');
  const load = await tryImport('../js/physics/loadTransfer.js');
  const susp = await tryImport('../js/physics/suspension.js');
  const power = await tryImport('../js/physics/powertrain.js');
  const aero = await tryImport('../js/physics/aero.js');
  const surface = await tryImport('../js/physics/surface.js');
  const state = await tryImport('../js/physics/state.js');
  const has = (mod, name) => !!(mod && name in mod);

  // Behavioural probes, for the questions an export list cannot answer.
  let launches = false;
  let stateHasOmega = false;
  let flatState = false;
  try {
    const car = kernel.createCar({});
    if (kernel.warmUp) kernel.warmUp(car);
    for (let i = 0; i < 1200; i++) {
      kernel.step(car, { throttle: 1, brake: 0, steer: 0 }, OPEN_TARMAC, 1 / 600);
    }
    launches = Number.isFinite(car.S[state.S_VZ]) && kernel.speedOf(car) > 5;
    // The wheels must carry their own angular velocity, and it must have been
    // driven by torque rather than derived from road speed.
    stateHasOmega = has(state, 'S_OMEGA')
      && car.S[state.S_OMEGA + 2] > 0
      && Math.abs(car.S[state.S_OMEGA + 2] * 0.334 - kernel.forwardSpeed(car)) > 1e-9;
    flatState = car.S instanceof Float64Array && car.S.length >= 40;
  } catch { /* left absent */ }

  // Roll-stiffness distribution: under pure lateral acceleration, does the front
  // axle transfer a different share than the rear? Equal deltas mean the model
  // has no balance adjustment at all, which is the main setup lever on a real car.
  let rollDistribution = false;
  let lateralTransfer = false;
  if (load?.wheelNormalLoads) {
    try {
      const rolled = load.wheelNormalLoads(0, 10, 0);
      const dF = Math.abs(rolled[0] - rolled[1]);
      const dR = Math.abs(rolled[2] - rolled[3]);
      lateralTransfer = dF > 1 || dR > 1;
      rollDistribution = Math.abs(dF - dR) > 1;
    } catch { /* left absent */ }
  }

  // Per-wheel surface: does one wheel on the grass leave the others on tarmac?
  let perWheelSurface = false;
  if (surface?.sampleWheelSurfaces) {
    try {
      const samples = surface.createSurfaceSamples();
      const splitTrack = {
        query: x => ({ surface: x > 0 ? 'grass' : 'tarmac', lateral: 0, wallLimit: 1e9, normal: { x: 0, z: 0 } }),
      };
      surface.sampleWheelSurfaces(splitTrack, 0, 0, 0, samples);
      perWheelSurface = surface.isSplitSurface(samples);
    } catch { /* left absent */ }
  }

  // Porpoising: is the aero actually coupled to the suspension, or is something a
  // constant? An emergent behaviour to look for rather than a number to tune to.
  let porpoises = false;
  if (aero?.groundEffect && susp?.step) {
    try {
      const s = susp.createSuspensionState();
      const a = aero.createAeroState();
      const l = { ground: [0, 0, 0, 0], aeroFront: 0, aeroRear: 0 };
      const c = {
        speed: 320 / 3.6, rideFront: susp.RIDE_HEIGHT_FRONT, rideRear: susp.RIDE_HEIGHT_REAR,
        sideslip: 0, yawRate: 0, drs: false, dt: 1 / 600,
      };
      const tail = [];
      const n = Math.round(8 * 600);
      for (let i = 0; i < n; i++) {
        c.rideFront = s.rideFront;
        c.rideRear = s.rideRear;
        aero.groundEffect(a, c);
        l.aeroFront = a.fzFront - a.plankFront;
        l.aeroRear = a.fzRear - a.plankRear;
        susp.step(s, l, 1 / 600);
        if (i > n - 1800) tail.push(s.rideFront);
      }
      porpoises = (Math.max(...tail) - Math.min(...tail)) * 1000 > 1;
    } catch { /* left absent */ }
  }

  const caps = [
    ['flat Float64Array state vector', flatState],
    ['four-corner normal loads', has(load, 'wheelNormalLoads')],
    ['lateral load transfer', lateralTransfer],
    ['load-sensitive peak grip', has(wheel, 'peakGrip')],
    ['slip-ratio tyre model', has(wheel, 'slipRatio')],
    ['combined slip', has(wheel, 'combinedSlipForces')],
    ['wheel angular DOF in state', stateHasOmega],
    ['torque-driven wheels (launches from rest)', launches],
    ['tyre relaxation length', has(wheel, 'relaxationLength') || has(wheel, 'lagSlip')],
    ['self-aligning torque Mz', has(wheel, 'aligningTorque') || has(wheel, 'pacejkaMz')],
    ['tyre thermal model', has(wheel, 'tyreTemperature') || has(wheel, 'thermalStep')],
    ['tyre wear', has(wheel, 'wearStep')],
    ['front/rear tyre difference', has(wheel, 'muScaleFor')],
    ['suspension springs/dampers', has(susp, 'suspensionForce') || has(susp, 'step')],
    ['roll stiffness distribution', rollDistribution],
    ['ride-height-dependent aero', has(aero, 'groundEffect') || has(aero, 'clAtRideHeight')],
    ['porpoising emerges at speed', porpoises],
    ['DRS', has(aero, 'drs') || has(aero, 'DRS_CLA_LOSS')],
    ['engine torque curve', has(power, 'engineTorque')],
    ['gear ratios in the force path', has(power, 'GEAR_RATIOS')],
    ['MGU-K / ERS deployment', has(power, 'mgukTorque')],
    ['brake thermal model', has(power, 'brakeTemperature')],
    ['brake-by-wire blending', has(power, 'brakeByWire')],
    ['per-wheel surface query', perWheelSurface],
    ['input recording and replay', !!(await tryImport('../js/physics/replay.js'))?.replay],
    ['telemetry export', !!(await tryImport('../js/physics/telemetryLog.js'))?.toCSV],
    ['fixed-step deterministic clock', !!(await tryImport('../js/physics/fixedStep.js'))?.pump],
  ];

  console.log('\n  Capability coverage');
  console.log(`  ${rule(68)}`);
  let have = 0;
  for (const [label, ok] of caps) {
    if (ok) have++;
    console.log(`  ${ok ? `${C.pass}[x]${C.off_}` : `${C.dim}[ ]${C.off_}`} ${label}`);
  }
  console.log(`\n  ${have}/${caps.length} systems present\n`);
}

main();
