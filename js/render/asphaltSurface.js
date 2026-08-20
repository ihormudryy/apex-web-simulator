/**
 * Large-scale asphalt variation: the structure a tiling detail map cannot carry.
 *
 * `asphaltMaps.js` supplies aggregate the size of a 4 m tile. That is the right
 * scale for stones and wrong for everything that makes a circuit look used —
 * the rubbered-in racing line, dusty marbles off it, resurfacing patches, the
 * seam where paving passes meet. Those span metres to hundreds of metres and
 * never repeat, so they live in one map indexed by position on the track:
 * U is distance around the lap, V is across the racing surface.
 *
 * Pure numbers, no Three.js — the profile is unit-tested here and the shader
 * only samples and multiplies, so there is no formula duplicated in GLSL.
 *
 * Channels: R albedo multiplier, G roughness multiplier, B rubber amount
 * (for tinting toward neutral, since rubber is not simply darker asphalt).
 */

/** Decoded multiplier ranges. The GLSL is generated from these, so they agree. */
// Floor is set by rubber and the paving seam coinciding: 0.66 x 0.95 x 0.792.
// Encode ranges must cover what the profile can actually produce or the darkest
// asphalt on the circuit silently clamps to a single value.
export const ALBEDO_MUL_MIN = 0.48;
// Ceiling is set by marbles over a light resurfacing patch: 1.15 x 1.05.
export const ALBEDO_MUL_MAX = 1.24;
export const ROUGH_MUL_MIN = 0.70;
export const ROUGH_MUL_MAX = 1.18;

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = v => Math.max(0, Math.min(1, v));

function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

export const decodeAlbedoMul = byte =>
  ALBEDO_MUL_MIN + (byte / 255) * (ALBEDO_MUL_MAX - ALBEDO_MUL_MIN);
export const decodeRoughMul = byte =>
  ROUGH_MUL_MIN + (byte / 255) * (ROUGH_MUL_MAX - ROUGH_MUL_MIN);

const encode = (value, min, max) =>
  Math.round(clamp01((value - min) / (max - min)) * 255);

/**
 * The profile at one point on the surface.
 *
 * @param {number} lat  normalised lateral position, -1 at one edge, +1 at the other
 * @param {number} along  distance around the lap in metres
 */
export function asphaltSurfacePoint(lat, along) {
  // The line does not sit dead centre for a whole lap; it drifts as corners
  // alternate. Two slow incommensurate terms so the drift never visibly repeats.
  const wander = 0.22 * Math.sin(along * 0.0021) + 0.12 * Math.sin(along * 0.0071 + 1.3);
  const line = Math.exp(-(((lat - wander) / 0.42) ** 2));
  // Rubber builds unevenly round the lap — heaviest into and out of corners.
  const depth = 0.62 + 0.38 * (0.5 + 0.5 * Math.sin(along * 0.0013 + 0.7));
  const rubber = line * depth;

  // Marbles: dust and rubber pellets swept off the line, lighter and rougher.
  const marbles = smoothstep(0.58, 0.97, Math.abs(lat));

  // Resurfacing patches: hundreds of metres long, slightly different mix.
  const field = 0.5 * Math.sin(along * 0.0117)
    + 0.32 * Math.sin(along * 0.0041 + 2.1)
    + 0.18 * Math.sin(lat * 3.1 + along * 0.0007);
  const patch = smoothstep(-0.12, 0.28, field);

  // Longitudinal seam where two paving passes meet, about half way out.
  const seam = Math.exp(-(((Math.abs(lat) - 0.5) / 0.035) ** 2));

  let albedo = 1;
  albedo *= lerp(1, 0.60, rubber);
  albedo *= lerp(1, 1.15, marbles);
  albedo *= lerp(0.95, 1.05, patch);
  albedo *= lerp(1, 0.74, seam * 0.8);

  let roughness = 1;
  roughness *= lerp(1, 0.76, rubber);
  roughness *= lerp(1, 1.08, marbles);
  roughness *= lerp(0.98, 1.03, patch);

  return { albedo, roughness, rubber };
}

/**
 * @param {object} [options]
 * @param {number} [options.width=2048] samples around the lap
 * @param {number} [options.height=64] samples across the racing surface
 * @param {number} [options.lapLength=5900] metres
 * @returns {{ data: Uint8ClampedArray, width: number, height: number }}
 */
export function asphaltSurfaceMap({ width = 2048, height = 64, lapLength = 5900 } = {}) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const lat = ((y + 0.5) / height) * 2 - 1;
    for (let x = 0; x < width; x++) {
      const along = ((x + 0.5) / width) * lapLength;
      const p = asphaltSurfacePoint(lat, along);
      const o = (y * width + x) * 4;
      data[o] = encode(p.albedo, ALBEDO_MUL_MIN, ALBEDO_MUL_MAX);
      data[o + 1] = encode(p.roughness, ROUGH_MUL_MIN, ROUGH_MUL_MAX);
      data[o + 2] = Math.round(clamp01(p.rubber) * 255);
      data[o + 3] = 255;
    }
  }
  return { data, width, height };
}
