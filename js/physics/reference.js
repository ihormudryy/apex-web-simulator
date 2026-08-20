/**
 * Reference figures for a 2022–2026 ground-effect Formula 1 car, and the
 * procedures that measure the car against them.
 *
 * "As realistic as possible" is not actionable without numbers, so these are the
 * numbers. Approximate public data — good enough to catch a model that is wrong
 * by tens of percent, which is the error class that actually matters.
 *
 * Measurements drive the **whole** integration path, not the tyre kernel alone.
 * That distinction turned out to matter: `bicycle.step` works in body-frame
 * velocities while `vehicle.advance` owns the world/body projection, so inside
 * the kernel a large yaw rate never produces sideslip and the body-frame lateral
 * force is not the lateral acceleration. Measuring the kernel in isolation
 * reported 0.09 g on a car pulling several g, and then 54 g once the metric was
 * changed — the second number being a spin, not grip. Driving `advance` gives a
 * closed system whose trajectory can simply be observed.
 *
 * The `sim` argument is an adapter so this module stays free of Three.js and can
 * be tested against a toy whose answers are known on paper.
 */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const DEG2RAD = Math.PI / 180;

/** Frame step handed to `advance`, which substeps internally. */
export const MEASURE_DT = 1 / 120;

/**
 * Steering available at a given speed — the car limits lock as speed rises, so a
 * limit measurement must not command more than the driver could.
 */
export function maxSteerAt(speedMs) {
  return (18 - 12 * clamp(speedMs / 80, 0, 1)) * DEG2RAD;
}

export const REFERENCE = [
  { id: 'accel-100', label: '0–100 km/h', unit: 's', target: 2.6, tol: 0.30 },
  { id: 'accel-200', label: '0–200 km/h', unit: 's', target: 4.8, tol: 0.30 },
  { id: 'accel-300', label: '0–300 km/h', unit: 's', target: 9.0, tol: 0.35 },
  { id: 'vmax', label: 'top speed', unit: 'km/h', target: 330, tol: 0.12 },
  { id: 'brake-100', label: '100–0 km/h', unit: 'm', target: 17, tol: 0.35 },
  { id: 'brake-200', label: '200–0 km/h', unit: 'm', target: 65, tol: 0.30 },
  { id: 'brake-300', label: '300–0 km/h', unit: 'm', target: 125, tol: 0.30 },
  { id: 'lat-100', label: 'peak lateral @100 km/h', unit: 'g', target: 2.2, tol: 0.35 },
  { id: 'lat-200', label: 'peak lateral @200 km/h', unit: 'g', target: 3.8, tol: 0.30 },
  { id: 'lat-290', label: 'peak lateral @290 km/h', unit: 'g', target: 5.2, tol: 0.30 },
  { id: 'df-200', label: 'downforce @200 km/h', unit: 'kg', target: 1000, tol: 0.35 },
  { id: 'df-300', label: 'downforce @300 km/h', unit: 'kg', target: 2000, tol: 0.35 },
];

const failed = note => ({ value: NaN, note });
const FLAT = { throttle: false, brake: false };
/** Reused, so the measurement loop allocates nothing per step either. */
const throttleHold = { throttle: 0, brake: false };

/** Run the sim until `done`, accumulating path length. Never throws on garbage. */
function drive(sim, { v0 = 0, inputAt, steerAt, done, maxT = 40 }) {
  const car = sim.create();
  if (v0) sim.launch(car, v0);
  let t = 0;
  let dist = 0;
  while (t < maxT) {
    const [x0, z0] = sim.position(car);
    if (steerAt) sim.steer(car, steerAt(t, car));
    sim.advance(car, inputAt(t, car), MEASURE_DT);
    if (!sim.finite(car)) return { car, t, dist, ok: false, why: `non-finite state at t=${t.toFixed(3)} s` };
    const [x1, z1] = sim.position(car);
    dist += Math.hypot(x1 - x0, z1 - z0);
    t += MEASURE_DT;
    if (done && done(car, t, dist)) return { car, t, dist, ok: true };
  }
  return { car, t, dist, ok: true, timedOut: true };
}

