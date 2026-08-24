/**
 * The effects, driven from the physics.
 *
 * Every one of these reads a quantity the kernel computes for its own reasons.
 * That is the plan's "one model, two outputs", and it is worth more than it
 * sounds: an effect keyed to what the car is doing cannot contradict it, where an
 * effect keyed to which key is held always eventually does. The brake lights used
 * to glow instantly from cold and go out instantly when the pedal came up, both of
 * which a 5 kg carbon disc physically cannot do.
 *
 *   brake glow    <- brake disc temperature, which also sets pad friction
 *   sparks        <- skid plank contact force, which is also a real vertical load
 *   tyre smoke    <- slip power, which also heats the tyre
 *   tyre marks    <- slip and load, accumulated into a track-space texture
 *   heat haze     <- disc temperature and engine load
 *
 * Particles are one `Points` per system with a preallocated ring of vertices,
 * because the alternative — an `Object3D` per particle — allocates at 60 Hz and
 * the whole point of the flat state vector was to stop doing that.
 */

import * as THREE from 'three';
import { brakeGlow } from './blackbody.js';
import {
  smokeRate, sparkRate, markIntensity, brakeHaze, exhaustHaze,
} from './effectRates.js';
import { createRing, emit, advance, createBudget, takeBudget } from './particleRing.js';
import { createMarkBuffer, layMark } from './tyreMarks.js';

import { enableCarParticleSystems } from './carParticleBackend.js';
import { smokePuff, SOFT_PARTICLE_METRES } from './smokeLook.js';

export { enableCarParticleSystems };

const WHEELS = 4;

/** Placeholder so WebGL does not warn about an unbound depth sampler. */
let _dummyDepth = null;
function dummyDepthTexture() {
  if (_dummyDepth) return _dummyDepth;
  _dummyDepth = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  _dummyDepth.needsUpdate = true;
  return _dummyDepth;
}

/** @type {null | typeof import('./carEffectsWebGpu.js')} */
let webGpuParticles = null;

/**
 * Lazy-load the WebGPU sprite path so the WebGL import map never pulls in `three/tsl`.
 * @returns {Promise<typeof import('./carEffectsWebGpu.js')>}
 */
async function loadWebGpuParticles() {
  if (!webGpuParticles) webGpuParticles = await import('./carEffectsWebGpu.js');
  return webGpuParticles;
}

/**
 * Preload WebGPU particle module during boot (call from HelloRacer after backend resolve).
 */
export async function prepareCarEffectsBackend(backend) {
  if (backend === 'webgpu') await loadWebGpuParticles();
}

// ---------------------------------------------------------------------------
// Geometry around the pure ring
// ---------------------------------------------------------------------------

/**
 * Soft round particles. WebGL: classic Points + ShaderMaterial. WebGPU: Sprite +
 * PointsNodeMaterial (see `carEffectsWebGpu.js`).
 *
 * @param {object} opts
 * @param {'webgl' | 'webgpu'} [opts.backend]
 */
