/**
 * Cockpit camera motion from chassis dynamics.
 *
 * The plan puts most of the *perceived* speed and grip here rather than in the
 * image, and it is right in a way that is easy to underrate: a camera that leans
 * under braking, shakes over a kerb and settles as the car takes a set tells you
 * what the car is doing continuously and without a number. No amount of resolution
 * does that.
 *
 * Everything is driven from state the kernel already carries — body-frame
 * accelerations, the suspension's own heave/pitch/roll, and the surface roughness
 * under the wheels. Nothing here is keyed to an input, which is the point: a camera
 * that lurches when the brake key goes down rather than when the car decelerates
 * lies about a locked wheel and about a car already at the limit.
 *
 * Free of three.js, so the response can be argued with in a test. The caller adds
 * the offsets to whatever transform it was going to use.
 */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Head response. The driver's head is on a neck, not bolted to the chassis: it
 * lags the car, and that lag is most of what makes onboard footage readable.
 */
export const HEAD_STIFFNESS = 26;
export const HEAD_DAMPING = 9;

/** How far the head moves per g. Metres and radians. */
export const SURGE_PER_G = 0.022;
export const SWAY_PER_G = 0.028;
export const PITCH_PER_G = 0.010;
export const ROLL_PER_G = 0.014;
/** Chassis attitude is passed through nearly whole — the head goes with the car. */
export const CHASSIS_PITCH_GAIN = 0.85;
export const CHASSIS_ROLL_GAIN = 0.85;

/** Vertical shake from a rough surface. */
export const SHAKE_AMPLITUDE = 0.014;
export const SHAKE_HZ = 17;

export function createChassisCamera() {
  return {
    // Head offset in body axes: x forward, y up, z right.
    x: 0, y: 0, z: 0,
    /** The sprung part of the vertical offset, before the road shake is added. */
    heaveY: 0,
    vx: 0, vy: 0, vz: 0,
    pitch: 0, roll: 0,
    vPitch: 0, vRoll: 0,
    shakePhase: 0,
    shake: 0,
  };
}

export function resetChassisCamera(cam) {
  Object.assign(cam, createChassisCamera());
}

/**
 * Advance the head by `dt`.
 *
 * A damped spring toward a target set by acceleration, rather than the target
 * itself. Following the acceleration directly gives a camera that snaps — real
 * acceleration changes in milliseconds and a head cannot — and the snap reads as a
 * glitch rather than as force.
 *
 * Integrated semi-implicitly for the same reason the suspension is: the stiffness
 * is 26 and a frame can be 50 ms, and an explicit spring at that ratio rings.
 *
 * @param {object} cam from `createChassisCamera`
 * @param {object} s state: `aLong`, `aLat` in m/s² (body axes, +x forward,
 *   +y right); `pitch`, `roll` from the suspension; `roughness` 0..1; `speed` m/s.
 * @param {number} dt seconds
 * @param {number} g gravity
 */
export function updateChassisCamera(cam, s, dt, g = 9.81) {
  if (!(dt > 0)) return cam;

  // Braking throws the head forward, so the *camera* moves back relative to the
  // car; cornering right throws it left. Both are the reaction, not the force.
  const targetX = -clamp(s.aLong / g, -6, 6) * SURGE_PER_G;
  const targetZ = -clamp(s.aLat / g, -6, 6) * SWAY_PER_G;
  const targetPitch = clamp(s.aLong / g, -6, 6) * PITCH_PER_G
    + (s.pitch ?? 0) * CHASSIS_PITCH_GAIN;
  const targetRoll = -clamp(s.aLat / g, -6, 6) * ROLL_PER_G
    + (s.roll ?? 0) * CHASSIS_ROLL_GAIN;

  // Semi-implicit: solve the new velocity against the spring and damper together,
  // which is stable at any step where the explicit form would ring.
  const step = (pos, vel, target) => {
    const denom = 1 + HEAD_DAMPING * dt + HEAD_STIFFNESS * dt * dt;
    const v = (vel + HEAD_STIFFNESS * dt * (target - pos)) / denom;
    return [pos + v * dt, v];
  };

  [cam.x, cam.vx] = step(cam.x, cam.vx, targetX);
  [cam.z, cam.vz] = step(cam.z, cam.vz, targetZ);
  [cam.pitch, cam.vPitch] = step(cam.pitch, cam.vPitch, targetPitch);
  [cam.roll, cam.vRoll] = step(cam.roll, cam.vRoll, targetRoll);

  // Heave — the suspension's own vertical motion — goes through the spring,
  // because it is slow and the neck genuinely filters it.
  [cam.heaveY, cam.vy] = step(cam.heaveY, cam.vy, (s.heave ?? 0) * 0.6);

  // Road shake is added on top of the spring rather than fed through it.
  //
  // The head spring's natural frequency is sqrt(26)/2pi = 0.81 Hz, so a 17 Hz
  // road input arrives attenuated by (0.81/17)^2 — a factor of 440. Passed
  // through the spring the shake was 0.2 mm instead of 2 mm and simply did not
  // exist. Physically the seat transmits high-frequency road input to the whole
  // driver more or less whole; it is the slow leaning the neck smooths out.
  //
  // Sinusoidal rather than random: a random offset per frame is frame-rate-
  // dependent noise, where a phase advanced by dt is the same motion however
  // often it is sampled — the same reason the physics runs on a fixed step.
  const intensity = clamp(s.roughness ?? 0, 0, 1) * clamp((s.speed ?? 0) / 70, 0, 1);
  cam.shake = intensity;
  cam.shakePhase += dt * SHAKE_HZ * 2 * Math.PI;
  if (cam.shakePhase > 2 * Math.PI) cam.shakePhase -= 2 * Math.PI;
  cam.y = cam.heaveY + Math.sin(cam.shakePhase) * SHAKE_AMPLITUDE * intensity;

  return cam;
}

/**
 * Field of view from speed.
 *
 * Widening with speed is the oldest trick in the genre and it works, because
 * peripheral flow is what the eye reads speed from. Kept modest: past a few
 * degrees it stops reading as speed and starts reading as a fisheye lens.
 */
export function speedFov(baseFov, speed, reference = 90, widen = 8) {
  return baseFov + widen * clamp(speed / reference, 0, 1);
}
