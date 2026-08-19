import { test } from 'node:test';
import assert from 'node:assert/strict';
import { directionFromEquirectUV, sunDirectionFromEquirect } from './equirect.js';

test('equirect UV matches Three.js equirectUv inverse', () => {
  // Three: u = atan2(z,x)/(2π)+0.5, v = asin(y)/π+0.5
  const zenith = directionFromEquirectUV(0.5, 1);
  assert.ok(Math.abs(zenith.y - 1) < 1e-9);
  assert.ok(Math.hypot(zenith.x, zenith.z) < 1e-6);

  const horizonPosX = directionFromEquirectUV(0.5, 0.5);
  assert.ok(Math.abs(horizonPosX.y) < 1e-9);
  assert.ok(Math.abs(horizonPosX.x - 1) < 1e-6);
  assert.ok(Math.abs(horizonPosX.z) < 1e-6);
});

test('sun direction is the brightest sky pixel, not the ground', () => {
  // 4×2 RGBA8: top row is sky (v→1 after flip), bottom is a brighter ground.
  // A single white pixel at (u,v) ≈ (0.375, 0.75) must win.
  const width = 4, height = 2, channels = 4;
  const data = new Float32Array(width * height * channels);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 0.05; data[i + 1] = 0.05; data[i + 2] = 0.08; data[i + 3] = 1;
  }
  // Ground row (row 1 if row 0 is zenith in file / top of image): very bright.
  const ground = (1 * width + 0) * 4;
  data[ground] = 80; data[ground + 1] = 80; data[ground + 2] = 80;
  // Sky sun at column 1 of the zenith-side row.
  const sun = (0 * width + 1) * 4;
  data[sun] = 12; data[sun + 1] = 11; data[sun + 2] = 9;

  const dir = sunDirectionFromEquirect(data, width, height, { channels, rowZero: 'zenith' });
  const expected = directionFromEquirectUV((1 + 0.5) / width, 1 - (0 + 0.5) / height);
  assert.ok(Math.abs(dir.x - expected.x) < 1e-9, `x ${dir.x} vs ${expected.x}`);
  assert.ok(Math.abs(dir.y - expected.y) < 1e-9, `y ${dir.y} vs ${expected.y}`);
  assert.ok(Math.abs(dir.z - expected.z) < 1e-9, `z ${dir.z} vs ${expected.z}`);
  assert.ok(dir.y > 0.2, 'sun stays above the horizon');
});
