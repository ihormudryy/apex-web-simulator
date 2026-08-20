export const CAMERA_MODES = ['chase', 'driver', 'front'];

/** Chase and bumper cameras. Tight near keeps ribbon depth from fighting. */
export const CAMERA_NEAR = 0.25;

/** Helmet-cam: visor height, looking down the nose so the rim stays in frame. */
export const DRIVER_CAMERA = {
  alongFwd: 0.10,
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
