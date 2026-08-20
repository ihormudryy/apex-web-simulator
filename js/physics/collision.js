/**
 * Wall collision, with the car as a body rather than a point.
 *
 * What this replaces treated the car as a particle at the CoG: one lateral test,
 * one velocity reflection, yaw rate halved by decree. Three things a particle
 * cannot do, and all three are what a wall hit *is*:
 *
 *   - **A corner hits first.** A car arriving nose-first takes the impact at the
 *     nose, and the impulse there produces a yaw moment — the car pivots off the
 *     wall. The point model just slid.
 *   - **Glancing and head-on are different events.** The impulse follows the
 *     closing speed along the wall normal at the *contact point*, so brushing a
 *     wall at 300 km/h is a scrape and hitting it square at 60 is a wreck —
 *     rather than both being "some velocity removed".
 *   - **Scraping is friction.** Sliding along the wall costs speed through a
 *     tangential impulse capped by the normal one, which is why wall-riding is
 *     not a racing line.
 *
 * Planar rigid-body contact: an impulse at the deepest penetrating corner with
 * restitution, Coulomb friction, and positional correction. Armco yields, so the
 * restitution is low — a barrier hit is a thud, not a bounce.
 *
 * Free of three.js, allocation-free per resolve, and deterministic — a replay
 * that includes a crash reproduces the crash.
 */

import { MASS, IZ, LF, LR } from './constants.js';
import * as ST from './state.js';

/**
 * The collision footprint, body frame (x forward, y right). Nose and tail are
 * axle position plus overhang — the front wing is a long way ahead of the axle,
 * which is exactly why nose-first hits are wing hits.
 */
export const NOSE_X = LF + 1.05;
export const TAIL_X = -(LR + 0.85);
export const HALF_WIDTH = 0.98;

/** Corner order: nose-left, nose-right, tail-left, tail-right. */
export const CORNER_X = [NOSE_X, NOSE_X, TAIL_X, TAIL_X];
export const CORNER_Y = [-HALF_WIDTH, HALF_WIDTH, -HALF_WIDTH, HALF_WIDTH];

/** Armco yields; a barrier strike is a thud, not a bounce. */
export const RESTITUTION = 0.15;
/** Steel on sliding carbon and bodywork. */
export const WALL_FRICTION = 0.5;
/**
 * Broad phase: corners are only queried when the chassis is within this of the
 * wall. The diagonal of the footprint, plus slack.
 */
export const BROAD_MARGIN = 3.4;

/** One scratch result, reused so the sim loop allocates nothing. */
export function createContact() {
  return {
    hit: false,
    corner: -1,
    /** Closing speed into the wall at the contact, m/s. The damage input. */
    severity: 0,
    /** Sliding speed along the wall at the contact, m/s. Sparks and scrape. */
    scrape: 0,
    /** World position of the contact, for effects. */
    x: 0,
    z: 0,
    /** How many corners were touching. */
    touching: 0,
  };
}

/**
 * Resolve wall contact for one sim step, writing the outcome into `S` and the
 * report into `out`.
 *
 * @param {Float64Array} S the car's state vector
 * @param {object} track anything with `query(x, z) -> { lateral, wallLimit,
 *   normal: {x, z} }`
 * @param {object} out from `createContact`
 */
