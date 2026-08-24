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
  uv, dot,
} from 'three/tsl';

/**
 * Asphalt with lap-scale variation: racing line, marbles, patches, seams, and
 * optional session tyre marks (same channels as the WebGL inject).
 *
 * @param {object} params constructor parameters shared with the WebGL material
 * @param {THREE.Texture} surfaceTexture map from `asphaltSurfaceMap`
 * @param {{albedoMin:number, albedoSpan:number, roughMin:number, roughSpan:number}} range
 * @param {{ tyreMarks?: THREE.Texture | null }} [opts]
 */
export function createAsphaltNodeMaterial(params, surfaceTexture, range, opts = {}) {
  const material = new THREE.MeshStandardNodeMaterial(params);
  const surfUv = attribute('aSurfaceUv', 'vec2');
  const surf = texture(surfaceTexture, surfUv);

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

  // Macro octave — the same trick as the WebGL inject in Track.js: a second
  // read of the detail map at nine times the scale. The photoscanned tile is
  // pristine tarmac, featureless above ~0.3 m, so its own low-frequency
  // unevenness (0.0136 measured mean linear luminance), gained up, supplies
  // the worked-in patchiness of a used circuit and breaks the 2 m tiling.
  const macroTexel = texture(params.map, uv().mul(float(0.111)));
  const macroDev = dot(macroTexel.rgb, vec3(0.2126, 0.7152, 0.0722))
    .div(float(0.0136)).sub(float(1.0));
  const macroMul = clamp(macroDev.mul(float(3.5)).add(float(1.0)), 0.72, 1.35);

  // Dynamic rubber from this session. A 1×1 black placeholder keeps the sampler
  // valid before the car binds its mark buffer; `uHasTyreMarks` zeros the effect.
  //
  // This is `texture( tex )` and not `texture( uniform( tex ) )`. TSL's
  // `texture()` demands an actual THREE.Texture and throws NodeError on a
  // UniformNode ("expects a valid instance of THREE.Texture"), which killed the
  // whole `colorNode` graph — and a MeshStandardNodeMaterial with a dead
  // colorNode draws pure black, so the entire circuit rendered as a black void
  // on the WebGPU path while grass, kerbs and barriers looked fine. Rebinding
  // still works identically: a TextureNode carries `.value` just as a
  // UniformNode does, which is all `setTyreMarkTexture` assigns to.
  const emptyMarks = emptyMarkTexture();
  const uTyreMarks = texture(opts.tyreMarks ?? emptyMarks, surfUv);
  const uHasTyreMarks = uniform(opts.tyreMarks ? 1 : 0);
  material.userData.asphaltMarkUniforms = { uTyreMarks, uHasTyreMarks, emptyMarks };

  const marks = uTyreMarks.r.mul(uHasTyreMarks);
  const markTint = mix(vec3(1.0), vec3(0.28, 0.29, 0.32), marks);

  material.colorNode = materialColor.mul(albedoMul).mul(rubberTint).mul(macroMul).mul(markTint);

  // Brighter macro patches are worn, polished asphalt: lighter AND smoother,
  // so the sun response varies with the mottling.
  const macroRough = clamp(float(1.0).sub(macroDev.mul(float(1.8))), 0.85, 1.12);
  const markRough = mix(float(1.0), float(0.72), marks);
  material.roughnessNode = materialRoughness.mul(
    float(range.roughMin).add(surf.g.mul(float(range.roughSpan))),
  ).mul(macroRough).mul(markRough);
  return material;
}

let _emptyMarkTexture = null;
function emptyMarkTexture() {
  if (_emptyMarkTexture) return _emptyMarkTexture;
  const data = new Uint8Array([0, 0, 0, 255]);
  _emptyMarkTexture = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
  _emptyMarkTexture.needsUpdate = true;
  return _emptyMarkTexture;
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
