// The engine's voice as pure numbers: an order spectrum and a per-frame mix.
// The Web Audio graph lives in EngineAudio.js; this module is the part tests pin.
//
// An engine note is not a chord of a few pure tones — it is a dense stack of
// *engine orders*: components at multiples of half the rotation frequency, with
// the firing order (cylinders/2 for a four-stroke) dominant. The previous voice
// was a triangle plus two sines, which is an organ. This one hands the wrapper a
// full order spectrum to bake into a PeriodicWave.

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * A 1.6 L V6 turbo hybrid — six cylinders, firing order 3.
 *
 * This was 8, matching the 2010 mesh, and the plan's recommendation is explicit:
 * keep the mesh, adopt modern physics wholesale, and switch the engine voice. The
 * change is not cosmetic. Firing order is `cylinders / 2`, so it moves the
 * dominant component of the spectrum from 4th order to 3rd — at 12 000 rpm that is
 * 600 Hz rather than 800, and every harmonic of the exhaust series moves with it.
 * It is most of why the V6 era sounds flat next to the V8 era, and the turbo is
 * the rest: a single turbine on the exhaust smooths the pulses the V8 fired
 * straight out of the pipe.
 */
export const CYLINDERS = 6;

/** Highest engine order carried by the wave. 28th order at 15 000 rpm is 7 kHz. */
export const MAX_ORDER = 28;

// How fast the audible rpm may move, in rpm per second. Pulls are engine-limited;
// coasting decays slowly; a gear shift is a mechanical event and must be near
// instantaneous — the old symmetric 7 000 rpm/s turned every upshift into a
// 460 ms siren glide.
export const SLEW_UP_RPM_S = 16000;
export const SLEW_DOWN_RPM_S = 9000;
export const SLEW_SHIFT_RPM_S = 60000;
/** Seconds after a gear change during which the shift slew applies. */
export const SHIFT_WINDOW_S = 0.12;
/** Master dips to this fraction for the torque cut, then recovers. */
export const SHIFT_DIP_GAIN = 0.45;
export const SHIFT_DIP_S = 0.07;

export function firingHz(rpm, cylinders = CYLINDERS) {
  return (Math.max(0, rpm) / 60) * (cylinders / 2);
}

/**
 * The PeriodicWave oscillator runs at half the rotation frequency, so that
 * harmonic k of the wave is engine order k/2 — half-order resolution from a
 * single oscillator.
 */
export function waveFundamentalHz(rpm) {
  return Math.max(0, rpm) / 120;
}

/** Harmonic index in the wave for a given engine order. */
export function orderIndex(order) {
  return Math.round(order * 2);
}

export function rpmNorm(rpm, idleRpm, redlineRpm) {
  const span = redlineRpm - idleRpm;
  if (!(span > 0)) return 0;
  return clamp((rpm - idleRpm) / span, 0, 1);
}

/**
 * Magnitude per half-order, normalised so the firing order is 1. Index k is
 * engine order k/2; index 0 (DC) stays 0.
 */
export function engineOrderSpectrum(cylinders = CYLINDERS) {
  const firing = cylinders / 2;
  const bins = 2 * MAX_ORDER + 1;
  const mags = new Float64Array(bins);

  for (let k = 1; k < bins; k++) {
    const order = k / 2;
    // Broadband floor: mechanical hash between the orders. Without it the note
    // is a clean organ chord; with it, an engine.
    let a = 0.012;
    // Integer orders: the rotation family (imbalance, accessories).
    if (k % 2 === 0) a += 0.05 / order;
    // The firing order and its harmonics, rolling off like a real exhaust.
    for (let h = 1; h * firing <= MAX_ORDER; h++) {
      if (order === firing * h) a += 1 / h ** 1.35;
    }
    // Growl content beside the firing series.
    if (order === firing / 2) a += 0.22;
    if (order === firing * 1.5) a += 0.28;
    if (order === firing * 2.5) a += 0.12;
    mags[k] = a;
  }

  let peak = 0;
  for (const v of mags) peak = Math.max(peak, v);
  for (let k = 0; k < bins; k++) mags[k] /= peak;
  return mags;
}

/**
 * Mix for one frame. Frequencies in Hz, gains 0–1 before the master fader.
 */
/**
 * Turbo and MGU-K.
 *
 * The compressor runs at 100 000+ rpm, geared to nothing — its speed follows the
 * mass flow, which is roughly boost times engine speed. That whine sitting on top
 * of a comparatively muted exhaust is the signature of the era. `TURBO_HZ_SCALE`
 * puts it at about 5 kHz at full boost and full revs, which is where it sits.
 *
 * The MGU-K whine is an inverter artefact at a fixed multiple of shaft speed, so
 * it tracks rpm rather than boost, and it is only there when the thing is doing
 * something — deploying or harvesting, not idling.
 */
export const TURBO_HZ_SCALE = 0.36;
export const TURBO_GAIN = 0.055;
export const MGUK_HZ_SCALE = 0.62;
export const MGUK_GAIN = 0.030;
/** Wastegate flutter on a sharp lift, and how long it lasts. */
export const WASTEGATE_GAIN = 0.10;
export const WASTEGATE_S = 0.22;

export function engineVoice({
  rpm = 4000,
  throttle = 0,
  brake = 0,
  idleRpm = 4000,
  redlineRpm = 15000,
  boost = 0,
  ers = 0,
  liftOff = 0,
} = {}) {
  void brake;   // crackle deliberately ignores the brakes: lift-off pops happen while braking
  const n = rpmNorm(rpm, idleRpm, redlineRpm);
  const load = clamp(throttle, 0, 1);
  const fire = firingHz(rpm);
  const overrun = load < 0.08 && n > 0.25;
  const spool = clamp(boost, 0, 1);

  return {
    waveHz: clamp(waveFundamentalHz(rpm), 0, 300),
    voiceGain: 0.30 + 0.20 * load + 0.10 * n,
    detuneCents: 5,

    // Brightness follows revs and load: an engine at full noise is all edge.
    lowpassHz: 2600 + 5200 * n + 2600 * load,

    // Exhaust roar sits just above the firing series; intake hiss is load noise.
    bandHz: clamp(fire * 1.25, 600, 4000),
    noiseExhaust: 0.030 + 0.075 * load + 0.020 * n,
    noiseIntake: 0.012 + 0.050 * load * (0.3 + 0.7 * n),

    master: 0.055 + 0.050 * n + 0.060 * load,

    // Race idle is lumpy; the lumps disappear as the revs come up.
    wobbleRpm: 90 * (1 - n) ** 3,
    wobbleHz: 9,

    overrun,
    /** Impulsive pops per second — the wrapper schedules each one. */
    crackleRate: overrun ? 14 + 26 * n : 0,
    cracklePop: 0.10 + 0.10 * n,

    // Compressor whine. Follows mass flow, so boost times revs — a spooled turbo
    // at low revs is quiet, and so is a high-revving engine off boost.
    turboHz: clamp(rpm * spool * TURBO_HZ_SCALE, 200, 8000),
    turboGain: TURBO_GAIN * spool * (0.25 + 0.75 * n),

    // MGU-K inverter whine, present only while it is deploying or harvesting.
    mgukHz: clamp(rpm * MGUK_HZ_SCALE, 200, 9000),
    mgukGain: MGUK_GAIN * clamp(Math.abs(ers), 0, 1),

    // Wastegate flutter, on the sharp lift rather than on the throttle position:
    // a slow roll-off does not dump the boost.
    wastegateGain: WASTEGATE_GAIN * clamp(liftOff, 0, 1) * spool,
  };
}
