/**
 * Tyre, kerb and plank audio, from the physics.
 *
 * The plan's honest limitation is that **real force feedback is not available in
 * the browser**: the Gamepad API has no force-feedback axis, `vibrationActuator`
 * is the ceiling, and WebHID wheel drivers are device-specific. So grip
 * communication has to move into the channels that do work, and the loudest of
 * those is sound.
 *
 * This is not decoration then — it is the primary channel by which the car tells
 * the driver what the tyres are doing. Every input is a quantity the kernel
 * already computes for the tyre model, which is what makes it trustworthy: the
 * scrub rises because the tyre is actually sliding, not because a threshold on a
 * key was crossed.
 *
 * Free of the Web Audio API, so the mapping can be tested. `EngineAudio` owns the
 * graph.
 */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---------------------------------------------------------------------------
// Tyre scrub
// ---------------------------------------------------------------------------

/**
 * Scrub is the sound of rubber being dragged sideways, and its *pitch* is what
 * carries the information.
 *
 * Volume alone tells you there is slip. Pitch tells you how much, and it is the
 * difference between "the tyre is working" and "the tyre has gone". A real slick
 * squeals rising as it approaches the limit and drops to a lower, rougher roar
 * once it is past it — the squeal is stick-slip at the trailing edge of the
 * contact patch, and once the whole patch is sliding there is nothing left to
 * stick.
 */
export const SCRUB_ONSET = 0.6;
export const SCRUB_SQUEAL_PEAK = 3.5;
export const SCRUB_FULL_SLIDE = 12;
export const SCRUB_HZ_LOW = 420;
export const SCRUB_HZ_PEAK = 1150;
export const SCRUB_HZ_SLIDE = 560;

/**
 * @param {number} slipSpeed contact-patch sliding speed, m/s
 * @param {number} load vertical load, N
 * @param {number} mu surface friction, so grass sounds like grass
 * @param {number} staticLoad reference corner load, N
 */
export function scrubVoice(slipSpeed, load, mu = 1.85, staticLoad = 2000) {
  const slip = Math.abs(slipSpeed);
  if (slip <= SCRUB_ONSET) {
    return { gain: 0, hz: SCRUB_HZ_LOW, noise: 0, squeal: 0 };
  }

  // Loudness follows slip power, the same quantity that heats the tyre. A lightly
  // loaded tyre spinning fast is quiet; a loaded one scrubbing slowly is not.
  const power = slip * Math.max(load, 0);
  const gain = clamp(power / 60000, 0, 1);

  // Pitch: up to the squeal peak, then back down as the patch gives up entirely.
  let hz;
  let squeal;
  if (slip <= SCRUB_SQUEAL_PEAK) {
    const t = (slip - SCRUB_ONSET) / (SCRUB_SQUEAL_PEAK - SCRUB_ONSET);
    hz = SCRUB_HZ_LOW + (SCRUB_HZ_PEAK - SCRUB_HZ_LOW) * t;
    squeal = t;
  } else {
    const t = clamp((slip - SCRUB_SQUEAL_PEAK) / (SCRUB_FULL_SLIDE - SCRUB_SQUEAL_PEAK), 0, 1);
    hz = SCRUB_HZ_PEAK + (SCRUB_HZ_SLIDE - SCRUB_HZ_PEAK) * t;
    squeal = 1 - t;
  }

  // A low-grip surface does not squeal — it roars. Gravel and grass have no
  // stick-slip to speak of, so the tonal part goes and the noise stays.
  const grip = clamp(mu / 1.85, 0, 1);
  void staticLoad;

  return {
    gain,
    hz,
    /** Broadband share: all of it on a loose surface, some of it on a slide. */
    noise: gain * (1 - 0.55 * grip * squeal),
    /** Tonal share — the squeal proper. */
    squeal: gain * grip * squeal,
  };
}

/** The loudest corner decides the scrub, because that is what a driver hears. */
export function loudestScrub(slipSpeeds, loads, mus, out = {}) {
  let best = null;
  for (let i = 0; i < slipSpeeds.length; i++) {
    const v = scrubVoice(slipSpeeds[i], loads[i], mus[i]);
    if (!best || v.gain > best.gain) best = v;
  }
  Object.assign(out, best ?? { gain: 0, hz: SCRUB_HZ_LOW, noise: 0, squeal: 0 });
  return out;
}

// ---------------------------------------------------------------------------
// Kerbs and the plank
// ---------------------------------------------------------------------------

/**
 * Kerb rattle. The serrations pass under the wheel at `speed / pitch` Hz, which is
 * a real frequency and audibly rises with speed — riding a kerb slowly is a series
 * of thuds and riding it fast is a buzz.
 */
export const KERB_RIB_PITCH = 0.5;

export function kerbVoice(onKerb, speed, load, staticLoad = 2000) {
  if (!onKerb || speed < 2) return { gain: 0, hz: 0, rate: 0 };
  const rate = Math.abs(speed) / KERB_RIB_PITCH;
  return {
    gain: clamp((load / (staticLoad * 2)) * clamp(speed / 30, 0, 1), 0, 1),
    hz: clamp(rate, 4, 400),
    rate,
  };
}

/**
 * Plank scrape. Titanium on tarmac at 300 km/h — a bright, harsh grind whose
 * loudness follows contact force and speed together, exactly as the sparks do.
 * Same model, two outputs, again.
 */
export function plankVoice(plankForce, speed) {
  if (plankForce <= 0 || speed < 5) return { gain: 0, hz: 2600 };
  return {
    gain: clamp((plankForce / 8000) * clamp(speed / 60, 0, 1), 0, 1),
    hz: clamp(1800 + speed * 22, 1800, 5200),
  };
}

// ---------------------------------------------------------------------------
// Rumble, which is the closest thing to force feedback available
// ---------------------------------------------------------------------------

/**
 * Gamepad rumble from the steering torque the tyre model computes.
 *
 * `vibrationActuator`'s dual-rumble is the ceiling the browser offers, and it is a
 * poor substitute for a wheel. But the information is real: `Mz` collapses as the
 * front axle approaches its limit, so rumble that follows it goes *light* exactly
 * when the front is about to let go, which is the thing a driver most needs to
 * know and cannot otherwise be told.
 *
 * Two channels, because dual-rumble has two: the strong motor carries surface and
 * impact, the weak one carries the steering load.
 */
export const MZ_REFERENCE = 260;

export function rumble(steerTorque, roughness, speed, kerb = 0) {
  const load = clamp(Math.abs(steerTorque) / MZ_REFERENCE, 0, 1);
  const surface = clamp(roughness, 0, 1) * clamp(speed / 70, 0, 1);
  return {
    strong: clamp(surface * 0.7 + kerb, 0, 1),
    weak: clamp(load, 0, 1),
  };
}
