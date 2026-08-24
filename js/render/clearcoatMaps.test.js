import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canUseClearcoatMaps } from './clearcoatMaps.js';

test('WebGPU cannot bind DataTextures as clearcoat maps', () => {
  assert.equal(canUseClearcoatMaps('webgpu'), false);
});

test('WebGL keeps the authored clearcoat maps', () => {
  assert.equal(canUseClearcoatMaps('webgl'), true);
  assert.equal(canUseClearcoatMaps(undefined), true);
});
