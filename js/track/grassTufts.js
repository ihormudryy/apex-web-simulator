import * as THREE from 'three';
import { planGrassTufts } from './tracksidePlacements.js';
import { TUFT_H, tuftClumpTexture, tuftPlaneGeometryData } from './tuftGeometry.js';
import { composeOnBeforeCompile } from '../render/composeOnBeforeCompile.js';
import { interleaveForThinning } from './lodBands.js';

/**
 * Wind, shared by the GLSL and TSL paths so they cannot drift apart.
 * `dir` is a world direction; `amp` is metres of sway at the blade tips.
 */
export const WIND = { dir: [0.82, 0, 0.57], amp: 0.085 };

/** Deterministic sway phase from where the tuft stands. */
export const tuftPhase = (x, z) => x * 0.37 + z * 0.53;

function buildGeometry() {
  const d = tuftPlaneGeometryData();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(d.positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(d.normals, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(d.uvs, 2));
  g.setIndex(d.indices);
  g.computeBoundingSphere();
  return g;
}

/**
 * One chunk's geometry: the base card, plus per-instance yaw and sway phase.
 *
 * The vertex attributes are the *same* `BufferAttribute` objects as the base, so
 * all 96 chunks share one 12-vertex GPU buffer; only the small instanced arrays
 * differ. Yaw is carried as data rather than read back out of `instanceMatrix`
 * because TSL exposes no instance-matrix node, and passing it explicitly makes
 * both backends compute the sway from identical inputs.
 */
function chunkGeometry(base, placements) {
  const g = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv']) {
    g.setAttribute(name, base.getAttribute(name));
  }
  g.setIndex(base.index);
  g.boundingSphere = base.boundingSphere;

  const yaw = new Float32Array(placements.length);
  const phase = new Float32Array(placements.length);
  for (let i = 0; i < placements.length; i++) {
    yaw[i] = placements[i].yaw;
    phase[i] = tuftPhase(placements[i].x, placements[i].z);
  }
  g.setAttribute('aTuftYaw', new THREE.InstancedBufferAttribute(yaw, 1));
  g.setAttribute('aTuftPhase', new THREE.InstancedBufferAttribute(phase, 1));
  return g;
}

function tuftMaterialParams() {
  const { data, size } = tuftClumpTexture();
  const map = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  map.colorSpace = THREE.SRGBColorSpace;
  map.minFilter = THREE.LinearMipmapLinearFilter;
  map.magFilter = THREE.LinearFilter;
  map.generateMipmaps = true;
  map.anisotropy = 8;
  map.needsUpdate = true;

  return {
    map,
    // Alpha-tested, not blended: `transparent` would move the tufts into the
    // back-to-front transparent queue, where they neither write depth nor sort
    // sanely against each other. Cutout grass belongs in the opaque pass.
    transparent: false,
    alphaTest: 0.42,
    // `alphaToCoverage` was tried here to let MSAA resolve the cutout, on the
    // theory that 34 689 blade-shaped stencils were the worst-case edge crawl.
    // Measured, it made things slightly worse — p99 48.3 -> 52.7 — so the crawl
    // is elsewhere. Left as a note so the idea is not retried blind.
    side: THREE.FrontSide,
    roughness: 0.88,
    metalness: 0,
    // Kept low: sky IBL is blue-white and washes the blades toward straw.
    envMapIntensity: 0.55,
    color: 0xffffff,
  };
}

/**
 * @param {?object} surfaceNodes `tslSurfaceNodes` module on the WebGPU path.
 */
