import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enableCarParticleSystems } from './carParticleBackend.js';

test('WebGL keeps ShaderMaterial particle Points', () => {
  assert.equal(enableCarParticleSystems('webgl'), true);
});

test('WebGPU skips ShaderMaterial particle Points', () => {
  // NodeBuilder rejects ShaderMaterial; WebGPU points are also 1px-only.
  assert.equal(enableCarParticleSystems('webgpu'), false);
});
