/**
 * Colour grading, as a tone curve rather than a lookup table.
 *
 * The plan puts this last and on a correct image, which is the right order and
 * worth keeping to: grading applied to a broken image hides the break, and once
 * hidden nobody finds it. So this arrives after the tyre model, the aero, the
 * track and the effects, and it has a measured job rather than a look.
 *
 * The job comes from the rendering dashboard, which after everything else is
 * green reports one metric still off: **crushed shadows, 5.0% of pixels at or
 * below 5/255, against a target of 2%.** That is a real fault and a specific one —
 * a twentieth of the frame is carrying no information at all, mostly in the
 * shadowed side of the car and under the barriers. Lifting the toe of the curve
 * fixes exactly that and nothing else.
 *
 * A curve rather than a 3D LUT for two reasons. A LUT is a texture to author,
 * upload and sample, and nothing here needs per-hue control — the fault is
 * tonal. And a curve can be tested: `crushedFraction` below takes a histogram and
 * says what the dashboard will say, so the setting is chosen by measurement
 * instead of by eye.
 *
 * Free of three.js, so it can be.
 */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * How far off the floor to lift the darkest pixels, in 0..1 display units.
 *
 * 5/255 is the dashboard's "crushed" threshold, so a lift of about 8/255 moves the
 * genuinely-black pixels just clear of it while leaving anything already above it
 * essentially untouched.
 */
export const TOE_LIFT = 0.032;
/** Where the lift has faded out. Above this the curve is the identity. */
export const TOE_RANGE = 0.16;
/**
 * A little shoulder compression, so lifting the toe does not flatten the frame.
 * The dashboard measures contrast as p95 − p5, and it has to stay above 90.
 */
export const SHOULDER = 0.06;
export const SHOULDER_FROM = 0.75;

/**
 * The tone curve, in display-referred 0..1.
 *
 * Lift the toe, leave the middle alone, and pull the very top down slightly. The
 * middle is deliberately untouched: the mean luminance and the saturation are both
 * inside target already, and a curve that moves them to fix the shadows has
 * traded a measured fault for two.
 */
export function toneCurve(x) {
  const v = clamp(x, 0, 1);
  // Toe: a smooth lift that decays to nothing by TOE_RANGE. `1 - (v/range)` gives
  // a kink at the join; squaring it makes the join C1 and invisible.
  let out = v;
  if (v < TOE_RANGE) {
    const t = 1 - v / TOE_RANGE;
    out += TOE_LIFT * t * t;
  }
  if (out > SHOULDER_FROM) {
    const t = (out - SHOULDER_FROM) / (1 - SHOULDER_FROM);
    out -= SHOULDER * t * t;
  }
  return clamp(out, 0, 1);
}

/** The curve as GLSL, so there is exactly one definition of it. */
export const TONE_CURVE_GLSL = /* glsl */`
float toneCurve(float x) {
  float v = clamp(x, 0.0, 1.0);
  float out_ = v;
  if (v < ${TOE_RANGE}) {
    float t = 1.0 - v / ${TOE_RANGE};
    out_ += ${TOE_LIFT} * t * t;
  }
  if (out_ > ${SHOULDER_FROM}) {
    float t = (out_ - ${SHOULDER_FROM}) / ${(1 - SHOULDER_FROM).toFixed(6)};
    out_ -= ${SHOULDER} * t * t;
  }
  return clamp(out_, 0.0, 1.0);
}`;

/**
 * Saturation adjustment about luminance. Kept tiny and separate from the curve.
 *
 * The dashboard's saturation band is 0.08–0.34 and the frame measures 0.14, so
 * there is room, and a British circuit under high cloud should not be pushed far.
 */
export const SATURATION = 1.06;
export const LUMA_WEIGHTS = { r: 0.2126, g: 0.7152, b: 0.0722 };

export function applyGrade(r, g, b, out = { r: 0, g: 0, b: 0 }) {
  const cr = toneCurve(r);
  const cg = toneCurve(g);
  const cb = toneCurve(b);
  const luma = cr * LUMA_WEIGHTS.r + cg * LUMA_WEIGHTS.g + cb * LUMA_WEIGHTS.b;
  out.r = clamp(luma + (cr - luma) * SATURATION, 0, 1);
  out.g = clamp(luma + (cg - luma) * SATURATION, 0, 1);
  out.b = clamp(luma + (cb - luma) * SATURATION, 0, 1);
  return out;
}

// ---------------------------------------------------------------------------
// Measuring what the dashboard measures
// ---------------------------------------------------------------------------

/** Fraction of a luminance histogram at or below `level`, as a percentage. */
export function crushedFraction(histogram, level = 5) {
  let below = 0;
  let total = 0;
  for (let i = 0; i < histogram.length; i++) {
    total += histogram[i];
    if (i <= level) below += histogram[i];
  }
  return total ? (100 * below) / total : 0;
}

/** Fraction at or above `level`, as a percentage. Clipped highlights. */
export function clippedFraction(histogram, level = 250) {
  let above = 0;
  let total = 0;
  for (let i = 0; i < histogram.length; i++) {
    total += histogram[i];
    if (i >= level) above += histogram[i];
  }
  return total ? (100 * above) / total : 0;
}

/** p95 − p5 of a histogram, which is how the dashboard defines contrast. */
export function histogramContrast(histogram) {
  let total = 0;
  for (let i = 0; i < histogram.length; i++) total += histogram[i];
  if (!total) return 0;
  const at = p => {
    const want = p * total;
    let seen = 0;
    for (let i = 0; i < histogram.length; i++) {
      seen += histogram[i];
      if (seen >= want) return i;
    }
    return histogram.length - 1;
  };
  return at(0.95) - at(0.05);
}

/**
 * Push a histogram through the curve, so the effect on the dashboard's own
 * numbers can be predicted before touching a shader.
 */
export function gradeHistogram(histogram) {
  const out = new Float64Array(histogram.length);
  for (let i = 0; i < histogram.length; i++) {
    if (!histogram[i]) continue;
    const graded = Math.round(toneCurve(i / 255) * 255);
    out[clamp(graded, 0, 255)] += histogram[i];
  }
  return out;
}
