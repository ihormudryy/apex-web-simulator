export const CAMERA_MODES = ['chase', 'driver', 'front'];

export function nextCameraMode(current) {
  const i = CAMERA_MODES.indexOf(current);
  return CAMERA_MODES[(Math.max(i, 0) + 1) % CAMERA_MODES.length];
}
