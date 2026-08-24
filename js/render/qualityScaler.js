/**
 * Auto quality: watch frame time, step Ultra → High → Balanced when the GPU
 * is over budget, and climb back when there is headroom.
 *
 * Pure arithmetic — HelloRacer applies the chosen preset. `Q` still cycles
 * by hand; a manual pick pauses auto so the choice is visible.
 */

import { QUALITY_ORDER, qualityPreset } from './renderQuality.js';

export const QUALITY_SCALER = {
  /** 60 Hz budget. */
  targetMs: 1000 / 60,
  /** Drop when EMA sits above this (~50 fps). */
  downMs: 20,
  /** Climb when EMA sits below this (~76 fps). */
  upMs: 13.2,
  emaAlpha: 0.12,
  downHoldS: 0.75,
  upHoldS: 2.5,
  cooldownS: 2,
  warmupS: 3,
  /** Ignore a backgrounded tab / shader hitch. */
  stallMs: 80,
  /** After `Q`, auto waits this long before touching the preset again. */
  manualHoldS: 6,
};

/**
 * @param {{ preset?: string, auto?: boolean, warmupS?: number, cooldownS?: number }} [opts]
 */
export function createQualityScaler({
  preset = 'ultra',
  auto = true,
  warmupS = QUALITY_SCALER.warmupS,
  cooldownS = QUALITY_SCALER.cooldownS,
} = {}) {
  return {
    preset: QUALITY_ORDER.includes(preset) ? preset : 'ultra',
    auto: Boolean(auto),
    emaMs: 0,
    holdS: 0,
    holdDir: 0,
    cooldownS: 0,
    warmupS,
    cooldownDefaultS: cooldownS,
  };
}

export function setQualityManual(scaler, preset) {
  scaler.preset = QUALITY_ORDER.includes(preset) ? preset : scaler.preset;
  scaler.cooldownS = QUALITY_SCALER.manualHoldS;
  scaler.holdS = 0;
  scaler.holdDir = 0;
  scaler.emaMs = 0;
}

/**
 * @param {ReturnType<typeof createQualityScaler>} scaler
 * @param {number} frameMs unclamped frame duration
 * @returns {{ preset: string, changed: boolean, reason: 'none' | 'down' | 'up' }}
 */
export function stepQualityScaler(scaler, frameMs) {
  const none = { preset: scaler.preset, changed: false, reason: 'none' };
  const stalled = !(frameMs > 0) || frameMs >= QUALITY_SCALER.stallMs;
  const dt = stalled ? 0 : frameMs / 1000;

  if (scaler.warmupS > 0) {
    // Warmup still counts wall time so shader-compile stalls expire it.
    scaler.warmupS = Math.max(0, scaler.warmupS - Math.max(0, frameMs) / 1000);
    return none;
  }
  if (!stalled && scaler.cooldownS > 0) {
    scaler.cooldownS = Math.max(0, scaler.cooldownS - dt);
  }

  if (!scaler.auto || stalled) return none;

  if (!(scaler.emaMs > 0)) scaler.emaMs = frameMs;
  else scaler.emaMs += QUALITY_SCALER.emaAlpha * (frameMs - scaler.emaMs);

  if (scaler.cooldownS > 0) return none;

  const i = Math.max(0, QUALITY_ORDER.indexOf(scaler.preset));
  let dir = 0;
  if (scaler.emaMs > QUALITY_SCALER.downMs && i < QUALITY_ORDER.length - 1) dir = 1;
  else if (scaler.emaMs < QUALITY_SCALER.upMs && i > 0) dir = -1;

  if (dir === 0) {
    scaler.holdS = 0;
    scaler.holdDir = 0;
    return none;
  }
  if (scaler.holdDir !== dir) {
    scaler.holdDir = dir;
    scaler.holdS = 0;
  }
  scaler.holdS += dt;
  const need = dir > 0 ? QUALITY_SCALER.downHoldS : QUALITY_SCALER.upHoldS;
  if (scaler.holdS < need) return none;

  scaler.preset = QUALITY_ORDER[i + dir];
  scaler.holdS = 0;
  scaler.holdDir = 0;
  scaler.cooldownS = scaler.cooldownDefaultS;
  return { preset: scaler.preset, changed: true, reason: dir > 0 ? 'down' : 'up' };
}

export function qualityCaption(scaler) {
  const label = qualityPreset(scaler.preset).label;
  if (!scaler.auto) return label;
  if (scaler.cooldownS > QUALITY_SCALER.cooldownS) return `${label} · hold`;
  return `${label} · auto`;
}