export function measureAcceleration(sim, toKmh, maxT = 40) {
  const target = toKmh / 3.6;
  const r = drive(sim, {
    inputAt: () => ({ forward: true }),
    done: car => sim.forward(car) >= target,
    maxT,
  });
  if (!r.ok) return failed(r.why);
  if (r.timedOut) {
    return failed(`stalled at ${(sim.forward(r.car) * 3.6).toFixed(0)} km/h`);
  }
  return { value: r.t, note: '' };
}

export function measureTopSpeed(sim, maxT = 90) {
  const r = drive(sim, { inputAt: () => ({ forward: true }), maxT });
  if (!r.ok) return failed(r.why);
  return { value: sim.forward(r.car) * 3.6, note: `after ${maxT} s` };
}

export function measureBraking(sim, fromKmh, maxT = 20) {
  const r = drive(sim, {
    v0: fromKmh / 3.6,
    inputAt: () => ({ brake: true }),
    done: car => sim.forward(car) <= 0.5,
    maxT,
  });
  if (!r.ok) return failed(r.why);
  if (r.timedOut) return failed(`never stopped (${(sim.forward(r.car) * 3.6).toFixed(0)} km/h)`);
  return { value: r.dist, note: `${r.t.toFixed(2)} s` };
}

/**
 * Largest *sustained* lateral acceleration at a speed — a skid-pad limit.
 *
 * Lateral acceleration is read off the trajectory as yaw rate x forward speed,
 * which is `v²/R` and so does not depend on how the model stores its state.
 *
 * The judgement of "sustained" is the whole difficulty, and the first version of
 * it was too brittle to be useful. It compared the yaw rate at 75% of a 3 s hold
 * against the value at 100%, and stopped the sweep at the first angle that
 * disagreed. Against the four-wheel kernel that aborted at 2 degrees of a
 * 13.8 degree lock and reported 0.79 g on a car that sustains 2.3 — because the
 * tyre relaxation, the aero lag and a bang-bang speed controller together mean two
 * instantaneous samples 0.75 s apart are not evidence of anything.
 *
 * So: hold longer, judge from a *window* rather than two samples, average the
 * result over that window, and tolerate one marginal angle before giving up. The
 * sweep still refuses to report a car that is spinning — past the limit the
 * numbers get *larger*, and a peak-seeking metric will happily report a spin as a
 * record.
 */
export function measurePeakLateral(sim, speedKmh, {
  hold = 5.0, steps = 40, window = 1.0, tolerateFailures = 1,
} = {}) {
  const vTarget = speedKmh / 3.6;
  const lock = maxSteerAt(vTarget);
  let best = 0;
  let note = 'no stable cornering state';
  let failures = 0;

  const n = Math.round(hold / MEASURE_DT);
  const windowN = Math.round(window / MEASURE_DT);
  const yawTrace = new Float64Array(windowN);
  const ayTrace = new Float64Array(windowN);

  for (let i = 1; i <= steps; i++) {
    const steer = (lock * i) / steps;
    const car = sim.create();
    sim.launch(car, vTarget);
    let broke = null;
    let filled = 0;

    for (let k = 0; k < n; k++) {
      sim.steer(car, steer);
      // A proportional pedal, not an on/off switch. Holding a skid pad is a steady
      // throttle; switching between full and nothing at 120 Hz shakes the rear
      // axle hard enough to look like a car that never settles.
      throttleHold.throttle = clamp((vTarget - sim.forward(car)) * 0.6, 0, 1);
      sim.advance(car, throttleHold, MEASURE_DT);
      if (!sim.finite(car)) {
        broke = `non-finite at ${(steer / DEG2RAD).toFixed(1)} deg`;
        break;
      }
      if (k >= n - windowN) {
        const slot = k - (n - windowN);
        const fwd = sim.forward(car);
        yawTrace[slot] = sim.yawRate(car);
        ayTrace[slot] = Math.abs(sim.yawRate(car) * fwd) / sim.G;
        filled = slot + 1;
      }
    }
    if (broke) {
      if (best === 0) return failed(broke);
      break;
    }

    const fwd = sim.forward(car);
    const sideslip = Math.abs(Math.atan2(sim.lateral(car), Math.abs(fwd) || 1e-6));

    // Settled: the yaw rate over the final window is neither drifting nor
    // oscillating by more than a few percent of itself.
    const firstHalf = mean(yawTrace, 0, filled >> 1);
    const secondHalf = mean(yawTrace, filled >> 1, filled);
    const spread = range(yawTrace, 0, filled);
    const level = Math.max(Math.abs(secondHalf), 1e-6);
    const settled = Math.abs(secondHalf - firstHalf) <= Math.max(0.02, level * 0.06)
      && spread <= Math.max(0.05, level * 0.18);
    const tracking = sideslip < 0.20 && fwd > vTarget * 0.85 && settled;

    if (!tracking) {
      // One marginal angle is not a limit; two in a row is.
      if (++failures > tolerateFailures) break;
      continue;
    }
    failures = 0;

    const ay = mean(ayTrace, filled >> 1, filled);
    if (ay > best) {
      best = ay;
      note = `${(steer / DEG2RAD).toFixed(1)} deg of ${(lock / DEG2RAD).toFixed(1)} deg lock`;
    }
  }

  return best === 0 ? failed(note) : { value: best, note };
}

