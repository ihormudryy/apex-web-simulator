import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCenterline } from './centerline.js';
import { planGrassTufts, planCatchFence, planMarshalPosts, planDistanceBoards, planTyreStacks } from './tracksidePlacements.js';
import { SILVERSTONE_WAYPOINTS } from './silverstoneWaypoints.js';

const square = [
  { x: 0, z: 0, halfWidth: 6, runoff: 8 },
  { x: 120, z: 0, halfWidth: 6, runoff: 8 },
  { x: 120, z: 80, halfWidth: 6, runoff: 8 },
  { x: 0, z: 80, halfWidth: 6, runoff: 8 },
];

test('grass tufts stay off the tarmac and inside the runoff band', () => {
  const cl = buildCenterline(square, 400);
  const tufts = planGrassTufts(cl.samples, cl.length, { maxCount: 500 });
  assert.ok(tufts.length > 40, `expected scatter, got ${tufts.length}`);
  for (const t of tufts) {
    assert.ok(t.lateral > t.halfWidth + 0.2, `tuft on asphalt at lateral ${t.lateral}`);
    const maxLat = t.halfWidth + t.runoff + 1.5 + 0.35;
    assert.ok(t.lateral <= maxLat + 0.01, `tuft too far out at ${t.lateral} > ${maxLat}`);
  }
});

test('catch fence panels sit outside the Armco wall', () => {
  const cl = buildCenterline(square, 200);
  const panels = planCatchFence(cl.samples, cl.length, { panelWidth: 10 });
  assert.ok(panels.length >= 8);
  for (const p of panels) {
    const dist = Math.hypot(p.x - p.lookX, p.z - p.lookZ);
    assert.ok(dist > p.wallLimit + 0.4, `panel inside wall at ${dist.toFixed(2)} m`);
    assert.ok(dist < p.wallLimit + 1.2, `panel too far out at ${dist.toFixed(2)} m`);
  }
});

test('Silverstone scatter stays within a sane budget', () => {
  const cl = buildCenterline(SILVERSTONE_WAYPOINTS, 4000);
  const tufts = planGrassTufts(cl.samples, cl.length);
  const fence = planCatchFence(cl.samples, cl.length);
  // The ceiling is a lap-wide total, not a per-frame one: `createGrassTufts`
  // splits these across chunked InstancedMeshes so frustum culling submits only
  // the few in view. A verge dense enough to read as grass needs tens of
  // thousands; the old 14 000 cap was a sparse scatter.
  assert.ok(tufts.length > 20000 && tufts.length <= 60000, `tuft count ${tufts.length}`);
  assert.ok(fence.length > 800 && fence.length < 5000, `fence panels ${fence.length}`);
});

test('tufts start outside the kerb, not on it', () => {
  // The kerb ribbon occupies halfWidth .. halfWidth + KERB_WIDTH (1.0 m). Tufts
  // planted at +0.35 m grew straight out of the red and white blocks.
  const cl = buildCenterline(SILVERSTONE_WAYPOINTS, 2000);
  for (const t of planGrassTufts(cl.samples, cl.length)) {
    assert.ok(t.lateral - t.halfWidth >= 1.25 - 1e-9,
      `tuft only ${(t.lateral - t.halfWidth).toFixed(3)} m off the racing surface`);
  }
});

test('the kerb inset is caller-supplied so Track owns KERB_WIDTH', () => {
  const cl = buildCenterline(square, 400);
  for (const t of planGrassTufts(cl.samples, cl.length, { edgeInset: 4 })) {
    assert.ok(t.lateral - t.halfWidth >= 4 - 1e-9, `inset ignored: ${t.lateral - t.halfWidth}`);
  }
});

