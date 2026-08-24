/**
 * Telemetry capture and export.
 *
 * The point of a log is to answer "what was the car doing at the moment it went
 * wrong", which needs channels sampled together on the sim clock. Like the input
 * recording this is a ring of typed arrays, for the same reason: the writer runs
 * inside the sim loop and must not allocate.
 *
 * Channels are declared rather than inferred so the CSV header is stable and a
 * diff between two runs lines up column by column.
 */

import { telemetryOf, forwardSpeed, lateralSpeed, speed } from './vehicle.js';
import * as ST from './state.js';

/**
 * The channel set. Anything a physics change might plausibly move, and nothing
 * that can be derived cheaply from the rest.
 *
 * Kept as a flat list of names; a log stores one `Float32Array` per channel.
 * Float32 is deliberate — the *physics* is float64, but a log is for looking at,
 * and halving the memory doubles the window you can keep.
 */
export const CHANNELS = [
  't', 'x', 'z', 'yaw',
  'speed', 'vLong', 'vLat', 'yawRate', 'sideslip',
  'aLong', 'aLat',
  'throttle', 'brake', 'steer',
  'gear', 'rpm', 'drs', 'soc',
  'fzFL', 'fzFR', 'fzRL', 'fzRR',
  'slipFL', 'slipFR', 'slipRL', 'slipRR',
  'kappaFL', 'kappaFR', 'kappaRL', 'kappaRR',
  'tyreTFL', 'tyreTFR', 'tyreTRL', 'tyreTRR',
  'brakeTFL', 'brakeTFR', 'brakeTRL', 'brakeTRR',
  'rideF', 'rideR', 'downforce', 'drag', 'mz',
  'trackT', 'trackLat', 'surface', 'y', 'pitch', 'roll', 'heave',
];

/** ~60 s at 100 Hz after decimation. */
export const DEFAULT_LOG_CAPACITY = 36000;
/** Log every Nth sim step by default — 100 Hz is more than enough resolution. */
export const DEFAULT_DECIMATION = 6;

export function createLog(capacity = DEFAULT_LOG_CAPACITY, decimation = DEFAULT_DECIMATION) {
  const data = Object.create(null);
  for (const name of CHANNELS) data[name] = new Float32Array(capacity);
  return { capacity, decimation, data, written: 0, stepCount: 0 };
}

export const logLength = log => Math.min(log.written, log.capacity);
export const logWrapped = log => log.written > log.capacity;

export function logIndex(log, k) {
  const n = logLength(log);
  const start = logWrapped(log) ? log.written % log.capacity : 0;
  return (start + (k % n)) % log.capacity;
}

/**
 * Write one sample. `sample` is a plain object keyed by channel name; missing
 * channels are written as 0 rather than left stale, so a gap reads as a gap.
 *
 * Returns true if the sample was kept — decimation drops most of them.
 */
export function logStep(log, sample) {
  const keep = log.stepCount % log.decimation === 0;
  log.stepCount++;
  if (!keep) return false;
  const i = log.written % log.capacity;
  for (const name of CHANNELS) {
    const v = sample[name];
    log.data[name][i] = typeof v === 'number' ? v : (v ? 1 : 0);
  }
  log.written++;
  return true;
}

export function resetLog(log) {
  log.written = 0;
  log.stepCount = 0;
  for (const name of CHANNELS) log.data[name].fill(0);
}

/** Read one sample back, oldest-first. */
export function logAt(log, k, out = {}) {
  const i = logIndex(log, k);
  for (const name of CHANNELS) out[name] = log.data[name][i];
  return out;
}

/** A single channel as a plain array, oldest-first — for plotting and diffing. */
export function channel(log, name) {
  const n = logLength(log);
  const src = log.data[name];
  const out = new Float32Array(n);
  for (let k = 0; k < n; k++) out[k] = src[logIndex(log, k)];
  return out;
}

/**
 * CSV, oldest-first. Fixed precision so two exports of the same run are
 * byte-identical and `diff` is usable as a first-pass comparison.
 */
export function toCSV(log, { precision = 5 } = {}) {
  const n = logLength(log);
  const lines = [CHANNELS.join(',')];
  const row = new Array(CHANNELS.length);
  for (let k = 0; k < n; k++) {
    const i = logIndex(log, k);
    for (let c = 0; c < CHANNELS.length; c++) {
      row[c] = trim(log.data[CHANNELS[c]][i], precision);
    }
    lines.push(row.join(','));
  }
  return `${lines.join('\n')}\n`;
}

