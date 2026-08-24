/**
 * Procedural concrete Jersey barrier maps — albedo, normal, roughness.
 *
 * Pure pixel functions (no Three.js) so Node tests can lock the weathered
 * concrete look: formwork seams, aggregate speckles, tyre scuffs at the base,
 * and a slight slope cue in the normal from the trapezoid face.
 */

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

function hash2(ix, iy, seed) {
  let n = Math.imul(ix + seed * 17, 374761393) + Math.imul(iy + seed * 31, 668265263);
  n = (n ^ (n >>> 13)) >>> 0;
  return (n % 10000) / 10000;
}

function wrap(i, n) {
  return ((i % n) + n) % n;
}

function valueNoise(x, y, cells, seed) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(wrap(x0, cells), wrap(y0, cells), seed);
  const b = hash2(wrap(x0 + 1, cells), wrap(y0, cells), seed);
  const c = hash2(wrap(x0, cells), wrap(y0 + 1, cells), seed);
  const d = hash2(wrap(x0 + 1, cells), wrap(y0 + 1, cells), seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** One tile spans this many metres along the wall. */
export const JERSEY_PANEL_METRES = 3.0;
/** Barrier height, m — typical low trackside Jersey. */
export const JERSEY_HEIGHT = 0.95;
/** Half-thickness at the base / top (trapezoid), m. */
export const JERSEY_HALF_BASE = 0.28;
export const JERSEY_HALF_TOP = 0.12;

/**
 * Relief height at (u,v) in [0,1]² — formwork + aggregate + base scuff.
 * Positive = outward bump for normals.
 */
export function jerseyHeight(u, v) {
  const form = 0.004 * Math.sin(u * Math.PI * 2 * 2.0)
    + 0.0025 * Math.sin(v * Math.PI * 2 * 6);
  const seam = Math.exp(-((u - 0.5) ** 2) / (2 * 0.012 ** 2)) * 0.006;
  const agg = (valueNoise(u * 48, v * 24, 64, 9) - 0.5) * 0.008;
  const scuff = Math.exp(-(v * v) / 0.08) * 0.01
    * (0.4 + 0.6 * valueNoise(u * 20, v * 8, 32, 3));
  return form + seam + agg + scuff;
}

/**
 * @param {number} [width=512]
 * @param {number} [height=256]
 */
export function jerseyAlbedo(width = 512, height = 256) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const n = valueNoise(u * 18, v * 10, 32, 5);
      const n2 = valueNoise(u * 55, v * 30, 64, 11);
      // Cool concrete grey; dirtier toward the base.
      let r = 0.52 + 0.06 * n + 0.03 * n2;
      let g = 0.51 + 0.05 * n + 0.025 * n2;
      let b = 0.48 + 0.04 * n + 0.02 * n2;
      const dirt = Math.exp(-(v * v) / 0.12) * (0.35 + 0.4 * n);
      r = lerp(r, 0.28, dirt);
      g = lerp(g, 0.26, dirt);
      b = lerp(b, 0.22, dirt);
      // Tyre scuff streaks near the racing face (low v).
      const streak = Math.exp(-((v - 0.12) ** 2) / 0.01)
        * Math.pow(0.5 + 0.5 * Math.sin(u * Math.PI * 14 + n2 * 4), 4);
      r = lerp(r, 0.18, streak * 0.55);
      g = lerp(g, 0.17, streak * 0.55);
      b = lerp(b, 0.16, streak * 0.55);
      // Panel seam slightly darker.
      const seam = Math.exp(-((u - 0.5) ** 2) / (2 * 0.01 ** 2));
      r = lerp(r, r * 0.85, seam);
      g = lerp(g, g * 0.85, seam);
      b = lerp(b, b * 0.85, seam);
      const o = (y * width + x) * 4;
      data[o] = Math.round(clamp(r, 0, 1) * 255);
      data[o + 1] = Math.round(clamp(g, 0, 1) * 255);
      data[o + 2] = Math.round(clamp(b, 0, 1) * 255);
      data[o + 3] = 255;
    }
  }
  return data;
}

/**
 * @param {number} [width=512]
 * @param {number} [height=256]
 * @param {number} [strength=1.4]
 */
export function jerseyNormal(width = 512, height = 256, strength = 1.4) {
  const data = new Uint8ClampedArray(width * height * 4);
  const du = 1 / width;
  const dv = 1 / height;
  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const hL = jerseyHeight(u - du, v);
      const hR = jerseyHeight(u + du, v);
      const hD = jerseyHeight(u, v - dv);
      const hU = jerseyHeight(u, v + dv);
      let nx = (hL - hR) * strength * width * 0.5;
      let ny = (hD - hU) * strength * height * 0.5;
      let nz = 1;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
      const o = (y * width + x) * 4;
      data[o] = Math.round((nx * 0.5 + 0.5) * 255);
      data[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      data[o + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      data[o + 3] = 255;
    }
  }
  return data;
}

/**
 * @param {number} [width=512]
 * @param {number} [height=256]
 */
export function jerseyRoughness(width = 512, height = 256) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const n = valueNoise(u * 22, v * 14, 32, 7);
      // Matte concrete; polished slightly where tyres polish mid-height.
      let rough = 0.88 - 0.08 * Math.exp(-(((v - 0.35) / 0.2) ** 2)) + 0.06 * (n - 0.5);
      rough = clamp(rough, 0.55, 0.98);
      const g = Math.round(rough * 255);
      const o = (y * width + x) * 4;
      data[o] = g;
      data[o + 1] = g;
      data[o + 2] = g;
      data[o + 3] = 255;
    }
  }
  return data;
}

const lerp = (a, b, t) => a + (b - a) * t;

/**
 * Lateral offsets for the Jersey trapezoid profile (track-facing slope).
 * `t` is 0 at base, 1 at top. Returns half-thickness toward the field (+) and
 * toward the track (−), relative to the wall centreline.
 */
export function jerseyHalfThickness(t) {
  const u = clamp(t, 0, 1);
  const half = JERSEY_HALF_BASE + (JERSEY_HALF_TOP - JERSEY_HALF_BASE) * u;
  return half;
}
