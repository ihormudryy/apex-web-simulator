/**
 * The track surface as a three-dimensional thing.
 *
 * The circuit was a flat ribbon: `y = 0` everywhere, with layered strips at
 * millimetre offsets, and a single surface type sampled for the whole car. For a
 * simulator that is the largest remaining gap after the tyre, because the surface
 * *is* what the tyre talks to. Bumps are most of what makes a real circuit
 * recognisable to drive, and a kerb that changes a friction coefficient rather
 * than hitting the suspension is not a kerb.
 *
 * Four contributions, and they are separate because they behave differently:
 *
 *   1. **Elevation** along the lap — slow, metres, and mostly felt as gradient.
 *   2. **Cross-slope** — banking, plus the drainage crown every real road has.
 *   3. **Bumps** — centimetres, metres of wavelength, and different on the two
 *      sides of the car, which is what makes them upset the platform.
 *   4. **Kerbs** — real geometry with a real height and real serrations.
 *
 * Free of three.js, because both the physics and the mesh builder use it and they
 * must agree exactly. A visual bump that the tyre cannot feel is worse than no
 * bump at all.
 */

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Elevation along the lap
// ---------------------------------------------------------------------------

/**
 * Silverstone elevation, metres, against lap fraction.
 *
 * A former airfield, so it is flat by the standards of a real road circuit —
 * about 12 m from lowest to highest, where Spa has 100. Gradients peak near 3%. But it is not flat, and
 * the parts that are not are the parts drivers talk about: the drop into Farm, the
 * climb to Village, the fall through Becketts, and the rise back to Abbey.
 *
 * Approximate. The shape matters more than the survey: what a driver feels is the
 * gradient and its rate of change, not the absolute number.
 */
export const SILVERSTONE_ELEVATION = [
  // Lap fractions follow the surveyed centerline (silverstoneSurvey.js): the
  // corners sit at their measured stations — Village/Loop at 763/906 m,
  // Hangar Straight the 830 m gap after Chapel, Vale's chicane at ~5.4 km.
  // The interpolators assume the first anchor sits at t = 0 exactly.
  { t: 0.000, y: 9.30 },   // the grid, climbing toward Abbey
  { t: 0.042, y: 10.64 },   // Abbey — the high point
  { t: 0.076, y: 6.48 },   // Farm Curve, dropping
  { t: 0.130, y: 0.02 },   // Village, at the bottom
  { t: 0.154, y: 1.64 },   // The Loop
  { t: 0.185, y: 5.10 },   // Aintree, climbing
  { t: 0.240, y: 8.79 },   // Wellington Straight
  { t: 0.298, y: 6.95 },   // Brooklands, dropping in
  { t: 0.325, y: 5.79 },   // Luffield
  { t: 0.358, y: 8.56 },   // Woodcote, rising
  { t: 0.390, y: 12.02 },   // Copse — high
  { t: 0.500, y: 9.25 },   // Maggotts
  { t: 0.600, y: 4.18 },   // Becketts, falling through
  { t: 0.685, y: 2.33 },   // Chapel
  { t: 0.760, y: 3.72 },   // Hangar Straight
  { t: 0.826, y: 6.25 },   // Stowe
  { t: 0.915, y: 3.25 },   // Vale, the dip
  { t: 0.957, y: 6.72 },   // Club, climbing back
];

/**
 * Periodic Catmull-Rom through the control points.
 *
 * C¹ continuity is not a nicety here. Linear interpolation between control points
 * puts a gradient discontinuity at every one of them, and a gradient
 * discontinuity is a step in the suspension input — seventeen invisible kerb
 * strikes a lap, at exactly the places the elevation was meant to be smooth.
 */
export function elevationAt(t, points = SILVERSTONE_ELEVATION) {
  const n = points.length;
  const u = ((t % 1) + 1) % 1;
  // Locate the span. Control points are sorted, and there are few enough that a
  // linear scan beats the branch cost of a binary search.
  let i = n - 1;
  for (let k = 0; k < n; k++) {
    const next = (k + 1) % n;
    const tk = points[k].t;
    const tn = next === 0 ? 1 : points[next].t;
    if (u >= tk && u < tn) { i = k; break; }
  }
  const p0 = points[(i - 1 + n) % n];
  const p1 = points[i];
  const p2 = points[(i + 1) % n];
  const p3 = points[(i + 2) % n];
  const t1 = p1.t;
  const t2 = (i + 1) % n === 0 ? 1 : p2.t;
  const s = (u - t1) / Math.max(t2 - t1, 1e-9);
  return catmullRom(p0.y, p1.y, p2.y, p3.y, s);
}

