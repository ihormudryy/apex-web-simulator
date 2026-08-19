/**
 * Pose a directional light so its orthographic shadow frustum is a square
 * around the car, not the whole 6 km circuit.
 *
 * `sun` points toward the sun (same convention as `sunDirectionFromEquirect`).
 * The light sits `distance` metres that way from the car.
 */
export function localShadowLightPose(target, sun, { distance = 80, radius = 40 } = {}) {
  const len = Math.hypot(sun.x, sun.y, sun.z) || 1;
  const sx = sun.x / len, sy = sun.y / len, sz = sun.z / len;
  const pad = 10;
  return {
    light: {
      x: target.x + sx * distance,
      y: target.y + sy * distance,
      z: target.z + sz * distance,
    },
    target: { x: target.x, y: target.y, z: target.z },
    left: -radius,
    right: radius,
    top: radius,
    bottom: -radius,
    near: Math.max(0.5, distance - radius - pad),
    far: distance + radius + pad,
  };
}

export function applyLocalShadowPose(light, pose) {
  light.position.set(pose.light.x, pose.light.y, pose.light.z);
  light.target.position.set(pose.target.x, pose.target.y, pose.target.z);
  light.target.updateMatrixWorld();
  const cam = light.shadow.camera;
  cam.left = pose.left;
  cam.right = pose.right;
  cam.top = pose.top;
  cam.bottom = pose.bottom;
  cam.near = pose.near;
  cam.far = pose.far;
  cam.updateProjectionMatrix();
}
