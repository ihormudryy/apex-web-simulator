import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ribbonTileUV } from './ribbonUV.js';

test('metre UVs tile along the lap and across the road width', () => {
  const uv = ribbonTileUV({
    alongMetres: 16,
    left: 6,
    right: -6,
    tileMetres: 8,
  });
  assert.equal(uv.u0, 2);
  assert.equal(uv.u1, 2);
  assert.equal(uv.v0, 0.75);
  assert.equal(uv.v1, -0.75);
});

test('normalized UVs stay 0–1 around the lap with V across the strip', () => {
  const uv = ribbonTileUV({
    station: 10,
    stationCount: 40,
    mode: 'normalized',
  });
  assert.equal(uv.u0, 0.25);
  assert.equal(uv.u1, 0.25);
  assert.equal(uv.v0, 0);
  assert.equal(uv.v1, 1);
});
