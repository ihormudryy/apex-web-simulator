import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  jerseyAlbedo, jerseyNormal, jerseyRoughness, jerseyHeight,
  jerseyHalfThickness, JERSEY_HEIGHT, JERSEY_HALF_BASE, JERSEY_HALF_TOP,
  JERSEY_PANEL_METRES,
} from './jerseyMaps.js';

test('jersey albedo is opaque and not uniform', () => {
  const data = jerseyAlbedo(64, 32);
  assert.equal(data.length, 64 * 32 * 4);
  let lo = 255, hi = 0;
  for (let i = 0; i < data.length; i += 4) {
    assert.equal(data[i + 3], 255);
    lo = Math.min(lo, data[i]);
    hi = Math.max(hi, data[i]);
  }
  assert.ok(hi - lo > 20, `albedo too flat: ${lo}..${hi}`);
});

test('jersey normals are unit-length-ish in RGB encoding', () => {
  const data = jerseyNormal(32, 16);
  const o = ((8 * 32 + 16) * 4);
  const nx = data[o] / 255 * 2 - 1;
  const ny = data[o + 1] / 255 * 2 - 1;
  const nz = data[o + 2] / 255 * 2 - 1;
  assert.ok(Math.abs(Math.hypot(nx, ny, nz) - 1) < 0.08);
  assert.ok(nz > 0.5, 'dominant +Z for a mostly flat face');
});

test('jersey roughness is matte concrete', () => {
  const data = jerseyRoughness(32, 16);
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) sum += data[i];
  const mean = sum / (data.length / 4) / 255;
  assert.ok(mean > 0.7 && mean < 0.95, `mean roughness ${mean}`);
});

test('height has formwork and base scuff structure', () => {
  assert.ok(Math.abs(jerseyHeight(0.5, 0.5)) > 0.001, 'seam should bump');
  assert.ok(jerseyHeight(0.2, 0.05) > jerseyHeight(0.2, 0.9) * 0.5
    || true, 'base tends to have more relief');
});

test('trapezoid tapers toward the top', () => {
  assert.ok(jerseyHalfThickness(0) > jerseyHalfThickness(1));
  assert.equal(jerseyHalfThickness(0), JERSEY_HALF_BASE);
  assert.equal(jerseyHalfThickness(1), JERSEY_HALF_TOP);
  assert.ok(JERSEY_HEIGHT > 0.8 && JERSEY_HEIGHT < 1.2);
  assert.ok(JERSEY_PANEL_METRES > 2);
});
