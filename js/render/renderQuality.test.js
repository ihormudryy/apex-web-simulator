import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  QUALITY_PRESETS, QUALITY_ORDER, nextQualityPreset, qualityPreset, OVERCAST_LIGHTING,
} from './renderQuality.js';

test('quality presets cover ultra/high/balanced', () => {
  assert.deepEqual(QUALITY_ORDER, ['ultra', 'high', 'balanced']);
  for (const id of QUALITY_ORDER) {
    assert.ok(QUALITY_PRESETS[id].renderScale > 0.5);
    assert.ok(QUALITY_PRESETS[id].label);
  }
});

test('nextQualityPreset cycles', () => {
  assert.equal(nextQualityPreset('ultra'), 'high');
  assert.equal(nextQualityPreset('high'), 'balanced');
  assert.equal(nextQualityPreset('balanced'), 'ultra');
});

test('overcast lighting is softer than hard sun defaults', () => {
  assert.ok(OVERCAST_LIGHTING.sunIntensity < 2.5);
  assert.ok(OVERCAST_LIGHTING.hemiIntensity.webgpu > 0.3);
  assert.equal(qualityPreset('nope').label, 'High');
});
