/**
 * Distance bands for trackside detail — the arithmetic only, no Three.js.
 *
 * Two things went wrong in the first version of this, and both are decided here.
 *
 * The distance must be measured to the *nearest point* of a piece of geometry,
 * not to its origin or centre. Trackside content is instanced across the whole
 * lap: `catchFencePanels` is one mesh 5.9 km long whose centre sits a kilometre
 * from the car while part of it is a metre away. Measuring to the centre — or, as
 * it happened, to a `THREE.LOD` parked at the world origin — reported ~1011 m for
 * geometry the driver could touch, and every band collapsed to "too far to draw".
 *
 * And detail must fall off by *density*, not by dropping whole objects. Halving
 * the pieces of a chunked set leaves bald stretches that pop as the camera moves.
 */

/** Metres: [full detail below, half detail below, nothing beyond]. */
export const TRACKSIDE_BANDS = {
  grass: [60, 180, 420],
  fence: [120, 260, 620],
  props: [90, 220, 520],
};

/**
 * Distance from a point to the nearest surface of a bounding sphere, clamped at
 * zero for a point inside it.
 */
export function distanceToSphere(px, py, pz, cx, cy, cz, radius) {
  const d = Math.hypot(px - cx, py - cy, pz - cz);
  return Math.max(0, d - radius);
}

/**
 * Fraction of instances to draw at a given distance.
 *
 * @param {number} distance metres to the nearest point of the geometry
 * @param {[number, number, number]} bands full / half / cut-off distances
 * @returns {number} 1, 0.5 or 0
 */
export function densityForDistance(distance, bands) {
  const [full, half, cut] = bands;
  if (!(distance < cut)) return 0;
  if (distance < full) return 1;
  if (distance < half) return 0.5;
  // Between the half band and the cut-off, thin further rather than snapping to
  // nothing — a hard edge at `cut` is visible as a line sweeping over the grass.
  return 0.25;
}

/**
 * Instance count for a mesh at a given distance. Never drops the last instance
 * of something still inside the cut-off, so thin sets do not blink out.
 */
export function instanceCountFor(fullCount, distance, bands) {
  const density = densityForDistance(distance, bands);
  if (density === 0) return 0;
  return Math.max(1, Math.round(fullCount * density));
}

/**
 * Shuffle a chunk's placements so any prefix of them is spread over the whole
 * chunk.
 *
 * The distance LOD thins a chunk by lowering `InstancedMesh.count`, which draws
 * a prefix of the instances. Placements are generated in station order, so an
 * unshuffled prefix covers the first few metres of the chunk at full density and
 * leaves the rest bare. Shuffled, half the count is half the density everywhere.
 *
 * Deterministic (seeded, no `Math.random`) so the scatter is identical run to run.
 */
export function interleaveForThinning(items, seed = 7) {
  const out = items.slice();
  let state = (seed * 2654435761) % 4294967296;
  const next = () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
