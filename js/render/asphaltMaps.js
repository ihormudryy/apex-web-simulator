/**
 * Tileable asphalt height → albedo / tangent-space normal / roughness.
 * One UV unit is one tile; Track encodes metres into UVs so the grain stays
 * physical on a 12 m GP ribbon.
 */

function wrap(i, n) {
  return ((i % n) + n) % n;
}

function hash2(ix, iy, seed) {
  let n = Math.imul(ix + seed * 17, 374761393) + Math.imul(iy + seed * 31, 668265263);
  n = (n ^ (n >>> 13)) >>> 0;
  return (n % 10000) / 10000;
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

function fbm(x, y, cells, seed) {
  let v = 0, amp = 0.5, freq = 1, norm = 0;
  for (let o = 0; o < 5; o++) {
    v += amp * valueNoise(x * freq, y * freq, cells * freq, seed + o * 19);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return v / norm;
}

export function tileableHeight(size, seed = 1) {
  const height = new Float32Array(size * size);
  // Fine aggregate: 8 cells over a 4 m tile made 50 cm waves (wet cobbles).
  const cells = 32;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size * cells;
      const v = (y + 0.5) / size * cells;
      const coarse = fbm(u, v, cells, seed);
      const stones = valueNoise(u * 10, v * 10, cells * 10, seed + 7);
      height[y * size + x] = coarse * 0.55 + stones * 0.45;
    }
  }
  return height;
}

/** Aggregate cells per tile for per-stone colour. Finer than this and the tint
 * averages back out to flat grey under a mip; coarser and it reads as blotches. */
const STONE_CELLS = 48;

/**
 * Asphalt albedo, mean in the 80–110 sRGB band that dry tarmac actually sits in.
 *
 * Individual stones vary either side of that. A single grey ramp driven only by
 * height gives every particle the same colour, which is the tell that a surface
 * is procedural: real asphalt is a mix of pale granite, dark basalt and the
 * occasional warm one, and the eye reads that scatter as detail.
 */
export function albedoFromHeight(height, size) {
  const out = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const h = height[i];
      // Quantise to a stone-sized cell so each particle keeps one colour.
      const cx = wrap(Math.floor((x / size) * STONE_CELLS), STONE_CELLS);
      const cy = wrap(Math.floor((y / size) * STONE_CELLS), STONE_CELLS);
      const lightness = hash2(cx, cy, 23);
      const warmth = hash2(cx, cy, 91);
      const grey = 80 + h * 30 + (lightness - 0.5) * 24;
      const o = i * 4;
      out[o] = grey * (1 + (warmth - 0.5) * 0.10);
      out[o + 1] = grey * (0.98 + (warmth - 0.5) * 0.02);
      out[o + 2] = grey * (0.94 - (warmth - 0.5) * 0.06);
      out[o + 3] = 255;
    }
  }
  return out;
}

export function normalFromHeight(height, size, scale = 4) {
  const out = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const hL = height[y * size + wrap(x - 1, size)];
      const hR = height[y * size + wrap(x + 1, size)];
      const hD = height[wrap(y - 1, size) * size + x];
      const hU = height[wrap(y + 1, size) * size + x];
      let nx = (hL - hR) * scale;
      let ny = (hD - hU) * scale;
      let nz = 1;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
      const o = (y * size + x) * 4;
      out[o] = Math.round((nx * 0.5 + 0.5) * 255);
      out[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      out[o + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      out[o + 3] = 255;
    }
  }
  return out;
}

export function roughnessFromHeight(height, size) {
  const out = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < height.length; i++) {
    // High roughness: StandardMaterial multiplies this by material.roughness,
    // and 140/255 × 0.72 read as wet tarmac.
    const r = 210 + height[i] * 35;
    const o = i * 4;
    out[o] = r;
    out[o + 1] = r;
    out[o + 2] = r;
    out[o + 3] = 255;
  }
  return out;
}
