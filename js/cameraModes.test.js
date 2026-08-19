import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CAMERA_MODES, nextCameraMode } from './cameraModes.js';

test('C cycles rear chase → driver → front bumper → rear', () => {
  assert.deepEqual(CAMERA_MODES, ['chase', 'driver', 'front']);
  assert.equal(nextCameraMode('chase'), 'driver');
  assert.equal(nextCameraMode('driver'), 'front');
  assert.equal(nextCameraMode('front'), 'chase');
});