function catmullRom(a, b, c, d, s) {
  const s2 = s * s;
  const s3 = s2 * s;
  return 0.5 * (
    2 * b
    + (-a + c) * s
    + (2 * a - 5 * b + 4 * c - d) * s2
    + (-a + 3 * b - 3 * c + d) * s3
  );
}

/**
 * Vertical curvature of the elevation profile, 1/m. Positive is a compression,
 * negative a crest.
 *
 * Taken from the smooth profile only. The bumps reach the car through the plane
 * residual, so including them here would count them twice — and a second
 * derivative of a bump field is enormous: a 6 mm bump on a 3 m wavelength has a
 * curvature of 0.026/m, which at 80 m/s is 17 g of vertical acceleration.
 */
export function verticalCurvature(t, lapLength, points = SILVERSTONE_ELEVATION) {
  const dt = 4 / lapLength;      // four metres — long enough to be smooth
  const ds = 4;
  const a = elevationAt(t - dt, points);
  const b = elevationAt(t, points);
  const c = elevationAt(t + dt, points);
  return (a - 2 * b + c) / (ds * ds);
}

/** Gradient of the elevation with respect to distance along the lap, per metre. */
export function elevationGradient(t, lapLength, points = SILVERSTONE_ELEVATION) {
  const dt = 1 / lapLength;         // one metre, in lap fractions
  return (elevationAt(t + dt, points) - elevationAt(t - dt, points)) / 2;
}

// ---------------------------------------------------------------------------
// Cross-slope
// ---------------------------------------------------------------------------

/**
 * Drainage crown: every real road is highest at its centre so water runs off.
 * 1.5% is typical, and it is not cosmetic — it puts the outside wheels lower than
 * the inside ones, which loads them slightly and is part of why a car placed wide
 * feels different from one placed narrow.
 */
export const CROWN_SLOPE = 0.015;

/**
 * Banking, radians, against lap fraction. Positive banks the left side down.
 *
 * Silverstone is essentially flat, and the honest model of "essentially flat" is a
 * small number rather than zero: a couple of corners have a degree or two of
 * adverse or favourable camber, and that degree or two is worth something at
 * 5 g.
 */
export const SILVERSTONE_BANKING = [
  { t: 0.000, a: 0.000 },
  { t: 0.130, a: -0.012 },   // Village, slightly adverse
  { t: 0.185, a: 0.010 },    // Aintree, mild positive
  { t: 0.325, a: 0.018 },    // Luffield, the most banked corner on the lap
  { t: 0.390, a: 0.008 },    // Copse
  { t: 0.600, a: -0.006 },   // Becketts, a touch adverse
  { t: 0.826, a: 0.014 },    // Stowe
  { t: 0.960, a: 0.004 },
];

export function bankingAt(t, points = SILVERSTONE_BANKING) {
  const n = points.length;
  const u = ((t % 1) + 1) % 1;
  let i = n - 1;
  for (let k = 0; k < n; k++) {
    const next = (k + 1) % n;
    const tk = points[k].t;
    const tn = next === 0 ? 1 : points[next].t;
    if (u >= tk && u < tn) { i = k; break; }
  }
  const p0 = points[(i - 1 + n) % n];
  const p1 = points[i];
  const p2 = points[(i + 1) % n];
  const p3 = points[(i + 2) % n];
  const t1 = p1.t;
  const t2 = (i + 1) % n === 0 ? 1 : p2.t;
  const s = (u - t1) / Math.max(t2 - t1, 1e-9);
  return catmullRom(p0.a, p1.a, p2.a, p3.a, s);
}

/**
 * Height contribution of the cross-section at a lateral offset.
 *
 * Banking is a plane; the crown is a roof. Both are referenced to the centreline,
 * so a car on the centreline sits at the elevation and everything else is
 * relative to that.
 */
export function crossSlopeHeight(t, lateral) {
  return -Math.abs(lateral) * CROWN_SLOPE + lateral * bankingAt(t);
}

// ---------------------------------------------------------------------------
// Bumps
// ---------------------------------------------------------------------------

