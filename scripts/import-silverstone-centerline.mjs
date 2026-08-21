#!/usr/bin/env node
/**
 * Import the surveyed Silverstone centerline into scene coordinates.
 *
 *   node scripts/import-silverstone-centerline.mjs [path/to/Silverstone.csv]
 *
 * Source: TUMFTM racetrack-database (LGPL-3.0), `tracks/Silverstone.csv` —
 * 1178 centerline points at ~5 m spacing with per-point left/right track
 * widths (centerline traced from OpenStreetMap, widths from satellite
 * imagery). Pinned at commit e59595d1 (2021-09-18):
 * https://github.com/TUMFTM/racetrack-database/blob/e59595d1/tracks/Silverstone.csv
 * Without a path argument the CSV is fetched from that pinned commit.
 *
 * What this does, in order:
 *  1. RECENTRE — the survey line is not the geometric middle (left/right
 *     widths differ); shift each point laterally by (w_right − w_left)/2 so
 *     the generator's symmetric halfWidth = (w_left + w_right)/2 is exact.
 *  2. RELAX — the trace has a few elbow artifacts (implied radius ~12 m at
 *     The Loop, which no 5.9 m-wheelbase car could round); localized
 *     Laplacian passes open every corner to ≥ R_MIN, and each moved point is
 *     checked to stay inside the surveyed road corridor (min side width less
 *     a metre), so the fix never invents road that is not there.
 *  3. SCALE — normalize the loop to the official 5891 m.
 *  4. ALIGN — closed-form similarity fit (rotation/translation/optional
 *     mirror over sampled arc-length correspondences) onto the previous
 *     hand-tuned ring, so the circuit lands where the scene, cameras and
 *     spawn already expect it; the ring is then re-indexed so point 0 sits at
 *     the old grid station and runs the same direction of travel.
 *  5. RUNOFF — the survey has no runoff data; each point inherits it from the
 *     nearest station of the old ring, keeping the hand-tuned per-corner
 *     values (Copse wide, The Loop tight).
 *  6. EMIT js/track/silverstoneSurvey.js with provenance and license header.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { filletToLength } from '../js/track/fillet.js';
import { densifyRing } from '../js/track/densify.js';
import { buildCenterline, maxTangentJump, minCurvatureRadius } from '../js/track/centerline.js';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '../js/track/silverstoneSurvey.js');
const PINNED_CSV = 'https://raw.githubusercontent.com/TUMFTM/racetrack-database/e59595d1f3573b30d1ded6a08984935b957688e0/tracks/Silverstone.csv';
const OFFICIAL_LENGTH = 5891;
const R_MIN = 20; // m — see header; the corridor check guards every move.
// 22 would suit the test autopilot better but strays past the surveyed road
// at The Loop; the road is what it is, so the autopilot adapts instead.

// The hand-tuned ring this replaces, kept verbatim as the alignment target.
const OLD_CORNERS = [
  { x:  820, z: -326.6667, halfWidth: 8.5, runoff: 14, radius: 600 },
  { x:  780, z: -220, halfWidth: 7.5, runoff: 16, radius: 170 },
  { x:  650, z: -180, halfWidth: 7.0, runoff: 14, radius: 110 },
  { x:  520, z: -470, halfWidth: 7.0, runoff: 12, radius:  55 },
  { x:  310, z: -430, halfWidth: 6.5, runoff:  6, radius:  30 },
  { x:  280, z: -280, halfWidth: 7.0, runoff: 12, radius:  90 },
  { x:  120, z:  -40, halfWidth: 7.5, runoff: 14, radius: 260 },
  { x: -180, z:  220, halfWidth: 7.5, runoff: 14, radius: 220 },
  { x: -420, z:  280, halfWidth: 7.0, runoff: 12, radius:  75 },
  { x: -620, z:  180, halfWidth: 7.0, runoff: 12, radius:  55 },
  { x: -680, z:  -40, halfWidth: 7.5, runoff: 16, radius: 190 },
  { x: -600, z: -280, halfWidth: 7.5, runoff: 22, radius: 200 },
  { x: -420, z: -420, halfWidth: 7.0, runoff: 16, radius: 170 },
  { x: -220, z: -500, halfWidth: 7.0, runoff: 16, radius: 130 },
  { x:  -40, z: -620, halfWidth: 7.0, runoff: 14, radius: 150 },
  { x:  180, z: -900, halfWidth: 7.5, runoff: 18, radius: 500 },
  { x:  420, z: -1180, halfWidth: 7.5, runoff: 18, radius: 240 },
  { x:  640, z: -1280, halfWidth: 7.5, runoff: 24, radius: 115 },
  { x:  820, z: -1120, halfWidth: 7.0, runoff: 16, radius:  60 },
  { x:  880, z: -820, halfWidth: 7.5, runoff: 20, radius: 130 },
  { x:  840, z: -380, halfWidth: 8.5, runoff: 14, radius: 260 },
];

const csvPath = process.argv[2];
const csv = csvPath
  ? readFileSync(csvPath, 'utf8')
  : await (await fetch(PINNED_CSV)).text();
const raw = csv.trim().split('\n').filter(l => !l.startsWith('#'))
  .map(l => l.split(',').map(Number));
console.log(`parsed ${raw.length} survey points`);

const n = raw.length;
const wrap = i => ((i % n) + n) % n;

// ---- 1. relax elbow artifacts to R_MIN, corridor-guarded -------------------
// On the RAW trace: recentring first adds ±0.5 m of lateral jitter that
// deepens the very elbows the relaxation is opening.
let pts = raw.map(p => ({
  x: p[0], y: p[1],
  halfWidth: (p[2] + p[3]) / 2,
  wRight: p[2], wLeft: p[3],
  minSide: Math.min(p[2], p[3]),
  ox: p[0], oy: p[1],
}));

const radiusAt = (P, i) => {
  const a = P[wrap(i - 1)], b = P[i], c = P[wrap(i + 1)];
  const h1 = Math.atan2(b.y - a.y, b.x - a.x);
  const h2 = Math.atan2(c.y - b.y, c.x - b.x);
  let d = h2 - h1;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  const seg = (Math.hypot(b.x - a.x, b.y - a.y) + Math.hypot(c.x - b.x, c.y - b.y)) / 2;
  return Math.abs(d) > 1e-4 ? seg / Math.abs(d) : Infinity;
};
let passes = 0;
for (; passes < 2000; passes++) {
  let worst = Infinity;
  const move = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    const r = radiusAt(pts, i);
    worst = Math.min(worst, r);
    if (r < R_MIN) for (let k = -2; k <= 2; k++) move[wrap(i + k)] = true;
  }
  if (worst >= R_MIN) break;
  pts = pts.map((p, i) => {
    if (!move[i]) return p;
    const a = pts[wrap(i - 1)], c = pts[wrap(i + 1)];
    return {
      ...p,
      x: p.x + 0.5 * ((a.x + c.x) / 2 - p.x),
      y: p.y + 0.5 * ((a.y + c.y) / 2 - p.y),
    };
  });
}
// Corridor check AFTER convergence: capping moves mid-iteration just fought
// the smoothing into kinks. Every displaced point must stay on plausible
// road — within the narrow side's width plus 2 m of kerb/runoff belt, the
// same rule the final check applies.
let minR = Infinity, maxShift = 0, violations = 0;
for (let i = 0; i < n; i++) {
  minR = Math.min(minR, radiusAt(pts, i));
  const d = Math.hypot(pts[i].x - pts[i].ox, pts[i].y - pts[i].oy);
  maxShift = Math.max(maxShift, d);
  if (d > pts[i].minSide + 2) violations++;
}
console.log(`relaxed in ${passes} passes: min radius ${minR.toFixed(1)} m, max shift ${maxShift.toFixed(2)} m, corridor violations ${violations}`);
if (minR < R_MIN - 0.5) throw new Error('relaxation did not converge to R_MIN');
if (violations > 0) throw new Error(`${violations} relaxed points left the surveyed road corridor`);

// ---- 2. recentre onto the true middle --------------------------------------
// TUMFTM widths are measured to the right/left of the direction of travel;
// right of heading (tx, ty) is (ty, -tx). Shifting by (w_right - w_left)/2
// puts the line on the geometric middle, which is what the generator's
// symmetric halfWidth assumes. The per-point width asymmetry is measurement
// jitter on top of a slowly varying truth, so the shift (and halfWidth) are
// smoothed over a ±5-point (~25 m) window before being applied — raw shifts
// zigzagged the line down to an 11.8 m implied radius.
const ringAvg = (vals, half) => vals.map((_, i) => {
  let s = 0;
  for (let k = -half; k <= half; k++) s += vals[wrap(i + k)];
  return s / (2 * half + 1);
});
const shifts = ringAvg(pts.map(p => (p.wRight - p.wLeft) / 2), 5);
const halfWidths = ringAvg(pts.map(p => p.halfWidth), 5);
pts = pts.map((p, i) => {
  const a = pts[wrap(i - 2)], c = pts[wrap(i + 2)];
  const tx = c.x - a.x, ty = c.y - a.y;
  const tl = Math.hypot(tx, ty) || 1;
  return {
    ...p,
    x: p.x + (ty / tl) * shifts[i],
    y: p.y - (tx / tl) * shifts[i],
    halfWidth: halfWidths[i],
  };
});

// ---- 2b. relax against the DOWNSTREAM metric --------------------------------
// The game densifies this ring with a Catmull-Rom and resamples to 4000
// stations; the spline overshoots slightly between 5 m survey points at the
// tightest corners, so the polyline radius alone under-guarantees what the
// physics sees. Iterate: densify exactly as the runtime does, find stations
// whose heading jump exceeds the budget, map them back to survey points, and
// open those neighbourhoods a little more. Corridor rule still applies.
const toRing = P => P.map(p => ({ x: p.x, z: p.y, halfWidth: p.halfWidth, runoff: 0 }));
// Deg of heading turn over any station-length arc window of the dense ring.
// The 4000-station tests demand < 5° between adjacent stations, and what a
// station pair measures is the turn over one 1.47 m arc starting at an
// arbitrary phase — so the guarantee has to hold for EVERY such window, not
// just the ones a particular ring indexing happens to sample (re-indexing the
// start once swung the measured jump from 4.47° to 5.61°).
const JUMP_BUDGET = 4.5;
const STATION_ARC = OFFICIAL_LENGTH / 4000;
let rounds = 0;
for (; rounds < 200; rounds++) {
  const dense = densifyRing(toRing(pts), 0.75);
  const dn = dense.length;
  const heading = i => {
    const a = dense[((i % dn) + dn) % dn], b = dense[((i + 1) % dn + dn) % dn];
    return Math.atan2(b.z - a.z, b.x - a.x);
  };
  const move = new Array(n).fill(false);
  let worstJump = 0;
  for (let i = 0; i < dn; i++) {
    // walk forward one station-length of arc
    let arc = 0, j = i;
    while (arc < STATION_ARC) {
      const a = dense[j % dn], b = dense[(j + 1) % dn];
      arc += Math.hypot(b.x - a.x, b.z - a.z);
      j++;
    }
    let d = heading(j) - heading(i);
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    const deg = Math.abs(d) * 180 / Math.PI;
    worstJump = Math.max(worstJump, deg);
    if (deg > JUMP_BUDGET) {
      const a = dense[i % dn];
      let bi = 0, bd = Infinity;
      for (let k = 0; k < n; k++) {
        const dd = (pts[k].x - a.x) ** 2 + (pts[k].y - a.z) ** 2;
        if (dd < bd) { bd = dd; bi = k; }
      }
      for (let k = -2; k <= 2; k++) move[wrap(bi + k)] = true;
    }
  }
  if (worstJump <= JUMP_BUDGET) break;
  pts = pts.map((p, i) => {
    if (!move[i]) return p;
    const a = pts[wrap(i - 1)], c2 = pts[wrap(i + 1)];
    return {
      ...p,
      x: p.x + 0.5 * ((a.x + c2.x) / 2 - p.x),
      y: p.y + 0.5 * ((a.y + c2.y) / 2 - p.y),
    };
  });
}
{
  let r = Infinity, viol = 0, shift = 0, maxPastEdge = 0;
  for (let i = 0; i < n; i++) {
    r = Math.min(r, radiusAt(pts, i));
    const d = Math.hypot(pts[i].x - pts[i].ox, pts[i].y - pts[i].oy);
    shift = Math.max(shift, d);
    maxPastEdge = Math.max(maxPastEdge, d - pts[i].minSide);
    // The repaired line may stray up to 2 m past the surveyed asphalt edge —
    // onto the real kerb/runoff belt — at the two hairpins whose traced
    // elbows (~12 m implied radius) no car could round. Beyond that the
    // repair would be inventing road in open grass.
    if (d > pts[i].minSide + 2) viol++;
  }
  const c = buildCenterline(densifyRing(toRing(pts), 0.75), 4000);
  console.log(`spline-relaxed in ${rounds} rounds: polyline min radius ${r.toFixed(1)} m, `
    + `dense min radius ${minCurvatureRadius(c).toFixed(1)} m, `
    + `dense max jump ${(maxTangentJump(c) * 180 / Math.PI).toFixed(2)} deg, `
    + `max shift ${shift.toFixed(2)} m, worst stray past the asphalt edge ${Math.max(0, maxPastEdge).toFixed(2)} m, violations ${viol}`);
  if (maxTangentJump(c) * 180 / Math.PI > JUMP_BUDGET + 0.01) throw new Error('spline relaxation did not converge');
  if (minCurvatureRadius(c) < 18) throw new Error('densified centerline is tighter than 18 m');
  if (viol > 0) throw new Error(`${viol} relaxed points strayed more than 2 m past the surveyed road`);
}

// ---- 3. scale to the official lap length ----------------------------------
const loopLength = P => P.reduce((s, p, i) =>
  s + Math.hypot(P[(i + 1) % P.length].x - p.x, P[(i + 1) % P.length].y - p.y), 0);
const scale = OFFICIAL_LENGTH / loopLength(pts);
pts = pts.map(p => ({ ...p, x: p.x * scale, y: p.y * scale }));
console.log(`scaled by ${scale.toFixed(5)} to ${loopLength(pts).toFixed(1)} m`);

// ---- 4. align onto the old scene ring --------------------------------------
const oldRing = filletToLength(OLD_CORNERS, OFFICIAL_LENGTH).ring;
const resample = (P, m, get) => {
  const L = loopLength(P);
  const out = [];
  let acc = 0, seg = 0;
  for (let i = 0; i < m; i++) {
    const s = (i / m) * L;
    while (seg < P.length) {
      const a = get(P[seg]), b = get(P[wrap2(seg + 1, P.length)]);
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      if (acc + d >= s || seg === P.length - 1) {
        const u = d > 0 ? (s - acc) / d : 0;
        out.push({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u });
        break;
      }
      acc += d;
      seg++;
    }
  }
  return out;
};
function wrap2(i, m) { return ((i % m) + m) % m; }
const M = 256;

/** Least-squares rotation+translation mapping B[i] -> A[i], closed form. */
function fit(B, A) {
  const m = B.length;
  const cx = B.reduce((s, p) => s + p.x, 0) / m, cy = B.reduce((s, p) => s + p.y, 0) / m;
  const ax = A.reduce((s, p) => s + p.x, 0) / m, ay = A.reduce((s, p) => s + p.y, 0) / m;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < m; i++) {
    const bx = B[i].x - cx, by = B[i].y - cy;
    const px = A[i].x - ax, py = A[i].y - ay;
    sxx += bx * px + by * py;
    sxy += bx * py - by * px;
  }
  const theta = Math.atan2(sxy, sxx);
  const cos = Math.cos(theta), sin = Math.sin(theta);
  let rms = 0;
  for (let i = 0; i < m; i++) {
    const bx = B[i].x - cx, by = B[i].y - cy;
    const x = ax + bx * cos - by * sin, y = ay + bx * sin + by * cos;
    rms += (x - A[i].x) ** 2 + (y - A[i].y) ** 2;
  }
  return { theta, cos, sin, cx, cy, ax, ay, rms: Math.sqrt(rms / m) };
}

