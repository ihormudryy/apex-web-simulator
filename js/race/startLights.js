/**
 * F1 start-light sequence: five red lights come on one per second, hold for a
 * random beat, then go out together — lights out and away we go. The car's
 * pedals are locked until they do; touching the throttle early is a jump
 * start, which aborts the start and sends the car back to the grid.
 *
 * The grid sits in `idle` doing nothing until the player arms it — a grid
 * reset alone must not start the countdown, or the player is racing a clock
 * they didn't choose to start. `armStartLights` is that one deliberate act;
 * a jump start (or any other reset) drops the state back to `idle` so it
 * takes another press to go again.
 *
 * The hold has to stay unlearnable, which means real randomness — the RNG is
 * a caller-supplied function rather than a hardcoded `Math.random` purely so
 * a test can pin it down and assert on an exact value. That is the whole
 * reason for the injection: it is not what keeps a replay or a ghost lap
 * correct. Those (physics/ghost.js, physics/replay.js) record concrete input
 * frames and reconstruct nothing from the hold or its RNG, so they are just
 * as bit-exact with the default `Math.random` as with any seed. The state
 * keeps the `rng` it was built with so re-arming (or a reset) re-rolls from
 * the same stream rather than needing it threaded back in every time.
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
    /** 'idle' → 'sequence' → 'green' → 'done', or 'sequence' → 'jump'. */
    phase: 'idle',
    /** Seconds inside the current phase. */
    t: 0,
    /** Red lights currently lit, 0..5. */
    lit: 0,
    hold: HOLD_MIN + rng() * HOLD_RANGE,
    /** Kept so each arming (and each reset) re-rolls; seeded per race for replay. */
    rng,
  };
}

/** The player is ready. Nothing happens on the grid until this is called. */
export function armStartLights(s) {
  s.phase = 'sequence';
  s.t = 0;
  s.lit = 0;
  s.hold = HOLD_MIN + s.rng() * HOLD_RANGE;
  return s;
}

/** Back to the grid, waiting to be armed again — after a jump start or a reset. */
export function resetStartLights(s) {
  s.phase = 'idle';
  s.t = 0;
  s.lit = 0;
  s.hold = HOLD_MIN + s.rng() * HOLD_RANGE;
  return s;
}

/**
 * @param {ReturnType<typeof createStartLights>} s mutated in place
 * @param {number} dt seconds
 * @param {boolean} throttlePressed forward or reverse held this frame
 */
export function advanceStartLights(s, dt, throttlePressed) {
  // An un-armed grid does not accumulate time — nothing to advance towards.
  if (s.phase === 'idle') return s;
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

/** Pedals stay dead on an un-armed grid, through the sequence, and after a jump start. */
export function startInputLocked(s) {
  return s.phase === 'idle' || s.phase === 'sequence' || s.phase === 'jump';
}

/** A jump start has been shown long enough; send the car back to the grid. */
export function jumpStartExpired(s) {
  return s.phase === 'jump' && s.t >= JUMP_SHOWN;
}
