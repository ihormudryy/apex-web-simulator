import { test } from 'node:test';
import assert from 'node:assert/strict';
import { densifyRing } from './densify.js';
import { SILVERSTONE_SURVEYED_RING } from './silverstoneSurvey.js';
import { buildCenterline, maxTangentJump, minCurvatureRadius } from './centerline.js';

function ringLength(ring) {
  return ring.reduce((s, p, i) => {
    const q = ring[(i + 1) % ring.length];
    return s + Math.hypot(q.x - p.x, q.z - p.z);
  }, 0);
}

test('densify interpolates the survey points exactly', () => {
  // Catmull-Rom passes through its control points; the surveyed positions
  // must survive densification untouched, or the import guarantees
  // (min radius, corridor) no longer apply to what is drawn.
  const ring = SILVERSTONE_SURVEYED_RING;
  const dense = densifyRing(ring, 0.75);
  const first = dense[0];
  assert.ok(Math.hypot(first.x - ring[0].x, first.z - ring[0].z) < 1e-9);
  // every survey point appears somewhere in the dense ring
  let cursor = 0;
  for (const p of ring) {
    let found = false;
    for (let k = 0; k < dense.length; k++) {
      const d = dense[(cursor + k) % dense.length];
      if (Math.hypot(d.x - p.x, d.z - p.z) < 1e-6) { cursor += k; found = true; break; }
    }
    assert.ok(found, `survey point (${p.x}, ${p.z}) missing from the dense ring`);
  }
});

test('densified ring keeps the surveyed length', () => {
  const ring = SILVERSTONE_SURVEYED_RING;
  const dense = densifyRing(ring, 0.75);
  const a = ringLength(ring);
  const b = ringLength(dense);
  // The spline may bulge slightly outside the polyline chords, never shrink
  // below them, and stays within a few permille of the surveyed loop.
  assert.ok(b >= a - 1e-6, 'spline cannot be shorter than its chords');
  assert.ok(Math.abs(b - a) / a < 0.005, `length drifted ${(100 * (b - a) / a).toFixed(2)}%`);
});

test('densified survey meets the generator smoothness the physics needs', () => {
  const dense = densifyRing(SILVERSTONE_SURVEYED_RING, 0.75);
  const c = buildCenterline(dense, 4000);
  const jump = maxTangentJump(c) * 180 / Math.PI;
  assert.ok(jump < 5, `heading jumps ${jump.toFixed(1)} deg between stations`);
  const tightest = minCurvatureRadius(c);
  assert.ok(tightest > 18, `tightest corner radius ${tightest.toFixed(1)} m`);
});

test('widths interpolate between survey points and stay in the surveyed range', () => {
  const dense = densifyRing(SILVERSTONE_SURVEYED_RING, 0.75);
  let min = Infinity, max = -Infinity;
  for (const p of dense) { min = Math.min(min, p.halfWidth); max = Math.max(max, p.halfWidth); }
  // The surveyed halfWidth spans ~5.6–8.9 m; linear interpolation cannot
  // overshoot the endpoints.
  assert.ok(min > 5 && max < 9.5, `halfWidth range ${min.toFixed(2)}–${max.toFixed(2)}`);
  assert.ok(dense.every(p => p.runoff >= 6 && p.runoff <= 24), 'runoff stays in the hand-tuned range');
});
