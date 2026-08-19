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
  const cells = 8;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size * cells;
      const v = (y + 0.5) / size * cells;
      const coarse = fbm(u, v, cells, seed);
      const stones = valueNoise(u * 6, v * 6, cells * 6, seed + 7);
      height[y * size + x] = coarse * 0.75 + stones * 0.25;
    }
  }
  return height;
}

export function albedoFromHeight(height, size) {
  const out = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < height.length; i++) {
    const h = height[i];
    const grey = 38 + h * 28;
    const o = i * 4;
    out[o] = grey;
    out[o + 1] = grey * 0.98;
    out[o + 2] = grey * 0.94;
    out[o + 3] = 255;
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
    const r = 140 + height[i] * 55;
    const o = i * 4;
    out[o] = r;
    out[o + 1] = r;
    out[o + 2] = r;
    out[o + 3] = 255;
  }
  return out;
}
