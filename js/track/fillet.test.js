// js/track/fillet.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filletRing, ringLength, filletToLength } from './fillet.js';
import { buildCenterline, minCurvatureRadius, maxTangentJump } from './centerline.js';

const square = (radius) => [
  { x: 0, z: 0, radius, halfWidth: 6, runoff: 8 },
  { x: 200, z: 0, radius, halfWidth: 6, runoff: 8 },
  { x: 200, z: 200, radius, halfWidth: 6, runoff: 8 },
  { x: 0, z: 200, radius, halfWidth: 6, runoff: 8 },
];

// Curvature is only meaningful at a fixed station spacing, and the spacing the
// physics sees is whatever `buildCenterline` resamples to. Measure it there.
const tightestRadius = (ring, spacing = 1.5) =>
  minCurvatureRadius(buildCenterline(ring, Math.round(ringLength(ring) / spacing)));

test('a zero-radius ring is returned unchanged', () => {
  const ring = filletRing(square(0));
  assert.equal(ring.length, 4);
  assert.deepEqual(ring.map(p => [p.x, p.z]), [[0, 0], [200, 0], [200, 200], [0, 200]]);
});

test('filleting a square replaces each 90° corner with a quarter arc of the asked radius', () => {
  const r = 30;
  const ring = filletRing(square(r), { arcStep: 1 });
  // Every emitted point is either on a straight or at distance r from a corner centre.
  const centres = [[r, r], [200 - r, r], [200 - r, 200 - r], [r, 200 - r]];
  for (const p of ring) {
    const nearest = Math.min(...centres.map(([cx, cz]) => Math.hypot(p.x - cx, p.z - cz)));
    assert.ok(nearest <= r + 1e-6, `point (${p.x},${p.z}) is ${nearest} from the nearest arc centre`);
  }
  // Corner-cutting shortens the lap by (2 - π/2)·r per 90° corner.
  const expected = 800 - 4 * (2 - Math.PI / 2) * r;
  assert.ok(Math.abs(ringLength(ring) - expected) / expected < 1e-3,
    `length ${ringLength(ring)} vs ${expected}`);
});

test('filleting bounds curvature: no station turns tighter than the asked radius', () => {
  const r = 25;
  const min = tightestRadius(filletRing(square(r)));
  assert.ok(min > r * 0.8, `tightest curvature radius ${min} m, asked for ${r} m`);
});

test('filleting removes the kink an unfilleted polygon hands to the physics', () => {
  const spacing = 1.5, arcStep = 0.5, r = 25;
  const jumpDeg = ring => maxTangentJump(
    buildCenterline(ring, Math.round(ringLength(ring) / spacing))) * 180 / Math.PI;

  assert.ok(jumpDeg(square(0)) > 80,
    `a polygon hands the physics a ~90° heading jump, measured ${jumpDeg(square(0)).toFixed(1)}°`);

  // On an arc of radius r a station can only turn by the road it spans plus the
  // one chord it may straddle; 1.25 leaves room for where stations happen to land.
  const bound = 1.25 * (spacing + arcStep) / r * 180 / Math.PI;
  const filleted = jumpDeg(filletRing(square(r), { arcStep }));
  assert.ok(filleted <= bound, `filleted jump ${filleted.toFixed(2)}° exceeds ${bound.toFixed(2)}°`);
});

test('radii are clamped so two arcs never overrun the straight they share', () => {
  // 40 m straights cannot host two 90° arcs of 100 m radius (setback 100 m each).
  const tight = [
    { x: 0, z: 0, radius: 100 },
    { x: 40, z: 0, radius: 100 },
    { x: 40, z: 40, radius: 100 },
    { x: 0, z: 40, radius: 100 },
  ];
  const ring = filletRing(tight, { arcStep: 0.5 });
  for (const p of ring) {
    assert.ok(p.x >= -1e-6 && p.x <= 40 + 1e-6 && p.z >= -1e-6 && p.z <= 40 + 1e-6,
      `clamped arc escaped the hull at (${p.x},${p.z})`);
  }
  assert.ok(ringLength(ring) > 100, `degenerate ring length ${ringLength(ring)}`);
});

test('non-geometry properties ride along onto every generated point', () => {
  const ring = filletRing([
    { x: 0, z: 0, radius: 20, halfWidth: 6, runoff: 9 },
    { x: 100, z: 0, radius: 20, halfWidth: 8, runoff: 3 },
    { x: 100, z: 100, radius: 20, halfWidth: 6, runoff: 9 },
    { x: 0, z: 100, radius: 20, halfWidth: 6, runoff: 9 },
  ], { arcStep: 5 });
  for (const p of ring) {
    assert.ok(typeof p.halfWidth === 'number' && typeof p.runoff === 'number');
  }
  assert.ok(ring.some(p => p.halfWidth === 8 && p.runoff === 3), 'per-corner values lost');
});

test('filletToLength hits the target lap length with the radii still in true metres', () => {
  const { ring, length, scale } = filletToLength(square(40), 5891);
  assert.ok(Math.abs(length - 5891) < 1, `length ${length}`);
  assert.ok(scale > 1, `expected to grow the polygon, scale=${scale}`);
  const min = tightestRadius(ring);
  assert.ok(min > 30, `radii should stay near the authored 40 m, tightest was ${min}`);
});
