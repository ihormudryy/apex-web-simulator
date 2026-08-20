/**
 * Wheel placement for the car mesh.
 *
 * Wheels are parented to `root` (yaw only) and anchored to the per-corner ground
 * samples the physics already uses. The body on `visualRoot` carries pitch/roll
 * plus a static rake offset so the authored mesh matches the 30/80 mm ride split.
 */

import { WB, LF, LR } from '../physics/constants.js';
import { WHEEL_X, WHEEL_Y } from '../physics/surface.js';
import { WHEEL_RADIUS } from '../physics/wheel.js';
import {
  CORNER_AX, CORNER_AY, RIDE_HEIGHT_FRONT, RIDE_HEIGHT_REAR,
} from '../physics/suspension.js';

/** FL, FR, RL, RR — same order as the physics surface samples. */
export const IS_FRONT = [true, true, false, false];

/**
 * Distance from the ground contact to the wheel object origin, m.
 * The authored Tyre.bin geometry has radius exactly 0.334 — the same as the
 * physics radius — so anything larger floats the tyres above the deck.
 */
export const TYRE_CONTACT_RADIUS = WHEEL_RADIUS;

/**
 * Where the authored mesh expects the wheel hubs, metres forward of the mesh
 * origin. From the original 2011 HelloRacer source, which placed the wheel
 * objects at x = 1.3928/1.4 (front) and x = -2 (rear) around this same mesh.
 */
export const AUTHORED_HUB_FORWARD = { front: 1.3964, rear: -2.0 };

/**
 * The authored half-track, m — the 2011 source put the wheels at z = ±0.69,
 * and the suspension mesh's wishbone tips only reach |x| ≈ 0.56, entering the
 * rims at this spacing. The physics half-track (0.8 m) is a handling decision
 * that stays in the kernel; drawing the wheels there instead left 11 cm of
 * daylight between every wheel and its suspension.
 */
export const AUTHORED_TRACK_HALF = 0.69;

/**
 * How far forward of the mesh origin the physics CoG sits, m.
 *
 * The physics splits the wheelbase LF/LR about the CoG, but the mesh origin is
 * not the CoG — the authored hubs sit 1.3964 m ahead of it and 2.0 m behind.
 * Drawing the body at the pose therefore put every wheel ~0.44 m ahead of its
 * wishbones. The body mesh is shifted forward by this much instead, so the
 * authored hubs land on the physics axles and the drawn tyres stay on the
 * physics contact patches (which the tyre marks and smoke already use).
 */
export const MESH_FORWARD_OFFSET =
  ((LF - AUTHORED_HUB_FORWARD.front) + (-LR - AUTHORED_HUB_FORWARD.rear)) / 2;

/** Static hub height above the chassis reference, m. */
export function hubBaseY(i) {
  const ride = IS_FRONT[i] ? RIDE_HEIGHT_FRONT : RIDE_HEIGHT_REAR;
  return WHEEL_RADIUS + ride;
}

/**
 * Nose-down pitch so level front/rear hub offsets both meet a flat plane.
 * Physics pitch is nose-up positive; this returns a negative angle (nose down).
 */
export function staticRakePitch() {
  return -Math.atan2(hubBaseY(2) - hubBaseY(0), WB);
}

/**
 * visualRoot attitude. Static rake is added to the sim pitch.
 *
 * visualRoot's Euler keeps rotation.y pinned at 90°, which puts the x and z
 * components in gimbal lock: Rx(x)·Ry(90°)·Rz(z) = Rx(x + z)·Ry(90°), a single
 * rotation about the world lateral axis — pitch. A POSITIVE angle raises the
 * nose (verified against three.js with the real root → visualRoot → body
 * chain), so the physics pitch (nose-up positive) passes through unnegated.
 * The old `-(pitch + rake)` drew the car nose-UP at rest with the diffuser
 * pressed into the track, and rendered braking dive as nose lift.
 *
 * Roll cannot be represented on this node at all — anything written to x just
 * adds to pitch — so x stays 0 until the attitude gets its own yaw-free node.
 */
export function chassisAttitudeRotation(pitch, roll) {
  return { x: 0, z: pitch + staticRakePitch() };
}

/**
 * Wheel hub position in `root` local space (yaw only — no pitch/roll).
 *
 * `root` already carries the yaw rotation, so these offsets are the plain
 * body-frame ones: -Z forward, +X right. Rotating them by yaw here as well
 * applied yaw twice — at the grid (yaw ≈ 159°) the front wheels rendered at
 * the rear of the car and the rears at the front.
 *
 * @param {number} i corner 0..3
 * @param {{ height: number }} surface sampled ground under this wheel
 * @param {number} chassisY world height of the chassis reference
 */
export function wheelRootPosition(i, surface, chassisY) {
  return {
    x: Math.sign(WHEEL_Y[i]) * AUTHORED_TRACK_HALF,
    y: surface.height + TYRE_CONTACT_RADIUS - chassisY,
    z: -WHEEL_X[i],
  };
}

/**
 * Live suspension offset along world vertical, for subtle compression visuals.
 * @param {{ zc: number, pitch: number, roll: number, zw: number[] }} susp
 * @param {number} i
 */
export function suspensionHubOffset(susp, i) {
  const zci = susp.zc
    + CORNER_AX[i] * susp.pitch
    + CORNER_AY[i] * susp.roll;
  return susp.zw[i] - zci;
}
