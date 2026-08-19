/** Directional sun for cascaded shadows. `sunDir` points toward the sun. */
export function setSunLightDirection(sunLight, sunDir, distance = 400) {
  sunLight.position.copy(sunDir).multiplyScalar(distance);
  sunLight.target.position.set(0, 0, 0);
  sunLight.target.updateMatrixWorld();
}
