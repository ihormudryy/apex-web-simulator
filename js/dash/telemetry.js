// One frame's worth of driver-facing numbers, and the lap timing state behind them.
//
// Reads the car and the track; touches neither the DOM nor Three.js, so the whole
// thing runs under `node --test`. The dashboard renders whatever this returns and
// knows nothing about how it was worked out.

import {
  forwardSpeed, lateralSpeed, speed, resolvePedals, telemetryOf,
} from '../physics/vehicle.js';
import { MASS, G } from '../physics/constants.js';
import { gearFor, rpmFor, shiftFraction } from './gearbox.js';
import { peakGrip, muScaleFor, gripFromTemperature, gripFromWear } from '../physics/wheel.js';
import { socFraction, BATTERY_CAPACITY } from '../physics/powertrain.js';

const RAD2DEG = 180 / Math.PI;
/** Steering lock at rest, matching `vehicle.js`. Normalises the steering readout. */
const MAX_STEER = 18 * Math.PI / 180;
/** Below this the car is manoeuvring, and a sideslip angle means nothing. */
const SLIP_FLOOR = 2;
/** Peak-hold on the g meter bleeds away at this many g per second. */
const PEAK_DECAY = 0.35;

/**
 * @param {object} options
 * @param {number} options.lapLength metres, for distance readouts.
 * @param {number} [options.sectors=3] timing sectors.
 * @param {number} [options.deltaBuckets=400] resolution of the best-lap trace.
 * @param {number} [options.minLapTime=20] a "lap" quicker than this is the car
 *   jittering over the line, not a lap.
 */
