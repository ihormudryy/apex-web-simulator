/**
 * Tileable gravel / dirt for the runoff strip between kerb and lawn.
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

function fbm(x, y, cells, seed, octaves = 5) {
  let v = 0, amp = 0.5, freq = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    v += amp * valueNoise(x * freq, y * freq, cells * freq, seed + o * 13);
    norm += amp;
    amp *= 0.52;
    freq *= 2.1;
  }
  return v / norm;
}

/** @param {number} [size=512] */
export function tileableGravelHeight(size = 512, seed = 29) {
  const height = new Float32Array(size * size);
  const cells = Math.max(16, Math.round(size / 24));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size * cells;
      const v = (y + 0.5) / size * cells;
      const base = fbm(u, v, cells, seed, 5);
      const pebbles = fbm(u * 3.7 + 2.1, v * 3.7 - 1.4, cells * 3, seed + 7, 3);
      height[y * size + x] = base * 0.65 + pebbles * 0.35;
    }
  }
  return height;
}

/** Warm grey-brown gravel albedo from a height field. */
export function gravelAlbedoFromHeight(height, size) {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const h = height[i];
    const stone = 0.34 + h * 0.22;
    const dust = 0.08 * (1 - h);
    const r = Math.round((stone + dust * 1.1) * 255);
    const g = Math.round((stone * 0.92 + dust * 0.85) * 255);
    const b = Math.round((stone * 0.78 + dust * 0.55) * 255);
    const o = i * 4;
    data[o] = r;
    data[o + 1] = g;
    data[o + 2] = b;
    data[o + 3] = 255;
  }
  return data;
}
