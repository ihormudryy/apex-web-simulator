// js/track/centerline.js
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
  for (let i = 0; i < sampleCount; i++) {
    const s = (i / sampleCount) * length;
    let seg = 0;
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
    const lateral = (qx - s.x) * s.nx + (qz - s.z) * s.nz;
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

  return { samples, length, query };
}
