import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineWearAlbedo, lineWearRoughness } from './lineWearMaps.js';

test('line wear albedo stays off-white with visible variation', () => {
  const alb = lineWearAlbedo(256, 16, 1);
  let min = 255, max = 0;
  for (let i = 0; i < alb.length; i += 4) {
    min = Math.min(min, alb[i]);
    max = Math.max(max, alb[i]);
  }
  assert.ok(min >= 90 && max <= 250, `albedo range ${min}–${max}`);
  assert.ok(max - min > 20, 'wear should modulate the stripe');
});

test('line wear roughness stays in a matte band', () => {
  const rough = lineWearRoughness(256, 16, 1);
  let min = 255, max = 0;
  for (let i = 0; i < rough.length; i += 4) {
    min = Math.min(min, rough[i]);
    max = Math.max(max, rough[i]);
  }
  assert.ok(min > 140 && max < 255, `roughness ${min}–${max}`);
});