// ---- 4a. anchor: find the real start/finish and racing direction -----------
// A shape-only fit of this near-oval loop onto the old hand ring has local
// minima ~130 m apart that put Hangar where Wellington belongs — it landed the
// grid on the wrong straight once. The bacinger/f1-circuits GeoJSON (MIT,
// pinned commit 394d8fbe) is WGS84-georeferenced with point 0 ON the
// start/finish line and the points in racing order, and since it and the
// survey are the same real shape, fitting the survey onto IT is unambiguous.
const BACINGER_URL = 'https://raw.githubusercontent.com/bacinger/f1-circuits/394d8fbe70ef849494e803e1c92c9dd407cbabdb/circuits/gb-1948.geojson';
const geo = JSON.parse(process.argv[3]
  ? readFileSync(process.argv[3], 'utf8')
  : await (await fetch(BACINGER_URL)).text());
const coords = geo.features[0].geometry.coordinates.slice(0, -1);
const latM = coords.reduce((s, c) => s + c[1], 0) / coords.length;
const DEG = Math.PI / 180, EARTH = 6371000;
const geoPts = coords.map(([lon, lat]) => ({
  x: EARTH * lon * DEG * Math.cos(latM * DEG),
  y: EARTH * lat * DEG,
}));
const G0 = resample(geoPts, M, p => p);
let anchor = null;
for (const mirror of [1, -1]) {
  for (const dir of [1, -1]) {
    const base = pts.map(p => ({ x: p.x, y: mirror * p.y }));
    const ordered = dir === 1 ? base : [...base].reverse();
    const R = resample(ordered, M, p => p);
    for (let off = 0; off < M; off++) {
      const B = R.map((_, i) => R[(i + off) % M]);
      const f = fit(B, G0);
      if (!anchor || f.rms < anchor.rms) anchor = { ...f, mirror, dir };
    }
  }
}
console.log(`survey -> georeference fit: rms ${anchor.rms.toFixed(1)} m, mirror ${anchor.mirror}, direction ${anchor.dir}`);
if (anchor.rms > 30) throw new Error('survey does not match the georeferenced circuit — check inputs');
if (anchor.mirror === -1) throw new Error('survey unexpectedly mirrored against the map');
if (anchor.dir === -1) pts.reverse();