/**
 * Bumps, as a sum of sinusoids in distance along the lap.
 *
 * Deliberately not random. A hash-based noise field would give a surface that is
 * different every time the amplitude is retuned, and one that a driver cannot
 * learn — and learning where the bumps are is most of what knowing a circuit
 * means. A fixed sum of incommensurate wavelengths is repeatable, cheap, learnable,
 * and gives a spectrum rather than a single frequency.
 *
 * Amplitudes are metres. The set below gives about 28 mm peak-to-peak at full
 * severity, which is a bumpy racing surface — 56 mm, where this started, is a farm
 * track, and it swamped the 12 mm of front bump-stop gap the car has to work with.
 *
 * The lateral phase term is the important one. Bumps that are identical across the
 * car's width only pitch it; bumps that differ across the width *roll* it, and
 * that is what makes a bumpy circuit tiring rather than merely bouncy.
 */
const BUMP_HARMONICS = [
  // wavelength (m), amplitude (m), lateral phase gradient (rad/m)
  { lambda: 31.0, amp: 0.0062, lateralPhase: 0.05 },
  { lambda: 17.3, amp: 0.0040, lateralPhase: 0.11 },
  { lambda: 9.70, amp: 0.0026, lateralPhase: 0.19 },
  { lambda: 5.30, amp: 0.0015, lateralPhase: 0.31 },
  { lambda: 2.90, amp: 0.0004, lateralPhase: 0.47 },
  { lambda: 1.37, amp: 0.0009, lateralPhase: 0.83 },
];

/**
 * Per-region bump severity, 0..1, against lap fraction. Real circuits are not
 * uniformly rough: a resurfaced straight is glassy and a thirty-year-old corner
 * entry is not.
 */
export const SILVERSTONE_ROUGHNESS = [
  { t: 0.000, r: 0.45 },
  { t: 0.130, r: 0.85 },   // Village — the roughest part of the lap
  { t: 0.200, r: 0.55 },
  { t: 0.250, r: 0.25 },   // Wellington Straight, resurfaced and smooth
  { t: 0.325, r: 0.60 },   // Luffield
  { t: 0.390, r: 0.40 },   // Copse
  { t: 0.600, r: 0.70 },   // Becketts, notably bumpy on entry
  { t: 0.760, r: 0.20 },   // Hangar Straight
  { t: 0.915, r: 0.75 },   // Vale
];

export function roughnessAt(t, points = SILVERSTONE_ROUGHNESS) {
  const n = points.length;
  const u = ((t % 1) + 1) % 1;
  let i = n - 1;
  for (let k = 0; k < n; k++) {
    const next = (k + 1) % n;
    const tk = points[k].t;
    const tn = next === 0 ? 1 : points[next].t;
    if (u >= tk && u < tn) { i = k; break; }
  }
  const p1 = points[i];
  const p2 = points[(i + 1) % n];
  const t1 = p1.t;
  const t2 = (i + 1) % n === 0 ? 1 : p2.t;
  const s = (u - t1) / Math.max(t2 - t1, 1e-9);
  // Linear here rather than Catmull-Rom: this scales an amplitude, so a gradient
  // discontinuity in it is not a step in the surface.
  return p1.r + (p2.r - p1.r) * s;
}

/**
 * Bump height at a point on the surface.
 *
 * @param {number} along distance round the lap, metres
 * @param {number} lateral offset from the centreline, metres
 * @param {number} severity 0..1, from `roughnessAt`
 */
export function bumpHeight(along, lateral, severity) {
  let h = 0;
  for (let i = 0; i < BUMP_HARMONICS.length; i++) {
    const b = BUMP_HARMONICS[i];
    h += b.amp * Math.sin(TAU * along / b.lambda + lateral * b.lateralPhase);
  }
  return h * severity;
}

// ---------------------------------------------------------------------------
// Kerbs
// ---------------------------------------------------------------------------

/**
 * Kerb geometry. 50 mm high with a serrated top — the ribs are what make a kerb
 * loud and what makes riding one cost you the platform rather than just some grip.
 *
 * The car does not "go onto the kerb surface"; a wheel climbs a 50 mm step through
 * its own suspension travel, which is more than half the front bump-stop gap. That
 * is why kerbs matter on these cars and why they matter more than they used to.
 */
