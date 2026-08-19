import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalFromHeight, roughnessFromNoise, metallicFromNoise,
  specularIntensityFromNoise, carbonWeaveNormal, tyreMicroNormalAndRoughness,
} from './carProceduralMaps.js';

test('orange-peel normal encodes a mostly-up normal (high Z)', () => {
  const { data, size } = normalFromHeight({ size: 64, strength: 0.9, seed: 1 });
  let sumZ = 0;
  for (let i = 0; i < data.length; i += 4) sumZ += data[i + 2];
  const meanZ = sumZ / (data.length / 4);
  assert.ok(meanZ > 170, `meanZ=${meanZ}`);
});

test('body roughness is a mid band, not all black/white', () => {
  const { data } = roughnessFromNoise({ size: 64, base: 0.32, variance: 0.08, seed: 2 });
  let min = 255, max = 0;
  for (let i = 0; i < data.length; i += 4) {
    min = Math.min(min, data[i]);
    max = Math.max(max, data[i]);
  }
  assert.ok(min > 40 && max < 240, `roughness ${min}..${max}`);
});

test('metallic variation stays small for a paint dielectric', () => {
  const { data } = metallicFromNoise({ size: 64, base: 0.0, variance: 0.015, seed: 3 });
  let max = 0;
  for (let i = 0; i < data.length; i += 4) max = Math.max(max, data[i]);
  // 0.06 maps to 153
  assert.ok(max < 170, `max metallic channel ${max}`);
});

test('carbon weave normal has some variation', () => {
  const { data } = carbonWeaveNormal({ size: 64, strength: 1.1, seed: 4, weaveFreq: 10 });
  let minZ = 255, maxZ = 0;
  for (let i = 0; i < data.length; i += 4) {
    minZ = Math.min(minZ, data[i + 2]);
    maxZ = Math.max(maxZ, data[i + 2]);
  }
  assert.ok(maxZ - minZ > 12, `z variation ${minZ}..${maxZ}`);
});

test('tyre maps: normal Z high and roughness mid', () => {
  const { normal, roughness } = tyreMicroNormalAndRoughness({ size: 64, seed: 6 });
  let sumZ = 0;
  for (let i = 0; i < normal.data.length; i += 4) sumZ += normal.data[i + 2];
  const meanZ = sumZ / (normal.data.length / 4);
  assert.ok(meanZ > 150, `meanZ=${meanZ}`);

  let min = 255, max = 0;
  for (let i = 0; i < roughness.data.length; i += 4) {
    min = Math.min(min, roughness.data[i]);
    max = Math.max(max, roughness.data[i]);
  }
  // Roughness should be high so tyres read matte, not chrome.
  assert.ok(min > 140 && max < 255, `roughness ${min}..${max}`);
});

/** Spread of one channel, 0 when the channel carries no variation. */
function channelSpread(data, offset) {
  let min = 255, max = 0;
  for (let i = offset; i < data.length; i += 4) {
    min = Math.min(min, data[i]);
    max = Math.max(max, data[i]);
  }
  return max - min;
}

test('specular intensity varies in ALPHA, the only channel three reads', () => {
  // three: `specularIntensityFactor *= texture2D( specularIntensityMap, uv ).a`.
  // Writing the variation to RGB and leaving alpha at 255 makes the map inert —
  // it allocates a texture and multiplies specular by 1.0 everywhere. That
  // shipped once; this test is why it cannot ship again.
  const { data } = specularIntensityFromNoise({ size: 64, base: 0.55, variance: 0.1, seed: 16 });
  assert.ok(channelSpread(data, 3) > 8,
    `alpha carries no variation (spread ${channelSpread(data, 3)}) — the map is inert`);

  // And it must stay inside a plausible dielectric range once sampled.
  let min = 255, max = 0;
  for (let i = 3; i < data.length; i += 4) {
    min = Math.min(min, data[i]);
    max = Math.max(max, data[i]);
  }
  assert.ok(min / 255 > 0.2 && max / 255 < 1.0,
    `specular multiplier ${(min / 255).toFixed(2)}..${(max / 255).toFixed(2)} out of range`);
});

test('greyscale maps fill every channel, so any read channel works', () => {
  // roughnessMap is read from .g and metalnessMap from .b. These generators are
  // greyscale, which is what makes them correct regardless — worth pinning, since
  // the specular map's channel bug was exactly this assumption going unchecked.
  for (const [name, made] of [
    ['roughness', roughnessFromNoise({ size: 64 })],
    ['metallic', metallicFromNoise({ size: 64, variance: 0.05 })],
  ]) {
    const r = channelSpread(made.data, 0);
    assert.ok(r > 0, `${name} has no variation at all`);
    assert.equal(channelSpread(made.data, 1), r, `${name}: green differs from red`);
    assert.equal(channelSpread(made.data, 2), r, `${name}: blue differs from red`);
  }
});
