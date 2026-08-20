/**
 * Rubber accumulated into a track-space texture.
 *
 * The asphalt material already carries an un-tiled `aSurfaceUv` addressing the
 * whole circuit — lap fraction along, normalised width across — which exists for
 * the baked racing line. Writing into a texture on those coordinates makes the
 * racing line **dynamic**: laid down by the car rather than authored, deepening
 * over a session exactly where the tyres have been put.
 *
 * Free of three.js so the accumulation can be tested; `carEffects.js` wraps the
 * buffer in a `DataTexture`.
 */

/**
 * Resolution. Width is the short axis on purpose: a circuit is 5.9 km long and
 * 12 m wide, so the along-lap axis is the one that has to be generous. 2048
 * samples over 5891 m is one every 2.9 m, about the length of a braking mark worth
 * seeing; 128 across 24 m of surface-plus-runoff is 19 cm, narrower than a tyre.
 */
export const MARK_ALONG = 2048;
export const MARK_ACROSS = 128;
/** Darkness added per unit of intensity-seconds. */
export const MARK_GAIN = 90;
/** Rubber does not build up forever. */
export const MARK_CEILING = 235;

export function createMarkBuffer(along = MARK_ALONG, across = MARK_ACROSS) {
  return {
    along,
    across,
    data: new Uint8Array(along * across),
    dirty: false,
  };
}

export function clearMarks(marks) {
  marks.data.fill(0);
  marks.dirty = true;
}

/**
 * Lay rubber at a point in track space.
 *
 * @param {object} marks from `createMarkBuffer`
 * @param {number} t lap fraction; wraps, because a lap does
 * @param {number} across normalised position, −1 at one edge to +1 at the other
 * @param {number} amount intensity × dt
 */
export function layMark(marks, t, across, amount) {
  if (!(amount > 0)) return false;
  if (across < -1 || across > 1) return false;
  const u = Math.floor((((t % 1) + 1) % 1) * marks.along) % marks.along;
  const v = Math.round((across * 0.5 + 0.5) * (marks.across - 1));
  const add = amount * MARK_GAIN;
  // A small cross rather than a single texel. One texel is 2.9 m long and 19 cm
  // wide, so a single-texel mark reads as a dash rather than as a line.
  for (let dv = -1; dv <= 1; dv++) {
    const vv = v + dv;
    if (vv < 0 || vv >= marks.across) continue;
    const weight = dv === 0 ? 1 : 0.45;
    const i = vv * marks.along + u;
    marks.data[i] = Math.min(MARK_CEILING, marks.data[i] + add * weight);
  }
  marks.dirty = true;
  return true;
}

/** Total rubber laid, for tests and for a debug readout. */
export function markTotal(marks) {
  let sum = 0;
  for (let i = 0; i < marks.data.length; i++) sum += marks.data[i];
  return sum;
}

/** Darkness at a point, 0..255. */
export function markAt(marks, t, across) {
  const u = Math.floor((((t % 1) + 1) % 1) * marks.along) % marks.along;
  const v = Math.round((across * 0.5 + 0.5) * (marks.across - 1));
  if (v < 0 || v >= marks.across) return 0;
  return marks.data[v * marks.along + u];
}
