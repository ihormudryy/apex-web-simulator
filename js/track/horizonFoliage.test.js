import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planHorizonBillboards } from './horizonPlan.js';
import { buildCenterline } from './centerline.js';
import { SILVERSTONE_WAYPOINTS } from './silverstoneWaypoints.js';

function fakeCenterline(length = 5900, n = 400) {
  const samples = [];
  const r = length / (2 * Math.PI);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    samples.push({
      x: Math.cos(a) * r,
      z: Math.sin(a) * r,
      tx: -Math.sin(a),
      tz: Math.cos(a),
      nx: Math.cos(a),
      nz: Math.sin(a),
      halfWidth: 7,
      runoff: 12,
    });
  }
  return { samples, length };
}

test('horizon plan places near trees, far trees and stands', () => {
  const plan = planHorizonBillboards(fakeCenterline());
  const near = plan.filter(p => p.kind === 'treeNear');
  const far = plan.filter(p => p.kind === 'treeFar');
  const stands = plan.filter(p => p.kind === 'stand');
  assert.ok(near.length > 100, `only ${near.length} near trees`);
  assert.ok(far.length > 50, `only ${far.length} far trees`);
  assert.ok(stands.length >= 20, `only ${stands.length} stands`);
});

test('far trees sit farther from the road than near trees', () => {
  const cl = fakeCenterline();
  const plan = planHorizonBillboards(cl);
  const distToRoad = (p) => {
    let best = Infinity;
    for (const s of cl.samples) {
      const d = Math.hypot(p.x - s.x, p.z - s.z) - s.halfWidth;
      if (d < best) best = d;
    }
    return best;
  };
  const near = plan.filter(p => p.kind === 'treeNear');
  const far = plan.filter(p => p.kind === 'treeFar');
  const nearMean = near.reduce((s, p) => s + distToRoad(p), 0) / near.length;
  const farMean = far.reduce((s, p) => s + distToRoad(p), 0) / far.length;
  assert.ok(farMean > nearMean + 40,
    `far ring not farther: near ${nearMean.toFixed(0)} far ${farMean.toFixed(0)}`);
});

test('empty centerline yields no billboards', () => {
  assert.deepEqual(planHorizonBillboards({ samples: [], length: 0 }), []);
});

test('placement is deterministic for a given seed', () => {
  const cl = fakeCenterline();
  const a = planHorizonBillboards(cl, { seed: 7 });
  const b = planHorizonBillboards(cl, { seed: 7 });
  assert.equal(a.length, b.length);
  assert.ok(Math.abs(a[0].x - b[0].x) < 1e-9);
  const c = planHorizonBillboards(cl, { seed: 99 });
  assert.ok(Math.abs(a[0].x - c[0].x) > 0.01 || Math.abs(a[0].z - c[0].z) > 0.01);
});

test('no billboard lands near ANY part of a circuit that folds back on itself', () => {
  // On the real, surveyed Silverstone — not `fakeCenterline`, which is a circle.
  // That distinction is the whole test: offsetting laterally from a station is
  // always safe on a convex ring, so a circular fixture cannot express this bug,
  // and it shipped. Silverstone's infield runs back alongside its own straights,
  // so a tree pushed 42-88 m off one station lands on another: the worst
  // measured 0.8 m from the racing line, with 18 inside 20 m, drawn as 5.5x9.5 m
  // unbillboarded cards looming over the track as translucent grey wedges.
  const centerline = buildCenterline(SILVERSTONE_WAYPOINTS, 2000);
  const plan = planHorizonBillboards(centerline);
  assert.ok(plan.length > 250, `only ${plan.length} billboards survived the clearance test`);

  let worst = { d: Infinity };
  for (const p of plan) {
    for (const s of centerline.samples) {
      const d = Math.hypot(p.x - s.x, p.z - s.z);
      if (d < worst.d) worst = { d, kind: p.kind, x: p.x, z: p.z };
    }
  }
  // The planner's own floor is nearMin = 42 m; allow a metre of sampling slack.
  assert.ok(worst.d > 39,
    `a ${worst.kind} sits ${worst.d.toFixed(1)} m from the circuit at `
    + `${worst.x.toFixed(0)},${worst.z.toFixed(0)} — it will loom over the track`);
});