export function resolveWallContact(S, track, out) {
  out.hit = false;
  out.touching = 0;
  out.severity = 0;
  out.scrape = 0;
  out.corner = -1;

  // Broad phase on the chassis point.
  const centre = track.query(S[ST.S_X], S[ST.S_Z]);
  if (centre.wallLimit === undefined) return out;
  if (Math.abs(centre.lateral) < centre.wallLimit - BROAD_MARGIN) return out;

  const yaw = S[ST.S_YAW];
  const sinY = Math.sin(yaw);
  const cosY = Math.cos(yaw);
  // Yaw 0 faces -Z: forward = (-sin, -cos), right = (cos, -sin).
  const fx = -sinY;
  const fz = -cosY;
  const rx = cosY;
  const rz = -sinY;

  const yaw2 = 0;   // (kept for clarity of the frame comment above)
  void yaw2;

  // Gather the touching corners first, then iterate the velocity solve over all
  // of them. This matters for the flat, side-against-wall case: it is a
  // two-contact event, and resolving only the deepest corner turns most of the
  // impulse into rotation while the chassis carries on into the wall — measured
  // as a 10 m/s side hit leaving 8.4 m/s of closing speed. Alternating impulses
  // over both contacts converge to zero closing speed at each, and their yaw
  // contributions cancel the way a flat hit should.
  const CONTACTS = 4;
  let any = false;
  let deepestPen = 0;
  let deepestIdx = -1;
  for (let i = 0; i < CONTACTS; i++) {
    const wx = S[ST.S_X] + CORNER_X[i] * fx + CORNER_Y[i] * rx;
    const wz = S[ST.S_Z] + CORNER_X[i] * fz + CORNER_Y[i] * rz;
    const q = track.query(wx, wz);
    scratch.pen[i] = q.wallLimit === undefined ? -1 : Math.abs(q.lateral) - q.wallLimit;
    if (scratch.pen[i] > 0) {
      // Inward is +normal when lateral is positive. The centreline convention is
      //   lateral = -((P - S) . n)
      // so moving along +n DECREASES lateral. Getting this backwards does not
      // fail loudly — it pushes the car OUT of the track a little more each step,
      // penetration grows, and the positional correction compounds exponentially:
      // measured, the car doubled its distance from the circuit every sim step
      // until the state overflowed at 1e308. The fixture in collision.test.js
      // encodes the same convention precisely so this cannot pass tests again.
      const side = q.lateral > 0 ? 1 : -1;
      const nx = side * q.normal.x;
      const nz = side * q.normal.z;
      scratch.nx[i] = nx;
      scratch.nz[i] = nz;
      scratch.wx[i] = wx;
      scratch.wz[i] = wz;
      any = true;
      out.touching++;
      if (scratch.pen[i] > deepestPen) {
        deepestPen = scratch.pen[i];
        deepestIdx = i;
      }
      // Severity is the ARRIVAL closing speed, measured here before any impulse
      // has been applied. Reading it inside the solve loop double-counted: the
      // first contact's impulse adds rotation, which inflates the closing speed
      // seen at the second contact — a 2.7 m/s brush reported as 4.2.
      const rcx = wx - S[ST.S_X];
      const rcz = wz - S[ST.S_Z];
      const vpx = S[ST.S_VX] + S[ST.S_AV] * rcz;
      const vpz = S[ST.S_VZ] - S[ST.S_AV] * rcx;
      const vn = vpx * nx + vpz * nz;
      const vt = Math.abs(vpx * -nz + vpz * nx);
      if (-vn > out.severity) {
        out.severity = Math.max(0, -vn);
        out.corner = i;
        out.x = wx;
        out.z = wz;
        out.scrape = vt;
      } else if (out.corner < 0) {
        out.corner = i;
        out.x = wx;
        out.z = wz;
        out.scrape = vt;
      }
    }
  }
  if (!any) return out;

  // Velocity iterations over the active contacts.
  for (let pass = 0; pass < 4; pass++) {
    for (let i = 0; i < CONTACTS; i++) {
      if (scratch.pen[i] <= 0) continue;
      const nx = scratch.nx[i];
      const nz = scratch.nz[i];
      const rcx = scratch.wx[i] - S[ST.S_X];
      const rcz = scratch.wz[i] - S[ST.S_Z];
      const av = S[ST.S_AV];
      const vpx = S[ST.S_VX] + av * rcz;
      const vpz = S[ST.S_VZ] - av * rcx;
      const vn = vpx * nx + vpz * nz;
      if (vn >= 0) continue;
      const rCrossN = rcz * nx - rcx * nz;
      const j = -(1 + RESTITUTION) * vn / (1 / MASS + rCrossN * rCrossN / IZ);
      S[ST.S_VX] += (j / MASS) * nx;
      S[ST.S_VZ] += (j / MASS) * nz;
      S[ST.S_AV] += j * rCrossN / IZ;

      // Coulomb friction along the wall, capped by this contact's normal impulse.
      const tx = -nz;
      const tz = nx;
      const vt = vpx * tx + vpz * tz;
      const rCrossT = rcz * tx - rcx * tz;
      const jtNeeded = -vt / (1 / MASS + rCrossT * rCrossT / IZ);
      const jt = Math.max(-WALL_FRICTION * j, Math.min(WALL_FRICTION * j, jtNeeded));
      S[ST.S_VX] += (jt / MASS) * tx;
      S[ST.S_VZ] += (jt / MASS) * tz;
      S[ST.S_AV] += jt * rCrossT / IZ;

      out.hit = true;
    }
  }

  // One positional correction, along the deepest contact's normal.
  if (deepestIdx >= 0) {
    S[ST.S_X] += deepestPen * scratch.nx[deepestIdx];
    S[ST.S_Z] += deepestPen * scratch.nz[deepestIdx];
  }
  return out;
}

/** Contact scratch, module-level so the resolve allocates nothing. */
const scratch = {
  pen: new Float64Array(4),
  nx: new Float64Array(4),
  nz: new Float64Array(4),
  wx: new Float64Array(4),
  wz: new Float64Array(4),
};
