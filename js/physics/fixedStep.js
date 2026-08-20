/**
 * The sim clock, separated from the frame clock.
 *
 * This is the single most consequential decision in the architecture, so it lives
 * in its own module rather than being tangled into the vehicle: a stiff tyre and
 * suspension model needs a short, *fixed* step, while `requestAnimationFrame`
 * delivers whatever the display and the scheduler feel like delivering.
 *
 * The old loop chose a *variable* number of substeps from the frame time, which
 * meant the car behaved differently on a 60 Hz laptop and a 165 Hz monitor, and
 * that a bug seen once could not be reproduced. An accumulator fixes all three
 * problems at once:
 *
 *   - determinism — the same inputs give the same trajectory on every machine,
 *   - replay — record inputs, replay bit-exact, and diff two physics versions,
 *   - smoothness — interpolating the two most recent states removes the stutter
 *     you get whenever frame rate and sim rate are not integer multiples.
 *
 * `MAX_CATCHUP` prevents the death spiral where a slow frame demands more
 * substeps, which makes the next frame slower still. Time past that ceiling is
 * dropped: the sim runs slow for a moment, which is survivable, where the spiral
 * is not.
 */

/** Sim rate. Stiff tyre + suspension models need this; see suspension.js. */
export const SIM_HZ = 600;
export const DT = 1 / SIM_HZ;
/** Never integrate more than this much wall time in one frame. */
export const MAX_CATCHUP = 0.1;
export const MAX_STEPS = Math.ceil(MAX_CATCHUP * SIM_HZ);

export function createClock() {
  return { accumulator: 0, alpha: 0, steps: 0, dropped: 0, simTime: 0 };
}

export function resetClock(clock) {
  clock.accumulator = 0;
  clock.alpha = 0;
  clock.steps = 0;
  clock.dropped = 0;
  clock.simTime = 0;
}

/**
 * Run `step` at a fixed `DT` for as much of `frameDt` as the accumulator holds.
 *
 * `step` is called with no arguments and must advance exactly `DT` of sim time.
 * `beforeStep`, if given, runs immediately before each step — that is where the
 * render interpolation snapshot is taken, so that after the loop the snapshot
 * holds the state one step *behind* the current one and `alpha` interpolates
 * between the two.
 *
 * @returns {number} number of steps taken this frame.
 */
export function pump(clock, frameDt, step, beforeStep) {
  if (!(frameDt > 0)) {
    clock.steps = 0;
    return 0;
  }
  const budget = Math.min(frameDt, MAX_CATCHUP);
  clock.dropped += frameDt - budget;
  clock.accumulator += budget;

  let steps = 0;
  while (clock.accumulator >= DT) {
    if (steps >= MAX_STEPS) {
      // Cannot happen while budget <= MAX_CATCHUP and the accumulator starts
      // below DT, but a NaN frameDt upstream would otherwise spin forever.
      clock.accumulator = 0;
      break;
    }
    if (beforeStep) beforeStep();
    step();
    clock.accumulator -= DT;
    clock.simTime += DT;
    steps++;
  }

  // A frame shorter than DT takes no step at all; alpha keeps climbing so the
  // render still moves, and the snapshot is left alone so it stays one step back.
  clock.alpha = clock.accumulator / DT;
  clock.steps = steps;
  return steps;
}

/** Linear blend for render interpolation. */
export const lerp = (a, b, t) => a + (b - a) * t;
