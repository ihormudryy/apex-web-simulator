import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LUMINANCE_FLOOR, sampleMeanLuminance, allSamplesAboveFloor,
} from './luminance.js';
import { albedoFromHeight, tileableHeight } from './asphaltMaps.js';

test('procedural asphalt albedo sits in the dry-tarmac band', () => {
  const size = 64;
  const alb = albedoFromHeight(tileableHeight(size, 1), size);
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
  assert.ok(min >= 58 && max <= 134, `albedo ${min}–${max}`);
});

test('luminance floor rejects a black frame', () => {
  const w = 4, h = 4;
  const rgba = new Uint8Array(w * h * 4);
  assert.ok(!allSamplesAboveFloor(rgba, w, h, [[0.5, 0.5]], LUMINANCE_FLOOR));
});

test('luminance floor accepts a lit ground sample', () => {
  const w = 4, h = 4;
  const rgba = new Uint8Array(w * h * 4).fill(100);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  assert.ok(allSamplesAboveFloor(rgba, w, h, [[0.5, 0.5]], LUMINANCE_FLOOR));
  assert.ok(sampleMeanLuminance(rgba, w, h, [[0.5, 0.5]]) > 90);
});