function createParticleSystem({
  count, size, color, opacity, gravity, drag, blending, attenuate = true,
  backend = 'webgl', envelope = 'linear', expand = 1, soft = false,
}) {
  if (backend === 'webgpu') {
    if (!webGpuParticles) {
      throw new Error('prepareCarEffectsBackend("webgpu") must run before createCarEffects');
    }
    return webGpuParticles.createWebGpuParticleSystem({
      count, size, color, opacity, gravity, drag, blending, attenuate,
      envelope, expand, soft,
    });
  }

  const ring = createRing({ count, gravity, drag, envelope, expand });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(ring.positions, 3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(ring.sizes, 1));
  geometry.setAttribute('aAlpha', new THREE.BufferAttribute(ring.alphas, 1));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(ring.seeds, 1));
  // A generous sphere: these move every frame, and recomputing bounds to cull a
  // few hundred points is the wrong trade.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uOpacity: { value: opacity },
      uScale: { value: size },
      uAttenuate: { value: attenuate ? 1 : 0 },
      uSoft: { value: soft ? 1 : 0 },
      tDepth: { value: dummyDepthTexture() },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uCameraNear: { value: 0.3 },
      uCameraFar: { value: 1400 },
      uSoftness: { value: soft ? SOFT_PARTICLE_METRES : 0 },
      uDepthFade: { value: 0 },
    },
    vertexShader: /* glsl */`
      attribute float aSize;
      attribute float aAlpha;
      attribute float aSeed;
      varying float vAlpha;
      varying float vSeed;
      varying float vViewDist;
      uniform float uScale;
      uniform float uAttenuate;
      void main() {
        vAlpha = aAlpha;
        vSeed = aSeed;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vViewDist = -mv.z;
        gl_Position = projectionMatrix * mv;
        float attenuation = mix(1.0, 300.0 / max(-mv.z, 1.0), uAttenuate);
        gl_PointSize = uScale * aSize * attenuation;
      }`,
    fragmentShader: /* glsl */`
      varying float vAlpha;
      varying float vSeed;
      varying float vViewDist;
      uniform vec3 uColor;
      uniform float uOpacity;
      uniform float uSoft;
      uniform sampler2D tDepth;
      uniform vec2 uResolution;
      uniform float uCameraNear;
      uniform float uCameraFar;
      uniform float uSoftness;
      uniform float uDepthFade;
      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }
      float perspectiveDepthToViewZ(const in float depth, const in float near, const in float far) {
        return (near * far) / ((far - near) * depth - far);
      }
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float r = length(d);
        if (r > 0.5) discard;
        float falloff;
        if (uSoft > 0.5) {
          // Soft volumetric puff: dense core, soft mid, barely-there rim, mottled.
          float core = smoothstep(0.28, 0.0, r);
          float mid = smoothstep(0.48, 0.12, r);
          float rim = smoothstep(0.5, 0.22, r);
          float n = hash(gl_PointCoord * 28.0 + vSeed * 17.0);
          float n2 = hash(gl_PointCoord.yx * 51.0 - vSeed * 9.0);
          float mottled = mix(0.72, 1.18, n) * mix(0.85, 1.1, n2);
          falloff = (core * 0.5 + mid * 0.35 + rim * 0.18) * mottled;
          falloff *= falloff; // concentrate density toward the centre
        } else {
          falloff = smoothstep(0.5, 0.05, r);
        }
        float fade = 1.0;
        if (uDepthFade > 0.5 && uSoftness > 0.0) {
          float packed = texture2D(tDepth, gl_FragCoord.xy / max(uResolution, vec2(1.0))).x;
          if (packed > 1.0e-5) {
            float sceneDist = -perspectiveDepthToViewZ(packed, uCameraNear, uCameraFar);
            float gap = sceneDist - vViewDist;
            float t = clamp(gap / uSoftness, 0.0, 1.0);
            fade = t * t * (3.0 - 2.0 * t);
          }
        }
        float a = vAlpha * uOpacity * falloff * fade;
        gl_FragColor = vec4(uColor * falloff, a);
      }`,
    transparent: true,
    depthWrite: false,
    blending,
    // Premultiply-ish look: soft edges over asphalt without hard discs.
    premultipliedAlpha: soft,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  if (soft) points.renderOrder = 8;

  return { ring, points, geometry, material, budget: createBudget(), webgpu: false };
}