// The GeoJSON's point 0 is an arbitrary ring opening (it sits ~1.1 km from
// the start line, up near the Village complex), so the grid and the racing
// direction come from OSM landmarks instead: the Hamilton Straight
// (way 55224167) midpoint IS the start/finish area, and its last node feeds
// straight into Abbey (way 169854842) — racing order runs Hamilton → Abbey.
// Coordinates fetched from the Overpass API, 2026-08-21.
const HAMILTON_MID = { lat: 52.06939, lon: -1.02208 };
const ABBEY_MID = { lat: 52.07126, lon: -1.01931 };
const toMeters = ({ lat, lon }) => ({
  x: EARTH * lon * DEG * Math.cos(latM * DEG),
  y: EARTH * lat * DEG,
});
const toGeoFrame = p => {
  const bx = p.x - anchor.cx, by = p.y - anchor.cy;
  return {
    x: anchor.ax + bx * anchor.cos - by * anchor.sin,
    y: anchor.ay + bx * anchor.sin + by * anchor.cos,
  };
};
const nearestIdx = target => {
  let bi = 0, bd = Infinity;
  pts.forEach((p, i) => {
    const g = toGeoFrame(p);
    const d = (g.x - target.x) ** 2 + (g.y - target.y) ** 2;
    if (d < bd) { bd = d; bi = i; }
  });
  return { i: bi, d: Math.sqrt(bd) };
};
const gridHit = nearestIdx(toMeters(HAMILTON_MID));
const abbeyHit = nearestIdx(toMeters(ABBEY_MID));
const forwardArc = ((abbeyHit.i - gridHit.i + n) % n) * 5;
console.log(`grid at survey point ${gridHit.i} (${gridHit.d.toFixed(0)} m from Hamilton Straight mid), `
  + `Abbey at ${abbeyHit.i}: ${forwardArc.toFixed(0)} m ahead along survey order`);
