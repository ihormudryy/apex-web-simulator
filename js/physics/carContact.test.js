import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCarContact, createCarContact } from './carContact.js';
import { MASS, IZ } from './constants.js';
import * as ST from './state.js';

function carAt(x, z, yaw = 0, vx = 0, vz = 0, av = 0) {
  const S = new Float64Array(64);
  S[ST.S_X] = x; S[ST.S_Z] = z; S[ST.S_YAW] = yaw;
  S[ST.S_VX] = vx; S[ST.S_VZ] = vz; S[ST.S_AV] = av;
  return S;
}
const energy = (A, B) => 0.5 * MASS * (A[ST.S_VX] ** 2 + A[ST.S_VZ] ** 2)
  + 0.5 * IZ * A[ST.S_AV] ** 2
  + 0.5 * MASS * (B[ST.S_VX] ** 2 + B[ST.S_VZ] ** 2)
  + 0.5 * IZ * B[ST.S_AV] ** 2;

test('contact never adds kinetic energy', () => {
  // The failure this guards: a two-body impulse with a sign or divisor wrong
  // pumps energy in, and a gentle nudge launches a car into the sky.
  const out = createCarContact();
  for (const closing of [1, 5, 20, 60]) {
    for (const lateral of [0, 0.4, 0.9, 1.6]) {
      const A = carAt(0, 0, 0, 0, -closing);
      const B = carAt(lateral, -4.5, 0, 0, 0);
      const before = energy(A, B);
      resolveCarContact(A, B, out);
      assert.ok(energy(A, B) <= before + 1e-6,
        `closing ${closing} lateral ${lateral}: energy rose from ${before} to ${energy(A, B)}`);
    }
  }
});

test('linear momentum is conserved in a head-on hit', () => {
  const out = createCarContact();
  const A = carAt(0, 0, 0, 0, -10);
  const B = carAt(0, -4.5, 0, 0, 0);
  const px = MASS * (A[ST.S_VX] + B[ST.S_VX]);
  const pz = MASS * (A[ST.S_VZ] + B[ST.S_VZ]);
  resolveCarContact(A, B, out);
  assert.ok(Math.abs(MASS * (A[ST.S_VX] + B[ST.S_VX]) - px) < 1e-6);
  assert.ok(Math.abs(MASS * (A[ST.S_VZ] + B[ST.S_VZ]) - pz) < 1e-6);
});

test('cars far apart are not in contact', () => {
  const out = createCarContact();
  const A = carAt(0, 0);
  const B = carAt(0, -40);
  resolveCarContact(A, B, out);
  assert.equal(out.hit, false);
});

test('two overlapping cars at rest push apart and stay apart', () => {
  const out = createCarContact();
  const A = carAt(0, 0);
  const B = carAt(0.5, -1.0);
  for (let i = 0; i < 40; i++) resolveCarContact(A, B, out);
  const gap = Math.hypot(A[ST.S_X] - B[ST.S_X], A[ST.S_Z] - B[ST.S_Z]);
  assert.ok(gap > 1.0, `cars still overlapping after 40 steps: ${gap.toFixed(2)} m`);
  assert.ok(Number.isFinite(gap), 'positional correction diverged');
});

test('the result is the same whichever car is passed first', () => {
  const out = createCarContact();
  const A1 = carAt(0, 0, 0, 0, -12), B1 = carAt(0.6, -4.4, 0, 0, 0);
  const A2 = carAt(0, 0, 0, 0, -12), B2 = carAt(0.6, -4.4, 0, 0, 0);
  resolveCarContact(A1, B1, out);
  resolveCarContact(B2, A2, out);
  assert.ok(Math.abs(A1[ST.S_VZ] - A2[ST.S_VZ]) < 1e-9,
    'swapping the argument order changed the outcome');
});

test('a glancing blow costs less speed than a square one', () => {
  const out = createCarContact();
  const square = carAt(0, 0, 0, 0, -20);
  resolveCarContact(square, carAt(0, -4.5, 0, 0, 0), out);
  const glance = carAt(0, 0, 0, 0, -20);
  resolveCarContact(glance, carAt(1.8, -4.5, 0, 0, 0), out);
  assert.ok(Math.abs(glance[ST.S_VZ]) > Math.abs(square[ST.S_VZ]),
    'the glancing car lost at least as much speed as the square hit');
});