/** Fixed precision without the trailing zeros, which are pure noise in a diff. */
function trim(v, precision) {
  if (!Number.isFinite(v)) return '';
  if (v === 0) return '0';
  const s = v.toFixed(precision);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/**
 * Compare two logs channel by channel. This is the actual instrument for "did my
 * physics change do what I think it did": replay the same inputs before and
 * after, then read the table.
 */
export function diffLogs(a, b, { channels = CHANNELS } = {}) {
  const n = Math.min(logLength(a), logLength(b));
  const rows = [];
  for (const name of channels) {
    let maxAbs = 0;
    let sumSq = 0;
    let atK = 0;
    for (let k = 0; k < n; k++) {
      const d = a.data[name][logIndex(a, k)] - b.data[name][logIndex(b, k)];
      const ad = Math.abs(d);
      if (ad > maxAbs) { maxAbs = ad; atK = k; }
      sumSq += d * d;
    }
    rows.push({
      channel: name,
      maxAbs,
      rms: n ? Math.sqrt(sumSq / n) : 0,
      atSample: atK,
    });
  }
  return { samples: n, rows: rows.sort((p, q) => q.maxAbs - p.maxAbs) };
}

/** Surface codes for CSV — stable numeric labels rather than strings. */
export const SURFACE_CODE = { tarmac: 0, kerb: 1, grass: 2 };

/**
 * One sim-step sample from the live vehicle. Free of three.js; the browser hooks
 * this through `vehicle.observer` on the fixed step.
 *
 * @param {object} v vehicle from `createVehicle`
 * @param {object} [track] optional circuit, for centreline position
 */
export function sampleVehicleLog(v, track = null) {
  const S = v.car.S;
  const sim = telemetryOf(v);
  const q = track?.query ? track.query(v.x, v.z) : null;
  const fwd = forwardSpeed(v);
  const lat = lateralSpeed(v);
  const sus = v.car.suspension;
  return {
    t: S[ST.S_TIME],
    x: S[ST.S_X],
    z: S[ST.S_Z],
    yaw: S[ST.S_YAW],
    y: sim.chassisY,
    speed: speed(v),
    vLong: fwd,
    vLat: lat,
    yawRate: S[ST.S_AV],
    sideslip: Math.atan2(lat, Math.max(Math.abs(fwd), 0.5)),
    aLong: S[ST.S_A_LONG],
    aLat: S[ST.S_A_LAT],
    throttle: v.pedals?.throttle ?? 0,
    brake: v.pedals?.brake ? 1 : 0,
    steer: v.steerAngle,
    gear: S[ST.S_GEAR],
    rpm: sim.rpm,
    drs: S[ST.S_DRS] > 0.5 ? 1 : 0,
    soc: S[ST.S_SOC],
    fzFL: sim.fz[0],
    fzFR: sim.fz[1],
    fzRL: sim.fz[2],
    fzRR: sim.fz[3],
    slipFL: sim.slipAngle[0],
    slipFR: sim.slipAngle[1],
    slipRL: sim.slipAngle[2],
    slipRR: sim.slipAngle[3],
    kappaFL: sim.slipRatio[0],
    kappaFR: sim.slipRatio[1],
    kappaRL: sim.slipRatio[2],
    kappaRR: sim.slipRatio[3],
    tyreTFL: S[ST.S_TYRE_SURFACE_T],
    tyreTFR: S[ST.S_TYRE_SURFACE_T + 1],
    tyreTRL: S[ST.S_TYRE_SURFACE_T + 2],
    tyreTRR: S[ST.S_TYRE_SURFACE_T + 3],
    brakeTFL: S[ST.S_BRAKE_T],
    brakeTFR: S[ST.S_BRAKE_T + 1],
    brakeTRL: S[ST.S_BRAKE_T + 2],
    brakeTRR: S[ST.S_BRAKE_T + 3],
    rideF: sim.rideFront,
    rideR: sim.rideRear,
    downforce: sim.downforce,
    drag: sim.drag,
    mz: sim.steerTorque,
    trackT: q?.t ?? 0,
    trackLat: q?.lateral ?? 0,
    surface: SURFACE_CODE[q?.surface] ?? -1,
    pitch: sim.pitch,
    roll: sim.roll,
    heave: sim.heave,
  };
}

/**
 * Session recorder: toggle on Space, sample on the sim clock via `observer`.
 */
export function createTelemetryRecorder(options = {}) {
  const log = createLog(options.capacity, options.decimation);
  let active = false;
  return {
    log,
    get active() { return active; },
    start() {
      resetLog(log);
      active = true;
    },
    stop() {
      active = false;
      return logLength(log);
    },
    /** @returns {boolean} new active state */
    toggle() {
      if (active) {
        active = false;
        return false;
      }
      resetLog(log);
      active = true;
      return true;
    },
    observe(v, track) {
      if (!active) return false;
      return logStep(log, sampleVehicleLog(v, track));
    },
  };
}

/**
 * Trigger a CSV download in the browser. No-op under Node.
 *
 * @param {ReturnType<typeof createLog>} log
 * @param {string} [filename]
 */
export function downloadLogCSV(log, filename = 'telemetry.csv') {
  if (typeof document === 'undefined') return;
  const csv = toCSV(log);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