if (gridHit.d > 60) throw new Error('no survey point near the Hamilton Straight — georeference is off');
if (forwardArc > OFFICIAL_LENGTH / 2) {
  // Abbey is behind us in survey order: the ring runs against racing
  // direction, so flip it (and re-find the grid in the flipped order).
  pts.reverse();
  gridHit.i = n - 1 - gridHit.i;
  console.log('survey order was against the racing direction — reversed');
}
pts = pts.map((_, i) => pts[(i + gridHit.i) % n]);

// ---- 4b. place in the scene: constructed, not fitted ------------------------
// The old hand ring is too distorted to least-squares against (its corners sit
// at the wrong lap fractions, so any rigid fit compromises everywhere). The
// scene placement is fully determined without fitting: the survey grid goes
// exactly where the old grid was, the grid HEADING matches the old spawn
// heading (cameras and the start line carry over), and the mirror is chosen
// so the lap turns the same way round as before. The rest of the track then
// falls wherever reality puts it.
const signedArea = P => P.reduce((s, p, i) => {
  const q = P[(i + 1) % P.length];
  return s + (p.x * q.y - q.x * p.y);
}, 0) / 2;
const oldArea = signedArea(oldRing.map(p => ({ x: p.x, y: p.z })));
const surveyArea = signedArea(pts);
const mirror = Math.sign(oldArea) === Math.sign(surveyArea) ? 1 : -1;
const gridHeadingOld = Math.atan2(oldRing[1].z - oldRing[0].z, oldRing[1].x - oldRing[0].x);
const p0 = pts[0], p1 = pts[1];
const gridHeadingSurvey = Math.atan2(mirror * (p1.y - p0.y), p1.x - p0.x);
const theta = gridHeadingOld - gridHeadingSurvey;
const cosT = Math.cos(theta), sinT = Math.sin(theta);
const ring = pts.map(p => {
  const bx = p.x - p0.x, by = mirror * (p.y - p0.y);
  return {
    x: oldRing[0].x + bx * cosT - by * sinT,
    z: oldRing[0].z + bx * sinT + by * cosT,
    halfWidth: p.halfWidth,
  };
});
console.log(`scene placement: grid pinned to the old grid, heading matched, `
  + `mirror ${mirror}, rotation ${(theta * 180 / Math.PI).toFixed(1)} deg`);
