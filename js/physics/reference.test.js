import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REFERENCE, runReference, maxSteerAt, measureAcceleration, measureBraking,
  measureTopSpeed, measurePeakLateral, measureDownforce,
} from './reference.js';
import { MAX_STEER_DEG } from './driver.js';

/**
 * A car whose answers are known on paper, so the measuring code can be checked
 * without depending on the real vehicle. The real vehicle is the subject under
 * test in `npm run validate`; here the instrument is the subject.
 */
function toySim({ m = 1000, fDrive = 10000, fBrake = 20000, ayMax = 15, drag = 0 } = {}) {
  return {
    MASS: m, G: 10, RHO: 2, CLA: 3,
    create: () => ({ x: 0, v: 0, steer: 0, av: 0 }),
    launch: (c, mps) => { c.v = mps; },
    steer: (c, rad) => { c.steer = rad; },
    advance: (c, input, dt) => {
      const sign = Math.sign(c.v || 1);
      const fx = (input.brake ? -fBrake * sign : (input.forward ? fDrive : 0))
        - drag * c.v * c.v * sign;
      c.v += (dt * fx) / m;
      // A steady turn at the commanded lateral acceleration, saturating at ayMax.
      const ay = Math.min(ayMax, Math.abs(c.steer) * 400);
      c.av = Math.abs(c.v) > 0.01 ? ay / c.v : 0;
      c.x += dt * c.v;
    },
    forward: c => c.v,
    lateral: () => 0,
    yawRate: c => c.av,
    position: c => [c.x, 0],
    finite: c => Number.isFinite(c.v) && Number.isFinite(c.x),
  };
}

test('acceleration time matches the analytic answer', () => {
  // 10 000 N on 1000 kg is 10 m/s²; 100 km/h is 27.778 m/s.
  const { value } = measureAcceleration(toySim(), 100);
  assert.ok(Math.abs(value - 2.7778) < 0.02, `got ${value}`);
});

test('braking distance matches v²/2a', () => {
  const expected = (27.7778 ** 2 - 0.5 ** 2) / (2 * 20);
  const { value } = measureBraking(toySim(), 100);
  assert.ok(Math.abs(value - expected) < 0.3, `got ${value}, expected ${expected.toFixed(2)}`);
});

test('top speed converges on the drag-limited terminal speed', () => {
  // fDrive = drag·v²  ->  v = sqrt(10000/4) = 50 m/s = 180 km/h.
  const { value } = measureTopSpeed(toySim({ drag: 4 }));
  assert.ok(Math.abs(value - 180) < 1, `got ${value}`);
});

test('peak lateral comes back in g from a stable cornering state', () => {
  // 15 m/s² at G=10 is 1.5 g, and the toy saturates there.
  const { value } = measurePeakLateral(toySim(), 200);
  assert.ok(Math.abs(value - 1.5) < 0.05, `got ${value}`);
});

test('a spin is not reported as grip', () => {
  // Yaw rate that never settles and sideslip that runs away. The naive metric —
  // peak of yaw-rate times speed — called exactly this 54 g on the real car.
  const spinning = {
    MASS: 800, G: 9.81, RHO: 1.225, CLA: 4.6,
    create: () => ({ v: 80, av: 0, lat: 0, x: 0 }),
    launch: (c, mps) => { c.v = mps; },
    steer: () => {},
    advance: (c, _input, dt) => { c.av += dt * 8; c.lat += dt * 20; c.x += dt * c.v; },
    forward: c => c.v,
    lateral: c => c.lat,
    yawRate: c => c.av,
    position: c => [c.x, 0],
    finite: () => true,
  };
  const r = measurePeakLateral(spinning, 290);
  assert.ok(!Number.isFinite(r.value), `reported ${r.value} g for a spin`);
});

test('steering lock falls with speed, and the sweep respects it', () => {
  // Properties, not the output of a particular formula. This asserted 6 deg at
  // 80 m/s, which was the old linear fade restated — so the test had to be edited
  // to change the curve, which is a test measuring the code rather than the
  // requirement.
  const atRest = maxSteerAt(0) * 180 / Math.PI;
  const fast = maxSteerAt(80) * 180 / Math.PI;
  assert.ok(
    Math.abs(atRest - MAX_STEER_DEG) < 0.01,
    `${atRest} deg at rest, expected the mechanical lock ${MAX_STEER_DEG}`,
  );
  assert.ok(fast < atRest * 0.5, `${fast} deg at 80 m/s is not much less than ${atRest}`);
  assert.ok(fast > 1, `${fast} deg at 80 m/s leaves the car unable to steer at all`);
  // The reported angle must never exceed the lock available at that speed.
  const r = measurePeakLateral(toySim(), 290);
  const used = Number(/([\d.]+) deg of/.exec(r.note)?.[1] ?? 0);
  assert.ok(used <= fast + 0.01, `used ${used} deg of ${fast} deg lock`);
});

test('a car that returns NaN is reported, not crashed on', () => {
  const broken = {
    MASS: 800, G: 9.81, RHO: 1.225, CLA: 4.6,
    create: () => ({}), launch: () => {}, steer: () => {},
    advance: () => {}, forward: () => NaN, lateral: () => NaN,
    yawRate: () => NaN, position: () => [NaN, NaN], finite: () => false,
  };
  const rows = runReference(broken);
  assert.equal(rows.length, REFERENCE.length);
  const dynamic = rows.filter(r => !r.id.startsWith('df-'));
  assert.ok(dynamic.every(r => r.verdict === 'error'), 'integrated rows should error');
  assert.ok(dynamic.every(r => /non-finite/.test(r.note)), 'and say why');
  // Downforce is analytic, so it still answers.
  assert.ok(rows.filter(r => r.id.startsWith('df-')).every(r => Number.isFinite(r.measured)));
});

test('a car that throws is reported, not propagated', () => {
  const rows = runReference({
    MASS: 800, G: 9.81, RHO: 1.225, CLA: 4.6,
    create() { throw new Error('sim exploded'); },
  });
  const dynamic = rows.filter(r => !r.id.startsWith('df-'));
  assert.ok(dynamic.every(r => r.verdict === 'error' && /sim exploded/.test(r.note)));
});

test('downforce is q·ClA expressed as mass', () => {
  // 200 km/h = 55.556 m/s; q = 0.5·2·55.556² = 3086.4; ·3 / 10 = 925.9 kg.
  const { value } = measureDownforce(toySim(), 200);
  assert.ok(Math.abs(value - 925.9) < 1, `got ${value}`);
});

test('every reference entry is well formed', () => {
  const ids = new Set();
  for (const r of REFERENCE) {
    assert.ok(!ids.has(r.id), `duplicate id ${r.id}`);
    ids.add(r.id);
    assert.ok(r.target > 0, `${r.id} target`);
    assert.ok(r.tol > 0 && r.tol < 1, `${r.id} tolerance ${r.tol}`);
    assert.ok(r.label && r.unit, `${r.id} needs a label and unit`);
  }
});

test('verdicts are only pass, off or error', () => {
  for (const r of runReference(toySim({ drag: 4 }))) {
    assert.ok(['pass', 'off', 'error'].includes(r.verdict), r.verdict);
  }
});