function mean(a, from, to) {
  if (to <= from) return 0;
  let sum = 0;
  for (let i = from; i < to; i++) sum += a[i];
  return sum / (to - from);
}

function range(a, from, to) {
  if (to <= from) return 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = from; i < to; i++) {
    if (a[i] < lo) lo = a[i];
    if (a[i] > hi) hi = a[i];
  }
  return hi - lo;
}

/**
 * Downforce in kilogrammes.
 *
 * This was analytic — `½ρv²·ClA/g` read off a constant `sim.CLA`. That constant
 * does not exist on a ground-effect car: ClA is a function of the ride height the
 * car settles at, which is a function of the downforce. The only correct
 * measurement is to let the coupled aero/suspension system find its own
 * equilibrium and read the answer off, which is what the adapter now does.
 *
 * The analytic path is kept as a fallback so a toy sim in the tests can still
 * declare a constant ClA and be measured against paper.
 */
export function measureDownforce(sim, speedKmh) {
  if (typeof sim.downforceAt === 'function') {
    const kg = sim.downforceAt(speedKmh);
    return Number.isFinite(kg)
      ? { value: kg, note: 'coupled equilibrium' }
      : failed('no aero equilibrium');
  }
  const v = speedKmh / 3.6;
  const kg = (0.5 * sim.RHO * v * v * sim.CLA) / sim.G;
  return Number.isFinite(kg)
    ? { value: kg, note: `ClA=${sim.CLA}` }
    : failed('aero constants missing');
}

export function runReference(sim) {
  const measure = {
    'accel-100': () => measureAcceleration(sim, 100),
    'accel-200': () => measureAcceleration(sim, 200),
    'accel-300': () => measureAcceleration(sim, 300, 60),
    vmax: () => measureTopSpeed(sim),
    'brake-100': () => measureBraking(sim, 100),
    'brake-200': () => measureBraking(sim, 200),
    'brake-300': () => measureBraking(sim, 300),
    'lat-100': () => measurePeakLateral(sim, 100),
    'lat-200': () => measurePeakLateral(sim, 200),
    'lat-290': () => measurePeakLateral(sim, 290),
    'df-200': () => measureDownforce(sim, 200),
    'df-300': () => measureDownforce(sim, 300),
  };

  return REFERENCE.map(ref => {
    let out;
    try {
      out = measure[ref.id]();
    } catch (err) {
      out = failed(`threw: ${err.message}`);
    }
    const error = Number.isFinite(out.value) ? out.value / ref.target - 1 : NaN;
    const verdict = !Number.isFinite(out.value) ? 'error'
      : Math.abs(error) <= ref.tol ? 'pass' : 'off';
    return { ...ref, measured: out.value, note: out.note, error, verdict };
  });
}
