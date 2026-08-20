import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clamp01,
  clampRange,
  defaultRenderValues,
  DEFAULT_AO_BLEND,
  DEFAULT_REFLECTIVITY,
  RENDER_SLIDERS,
  sanitizeRenderValues,
} from './renderPanelState.js';
import {
  ENVIRONMENT_INTENSITY,
  HEMISPHERE_INTENSITY,
  RIM_INTENSITY,
  SHADOW_INTENSITY,
  SUN_INTENSITY,
  TONE_EXPOSURE,
} from './lightingBalance.js';

test('clampRange clamps and rejects non-finite', () => {
  assert.equal(clampRange(-1, 0, 1), 0);
  assert.equal(clampRange(2, 0, 1), 1);
  assert.equal(clampRange(0.4, 0, 1), 0.4);
  assert.equal(clampRange(NaN, 0, 1), 0);
  assert.equal(clamp01(1.5), 1);
});

test('defaultRenderValues follow lighting balance and backend fill', () => {
  const webgl = defaultRenderValues('webgl');
  const webgpu = defaultRenderValues('webgpu');

  assert.equal(webgl.toneExposure, TONE_EXPOSURE);
  assert.equal(webgl.envIntensity, ENVIRONMENT_INTENSITY);
  assert.equal(webgl.sunIntensity, SUN_INTENSITY);
  assert.equal(webgl.shadowIntensity, SHADOW_INTENSITY);
  assert.equal(webgl.reflectivity, DEFAULT_REFLECTIVITY);
  assert.equal(webgl.aoBlend, DEFAULT_AO_BLEND);
  assert.equal(webgl.hemiIntensity, HEMISPHERE_INTENSITY.webgl);
  assert.equal(webgpu.hemiIntensity, HEMISPHERE_INTENSITY.webgpu);
  assert.equal(webgl.rimIntensity, RIM_INTENSITY.webgl);
  assert.equal(webgpu.rimIntensity, RIM_INTENSITY.webgpu);
  assert.equal(webgl.ssao, false);
  assert.equal(webgl.bounce, true);
  assert.equal(webgl.csm, true);
  assert.equal(webgl.taa, false);
  assert.equal(webgl.grade, true);
});

test('sanitizeRenderValues clamps sliders and coerces FX flags', () => {
  const cleaned = sanitizeRenderValues({
    toneExposure: 99,
    envIntensity: -3,
    sunIntensity: 1.25,
    ssao: 1,
    bounce: 0,
    unknown: 'keep',
  });
  assert.equal(cleaned.toneExposure, RENDER_SLIDERS.toneExposure.max);
  assert.equal(cleaned.envIntensity, RENDER_SLIDERS.envIntensity.min);
  assert.equal(cleaned.sunIntensity, 1.25);
  assert.equal(cleaned.ssao, true);
  assert.equal(cleaned.bounce, false);
  assert.equal(cleaned.unknown, 'keep');
});