const bbox = P => P.reduce((b, p) => ({
  minX: Math.min(b.minX, p.x), maxX: Math.max(b.maxX, p.x),
  minZ: Math.min(b.minZ, p.z), maxZ: Math.max(b.maxZ, p.z),
}), { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity });
const nb = bbox(ring), ob = bbox(oldRing);
console.log(`bbox old x[${ob.minX.toFixed(0)},${ob.maxX.toFixed(0)}] z[${ob.minZ.toFixed(0)},${ob.maxZ.toFixed(0)}]`);
console.log(`bbox new x[${nb.minX.toFixed(0)},${nb.maxX.toFixed(0)}] z[${nb.minZ.toFixed(0)},${nb.maxZ.toFixed(0)}]`);

// ---- 5. runoff from the nearest old-ring station ---------------------------
let hint = 0;
for (const p of ring) {
  let bestJ = hint, bestD = Infinity;
  for (let k = -60; k <= 60; k++) {
    const j = wrap2(hint + k, oldRing.length);
    const d = (oldRing[j].x - p.x) ** 2 + (oldRing[j].z - p.z) ** 2;
    if (d < bestD) { bestD = d; bestJ = j; }
  }
  if (bestD > 100 * 100) { // fell out of the hint window — full scan
    for (let j = 0; j < oldRing.length; j++) {
      const d = (oldRing[j].x - p.x) ** 2 + (oldRing[j].z - p.z) ** 2;
      if (d < bestD) { bestD = d; bestJ = j; }
    }
  }
  hint = bestJ;
  p.runoff = oldRing[bestJ].runoff;
}

