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
];

/** One sample per sim step is 600 Hz; 20 s of that is plenty to look at. */
export const DEFAULT_LOG_CAPACITY = 12000;
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
