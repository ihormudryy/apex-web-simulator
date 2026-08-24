import { hash01 } from './tracksidePlacements.js';

/**
 * Pure placement for distant horizon billboards — no Three.js.
 *
 * @typedef {'treeNear' | 'treeFar' | 'stand'} HorizonKind
 */

/**
 * @param {{ samples: object[], length: number }} centerline
 * @param {object} [opts]
 * @returns {Array<{ x: number, z: number, scale: number, rot: number, kind: HorizonKind, along: number }>}
 */
export function planHorizonBillboards(centerline, {
  nearSpacing = 32,
  farSpacing = 55,
  standSpacing = 220,
  nearMin = 42,
  nearMax = 88,
  farMin = 110,
  farMax = 220,
  standMin = 95,
  standMax = 160,
  seed = 61,
  maxNear = 480,
  maxFar = 280,
  maxStands = 36,
  minClearance = 40,
} = {}) {
  const { samples, length: lapLength } = centerline;
  if (!samples?.length || !(lapLength > 0)) return [];

  const n = samples.length;
  const out = [];

  /**
   * Distance to the nearest point of the *whole* circuit, squared.
   *
   * Offsetting laterally from one station only guarantees clearance from that
   * station, and Silverstone folds back on itself repeatedly — the infield at
   * Luffield, Brooklands and the Loop all pass within a hundred metres of other
   * straights. So a tree pushed 42-88 m off one station lands on another part of
   * the track: measured against the surveyed centerline, the closest billboard
   * sat 0.8 m from the racing line, with 18 of them inside 20 m. On screen they
   * are 5.5x9.5 m cards (grandstands 28x12) with no billboarding, so up close
   * they read as flat translucent grey wedges hanging over the track — the
   * "artifact above the car".
   */
  const nearestStation2 = (x, z) => {
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      const s = samples[i];
      const dx = x - s.x;
      const dz = z - s.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < best) best = d2;
    }
    return best;
  };

  const clear2 = minClearance * minClearance;

  /**
   * First candidate that clears the circuit: the chosen side and offset, then
   * the same side pushed further out, then the far side. Returns null when this
   * stretch has no room at all, and an absent tree beats one on the apex.
   */
  const findSpot = (s, side, outward, minOut, maxOut, alongJitter) => {
    const wall = s.halfWidth + s.runoff + 2.5;
    for (const trySide of [side, -side]) {
      for (const tryOut of [outward, (minOut + maxOut) / 2, maxOut]) {
        const offset = wall + tryOut;
        const x = s.x + s.nx * trySide * offset + s.tx * alongJitter;
        const z = s.z + s.nz * trySide * offset + s.tz * alongJitter;
        if (nearestStation2(x, z) >= clear2) return { x, z };
      }
    }
    return null;
  };

  const placeRing = (spacing, minOut, maxOut, maxCount, kind, seedOff) => {
    const count = Math.min(maxCount, Math.ceil(lapLength / spacing));
    for (let p = 0; p < count; p++) {
      const idx = Math.floor((p / count) * n) % n;
      const s = samples[idx];
      const side = hash01(p, seedOff, 2, seed) < 0.5 ? -1 : 1;
      const outward = minOut + hash01(p, seedOff + 1, 3, seed) * (maxOut - minOut);
      const alongJitter = (hash01(p, seedOff + 2, 4, seed) - 0.5) * spacing * 0.6;
      const spot = findSpot(s, side, outward, minOut, maxOut, alongJitter);
      if (!spot) continue;
      out.push({
        x: spot.x,
        z: spot.z,
        scale: 0.85 + hash01(p, seedOff + 3, 5, seed) * 0.55,
        rot: hash01(p, seedOff + 4, 6, seed) * Math.PI,
        kind,
        along: (p / count) * lapLength,
      });
    }
  };

  placeRing(nearSpacing, nearMin, nearMax, maxNear, 'treeNear', 0);
  placeRing(farSpacing, farMin, farMax, maxFar, 'treeFar', 10);

  const standCount = Math.min(maxStands, Math.ceil(lapLength / standSpacing));
  for (let p = 0; p < standCount; p++) {
    const idx = Math.floor((p / standCount) * n) % n;
    const s = samples[idx];
    const side = hash01(p, 20, 2, seed) < 0.55 ? 1 : -1;
    const outward = standMin + hash01(p, 21, 3, seed) * (standMax - standMin);
    // Same clearance rule, and it matters more here: a grandstand card is
    // 28x12 m, and one of these measured 11.7 m from the centerline.
    const spot = findSpot(s, side, outward, standMin, standMax, 0);
    if (!spot) continue;
    out.push({
      x: spot.x,
      z: spot.z,
      scale: 1.1 + hash01(p, 22, 4, seed) * 0.9,
      rot: Math.atan2(s.nx * side, s.nz * side) + Math.PI * 0.5
        + (hash01(p, 23, 5, seed) - 0.5) * 0.25,
      kind: 'stand',
      along: (p / standCount) * lapLength,
    });
  }

  return out;
}
