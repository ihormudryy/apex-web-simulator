export const CAMERA_MODES = ['chase', 'driver', 'front'];

/** Chase and bumper cameras. Tight near keeps ribbon depth from fighting. */
export const CAMERA_NEAR = 0.25;

/** Rear chase zoom limits and keyboard step, metres. */
export const CHASE_ZOOM = {
  min: 2,
  max: 30,
  step: 0.6,
};

/** @param {number} radius */
export function clampChaseZoom(radius) {
  return Math.min(CHASE_ZOOM.max, Math.max(CHASE_ZOOM.min, radius));
}

/** @param {number} radius @param {number} delta negative zooms in */
export function adjustChaseZoom(radius, delta) {
  return clampChaseZoom(radius + delta);
}

/**
 * Helmet-cam: visor height, looking down the nose so the rim stays in frame.
 * alongFwd tracks the driver's authored seat, which sits MESH_FORWARD_OFFSET
 * (0.4375 m) ahead of the pose now that the body meets its wheels.
 */
export const DRIVER_CAMERA = {
  alongFwd: 0.54,
  height: 0.74,
  lookAhead: 5.5,
  lookY: 0.32,
  fov: 72,
  // Cockpit bodywork sits ~5–20 cm from the visor. 0.25 m was slicing it.
  near: 0.05,
};

export function nextCameraMode(current) {
  const i = CAMERA_MODES.indexOf(current);
  return CAMERA_MODES[(Math.max(i, 0) + 1) % CAMERA_MODES.length];
}
