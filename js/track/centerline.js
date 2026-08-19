// js/track/centerline.js
//
// Resamples a closed polyline into evenly spaced stations and answers "where am
// I relative to the road?" for any world XZ point. Deliberately free of Three.js
// so the physics and its tests can use it directly.

export function buildCenterline(waypoints, sampleCount = 4000) {
  const n = waypoints.length;
  const accum = [0];
  for (let i = 0; i < n; i++) {
    const a = waypoints[i], b = waypoints[(i + 1) % n];
    const dx = b.x - a.x, dz = b.z - a.z;
    accum.push(accum[i] + Math.hypot(dx, dz));
  }
  const length = accum[n];
  const samples = new Array(sampleCount);
  // `s` climbs monotonically, so the segment cursor only ever moves forward:
  // walking it alongside keeps this O(n + sampleCount) for dense rings.
  let seg = 0;
  for (let i = 0; i < sampleCount; i++) {
    const s = (i / sampleCount) * length;
    while (seg < n - 1 && accum[seg + 1] < s) seg++;
    const a = waypoints[seg], b = waypoints[(seg + 1) % n];
    const span = accum[seg + 1] - accum[seg] || 1;
    const u = (s - accum[seg]) / span;
    const x = a.x + (b.x - a.x) * u;
    const z = a.z + (b.z - a.z) * u;
    const tx = (b.x - a.x) / span;
    const tz = (b.z - a.z) / span;
    const nx = -tz, nz = tx;
    samples[i] = {
      x, z, tx, tz, nx, nz,
      halfWidth: a.halfWidth + (b.halfWidth - a.halfWidth) * u,
      runoff: a.runoff + (b.runoff - a.runoff) * u,
      t: i / sampleCount,
    };
  }

  const spacing = length / sampleCount;

  function query(qx, qz, hintIndex = 0) {
    const lim = samples.length;
    let bestI = 0, bestD2 = Infinity;
    const window = 80;
    const start = ((hintIndex % lim) + lim) % lim;
    const consider = (i) => {
      const s = samples[i];
      const d2 = (s.x - qx) ** 2 + (s.z - qz) ** 2;
      if (d2 < bestD2) { bestD2 = d2; bestI = i; }
    };
    for (let d = 0; d <= window; d++) {
      consider((start + d) % lim);
      if (d) consider((start - d + lim) % lim);
    }
    const hw0 = samples[bestI].halfWidth + samples[bestI].runoff + 40;
    if (bestD2 > hw0 * hw0) {
      for (let i = 0; i < lim; i++) consider(i);
    }
    const s = samples[bestI];
    const lateral = -((qx - s.x) * s.nx + (qz - s.z) * s.nz);
    const ad = Math.abs(lateral);
    const surface = ad < s.halfWidth ? 'tarmac' : ad < s.halfWidth + 1 ? 'kerb' : 'grass';
    return {
      tangent: { x: s.tx, z: s.tz },
      normal: { x: s.nx, z: s.nz },
      lateral,
      halfWidth: s.halfWidth,
      surface,
      wallLimit: s.halfWidth + s.runoff,
      index: bestI,
      t: s.t,
    };
  }

  return { samples, length, spacing, query };
}

/**
 * Radius of the tightest turn the centerline makes, in metres.
 *
 * This is the number that decides whether the circuit is driveable at all: a
 * turn of `dθ` over `ds` metres demands `v²·dθ/ds` of lateral acceleration, so
 * a zero radius is a wall at any speed.
 *
 * Measured over a car length rather than station-to-station. Arcs reach the
 * station table as chords, and whether a station happens to straddle one chord
 * junction or two is an artefact of the tessellation, not of the road.
 */
export function minCurvatureRadius(centerline, baseline = 4) {
  return Math.min(...curvatureRadii(centerline, baseline));
}

/** Per-station turn radius, in metres. `Infinity` on a straight. */
export function curvatureRadii(centerline, baseline = 4) {
  const { samples, spacing } = centerline;
  const w = Math.max(1, Math.round(baseline / spacing));
  const span = w * spacing;
  return samples.map((a, i) => {
    const b = samples[(i + w) % samples.length];
    const dot = Math.max(-1, Math.min(1, a.tx * b.tx + a.tz * b.tz));
    const turn = Math.acos(dot);
    return turn > 1e-9 ? span / turn : Infinity;
  });
}

/** Largest heading change between adjacent stations, in radians. */
export function maxTangentJump(centerline) {
  const { samples } = centerline;
  let worst = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = samples[i], b = samples[(i + 1) % samples.length];
    const dot = Math.max(-1, Math.min(1, a.tx * b.tx + a.tz * b.tz));
    worst = Math.max(worst, Math.acos(dot));
  }
  return worst;
}
