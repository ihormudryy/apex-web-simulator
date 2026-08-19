// Round the corners of a closed control polygon into circular arcs.
//
// A hand-authored corner list is a polygon, and a polygon has zero-radius
// corners: no car can drive one and the swept ribbon folds back on itself on
// the inside of the turn. Replacing every vertex with a tangent circular arc
// gives the centerline a bounded curvature, which is what both the physics
// query and the ribbon mesh need.

const EPS = 1e-9;
// Below this turn the vertex is a straight-through joint. `acos` of a dot product
// near 1 is noise at ~1e-8 rad, and honouring that noise would emit a three-point
// "arc" of coincident vertices for every collinear control point.
const STRAIGHT_ANGLE = 1e-4;
// Consecutive ring points closer than this collapse: degenerate segments give the
// ribbon zero-area triangles and the centerline a zero-length span.
const MIN_POINT_GAP = 1e-3;

function unit(ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const len = Math.hypot(dx, dz) || 1;
  return { x: dx / len, z: dz / len, len };
}

// How far back from the vertex each arc has to start, and the arc geometry.
// A corner turning by `theta` with radius r meets its straights `r*tan(theta/2)`
// before and after the vertex, with the centre `r/cos(theta/2)` along the bisector.
function cornerGeometry(prev, at, next, radius) {
  const tIn = unit(prev.x, prev.z, at.x, at.z);
  const tOut = unit(at.x, at.z, next.x, next.z);
  const cross = tIn.x * tOut.z - tIn.z * tOut.x;
  const dot = Math.max(-1, Math.min(1, tIn.x * tOut.x + tIn.z * tOut.z));
  const theta = Math.acos(dot);
  return {
    tIn, tOut, theta,
    turnSign: cross >= 0 ? 1 : -1,
    setback: radius > 0 ? radius * Math.tan(theta / 2) : 0,
    segIn: tIn.len,
    segOut: tOut.len,
  };
}

/**
 * Fillet a closed ring of control points.
 *
 * @param {Array<{x:number,z:number,radius?:number}>} corners closed ring, first
 *   point NOT repeated at the end. Any other properties (halfWidth, runoff, …)
 *   are carried through onto every point the corner generates.
 * @param {object} [options]
 * @param {number} [options.arcStep=0.5] chord length along an arc, metres. Must stay
 *   well under the station spacing `buildCenterline` resamples to, or the arc
 *   reaches the physics as a stair of straights.
 * @param {number} [options.fitFraction=0.98] fraction of a straight the two arcs
 *   sharing it may consume between them. Below 1 so consecutive arcs never touch.
 * @returns {Array<object>} dense ring ready for `buildCenterline`.
 */
export function filletRing(corners, { arcStep = 0.5, fitFraction = 0.98 } = {}) {
  const n = corners.length;
  if (n < 3) return corners.map(c => ({ ...c }));

  const geo = corners.map((at, i) =>
    cornerGeometry(corners[(i - 1 + n) % n], at, corners[(i + 1) % n], at.radius ?? 0));

  // Shrink setbacks until the two arcs sharing a straight both fit on it. Only
  // ever scales down, so a couple of passes reach a fixed point.
  const setback = geo.map(g => g.setback);
  for (let pass = 0; pass < 8; pass++) {
    const scale = new Array(n).fill(1);
    let tightened = false;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const budget = geo[j].segIn * fitFraction;   // straight from corner i to corner j
      const want = setback[i] + setback[j];
      if (want > budget && want > EPS) {
        const s = budget / want;
        scale[i] = Math.min(scale[i], s);
        scale[j] = Math.min(scale[j], s);
        tightened = true;
      }
    }
    if (!tightened) break;
    for (let i = 0; i < n; i++) setback[i] *= scale[i];
  }

  const ring = [];
  for (let i = 0; i < n; i++) {
    const at = corners[i];
    const g = geo[i];
    const { radius: _ignored, ...carried } = at;
    const T = setback[i];
    const r = g.theta > STRAIGHT_ANGLE ? T / Math.tan(g.theta / 2) : 0;

    if (T <= EPS || g.theta <= STRAIGHT_ANGLE || !Number.isFinite(r)) {
      ring.push({ ...carried, x: at.x, z: at.z, radius: Infinity });
      continue;
    }

    const inX = at.x - g.tIn.x * T, inZ = at.z - g.tIn.z * T;
    // The centre sits r away from the tangent point, perpendicular to the
    // incoming straight, on whichever side the corner turns toward.
    const centreX = inX - g.tIn.z * g.turnSign * r;
    const centreZ = inZ + g.tIn.x * g.turnSign * r;

    const startAngle = Math.atan2(inZ - centreZ, inX - centreX);
    const sweep = g.theta * g.turnSign;
    const steps = Math.max(2, Math.ceil(Math.abs(sweep) * r / arcStep));
    for (let s = 0; s <= steps; s++) {
      const a = startAngle + sweep * (s / steps);
      ring.push({
        ...carried,
        x: centreX + Math.cos(a) * r,
        z: centreZ + Math.sin(a) * r,
        radius: r,
      });
    }
  }
  return dedupe(ring);
}

function dedupe(ring) {
  const out = [];
  for (const p of ring) {
    const last = out[out.length - 1];
    if (last && Math.hypot(p.x - last.x, p.z - last.z) < MIN_POINT_GAP) continue;
    out.push(p);
  }
  while (out.length > 3 &&
         Math.hypot(out[0].x - out[out.length - 1].x, out[0].z - out[out.length - 1].z) < MIN_POINT_GAP) {
    out.pop();
  }
  return out;
}

/** Closed-ring arc length of a polyline. */
export function ringLength(ring) {
  let total = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    total += Math.hypot(b.x - a.x, b.z - a.z);
  }
  return total;
}

/**
 * Uniformly scale the control polygon until the filleted ring is `targetLength`
 * metres round, leaving the authored corner radii in true metres.
 *
 * Growing the polygon while holding the radii fixed only ever lengthens the lap,
 * so a bisection converges.
 */
export function filletToLength(corners, targetLength, options = {}) {
  const at = scale => filletRing(corners.map(c => ({ ...c, x: c.x * scale, z: c.z * scale })), options);

  let lo = 0.1, hi = 10;
  for (let i = 0; i < 40 && ringLength(at(hi)) < targetLength; i++) hi *= 2;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (ringLength(at(mid)) < targetLength) lo = mid; else hi = mid;
  }
  const scale = (lo + hi) / 2;
  const ring = at(scale);
  return { ring, scale, length: ringLength(ring) };
}
