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

// Angular momentum about the origin, Y-axis convention matching av's
// yaw-left-positive cross product (v_point = v + av x r): the intrinsic spin
// term IZ*av plus each body's orbital term m*(z*vx - x*vz).
//
// `xA/zA/xB/zB` are FROZEN at the pre-call positions deliberately, for both
// the before and after readings. Two equal-and-opposite impulses applied at
// the same shared point conserve angular momentum about any fixed point
// exactly, regardless of the impulse's magnitude or direction — but only the
// velocity solve has that property. The positional correction afterwards
// moves the centres without touching velocities, and re-reading the (now
// shifted) positions into this same formula mixes in a purely geometric,
// non-physical contribution — measured at ~185 against a same-order energy
// of ~160,000 for these cases, entirely an artefact of the correction step,
// not the impulse. Freezing the positions removes that confound and isolates
// exactly what the velocity solve is required to conserve.
const angMom = (A, B, xA, zA, xB, zB) => IZ * (A[ST.S_AV] + B[ST.S_AV])
  + MASS * ((zA * A[ST.S_VX] - xA * A[ST.S_VZ]) + (zB * B[ST.S_VX] - xB * B[ST.S_VZ]));

test('angular momentum about the origin is conserved by the velocity solve', () => {
  // The blind spot this guards: energy and momentum conservation do not
  // constrain the rotational (av) term at all — a sign error confined to one
  // body's spin update (e.g. `SB[S_AV] += ...` flipped to `-=`) leaves both
  // of those tests green. Verified by injecting exactly that bug: energy and
  // momentum here still passed, while this test's residual jumped from
  // ~1e-12 to the thousands, for every case below.
  const out = createCarContact();
  const cases = [
    // [Ax, Az, Ayaw, Avx, Avz, Bx, Bz, Byaw]
    [0, 0, 0, 0, -20, 0, -4.5, 0],       // square
    [0, 0, 0, 0, -20, 1.8, -4.5, 0],     // glancing
    [0, 0, 0.3, null, null, 0.2, -4.3, 0],   // angled rear-end, velocity below
    [-3.0, -0.3, -Math.PI / 2 + 0.05, null, null, 0, 0, 0], // side-on
  ];
  for (const [ax, az, ayaw, avx, avz, bx, bz, byaw] of cases) {
    let vx = avx, vz = avz;
    if (vx === null) {
      // Drive along the car's own forward direction so an angled car still
      // closes on the other, rather than sliding past it sideways.
      const speed = 15;
      vx = -Math.sin(ayaw) * speed;
      vz = -Math.cos(ayaw) * speed;
    }
    const A = carAt(ax, az, ayaw, vx, vz);
    const B = carAt(bx, bz, byaw, 0, 0);
    const xA = A[ST.S_X], zA = A[ST.S_Z], xB = B[ST.S_X], zB = B[ST.S_Z];
    const before = angMom(A, B, xA, zA, xB, zB);
    resolveCarContact(A, B, out);
    const after = angMom(A, B, xA, zA, xB, zB); // positions frozen, see above
    assert.ok(Math.abs(after - before) < 1e-3,
      `case [${ax},${az},${ayaw}]: angular momentum drifted from ${before} to ${after}`);
  }
});

test('an angled rear-end hit does not add energy and conserves momentum', () => {
  // Every prior test is axis-aligned (both cars at yaw 0). This is the first
  // to put a car at a genuine angle to the other, so the normal and lever
  // arms are exercised outside that special case.
  const out = createCarContact();
  const yaw = 0.3; // ~17 degrees off dead ahead
  const speed = 15;
  const A = carAt(0, 0, yaw, -Math.sin(yaw) * speed, -Math.cos(yaw) * speed);
  const B = carAt(0.2, -4.3, 0, 0, 0);
  const before = energy(A, B);
  const px = MASS * (A[ST.S_VX] + B[ST.S_VX]);
  const pz = MASS * (A[ST.S_VZ] + B[ST.S_VZ]);
  resolveCarContact(A, B, out);
  assert.ok(out.hit, 'expected the angled approach to register contact');
  assert.ok(energy(A, B) <= before + 1e-6,
    `energy rose from ${before} to ${energy(A, B)}`);
  assert.ok(Math.abs(MASS * (A[ST.S_VX] + B[ST.S_VX]) - px) < 1e-6);
  assert.ok(Math.abs(MASS * (A[ST.S_VZ] + B[ST.S_VZ]) - pz) < 1e-6);
});

test('a side-on hit does not add energy, conserves momentum, and pushes the cars apart', () => {
  // Centre-to-centre normal is an approximation of the true contact surface
  // normal; for a near-perpendicular (T-bone-like) hit it is at its least
  // accurate (the physically correct local normal is closer to the struck
  // panel's normal). Out of scope for this task — see the module header —
  // but this still has to hold: no energy created, momentum conserved, and
  // the cars end up more separated than they started, not less.
  const out = createCarContact();
  const yaw = -Math.PI / 2 + 0.05; // struck car nearly broadside-on
  const speed = 12;
  const A = carAt(-3.0, -0.3, yaw, -Math.sin(yaw) * speed, -Math.cos(yaw) * speed);
  const B = carAt(0, 0, 0, 0, 0);
  const before = energy(A, B);
  const px = MASS * (A[ST.S_VX] + B[ST.S_VX]);
  const pz = MASS * (A[ST.S_VZ] + B[ST.S_VZ]);
  resolveCarContact(A, B, out);
  assert.ok(out.hit, 'expected the side-on approach to register contact');
  assert.ok(energy(A, B) <= before + 1e-6,
    `energy rose from ${before} to ${energy(A, B)}`);
  assert.ok(Math.abs(MASS * (A[ST.S_VX] + B[ST.S_VX]) - px) < 1e-6);
  assert.ok(Math.abs(MASS * (A[ST.S_VZ] + B[ST.S_VZ]) - pz) < 1e-6);

  // Same geometry, at rest: repeated resolves should separate the cars, not
  // let them interpenetrate further.
  const A2 = carAt(-3.0, -0.3, yaw, 0, 0);
  const B2 = carAt(0, 0, 0, 0, 0);
  const gapBefore = Math.hypot(A2[ST.S_X] - B2[ST.S_X], A2[ST.S_Z] - B2[ST.S_Z]);
  for (let i = 0; i < 40; i++) resolveCarContact(A2, B2, out);
  const gapAfter = Math.hypot(A2[ST.S_X] - B2[ST.S_X], A2[ST.S_Z] - B2[ST.S_Z]);
  assert.ok(Number.isFinite(gapAfter), 'positional correction diverged');
  assert.ok(gapAfter > gapBefore,
    `cars ended up closer (${gapBefore.toFixed(2)} -> ${gapAfter.toFixed(2)}) instead of separating`);
});
