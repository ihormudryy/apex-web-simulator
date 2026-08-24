/**
 * Tyre-smoke look: envelopes and emit recipes, free of three.js.
 *
 * Real rubber smoke is a soft, mottled plume that grows as it rises and fades
 * gently — not flat discs that appear at full opacity and vanish. The physics
 * still decides *how much* smoke (`smokeRate`); this decides how each puff looks.
 */

const clamp01 = v => Math.max(0, Math.min(1, v));

/**
 * Opacity over normalised age `t` in [0,1].
 * Soft ramp in, long plateau, long soft ramp out — like a real plume dissolving.
 */
export function smokeAlpha(t) {
  const u = clamp01(t);
  // Softer birth, longer dissolve — reads more volumetric in a still.
  const fadeIn = clamp01(u / 0.18);
  const fadeOut = clamp01((1 - u) / 0.55);
  const a = fadeIn * fadeIn * (3 - 2 * fadeIn);
  const b = fadeOut * fadeOut * (3 - 2 * fadeOut);
  return a * b * 0.92;
}

/**
 * Fade a particle fragment as it approaches opaque scene depth.
 *
 * `sceneDist` / `fragDist` are metres in front of the camera. A missing or
 * unusable scene sample returns 1 so smoke still draws before the first depth
 * harvest. Zero softness disables the fade.
 *
 * @param {number} sceneDist
 * @param {number} fragDist
 * @param {number} [softness=0.55]
 */
export function softParticleFade(sceneDist, fragDist, softness = 0.55) {
  if (!(softness > 0)) return 1;
  if (!(sceneDist > 0) || !Number.isFinite(sceneDist)) return 1;
  const gap = sceneDist - fragDist;
  if (!(gap > 0)) return 0;
  if (gap >= softness) return 1;
  const t = gap / softness;
  return t * t * (3 - 2 * t);
}

/** Metres of fade in front of an occluder — tyre smoke scale. */
export const SOFT_PARTICLE_METRES = 0.55;

/**
 * World size multiplier over life. Smoke expands as it cools and mixes.
 * @param {number} t normalised age
 * @param {number} [expand=2.4] final size / birth size
 */
export function smokeSizeScale(t, expand = 3.1) {
  const u = clamp01(t);
  // Ease-out: most of the growth early, then a slow bloom.
  const e = 1 - (1 - u) * (1 - u);
  return 1 + (expand - 1) * e;
}

/**
 * One puff's birth parameters from intensity and a [0,1) random.
 * Returns velocity extras relative to the contact patch frame.
 *
 * @param {number} intensity smokeRate 0..1
 * @param {() => number} rand
 */
export function smokePuff(intensity, rand = Math.random) {
  const i = clamp01(intensity);
  // Dense core vs wispy outer — two recipes share one ring.
  const wisp = rand() > 0.45 + i * 0.15;
  const life = wisp
    ? 2.0 + rand() * 2.2
    : 1.1 + rand() * 1.4;
  const size = wisp
    ? 0.7 + rand() * 1.1
    : 0.35 + rand() * 0.55;
  const rise = wisp
    ? 0.25 + rand() * 0.7
    : 0.45 + rand() * 1.1;
  const scatter = wisp ? 2.6 + rand() * 3.2 : 1.3 + rand() * 1.9;
  const back = 0.05 + rand() * 0.1 + i * 0.06;
  return { life, size, rise, scatter, back, wisp, seed: rand() };
}
