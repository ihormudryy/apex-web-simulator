/**
 * Whether to build the smoke / spark / haze particle systems.
 *
 * WebGL uses classic `ShaderMaterial` Points. WebGPU uses instanced Sprites with
 * `PointsNodeMaterial` (point primitives are 1 px only). Both backends run the
 * same CPU ring in `particleRing.js`.
 *
 * @param {'webgl' | 'webgpu'} backend
 */
export function enableCarParticleSystems(backend) {
  return backend === 'webgl' || backend === 'webgpu';
}

/** Draw path for sized soft particles on a given backend. */
export function particleDrawBackend(backend) {
  return backend === 'webgpu' ? 'sprite' : 'points';
}
