import { test } from 'node:test';
import assert from 'node:assert/strict';
import { directionFromEquirectUV, sunDirectionFromEquirect } from './equirect.js';
import { outdoorSkyData, DEFAULT_SUN_U, DEFAULT_SUN_V } from './outdoorSky.js';

test('sky fill stays display-referred so ACES does not wash the scene', () => {
  // The map is both background and IBL. A ×4 sky plus a wide corona made the
  // whole hemisphere several nits too hot, so every StandardMaterial read as
  // overexposed even before the directional sun.
  const { data, width, height, sunU, sunV } = outdoorSkyData({
    width: 128,
    height: 64,
  });
  let sum = 0, n = 0, hot = 0;
  for (let y = 0; y < height; y++) {
    const v = 1 - (y + 0.5) / height;
    if (v <= 0.5) continue;
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const du = Math.min(Math.abs(u - sunU), 1 - Math.abs(u - sunU));
      const dv = v - sunV;
      if (du * du + dv * dv < 0.05 * 0.05) continue;
      const i = (y * width + x) * 4;
      const lum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      sum += lum;
      n++;
      if (lum > 8) hot++;
    }
  }
  const mean = sum / n;
  assert.ok(mean > 0.15 && mean < 1.6, `sky fill luminance ${mean}`);
  assert.ok(hot / n < 0.02, `hot sky fraction ${hot / n}`);
});

test('generated outdoor sky puts the sun where sunDirectionFromEquirect finds it', () => {
  const { data, width, height } = outdoorSkyData({
    width: 64,
    height: 32,
    sunU: DEFAULT_SUN_U,
    sunV: DEFAULT_SUN_V,
  });
  const dir = sunDirectionFromEquirect(data, width, height, { channels: 4, rowZero: 'zenith' });
  const expected = directionFromEquirectUV(DEFAULT_SUN_U, DEFAULT_SUN_V);
  const dot = dir.x * expected.x + dir.y * expected.y + dir.z * expected.z;
  assert.ok(dot > 0.98, `sun alignment dot ${dot}`);
  assert.ok(dir.y > 0.3);
});
