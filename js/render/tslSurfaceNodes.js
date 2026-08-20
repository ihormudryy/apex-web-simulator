/**
 * TSL node graphs for the two effects that `onBeforeCompile` cannot deliver on
 * the WebGPU path.
 *
 * `NodeMaterial` never runs `onBeforeCompile`, so the GLSL string injections in
 * `Track.js` and `grassTufts.js` are silently inert under `?renderer=webgpu` —
 * the asphalt kept only its aggregate and the grass stood still. These factories
 * build the same two effects as node graphs instead.
 *
 * This module statically imports `three/tsl`, which pulls in the WebGPU build, so
 * it must only ever be reached by dynamic import on the WebGPU path. The WebGL
 * path must not load it.
 *
 * The shared half of the work is not duplicated: the asphalt profile still comes
 * from the same unit-tested `asphaltSurface.js` map, and the tuft geometry from
 * the same `tuftGeometry.js`. Only the few lines that sample and combine differ.
 */
import * as THREE from 'three';
import {
  attribute, texture, materialColor, materialRoughness,
  float, vec2, vec3, mix, sin, cos, clamp, uniform, positionLocal, time,
} from 'three/tsl';

/**
 * Asphalt with lap-scale variation: racing line, marbles, patches, seams.
 *
 * @param {object} params constructor parameters shared with the WebGL material
 * @param {THREE.Texture} surfaceTexture map from `asphaltSurfaceMap`
 * @param {{albedoMin:number, albedoSpan:number, roughMin:number, roughSpan:number}} range
 */
export function createAsphaltNodeMaterial(params, surfaceTexture, range) {
  const material = new THREE.MeshStandardNodeMaterial(params);
  const surf = texture(surfaceTexture, attribute('aSurfaceUv', 'vec2'));

  // `materialColor` is the material's own albedo — colour times `map`, with the
  // map's colour space already applied — so overriding `colorNode` keeps the
  // aggregate detail instead of replacing it with a flat tint.
  const albedoMul = float(range.albedoMin).add(surf.r.mul(float(range.albedoSpan)));
  // Rubber is cool-neutral, so where it has built up it takes the warm cast off
  // the aggregate rather than only darkening it.
  //
  // This started life as a desaturation toward the albedo's own luminance, which
  // was two mistakes at once. It could never do anything — asphalt albedo is
  // already near-neutral, so pulling it toward its own luminance is a no-op — and
  // `materialColor` is a **vec4**, so `dot( materialColor, vec3(...) )` folded the
  // alpha into the sum and returned roughly 1.7x the true luminance. The result
  // was a racing line 19% *brighter* than the track edges. `luminance()` has the
  // same problem on a vec4; `.rgb` first is the fix if a luminance is ever wanted.
  const rubberTint = mix(vec3(1.0), vec3(0.93, 0.97, 1.05), surf.b);
  material.colorNode = materialColor.mul(albedoMul).mul(rubberTint);

  material.roughnessNode = materialRoughness.mul(
    float(range.roughMin).add(surf.g.mul(float(range.roughSpan))),
  );
  return material;
}

/**
 * Grass tufts that sway.
 *
 * The per-instance yaw arrives as an instanced attribute rather than being read
 * back out of `instanceMatrix`, because TSL exposes no instance-matrix node —
 * and it makes both backends run the same arithmetic from the same data.
 *
 * @param {object} params constructor parameters shared with the WebGL material
 * @param {{tuftHeight:number, windDir:THREE.Vector3, windAmp:number}} wind
 */
export function createTuftNodeMaterial(params, wind) {
  const material = new THREE.MeshStandardNodeMaterial(params);

  // `time` is driven by the renderer itself. The WebGL path advances its own
  // uniform from `mesh.onBeforeRender`, which is never called here — the value
  // sat at 0 for every frame and the grass stood perfectly still while looking
  // completely correct from the JS side.
  const uTime = time;
  const uWindDir = uniform(wind.windDir);
  const uWindAmp = uniform(wind.windAmp);

  const yaw = attribute('aTuftYaw', 'float');
  const pos = positionLocal;
  // Sway grows with height so the roots stay planted.
  const h = clamp(pos.y.div(float(wind.tuftHeight)), 0, 1);
  const phase = attribute('aTuftPhase', 'float');
  const sway = sin(uTime.mul(1.55).add(phase)).mul(0.62)
    .add(sin(uTime.mul(3.10).add(phase.mul(1.7))).mul(0.38));

  // World wind rotated into instance space: local = transpose(Ry(yaw)) * world.
  const c = cos(yaw);
  const s = sin(yaw);
  const wx = uWindDir.x.mul(c).sub(uWindDir.z.mul(s));
  const wz = uWindDir.x.mul(s).add(uWindDir.z.mul(c));

  const offset = vec2(wx, wz).mul(sway).mul(h).mul(h).mul(uWindAmp);
  material.positionNode = vec3(pos.x.add(offset.x), pos.y, pos.z.add(offset.y));

  // `isTsl` tells the caller not to drive uTime by hand: `time` belongs to the
  // renderer, and writing to it would fight whatever the renderer sets.
  material.userData.windUniforms = { uTime, uWindDir, uWindAmp, isTsl: true };
  return material;
}
