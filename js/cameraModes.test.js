import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CAMERA_MODES, DRIVER_CAMERA, nextCameraMode, clampChaseZoom, adjustChaseZoom, CHASE_ZOOM } from './cameraModes.js';

test('C cycles rear chase → driver → front bumper → rear', () => {
  assert.deepEqual(CAMERA_MODES, ['chase', 'driver', 'front', 'finish']);
  assert.equal(nextCameraMode('chase'), 'driver');
  assert.equal(nextCameraMode('driver'), 'front');
  assert.equal(nextCameraMode('front'), 'finish');
  assert.equal(nextCameraMode('finish'), 'chase');
});

// Steering hub after the car's two +90° Y wraps and the body's forward shift:
// 0.5054 + MESH_FORWARD_OFFSET (0.4375) m forward, 0.593 m up.
const WHEEL = { alongFwd: 0.9429, height: 0.5933 };

function pitch(fromFwd, fromY, toFwd, toY) {
  return Math.atan2(toY - fromY, toFwd - fromFwd);
}

test('driver camera keeps the steering wheel inside the vertical FOV', () => {
  const c = DRIVER_CAMERA;
  const look = pitch(c.alongFwd, c.height, c.lookAhead, c.lookY);
  const wheel = pitch(c.alongFwd, c.height, WHEEL.alongFwd, WHEEL.height);
  const halfFov = (c.fov * Math.PI / 180) / 2;
  assert.ok(Math.abs(wheel - look) < halfFov * 0.8,
    `wheel is ${((wheel - look) * 180 / Math.PI).toFixed(1)}° from look, FOV half is ${(halfFov * 180 / Math.PI).toFixed(1)}°`);
  assert.ok(c.near <= 0.06, 'cockpit surfaces sit well inside a 0.25 m clip plane');
  assert.ok(WHEEL.alongFwd - c.alongFwd > c.near,
    'wheel must sit in front of the near clip plane');
});

test('chase zoom clamps and steps', () => {
  assert.equal(clampChaseZoom(1), CHASE_ZOOM.min);
  assert.equal(clampChaseZoom(40), CHASE_ZOOM.max);
  assert.equal(adjustChaseZoom(5, -CHASE_ZOOM.step), 5 - CHASE_ZOOM.step);
  assert.equal(adjustChaseZoom(2, -1), CHASE_ZOOM.min);
});
