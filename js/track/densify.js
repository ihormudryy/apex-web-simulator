/**
 * Densify a closed ring of survey points into a smooth dense ring.
 *
 * The surveyed centerline arrives at ~5 m spacing; fed straight to
 * `buildCenterline` that is a polygon with 5 m facets, and the tangent the
 * physics reads would step at every facet joint. A uniform Catmull-Rom
 * through the points (the survey spacing is uniform, so the uniform variant
 * is appropriate) interpolates every survey point exactly while giving the
 * generator sub-metre segments with continuous heading. Widths and runoff
 * interpolate linearly alongside.
 */

/** Catmull-Rom basis at parameter u for the segment p1→p2. */
function cr(a, b, c, d, u) {
  const u2 = u * u, u3 = u2 * u;
  return 0.5 * (
    2 * b
    + (-a + c) * u
    + (2 * a - 5 * b + 4 * c - d) * u2
    + (-a + 3 * b - 3 * c + d) * u3
  );
}

/**
 * @param {Array<{x:number,z:number,halfWidth:number,runoff:number}>} ring
 *   closed ring, first point NOT repeated at the end
 * @param {number} [step=0.75] target spacing of the output, metres
 * @returns {Array<{x:number,z:number,halfWidth:number,runoff:number}>}
 */
export function densifyRing(ring, step = 0.75) {
  const n = ring.length;
  if (n < 4) return ring.map(p => ({ ...p }));
  const out = [];
  for (let i = 0; i < n; i++) {
    const p0 = ring[(i - 1 + n) % n];
    const p1 = ring[i];
    const p2 = ring[(i + 1) % n];
    const p3 = ring[(i + 2) % n];
    const segLen = Math.hypot(p2.x - p1.x, p2.z - p1.z);
    const m = Math.max(1, Math.round(segLen / step));
    for (let k = 0; k < m; k++) {
      const u = k / m;
      out.push({
        x: cr(p0.x, p1.x, p2.x, p3.x, u),
        z: cr(p0.z, p1.z, p2.z, p3.z, u),
        halfWidth: p1.halfWidth + (p2.halfWidth - p1.halfWidth) * u,
        runoff: p1.runoff + (p2.runoff - p1.runoff) * u,
      });
    }
  }
  return out;
}
