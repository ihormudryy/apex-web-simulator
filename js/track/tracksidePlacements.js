/**
 * Deterministic scatter for grass tufts and catch-fence panels along the lap.
 * Pure geometry — no Three.js — so physics/tests can reuse the same rules.
 */

export function hash01(a, b, c, seed = 1) {
  let n = Math.imul(a + seed * 17, 374761393) + Math.imul(b + seed * 31, 668265263);
  n += Math.imul(c + seed * 53, 1442695041);
  n = (n ^ (n >>> 13)) >>> 0;
  return (n % 10000) / 10000;
}

/**
 * @param {Array<{x:number,z:number,tx:number,tz:number,nx:number,nz:number,halfWidth:number,runoff:number}>} samples
 * @param {number} lapLength metres
 */
export function planGrassTufts(samples, lapLength, {
  alongSpacing = 1.2,
  // Tufts must clear the kerb before they start, or they grow out of the red and
  // white blocks. The kerb ribbon runs from `halfWidth` to `halfWidth + 1.0`.
  edgeInset = 1.25,
  maxBeyondRunoff = 1.5,
  // Tufts per station per side, before the density filter thins them.
  perStation = 6,
  seed = 17,
  maxCount = 60000,
} = {}) {
  if (!samples.length || lapLength <= 0) return [];

  const metresPerSample = lapLength / samples.length;
  const stationStep = Math.max(1, Math.round(alongSpacing / metresPerSample));
  const alongSpan = stationStep * metresPerSample;
  const placements = [];

  for (let i = 0; i < samples.length; i += stationStep) {
    const s = samples[i];
    // The plantable band: just outside the kerb, out to a little past the runoff.
    const inner = s.halfWidth + edgeInset;
    const outer = s.halfWidth + s.runoff + maxBeyondRunoff;
    const span = outer - inner;
    if (span <= 0) continue;

    for (const side of [-1, 1]) {
      const here = perStation + Math.floor(hash01(i, side, 0, seed) * perStation);
      for (let j = 0; j < here; j++) {
        const u = hash01(i, side, j + 1, seed);
        const lateral = inner + u * span;
        // 1 against the kerb, 0 at the outer edge — `u` already is that ramp.
        const falloff = 1 - u;
        const keep = hash01(i, side, j + 9, seed);
        // Keep probability tracks `falloff` directly: dense against the asphalt,
        // thinning outward. Using `(1 - falloff)` here inverted the gradient and
        // put 13x more tufts in the far runoff than on the verge.
        if (keep > 0.12 + 0.78 * falloff) continue;

        // Jitter along the lap as well as across it. Without this every tuft
        // sits exactly on a station and the verge shows transverse stripes.
        const along = (hash01(i, side, j + 5, seed) - 0.5) * alongSpan;

        placements.push({
          x: s.x + s.nx * side * lateral + s.tx * along,
          z: s.z + s.nz * side * lateral + s.tz * along,
          yaw: Math.atan2(s.tx, s.tz) + (hash01(i, side, j + 2, seed) - 0.5) * 2.4,
          scale: 0.7 + hash01(i, side, j + 3, seed) * 0.5,
          lateral,
          halfWidth: s.halfWidth,
          runoff: s.runoff,
        });
        if (placements.length >= maxCount) return placements;
      }
    }
  }
  return placements;
}

/**
 * Catch fence panels just outside the Armco wall (`halfWidth + runoff`).
 *
 * @param {Array<{x:number,z:number,tx:number,tz:number,nx:number,nz:number,halfWidth:number,runoff:number}>} samples
 * @param {number} lapLength metres
 */
export function planCatchFence(samples, lapLength, {
  panelWidth = 5,
  outward = 0.55,
} = {}) {
  if (!samples.length || lapLength <= 0) return [];

  const n = samples.length;
  const count = Math.ceil(lapLength / panelWidth);
  const panels = [];

  for (let p = 0; p < count; p++) {
    const idx = Math.floor((p / count) * n) % n;
    const s = samples[idx];
    const wall = s.halfWidth + s.runoff;

    for (const side of [-1, 1]) {
      const offset = wall + outward;
      panels.push({
        x: s.x + s.nx * side * offset,
        z: s.z + s.nz * side * offset,
        lookX: s.x,
        lookZ: s.z,
        side,
        wallLimit: wall,
      });
    }
  }
  return panels;
}

