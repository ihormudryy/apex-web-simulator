/**
 * Ghost laps.
 *
 * The delta readout already tells a driver they are three tenths down. It does not
 * tell them *where*, and "where" is the whole question. A ghost does: a second car
 * driving the best lap alongside, which turns an abstract number into a car pulling
 * away from you at the exit of Becketts.
 *
 * This is what the input recording was built for. The plan's argument for it was
 * testing a physics change by replaying a lap, and that is the more important use
 * — but a ghost is the same machinery pointed at the driver instead of at the
 * model, and it costs one extra vehicle and one extra sim step per frame.
 *
 * Free of three.js. The renderer draws whatever pose this reports.
 */

import {
  createRecording, resetRecording, recordStep, recordingLength, recordingAt,
  serializeRecording, deserializeRecording, packInput,
} from './replay.js';
import { DT } from './fixedStep.js';

/** Two minutes of lap at 600 Hz. A Silverstone lap is about 87 seconds. */
export const GHOST_CAPACITY = 72000;

export function createGhostState() {
  return {
    /** Inputs for the lap in progress. */
    current: createRecording(GHOST_CAPACITY),
    /** Inputs for the best lap so far, or null. */
    best: null,
    bestLapTime: null,
    /** How far through the best lap the ghost has been replayed. */
    cursor: 0,
    /** Sim time since the player crossed the line, so the ghost stays in step. */
    elapsed: 0,
    active: false,
    /** True when the recording overflowed, which invalidates it as a lap. */
    overflowed: false,
  };
}

export function resetGhost(g) {
  resetRecording(g.current);
  g.best = null;
  g.bestLapTime = null;
  g.cursor = 0;
  g.elapsed = 0;
  g.active = false;
  g.overflowed = false;
}

/**
 * Record one sim step of the lap in progress.
 *
 * Called from inside the sim loop, so it takes the packed flags and the steer
 * angle rather than an input object — the same reason `replay.recordStep` does.
 */
export function recordGhostStep(g, input, steerAngle) {
  if (g.current.written >= g.current.capacity) {
    // A lap longer than the buffer is not a lap worth chasing, and letting the
    // ring wrap would silently splice its end onto its beginning.
    g.overflowed = true;
    return;
  }
  recordStep(g.current, packInput(input), steerAngle);
}

/**
 * A lap has been completed. Keep it if it is the best, and start recording again.
 *
 * @returns {boolean} whether this lap became the new best.
 */
export function completeLap(g, lapTime, { minLapTime = 20 } = {}) {
  const valid = Number.isFinite(lapTime)
    && lapTime > minLapTime
    && !g.overflowed
    && recordingLength(g.current) > 0;

  let improved = false;
  if (valid && (g.bestLapTime === null || lapTime < g.bestLapTime)) {
    // A copy, not a reference: the live recording is about to be reset under it.
    g.best = deserializeRecording(serializeRecording(g.current));
    g.bestLapTime = lapTime;
    improved = true;
  }

  resetRecording(g.current);
  g.overflowed = false;
  g.cursor = 0;
  g.elapsed = 0;
  g.active = g.best !== null;
  return improved;
}

/**
 * Advance the ghost by one frame, in lockstep with the player's own sim clock.
 *
 * The ghost is stepped by *elapsed sim time since the line*, not by frames. That
 * is what keeps it honest: if the player's frame rate drops, the ghost slows with
 * them rather than running away, and the gap on screen stays the gap on the clock.
 *
 * @param {object} g ghost state
 * @param {number} dt frame time
 * @param {function} stepFn `(input) => void`, advancing the ghost vehicle one `DT`
 * @returns {number} sim steps taken
 */
export function advanceGhost(g, dt, stepFn) {
  if (!g.active || !g.best) return 0;
  g.elapsed += dt;
  const wanted = Math.floor(g.elapsed / DT);
  const total = recordingLength(g.best);
  let steps = 0;
  const input = {};
  while (g.cursor < wanted && g.cursor < total) {
    recordingAt(g.best, g.cursor, input);
    stepFn(input);
    g.cursor++;
    steps++;
    // A frame long enough to want hundreds of steps is a stall, not a lap; the
    // ghost catching up over the next few frames is better than a hitch.
    if (steps >= 240) break;
  }
  if (g.cursor >= total) {
    // The ghost finished its lap. It waits at the line for the player.
    g.active = false;
  }
  return steps;
}

/** Fraction of the best lap the ghost has replayed, 0..1. */
export function ghostProgress(g) {
  if (!g.best) return 0;
  const total = recordingLength(g.best);
  return total ? Math.min(1, g.cursor / total) : 0;
}

/** Ghost lap time so far, in seconds. */
export const ghostTime = g => g.cursor * DT;

/** Serialise a best lap, so it survives a reload or can be shared. */
export function saveGhost(g) {
  if (!g.best) return null;
  return { lapTime: g.bestLapTime, recording: serializeRecording(g.best) };
}

export function loadGhost(g, blob) {
  if (!blob?.recording) return false;
  g.best = deserializeRecording(blob.recording);
  g.bestLapTime = blob.lapTime ?? null;
  g.cursor = 0;
  g.elapsed = 0;
  g.active = true;
  return true;
}
