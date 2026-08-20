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

import { MU } from './constants.js';
import { LF, LR, TRACK_HALF } from './constants.js';

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
  }
  return out;
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
