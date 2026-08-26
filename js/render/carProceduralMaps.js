// Procedural PBR micro-detail maps for the prototype car.
//
// The repo ships only a small set of base color textures (BodyPaint.jpg,
// Tyre.jpg, etc). For “orange-peel”, clearcoat variation, carbon fiber weave,
// and tyre micro-detail we generate lightweight maps at runtime so the
// renderer can stay self-contained (no new asset download step).

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function hash2(ix, iy, seed) {
  let n = Math.imul(ix + seed * 17, 374761393) + Math.imul(iy + seed * 31, 668265263);
  n = (n ^ (n >>> 13)) >>> 0;
  return (n % 100000) / 100000;
}

function valueNoise(x, y, cells, seed) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(x0, y0, seed);
  const b = hash2(x0 + 1, y0, seed);
  const c = hash2(x0, y0 + 1, seed);
  const d = hash2(x0 + 1, y0 + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

function fbm(x, y, cells, seed) {
  let v = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let o = 0; o < 5; o++) {
    v += amp * valueNoise(x * freq, y * freq, cells * freq, seed + o * 19);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return v / norm;
}

function encodeNormal(nx, ny, nz) {
  // Pack tangent-space normal into RGB in [0,255].
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len; ny /= len; nz /= len;
  return {
    r: Math.round((nx * 0.5 + 0.5) * 255),
    g: Math.round((ny * 0.5 + 0.5) * 255),
    b: Math.round((nz * 0.5 + 0.5) * 255),
  };
}

export function normalFromHeight({ size = 256, strength = 0.9, seed = 1, angle = 0 } = {}) {
  // Height field: procedural orange-peel / micro-bump.
  const data = new Uint8ClampedArray(size * size * 4);
  const ca = Math.cos(angle), sa = Math.sin(angle);
  const eps = 1 / size;
  const cells = 10;

  const heightAt = (u, v) => {
    // Rotate to break up perfectly axis-aligned bumps.
    const x = u * ca - v * sa;
    const y = u * sa + v * ca;
    // Two octaves for coarse orange-peel + finer sparkle.
    return (fbm(x, y, cells, seed) - 0.5) * 2;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const hC = heightAt(u, v);
      const hL = heightAt(u - eps, v);
      const hR = heightAt(u + eps, v);
      const hD = heightAt(u, v - eps);
      const hU = heightAt(u, v + eps);
      // Gradient of height => normal.
      const nx = (hL - hR) * strength;
      const ny = (hD - hU) * strength;
      const nz = 1;
      const o = (y * size + x) * 4;
      const p = encodeNormal(nx, ny, nz);
      data[o] = p.r; data[o + 1] = p.g; data[o + 2] = p.b; data[o + 3] = 255;
    }
  }

  return { data, size };
}

export function roughnessFromNoise({ size = 256, base = 0.32, variance = 0.08, seed = 2 } = {}) {
  const data = new Uint8ClampedArray(size * size * 4);
  const cells = 10;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const n = fbm(u, v, cells, seed);
      const r = clamp(base + (n - 0.5) * 2 * variance, 0.05, 0.9);
      const g = Math.round(r * 255);
      const o = (y * size + x) * 4;
      data[o] = g; data[o + 1] = g; data[o + 2] = g; data[o + 3] = 255;
    }
  }
  return { data, size };
}

export function specularIntensityFromNoise({ size = 256, base = 0.55, variance = 0.12, seed = 16 } = {}) {
  const data = new Uint8ClampedArray(size * size * 4);
  const cells = 8;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const n = fbm(u, v, cells, seed);
      const s = clamp(base + (n - 0.5) * 2 * variance, 0.2, 1);
      const g = Math.round(s * 255);
      const o = (y * size + x) * 4;
      // Three samples `specularIntensityMap` from the ALPHA channel only
      // (`specularIntensityFactor *= texture2D( ... ).a`). Writing the variation
      // to RGB with alpha pinned at 255 multiplies specular by exactly 1.0
      // everywhere — the map allocates a texture and changes nothing. RGB keeps
      // the same value so the map stays inspectable and could feed a
      // specularColorMap, but alpha is the channel that does the work.
      data[o] = g; data[o + 1] = g; data[o + 2] = g; data[o + 3] = g;
    }
  }
  return { data, size };
}

export function metallicFromNoise({ size = 256, base = 0.0, variance = 0.015, seed = 3 } = {}) {
  const data = new Uint8ClampedArray(size * size * 4);
  const cells = 7;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const n = fbm(u, v, cells, seed);
      const m = clamp(base + (n - 0.5) * 2 * variance, 0, 0.06);
      const g = Math.round(m * 255);
      const o = (y * size + x) * 4;
      data[o] = g; data[o + 1] = g; data[o + 2] = g; data[o + 3] = 255;
    }
  }
  return { data, size };
}

