// js/race/racingLine.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRacingLine, lineCurvatureTotal, CORRIDOR_MARGIN } from './racingLine.js';
import { buildCenterline } from '../track/centerline.js';
import { SILVERSTONE_WAYPOINTS } from '../track/silverstoneWaypoints.js';

const cl = buildCenterline(SILVERSTONE_WAYPOINTS, 4000);

test('every point of the line stays inside the track corridor', () => {
  const line = buildRacingLine(cl.samples);
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
  const line = buildRacingLine(cl.samples);
  const flat = buildRacingLine(cl.samples, { iterations: 0 });
  assert.ok(lineCurvatureTotal(line) < lineCurvatureTotal(flat) * 0.92,
    'relaxation did not reduce squared curvature by at least 8%');
});

test('peak curvature is lower than the centerline it came from', () => {
  // Peak curvature is the physically meaningful number: it sets the minimum
  // corner speed, which is what a racing line is actually for.
  const line = buildRacingLine(cl.samples);
  const flat = buildRacingLine(cl.samples, { iterations: 0 });
  const peak = (arr) => arr.reduce((m, v) => Math.max(m, v), 0);
  assert.ok(peak(line.curvature) < peak(flat.curvature) * 0.92,
    'relaxation did not reduce peak curvature by at least 8%');
});

test('the line cuts an apex rather than just smoothing', () => {
  // Through a corner, a racing line runs wide, crosses to the inside, then runs
  // wide again — so the offset changes sign at least twice over the lap.
  const line = buildRacingLine(cl.samples);
  let flips = 0;
  for (let i = 1; i < line.offset.length; i++) {
    if (Math.sign(line.offset[i]) !== 0
      && Math.sign(line.offset[i]) !== Math.sign(line.offset[i - 1])) flips++;
  }
  assert.ok(flips >= 8, `only ${flips} offset sign changes — the line is not cutting apexes`);
});

test('the same centerline always yields the same line', () => {
  const a = buildRacingLine(cl.samples);
  const b = buildRacingLine(cl.samples);
  for (let i = 0; i < a.offset.length; i++) assert.equal(a.offset[i], b.offset[i]);
});

test('the speed limit is lower in the corners than on the straights', () => {
  const line = buildRacingLine(cl.samples);
  let tightest = Infinity, loosest = 0;
  for (let i = 0; i < line.speed.length; i++) {
    tightest = Math.min(tightest, line.speed[i]);
    loosest = Math.max(loosest, line.speed[i]);
  }
  assert.ok(tightest < 40, `slowest point allows ${tightest.toFixed(1)} m/s — no corner is slow`);
  assert.ok(loosest > 70, `fastest point allows only ${loosest.toFixed(1)} m/s`);
});
