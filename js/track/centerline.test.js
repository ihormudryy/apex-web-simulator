// js/track/centerline.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCenterline, minCurvatureRadius, maxTangentJump, curvatureRadii,
} from './centerline.js';
import { SILVERSTONE_WAYPOINTS } from './silverstoneWaypoints.js';

const box = [
  { x: 0, z: 0, halfWidth: 6, runoff: 8 },
  { x: 100, z: 0, halfWidth: 6, runoff: 8 },
  { x: 100, z: 50, halfWidth: 6, runoff: 8 },
  { x: 0, z: 50, halfWidth: 6, runoff: 8 },
];

test('closed loop length is perimeter', () => {
  const c = buildCenterline(box, 400);
  assert.ok(Math.abs(c.length - 300) / 300 < 0.08);
});

test('on-center is tarmac, 7m off is kerb, 20m off is grass', () => {
  const c = buildCenterline(box, 400);
  const mid = c.query(50, 0);
  assert.equal(mid.surface, 'tarmac');
  const kerb = c.query(50, 6.5);
  assert.equal(kerb.surface, 'kerb');
  const grass = c.query(50, 20);
  assert.equal(grass.surface, 'grass');
  assert.ok(grass.wallLimit > 10);
});

test('lateral positive is right of +X travel on bottom edge', () => {
  const c = buildCenterline(box, 400);
  const left = c.query(50, 6.5);
  assert.ok(left.lateral < 0, 'left of travel should be negative lateral');
  const right = c.query(50, -6.5);
  assert.ok(right.lateral > 0, 'right of travel should be positive lateral');
});

test('Silverstone GP length is 5.891 km ± 5%', () => {
  const c = buildCenterline(SILVERSTONE_WAYPOINTS, 4000);
  assert.ok(c.length > 5596 && c.length < 6186, `length ${c.length}`);
});

test('Silverstone Hamilton Straight has continuous spawn tangents', () => {
  const n = SILVERSTONE_WAYPOINTS.length;
  const last = SILVERSTONE_WAYPOINTS[n - 1];
  const ham = SILVERSTONE_WAYPOINTS[0];
  const abb = SILVERSTONE_WAYPOINTS[1];
  const unit = (a, b) => {
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    return { x: dx / len, z: dz / len };
  };
  const tIn = unit(last, ham);
  const tOut = unit(ham, abb);
  const dot = tIn.x * tOut.x + tIn.z * tOut.z;
  assert.ok(dot > 0.99, `spawn tangent dot ${dot}`);
});

test('Silverstone ring has no tangent reversals', () => {
  const c = buildCenterline(SILVERSTONE_WAYPOINTS, 4000);
  for (let i = 0; i < c.samples.length; i++) {
    const a = c.samples[i];
    const b = c.samples[(i + 1) % c.samples.length];
    const dot = a.tx * b.tx + a.tz * b.tz;
    // The parked 21-waypoint, piecewise-linear design has intentional corner
    // kinks below 0.9. Until I2 adds curve vertices, reject every reversal.
    assert.ok(dot > 0, `tangent reversal at sample ${i}: dot=${dot}`);
  }
});

test('Silverstone distant sections stay more than a track width apart', () => {
  const c = buildCenterline(SILVERSTONE_WAYPOINTS, 2000);
  const spacing = c.length / c.samples.length;
  const maxHalfWidth = Math.max(...c.samples.map(s => s.halfWidth));
  const neighborhood = Math.ceil(60 / spacing);
  let minDistance = Infinity;

  for (let i = 0; i < c.samples.length; i++) {
    for (let j = i + 1; j < c.samples.length; j++) {
      const ringGap = Math.min(j - i, c.samples.length - (j - i));
      if (ringGap <= neighborhood) continue;
      const a = c.samples[i];
      const b = c.samples[j];
      minDistance = Math.min(minDistance, Math.hypot(a.x - b.x, a.z - b.z));
    }
  }

  assert.ok(minDistance > 2 * maxHalfWidth,
    `minimum self-approach ${minDistance} <= ${2 * maxHalfWidth}`);
});

// --- The properties that make the circuit drivable and the mesh well-formed ---

test('Silverstone corner radii are bounded, not the zero-radius kinks of a polygon', () => {
  const c = buildCenterline(SILVERSTONE_WAYPOINTS, 4000);
  const tightest = minCurvatureRadius(c);
  // A polygon vertex is a zero-radius corner and no car can take one at any
  // speed. The Loop is the slowest corner on the real circuit at ~85 km/h.
  assert.ok(tightest > 25, `tightest corner radius is ${tightest.toFixed(1)} m`);
  const slowest = Math.sqrt(1.6 * 9.81 * tightest) * 3.6;
  assert.ok(slowest > 70 && slowest < 130,
    `slowest corner allows ${slowest.toFixed(0)} km/h — not a Silverstone-like hairpin`);
});

test('the heading never jumps between stations', () => {
  const c = buildCenterline(SILVERSTONE_WAYPOINTS, 4000);
  const jump = maxTangentJump(c) * 180 / Math.PI;
  // The centerline tangent is what `query` hands the physics; a step change in it
  // is a step change in the car's lateral offset and surface.
  assert.ok(jump < 5, `heading jumps ${jump.toFixed(1)}° between adjacent stations`);
});

test('no corner is tighter than the ribbon swept through it', () => {
  const c = buildCenterline(SILVERSTONE_WAYPOINTS, 4000);
  const radii = curvatureRadii(c);
  // A strip of half-width w swept round a radius r folds back on itself once
  // w >= r, which is what made the runoff and the barriers cut across the track
  // on the inside of every corner. The margin has to hold station by station:
  // the slowest corner and the widest runoff are at opposite ends of the lap.
  let worst = { ratio: Infinity };
  c.samples.forEach((s, i) => {
    const reach = s.halfWidth + s.runoff;
    const ratio = radii[i] / reach;
    if (ratio < worst.ratio) worst = { ratio, i, radius: radii[i], reach };
  });
  assert.ok(worst.ratio > 1.2,
    `station ${worst.i}: radius ${worst.radius.toFixed(1)} m against a ` +
    `${worst.reach.toFixed(1)} m half-width (ratio ${worst.ratio.toFixed(2)})`);
});

test('the spawn sits on a straight, so the grid faces down the road', () => {
  const c = buildCenterline(SILVERSTONE_WAYPOINTS, 4000);
  const n = c.samples.length;
  const span = Math.round(25 / c.spacing);   // 25 m either side of the line
  const at = c.samples[0];
  for (const i of [-span, span]) {
    const s = c.samples[(i + n) % n];
    const dot = at.tx * s.tx + at.tz * s.tz;
    assert.ok(dot > 0.999, `tangent turns by ${(Math.acos(dot) * 180 / Math.PI).toFixed(2)}° within 25 m of the grid`);
  }
});

test('station spacing is fine enough for the physics window', () => {
  const c = buildCenterline(SILVERSTONE_WAYPOINTS, 4000);
  // `query` searches +/-80 stations around its hint. At 90 m/s over a 0.05 s
  // frame the car moves 4.5 m, so the window has to cover far more than that.
  assert.ok(c.spacing < 3, `station spacing ${c.spacing.toFixed(2)} m`);
  assert.ok(80 * c.spacing > 50, `search window only reaches ${(80 * c.spacing).toFixed(0)} m`);
});
