/**
 * Blackbody colour and emission, for anything hot enough to glow.
 *
 * The plan's phrase for this is "one model, two outputs": the brake disc model
 * already knows its temperature because that temperature sets the pad friction and
 * therefore how the car stops. Drawing the glow from the same number costs
 * nothing and cannot disagree with the physics — which a hand-tuned "glow when
 * braking hard" ramp certainly would, and did: the old code lit the discs from a
 * boolean and so glowed instantly from cold and went out instantly when the pedal
 * came up, both of which a 5 kg carbon disc cannot do.
 *
 * Free of three.js, and tested against the temperatures things are known to glow
 * at rather than against how it looks.
 */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export const KELVIN_OFFSET = 273.15;
export const celsiusToKelvin = c => c + KELVIN_OFFSET;

/**
 * Approximate blackbody chromaticity, 1000–15000 K, written into `out` as linear
 * RGB in 0..1 with the brightest channel at 1.
 *
 * A piecewise fit rather than an integral over the Planck curve and the CIE
 * observer: the error is a couple of percent over the range that matters and the
 * shape — red at 1000 K, orange through yellow, white near 6000 K — is what
 * carries the information.
 *
 * Kept normalised, with brightness a separate concern. Temperature says *what
 * colour*; Stefan-Boltzmann says *how bright*; multiplying them together in one
 * function makes a dim red disc and a bright red disc the same object.
 */
export function kelvinToRgb(kelvin, out = { r: 0, g: 0, b: 0 }) {
  const t = clamp(kelvin, 1000, 15000) / 100;

  let r;
  if (t <= 66) {
    r = 255;
  } else {
    r = 329.698727446 * ((t - 60) ** -0.1332047592);
  }

  let g;
  if (t <= 66) {
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
  } else {
    g = 288.1221695283 * ((t - 60) ** -0.0755148492);
  }

  let b;
  if (t >= 66) {
    b = 255;
  } else if (t <= 19) {
    b = 0;
  } else {
    b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  }

  const scale = 1 / 255;
  out.r = clamp(r * scale, 0, 1);
  out.g = clamp(g * scale, 0, 1);
  out.b = clamp(b * scale, 0, 1);
  return out;
}

/**
 * Visible glow, 0..1, from a temperature in Celsius.
 *
 * Below the visible threshold nothing shows at all. Above it, radiated power goes
 * as `T⁴` in Kelvin, which is why a disc looks unlit at 400 °C and fierce at 900:
 * the temperature not quite doubles and the emission goes up by a factor of five.
 * A linear ramp gets this badly wrong in the middle of the range, which is where
 * the disc spends its time.
 */
export const GLOW_THRESHOLD_C = 480;
export const GLOW_FULL_C = 1000;

export function glowIntensity(celsius) {
  if (celsius <= GLOW_THRESHOLD_C) return 0;
  const k = celsiusToKelvin(celsius);
  const lo = celsiusToKelvin(GLOW_THRESHOLD_C);
  const hi = celsiusToKelvin(GLOW_FULL_C);
  const p = (k ** 4 - lo ** 4) / (hi ** 4 - lo ** 4);
  return clamp(p, 0, 1);
}

/**
 * Brake disc glow: colour and intensity together, in place.
 *
 * The colour is *not* the disc's own blackbody temperature mapped straight through
 * `kelvinToRgb`. A carbon disc at 900 °C is 1173 K, and 1173 K on the Planckian
 * locus is a deep orange-red — which is right, and is what the fit gives. What
 * would be wrong is treating the disc as a light source at daylight temperature
 * because it happens to look bright.
 */
export function brakeGlow(celsius, out = { r: 0, g: 0, b: 0, intensity: 0 }) {
  const intensity = glowIntensity(celsius);
  if (intensity <= 0) {
    out.r = 0;
    out.g = 0;
    out.b = 0;
    out.intensity = 0;
    return out;
  }
  kelvinToRgb(celsiusToKelvin(celsius), out);
  out.intensity = intensity;
  return out;
}
