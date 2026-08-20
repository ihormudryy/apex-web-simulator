/**
 * How much of each physics-driven effect to emit, and when.
 *
 * Every function here is driven by a quantity the kernel already computes for its
 * own reasons — slip speed, tyre load, surface temperature, plank contact force.
 * That is the point: an effect keyed to what the car is doing cannot contradict
 * it, and an effect keyed to which key is held always eventually does.
 *
 * Free of three.js, so the thresholds can be argued with in a test rather than by
 * squinting at a frame.
 */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---------------------------------------------------------------------------
// Tyre smoke
// ---------------------------------------------------------------------------

/**
 * Smoke comes from slip *power*, not slip speed.
 *
 * A lightly loaded tyre spinning fast makes very little smoke; a heavily loaded
 * one sliding slowly makes a great deal. The product is what boils the rubber, and
 * it is already computed for the thermal model.
 */
export const SMOKE_POWER_THRESHOLD = 9000;
export const SMOKE_POWER_FULL = 90000;
/** An overheated tyre smokes for less slip, because the rubber is already soft. */
export const SMOKE_HEAT_GAIN = 0.5;

export function smokeRate(slipSpeed, load, surfaceT, optimumT = 100) {
  const power = Math.abs(slipSpeed) * Math.abs(load);
  const heat = clamp((surfaceT - optimumT) / 60, 0, 1);
  const threshold = SMOKE_POWER_THRESHOLD * (1 - SMOKE_HEAT_GAIN * heat);
  if (power <= threshold) return 0;
  return clamp((power - threshold) / (SMOKE_POWER_FULL - threshold), 0, 1);
}

// ---------------------------------------------------------------------------
// Plank sparks
// ---------------------------------------------------------------------------

/**
 * Sparks need contact *and* speed.
 *
 * A titanium plank resting on the ground in the pit lane does not spark; the
 * shower comes from grinding it along tarmac at 300 km/h. So the rate is the
 * product, and there is a speed below which no amount of contact does anything.
 */
export const SPARK_MIN_SPEED = 25;
export const SPARK_FORCE_FULL = 6000;

export function sparkRate(plankForce, speed) {
  if (speed <= SPARK_MIN_SPEED || plankForce <= 0) return 0;
  const byForce = clamp(plankForce / SPARK_FORCE_FULL, 0, 1);
  const bySpeed = clamp((speed - SPARK_MIN_SPEED) / 55, 0, 1);
  return byForce * bySpeed;
}

// ---------------------------------------------------------------------------
// Tyre marks
// ---------------------------------------------------------------------------

/**
 * Rubber laid down on the road.
 *
 * Deliberately a much lower threshold than smoke: a tyre marks the road long
 * before it smokes, which is why a racing line builds up over a session from
 * cars that are not sliding at all. The plan's note is that this makes the
 * racing-line rubber dynamic rather than baked, and a threshold set at the
 * smoking point would never accumulate a line at all.
 */
export const MARK_SLIP_THRESHOLD = 0.35;
export const MARK_SLIP_FULL = 6;

export function markIntensity(slipSpeed, load, staticLoad = 2000) {
  const slip = Math.abs(slipSpeed);
  if (slip <= MARK_SLIP_THRESHOLD) return 0;
  const bySlip = clamp((slip - MARK_SLIP_THRESHOLD) / (MARK_SLIP_FULL - MARK_SLIP_THRESHOLD), 0, 1);
  const byLoad = clamp(load / (staticLoad * 2), 0, 1.5);
  return clamp(bySlip * byLoad, 0, 1);
}

// ---------------------------------------------------------------------------
// Heat haze
// ---------------------------------------------------------------------------

/**
 * Haze from the brake ducts and the exhaust.
 *
 * Brake haze follows disc temperature and dies with airflow — it is most visible
 * as the car slows into a corner, not on the straight where the air is moving fast
 * enough to carry it away. Exhaust haze follows engine load.
 */
export const HAZE_BRAKE_THRESHOLD_C = 350;
export const HAZE_SPEED_SCATTER = 45;

export function brakeHaze(discT, speed) {
  const heat = clamp((discT - HAZE_BRAKE_THRESHOLD_C) / 450, 0, 1);
  const still = 1 / (1 + Math.abs(speed) / HAZE_SPEED_SCATTER);
  return heat * still;
}

export function exhaustHaze(throttle, rpm, limiterRpm = 15000) {
  return clamp(throttle, 0, 1) * clamp(rpm / limiterRpm, 0, 1);
}

// ---------------------------------------------------------------------------
// Camera shake
// ---------------------------------------------------------------------------

/**
 * How hard to shake the cockpit camera.
 *
 * The plan puts most of the *perceived* speed and grip in this rather than in the
 * image: a camera driven by chassis acceleration tells you what the car is doing
 * in a way no amount of resolution does. Surface roughness is in it because a
 * bumpy circuit at 300 km/h is a physical experience, and the suspension already
 * knows it is bumpy.
 */
export function cameraShake(aLong, aLat, roughness, speed, g = 9.81) {
  const accel = Math.hypot(aLong, aLat) / (5 * g);
  const surface = clamp(roughness, 0, 1) * clamp(speed / 80, 0, 1);
  return clamp(accel * 0.7 + surface * 0.5, 0, 1.5);
}