// Cap runoff against the local radius: a strip of reach (halfWidth + runoff)
// swept round a radius folds back on itself as reach approaches the radius,
// and the generator's own test demands radius/reach > 1.2. The tight corners
// of the real layout inherited wide hand-tuned runoffs from the map above;
// real hairpins have their barriers close, so clamping is also the honest
// look. Floor of 3 m keeps a verge everywhere.
const sceneRadiusAt = i => {
  const a = ring[wrap(i - 1)], b = ring[i], c = ring[wrap(i + 1)];
  const h1 = Math.atan2(b.z - a.z, b.x - a.x);
  const h2 = Math.atan2(c.z - b.z, c.x - b.x);
  let d = h2 - h1;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  const seg = (Math.hypot(b.x - a.x, b.z - a.z) + Math.hypot(c.x - b.x, c.z - b.z)) / 2;
  return Math.abs(d) > 1e-4 ? seg / Math.abs(d) : Infinity;
};
const runoffCap = ring.map((p, i) => {
  // Radius over a ±5-point window, so a single straight vertex inside a
  // corner cannot exempt its neighbours from the cap. The 1.5 margin over the
  // generator test's 1.2 covers the dense spline running tighter than the
  // survey polyline this cap is measured on.
  let r = Infinity;
  for (let k = -5; k <= 5; k++) r = Math.min(r, sceneRadiusAt(wrap(i + k)));
  return Math.max(3, r / 1.5 - p.halfWidth);
});
let runoffCapped = 0;
ring.forEach((p, i) => { if (p.runoff > runoffCap[i]) runoffCapped++; });
// Smooth, then re-cap, a few times over: a hard cap alone steps the barrier
// distance by metres between neighbouring points; smoothing tapers the
// approach while the re-cap keeps every point under its own limit.
let runoffs = ring.map((p, i) => Math.min(p.runoff, runoffCap[i]));
for (let pass = 0; pass < 3; pass++) {
  runoffs = runoffs.map((_, i) => {
    let s = 0;
    for (let k = -3; k <= 3; k++) s += runoffs[wrap(i + k)];
    return s / 7;
  }).map((v, i) => Math.min(v, runoffCap[i]));
}
ring.forEach((p, i) => { p.runoff = Math.round(runoffs[i] * 100) / 100; });
console.log(`runoff capped at ${runoffCapped} points to keep radius/reach clear of the fold-back limit`);

