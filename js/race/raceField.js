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
 *
 * KNOWN LIMITATION: `stepField` (and the `driveAi` call inside it) runs once
 * per RENDERED frame, while each entry's `advance` sub-steps the physics
 * itself at a fixed 600 Hz internally (see CLAUDE.md, "Sim clock != frame
 * clock"). The physics is refresh-rate independent; the AI's *decision* rate
 * is not — a rival re-aims and re-plans once per frame, so it samples the
 * racing line and the speed target coarser at 30 fps than at 144 fps.
 * Measured: a 1.8% lap-time spread (about 2.5 s a lap) across 30-144 fps.
 * The `DIFFICULTY` calibration table in aiDriver.js is only valid at the
 * 60 Hz it was measured on. Restructuring `driveAi` to run at a fixed rate
 * decoupled from the render loop (mirroring how physics already works) would
 * fix this properly; that is out of scope for this fix wave and is recorded
 * here rather than attempted.
 *
 * KNOWN LIMITATION: `elapsed` is wall-time-since-lights-out, not
 * time-actually-driven-since-the-last-crossing — it accrues identically
 * whether the car is racing or just sitting on the grid after the lights go
 * green (see the MIN_LAP_TIME comment below for why it has to start counting
 * at lights-out rather than 0). So a car that sits stationary for long enough
 * after the green light before its first crossing can still trip the
 * MIN_LAP_TIME guard on that very first crossing, crediting a lap it never
 * drove: measured, sitting still ~19 s after lights-out then driving off is
 * clean, but ~21 s credits one immediately. Strictly better than before this
 * fix wave (previously the guard could be satisfied before a wheel ever
 * turned, during the unbounded pre-lights hold — see the C2 fix below), but
 * the root cause — `elapsed` measuring wall time rather than driven time — is
 * untouched. A fix would need to track "time since last crossing" as its own
 * clock, gated on actually moving, rather than deriving it from `elapsed`.
 */

import {
  createVehicle, setPose, advance, updateSteering, resetVehicle, forwardSpeed, speed,
} from '../physics/vehicle.js';
import { createAiState, driveAi } from './aiDriver.js';
import { buildRacingLine } from './racingLine.js';
import { resolveCarContact, createCarContact } from '../physics/carContact.js';
import { MIN_LAP_TIME } from '../dash/telemetry.js';

/** Three laps: long enough that a mistake costs the race, short enough to re-run. */
export const RACE_LAPS = 3;
/** Grid slots either side of the centreline, and the stagger between them, m. */
export const GRID_LATERAL = 1.9;
export const GRID_STAGGER = 5.0;
/** Same off-road bound `aiDriver.test.js` uses: 1 m past the tarmac/kerb edge. */
const OFF_ROAD_MARGIN = 1;
/** Below this the rival counts as stopped, not just slow through a corner. */
const STALL_SPEED = 1.0;
/**
 * How long a rival must sit off-road and stopped before the field recovers
 * it. `driveAi` never sets `reverse` (see aiDriver.js), so a beached rival
 * cannot recover on its own — this is the mitigation the design doc promises
 * ("the field returns a stranded rival to the grid rather than modelling a
 * recovery") and that shipped without an implementation. The recovery itself
 * no longer matches that doc's wording, though: it puts the car back at its
 * OWN position on track rather than the grid — see `recoverStranded` for why
 * returning it to the grid turned out to manufacture a free lap.
 *
 * 3 s is long enough that the AI's normal driving — which can be
 * off-road-and-slow only briefly, e.g. correcting a slide onto the kerb —
 * never trips it, but short enough that a genuinely beached car (which stays
 * at v=0 indefinitely, an absorbing state) doesn't sit parked for long.
 */
const STALL_TIME = 3.0;

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
    // Seeded from the ACTUAL grid `t`, not 0: a grid slot sits just before the
    // start/finish line (t close to 1), and starting `prevT` at 0 made the
    // very first step look like a backward wrap across the line — the seam
    // the MIN_LAP_TIME guard exists to reject, except the idle-plus-lights
    // hold before the player presses START is long enough on its own to
    // satisfy that guard too. See the C2 fix in `stepField`.
    const gridT = view.query(pose.x, pose.z).t;
    entries.push({
      slot,
      isPlayer,
      vehicle,
      view,
      ai: isPlayer ? null : createAiState(level),
      input: { forward: false, reverse: false, left: false, right: false, brake: false },
      laps: 0,
      t: gridT,
      prevT: gridT,
      lapStart: 0,
      elapsed: 0,
      finished: false,
      finishTime: 0,
      // Off-road-and-stopped time, for the stranded-rival grid return below.
      stallTime: 0,
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
    const gridT = e.view.query(pose.x, pose.z).t;
    e.laps = 0;
    e.t = gridT;
    e.prevT = gridT;
    e.lapStart = 0;
    e.elapsed = 0;
    e.finished = false;
    e.finishTime = 0;
    e.stallTime = 0;
  }
  return field;
}

/**
 * Recover a stranded rival: zero its motion and place it back on the road AT
 * ITS OWN `t` — centred on the centreline, facing the tangent — but leave its
 * race progress (`laps`, `elapsed`, `lapStart`) alone — this is recovery from
 * being stuck, not a reset of the race.
 *
 * This used to return the car to its GRID slot instead, reseeding `prevT`
 * from the grid's `t` (~0.9996) so the very next step wouldn't read as a
 * backward wrap across the start/finish line. That stopped the immediate
 * misread but not the real one: a rival that has been racing for a while
 * already has `elapsed - lapStart` well past MIN_LAP_TIME, so the grid sits
 * only a few metres before the line — and the very next crossing, a fraction
 * of a second later, credited a lap the car never drove. Measured on the
 * real `stepField` path with the stall accruing naturally (not a preset
 * `stallTime`): a rival stranded at t=0.50 gained a lap within about 0.2 s of
 * being "recovered" to the grid. See `raceField.test.js`'s
 * "a naturally stranded rival gains no lap..." test, which drives that exact
 * scenario and is what should have caught this before it shipped.
 *
 * Recovering at the car's OWN `t` instead sidesteps the whole class of bug:
 * `t` barely moves — the car was stuck, not off racing a lap elsewhere — so
 * no crossing is manufactured and `prevT` needs no special reseeding logic
 * to compensate for one. It also reads as better racing behaviour: a
 * recovered car rejoins where it went off, as it would in reality, rather
 * than being sent back to the start mid-race.
 *
 * @param {object} entry
 * @param {{index:number}} q this frame's already-computed query for `entry`
 *   — reused rather than queried a second time.
 */
function recoverStranded(entry, q) {
  const s = entry.view.centerline.samples[q.index];
  resetVehicle(entry.vehicle);
  const yaw = Math.atan2(-s.tx, -s.tz);
  setPose(entry.vehicle, s.x, s.z, yaw, entry.view);
  const here = entry.view.query(s.x, s.z).t;
  entry.t = here;
  entry.prevT = here;
  entry.stallTime = 0;
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

  // Contact: every unordered pair exactly once. Finished entries are skipped:
  // `advance` above already stops moving them (they're done), but leaving
  // them in this loop meant a parked car sitting dead on the racing line just
  // past the line still absorbed momentum from whoever was still racing —
  // physics never let go of a car the field had already stopped simulating.
  for (let i = 0; i < n; i++) {
    if (field.entries[i].finished) continue;
    for (let j = i + 1; j < n; j++) {
      if (field.entries[j].finished) continue;
      field.resolveContact(field.entries[i].vehicle.S, field.entries[j].vehicle.S, field.contact);
    }
  }

  // Lap accounting. `t` is a ring coordinate, so a car sitting on the start line
  // reads 0.9999 one step and 0.0001 the next; without the minimum-lap guard
  // that seam counts as a completed lap. Same rule the dashboard uses.
  //
  // `elapsed` only accrues once the lights go out (`!field.locked`): the idle
  // phase before the player arms the lights is unbounded, and accruing
  // through it (plus `prevT` starting at 0 against a grid `t` near 1) used to
  // satisfy the MIN_LAP_TIME guard before a wheel ever turned — a rival got a
  // free lap for roughly 13 s of sitting on the grid, sometimes the player
  // too. `t`/`prevT` still track every step, locked or not, so the guard's
  // clock starts exactly at lights-out with no stale wrap left over from the
  // hold.
  for (const e of field.entries) {
    if (e.finished) continue;
    const q = e.view.query(e.vehicle.x, e.vehicle.z);
    e.t = q.t;
    if (!field.locked) {
      e.elapsed += dt;
      if (e.t < e.prevT - 0.5 && e.elapsed - e.lapStart > MIN_LAP_TIME) {
        e.laps++;
        e.lapStart = e.elapsed;
      }
    }
    e.prevT = e.t;
    if (e.laps >= field.laps) {
      e.finished = true;
      e.finishTime = e.elapsed;
    }

    // Stranded-rival recovery (C1b): `driveAi` never sets `reverse`, so a
    // rival pushed off-road and stopped cannot get itself back — it is an
    // absorbing state, not a wobble. The player is exempt: teleporting a
    // human's car without asking is a different kind of bad experience, and
    // only the AI's own inputs can walk it into this state deterministically.
    if (!e.isPlayer && !e.finished) {
      const offRoad = Math.abs(q.lateral) > q.halfWidth + OFF_ROAD_MARGIN;
      const stopped = speed(e.vehicle) < STALL_SPEED;
      e.stallTime = offRoad && stopped ? e.stallTime + dt : 0;
      if (e.stallTime > STALL_TIME) recoverStranded(e, q);
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
