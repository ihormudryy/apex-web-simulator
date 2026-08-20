import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tileableGrassHeight, grassAlbedoFromHeight } from './grassMaps.js';
import { normalFromHeight, roughnessFromHeight } from './asphaltMaps.js';

test('grass albedo is green, not grey or neon', () => {
  const size = 32;
  const alb = grassAlbedoFromHeight(tileableGrassHeight(size, 1), size);
  let rSum = 0, gSum = 0, bSum = 0, n = 0;
  for (let i = 0; i < alb.length; i += 4) {
    rSum += alb[i]; gSum += alb[i + 1]; bSum += alb[i + 2];
    n++;
  }
  const r = rSum / n, g = gSum / n, b = bSum / n;
  assert.ok(g > r && g > b, `mean rgb ${r},${g},${b}`);
  assert.ok(g > 40 && g < 140, `green ${g}`);
});

test('grass normals point mostly up', () => {
  const size = 32;
  const nrm = normalFromHeight(tileableGrassHeight(size, 1), size, 1.6);
  const i = (16 * size + 16) * 4;
  assert.ok(nrm[i + 2] > 180, `normal Z packed ${nrm[i + 2]}`);
});

test('grass roughness stays high so the lawn is not wet plastic', () => {
  const rough = roughnessFromHeight(tileableGrassHeight(32, 1), 32);
  let min = 255, max = 0;
  for (let i = 0; i < rough.length; i += 4) {
    min = Math.min(min, rough[i]);
    max = Math.max(max, rough[i]);
  }
  assert.ok(min > 180 && max < 255, `roughness ${min}–${max}`);
});

test('grass albedo is a desaturated olive, not crushed to pure green', () => {
  // The test above only checks that green leads, which a hyper-saturated map
  // passes happily. This pins the ratios: red and blue must stay present, or
  // the lawn reads as astroturf. The map is used with a neutral material
  // colour, so what is measured here is what reaches the screen.
  const size = 32;
  const alb = grassAlbedoFromHeight(tileableGrassHeight(size, 1), size);
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < alb.length; i += 4) {
    r += alb[i]; g += alb[i + 1]; b += alb[i + 2]; n++;
  }
  r /= n; g /= n; b /= n;
  assert.ok(r / g > 0.55, `red too weak: r/g = ${(r / g).toFixed(2)} (mean ${r.toFixed(0)},${g.toFixed(0)},${b.toFixed(0)})`);
  assert.ok(b / g > 0.4, `blue too weak: b/g = ${(b / g).toFixed(2)}`);
  assert.ok(g / r < 2.0, `green runaway: g/r = ${(g / r).toFixed(2)}`);
});