// ---- 6. emit ---------------------------------------------------------------
const r2 = v => Math.round(v * 100) / 100;
const rows = ring.map(p =>
  `[${r2(p.x)},${r2(p.z)},${r2(p.halfWidth)},${r2(p.runoff)}]`);
const body = `/**
 * Surveyed Silverstone GP centerline, scene coordinates. GENERATED — do not
 * edit by hand; regenerate with scripts/import-silverstone-centerline.mjs.
 *
 * Source data: TUMFTM racetrack-database, tracks/Silverstone.csv at commit
 * e59595d1 (github.com/TUMFTM/racetrack-database, LGPL-3.0) — centerline from
 * OpenStreetMap traces (© OpenStreetMap contributors, ODbL), track widths
 * from satellite imagery. ${n} points, ~5 m spacing, recentred onto the true
 * road middle, elbow artifacts relaxed to a ${R_MIN} m minimum radius inside
 * the surveyed corridor, loop scaled to the official ${OFFICIAL_LENGTH} m and
 * fitted onto the scene frame of the previous hand-tuned layout. Runoff
 * widths are not surveyed; they carry over from the hand-tuned ring.
 *
 * Each row is [x, z, halfWidth, runoff] in metres; point 0 is the grid.
 */
const P = [
${rows.join(',\n')},
];

export const SILVERSTONE_SURVEYED_RING = P.map(([x, z, halfWidth, runoff]) =>
  ({ x, z, halfWidth, runoff }));
`;
writeFileSync(OUT, body);
console.log(`wrote ${OUT} (${ring.length} points)`);