export const KERB_WIDTH = 1.0;
export const KERB_HEIGHT = 0.050;
/** Serration pitch and depth, metres. */
export const KERB_RIB_PITCH = 0.5;
export const KERB_RIB_DEPTH = 0.012;
/**
 * How far each kerb edge ramps up over, metres.
 *
 * The racing-line (inner) edge stays short so a kerb still bites. The runoff
 * (outer) edge is longer: rejoining from the grass used to climb 50 mm in 18 cm,
 * which is a damper shaft speed well past the digressive knee, and the car
 * boinged for seconds after it was back on asphalt.
 */
export const KERB_RAMP = 0.18;
export const KERB_RAMP_OUTER = 0.45;

/**
 * Kerb height at a lateral offset, given the edge of the asphalt.
 *
 * @param {number} lateralAbs absolute distance from the centreline, metres
 * @param {number} halfWidth asphalt half-width at this station, metres
 * @param {number} along distance round the lap, for the ribs
 */
export function kerbHeight(lateralAbs, halfWidth, along) {
  const over = lateralAbs - halfWidth;
  if (over <= 0 || over > KERB_WIDTH) return 0;
  // Ramp in from the asphalt, then fall away more gently toward the runoff.
  const rampIn = Math.min(1, over / KERB_RAMP);
  const rampOut = Math.min(1, (KERB_WIDTH - over) / KERB_RAMP_OUTER);
  const plateau = KERB_HEIGHT * Math.min(rampIn, rampOut);
  // Ribs run across the kerb, so they are a function of distance along the lap.
  const rib = KERB_RIB_DEPTH * 0.5
    * (1 - Math.cos(TAU * along / KERB_RIB_PITCH))
    * Math.min(rampIn, rampOut);
  return plateau + rib;
}

// ---------------------------------------------------------------------------
// The whole surface
// ---------------------------------------------------------------------------

/**
 * Surface height in world Y at a point on the track.
 *
 * The cross-slope is clamped at the wall limit. Beyond it the crown and the
 * banking are planes with no reason to stop, and a plane that does not stop is a
 * kilometre-deep trench a kilometre from the track: at 1.5% a point 800 m out sits
 * 12 m below the road, which is the same order as the entire elevation change.
 *
 * @param {object} q from `centerline.query` — needs `t`, `lateral`, `halfWidth`,
 *   and optionally `wallLimit`
 * @param {number} lapLength metres
 * @param {object} [profile] override the circuit profile, for tests
 */
export function surfaceHeight(q, lapLength, profile = {}) {
  const {
    elevation = SILVERSTONE_ELEVATION,
    banking = SILVERSTONE_BANKING,
    roughness = SILVERSTONE_ROUGHNESS,
    bumpScale = 1,
  } = profile;
  const along = q.t * lapLength;
  const lateralAbs = Math.abs(q.lateral);
  const edge = q.wallLimit ?? (q.halfWidth * 2);
  const crossLateral = Math.sign(q.lateral || 1) * Math.min(lateralAbs, edge);

  let h = elevationAt(q.t, elevation);
  h += -Math.abs(crossLateral) * CROWN_SLOPE + crossLateral * bankingAt(q.t, banking);
  h += bumpScale * bumpHeight(along, q.lateral, roughnessAt(q.t, roughness));
  h += kerbHeight(lateralAbs, q.halfWidth, along);
  return h;
}

/** Mean elevation over the lap. What the ground relaxes to far from the circuit. */
export function meanElevation(profile = SILVERSTONE_ELEVATION, samples = 512) {
  let sum = 0;
  for (let i = 0; i < samples; i++) sum += elevationAt(i / samples, profile);
  return sum / samples;
}

/** How far beyond the wall the ground takes to relax to the mean, metres. */
export const FIELD_BLEND = 420;

/**
 * Ground height beyond the circuit, for the mesh that fills the horizon.
 *
 * **This must agree with `surfaceHeight` everywhere the car can reach**, and the
 * reason is not aesthetic. The car was placed at the height the *physics* thought
 * the ground was while the mesh drew it somewhere else, and the result was a car
 * buried up to its rear wing in grass — visible only because it happened to run
 * off the road.
 *
 * So the two are the same function at the wall limit by construction: the lateral
 * offset is clamped to the wall, `surfaceHeight` is evaluated there, and only
 * *beyond* the wall does anything relax. Inside the barriers, where the car
 * actually is, they are identical.
 */
