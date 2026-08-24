/**
 * Sub-pixel jitter sequence for temporal antialiasing.
 *
 * TAA works by moving the sampling grid a fraction of a pixel each frame and
 * accumulating, so over N frames the scene is sampled at N sub-pixel positions
 * and thin geometry stops popping between covered and not-covered. Which
 * positions you pick decides how well it converges.
 *
 * A Halton (2, 3) sequence, which is the standard choice, and worth understanding
 * rather than copying: it is *low-discrepancy*, meaning any prefix of it is
 * already spread evenly over the pixel. Random offsets clump — with 8 random
 * samples you will usually have two nearly on top of each other and a gap
 * somewhere else, and the gap is where the aliasing survives. A regular grid
 * spreads perfectly but only at exactly its own length, and aliases against
 * anything periodic in the scene, of which a kerb pattern and a run of centre-line
 * dashes are two.
 *
 * Free of three.js so the sequence itself can be tested for the property that
 * matters, which is coverage rather than any particular value.
 */

/**
 * The `index`-th term of the radical-inverse (van der Corput) sequence in `base`.
 *
 * Reflect the digits of `index` in `base` about the radix point: 1 → 0.1, 2 → 0.2,
 * 3 → 0.01, and so on. Each new term lands in the largest remaining gap, which is
 * what makes the sequence low-discrepancy.
 */
export function radicalInverse(index, base) {
  let result = 0;
  let f = 1 / base;
  let i = index;
  while (i > 0) {
    result += f * (i % base);
    i = Math.floor(i / base);
    f /= base;
  }
  return result;
}

/** Number of frames before the pattern repeats. */
export const JITTER_PERIOD = 16;

/**
 * Jitter offset for a frame, in pixels, written into `out`.
 *
 * Centred on zero and spanning ±0.5 px: `setViewOffset` moves the whole view, so
 * an offset that is not zero-mean shifts the image as well as antialiasing it, and
 * a shifted image is exactly what a reprojection is trying to undo.
 *
 * The sequence is 1-based. Halton's zeroth term is 0 in every base, so a 0-based
 * index would spend one frame in sixteen taking no sample at all — which is not
 * wrong, but wastes a slot in a sequence chosen for its coverage.
 */
export function jitterAt(frame, out = { x: 0, y: 0 }) {
  const index = (frame % JITTER_PERIOD) + 1;
  out.x = radicalInverse(index, 2) - 0.5;
  out.y = radicalInverse(index, 3) - 0.5;
  return out;
}

/**
 * How much of the accumulated history to keep, per frame.
 *
 * 0.9 is roughly a 10-frame time constant: long enough to converge on thin
 * geometry, short enough that a mistake — a wrong reprojection, a disoccluded
 * pixel — is gone in a sixth of a second rather than smeared across the screen.
 */
/** Heavy accumulation — kept for experiments; default hybrid path uses the light weight. */
export const HISTORY_WEIGHT = 0.9;

/**
 * Light temporal blend for MSAA + hybrid AA. Short enough that smear stays low,
 * long enough to settle thin geometry over a few frames.
 */
export const HYBRID_HISTORY_WEIGHT = 0.52;

/**
 * Reject history that has drifted too far from the current neighbourhood.
 *
 * This is the whole difficulty of TAA without per-object motion vectors.
 * Reprojecting the camera through the depth buffer handles a moving *camera*
 * exactly, and gets a moving *object* wrong: the pixels where the car was last
 * frame reproject to where the background was, so the car smears a trail behind
 * itself. Clamping the history to the range of the current frame's 3×3
 * neighbourhood removes it — a smeared pixel is by definition outside the range of
 * its neighbours.
 *
 * Returns the clamped history value.
 */
export function clipHistory(history, neighbourMin, neighbourMax) {
  return Math.max(neighbourMin, Math.min(neighbourMax, history));
}

/**
 * Widen the clamp box by a fraction of its own size.
 *
 * A box taken from exactly the 3×3 min and max is too tight: a pixel on a thin
 * edge legitimately differs from all eight of its neighbours, and clamping it to
 * their range throws away the very sub-pixel detail the accumulation exists to
 * recover. Widening by ~15% keeps the detail and still catches a smear.
 */
export const CLIP_EXPAND = 0.15;

export function expandBox(min, max, expand = CLIP_EXPAND) {
  const centre = (min + max) * 0.5;
  const half = (max - min) * 0.5 * (1 + expand);
  return { min: centre - half, max: centre + half };
}
