/**
 * The field: every car on track, stepped together, contacting each other.
 *
 * The player is an entry like any other. The only difference between the player
 * and a rival is where the input comes from — the keyboard or `driveAi` — which
 * is what keeps the AI honest: it drives the same car through the same code.
 *
 * Ships with one rival. `rivals` is a count rather than a boolean because the
 * only thing standing between this and a full grid is the number of slots, and
 * the cost was measured before the seam was drawn: ~0.12 ms per vehicle per
 * frame at 600 Hz, linear to 20 cars.
 *
 * Free of three.js. The renderer draws whatever pose each entry reports.
 */

import {
  createVehicle, setPose, advance, updateSteering, resetVehicle, forwardSpeed,
} from '../physics/vehicle.js';
import { createAiState, driveAi } from './aiDriver.js';
import { buildRacingLine } from './racingLine.js';
import { resolveCarContact, createCarContact } from '../physics/carContact.js';

/** Three laps: long enough that a mistake costs the race, short enough to re-run. */
export const RACE_LAPS = 3;
/** Grid slots either side of the centreline, and the stagger between them, m. */
export const GRID_LATERAL = 1.9;
export const GRID_STAGGER = 5.0;
/** A "lap" quicker than this is the start-line seam, not a lap. See telemetry.js. */
const MIN_LAP_TIME = 20;

/**
 * A per-entry view of the track.
 *
 * `Track` carries one hint cursor. With several cars spread round the lap they
 * drag that cursor back and forth across the ring between them, which measured
 * ~15% slower per car — and, worse, is the aliasing failure `centerline.query`
 * warns about in its own comments. Each car gets its own cursor over the same
 * geometry.
 */
function trackView(track) {
  let hint = 0;
  let wheelHint = 0;
  return {
    centerline: track.centerline,
    spawn: () => track.spawn(),
    query(x, z) {
      const r = track.centerline.query(x, z, hint);
      hint = r.index;
      return r;
    },
    queryWheel(x, z, out) {
      // `queryWheel` writes the station it settled on onto `out.index`, so the
      // cursor advances without a second query. Re-querying here to find the
      // index would cost one extra ring search per wheel per step — double the
      // work the per-car cursor exists to avoid.
      const r = track.queryWheel(x, z, out, wheelHint);
      wheelHint = out.index ?? wheelHint;
      return r;
    },
    heightAt: (x, z) => track.heightAt(x, z),
  };
}

/**
 * Grid slot `n`, staggered as a real grid is.
 *
 * There is no multi-slot grid in the circuit geometry — `Track.spawn()` is one
 * station — so the slots are derived from it: alternating sides of the
 * centreline, each row a stagger further back.
 */
export function gridPose(track, slot) {
  const s = track.spawn();
  // buildCenterline's convention: normal is (-tz, tx).
  const nx = -s.tz;
  const nz = s.tx;
  const side = slot % 2 === 0 ? -1 : 1;
  const back = Math.floor(slot / 2) * GRID_STAGGER + (slot % 2) * GRID_STAGGER * 0.5;
  return {
    // Forward is (tx, tz); "back" is against it.
    x: s.x + nx * GRID_LATERAL * side - s.tx * back,
    z: s.z + nz * GRID_LATERAL * side - s.tz * back,
    yaw: Math.atan2(-s.tx, -s.tz),
  };
}

export function createRaceField(track, {
  rivals = 1, level = 'pro', physicsMode = 'arcade',
  // Overridable so a test can count resolutions per step without reaching
  // into the module's imports — see raceField.test.js's contact-count test.
  resolveContact = resolveCarContact,
} = {}) {
  const line = buildRacingLine(track.centerline.samples);
  const entries = [];
  for (let slot = 0; slot < rivals + 1; slot++) {
    const isPlayer = slot === 0;
    const view = trackView(track);
    const vehicle = createVehicle({ physicsMode });
    const pose = gridPose(track, slot);
    setPose(vehicle, pose.x, pose.z, pose.yaw, view);
    entries.push({
      slot,
      isPlayer,
      vehicle,
      view,
      ai: isPlayer ? null : createAiState(level),
      input: { forward: false, reverse: false, left: false, right: false, brake: false },
      laps: 0,
      t: 0,
      prevT: 0,
      lapStart: 0,
      elapsed: 0,
      finished: false,
      finishTime: 0,
    });
  }
  return {
    entries, line, laps: RACE_LAPS, contact: createCarContact(), locked: false,
    resolveContact,
  };
}

export function resetField(field, track) {
  for (const e of field.entries) {
    const pose = gridPose(track, e.slot);
    resetVehicle(e.vehicle);
    setPose(e.vehicle, pose.x, pose.z, pose.yaw, e.view);
    e.laps = 0;
    e.t = 0;
    e.prevT = 0;
    e.lapStart = 0;
    e.elapsed = 0;
    e.finished = false;
    e.finishTime = 0;
  }
  return field;
}

/**
 * Reused across every call: `stepField` runs every physics step and must not
 * allocate, and `driveAi` only ever reads `rival`'s fields synchronously
 * within the one call it is passed to, so one shared scratch object is safe —
 * the same reasoning `carContact.js`'s `pa`/`pb` scratch points rely on.
 */