/**
 * Marshal posts on the infield side of the catch fence.
 *
 * @param {Array<{x:number,z:number,tx:number,tz:number,nx:number,nz:number,halfWidth:number,runoff:number}>} samples
 * @param {number} lapLength metres
 */
export function planMarshalPosts(samples, lapLength, {
  spacing = 90,
  inward = 0.35,
  seed = 23,
} = {}) {
  if (!samples.length || lapLength <= 0) return [];

  const n = samples.length;
  const count = Math.ceil(lapLength / spacing);
  const posts = [];

  for (let p = 0; p < count; p++) {
    const idx = Math.floor((p / count) * n) % n;
    const s = samples[idx];
    const wall = s.halfWidth + s.runoff + 0.55;
    const offset = wall + inward;
    if (hash01(p, 0, 1, seed) < 0.22) continue;

    posts.push({
      x: s.x + s.nx * offset,
      z: s.z + s.nz * offset,
      lookX: s.x,
      lookZ: s.z,
      yaw: Math.atan2(s.tx, s.tz),
    });
  }
  return posts;
}

/**
 * Distance boards every `spacing` metres, outer side only (TV-facing).
 *
 * @param {Array<{x:number,z:number,tx:number,tz:number,nx:number,nz:number,halfWidth:number,runoff:number}>} samples
 * @param {number} lapLength metres
 */
export function planDistanceBoards(samples, lapLength, {
  spacing = 200,
  outward = 1.1,
} = {}) {
  if (!samples.length || lapLength <= 0) return [];

  const n = samples.length;
  const count = Math.max(1, Math.floor(lapLength / spacing));
  const boards = [];

  for (let p = 0; p < count; p++) {
    const dist = (p + 1) * spacing;
    const idx = Math.floor((dist / lapLength) * n) % n;
    const s = samples[idx];
    const wall = s.halfWidth + s.runoff + 0.55;
    const offset = wall + outward;

    boards.push({
      x: s.x - s.nx * offset,
      z: s.z - s.nz * offset,
      lookX: s.x,
      lookZ: s.z,
      labelM: Math.round(dist / 100) * 100,
    });
  }
  return boards;
}

function sampleCurvature(samples, i, span = 12) {
  const n = samples.length;
  const prev = samples[(i - span + n) % n];
  const next = samples[(i + span) % n];
  const dot = prev.tx * next.tx + prev.tz * next.tz;
  return 1 - Math.max(-1, Math.min(1, dot));
}

/**
 * Tyre stacks at tight corners — braking markers outside the Armco.
 *
 * @param {Array<{x:number,z:number,tx:number,tz:number,nx:number,nz:number,halfWidth:number,runoff:number}>} samples
 * @param {number} lapLength metres
 */
export function planTyreStacks(samples, lapLength, {
  minCurvature = 0.008,
  alongSpacing = 120,
  maxStacks = 48,
  seed = 41,
} = {}) {
  if (!samples.length || lapLength <= 0) return [];

  const n = samples.length;
  const step = Math.max(1, Math.round((alongSpacing / lapLength) * n));
  const stacks = [];

  for (let i = 0; i < n; i += step) {
    const curv = sampleCurvature(samples, i);
    if (curv < minCurvature) continue;
    if (hash01(i, 7, 3, seed) > 0.25 + curv * 3) continue;

    const s = samples[i];
    const wall = s.halfWidth + s.runoff;
    for (const side of [-1, 1]) {
      stacks.push({
        x: s.x + s.nx * side * (wall + 1.4),
        z: s.z + s.nz * side * (wall + 1.4),
        yaw: Math.atan2(s.tx, s.tz) + (side > 0 ? 0 : Math.PI),
        tiers: 2 + Math.floor(hash01(i, side, 1, seed) * 2),
      });
      if (stacks.length >= maxStacks) return stacks;
    }
  }
  return stacks;
}
