/**
 * Car-to-car contact: the moving-vs-moving sibling of `collision.js`.
 *
 * That module resolves a car against a STATIC wall, so all of the impulse goes
 * into one body. Two cars are a two-body problem: the impulse is equal and
 * opposite, and both the linear and the angular terms of both bodies enter the
 * effective mass. Reusing the wall solver with the other car standing in for
 * the wall gives each car the full impulse instead of its share — a touch then
 * throws both cars apart at roughly twice the speed they met at, which is also
 * the shape of the bug the energy test in carContact.test.js exists to catch.
 *
 * Same footprint as the wall solver, because it is the same car: corners at
 * NOSE_X / TAIL_X by ±HALF_WIDTH. Contact is tested as overlapping corner
 * discs rather than full polygon clipping — at these speeds and this size the
 * difference is not visible, and it keeps the routine allocation-free.
 *
 * The impulse normal is the centre-to-centre direction, NOT the vector between
 * the deepest-penetrating corner pair. The corner pairs still find penetration
 * depth and the contact points (for the lever arms, so a glancing hit still
 * produces spin) — but using a corner pair's own vector for the normal too
 * breaks down under a single big overlap: a nose corner that has already
 * travelled past the other car's tail corner has a corner-pair distance that
 * is INCREASING even while the cars are still closing overall, because that
 * one corner has tunnelled past the point it is being measured against.
 * Measured: a 20 m/s rear-end shot with the cars already 4.5 m apart (a
 * single-step snapshot, not an integrated approach) reported the nose/tail
 * corner pair as separating (vn > 0) and the resolve was skipped entirely — a
 * car could plough straight through another and feel nothing. Centre-to-centre
 * has no such blind spot: two centres never tunnel past each other while their
 * bounding radii still overlap, so its sign always agrees with whether the
 * bodies are closing.
 *
 * A square (head-on, no lateral offset) hit overlaps its left AND right
 * corner pairs equally. Resolving only the single deepest pair — an arbitrary
 * tie-break between them — puts the whole impulse's lever arm on one side and
 * spins the car that a symmetric hit should not spin, the same "single
 * deepest corner turns a flat hit into rotation" failure `collision.js`
 * documents for the wall case. The fix is the same one it uses: gather every
 * overlapping corner pair and run several velocity passes over all of them,
 * so the two sides' torques converge to cancelling out.
 */

import { MASS, IZ } from './constants.js';
import { CORNER_X, CORNER_Y, NOSE_X, TAIL_X, HALF_WIDTH } from './collision.js';
import * as ST from './state.js';

/** Carbon on carbon, not steel on carbon: less give than the Armco. */
export const CAR_RESTITUTION = 0.25;
export const CAR_FRICTION = 0.4;
/** Disc radius at each corner, m. Half the diagonal of the corner quadrant. */
export const CONTACT_RADIUS = 0.9;
/** Broad phase: no corner can touch beyond this centre distance, m. */
const BROAD = (NOSE_X - TAIL_X) + 2 * HALF_WIDTH;
/** Fraction of the overlap pushed out per call, split between the two cars. */
const CORRECTION = 0.5;

export function createCarContact() {
  return { hit: false, severity: 0, x: 0, z: 0 };
}

function cornerWorld(S, i, out) {
  const yaw = S[ST.S_YAW];
  const sinY = Math.sin(yaw), cosY = Math.cos(yaw);
  // Yaw 0 faces -Z: forward = (-sin, -cos), right = (cos, -sin).
  out.x = S[ST.S_X] + CORNER_X[i] * -sinY + CORNER_Y[i] * cosY;
  out.z = S[ST.S_Z] + CORNER_X[i] * -cosY + CORNER_Y[i] * -sinY;
  return out;
}

const pa = { x: 0, z: 0 };
const pb = { x: 0, z: 0 };

/** Up to 16 corner-pair contacts, module-level so resolve allocates nothing. */
const MAX_PAIRS = 16;
const scratch = {
  cx: new Float64Array(MAX_PAIRS),
  cz: new Float64Array(MAX_PAIRS),
};

/** Velocity-solve passes over the active contacts. See header. */
const PASSES = 4;

/**
 * @param {Float64Array} SA
 * @param {Float64Array} SB
 * @param {ReturnType<typeof createCarContact>} out
 */
