/**
 * Per-wheel surface query.
 *
 * One interface change, and it fixes a bug that mattered: sampling a single
 * surface type for the whole car meant that putting two wheels on the grass
 * dropped **the entire car** to μ = 0.35. A wheel on the grass should pull the
 * car — an asymmetric yaw moment — not teleport it onto ice.
 *
 * It is also the seam everything in Phase 2 hangs off. Elevation, banking,
 * cross-slope, bumps and kerb profiles all arrive as `height` and `normal` from
 * this query without the kernel changing at all, which is why it is worth defining
 * the full shape now even while the track is still flat.
 */

import { MU, LF, LR, TRACK_HALF } from './constants.js';

/**
 * Wheel positions in body coordinates: x forward, y right.
 *
 * The mesh's wheels sit at ±0.69 m from the centreline while the physics track
 * half-width is 0.8 m. The physics figure is the one that matters here — it sets
 * the roll moment arm — and a 110 mm visual difference on the wheel centre is not
 * something anyone will see.
 */
export const WHEEL_X = [LF, LF, -LR, -LR];
export const WHEEL_Y = [-TRACK_HALF, TRACK_HALF, -TRACK_HALF, TRACK_HALF];

/** One sample per wheel. Allocated once and written in place. */
export function createSurfaceSamples() {
  const out = [];
  for (let i = 0; i < 4; i++) {
    out.push({
      surface: 'tarmac',
      mu: MU.tarmac,
      height: 0,
      /** Surface normal, as the two horizontal components; y is implied upward. */
      nx: 0,
      nz: 0,
      roughness: 0,
      /**
       * Vertical curvature of the smooth elevation profile, 1/m. Positive is a
       * compression, negative a crest. From the profile rather than from the full
       * surface, because the bumps already reach the car through the plane
       * residual and counting them twice would be a very rough road indeed.
       */
      curvature: 0,
      /** World position the sample was taken at, for effects and debugging. */
      x: 0,
      z: 0,
    });
  }
  return out;
}

/**
 * Sample the track under all four wheels.
 *
 * Two track interfaces are accepted. A track with `queryWheel(x, z, out)` gets to
 * report height, normal, μ and roughness directly — that is what Phase 2 provides.
 * A track with only the older `query(x, z)` is treated as flat, with μ from the
 * surface name, so the existing circuit keeps working unchanged.
 *
 * @param {object} track
 * @param {number} x world X of the CoG
 * @param {number} z world Z of the CoG
 * @param {number} yaw radians
 * @param {Array} out from `createSurfaceSamples`
 */
export function sampleWheelSurfaces(track, x, z, yaw, out) {
  // Yaw 0 faces -Z, so forward is (-sin, -cos) and right is (cos, -sin).
  const sinY = Math.sin(yaw);
  const cosY = Math.cos(yaw);
  const fx = -sinY;
  const fz = -cosY;
  const rx = cosY;
  const rz = -sinY;

  for (let i = 0; i < 4; i++) {
    const wx = x + WHEEL_X[i] * fx + WHEEL_Y[i] * rx;
    const wz = z + WHEEL_X[i] * fz + WHEEL_Y[i] * rz;
    const s = out[i];
    s.x = wx;
    s.z = wz;

    if (track.queryWheel) {
      track.queryWheel(wx, wz, s);
      continue;
    }

    const sample = track.query(wx, wz);
    s.surface = sample.surface;
    s.mu = MU[sample.surface] ?? MU.grass;
    s.height = 0;
    s.nx = 0;
    s.nz = 0;
    s.roughness = 0;
    s.curvature = 0;
  }
  return out;
}

/**
 * Fit a plane through the four wheel contact heights, in place.
 *
 * What this is *for* took a wrong turn worth recording, because the obvious design
 * is wrong in a way that only shows up when you test it.
 *
 * The tempting move is to feed the suspension `height − plane`, on the theory that
 * a hill should not compress a spring. It does work for a uniform slope. It also
 * silently deletes kerbs: two wheels on a 50 mm kerb, across a 1.6 m track, *is*
 * a 3% lateral gradient, and the fit cannot tell it from banking. A one-sided kerb
 * came out as zero residual — a static tilt with no impact at all. The same
 * blindness applies longitudinally: four contact points at two distinct x values
 * always fit a plane exactly, so a crest between the axles vanishes too.
 *
 * The suspension does not need the help. It already carries heave, pitch and roll
 * as free DOFs with no absolute-attitude restoring term, so given raw wheel
 * heights it settles onto any plane by itself and the springs return to static —
 * and a kerb, a crest and a compression all arrive as the transients they are.
 * Cresting a rise unloads the car because the wheels have to stop rising and the
 * force to do that comes out of the spring; nothing has to be added for it.
 *
 * So the plane fit's job is narrower than it first looked, and both remaining
 * users are outside the suspension:
 *
 *   - `height` — where the car is. The renderer's Y.
 *   - `gradeLong`, `gradeLat` — the slope, for the gravity component along the
 *     body axes. That is a real force and does not come from anywhere else.
 *
 * `residual` is still computed, because it is exactly "how far from planar is the
 * ground under this car" and that is the right input for camera shake and for
 * kerb audio. It is no longer what the springs are fed.
 *
 * The lateral fit is exact by symmetry; the longitudinal one needs a 2×2 solve
 * because the CoG is not midway between the axles.
 */
export function fitGroundPlane(samples, out) {
  let sumH = 0;
  let sumXH = 0;
  let sumYH = 0;
  for (let i = 0; i < 4; i++) {
    const h = samples[i].height;
    sumH += h;
    sumXH += WHEEL_X[i] * h;
    sumYH += WHEEL_Y[i] * h;
  }
  // Lateral: the four y offsets are ±t/2, so Σy² = 4·(t/2)² = t².
  const t = 2 * TRACK_HALF;
  out.gradeLat = sumYH / (t * t);

  // Longitudinal: x ∈ {LF, LF, −LR, −LR}, which is not zero-mean.
  const A = 4;
  const B = 2 * (LF - LR);
  const C = 2 * (LF * LF + LR * LR);
  const det = A * C - B * B;
  out.height = (sumH * C - B * sumXH) / det;
  out.gradeLong = (A * sumXH - B * sumH) / det;

  for (let i = 0; i < 4; i++) {
    out.residual[i] = samples[i].height
      - (out.height + out.gradeLong * WHEEL_X[i] + out.gradeLat * WHEEL_Y[i]);
  }

  // Vertical curvature, averaged over the four contact points.
  //
  // This has to come from the track rather than from the fit, and the reason is
  // worth stating: four contact points at two distinct longitudinal positions
  // always fit a plane *exactly*, so a crest between the axles leaves no residual
  // at all. The plane fit is structurally blind to it. Yet cresting a rise at
  // speed unloads the car and a compression loads it, and those are two of the
  // things drivers talk about most.
  out.curvature = 0.25 * (samples[0].curvature + samples[1].curvature
    + samples[2].curvature + samples[3].curvature);
  return out;
}

export function createGroundPlane() {
  return {
    height: 0, gradeLong: 0, gradeLat: 0, curvature: 0, residual: [0, 0, 0, 0],
  };
}

/** Mean of the four μ values. For telemetry, and for nothing load-bearing. */
export function meanMu(samples) {
  return (samples[0].mu + samples[1].mu + samples[2].mu + samples[3].mu) / 4;
}

/** True when the wheels are not all on the same surface — the asymmetric case. */
export function isSplitSurface(samples) {
  const first = samples[0].surface;
  for (let i = 1; i < 4; i++) {
    if (samples[i].surface !== first) return true;
  }
  return false;
}
