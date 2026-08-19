import { test } from 'node:test';
import assert from 'node:assert/strict';
import { directionFromEquirectUV, sunDirectionFromEquirect } from './equirect.js';
import { outdoorSkyData, DEFAULT_SUN_U, DEFAULT_SUN_V } from './outdoorSky.js';

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
