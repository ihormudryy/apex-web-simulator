/**
 * Whether to build the smoke / spark / haze `Points` systems.
 *
 * Those systems use classic `ShaderMaterial` soft sprites. WebGPU's NodeBuilder
 * rejects `ShaderMaterial`, and WebGPU point primitives are also capped at 1 px,
 * so the WebGPU path keeps tyre marks (and brake glow) but skips the Points.
 *
 * Free of three.js so the decision can be unit-tested under Node.
 *
 * @param {'webgl' | 'webgpu'} backend
 */
export function enableCarParticleSystems(backend) {
  return backend !== 'webgpu';
}
