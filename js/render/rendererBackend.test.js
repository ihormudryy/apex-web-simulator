import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRendererMode } from './rendererBackend.js';

test('parseRendererMode defaults to webgl', () => {
  assert.equal(parseRendererMode(''), 'webgl');
  assert.equal(parseRendererMode('?foo=bar'), 'webgl');
});

test('parseRendererMode selects webgpu from the URL flag', () => {
  assert.equal(parseRendererMode('?renderer=webgpu'), 'webgpu');
  assert.equal(parseRendererMode('?renderer=webgl'), 'webgl');
});