const REL_SCRATCH = { x: 0, z: 0, lateralGap: 0, aheadGap: 0 };

/** Relative position of `other` as `driveAi` wants it. */
function relativeTo(entry, other, lapLength) {
  const a = entry.view.query(entry.vehicle.x, entry.vehicle.z);
  const b = other.view.query(other.vehicle.x, other.vehicle.z);
  let along = (b.t - a.t) * lapLength;
  // Shortest way round the ring: a car 5 m behind is -5, not a lap minus 5.
  if (along > lapLength / 2) along -= lapLength;
  if (along < -lapLength / 2) along += lapLength;
  REL_SCRATCH.x = other.vehicle.x;
  REL_SCRATCH.z = other.vehicle.z;
  REL_SCRATCH.lateralGap = b.lateral - a.lateral;
  REL_SCRATCH.aheadGap = along;
  return REL_SCRATCH;
}

/** First other car still racing, without a per-call closure allocation. */
function firstRival(entries, self) {
  for (let i = 0; i < entries.length; i++) {
    const o = entries[i];
    if (o !== self && !o.finished) return o;
  }
  return null;
}

/**
 * @param {object} field from `createRaceField`
 * @param {object} playerInput the keyboard's input object
 * @param {object} track
 * @param {number} dt seconds
 */
export function stepField(field, playerInput, track, dt) {
  const lapLength = track.centerline.length;
  const n = field.entries.length;

  for (const e of field.entries) {
    if (e.finished) continue;
    if (e.isPlayer) {
      e.input.forward = Boolean(playerInput.forward);
      e.input.reverse = Boolean(playerInput.reverse);
      e.input.left = Boolean(playerInput.left);
      e.input.right = Boolean(playerInput.right);
      e.input.brake = Boolean(playerInput.brake);
    } else {
      const other = firstRival(field.entries, e);
      driveAi(e.ai, e.vehicle, field.line, e.input,
        other ? relativeTo(e, other, lapLength) : null);
    }
    // The lights hold everyone on the grid; the AI must not creep either.
    if (field.locked) {
      e.input.forward = false;
      e.input.reverse = false;
      e.input.brake = true;
    }
    updateSteering(e.vehicle, e.input, dt);
    advance(e.vehicle, e.input, e.view, dt);
  }

  // Contact: every unordered pair exactly once.
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      field.resolveContact(field.entries[i].vehicle.S, field.entries[j].vehicle.S, field.contact);
    }
  }

  // Lap accounting. `t` is a ring coordinate, so a car sitting on the start line
  // reads 0.9999 one step and 0.0001 the next; without the minimum-lap guard
  // that seam counts as a completed lap. Same rule the dashboard uses.
  for (const e of field.entries) {
    if (e.finished) continue;
    e.elapsed += dt;
    const q = e.view.query(e.vehicle.x, e.vehicle.z);
    e.t = q.t;
    if (e.t < e.prevT - 0.5 && e.elapsed - e.lapStart > MIN_LAP_TIME) {
      e.laps++;
      e.lapStart = e.elapsed;
    }
    e.prevT = e.t;
    if (e.laps >= field.laps) {
      e.finished = true;
      e.finishTime = e.elapsed;
    }
  }
  return field;
}

/** Leader first: more laps wins, then further round the current lap. */
export function standings(field) {
  return field.entries.slice().sort((a, b) => {
    if (a.finished !== b.finished) return a.finished ? -1 : 1;
    if (a.finished && b.finished) return a.finishTime - b.finishTime;
    if (a.laps !== b.laps) return b.laps - a.laps;
    return b.t - a.t;
  });
}

/**
 * What a gap readout should show for `entry` relative to `other` — one of
 * three truthful pictures, not one number stretched to cover all of them.
 *
 * `relativeTo` wraps the along-track distance to within half a lap, which is
 * only meaningful when both cars are on the *same* lap: a car a whole lap
 * behind at the same track fraction wraps to a few metres and reports a
 * seconds gap of about nothing, which is a lie — it also hides the lap
 * itself, the fact that actually matters. And `stepField` stops advancing a
 * `finished` entry, so its track position afterwards is wherever it happened
 * to cross the line, not a live target — a distance-based gap to a parked
 * car isn't a gap, it's an artefact of where it stopped.
 *
 * So: different lap counts get a lap difference (what a timing screen shows,
 * and unambiguous); a finished `other` gets its finish time instead of a
 * live figure; only the same-lap, still-racing case gets a seconds gap.
 *
 * Sign convention throughout: positive means `entry` trails `other`.
 *
 * @param {object} entry the viewing car
 * @param {object} other the car being compared to
 * @param {number} lapLength metres
 * @returns {{kind: 'finished', finishTime: number}
 *   | {kind: 'laps', delta: number}
 *   | {kind: 'seconds', seconds: number}}
 */
export function rivalGapDisplay(entry, other, lapLength) {
  if (other.finished) {
    return { kind: 'finished', finishTime: other.finishTime };
  }
  if (entry.laps !== other.laps) {
    return { kind: 'laps', delta: other.laps - entry.laps };
  }
  const rel = relativeTo(entry, other, lapLength);
  const v = Math.max(forwardSpeed(entry.vehicle), 5);
  return { kind: 'seconds', seconds: rel.aheadGap / v };
}
