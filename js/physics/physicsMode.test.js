import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyGripScale,
  physicsPreset,
  readStoredPhysicsMode,
  resolvePhysicsMode,
  writeStoredPhysicsMode,
} from './physicsMode.js';

test('resolvePhysicsMode prefers URL over storage', () => {
  assert.equal(resolvePhysicsMode('?physics=sim', 'arcade'), 'sim');
  assert.equal(resolvePhysicsMode('', 'sim'), 'sim');
  assert.equal(resolvePhysicsMode('', null), 'arcade');
});

test('physics presets differ on aids and warm start', () => {
  assert.equal(physicsPreset('sim').aids, false);
  assert.equal(physicsPreset('sim').warm, false);
  assert.equal(physicsPreset('arcade').aids, true);
  assert.equal(physicsPreset('arcade').warm, true);
});

test('applyGripScale multiplies tyre mu scales', () => {
  const tune = { muScaleFront: 1, muScaleRear: 1 };
  applyGripScale(tune, 'arcade');
  assert.ok(tune.muScaleFront > 1);
  assert.equal(tune.muScaleFront, tune.muScaleRear);
});

test('stored physics preference round-trips', () => {
  const storage = { _m: {}, getItem(k) { return this._m[k] ?? null; }, setItem(k, v) { this._m[k] = v; } };
  writeStoredPhysicsMode('sim', storage);
  assert.equal(readStoredPhysicsMode(storage), 'sim');
});
