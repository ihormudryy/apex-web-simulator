import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enableCarParticleSystems, particleDrawBackend } from './carParticleBackend.js';

test('WebGL keeps ShaderMaterial particle Points', () => {
  assert.equal(enableCarParticleSystems('webgl'), true);
  assert.equal(particleDrawBackend('webgl'), 'points');
});

test('WebGPU enables instanced Sprite particles', () => {
  assert.equal(enableCarParticleSystems('webgpu'), true);
  assert.equal(particleDrawBackend('webgpu'), 'sprite');
});

test('unknown backends stay off', () => {
  assert.equal(enableCarParticleSystems('metal'), false);
});