export function createTelemetry({
  lapLength, sectors = 3, deltaBuckets = 400, minLapTime = 20,
} = {}) {
  const state = {
    lapTime: 0,
    lapCount: 0,
    lastLapTime: null,
    bestLapTime: null,
    prevT: 0,
    sector: 1,
    sectorStart: 0,
    sectorTimes: new Array(sectors).fill(null),
    bestSectorTimes: new Array(sectors).fill(null),
    // Elapsed time at each point round the lap, so a delta can compare like for
    // like. Comparing whole laps only tells you the answer once it is too late.
    trace: new Float64Array(deltaBuckets).fill(NaN),
    bestTrace: null,
    lastBucket: -1,
    peakG: 0,
  };

  function startLap() {
    state.lapTime = 0;
    state.sector = 1;
    state.sectorStart = 0;
    state.sectorTimes = new Array(sectors).fill(null);
    state.trace = new Float64Array(deltaBuckets).fill(NaN);
    state.lastBucket = -1;
  }

  function reset() {
    state.lapTime = 0;
    state.lapCount = 0;
    state.lastLapTime = null;
    state.bestLapTime = null;
    state.prevT = 0;
    state.sector = 1;
    state.sectorStart = 0;
    state.sectorTimes = new Array(sectors).fill(null);
    state.bestSectorTimes = new Array(sectors).fill(null);
    state.trace = new Float64Array(deltaBuckets).fill(NaN);
    state.bestTrace = null;
    state.lastBucket = -1;
    state.peakG = 0;
  }

  function finishLap() {
    state.lastLapTime = state.lapTime;
    state.lapCount++;
    if (state.bestLapTime === null || state.lapTime < state.bestLapTime) {
      state.bestLapTime = state.lapTime;
      state.bestTrace = state.trace.slice();
      state.bestSectorTimes = state.sectorTimes.slice();
    }
    startLap();
  }

  /**
   * When the best lap was at this exact point, interpolated between buckets.
   *
   * Reading the bucket's own value makes the delta sawtooth: elapsed time keeps
   * climbing inside a bucket while the reference sits still, then the reference
   * jumps. At 46 m/s a 400-bucket lap is a bucket every third of a second, which
   * is plainly visible on the readout.
   */
  function referenceTime(t) {
    if (!state.bestTrace) return null;
    const scaled = t * deltaBuckets;
    const bucket = Math.min(deltaBuckets - 1, Math.max(0, Math.floor(scaled)));
    const from = state.bestTrace[bucket];
    if (!Number.isFinite(from)) return null;
    // Past the last recorded bucket, the lap ended: fall back to the lap time.
    const nextIndex = bucket + 1;
    const to = nextIndex < deltaBuckets && Number.isFinite(state.bestTrace[nextIndex])
      ? state.bestTrace[nextIndex]
      : state.bestLapTime;
    if (!Number.isFinite(to)) return from;
    const u = scaled - bucket;
    return from + (to - from) * u;
  }

  function sample(car, track, dt) {
    const v = car.vehicle;
    const pedals = resolvePedals(v, car.input);
    const fwd = forwardSpeed(v);
    const lat = lateralSpeed(v);
    const speedMs = speed(v);
    const q = track.query(v.x, v.z);

    // Lateral acceleration along the car's right. Turning left accelerates the car
    // left, and +av is a left turn, hence the sign.
    const latG = -v.av * fwd / G;
    const longG = v.axPrev / G;
    const combinedG = Math.hypot(latG, longG);

    // What the tyres can actually give right now. Read off the kernel's own
    // per-wheel state rather than recomputed from a lumped ClA and one surface
    // type: the loads include the suspension, the downforce includes ride height,
    // and each corner has its own surface, temperature and wear.
    const sim = telemetryOf(v);
    let gripN = 0;
    for (let i = 0; i < 4; i++) {
      const surf = v.car.surfaces[i];
      const scale = gripFromTemperature(sim.tyreT[i]) * gripFromWear(sim.tyreWear[i]);
      gripN += peakGrip(surf.mu, sim.fz[i], scale * muScaleFor(i < 2));
    }
    const gripLimitG = gripN / (MASS * G);

    state.peakG = Math.max(combinedG, state.peakG - PEAK_DECAY * dt);

    state.lapTime += dt;

    const t = q.t;

    // The lap boundary is settled first. Everything below describes where the car
    // is now, so it has to run against the lap that position belongs to — pairing
    // a fresh position with the outgoing lap's elapsed time made the delta jump by
    // a whole lap as the car crossed the line.
    if (t < state.prevT - 0.5 && state.lapTime > minLapTime) {
      state.sectorTimes[sectors - 1] = state.lapTime - state.sectorStart;
      finishLap();
    }
    state.prevT = t;

    const bucket = Math.min(deltaBuckets - 1, Math.max(0, Math.floor(t * deltaBuckets)));
    // Forward only. Reversing over your own trace would rewrite history with
    // times that were never set on the way round.
    if (bucket > state.lastBucket) {
      state.trace[bucket] = state.lapTime;
      state.lastBucket = bucket;
    }

    const reference = referenceTime(t);
    const delta = reference === null ? null : state.lapTime - reference;

    const sector = Math.min(sectors, Math.floor(t * sectors) + 1);
    if (sector === state.sector + 1) {
      state.sectorTimes[state.sector - 1] = state.lapTime - state.sectorStart;
      state.sectorStart = state.lapTime;
      state.sector = sector;
    }

    // The real gear and the real rpm, from the driveline. These used to be derived
    // backwards from road speed, so the tacho and the engine note were both a
    // function of how fast the scenery was moving rather than of the drivetrain.
    const gear = fwd < -0.5 ? 'R' : sim.gear;
    const rpm = sim.rpm;

    return {
      speedMs,
      speedKmh: speedMs * 3.6,
      gear,
      rpm,
      shift: shiftFraction(rpm),

      throttle: Math.abs(pedals.throttle),
      brake: pedals.brake ? 1 : 0,
      reversing: pedals.throttle < 0,
      // -1 full left, +1 full right. `steerAngle` is positive to the left.
      steer: -v.steerAngle / MAX_STEER,

      latG,
      longG,
      combinedG,
      peakG: state.peakG,
      gripLimitG,
      tractionUse: gripLimitG > 0 ? Math.min(1.4, combinedG / gripLimitG) : 0,
      slipDeg: Math.abs(fwd) > SLIP_FLOOR ? Math.atan2(lat, fwd) * RAD2DEG : 0,

      // Per-corner state, for the dashboard, the audio and the effects.
      tyreT: sim.tyreT,
      tyreWear: sim.tyreWear,
      brakeT: sim.brakeT,
      wheelLoad: sim.fz,
      slipRatio: sim.slipRatio,
      slipAngle: sim.slipAngle,
      slipSpeed: sim.slipSpeed,
      rideFront: sim.rideFront,
      rideRear: sim.rideRear,
      downforce: sim.downforce,
      drag: sim.drag,
      drs: sim.drs,
      ersCharge: socFraction({ soc: sim.soc }),
      boost: sim.boost,
      clutch: sim.clutch,
      steerTorque: sim.steerTorque,
      plankContact: sim.plankContact,
      onBumpStop: sim.onBumpStop,

      surface: q.surface,
      offTrack: q.surface !== 'tarmac',
      lateral: q.lateral,
      lapFraction: t,
      lapDistance: t * lapLength,
      position: { x: v.x, z: v.z },

      sector: state.sector,
      sectorCount: sectors,
      sectorTimes: state.sectorTimes,
      bestSectorTimes: state.bestSectorTimes,
      lapTime: state.lapTime,
      lastLapTime: state.lastLapTime,
      bestLapTime: state.bestLapTime,
      delta,
      lapCount: state.lapCount,
    };
  }

  return { sample, state, reset };
}

/** `1:41.234`, or a placeholder when there is no time yet. */
export function formatLapTime(seconds, placeholder = '--:--.---') {
  if (seconds === null || !Number.isFinite(seconds)) return placeholder;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${minutes}:${rest.toFixed(3).padStart(6, '0')}`;
}

/** `+0.421` / `-0.312`, signed so the sign itself carries the news. */
export function formatDelta(seconds, placeholder = '--.---') {
  if (seconds === null || !Number.isFinite(seconds)) return placeholder;
  return `${seconds >= 0 ? '+' : '-'}${Math.abs(seconds).toFixed(3)}`;
}

/** `28.412`, for a sector split. */
export function formatSector(seconds, placeholder = '--.---') {
  if (seconds === null || !Number.isFinite(seconds)) return placeholder;
  return seconds.toFixed(3);
}
