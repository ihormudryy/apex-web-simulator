/**
 * Defaults and clamps for the foldable render overlay.
 * Keeps slider ranges out of the DOM module so they stay unit-testable.
 */

import {
  ENVIRONMENT_INTENSITY,
  HEMISPHERE_INTENSITY,
  RIM_INTENSITY,
  SHADOW_INTENSITY,
  SUN_INTENSITY,
  TONE_EXPOSURE,
} from './lightingBalance.js';
import {
  CINEMATIC_DEFAULTS, CINEMATIC_SLIDERS, CINEMATIC_TOGGLES,
} from './cinematicState.js';

export const DEFAULT_REFLECTIVITY = 0.45;
export const DEFAULT_AO_BLEND = 0.45;

/** Every FX checkbox, lighting and cinematic alike. */
export const FX_FLAGS = ['ssao', 'bounce', 'csm', 'taa', 'grade', ...CINEMATIC_TOGGLES];

export const RENDER_SLIDERS = {
  toneExposure: { min: 0.2, max: 2.5, step: 0.01 },
  envIntensity: { min: 0, max: 2, step: 0.01 },
  sunIntensity: { min: 0, max: 6, step: 0.05 },
  shadowIntensity: { min: 0, max: 1, step: 0.01 },
  hemiIntensity: { min: 0, max: 1.5, step: 0.01 },
  rimIntensity: { min: 0, max: 1.5, step: 0.01 },
  reflectivity: { min: 0, max: 1, step: 0.01 },
  aoBlend: { min: 0, max: 1, step: 0.01 },
  ...CINEMATIC_SLIDERS,
};

/**
 * @param {number} v
 * @param {number} min
 * @param {number} max
 */
export function clampRange(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/**
 * @param {number} v
 */
export function clamp01(v) {
  return clampRange(v, 0, 1);
}

/**
 * @param {'webgl' | 'webgpu'} [backend]
 */
export function defaultRenderValues(backend = 'webgpu') {
  const hemi = HEMISPHERE_INTENSITY[backend] ?? HEMISPHERE_INTENSITY.webgl;
  const rim = RIM_INTENSITY[backend] ?? RIM_INTENSITY.webgl;
  return {
    toneExposure: TONE_EXPOSURE,
    envIntensity: ENVIRONMENT_INTENSITY,
    sunIntensity: SUN_INTENSITY,
    shadowIntensity: SHADOW_INTENSITY,
    hemiIntensity: hemi,
    rimIntensity: rim,
    reflectivity: DEFAULT_REFLECTIVITY,
    aoBlend: DEFAULT_AO_BLEND,
    ssao: false,
    bounce: true,
    csm: true,
    taa: false,
    grade: true,
    ...CINEMATIC_DEFAULTS,
  };
}

/**
 * Clamp numeric slider fields; leave FX bools as booleans.
 * @param {Record<string, unknown>} values
 */
export function sanitizeRenderValues(values) {
  const out = { ...values };
  for (const [key, range] of Object.entries(RENDER_SLIDERS)) {
    if (key in out) out[key] = clampRange(out[key], range.min, range.max);
  }
  for (const key of FX_FLAGS) {
    if (key in out) out[key] = Boolean(out[key]);
  }
  return out;
}