test('tufts are jittered along the lap, not parked on stations', () => {
  // Placing every tuft exactly on a centerline sample draws transverse stripes
  // down the verge. Distances to the nearest station must not all be ~zero.
  const cl = buildCenterline(square, 400);
  const tufts = planGrassTufts(cl.samples, cl.length, { maxCount: 4000 });
  const offsets = tufts.map(t => {
    let best = Infinity;
    for (const s of cl.samples) best = Math.min(best, Math.hypot(t.x - s.x, t.z - s.z));
    return best;
  });
  const spread = Math.max(...offsets) - Math.min(...offsets);
  assert.ok(spread > 0.3, `no along-track jitter: spread only ${spread.toFixed(3)} m`);
});

// Density must fall off with distance from the asphalt — the whole point of the
// scatter, per `planGrassTufts`'s own docstring. The bounds tests above pass
// happily with the gradient inverted, which is exactly what had happened: the
// keep-threshold used `(1 - falloff)` where `falloff` is already ~1 at the kerb
// and ~0 at the far edge, so it thinned the verge and crowded the far runoff.
//
// Two metrics, because they answer different questions. Absolute metres is what
// the eye sees, but it is only meaningful where the runoff width is constant —
// around Silverstone the runoff varies enough that wide sections push even
// kerb-hugging tufts into far metre-bands. So the lap is checked in normalised
// band position, which is what the algorithm actually controls.
function bandCounts(tufts, key) {
  const bands = new Array(10).fill(0);
  for (const t of tufts) {
    const frac = key === 'norm'
      ? (t.lateral - t.halfWidth) / (t.runoff + 1.5)
      : (t.lateral - t.halfWidth) / 10;
    const b = Math.floor(Math.max(0, Math.min(0.999, frac)) * 10);
    bands[b]++;
  }
  return bands;
}

function assertFallsOff(bands, label) {
  const near = bands[0] + bands[1] + bands[2];
  const far = bands[7] + bands[8] + bands[9];
  assert.ok(near > far * 1.5,
    `${label}: density not falling off — ${near} in the inner three bands vs ` +
    `${far} in the outer three (want inner > 1.5x outer). Bands: ${bands.join(',')}`);
}

test('tuft density is highest at the kerb and thins outward (constant width)', () => {
  // Constant halfWidth/runoff, so absolute metres and normalised position agree
  // and the metric means exactly what it looks like.
  const cl = buildCenterline(square, 800);
  const tufts = planGrassTufts(cl.samples, cl.length, { maxCount: 20000 });
  assertFallsOff(bandCounts(tufts, 'abs'), 'square circuit, absolute metres');
});

test('tuft density thins outward around the whole lap', () => {
  const cl = buildCenterline(SILVERSTONE_WAYPOINTS, 4000);
  const tufts = planGrassTufts(cl.samples, cl.length);
  assertFallsOff(bandCounts(tufts, 'norm'), 'Silverstone, normalised band');
});

test('marshal posts sit just outside the catch fence line', () => {
  const cl = buildCenterline(square, 400);
  const posts = planMarshalPosts(cl.samples, cl.length, { spacing: 40, seed: 1 });
  assert.ok(posts.length >= 4);
  for (const p of posts) {
    const dist = Math.hypot(p.x - p.lookX, p.z - p.lookZ);
    assert.ok(dist > 12, `post too close at ${dist.toFixed(2)} m`);
  }
});

test('distance boards mark round hundreds on the outer wall', () => {
  const cl = buildCenterline(square, 400);
  const boards = planDistanceBoards(cl.samples, cl.length, { spacing: 100 });
  assert.ok(boards.length >= 3);
  for (const b of boards) {
    assert.equal(b.labelM % 100, 0);
    assert.ok(b.labelM > 0 && b.labelM <= cl.length);
  }
});

test('tyre stacks cluster on curved sections', () => {
  const cl = buildCenterline(SILVERSTONE_WAYPOINTS, 2000);
  const stacks = planTyreStacks(cl.samples, cl.length, { maxStacks: 60 });
  assert.ok(stacks.length >= 8 && stacks.length <= 60, `stack count ${stacks.length}`);
  for (const s of stacks) {
    assert.ok(s.tiers >= 2 && s.tiers <= 3);
  }
});