export function carbonWeaveNormal({ size = 256, strength = 1.1, seed = 4, weaveFreq = 38 } = {}) {
  // Woven grid of fibers in UV space. The goal is a sharp, “readable” weave
  // under specular.
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;

      // Two fiber directions. Add mild warping for non-perfect weave.
      const warp = (fbm(u * 2, v * 2, 4, seed) - 0.5) * 0.25;
      const a = (u + warp) * weaveFreq * Math.PI * 2;
      const b = (v - warp) * weaveFreq * Math.PI * 2;

      const h = 0.5 * Math.sin(a) + 0.5 * Math.sin(b);

      // Derivatives: sample a small neighborhood.
      const eps = 1 / size;
      const hL = 0.5 * Math.sin((u - eps) * weaveFreq * Math.PI * 2) + 0.5 * Math.sin(v * weaveFreq * Math.PI * 2);
      const hR = 0.5 * Math.sin((u + eps) * weaveFreq * Math.PI * 2) + 0.5 * Math.sin(v * weaveFreq * Math.PI * 2);
      const hD = 0.5 * Math.sin(u * weaveFreq * Math.PI * 2) + 0.5 * Math.sin((v - eps) * weaveFreq * Math.PI * 2);
      const hU = 0.5 * Math.sin(u * weaveFreq * Math.PI * 2) + 0.5 * Math.sin((v + eps) * weaveFreq * Math.PI * 2);

      const nx = (hL - hR) * strength;
      const ny = (hD - hU) * strength;
      const nz = 1;
      const o = (y * size + x) * 4;
      const p = encodeNormal(nx, ny, nz);
      data[o] = p.r; data[o + 1] = p.g; data[o + 2] = p.b; data[o + 3] = 255;
    }
  }
  return { data, size };
}

/**
 * Hue-rotate RGB pixels in place (alpha untouched) — the rival's livery hook.
 *
 * This is the matrix CSS `filter: hue-rotate()` uses (W3C Filter Effects), not
 * an RGB→HSL→RGB round trip. Its rows each sum to 1 for every angle, so any
 * grey pixel (R=G=B — the ink lines, panel shading and rivet shadows baked
 * into BodyPaint.jpg) lands back on itself exactly, at every angle: only the
 * saturated paint moves. An HSL round trip has no such guarantee and would
 * measurably drift the greys as saturation and lightness get re-derived from
 * rounded 8-bit RGB.
 *
 * Called on a canvas copy of the shipped texture, never the source `Image` or
 * a shared `Texture` — each `Car` draws its own copy (see `Car.js`), so two
 * cars never end up pointing at the same recoloured pixels.
 *
 * @param {Uint8ClampedArray} data RGBA, four bytes per pixel, mutated in place
 * @param {number} degrees hue rotation; wraps naturally via sin/cos
 * @returns {Uint8ClampedArray} `data`
 */
export function hueRotateRGBA(data, degrees) {
  const a = (degrees * Math.PI) / 180;
  const cosA = Math.cos(a);
  const sinA = Math.sin(a);
  const m00 = 0.213 + cosA * 0.787 - sinA * 0.213;
  const m01 = 0.715 - cosA * 0.715 - sinA * 0.715;
  const m02 = 0.072 - cosA * 0.072 + sinA * 0.928;
  const m10 = 0.213 - cosA * 0.213 + sinA * 0.143;
  const m11 = 0.715 + cosA * 0.285 + sinA * 0.140;
  const m12 = 0.072 - cosA * 0.072 - sinA * 0.283;
  const m20 = 0.213 - cosA * 0.213 - sinA * 0.787;
  const m21 = 0.715 - cosA * 0.715 + sinA * 0.715;
  const m22 = 0.072 + cosA * 0.928 + sinA * 0.072;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    data[i]     = m00 * r + m01 * g + m02 * b;
    data[i + 1] = m10 * r + m11 * g + m12 * b;
    data[i + 2] = m20 * r + m21 * g + m22 * b;
  }
  return data;
}

export function tyreMicroNormalAndRoughness({
  size = 256, seed = 6, grooveFreq = 18, grainFreq = 60,
} = {}) {
  const normal = new Uint8ClampedArray(size * size * 4);
  const rough = new Uint8ClampedArray(size * size * 4);
  const eps = 1 / size;

  const heightAt = (u, v) => {
    // Two patterns: circumferential grooves (U-ish) and longitudinal texture (V-ish)
    // in UV space. This is not a perfect cylinder unwrapping, but it yields
    // believable spec breakup at any camera angle.
    const grooves = Math.sin((u + seed * 0.001) * Math.PI * 2 * grooveFreq);
    const ribs = Math.sin((v + seed * 0.002) * Math.PI * 2 * grooveFreq * 0.5);
    const grain = fbm(u * grainFreq / 10, v * grainFreq / 10, 8, seed);
    return 0.45 * grooves + 0.25 * ribs + (grain - 0.5) * 0.35;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const hL = heightAt(u - eps, v);
      const hR = heightAt(u + eps, v);
      const hD = heightAt(u, v - eps);
      const hU = heightAt(u, v + eps);
      // Softer normal amplitude: real tyres are matte; we want readable
      // grooves without “chrome” specular.
      const nx = (hL - hR) * 0.65;
      const ny = (hD - hU) * 0.65;
      const nz = 1;
      const o = (y * size + x) * 4;
      const p = encodeNormal(nx, ny, nz);
      normal[o] = p.r; normal[o + 1] = p.g; normal[o + 2] = p.b; normal[o + 3] = 255;

      // Roughness: slightly rougher toward the edges of the tread in V.
      const edge = Math.abs(v - 0.5) * 2;
      const g = heightAt(u, v);
      // High roughness: tyres should never look mirror-polished.
      const r = clamp(0.82 + edge * 0.03 + (g - 0.0) * 0.02, 0.65, 0.98);
      const q = Math.round(r * 255);
      rough[o] = q; rough[o + 1] = q; rough[o + 2] = q; rough[o + 3] = 255;
    }
  }

  return { normal: { data: normal, size }, roughness: { data: rough, size } };
}

