// js/track/centerline.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCenterline, minCurvatureRadius, maxTangentJump, curvatureRadii,
  smoothTrackWidths, limitWidthGradient, nearestStationIndex,
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
  // speed. With the surveyed geometry the bound is on the CENTERLINE, which
  // at The Loop is genuinely ~20 m — drivers carry ~95 km/h through it only
  // by straightening the corner across the full 14 m width, which is a
  // driving-line matter. The old 25 m bound dated from the hand-tuned layout
  // where the centerline doubled as the driving line.
  assert.ok(tightest > 18, `tightest corner radius is ${tightest.toFixed(1)} m`);
  const slowest = Math.sqrt(1.6 * 9.81 * tightest) * 3.6;
  assert.ok(slowest > 55 && slowest < 130,
    `slowest corner allows ${slowest.toFixed(0)} km/h on the centerline — not a Silverstone-like hairpin`);
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

test('smoothTrackWidths removes step edges from runoff', () => {
  const jagged = [];
  for (let i = 0; i < 40; i++) {
    jagged.push({
      halfWidth: 8,
      runoff: i < 20 ? 5 : 20,
    });
  }
  const before = Math.abs(jagged[20].runoff - jagged[19].runoff);
  assert.equal(before, 15);
  smoothTrackWidths(jagged, 4);
  const after = Math.abs(jagged[20].runoff - jagged[19].runoff);
  assert.ok(after < 4, `runoff still steps by ${after.toFixed(2)} m after smoothing`);
});

test('Silverstone runoff does not stair-step between stations', () => {
  const c = buildCenterline(SILVERSTONE_WAYPOINTS, 4000);
  let worst = 0;
  for (let i = 1; i < c.samples.length; i++) {
    worst = Math.max(worst, Math.abs(c.samples[i].runoff - c.samples[i - 1].runoff));
  }
  // Unsmoothed Silverstone put ~0.75 m of runoff change into a 1.5 m station —
  // a visible sawtooth on the grass edge.
  assert.ok(worst <= 0.12 + 1e-9, `runoff jumps ${worst.toFixed(3)} m between stations`);
});

test('limitWidthGradient caps adjacent runoff change', () => {
  const samples = [
    { halfWidth: 8, runoff: 5 },
    { halfWidth: 8, runoff: 25 },
    { halfWidth: 8, runoff: 25 },
  ];
  limitWidthGradient(samples, 0.12);
  assert.ok(Math.abs(samples[1].runoff - samples[0].runoff) <= 0.12 + 1e-9);
});

test('nearest station is exhaustive — a Loop infield point is not Copse', () => {
  const c = buildCenterline(SILVERSTONE_WAYPOINTS, 4000);
  const loop = c.samples[Math.round(0.154 * c.samples.length) % c.samples.length];
  const copse = c.samples[Math.round(0.39 * c.samples.length) % c.samples.length];
  // A few metres inside the Loop, still beside the ribbon, not on Copse.
  const x = loop.x - loop.nx * (loop.halfWidth + loop.runoff + 8);
  const z = loop.z - loop.nz * (loop.halfWidth + loop.runoff + 8);
  const i = nearestStationIndex(c.samples, x, z);
  const t = c.samples[i].t;
  const dLoop = Math.hypot(x - loop.x, z - loop.z);
  const dCopse = Math.hypot(x - copse.x, z - copse.z);
  assert.ok(dLoop < dCopse, 'test point should be nearer the Loop than Copse');
  assert.ok(Math.abs(t - loop.t) < 0.08, `infield snapped to t=${t.toFixed(3)}, Loop is ${loop.t.toFixed(3)}`);
});

// ---------------------------------------------------------------------------
// Continuity of the query point itself.
//
// `query` snaps to the nearest station, and it used to hand back that station's
// `t` and `halfWidth` verbatim. Everything the physics stands on is a function
// of `t` — `surfaceHeight`, `surfaceRoughness`, `verticalCurvature`,
// `roadLiftAt` — so a per-station `t` made the surface a STAIRCASE: constant
// across a 1.47 m tread, then a step of up to 18 mm at the join. At 200 km/h
// that is 39 vertical steps a second under each tyre, which is what the four
// corner loads were chattering against: 994 N to 5192 N frame to frame with the
// car going straight, and the load direction reversing on 59% of frames.
//
// The drawn ribbon interpolates between the same stations, so the staircase was
// also a disagreement with the surface the driver can see.
// ---------------------------------------------------------------------------

test('t advances with the car, not in station-sized steps', () => {
  const c = buildCenterline(SILVERSTONE_WAYPOINTS, 4000);
  // Walk one station's worth of road in twenty small hops along the tangent.
  // Each hop is a known distance, so `t` has a known answer: hop / length.
  const s = c.samples[1500];
  const hop = c.spacing / 20;
  const expected = hop / c.length;
  let prev = null;
  let worst = 0;
  for (let i = 0; i < 20; i++) {
    const q = c.query(s.x + s.tx * hop * i, s.z + s.tz * hop * i);
    if (prev !== null) worst = Math.max(worst, Math.abs((q.t - prev) - expected));
    prev = q.t;
  }
  // In metres of road, so the failure reads as a distance rather than a fraction.
  assert.ok(worst * c.length < 0.01,
    `a ${hop.toFixed(3)} m hop moved t by up to ${(worst * c.length).toFixed(3)} m `
    + 'off true — the query point is quantised to stations');
});

test('t is continuous across a station boundary', () => {
  const c = buildCenterline(SILVERSTONE_WAYPOINTS, 4000);
  const a = c.samples[2000];
  const b = c.samples[2001];
  // Just before and just after the midpoint, where the nearest station flips.
  const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
  const eps = 0.01;
  const before = c.query(mx - a.tx * eps, mz - a.tz * eps);
  const after = c.query(mx + a.tx * eps, mz + a.tz * eps);
  const jump = Math.abs(after.t - before.t) * c.length;
  assert.ok(jump < 0.1,
    `t jumped ${jump.toFixed(3)} m of road across the station boundary`);
});

test('halfWidth interpolates between stations rather than stepping', () => {
  const c = buildCenterline(SILVERSTONE_WAYPOINTS, 4000);
  // Find a pair of stations whose widths actually differ.
  let idx = -1;
  for (let i = 0; i < 3999; i++) {
    if (Math.abs(c.samples[i + 1].halfWidth - c.samples[i].halfWidth) > 1e-4) { idx = i; break; }
  }
  assert.ok(idx >= 0, 'no width transition to test');
  const a = c.samples[idx], b = c.samples[idx + 1];
  const mid = c.query((a.x + b.x) / 2, (a.z + b.z) / 2);
  const lo = Math.min(a.halfWidth, b.halfWidth);
  const hi = Math.max(a.halfWidth, b.halfWidth);
  assert.ok(mid.halfWidth > lo && mid.halfWidth < hi,
    `midpoint halfWidth ${mid.halfWidth} is not between ${lo} and ${hi}`);
});
