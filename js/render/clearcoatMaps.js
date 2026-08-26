/**
 * Whether MeshPhysicalMaterial can take DataTexture clearcoat maps.
 *
 * On WebGPU those maps (clearcoatNormalMap / clearcoatRoughnessMap) make the
 * draw disappear — the bundled Apex GT1 body vanished and left floating tyres
 * and a grey tub. Numeric `clearcoat` / `clearcoatRoughness` still work.
 *
 * @param {'webgl' | 'webgpu' | string | undefined} backend
 * @returns {boolean}
 */
export function canUseClearcoatMaps(backend) {
  return backend !== 'webgpu';
}
