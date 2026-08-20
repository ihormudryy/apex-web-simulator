import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TRACKSIDE_BANDS, distanceToSphere, densityForDistance, instanceCountFor,
  interleaveForThinning,
} from './lodBands.js';

test('distance is measured to the nearest surface, not the centre', () => {
  // The case that broke the first version: a lap-spanning mesh whose centre is a
  // kilometre away but whose geometry reaches the car.
  const d = distanceToSphere(937.7, 1.6, -377.6, 0, 0, 0, 1200);
  assert.equal(d, 0, `lap-spanning geometry reported ${d.toFixed(1)} m away`);
  // A compact chunk reports its real distance.
  const chunk = distanceToSphere(0, 0, 0, 200, 0, 0, 49);
  assert.ok(Math.abs(chunk - 151) < 0.5, `expected ~151 m, got ${chunk}`);
});

test('geometry that reaches the camera always draws at full detail', () => {
  for (const bands of Object.values(TRACKSIDE_BANDS)) {
    assert.equal(densityForDistance(0, bands), 1);
  }
});

test('density falls off with distance and reaches zero past the cut-off', () => {
  const bands = [60, 180, 420];
  assert.equal(densityForDistance(10, bands), 1);
  assert.equal(densityForDistance(100, bands), 0.5);
  assert.equal(densityForDistance(300, bands), 0.25);
  assert.equal(densityForDistance(420, bands), 0);
  assert.equal(densityForDistance(5000, bands), 0);
});

test('density is monotonically non-increasing', () => {
  const bands = [60, 180, 420];
  let prev = Infinity;
  for (let d = 0; d <= 600; d += 5) {
    const v = densityForDistance(d, bands);
    assert.ok(v <= prev, `density rose at ${d} m: ${prev} -> ${v}`);
    prev = v;
  }
});

test('instance counts scale with density but never blink a live set to nothing', () => {
  const bands = [60, 180, 420];
  assert.equal(instanceCountFor(362, 10, bands), 362);
  assert.equal(instanceCountFor(362, 100, bands), 181);
  assert.equal(instanceCountFor(362, 300, bands), 91);
  assert.equal(instanceCountFor(362, 500, bands), 0);
  // A two-instance set inside the cut-off keeps at least one.
  assert.equal(instanceCountFor(2, 300, bands), 1);
  assert.equal(instanceCountFor(1, 300, bands), 1);
});

test('bands are ordered and sane', () => {
  for (const [name, bands] of Object.entries(TRACKSIDE_BANDS)) {
    const [full, half, cut] = bands;
    assert.ok(full > 0 && full < half && half < cut, `${name}: ${bands}`);
    assert.ok(cut <= 1400, `${name} cut-off ${cut} m is beyond fog.far`);
  }
});

test('a thinned prefix still covers the whole chunk', () => {
  // Placements arrive in station order. Drawing a prefix of them is exactly what
  // lowering `InstancedMesh.count` does, so an unshuffled prefix would render the
  // first few metres at full density and leave the rest of the chunk bare.
  const items = Array.from({ length: 400 }, (_, i) => ({ x: i / 4 }));   // 0..100 m
  const mixed = interleaveForThinning(items, 3);
  const half = mixed.slice(0, 200).map(o => o.x);
  const mean = half.reduce((a, b) => a + b, 0) / half.length;
  assert.ok(Math.abs(mean - 50) < 6, `prefix centred at ${mean.toFixed(1)} m, not ~50`);
  assert.ok(Math.min(...half) < 8, `prefix starts at ${Math.min(...half)} m`);
  assert.ok(Math.max(...half) > 92, `prefix ends at ${Math.max(...half)} m`);
  // Every eighth of the chunk keeps roughly its share.
  for (let b = 0; b < 8; b++) {
    const n = half.filter(x => x >= b * 12.5 && x < (b + 1) * 12.5).length;
    assert.ok(n >= 10, `band ${b} of the thinned prefix has only ${n} of ~25`);
  }
});

test('the interleave is a deterministic permutation', () => {
  const items = Array.from({ length: 50 }, (_, i) => i);
  const a = interleaveForThinning(items, 9);
  const b = interleaveForThinning(items, 9);
  assert.deepEqual(a, b, 'same seed must give the same order');
  assert.notDeepEqual(a, items, 'expected a reordering');
  assert.deepEqual([...a].sort((x, y) => x - y), items, 'must be a permutation');
  assert.notDeepEqual(interleaveForThinning(items, 10), a, 'seed should matter');
});
