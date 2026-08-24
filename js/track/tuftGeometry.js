/**
 * Tuft card geometry and clump texture as plain numbers — no Three.js, so the
 * shapes can be unit-tested. `grassTufts.js` wraps these into buffers and a
 * material. Same split as `tracksidePlacements.js`: rules here, scene there.
 */

/** Tuft card size in metres. The wind shader needs TUFT_H as a compile constant. */
export const TUFT_W = 0.16;
export const TUFT_H = 0.30;

/** Crossed planes per tuft. Three reads better than two from a low chase camera. */
export const TUFT_PLANES = 3;

const clamp01 = v => Math.max(0, Math.min(1, v));

function hash(n) {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * Alpha/colour for one clump of blades, as flat RGBA.
 *
 * A single tapered triangle is a leaf, not grass. This lays down several blades
 * of differing height, lean and width, and darkens toward the root so the clump
 * reads as having depth rather than being a flat decal.
 *
 * @returns {{ data: Uint8Array, size: number }}
 */
export function tuftClumpTexture({ size = 256, blades = 11, seed = 3 } = {}) {
  const data = new Uint8Array(size * size * 4);
  const spec = [];
  for (let b = 0; b < blades; b++) {
    const r = i => hash(seed * 71 + b * 13 + i);
    spec.push({
      root: 0.14 + (b + r(1) * 0.6) / blades * 0.72,
      lean: (r(2) - 0.5) * 0.42,
      height: 0.55 + r(3) * 0.45,
      halfWidth: 0.022 + r(4) * 0.028,
      shade: 0.78 + r(5) * 0.22,
    });
  }

  for (let y = 0; y < size; y++) {
    // v = 0 at the root, 1 at the top of the card.
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      let alpha = 0;
      // Colour is taken from the nearest blade whether or not this texel is
      // covered. Leaving RGB at 0 in the transparent regions makes the mip
      // chain blend every blade edge toward black, and at any distance the
      // tufts turn into charcoal spikes — the alpha channel hides the black,
      // the filtering does not.
      let near = spec[0];
      let nearDist = Infinity;
      let nearT = 1;
      for (const b of spec) {
        const t = Math.min(1, v / b.height);
        const centre = b.root + b.lean * Math.pow(t, 1.35);
        const d = Math.abs(u - centre);
        if (d < nearDist) { nearDist = d; near = b; nearT = t; }
        if (v > b.height) continue;
        const halfW = b.halfWidth * Math.pow(1 - t, 0.55);
        if (halfW <= 0) continue;
        // Soft edge over roughly one texel so the alpha test does not stair-step.
        const a = clamp01((halfW - d) / (1.2 / size) + 0.5);
        if (a > alpha) alpha = a;
      }
      // Root shadow: blades occlude each other near the ground.
      const root = 0.72 + 0.28 * clamp01(v / 0.30);
      const k = near.shade * root;
      // sRGB ramp from a dark root to a sunlit tip, straddling the lawn's own
      // (79, 103, 57) so the tufts read as the same species growing out of it.
      const ramp = (a, b) => a + (b - a) * nearT;
      const o = (y * size + x) * 4;
      data[o]     = Math.round(Math.min(255, ramp(72, 158) * k));
      data[o + 1] = Math.round(Math.min(255, ramp(94, 196) * k));
      data[o + 2] = Math.round(Math.min(255, ramp(52, 110) * k));
      data[o + 3] = Math.round(alpha * 255);
    }
  }
  return { data, size };
}

/**
 * Crossed-plane tuft geometry as plain arrays.
 *
 * Each plane's U must run along that plane's own horizontal axis. Deriving U
 * from world `x` works for the x-aligned plane and collapses every other plane
 * to a single texel column — which renders the card as a solid slab of whatever
 * alpha sits at that column. Here U comes from the vertex's offset along the
 * plane's in-plane axis, so every plane samples the full blade shape.
 *
 * Each plane carries both windings over one set of vertices. With `FrontSide`,
 * exactly one winding survives backface culling from any viewpoint, which lets
 * the normals stay upward instead of being flipped for back faces the way
 * `DoubleSide` would.
 */
export function tuftPlaneGeometryData({
  width = TUFT_W, height = TUFT_H, planes = TUFT_PLANES,
} = {}) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];

  for (let p = 0; p < planes; p++) {
    const a = (Math.PI * p) / planes;
    const ax = Math.cos(a);
    const az = Math.sin(a);
    const base = positions.length / 3;

    for (const [side, v] of [[-1, 0], [1, 0], [-1, 1], [1, 1]]) {
      positions.push(ax * width * side, height * v, az * width * side);
      uvs.push(side * 0.5 + 0.5, v);
      // Mostly up, tilted outward with U so the clump shades as a round mass
      // rather than a flat plate. Never downward, from either side.
      const nx = ax * side * 0.55;
      const nz = az * side * 0.55;
      const len = Math.hypot(nx, 1, nz);
      normals.push(nx / len, 1 / len, nz / len);
    }
    indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
    indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
  }
  return { positions, normals, uvs, indices };
}
