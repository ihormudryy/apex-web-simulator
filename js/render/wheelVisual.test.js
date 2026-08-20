import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WHEEL_RADIUS } from '../physics/wheel.js';
import { WB, LF, LR } from '../physics/constants.js';
import { WHEEL_X, WHEEL_Y } from '../physics/surface.js';
import { RIDE_HEIGHT_FRONT, RIDE_HEIGHT_REAR } from '../physics/suspension.js';
import {
  hubBaseY, chassisAttitudeRotation, staticRakePitch,
  wheelRootPosition, suspensionHubOffset, TYRE_CONTACT_RADIUS, IS_FRONT,
  AUTHORED_HUB_FORWARD, MESH_FORWARD_OFFSET,
} from './wheelVisual.js';

test('front hubs sit lower than rear hubs for static rake', () => {
  assert.ok(IS_FRONT[0] && IS_FRONT[1] && !IS_FRONT[2] && !IS_FRONT[3]);
  assert.ok(hubBaseY(0) < hubBaseY(2));
  assert.equal(hubBaseY(0), WHEEL_RADIUS + RIDE_HEIGHT_FRONT);
  assert.equal(hubBaseY(3), WHEEL_RADIUS + RIDE_HEIGHT_REAR);
  assert.ok((hubBaseY(3) - hubBaseY(0)) > 0.04, 'rear rake is ~50 mm');
});

test('static rake pitch is a small nose-down angle', () => {
  const p = staticRakePitch();
  assert.ok(p < 0, 'nose-down is negative in the physics convention');
  assert.ok(Math.abs(p) < 0.05, `${(p * 180 / Math.PI).toFixed(2)}° is plausible`);
});

test('wheelRootPosition puts hubs on the sampled ground', () => {
  const chassisY = 1.2;
  const surface = { height: 1.05 };
  const p = wheelRootPosition(0, surface, chassisY);
  assert.ok(Math.abs((chassisY + p.y) - (surface.height + TYRE_CONTACT_RADIUS)) < 1e-9);
});

test('wheelRootPosition is root-local: body-frame offsets, no yaw', () => {
  // Wheels are children of `root`, which already carries the yaw rotation.
  // Rotating the offsets here too applied yaw twice — at the grid (yaw ≈ 159°)
  // the front wheels rendered at the rear of the car and vice versa.
  const surface = { height: 0 };
  for (let i = 0; i < 4; i++) {
    const p = wheelRootPosition(i, surface, 0);
    assert.ok(Math.abs(p.x - WHEEL_Y[i]) < 1e-9, `corner ${i}: local x is the lateral offset`);
    assert.ok(Math.abs(p.z - -WHEEL_X[i]) < 1e-9, `corner ${i}: local -z is forward`);
  }
  const front = wheelRootPosition(0, surface, 0);
  const rear = wheelRootPosition(2, surface, 0);
  assert.ok(front.z < 0 && rear.z > 0, 'front hubs ahead of the origin, rear behind');
  assert.ok(Math.abs((-front.z + rear.z) - WB) < 1e-9, 'hubs span the wheelbase');
});

test('suspensionHubOffset tracks corner compression', () => {
  const susp = {
    zc: 0,
    pitch: 0,
    roll: 0,
    zw: [0.01, 0.01, -0.02, -0.02],
  };
  assert.equal(suspensionHubOffset(susp, 0), 0.01);
  assert.equal(suspensionHubOffset(susp, 2), -0.02);
});

test('chassisAttitudeRotation includes static rake at rest', () => {
  // The visualRoot Euler collapses to one rotation about the lateral axis
  // (rotation.y is pinned at 90°), and a POSITIVE angle there raises the nose —
  // verified against three.js directly. Nose-down rake is therefore negative,
  // matching the physics pitch convention unchanged.
  const att = chassisAttitudeRotation(0, 0);
  assert.ok(Math.abs(att.x) < 1e-9, 'x must stay zero — it adds to pitch, not roll');
  assert.ok(att.z < 0, 'nose-down rake is a negative Z rotation on visualRoot');
  assert.ok(Math.abs(att.z - staticRakePitch()) < 1e-9);
});

test('braking dive renders nose-down', () => {
  // Physics pitch is nose-up positive, so braking pitch is negative, and the
  // rendered angle must go more negative (nose drops) — not less.
  const rest = chassisAttitudeRotation(0, 0).z;
  const braking = chassisAttitudeRotation(-0.02, 0).z;
  assert.ok(braking < rest, 'braking must lower the nose below the static rake');
});

test('authored mesh hubs land on the physics axles once the body is shifted', () => {
  // The mesh origin is not the CoG: the 2011 source placed the front wheels
  // 1.3964 m ahead of it and the rears 2.0 m behind, while the physics splits
  // the wheelbase LF/LR about the CoG. MESH_FORWARD_OFFSET closes that gap.
  assert.ok(MESH_FORWARD_OFFSET > 0.4 && MESH_FORWARD_OFFSET < 0.48);
  assert.ok(Math.abs((AUTHORED_HUB_FORWARD.front + MESH_FORWARD_OFFSET) - LF) < 0.002,
    'front hubs meet the front axle within 2 mm');
  assert.ok(Math.abs((AUTHORED_HUB_FORWARD.rear + MESH_FORWARD_OFFSET) - -LR) < 0.002,
    'rear hubs meet the rear axle within 2 mm');
});

test('ground-anchored hubs sit one tyre radius above the road', () => {
  const chassisY = 0;
  const ground = 0;
  const hubFront = wheelRootPosition(0, { height: ground }, chassisY).y + chassisY;
  const hubRear = wheelRootPosition(2, { height: ground }, chassisY).y + chassisY;
  assert.ok(Math.abs(hubFront - TYRE_CONTACT_RADIUS - ground) < 1e-6);
  assert.ok(Math.abs(hubRear - TYRE_CONTACT_RADIUS - ground) < 1e-6);
});
