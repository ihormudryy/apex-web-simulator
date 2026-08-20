/**
 * Procedural Armco for the barriers: albedo, normal and roughness from one
 * height model, in the repo's usual pattern — pure functions over pixels, so
 * the maps are testable in Node and there is nothing to download.
 *
 * The look is a galvanised W-beam guardrail, which is what the barrier
 * geometry already is: two horizontal corrugations, panels lapped every few
 * metres with a pair of carriage bolts at each seam, posts behind, and the
 * weathering that tells you which way is down — grime settling along the
 * valleys, streaks under the bolts, dirt kicked up at the bottom edge.
 *
 * One texture tile spans one panel (`PANEL_METRES`) horizontally and the full
 * rail height vertically; the geometry tiles it along the wall.
 */

const TAU = Math.PI * 2;

/** One tile = one Armco panel. Real panels are 3.81 m; 4 keeps the UV maths flat. */
export const PANEL_METRES = 4;
/** The wall mesh is 1.1 m tall. */
export const RAIL_HEIGHT = 1.1;

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

/**
 * The W-beam cross-section as a height profile over v (0 bottom, 1 top), metres
 * of relief. Two corrugations with a valley between — the "W" seen end-on — and
 * rolled edges top and bottom. This one function drives the normal map AND the
 * crest/valley logic in the albedo and roughness, so the shading and the
 * weathering cannot disagree about where the humps are.
 */
export function beamProfile(v) {
  const hump = (c, w) => Math.exp(-((v - c) * (v - c)) / (2 * w * w));
  return 0.055 * (hump(0.30, 0.10) + hump(0.72, 0.10)) - 0.02 * hump(0.51, 0.06);
}

/** Bolt positions on a panel seam, as v coordinates: one bolt per corrugation. */
export const BOLT_V = [0.30, 0.72];
/** How wide the lap joint at each panel seam is, as a fraction of the panel. */
export const SEAM_FRACTION = 0.045;

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/** Distance to the nearest panel seam, in u-fraction (seams at u = 0 and 1). */
const seamDist = u => Math.min(u, 1 - u);

/** Bolt bump height at (u, v), metres of relief. */
function boltRelief(u, v) {
  const du = seamDist(u) / SEAM_FRACTION;
  if (du > 1.2) return 0;
  let relief = 0;
  for (const bv of BOLT_V) {
    const dv = (v - bv) / 0.05;
    const d2 = du * du * 2.2 + dv * dv;
    if (d2 < 1) relief += 0.012 * (1 - d2) * (1 - d2);
  }
  return relief;
}

/** Full relief model: beam profile + panel lap + bolts + dents. */
export function reliefAt(u, v, w = 256) {
  let hgt = beamProfile(v);
  // The lap joint: the overlapping panel end sits proud of the one beneath.
  if (seamDist(u) < SEAM_FRACTION) hgt += 0.006;
  hgt += boltRelief(u, v);
  // Service dents: shallow, sparse, remembered per tile position.
  const dent = valueNoise(u * 6, v * 3, 6, 97);
  if (dent > 0.82) hgt -= 0.010 * (dent - 0.82) / 0.18;
  void w;
  return hgt;
}

/**
 * Albedo, RGBA. Galvanised steel: cool grey with the spangle mottle, whitened
 * crests where traffic film has been polished off, grime in the valleys and
 * along the bottom, rust bleeding below the bolts.
 */
