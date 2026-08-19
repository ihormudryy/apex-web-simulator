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
  let min = 255, max = 0;
  for (let i = 0; i < alb.length; i += 4) {
    min = Math.min(min, alb[i]);
    max = Math.max(max, alb[i]);
  }
  assert.ok(min > 20 && max < 90, `albedo range ${min}–${max}`);
  assert.ok(max - min > 8, 'some grain');
});

test('roughness stays in a mid-grey band so the tarmac is not a mirror', () => {
  const size = 32;
  const rough = roughnessFromHeight(tileableHeight(size, 1), size);
  let min = 255, max = 0;
  for (let i = 0; i < rough.length; i += 4) {
    min = Math.min(min, rough[i]);
    max = Math.max(max, rough[i]);
  }
  assert.ok(min > 90 && max < 230, `roughness ${min}–${max}`);
});