function flushSystem(sys, dt) {
  advance(sys.ring, dt);
  if (sys.webgpu) {
    webGpuParticles.flushWebGpuParticleSystem(sys);
    return;
  }
  sys.geometry.attributes.position.needsUpdate = true;
  sys.geometry.attributes.aSize.needsUpdate = true;
  sys.geometry.attributes.aAlpha.needsUpdate = true;
  if (sys.geometry.attributes.aSeed) sys.geometry.attributes.aSeed.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// Tyre marks
// ---------------------------------------------------------------------------

/** The accumulation buffer, wrapped in a texture the asphalt material can sample. */
export function createTyreMarkTexture() {
  const marks = createMarkBuffer();
  const texture = new THREE.DataTexture(
    marks.data, marks.along, marks.across, THREE.RedFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  // Mipmaps asked for AND generated — unlike several textures in this scene which
  // request a mipmapped minFilter with generateMipmaps false, and so ask the
  // sampler for levels that were never uploaded.
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  marks.texture = texture;
  return marks;
}

/** Push accumulated marks to the GPU. Once a frame at most, not once a sample. */
export function flushMarks(marks) {
  if (!marks.dirty) return;
  marks.texture.needsUpdate = true;
  marks.dirty = false;
}

// ---------------------------------------------------------------------------
// The whole effect set
// ---------------------------------------------------------------------------

/**
 * @param {THREE.Scene} scene
 * @param {{ particles?: boolean, backend?: 'webgl' | 'webgpu' }} [options]
 *   `particles` defaults to true. Pass `backend: 'webgpu'` for Sprite draw path.
 */
export function createCarEffects(scene, { particles = true, backend = 'webgl' } = {}) {
  const marks = createTyreMarkTexture();
  const empty = {
    smoke: null,
    sparks: null,
    haze: null,
    marks,
    smokeBudget: 1,
    _glow: { r: 0, g: 0, b: 0, intensity: 0 },
    rates: { smoke: 0, sparks: 0, haze: 0 },
  };
  if (!particles) return empty;

  const opts = { backend };
  const smoke = createParticleSystem({
    count: 1400,
    // World metres on WebGPU sprites; pixel-ish scale on WebGL Points.
    size: backend === 'webgpu' ? 1.45 : 56,
    // Warm rubber-grey, not chalk white — real tyre smoke is dirty.
    color: 0xb8b0a6,
    opacity: 0.38,
    gravity: 0.55,
    drag: 0.85,
    blending: THREE.NormalBlending,
    envelope: 'smoke',
    expand: 3.1,
    soft: true,
    ...opts,
  });
  const sparks = createParticleSystem({
    count: 700,
    size: backend === 'webgpu' ? 0.12 : 5,
    color: 0xffb857,
    opacity: 1.0,
    gravity: -14,
    drag: 0.6,
    // Additive, because sparks are emitters: a spark over a dark tyre has to
    // brighten it, not tint it.
    blending: THREE.AdditiveBlending,
    ...opts,
  });
  const haze = createParticleSystem({
    count: 260,
    size: backend === 'webgpu' ? 0.55 : 28,
    color: 0xbfc4cc,
    opacity: 0.05,
    gravity: 2.4,
    drag: 1.1,
    blending: THREE.NormalBlending,
    ...opts,
  });

  for (const sys of [smoke, sparks, haze]) scene.add(sys.points);

  return {
    smoke,
    sparks,
    haze,
    marks,
    _glow: empty._glow,
    rates: empty.rates,
    smokeBudget: 1,
  };
}

/**
 * Emit and advance everything for one frame.
 *
 * @param {object} fx from `createCarEffects`
 * @param {object} c car state:
 *   `sim` from `telemetryOf`; `wheels` four world positions; `wheelTrack` four
 *   `{ t, across }` track positions; `x`, `z`, `groundY`, `forwardX`, `forwardZ`,
 *   `speed`, `throttle`, `exhaust`.
 * @param {number} dt seconds
 */
export function updateCarEffects(fx, c, dt) {
  const { sim, wheels, speed } = c;
  let smokeTotal = 0;
  let sparkTotal = 0;
  let hazeTotal = 0;
  const particles = Boolean(fx.smoke);

  for (let i = 0; i < WHEELS; i++) {
    const w = wheels[i];

    if (particles) {
      const rate = smokeRate(sim.slipSpeed[i], sim.fz[i], sim.tyreT[i]);
      smokeTotal += rate;
      // Dense enough to read as a plume; ignore whisper-level slip so rolling
      // creep does not seed a permanent cloud.
      if (rate >= 0.04) {
        const budget = fx.smokeBudget ?? 1;
        const puffs = takeBudget(fx.smoke.budget, rate * 110 * dt * budget);
        for (let k = 0; k < puffs; k++) {
          const puff = smokePuff(rate);
          const side = (Math.random() - 0.5) * puff.scatter;
          const along = (Math.random() - 0.5) * puff.scatter * 0.45;
          emit(
            fx.smoke.ring,
            w.x + along * c.forwardX + side * c.forwardZ * 0.35,
            w.y + 0.06 + Math.random() * 0.08,
            w.z + along * c.forwardZ - side * c.forwardX * 0.35,
            -c.forwardX * speed * puff.back + (Math.random() - 0.5) * puff.scatter * 0.55,
            puff.rise,
            -c.forwardZ * speed * puff.back + (Math.random() - 0.5) * puff.scatter * 0.55,
            puff.life,
            puff.size,
            puff.seed,
          );
        }
      }

      const h = brakeHaze(sim.brakeT[i], speed);
      hazeTotal += h;
      const shimmers = takeBudget(fx.haze.budget, h * 14 * dt);
      for (let k = 0; k < shimmers; k++) {
        emit(
          fx.haze.ring, w.x, w.y + 0.25, w.z,
          (Math.random() - 0.5) * 0.8, 1.1 + Math.random(), (Math.random() - 0.5) * 0.8,
          0.5 + Math.random() * 0.5, 0.6 + Math.random() * 0.8,
        );
      }
    }

    // Rubber on the road, at the wheel's own track position rather than the car's:
    // the car is 1.6 m wide on a 12 m surface, so four marks in one place is one
    // mark, and a racing line is exactly the difference between them.
    const wt = c.wheelTrack?.[i];
    if (wt) {
      layMark(fx.marks, wt.t, wt.across, markIntensity(sim.slipSpeed[i], sim.fz[i]) * dt * 8);
    }
  }

  if (particles) {
    // Plank sparks, from under the floor at each end. Ride height is measured to the
    // floor, so a negative value is the plank on the ground and its depth is the
    // penetration the contact force is computed from.
    const plankForce = h => (h < 0 ? -h * PLANK_STIFFNESS : 0);
    for (const [force, offset] of [
      [plankForce(sim.rideFront), 1.4],
      [plankForce(sim.rideRear), -1.2],
    ]) {
      const rate = sparkRate(force, speed);
      sparkTotal += rate;
      const n = takeBudget(fx.sparks.budget, rate * 260 * dt);
      for (let k = 0; k < n; k++) {
        // A spark shower is a cone thrown backwards, and its speed comes from the
        // car rather than from an explosion.
        const back = 0.35 + Math.random() * 0.5;
        emit(
          fx.sparks.ring,
          c.x + c.forwardX * offset, c.groundY + 0.03, c.z + c.forwardZ * offset,
          -c.forwardX * speed * back + (Math.random() - 0.5) * 5,
          1.5 + Math.random() * 3.5,
          -c.forwardZ * speed * back + (Math.random() - 0.5) * 5,
          0.25 + Math.random() * 0.45,
          0.5 + Math.random() * 0.9,
        );
      }
    }

    // Wall scrape: sparks from the contact point the collision resolve reported.
  // The same shower as the plank, because it is the same physics — metal ground
  // against an abrasive at speed.
  if (c.wallScrape > 3) {
    const rate = sparkRate(6000, c.wallScrape);
    const n = takeBudget(fx.sparks.budget, rate * 200 * dt);
    for (let k = 0; k < n; k++) {
      const back = 0.3 + Math.random() * 0.5;
      emit(
        fx.sparks.ring,
        c.wallX, c.groundY + 0.25 + Math.random() * 0.5, c.wallZ,
        -c.forwardX * c.wallScrape * back + (Math.random() - 0.5) * 6,
        1 + Math.random() * 3,
        -c.forwardZ * c.wallScrape * back + (Math.random() - 0.5) * 6,
        0.3 + Math.random() * 0.4,
        0.5 + Math.random() * 0.8,
      );
    }
  }

  // Exhaust haze, which is engine load rather than temperature.
    const exhaust = exhaustHaze(c.throttle, sim.rpm);
    if (c.exhaust) {
      const n = takeBudget(fx.haze.budget, Math.max(0, exhaust - 0.25) * 14 * dt);
      for (let k = 0; k < n; k++) {
        emit(
          fx.haze.ring, c.exhaust.x, c.exhaust.y, c.exhaust.z,
          -c.forwardX * 6 + (Math.random() - 0.5), 1.4 + Math.random(),
          -c.forwardZ * 6 + (Math.random() - 0.5),
          0.35 + Math.random() * 0.35, 0.4 + Math.random() * 0.6,
        );
      }
    }

    flushSystem(fx.smoke, dt);
    flushSystem(fx.sparks, dt);
    flushSystem(fx.haze, dt);
  }

  flushMarks(fx.marks);

  fx.rates.smoke = smokeTotal / WHEELS;
  fx.rates.sparks = sparkTotal;
  fx.rates.haze = hazeTotal / WHEELS;
  return fx.rates;
}

/**
 * Bind last-frame (WebGL) scene depth so smoke fades against the car and ribbon.
 * WebGPU samples viewport depth in the material and only needs softness.
 *
 * @param {object} fx
 * @param {{ depthTexture?: import('three').Texture | null, resolution?: import('three').Vector2, camera?: import('three').Camera }} [opts]
 */
export function bindSoftParticleDepth(fx, {
  depthTexture = null,
  resolution = null,
  camera = null,
} = {}) {
  if (!fx) return;
  const enabled = Boolean(depthTexture && camera && resolution);
  for (const sys of [fx.smoke, fx.haze]) {
    if (!sys) continue;
    if (sys.webgpu) {
      if (sys.uSoftness) sys.uSoftness.value = SOFT_PARTICLE_METRES;
      continue;
    }
    const u = sys.material?.uniforms;
    if (!u?.uDepthFade) continue;
    u.tDepth.value = depthTexture || dummyDepthTexture();
    u.uDepthFade.value = enabled ? 1 : 0;
    if (camera) {
      u.uCameraNear.value = camera.near;
      u.uCameraFar.value = camera.far;
    }
    if (resolution) u.uResolution.value.copy(resolution);
  }
}

/** Plank contact stiffness, matching `aero.K_PLANK`. */
const PLANK_STIFFNESS = 8e6;

/**
 * Set brake-disc glow on a material from the disc temperature.
 *
 * The hottest corner drives it, because there is one shared material for the
 * lights and the discs and the front pair is what is visible from behind.
 */
export function updateBrakeGlow(fx, material, brakeT, braking) {
  if (!material) return;
  const hottest = Math.max(brakeT[0], brakeT[1], brakeT[2], brakeT[3]);
  const glow = brakeGlow(hottest, fx._glow);
  // The brake *light* is a lamp and follows the pedal; the *disc* glow follows
  // temperature. Both land on this material, so take whichever is brighter.
  const lampIntensity = braking ? 1.5 : 0.4;
  const discIntensity = glow.intensity * 2.6;
  if (discIntensity > lampIntensity) {
    material.emissive.setRGB(glow.r, glow.g, glow.b);
    material.emissiveIntensity = discIntensity;
  } else {
    material.emissive.setHex(braking ? 0xff1100 : 0x330000);
    material.emissiveIntensity = lampIntensity;
  }
}

export function disposeCarEffects(fx, scene) {
  for (const sys of [fx.smoke, fx.sparks, fx.haze]) {
    if (!sys) continue;
    scene.remove(sys.points);
    sys.geometry?.dispose?.();
    sys.material.dispose();
  }
  fx.marks.texture.dispose();
}