export function armcoAlbedo(w, h) {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const v = 1 - y / (h - 1);          // v = 1 at the top of the rail
    const profile = beamProfile(v);
    const crest = clamp(profile / 0.055, 0, 1);
    for (let x = 0; x < w; x++) {
      const u = x / w;
      // Galvanic spangle: two scales of mottle.
      const spangle = 0.5 * valueNoise(u * 24, v * 8, 24, 11)
        + 0.5 * valueNoise(u * 96, v * 32, 96, 23);
      let r = 148 + 26 * spangle + 22 * crest;
      let g = 152 + 26 * spangle + 22 * crest;
      let b = 158 + 26 * spangle + 20 * crest;

      // Grime settles where the profile is lowest, and along the bottom edge.
      const valley = 1 - crest;
      const bottom = clamp((0.18 - v) / 0.18, 0, 1);
      const grime = clamp(0.28 * valley + 0.55 * bottom * bottom, 0, 1)
        * (0.7 + 0.3 * valueNoise(u * 40, v * 6, 40, 37));
      r *= 1 - 0.45 * grime;
      g *= 1 - 0.44 * grime;
      b *= 1 - 0.40 * grime;

      // Rust streaks running DOWN from the bolts — weathering knows which way
      // gravity points, and that is most of what makes a texture read as real.
      for (const bv of BOLT_V) {
        const below = bv - v;
        if (below > 0 && below < 0.45 && seamDist(u) < SEAM_FRACTION * 2.4) {
          const fade = (1 - below / 0.45)
            * (1 - seamDist(u) / (SEAM_FRACTION * 2.4))
            * (0.5 + 0.5 * valueNoise(u * 90, v * 30, 90, 53));
          r = r * (1 - 0.5 * fade) + 122 * 0.5 * fade;
          g = g * (1 - 0.5 * fade) + 70 * 0.5 * fade;
          b = b * (1 - 0.5 * fade) + 44 * 0.5 * fade;
        }
      }

      const i = (y * w + x) * 4;
      out[i] = clamp(Math.round(r), 0, 255);
      out[i + 1] = clamp(Math.round(g), 0, 255);
      out[i + 2] = clamp(Math.round(b), 0, 255);
      out[i + 3] = 255;
    }
  }
  return out;
}

/**
 * Normal map, RGBA, +Y up in texture space. Derived from `reliefAt` by central
 * differences, so the corrugation the light shows is the same one the albedo
 * weathers around.
 */
export function armcoNormal(w, h, strength = 5.5) {
  const out = new Uint8Array(w * h * 4);
  const duStep = 1 / w;
  const dvStep = 1 / h;
  for (let y = 0; y < h; y++) {
    const v = 1 - y / (h - 1);
    for (let x = 0; x < w; x++) {
      const u = x / w;
      const dhdu = (reliefAt((u + duStep) % 1, v) - reliefAt((u - duStep + 1) % 1, v)) / (2 * duStep);
      const dhdv = (reliefAt(u, clamp(v + dvStep, 0, 1)) - reliefAt(u, clamp(v - dvStep, 0, 1))) / (2 * dvStep);
      // Tangent-space normal; v runs up the rail, texture y runs down.
      const nx = -dhdu * strength;
      const ny = dhdv * strength;
      const inv = 1 / Math.hypot(nx, ny, 1);
      const i = (y * w + x) * 4;
      out[i] = clamp(Math.round(128 + 127 * nx * inv), 0, 255);
      out[i + 1] = clamp(Math.round(128 + 127 * ny * inv), 0, 255);
      out[i + 2] = clamp(Math.round(128 + 127 * inv), 0, 255);
      out[i + 3] = 255;
    }
  }
  return out;
}

/**
 * Roughness in G (the channel MeshStandardMaterial reads). Polished on the
 * crests where everything that ever brushed the rail has burnished it, matte in
 * the grimy valleys and along the bottom.
 */
export function armcoRoughness(w, h) {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const v = 1 - y / (h - 1);
    const crest = clamp(beamProfile(v) / 0.055, 0, 1);
    for (let x = 0; x < w; x++) {
      const u = x / w;
      const bottom = clamp((0.18 - v) / 0.18, 0, 1);
      const noise = valueNoise(u * 48, v * 12, 48, 71);
      const rough = clamp(0.62 - 0.24 * crest + 0.25 * bottom + 0.10 * (noise - 0.5), 0.2, 0.95);
      const i = (y * w + x) * 4;
      out[i] = 128;
      out[i + 1] = Math.round(rough * 255);
      out[i + 2] = 128;
      out[i + 3] = 255;
    }
  }
  return out;
}
