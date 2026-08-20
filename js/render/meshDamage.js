/**
 * Visible damage on the car mesh.
 *
 * The damage model already changes how the car drives; this makes the same
 * state change how it looks, from the same numbers: the front wing droops and
 * crumples with wing damage, a hit corner's wheel collapses onto camber, and
 * the paint loses its polish as the total climbs. Nothing here invents state —
 * every deformation is a pure function of the damage vector, so the mesh
 * always agrees with the physics and with the HUD.
 *
 * Geometry maths only, free of three.js: the region weights and the
 * deformation are testable in Node on plain Float32Arrays, and Car.js owns the
 * scene-graph plumbing.
 *
 * Coordinates are the paint mesh's local frame, measured from the loaded
 * geometry: +z is the nose, the front wing is the low slab at z > ~1.6 with
 * y < ~-0.15, and the whole body spans y -0.53..0.53 about its anchor.
 */

/** Where the wing region starts, and the hinge it droops about. */
export const WING_Z_FROM = 1.55;
export const WING_HINGE_Y = -0.15;
/** Everything below this is fully wing; the nose above gets a partial weight. */
export const WING_Y_FULL = -0.40;

/** Droop angle at full damage, radians. Capped so the wing drags, not buries. */
export const DROOP_FULL = 0.14;
/**
 * Two kinds of crumple, and the split is what makes the damage read right.
 *
 * A COHERENT buckle — a smooth wave over the surface — is what bent carbon
 * looks like: the panel keeps its skin but loses its shape. A per-vertex TEAR
 * rips adjacent vertices apart and reads as shattered. Applying the tear at all
 * damage levels made a 50% wing look like an explosion; real carbon bends and
 * cracks long before it shreds, so the buckle grows with the square of damage
 * and the tear with the cube — visible bend by half damage, shards only near
 * total destruction.
 */
export const BUCKLE_FULL = 0.055;
export const TEAR_FULL = 0.05;
/** The body must not deform below this local y — the ground is just beneath. */
export const Y_FLOOR = -0.62;

const clamp01 = v => Math.max(0, Math.min(1, v));

/** Deterministic per-vertex hash in [-1, 1], so a crumple is the same crumple. */
export function crumpleHash(i, salt) {
  let n = Math.imul(i + 1, 374761393) + Math.imul(salt + 1, 668265263);
  n = (n ^ (n >>> 13)) >>> 0;
  return ((n % 20000) / 10000) - 1;
}

/**
 * Per-vertex wing weights from the base positions. 0 for the body, rising to 1
 * for the wing slab, with smooth edges so the droop does not tear the mesh.
 *
 * Split by side as well, so a left-corner hit can mangle the left side harder —
 * the weights carry (total, leftness) per vertex.
 */
export function wingWeights(positions, count) {
  const weight = new Float32Array(count);
  const leftness = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    const wz = clamp01((z - WING_Z_FROM) / 0.30);
    const wy = clamp01((WING_HINGE_Y - y) / (WING_HINGE_Y - WING_Y_FULL));
    weight[i] = wz * wy;
    // The mesh is mirrored about x = 0; leftness feeds the asymmetry.
    leftness[i] = clamp01(0.5 - x * 1.2);
  }
  return { weight, leftness };
}

/**
 * Write the damaged body into `out` from the pristine `base`.
 *
 * @param {Float32Array} base pristine positions, xyz interleaved
 * @param {Float32Array} out same length, overwritten
 * @param {{weight: Float32Array, leftness: Float32Array}} regions
 * @param {{wing: number, left: number, right: number}} dmg wing damage 0..1 and
 *   the front-corner damages that bias which side hangs lower
 */
export function deformBody(base, out, regions, dmg) {
  const count = regions.weight.length;
  const wing = clamp01(dmg.wing);
  if (wing <= 0) {
    out.set(base);
    return out;
  }
  // Side bias: the side whose corner took the hits droops harder.
  const bias = clamp01(0.5 + 0.5 * (dmg.left - dmg.right));
  const droopL = DROOP_FULL * wing * (0.6 + 0.8 * bias);
  const droopR = DROOP_FULL * wing * (0.6 + 0.8 * (1 - bias));
  const buckle = BUCKLE_FULL * wing * wing;
  const tear = TEAR_FULL * wing * wing * wing;

  for (let i = 0; i < count; i++) {
    const w = regions.weight[i];
    const b = i * 3;
    if (w <= 0) {
      out[b] = base[b];
      out[b + 1] = base[b + 1];
      out[b + 2] = base[b + 2];
      continue;
    }
    const x = base[b];
    const y = base[b + 1];
    const z = base[b + 2];
    const droop = droopL * regions.leftness[i] + droopR * (1 - regions.leftness[i]);
    const a = droop * w;
    // Rotate about the lateral hinge line (y = WING_HINGE_Y, z = WING_Z_FROM):
    // the wing swings down and slightly back, like a wing that has let go.
    const dy = y - WING_HINGE_Y;
    const dz = z - WING_Z_FROM;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    let ny = WING_HINGE_Y + dy * cos - dz * sin;
    let nz = WING_Z_FROM + dy * sin + dz * cos;
    const tip = clamp01((z - WING_Z_FROM) / 1.0);
    // The buckle: smooth waves in the surface, a function of position so
    // neighbouring vertices move together and the skin stays a skin.
    const wave = Math.sin(x * 21 + z * 13) + 0.6 * Math.sin(x * 47 - z * 29);
    const wave2 = Math.sin(x * 33 - z * 19 + 1.7);
    ny += buckle * w * tip * wave;
    nz += buckle * w * tip * wave2 * 0.5;
    // The tear: per-vertex, only meaningful near total destruction.
    ny += tear * w * tip * crumpleHash(i, 3);
    nz += tear * w * tip * crumpleHash(i, 7) * 0.6;
    const nx = x + buckle * w * tip * wave2 * 0.4 + tear * w * tip * crumpleHash(i, 11) * 0.5;
    out[b] = nx;
    out[b + 1] = Math.max(Y_FLOOR, ny);
    out[b + 2] = nz;
  }
  return out;
}

/**
 * How a damaged corner's wheel should sit: camber collapse and a tuck upward,
 * both growing with damage and lurid once the corner is broken.
 *
 * @returns {{ camber: number, lift: number }} radians and metres
 */
export function wheelCollapse(damage) {
  const d = clamp01(damage);
  // Gentle lean below half damage, obviously wrong past it, undriveable at 1.
  const camber = 0.06 * d + 0.28 * d * d;
  const lift = 0.05 * d * d;
  return { camber, lift };
}

/**
 * Paint wear from total damage: roughness up, clearcoat down. Returned as
 * multipliers on the pristine material values so reset restores exactly.
 */
export function paintWear(totalDamage) {
  const t = Math.max(0, Math.min(2.4, totalDamage)) / 2.4;
  return {
    roughnessScale: 1 + 1.1 * t,
    clearcoatScale: 1 - 0.75 * t,
  };
}

/**
 * A cheap signature of the damage state, so the mesh is only rebuilt when the
 * damage actually changed — deforming 50k vertices per frame for a car that has
 * not been hit again would be a fine way to spend the physics budget on nothing.
 */
export function damageSignature(dmg) {
  const q = v => Math.round(v * 64);
  return `${q(dmg.wing)}|${q(dmg.floor)}|${dmg.wheels.map(q).join(',')}`;
}
