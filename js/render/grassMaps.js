/**
 * Tileable grass height → albedo. Normals and roughness reuse the asphalt
 * converters so a lawn and the tarmac share the same packing.
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

function fbm(x, y, cells, seed, octaves = 6) {
  let v = 0, amp = 0.5, freq = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    v += amp * valueNoise(x * freq, y * freq, cells * freq, seed + o * 19);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return v / norm;
}

/** @param {number} [size=1024] */
export function tileableGrassHeight(size = 1024, seed = 9) {
  const height = new Float32Array(size * size);
  // More cells + blade noise so 1k/2k maps resolve individual blades, not blotches.
  const cells = Math.max(24, Math.round(size / 32));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size * cells;
      const v = (y + 0.5) / size * cells;
      const clumps = fbm(u, v, cells, seed, 6);
      const blades = valueNoise(u * 18, v * 26, cells * 26, seed + 3);
      const fine = valueNoise(u * 48, v * 52, cells * 52, seed + 7);
      height[y * size + x] = clumps * 0.48 + blades * 0.36 + fine * 0.16;
    }
  }
  return height;
}

/**
 * Grass albedo in sRGB, ready to use with a neutral material colour.
 *
 * These values are the finished lawn colour, so the material must keep
 * `color: 0xffffff`. Tinting an already-green map with a green colour multiplies
 * the greens and crushes red and blue: 0x6ad05a over the old map landed on
 * (12, 80, 16), which is emerald astroturf, not grass. Real mown grass is a
 * desaturated olive — red and blue stay clearly present.
 */
export function grassAlbedoFromHeight(height, size) {
  const out = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < height.length; i++) {
    const h = height[i];
    const o = i * 4;
    out[o] = 62 + h * 34;
    out[o + 1] = 82 + h * 42;
    out[o + 2] = 44 + h * 26;
    out[o + 3] = 255;
  }
  return out;
}

/**
 * Slow world-space albedo multiply for the horizon lawn.
 * Breaks the tiled 1k grass stamp without a second texture fetch.
 *
 * @returns {{r:number,g:number,b:number}}
 */
export function grassFieldTint(x, z) {
  const patches = fbm(x * 0.011, z * 0.011, 64, 41, 4);
  const streaks = valueNoise(x * 0.0035, z * 0.0035, 32, 73);
  return {
    r: 0.88 + streaks * 0.16,
    g: 0.9 + patches * 0.18,
    b: 0.86 + patches * 0.12,
  };
}
