/**
 * Shared outdoor lighting numbers. WebGPU washes more easily (CSMShadowNode +
 * IBL + hemisphere), so its fill sits lower and its sun/shadow punch harder.
 */

export const SUN_INTENSITY = 3.0;
export const SHADOW_INTENSITY = 0.92;
export const SUN_DISTANCE = 400;

/** Hemisphere fill — lower on WebGPU so the sun can cast a readable shadow. */
export const HEMISPHERE_INTENSITY = {
  webgl: 0.40,
  webgpu: 0.18,
};

export const RIM_INTENSITY = {
  webgl: 0.35,
  webgpu: 0.18,
};

export const ENVIRONMENT_INTENSITY = 0.85;
export const TONE_EXPOSURE = 0.92;

/**
 * Keep a directional sun anchored on the camera/car so CSM cascades stay useful.
 * `sunDir` points toward the sun; the light sits along that ray and aims at the
 * anchor, so rays stay parallel to `-sunDir`.
 *
 * @param {{ position: { copy: Function, addScaledVector?: Function }, target: { position: { copy: Function }, updateMatrixWorld: Function } }} sunLight
 * @param {{ x: number, y: number, z: number }} sunDir unit vector toward the sun
 * @param {{ x: number, y: number, z: number }} anchor world point under the view
 * @param {number} [distance]
 */
export function followDirectionalSun(sunLight, sunDir, anchor, distance = SUN_DISTANCE) {
  sunLight.target.position.copy(anchor);
  sunLight.position.copy(anchor);
  if (typeof sunLight.position.addScaledVector === 'function') {
    sunLight.position.addScaledVector(sunDir, distance);
  } else {
    sunLight.position.x += sunDir.x * distance;
    sunLight.position.y += sunDir.y * distance;
    sunLight.position.z += sunDir.z * distance;
  }
  sunLight.target.updateMatrixWorld();
}