function buildMaterial(surfaceNodes) {
  const params = tuftMaterialParams();
  if (surfaceNodes) {
    // NodeMaterial never runs onBeforeCompile, so the WebGPU path builds the
    // same sway as a node graph instead of the GLSL injection below.
    return surfaceNodes.createTuftNodeMaterial(params, {
      tuftHeight: TUFT_H,
      windDir: new THREE.Vector3(...WIND.dir),
      windAmp: WIND.amp,
    });
  }

  const material = new THREE.MeshStandardMaterial(params);
  const uniforms = {
    uTime: { value: 0 },
    uWindDir: { value: new THREE.Vector3(...WIND.dir) },
    uWindAmp: { value: WIND.amp },
  };
  material.userData.windUniforms = uniforms;

  const inject = shader => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uWindDir = uniforms.uWindDir;
    shader.uniforms.uWindAmp = uniforms.uWindAmp;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uTime;
        uniform vec3 uWindDir;
        uniform float uWindAmp;
        attribute float aTuftYaw;
        attribute float aTuftPhase;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          // Sway grows with height so the roots stay planted.
          float h = clamp( transformed.y / ${TUFT_H.toFixed(4)}, 0.0, 1.0 );
          float sway = sin( uTime * 1.55 + aTuftPhase ) * 0.62
                     + sin( uTime * 3.10 + aTuftPhase * 1.7 ) * 0.38;
          // The offset is applied in instance space and then rotated by the
          // instance yaw, so rotate the world wind the other way first or every
          // tuft leans its own direction. local = transpose( Ry( yaw ) ) * world.
          float c = cos( aTuftYaw );
          float s = sin( aTuftYaw );
          vec2 w = vec2(
            uWindDir.x * c - uWindDir.z * s,
            uWindDir.x * s + uWindDir.z * c
          );
          transformed.xz += w * sway * h * h * uWindAmp;
        }`);
  };
  // Assigning `material.onBeforeCompile` directly does not survive: CSM calls
  // setupMaterial on every standard material in the scene and overwrites it, so
  // the sway silently never ran while uTime ticked away into an unread uniform.
  composeOnBeforeCompile(material, inject, 'grassWind');
  return material;
}

/**
 * Instanced cross-blade tufts on the runoff lawn, density highest at the kerb.
 *
 * Split into spatial chunks so frustum culling can do its job: `InstancedMesh`
 * cannot cull per instance, so one mesh spanning the whole lap has to be drawn
 * in full from every camera angle. Chunked by station order — which is spatial
 * order — a chase camera submits only the few chunks actually in view.
 *
 * @param {{ samples: object[], length: number }} centerline
 * @param {number|function} baseY world height of the tuft root. A number for a
 *   flat runoff; a `(x, z) => y` function once the ground has elevation, which it
 *   now does — 34 000 blades pinned to a single plane float clear of the surface
 *   at the high points of the circuit and are buried at the low ones.
 */
export function createGrassTufts(centerline, baseY = -0.04, {
  chunks = 96, plan = {}, surfaceNodes = null,
} = {}) {
  const group = new THREE.Group();
  group.name = 'grassTufts';

  const placements = planGrassTufts(centerline.samples, centerline.length, plan);
  if (!placements.length) return group;

  const baseGeometry = buildGeometry();
  const material = buildMaterial(surfaceNodes);
  const uniforms = material.userData.windUniforms;
  const perChunk = Math.ceil(placements.length / chunks);
  const dummy = new THREE.Object3D();

  for (let c = 0; c < chunks; c++) {
    const from = c * perChunk;
    // Chunk membership stays spatial — this only reorders within the chunk, so
    // that thinning by instance count thins evenly across it.
    const slice = interleaveForThinning(placements.slice(from, from + perChunk), c + 1);
    if (!slice.length) break;

    const mesh = new THREE.InstancedMesh(chunkGeometry(baseGeometry, slice), material, slice.length);
    for (let i = 0; i < slice.length; i++) {
      const p = slice[i];
      dummy.position.set(p.x, typeof baseY === 'function' ? baseY(p.x, p.z) : baseY, p.z);
      dummy.rotation.set(0, p.yaw, 0);
      dummy.scale.setScalar(p.scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    // A per-chunk bounding sphere is what makes culling possible at all.
    mesh.computeBoundingSphere();
    mesh.frustumCulled = true;
    // Not a shadow caster: a 0.4 m card is a few pixels in an 80 m cascade, so
    // it buys mush, and the depth pass would not run the wind shader — the
    // shadows would stand still while the grass moved.
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    // The GLSL path owns its own clock; the TSL path uses the renderer's `time`
    // node, so leave that one alone.
    if (!uniforms.isTsl) {
      mesh.onBeforeRender = () => {
        uniforms.uTime.value = performance.now() / 1000;
      };
    }
    group.add(mesh);
  }
  return group;
}
