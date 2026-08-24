/**
 * WebGPU smoke / spark / haze sprites.
 *
 * WebGPU point primitives are 1 px only, so sized soft particles must be
 * instanced sprites with `PointsNodeMaterial` (see three.js webgpu_instance_points).
 * CPU integration stays in `particleRing.js`; this module only wraps GPU draw.
 */

import * as THREE from 'three';
import {
  float, instancedBufferAttribute, shapeCircle, uniform, uv, vec2,
  length, smoothstep, mix, fract, sin, dot, viewportLinearDepth, linearDepth,
} from 'three/tsl';
import { createRing, createBudget } from './particleRing.js';
import { SOFT_PARTICLE_METRES } from './smokeLook.js';

/** Cheap hash for soft smoke mottling in TSL. */
function hash2(p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453));
}

/**
 * Soft volumetric disc: dense core + soft rim + noise (not a hard circle).
 * @param {*} seedNode per-particle seed attribute
 */
function softSmokeOpacity(seedNode) {
  const coord = uv().sub(0.5);
  const r = length(coord);
  const core = smoothstep(float(0.28), float(0), r);
  const mid = smoothstep(float(0.48), float(0.12), r);
  const rim = smoothstep(float(0.5), float(0.22), r);
  const n = hash2(uv().mul(28).add(seedNode.mul(17)));
  const n2 = hash2(uv().yx.mul(51).sub(seedNode.mul(9)));
  const mottled = mix(float(0.72), float(1.18), n).mul(mix(float(0.85), float(1.1), n2));
  const falloff = core.mul(0.5).add(mid.mul(0.35)).add(rim.mul(0.18)).mul(mottled);
  return falloff.mul(falloff);
}

/**
 * @param {object} opts same shape as the WebGL `createParticleSystem` options
 */
export function createWebGpuParticleSystem({
  count, size, color, opacity, gravity, drag, blending, attenuate = true,
  envelope = 'linear', expand = 1, soft = false,
}) {
  const ring = createRing({ count, gravity, drag, envelope, expand });

  const positionAttr = new THREE.InstancedBufferAttribute(ring.positions, 3);
  const sizeAttr = new THREE.InstancedBufferAttribute(ring.sizes, 1);
  const alphaAttr = new THREE.InstancedBufferAttribute(ring.alphas, 1);
  const seedAttr = new THREE.InstancedBufferAttribute(ring.seeds, 1);
  positionAttr.setUsage(THREE.DynamicDrawUsage);
  sizeAttr.setUsage(THREE.DynamicDrawUsage);
  alphaAttr.setUsage(THREE.DynamicDrawUsage);
  seedAttr.setUsage(THREE.DynamicDrawUsage);

  const uScale = uniform(size);
  const uOpacity = uniform(opacity);
  const uSoftness = uniform(soft ? SOFT_PARTICLE_METRES : 0);
  const sizeNode = uScale.mul(instancedBufferAttribute(sizeAttr));
  const seedNode = instancedBufferAttribute(seedAttr);
  const depthFade = soft
    ? smoothstep(float(0), uSoftness, viewportLinearDepth.sub(linearDepth()))
    : float(1);
  const alphaNode = soft
    ? uOpacity.mul(instancedBufferAttribute(alphaAttr)).mul(softSmokeOpacity(seedNode)).mul(depthFade)
    : uOpacity.mul(instancedBufferAttribute(alphaAttr)).mul(shapeCircle());

  const material = new THREE.PointsNodeMaterial({
    color: new THREE.Color(color),
    positionNode: instancedBufferAttribute(positionAttr),
    sizeNode,
    opacityNode: alphaNode,
    sizeAttenuation: attenuate,
    transparent: true,
    depthWrite: false,
    blending,
    alphaToCoverage: false,
    toneMapped: false,
    premultipliedAlpha: soft,
  });

  const points = new THREE.Sprite(material);
  points.count = count;
  points.frustumCulled = false;
  points.renderOrder = soft ? 8 : 10;

  return {
    ring,
    points,
    geometry: null,
    material,
    positionAttr,
    sizeAttr,
    alphaAttr,
    seedAttr,
    uSoftness,
    budget: createBudget(),
    webgpu: true,
  };
}

/** Push CPU ring buffers to the GPU after `advance`. */
export function flushWebGpuParticleSystem(sys) {
  sys.positionAttr.needsUpdate = true;
  sys.sizeAttr.needsUpdate = true;
  sys.alphaAttr.needsUpdate = true;
  if (sys.seedAttr) sys.seedAttr.needsUpdate = true;
}
