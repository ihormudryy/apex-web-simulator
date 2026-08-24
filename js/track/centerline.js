// js/track/centerline.js
//
// Resamples a closed polyline into evenly spaced stations and answers "where am
// I relative to the road?" for any world XZ point. Deliberately free of Three.js
// so the physics and its tests can use it directly.
//
// `query` answers for the POINT, not for the nearest station. That distinction
// is the whole load-bearing part of this module: the physics surface — every
// height, camber, roughness and kerb the tyre stands on — is a function of the
// `t` this returns. Handing back the nearest station's own `t` made all of it
// piecewise constant over a 1.47 m tread, so the car drove up a staircase of
// ~18 mm risers, roughly 39 of them a second at 200 km/h. See `query` for the
// measurements that came off it.

/**
 * Circular moving-average of halfWidth / runoff.
 *
 * Waypoint runoff can jump several metres between corners. Linear interpolation
 * along a short segment then puts a 0.5 m lateral step every station into the
 * ribbon edge — which reads as a jagged cliff where asphalt meets grass. A few
 * metres of averaging keeps the authored widths but stops the staircase.
 *
 * @param {Array<{halfWidth:number, runoff:number}>} samples
 * @param {number} [radius=10] stations each side of the window
 */
export function smoothTrackWidths(samples, radius = 10) {
  const n = samples.length;
  if (n < 3 || radius < 1) return samples;
  const hw = new Float64Array(n);
  const run = new Float64Array(n);
  const span = 2 * radius + 1;
  for (let i = 0; i < n; i++) {
    let sumW = 0;
    let sumR = 0;
    for (let d = -radius; d <= radius; d++) {
      const s = samples[(i + d + n) % n];
      sumW += s.halfWidth;
      sumR += s.runoff;
    }
    hw[i] = sumW / span;
    run[i] = sumR / span;
  }
  for (let i = 0; i < n; i++) {
    samples[i].halfWidth = hw[i];
    samples[i].runoff = run[i];
  }
  return samples;
}

/**
 * Cap how fast halfWidth / runoff may change along the lap, metres per station.
 *
 * Smoothing alone leaves a residual ramp whose slope is still a visible sawtooth
 * when the authored jump is large. A forward+backward clamp settles both ways
 * without shifting the mean width.
 *
 * @param {Array<{halfWidth:number, runoff:number}>} samples
 * @param {number} [maxDelta=0.12]
 */
export function limitWidthGradient(samples, maxDelta = 0.12) {
  const n = samples.length;
  if (n < 2 || !(maxDelta > 0)) return samples;
  const pass = (dir) => {
    for (let k = 1; k < n; k++) {
      const i = dir > 0 ? k : n - 1 - k;
      const prev = dir > 0 ? i - 1 : i + 1;
      const lo = samples[prev].runoff - maxDelta;
      const hi = samples[prev].runoff + maxDelta;
      samples[i].runoff = Math.max(lo, Math.min(hi, samples[i].runoff));
      const loW = samples[prev].halfWidth - maxDelta;
      const hiW = samples[prev].halfWidth + maxDelta;
      samples[i].halfWidth = Math.max(loW, Math.min(hiW, samples[i].halfWidth));
    }
  };
  pass(1);
  pass(-1);
  return samples;
}

/**
 * Globally nearest station to a world XZ point.
 *
 * The hinted `query` window is for the car, which moves continuously. An
 * axis-aligned ground grid jumps tens of metres at a time; a stale hint across
 * a hairpin classifies infield verts as on-track and punches rectangular pits.
 */
export function nearestStationIndex(samples, qx, qz) {
  let bestI = 0, bestD2 = Infinity;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const dx = s.x - qx;
    const dz = s.z - qz;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2) { bestD2 = d2; bestI = i; }
  }
  return bestI;
}

const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Blend a per-station field toward the neighbour the point actually sits toward.
 *
 * Exported so that anything placing objects against the edge of the road uses
 * the *same* width the road query reports. When the two disagreed — the planner
 * reading `samples[i].halfWidth` while `query` interpolated — grass tufts came
 * up through the asphalt on the widening exits.
 *
 * @param {number} a value at the nearest station
 * @param {number} b value at the neighbour in the direction of travel
 * @param {number} along signed metres past the nearest station
 * @param {number} spacing metres between stations
 */
export function blendStation(a, b, along, spacing) {
  return a + (b - a) * clamp01(Math.abs(along) / spacing);
}

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
  smoothTrackWidths(samples);
  limitWidthGradient(samples);

  const spacing = length / sampleCount;

  function nearestAt(qx, qz) {
    return nearestStationIndex(samples, qx, qz);
  }

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
    // Where the point sits ALONG the station, not just which station is nearest.
    //
    // `t` used to be `s.t` — the station's own value — which made every function
    // of `t` piecewise constant over a 1.47 m tread. Since the physics surface
    // (`surfaceHeight`, `surfaceRoughness`, `verticalCurvature`, `roadLiftAt`)
    // is entirely a function of `t`, the car was driving up a staircase: flat
    // for a station, then a step of up to 18 mm. At 200 km/h that is 39 vertical
    // steps a second under each tyre, and the four corner loads chattered
    // against it — 994 N to 5192 N frame to frame in a straight line, load
    // direction reversing on 59% of frames. Grip is proportional to load, so it
    // read as a car that darted, bounced and let go at random.
    //
    // Projecting onto the tangent costs two multiplies and makes the surface
    // continuous. The drawn ribbon already interpolates between these same
    // stations, so this is also what puts the physics back on the visible road.
    const dx = qx - s.x;
    const dz = qz - s.z;
    const along = dx * s.tx + dz * s.tz;
    const lateral = -(dx * s.nx + dz * s.nz);
    // Nearest-station keeps |along| within about half a spacing; curvature can
    // push it a little past, so the blend is clamped rather than assumed.
    const nb = samples[(bestI + (along >= 0 ? 1 : -1) + lim) % lim];
    const halfWidth = blendStation(s.halfWidth, nb.halfWidth, along, spacing);
    const runoff = blendStation(s.runoff, nb.runoff, along, spacing);
    const ad = Math.abs(lateral);
    const surface = ad < halfWidth ? 'tarmac' : ad < halfWidth + 1 ? 'kerb' : 'grass';
    // Wrapped into [0, 1): consumers key elevation tables on it and detect a lap
    // by watching it fall, so it has to stay a ring coordinate.
    let t = s.t + along / length;
    t -= Math.floor(t);
    return {
      tangent: { x: s.tx, z: s.tz },
      normal: { x: s.nx, z: s.nz },
      lateral,
      halfWidth,
      surface,
      wallLimit: halfWidth + runoff,
      index: bestI,
      t,
    };
  }

  return { samples, length, spacing, query, nearestStationIndex: nearestAt };
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
