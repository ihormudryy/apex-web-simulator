/**
 * F1 start-light sequence: five red lights come on one per second, hold for a
 * random beat, then go out together — lights out and away we go. The car's
 * pedals are locked until they do; touching the throttle early is a jump
 * start, which aborts the start and sends the car back to the grid.
 *
 * Free of three.js and the DOM, so the sequencing, the randomness bounds and
 * the jump-start rule can all be argued with in a test. The caller owns the
 * clock (dt), the input lock and the gantry drawing.
 */

/** Beat between the grid reset and the first red light, s. */
export const FIRST_LIGHT_DELAY = 0.8;
/** One light per second, as the real gantry does. */
export const LIGHT_INTERVAL = 1.0;
/** Lights-out hold: FIRST + rng() * RANGE seconds after the fifth light. */
export const HOLD_MIN = 0.8;
export const HOLD_RANGE = 2.2;
/** How long the dark gantry lingers after lights out before it hides, s. */
export const GREEN_SHOWN = 2.0;
/** How long the JUMP START verdict stays up before the grid reset, s. */
export const JUMP_SHOWN = 1.6;

/** @param {() => number} [rng] injected for tests; the hold must not be learnable */
export function createStartLights(rng = Math.random) {
  return {
    /** 'sequence' → 'green' → 'done', or 'sequence' → 'jump'. */
    phase: 'sequence',
    /** Seconds inside the current phase. */
    t: 0,
    /** Red lights currently lit, 0..5. */
    lit: 0,
    hold: HOLD_MIN + rng() * HOLD_RANGE,
  };
}

/**
 * @param {ReturnType<typeof createStartLights>} s mutated in place
 * @param {number} dt seconds
 * @param {boolean} throttlePressed forward or reverse held this frame
 */
export function advanceStartLights(s, dt, throttlePressed) {
  s.t += dt;
  if (s.phase === 'sequence') {
    if (throttlePressed) {
      s.phase = 'jump';
      s.t = 0;
      return s;
    }
    const sinceFirst = s.t - FIRST_LIGHT_DELAY;
    s.lit = sinceFirst < 0 ? 0 : Math.min(5, 1 + Math.floor(sinceFirst / LIGHT_INTERVAL));
    const lightsOutAt = FIRST_LIGHT_DELAY + 4 * LIGHT_INTERVAL + s.hold;
    if (s.t >= lightsOutAt) {
      s.phase = 'green';
      s.t = 0;
      s.lit = 0;
    }
    return s;
  }
  if (s.phase === 'green' && s.t >= GREEN_SHOWN) s.phase = 'done';
  return s;
}

/** Pedals stay dead until the lights go out — and after a jump start. */
export function startInputLocked(s) {
  return s.phase === 'sequence' || s.phase === 'jump';
}

/** A jump start has been shown long enough; send the car back to the grid. */
export function jumpStartExpired(s) {
  return s.phase === 'jump' && s.t >= JUMP_SHOWN;
}
