/**
 * Procedural wear for white track markings — rubber pickup, scuffs, and soft
 * edges so the lines read painted on asphalt rather than flat quads.
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
  for (let o = 0; o < 4; o++) {
    v += amp * valueNoise(x * freq, y * freq, cells * freq, seed + o * 13);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return v / norm;
}

/** Soft falloff toward the strip edges (v in 0–1 across the ribbon width). */
function edgeFade(v) {
  const d = Math.min(v, 1 - v) * 2;
  return Math.min(1, Math.max(0, d * 1.35));
}

/**
 * @param {number} width pixels along the lap
 * @param {number} height pixels across the ribbon
 * @param {number} [seed]
 * @returns {Uint8ClampedArray} RGBA sRGB albedo
 */
export function lineWearAlbedo(width, height, seed = 5) {
  const out = new Uint8ClampedArray(width * height * 4);
  const cells = 24;
  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    const edge = edgeFade(v);
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const grain = fbm(u * cells, v * cells * 0.35, cells, seed);
      const scuff = fbm(u * cells * 2.2 + 17, v * 3 + 4, cells, seed + 3);
      const rubber = fbm(u * cells * 0.6 + 5, v * 0.2, cells, seed + 9);
      const rubberMask = rubber > 0.62 ? (rubber - 0.62) * 2.8 : 0;
      let lum = 238 - scuff * 42 - rubberMask * 95;
      lum *= 0.72 + grain * 0.28;
      lum *= 0.82 + edge * 0.18;
      const i = (y * width + x) * 4;
      out[i] = lum;
      out[i + 1] = lum * 0.99;
      out[i + 2] = lum * 0.96;
      out[i + 3] = 255;
    }
  }
  return out;
}

/**
 * @param {number} width
 * @param {number} height
 * @param {number} [seed]
 * @returns {Uint8ClampedArray} RGBA linear roughness map
 */
export function lineWearRoughness(width, height, seed = 5) {
  const out = new Uint8ClampedArray(width * height * 4);
  const cells = 24;
  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    const edge = 1 - edgeFade(v) * 0.25;
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const scuff = fbm(u * cells * 2, v * 2, cells, seed + 1);
      const rubber = fbm(u * cells * 0.6, v * 0.2, cells, seed + 9);
      const rubberMask = rubber > 0.62 ? (rubber - 0.62) * 2.8 : 0;
      const rough = Math.min(255, Math.max(0, (185 + scuff * 50 + rubberMask * 35) * edge));
      const i = (y * width + x) * 4;
      out[i] = out[i + 1] = out[i + 2] = rough;
      out[i + 3] = 255;
    }
  }
  return out;
}
