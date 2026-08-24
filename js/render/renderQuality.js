/**
 * Desktop quality presets for the browser race experience.
 * Pure data — HelloRacer / RenderPanel apply these.
 */

export const QUALITY_PRESETS = {
  ultra: {
    label: 'Ultra',
    renderScale: 1.15,
    ssao: true,
    bounce: true,
    csm: true,
    taa: true,
    grade: true,
    motionBlur: true,
    bloom: true,
    flare: true,
    dof: false,
    shadowMapSize: 2048,
    csmCascades: 4,
    grassDensity: 1,
    smokeBudget: 1,
    aoBlend: 0.5,
    motionBlurStrength: 0.55,
  },
  high: {
    label: 'High',
    renderScale: 1.0,
    ssao: true,
    bounce: true,
    csm: true,
    taa: true,
    grade: true,
    motionBlur: true,
    bloom: true,
    flare: true,
    dof: false,
    shadowMapSize: 2048,
    csmCascades: 4,
    grassDensity: 0.85,
    smokeBudget: 0.85,
    aoBlend: 0.45,
    motionBlurStrength: 0.5,
  },
  balanced: {
    label: 'Balanced',
    renderScale: 0.92,
    ssao: true,
    bounce: false,
    csm: true,
    taa: true,
    grade: true,
    motionBlur: true,
    bloom: true,
    flare: false,
    dof: false,
    shadowMapSize: 1024,
    csmCascades: 3,
    grassDensity: 0.55,
    smokeBudget: 0.6,
    aoBlend: 0.4,
    motionBlurStrength: 0.4,
  },
};

export const QUALITY_ORDER = ['ultra', 'high', 'balanced'];

export function nextQualityPreset(current) {
  const i = QUALITY_ORDER.indexOf(current);
  return QUALITY_ORDER[(Math.max(i, 0) + 1) % QUALITY_ORDER.length];
}

/** Soft overcast lighting — matches the reference still's diffused sky. */
export const OVERCAST_LIGHTING = {
  sunIntensity: 1.35,
  shadowIntensity: 0.55,
  hemiIntensity: { webgl: 0.72, webgpu: 0.55 },
  rimIntensity: { webgl: 0.22, webgpu: 0.14 },
  envIntensity: 1.05,
  toneExposure: 0.98,
};

/**
 * @param {'ultra'|'high'|'balanced'} id
 */
export function qualityPreset(id) {
  return QUALITY_PRESETS[id] ?? QUALITY_PRESETS.high;
}