export function resolveCarContact(SA, SB, out) {
  out.hit = false;
  out.severity = 0;

  const dxc = SB[ST.S_X] - SA[ST.S_X];
  const dzc = SB[ST.S_Z] - SA[ST.S_Z];
  const dc2 = dxc * dxc + dzc * dzc;
  if (dc2 > BROAD * BROAD) return out;

  // Every overlapping corner pair, for penetration depth and contact points.
  let count = 0;
  let deepestPen = 0, deepestIdx = -1;
  for (let i = 0; i < 4; i++) {
    cornerWorld(SA, i, pa);
    for (let j = 0; j < 4; j++) {
      cornerWorld(SB, j, pb);
      const dx = pb.x - pa.x, dz = pb.z - pa.z;
      const d = Math.hypot(dx, dz);
      const pen = 2 * CONTACT_RADIUS - d;
      if (pen > 0) {
        scratch.cx[count] = 0.5 * (pa.x + pb.x);
        scratch.cz[count] = 0.5 * (pa.z + pb.z);
        if (pen > deepestPen) { deepestPen = pen; deepestIdx = count; }
        count++;
      }
    }
  }
  if (count === 0) return out;

  out.x = scratch.cx[deepestIdx];
  out.z = scratch.cz[deepestIdx];

  // Normal: centre-to-centre, shared by every contact pair. See header.
  const dc = Math.sqrt(dc2);
  const nx = dc > 1e-9 ? dxc / dc : 1;
  const nz = dc > 1e-9 ? dzc / dc : 0;
  const tx = -nz, tz = nx;

  // Severity is the arrival closing speed at the deepest contact, read before
  // any impulse — mirrors the wall solver, which measures once up front so an
  // earlier contact's impulse cannot inflate what a later one reports.
  {
    const rax = out.x - SA[ST.S_X], raz = out.z - SA[ST.S_Z];
    const rbx = out.x - SB[ST.S_X], rbz = out.z - SB[ST.S_Z];
    const vax = SA[ST.S_VX] + SA[ST.S_AV] * raz;
    const vaz = SA[ST.S_VZ] - SA[ST.S_AV] * rax;
    const vbx = SB[ST.S_VX] + SB[ST.S_AV] * rbz;
    const vbz = SB[ST.S_VZ] - SB[ST.S_AV] * rbx;
    const vn = (vbx - vax) * nx + (vbz - vaz) * nz;
    out.severity = Math.max(0, -vn);
  }

  // Velocity iterations over every overlapping corner pair, all sharing the
  // one centre-to-centre normal. A symmetric (square) hit overlaps its left
  // and right pairs equally; resolving both, repeatedly, converges their
  // opposite torques to cancel rather than freezing in whichever pair the
  // scan happened to see first.
  for (let pass = 0; pass < PASSES; pass++) {
    for (let k = 0; k < count; k++) {
      const cx = scratch.cx[k], cz = scratch.cz[k];
      const rax = cx - SA[ST.S_X], raz = cz - SA[ST.S_Z];
      const rbx = cx - SB[ST.S_X], rbz = cz - SB[ST.S_Z];

      // Point velocities. av is yaw-left positive: v_point = v + av x r.
      const vax = SA[ST.S_VX] + SA[ST.S_AV] * raz;
      const vaz = SA[ST.S_VZ] - SA[ST.S_AV] * rax;
      const vbx = SB[ST.S_VX] + SB[ST.S_AV] * rbz;
      const vbz = SB[ST.S_VZ] - SB[ST.S_AV] * rbx;
      const rvx = vbx - vax, rvz = vbz - vaz;
      const vn = rvx * nx + rvz * nz;
      if (vn >= 0) continue;

      const raCrossN = raz * nx - rax * nz;
      const rbCrossN = rbz * nx - rbx * nz;
      // Both bodies contribute to the effective mass — this is the whole
      // difference from the wall case, where the wall's terms are infinite.
      const invEff = 2 / MASS + (raCrossN * raCrossN + rbCrossN * rbCrossN) / IZ;
      const j = -(1 + CAR_RESTITUTION) * vn / invEff;

      SA[ST.S_VX] -= (j / MASS) * nx;
      SA[ST.S_VZ] -= (j / MASS) * nz;
      SA[ST.S_AV] -= j * raCrossN / IZ;
      SB[ST.S_VX] += (j / MASS) * nx;
      SB[ST.S_VZ] += (j / MASS) * nz;
      SB[ST.S_AV] += j * rbCrossN / IZ;

      // Coulomb friction along the tangent, capped by the normal impulse.
      const vt = rvx * tx + rvz * tz;
      const raCrossT = raz * tx - rax * tz;
      const rbCrossT = rbz * tx - rbx * tz;
      const invEffT = 2 / MASS + (raCrossT * raCrossT + rbCrossT * rbCrossT) / IZ;
      const jtNeeded = -vt / invEffT;
      const cap = CAR_FRICTION * Math.abs(j);
      const jt = Math.max(-cap, Math.min(cap, jtNeeded));

      SA[ST.S_VX] -= (jt / MASS) * tx;
      SA[ST.S_VZ] -= (jt / MASS) * tz;
      SA[ST.S_AV] -= jt * raCrossT / IZ;
      SB[ST.S_VX] += (jt / MASS) * tx;
      SB[ST.S_VZ] += (jt / MASS) * tz;
      SB[ST.S_AV] += jt * rbCrossT / IZ;

      out.hit = true;
    }
  }

  // One positional correction, along the deepest contact's normal, split
  // evenly — equal masses, equal share.
  const push = deepestPen * CORRECTION * 0.5;
  SA[ST.S_X] -= push * nx;
  SA[ST.S_Z] -= push * nz;
  SB[ST.S_X] += push * nx;
  SB[ST.S_Z] += push * nz;
  return out;
}