export function groundFieldHeight(q, lapLength, profile = {}, mean = null) {
  const edge = q.wallLimit ?? (q.halfWidth * 2);
  const lateralAbs = Math.abs(q.lateral);
  const clamped = { ...q, lateral: Math.sign(q.lateral || 1) * Math.min(lateralAbs, edge) };
  const local = surfaceHeight(clamped, lapLength, profile);
  const beyond = Math.max(0, lateralAbs - edge);
  if (beyond === 0) return local;
  const flat = mean ?? meanElevation(profile.elevation ?? SILVERSTONE_ELEVATION);
  const w = 1 / (1 + (beyond / FIELD_BLEND) ** 2);
  return flat + (local - flat) * w;
}

/**
 * Ground-mesh height that does not cliff where two parts of the lap pass nearby.
 *
 * `groundFieldHeight` is keyed on the single nearest station. Between Brooklands
 * and Luffield — or inside the Loop — two ribbons sit tens of metres apart with
 * several metres of elevation between them. An axis-aligned 20 m cell then
 * straddles the Voronoi cut and the lawn is a rectangular pit, fence hanging
 * over the hole. Inverse-distance blend of every station inside
 * `GROUND_BLEND_R` turns that cut into a slope. On the asphalt the nearest
 * station still dominates (d² ≈ 0).
 *
 * Physics keeps nearest-station `groundFieldHeight`; this is the drawn field.
 */
export const GROUND_BLEND_R = 90;

export function blendedGroundHeight(samples, x, z, lapLength, profile = {}, mean = null) {
  const flat = mean ?? meanElevation(profile.elevation ?? SILVERSTONE_ELEVATION);
  const r2 = GROUND_BLEND_R * GROUND_BLEND_R;
  let bestI = 0, bestD2 = Infinity;
  let hsum = 0, wsum = 0;
  const q = { t: 0, lateral: 0, halfWidth: 0, wallLimit: 0 };
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const d2 = (s.x - x) * (s.x - x) + (s.z - z) * (s.z - z);
    if (d2 < bestD2) { bestD2 = d2; bestI = i; }
    if (d2 >= r2) continue;
    q.t = s.t;
    q.lateral = -((x - s.x) * s.nx + (z - s.z) * s.nz);
    q.halfWidth = s.halfWidth;
    q.wallLimit = s.halfWidth + s.runoff;
    const w = 1 / (d2 + 16);
    hsum += w * groundFieldHeight(q, lapLength, profile, flat);
    wsum += w;
  }
  if (wsum > 0) return hsum / wsum;
  const s = samples[bestI];
  q.t = s.t;
  q.lateral = -((x - s.x) * s.nx + (z - s.z) * s.nz);
  q.halfWidth = s.halfWidth;
  q.wallLimit = s.halfWidth + s.runoff;
  return groundFieldHeight(q, lapLength, profile, flat);
}

/**
 * Surface roughness at a point, 0..1 — for the tyre scrub audio, for the camera
 * shake, and for anything else that wants to know the road is bad without
 * measuring it.
 */
export function surfaceRoughness(q, profile = {}) {
  return roughnessAt(q.t, profile.roughness ?? SILVERSTONE_ROUGHNESS);
}

/**
 * Extra sink of the *world ground mesh* under the racing ribbons.
 *
 * The coarse horizon grid cannot cut a hole that follows the asphalt. A binary
 * 15 cm drop under the road was a jagged cliff — black seams and z-fighting
 * along the ribbon. Instead sink the lawn only where the ribbons already cover
 * it, and fade to zero by the wall so the far field and the catch fence stay
 * flush with `groundFieldHeight` (the physics height).
 *
 * Physics does not use this. The car stands on `groundFieldHeight + roadLiftAt`.
 *
 * Always zero. A lateral-keyed sink on an axis-aligned grid is a rectangular
 * pit wherever a cell straddles the wall on a corner — the leftover holes.
 * The ribbons sit above the lawn via `Y_ASPHALT` and polygonOffset.
 */
export const GROUND_MESH_SINK = 0;

export function groundMeshBias(_lateralAbs, _wallLimit) {
  return 0;
}

// ---------------------------------------------------------------------------
// Terrain beyond the circuit
// ---------------------------------------------------------------------------

/**
 * Superseded by `groundFieldHeight`.
 *
 * This was an inverse-distance blend over a decimated station list — smooth,
 * cheap, and *a different function from the one the physics used*. Which is
 * exactly the failure it caused: the mesh drew the ground in one place and the
 * kernel put the car on it in another, and off the road the two differed by
 * enough to bury the car up to its rear wing.
 *
 * Kept only as a warning. Two height fields is one too many.
 */
