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

export { enableCarParticleSystems };

const WHEELS = 4;

// ---------------------------------------------------------------------------
// Geometry around the pure ring
// ---------------------------------------------------------------------------

/**
 * `Points` over a `particleRing`, with a soft round sprite generated in the shader
 * rather than sampled from a texture — a 64x64 blob map is a texture upload, a
 * mip chain and a binding for something `smoothstep` does in two instructions.
 *
 * WebGL only: see `enableCarParticleSystems`.
 */
function createParticleSystem({ count, size, color, opacity, gravity, drag, blending, attenuate = true }) {
  const ring = createRing({ count, gravity, drag });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(ring.positions, 3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(ring.sizes, 1));
  geometry.setAttribute('aAlpha', new THREE.BufferAttribute(ring.alphas, 1));
  // A generous sphere: these move every frame, and recomputing bounds to cull a
  // few hundred points is the wrong trade.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uOpacity: { value: opacity },
      uScale: { value: size },
      uAttenuate: { value: attenuate ? 1 : 0 },
    },
    vertexShader: /* glsl */`
      attribute float aSize;
      attribute float aAlpha;
      varying float vAlpha;
      uniform float uScale;
      uniform float uAttenuate;
      void main() {
        vAlpha = aAlpha;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        float attenuation = mix(1.0, 300.0 / max(-mv.z, 1.0), uAttenuate);
        gl_PointSize = uScale * aSize * attenuation;
      }`,
    fragmentShader: /* glsl */`
      varying float vAlpha;
      uniform vec3 uColor;
      uniform float uOpacity;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float r = length(d);
        if (r > 0.5) discard;
        float falloff = smoothstep(0.5, 0.05, r);
        gl_FragColor = vec4(uColor, vAlpha * uOpacity * falloff);
      }`,
    transparent: true,
    depthWrite: false,
    blending,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;

  return { ring, points, geometry, material, budget: createBudget() };
}

function flushSystem(sys, dt) {
  advance(sys.ring, dt);
  sys.geometry.attributes.position.needsUpdate = true;
  sys.geometry.attributes.aSize.needsUpdate = true;
  sys.geometry.attributes.aAlpha.needsUpdate = true;
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
 * @param {{ particles?: boolean }} [options]
 *   `particles` defaults to true (WebGL). Pass false on the WebGPU path.
 */
export function createCarEffects(scene, { particles = true } = {}) {
  const marks = createTyreMarkTexture();
  const empty = {
    smoke: null,
    sparks: null,
    haze: null,
    marks,
    _glow: { r: 0, g: 0, b: 0, intensity: 0 },
    rates: { smoke: 0, sparks: 0, haze: 0 },
  };
  if (!particles) return empty;

  const smoke = createParticleSystem({
    count: 900,
    size: 26,
    color: 0xd8d4cf,
    opacity: 0.30,
    gravity: 1.2,
    drag: 1.6,
    blending: THREE.NormalBlending,
  });
  const sparks = createParticleSystem({
    count: 700,
    size: 5,
    color: 0xffb857,
    opacity: 1.0,
    gravity: -14,
    drag: 0.6,
    // Additive, because sparks are emitters: a spark over a dark tyre has to
    // brighten it, not tint it.
    blending: THREE.AdditiveBlending,
  });
  const haze = createParticleSystem({
    count: 260,
    size: 34,
    color: 0xbfc4cc,
    opacity: 0.06,
    gravity: 2.4,
    drag: 1.1,
    blending: THREE.NormalBlending,
  });

  for (const sys of [smoke, sparks, haze]) scene.add(sys.points);

  return {
    smoke,
    sparks,
    haze,
    marks,
    _glow: empty._glow,
    rates: empty.rates,
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
      const puffs = takeBudget(fx.smoke.budget, rate * 90 * dt);
      for (let k = 0; k < puffs; k++) {
        // Thrown back from the contact patch at a fraction of road speed, then it
        // billows: a plume that simply rises is steam, not tyre smoke.
        emit(
          fx.smoke.ring, w.x, w.y + 0.1, w.z,
          (Math.random() - 0.5) * 3 - c.forwardX * speed * 0.06,
          0.7 + Math.random() * 1.4,
          (Math.random() - 0.5) * 3 - c.forwardZ * speed * 0.06,
          0.7 + Math.random() * 0.9,
          0.5 + Math.random() * 0.9,
        );
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
    sys.geometry.dispose();
    sys.material.dispose();
  }
  fx.marks.texture.dispose();
}
