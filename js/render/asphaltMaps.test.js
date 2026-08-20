import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tileableHeight, albedoFromHeight, normalFromHeight, roughnessFromHeight } from './asphaltMaps.js';

test('asphalt normals point mostly up', () => {
  const size = 32;
  const height = tileableHeight(size, 1);
  const nrm = normalFromHeight(height, size, 4);
  const i = (16 * size + 16) * 4;
  assert.ok(nrm[i + 2] > 180, `normal Z packed ${nrm[i + 2]}`);
});

test('asphalt albedo is a dark grey, not black or white', () => {
  const size = 32;
  const height = tileableHeight(size, 1);
  const alb = albedoFromHeight(height, size);
  let min = 255, max = 0, sum = 0, n = 0;
  for (let i = 0; i < alb.length; i += 4) {
    min = Math.min(min, alb[i]);
    max = Math.max(max, alb[i]);
    sum += alb[i];
    n++;
  }
  const mean = sum / n;
  // Dry tarmac sits at 80–110 sRGB, but that band is where the *mean* belongs.
  // Individual aggregate stones scatter either side of it by design; requiring
  // every pixel inside the band is what forced a single flat grey ramp, where
  // every particle had the same colour. The floor still catches the original
  // defect, which was a mean near 52.
  assert.ok(mean >= 80 && mean <= 110, `mean albedo ${mean.toFixed(1)}`);
  assert.ok(min >= 58 && max <= 134, `albedo range ${min}–${max} beyond plausible aggregate`);
  assert.ok(max - min > 20, 'expected visible per-stone variation, not one grey ramp');
});

test('roughness stays in a mid-grey band so the tarmac is not a mirror', () => {
  const size = 32;
  const rough = roughnessFromHeight(tileableHeight(size, 1), size);
  let min = 255, max = 0;
  for (let i = 0; i < rough.length; i += 4) {
    min = Math.min(min, rough[i]);
    max = Math.max(max, rough[i]);
  }
  assert.ok(min > 180 && max < 255, `roughness ${min}–${max}`);
});
