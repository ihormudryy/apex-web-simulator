import { smokeAlpha, smokeSizeScale } from './smokeLook.js';

/**
 * A fixed-budget particle ring.
 *
 * Free of three.js, which is not incidental: three is loaded from a CDN through an
 * importmap and is not present under Node, so anything that imports it cannot be
 * tested. The arithmetic here — recycling, integration, fading, and turning a
 * fractional emission rate into whole particles — is where the behaviour lives, so
 * it lives on its own and `carEffects.js` wraps it in geometry.
 *
 * Ring rather than a pool with a free list: a fixed vertex budget recycled
 * oldest-first cannot fragment, never allocates, and its worst case is losing the
 * oldest particle, which is the one nobody was looking at.
 */

/**
 * @param {object} spec
 * @param {number} spec.count vertex budget
 * @param {number} spec.gravity m/s², signed — negative falls
 * @param {number} spec.drag exponential velocity decay, per second
 * @param {'linear' | 'smoke'} [spec.envelope] alpha / size over life
 * @param {number} [spec.expand] final size / birth size when envelope is smoke
 */
export function createRing({ count, gravity = 0, drag = 0, envelope = 'linear', expand = 1 }) {
  const positions = new Float32Array(count * 3);
  const velocities = new Float32Array(count * 3);
  // Dead particles are parked far away rather than removed from the draw range:
  // rewriting the range every frame costs more than drawing a few zero-size points.
  positions.fill(PARKED);
  return {
    count,
    gravity,
    drag,
    envelope,
    expand,
    cursor: 0,
    positions,
    velocities,
    ages: new Float32Array(count),
    lifetimes: new Float32Array(count),
    sizes: new Float32Array(count),
    birthSizes: new Float32Array(count),
    alphas: new Float32Array(count),
    seeds: new Float32Array(count),
    live: 0,
  };
}

export const PARKED = 1e6;

export function emit(ring, x, y, z, vx, vy, vz, life, size, seed = Math.random()) {
  const i = ring.cursor;
  ring.cursor = (i + 1) % ring.count;
  if (ring.lifetimes[i] <= 0) ring.live++;
  const p = i * 3;
  ring.positions[p] = x;
  ring.positions[p + 1] = y;
  ring.positions[p + 2] = z;
  ring.velocities[p] = vx;
  ring.velocities[p + 1] = vy;
  ring.velocities[p + 2] = vz;
  ring.ages[i] = 0;
  ring.lifetimes[i] = life;
  ring.birthSizes[i] = size;
  ring.sizes[i] = size;
  ring.alphas[i] = ring.envelope === 'smoke' ? 0 : 1;
  ring.seeds[i] = seed;
  return i;
}

/**
 * Integrate every live particle by `dt`.
 *
 * Drag is applied as an exact exponential rather than `v -= drag*v*dt`, for the
 * same reason the tyre relaxation is: the explicit form goes unstable once
 * `drag*dt > 2`, and a smoke plume that inverts its velocity because somebody
 * dropped a frame is a memorable bug.
 */
export function advance(ring, dt) {
  if (!(dt > 0)) return ring.live;
  const decay = Math.exp(-ring.drag * dt);
  const { positions, velocities, ages, lifetimes, sizes, birthSizes, alphas, seeds } = ring;
  const smoke = ring.envelope === 'smoke';
  let live = 0;
  for (let i = 0; i < ring.count; i++) {
    if (lifetimes[i] <= 0) continue;
    ages[i] += dt;
    if (ages[i] >= lifetimes[i]) {
      lifetimes[i] = 0;
      alphas[i] = 0;
      sizes[i] = 0;
      positions[i * 3 + 1] = PARKED;
      continue;
    }
    const p = i * 3;
    velocities[p] *= decay;
    velocities[p + 1] = velocities[p + 1] * decay + ring.gravity * dt;
    velocities[p + 2] *= decay;
    // Cheap curl: a lateral wobble keyed to seed so the plume does not rise as
    // a straight chimney. Magnitude falls with drag so it settles into haze.
    if (smoke) {
      const wobble = Math.sin(ages[i] * (2.1 + seeds[i] * 3.4) + seeds[i] * 6.28) * 0.55;
      velocities[p] += wobble * dt;
      velocities[p + 2] += Math.cos(ages[i] * (1.7 + seeds[i] * 2.2)) * 0.45 * dt;
    }
    positions[p] += velocities[p] * dt;
    positions[p + 1] += velocities[p + 1] * dt;
    positions[p + 2] += velocities[p + 2] * dt;
    const t = ages[i] / lifetimes[i];
    if (smoke) {
      alphas[i] = smokeAlpha(t);
      sizes[i] = birthSizes[i] * smokeSizeScale(t, ring.expand);
    } else {
      alphas[i] = 1 - t;
    }
    live++;
  }
  ring.live = live;
  return live;
}

/** How many are alive right now. For tests, and for a debug readout. */
export const liveCount = ring => ring.live;

export function createBudget() {
  return { debt: 0 };
}

/**
 * Turn a fractional emission rate into whole particles, carrying the remainder.
 *
 * Without this, any rate below one particle per frame rounds to zero and the
 * effect does not exist at low intensity — which is most of the time, and exactly
 * where a subtle effect earns its keep. A wisp of smoke from a tyre just starting
 * to slide is the useful part; a cloud from a locked wheel is the obvious part.
 *
 * Capped, because a long frame must not empty the whole ring in one go.
 */
export const MAX_PER_FRAME = 64;

export function takeBudget(budget, amount) {
  if (!(amount > 0)) return 0;
  budget.debt += amount;
  const n = Math.min(Math.floor(budget.debt), MAX_PER_FRAME);
  budget.debt -= n;
  return n;
}
