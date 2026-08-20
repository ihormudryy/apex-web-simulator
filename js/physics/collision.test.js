import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveWallContact, createContact,
  NOSE_X, TAIL_X, HALF_WIDTH, RESTITUTION, WALL_FRICTION,
  CORNER_X, CORNER_Y,
} from './collision.js';
import { createState, S_X, S_Z, S_YAW, S_VX, S_VZ, S_AV } from './state.js';
import { LF, LR } from './constants.js';

/**
 * A straight wall along Z at x = +-limit, in the REAL centreline convention:
 *
 *   lateral = -((P - S) . n)
 *
 * so with the normal pointing +x, lateral is NEGATIVE on the +x side. The first
 * version of this fixture had it backwards, the sign error in collision.js
 * matched it, the tests passed — and on the real circuit every wall contact
 * pushed the car OUT of the track, compounding exponentially to overflow. A
 * fixture that mis-states the contract it stands in for is worse than none.
 */
const corridor = limit => ({
  query: (x) => ({ lateral: -x, wallLimit: limit, normal: { x: 1, z: 0 } }),
});

/** A car at the origin facing -Z (yaw 0), moving with the given velocity. */
function car({ x = 0, z = 0, yaw = 0, vx = 0, vz = 0, av = 0 } = {}) {
  const S = createState();
  S[S_X] = x; S[S_Z] = z; S[S_YAW] = yaw;
  S[S_VX] = vx; S[S_VZ] = vz; S[S_AV] = av;
  return S;
}

test('the footprint is an F1 car, not a point', () => {
  assert.ok(NOSE_X > LF, 'the nose is ahead of the front axle');
  assert.ok(-TAIL_X > LR, 'the tail is behind the rear axle');
  const length = NOSE_X - TAIL_X;
  assert.ok(length > 5 && length < 6, `${length.toFixed(2)} m long`);
  assert.ok(HALF_WIDTH * 2 > 1.8 && HALF_WIDTH * 2 <= 2.0, `${HALF_WIDTH * 2} m wide`);
});

test('a car well inside the track is never touched', () => {
  const S = car({ vx: 5 });
  const before = [...S];
  const out = resolveWallContact(S, corridor(50), createContact());
  assert.equal(out.hit, false);
  assert.deepEqual([...S], before, 'no contact must mean no change');
});

test('a sideways drift into the wall is stopped, with a thud not a bounce', () => {
  // Wall at x = 10; car sliding right at 10 m/s with its side 0.2 m into it.
  const S = car({ x: 10 - HALF_WIDTH + 0.2, vx: 10 });
  const out = resolveWallContact(S, corridor(10), createContact());
  assert.equal(out.hit, true);
  assert.ok(S[S_VX] <= 0, `still moving into the wall at ${S[S_VX]}`);
  assert.ok(
    Math.abs(S[S_VX]) <= 10 * RESTITUTION + 0.5,
    `bounced back at ${(-S[S_VX]).toFixed(1)} m/s from a 10 m/s hit — Armco yields`,
  );
  assert.ok(out.severity > 8, `severity ${out.severity} for a 10 m/s side hit`);
});

test('the corner is pushed back out of the wall', () => {
  const S = car({ x: 10 - HALF_WIDTH + 0.3, vx: 3 });
  resolveWallContact(S, corridor(10), createContact());
  const worstCorner = Math.max(...[0, 1, 2, 3].map(i => S[S_X] + CORNER_Y[i]));
  assert.ok(worstCorner <= 10 + 0.05, `a corner is still ${(worstCorner - 10).toFixed(2)} m inside the wall`);
});

test('a nose-first hit pivots the car — the impulse acts at the corner', () => {
  // Facing the wall (+x is to the car's left at yaw +90deg... simpler: yaw the
  // car 45 degrees so the nose-right corner leads into the wall.
  const yaw = -Math.PI / 4;                    // nose swung toward +x
  // Nose-right corner sits at x + 2.73 in this attitude, so start it just short
  // of the wall with real closing speed.
  const S = car({ x: 7.4, yaw, vx: 15, vz: -15, av: 0 });
  const out = resolveWallContact(S, corridor(10), createContact());
  assert.equal(out.hit, true);
  assert.ok(out.corner < 2, `contact should be a nose corner, got ${out.corner}`);
  assert.ok(Math.abs(S[S_AV]) > 0.3, `a corner hit must rotate the car: av ${S[S_AV]}`);
});

test('glancing and head-on are different events', () => {
  // Same speed, different angle: brushing at 3 degrees vs square-on.
  const brush = car({ x: 10 - HALF_WIDTH + 0.02, vx: 55 * Math.sin(0.05), vz: -55 * Math.cos(0.05) });
  const bOut = resolveWallContact(brush, corridor(10), createContact());
  const square = car({ x: 10 - HALF_WIDTH + 0.02, yaw: Math.PI / 2, vx: 25 });
  const sOut = resolveWallContact(square, corridor(10), createContact());
  assert.ok(bOut.severity < 4, `a 3-degree brush at 200 km/h read ${bOut.severity.toFixed(1)} m/s`);
  assert.ok(sOut.severity > 15, `a square 90 km/h hit read ${sOut.severity.toFixed(1)} m/s`);
});

test('scraping along the wall costs speed — wall-riding is not a racing line', () => {
  const S = car({ x: 10 - HALF_WIDTH + 0.05, vx: 2, vz: -50 });
  resolveWallContact(S, corridor(10), createContact());
  assert.ok(Math.abs(S[S_VZ]) < 50, `no tangential loss: ${S[S_VZ]}`);
  assert.ok(Math.abs(S[S_VZ]) > 40, 'but a scrape is not a brick wall either');
  assert.ok(WALL_FRICTION > 0.2 && WALL_FRICTION < 0.9);
});

test('the scrape speed is reported for sparks and damage', () => {
  const S = car({ x: 10 - HALF_WIDTH + 0.05, vx: 2, vz: -40 });
  const out = resolveWallContact(S, corridor(10), createContact());
  assert.ok(out.scrape > 30, `scrape ${out.scrape}`);
  assert.ok(Number.isFinite(out.x) && Number.isFinite(out.z), 'and where it happened');
});

test('resolution is deterministic', () => {
  const run = () => {
    const S = car({ x: 10 - HALF_WIDTH + 0.2, yaw: 0.3, vx: 12, vz: -30, av: 0.5 });
    resolveWallContact(S, corridor(10), createContact());
    return [...S];
  };
  assert.deepEqual(run(), run());
});

test('the contact report is reused, not reallocated', () => {
  const out = createContact();
  const S = car({ x: 10 - HALF_WIDTH + 0.1, vx: 5 });
  assert.equal(resolveWallContact(S, corridor(10), out), out);
});
