// js/race/racingLine.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRacingLine, lineCurvatureTotal, nearestOnLine, CORRIDOR_MARGIN } from './racingLine.js';
import { buildCenterline } from '../track/centerline.js';
import { SILVERSTONE_WAYPOINTS } from '../track/silverstoneWaypoints.js';

const cl = buildCenterline(SILVERSTONE_WAYPOINTS, 4000);
// Built once and shared: buildRacingLine runs 60,000 sweeps and every test
// below except the determinism check is reading, not re-deriving, that
// same result.
const line = buildRacingLine(cl.samples);
const flat = buildRacingLine(cl.samples, { iterations: 0 });

test('every point of the line stays inside the track corridor', () => {
  for (let i = 0; i < cl.samples.length; i++) {
    const limit = Math.max(0, cl.samples[i].halfWidth - CORRIDOR_MARGIN);
    assert.ok(Math.abs(line.offset[i]) <= limit + 1e-9,
      `station ${i}: offset ${line.offset[i].toFixed(3)} exceeds corridor ${limit.toFixed(3)}`);
  }
});

test('the line reduces squared curvature vs. the centerline it came from', () => {
  // Raw |curvature| summed over the lap is close to a topological invariant
  // (Fenchel's theorem: total turning of a closed loop doesn't depend on the
  // path through the corridor) and an apex-cutting line is shorter, which
  // shrinks ds and inflates that sum further — see racingLine.js for the
  // measurements. Sum of SQUARED curvature does not have that problem: it
  // rewards trading many small-radius stations for fewer, gentler ones.
  assert.ok(lineCurvatureTotal(line) < lineCurvatureTotal(flat) * 0.92,
    'relaxation did not reduce squared curvature by at least 8%');
});

test('peak curvature is lower than the centerline it came from', () => {
  // Peak curvature is the physically meaningful number: it sets the minimum
  // corner speed, which is what a racing line is actually for.
  const peak = (arr) => arr.reduce((m, v) => Math.max(m, v), 0);
  assert.ok(peak(line.curvature) < peak(flat.curvature) * 0.92,
    'relaxation did not reduce peak curvature by at least 8%');
});

test('mean lateral offset stays small — the expected outcome on this geometry', () => {
  // Small is not a shortfall here (see racingLine.js, "WHAT THIS ACTUALLY
  // BUYS"): on this circuit the corridor (~5 m) is narrow relative to corner
  // radii (20-200 m), so a curvature-minimizing line has little geometric
  // room to re-route and mostly smooths in place rather than visibly cutting
  // apexes — and the lap-time estimate shows that smoothing alone is worth
  // 10.3 s/lap, while the visibly apex-cutting alternative that was measured
  // came out slower. If a future change to the algorithm makes the line
  // start using much more of the road, this assertion will fail — that is
  // the point: it should send whoever changed it back to the module header
  // to re-check the lap-time trade-off, not just update a comment.
  let sum = 0;
  for (let i = 0; i < line.offset.length; i++) sum += Math.abs(line.offset[i]);
  const mean = sum / line.offset.length;
  assert.ok(mean < 0.5,
    `mean |offset| ${mean.toFixed(3)} m — geometry or algorithm changed; re-check the lap-time trade-off in racingLine.js`);
});

test('the same centerline always yields the same line', () => {
  const a = buildRacingLine(cl.samples);
  const b = buildRacingLine(cl.samples);
  for (let i = 0; i < a.offset.length; i++) assert.equal(a.offset[i], b.offset[i]);
});

test('the speed limit is lower in the corners than on the straights', () => {
  let tightest = Infinity, loosest = 0;
  for (let i = 0; i < line.speed.length; i++) {
    tightest = Math.min(tightest, line.speed[i]);
    loosest = Math.max(loosest, line.speed[i]);
  }
  assert.ok(tightest < 40, `slowest point allows ${tightest.toFixed(1)} m/s — no corner is slow`);
  assert.ok(loosest > 70, `fastest point allows only ${loosest.toFixed(1)} m/s`);
});

function bruteNearest(line, qx, qz) {
  let best = 0, bestD2 = Infinity;
  for (let i = 0; i < line.x.length; i++) {
    const dx = line.x[i] - qx, dz = line.z[i] - qz;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2) { bestD2 = d2; best = i; }
  }
  return best;
}

test('nearestOnLine finds a point exactly on the line', () => {
  for (const i of [0, 137, 900, 2001, 3999]) {
    const found = nearestOnLine(line, line.x[i], line.z[i], i);
    assert.equal(found, i, `station ${i}: query exactly on the line returned ${found}`);
  }
});

test('nearestOnLine still finds the true nearest station when the hint is stale', () => {
  const n = line.x.length;
  for (const i of [50, 800, 1500, 2600, 3500]) {
    const staleHint = (i + 700) % n; // several hundred stations off
    const found = nearestOnLine(line, line.x[i], line.z[i], staleHint);
    assert.equal(found, i,
      `station ${i}: stale hint ${staleHint} led to ${found} instead of the true nearest`);
  }
});

test('nearestOnLine matches a brute-force global scan', () => {
  const n = line.x.length;
  // A spread of query points: on-line stations offset laterally, and a few
  // points well off the racing surface entirely.
  for (const i of [10, 623, 1290, 2044, 2977, 3610]) {
    const qx = line.x[i] + 3 * cl.samples[i].nx;
    const qz = line.z[i] + 3 * cl.samples[i].nz;
    const hint = (i + 5000) % n; // arbitrary, uncorrelated with i
    const got = nearestOnLine(line, qx, qz, hint);
    const want = bruteNearest(line, qx, qz);
    assert.equal(got, want, `query near station ${i}: got ${got}, brute force says ${want}`);
  }
});
