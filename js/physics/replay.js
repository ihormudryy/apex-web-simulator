/**
 * Input recording and replay.
 *
 * This is the instrument that makes a physics change measurable. Without it the
 * only available question is "does this feel better?", asked of a person who has
 * just spent an hour writing the change and wants the answer to be yes. With it
 * the question becomes "drive a lap, save the inputs, apply the change, replay,
 * and diff the trajectory" — which has an answer.
 *
 * Two properties are load-bearing:
 *
 *   - **Inputs are sampled on the sim clock, not the frame clock.** A recording
 *     keyed to frames would replay differently on a different machine, which is
 *     exactly the bug the fixed step was introduced to kill.
 *   - **Inputs are a bitfield.** Five booleans and a steer angle per step; at
 *     600 Hz a two-minute lap is 72 000 steps, so a `Uint8Array` of flags and a
 *     `Float64Array` of steer is ~650 kB where an array of objects would be tens
 *     of megabytes and would allocate while driving.
 *
 * The steer channel is float64, not float32. That looks like a needless doubling
 * of the largest array here, and it is the difference between a replay that is
 * bit-exact and one that is merely close: the sim integrates steer in float64, so
 * storing it narrower feeds the replay a *rounded* angle and the two trajectories
 * separate at about 1e-9 per step. Which is small, and compounds, and makes the
 * trajectory diff useless for exactly the small changes it exists to detect.
 *
 * The steer angle is recorded rather than the left/right keys because steering is
 * integrated on the *frame* clock — it is a driver model, not physics — so keys
 * alone do not reproduce a run. Recording the resulting angle makes the physics
 * replay exact regardless.
 */

export const FLAG_FORWARD = 1 << 0;
export const FLAG_REVERSE = 1 << 1;
export const FLAG_BRAKE = 1 << 2;
export const FLAG_LEFT = 1 << 3;
export const FLAG_RIGHT = 1 << 4;
export const FLAG_DRS = 1 << 5;

/** Two minutes at 600 Hz — a lap of Silverstone with room to spare. */
export const DEFAULT_CAPACITY = 72000;

export function packInput(input) {
  return (input.forward ? FLAG_FORWARD : 0)
    | (input.reverse ? FLAG_REVERSE : 0)
    | (input.brake ? FLAG_BRAKE : 0)
    | (input.left ? FLAG_LEFT : 0)
    | (input.right ? FLAG_RIGHT : 0)
    | (input.drs ? FLAG_DRS : 0);
}

export function unpackInput(flags, out = {}) {
  out.forward = (flags & FLAG_FORWARD) !== 0;
  out.reverse = (flags & FLAG_REVERSE) !== 0;
  out.brake = (flags & FLAG_BRAKE) !== 0;
  out.left = (flags & FLAG_LEFT) !== 0;
  out.right = (flags & FLAG_RIGHT) !== 0;
  out.drs = (flags & FLAG_DRS) !== 0;
  return out;
}

/**
 * A fixed-size ring of per-step inputs.
 *
 * Ring rather than growable: the recorder runs inside the sim loop, and a buffer
 * that reallocates mid-lap is a GC pause at 200 km/h. When it wraps it keeps the
 * most recent `capacity` steps, which is the useful window anyway — you almost
 * always want "the last thirty seconds, during which it went wrong".
 */
export function createRecording(capacity = DEFAULT_CAPACITY) {
  return {
    capacity,
    flags: new Uint8Array(capacity),
    steer: new Float64Array(capacity),
    /** Total steps ever written, so `wrapped` and ordering are recoverable. */
    written: 0,
  };
}

export function recordStep(rec, flags, steerAngle) {
  const i = rec.written % rec.capacity;
  rec.flags[i] = flags;
  rec.steer[i] = steerAngle;
  rec.written++;
}

export const recordingLength = rec => Math.min(rec.written, rec.capacity);
export const recordingWrapped = rec => rec.written > rec.capacity;

/** Oldest-first index into the ring for logical position `k`. */
export function recordingIndex(rec, k) {
  const n = recordingLength(rec);
  const start = recordingWrapped(rec) ? rec.written % rec.capacity : 0;
  return (start + (k % n)) % rec.capacity;
}

export function recordingAt(rec, k, out = {}) {
  const i = recordingIndex(rec, k);
  const input = unpackInput(rec.flags[i], out);
  input.steer = rec.steer[i];
  return input;
}

export function resetRecording(rec) {
  rec.written = 0;
  rec.flags.fill(0);
  rec.steer.fill(0);
}

/**
 * Replay a recording through a sim step function, oldest step first.
 *
 * `stepFn(input, k)` must advance exactly one sim step. `onStep`, if given, runs
 * after each step — that is the hook a trajectory diff or a telemetry log uses.
 */
export function replay(rec, stepFn, onStep) {
  const n = recordingLength(rec);
  const input = {};
  for (let k = 0; k < n; k++) {
    recordingAt(rec, k, input);
    stepFn(input, k);
    if (onStep) onStep(k);
  }
  return n;
}

/**
 * Serialise to something that survives a round trip through JSON or a file.
 * Base64 rather than a number array: a 72 000-entry JSON array of small integers
 * is ~200 kB of text where the packed form is 96 kB.
 */
export function serializeRecording(rec) {
  const n = recordingLength(rec);
  const flags = new Uint8Array(n);
  const steer = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const i = recordingIndex(rec, k);
    flags[k] = rec.flags[i];
    steer[k] = rec.steer[i];
  }
  return {
    version: 1,
    length: n,
    flags: toBase64(flags),
    steer: toBase64(new Uint8Array(steer.buffer, steer.byteOffset, steer.byteLength)),
  };
}

export function deserializeRecording(blob) {
  if (blob?.version !== 1) throw new Error(`unknown recording version ${blob?.version}`);
  const flags = fromBase64(blob.flags);
  const steerBytes = fromBase64(blob.steer);
  const steer = new Float64Array(
    steerBytes.buffer, steerBytes.byteOffset, steerBytes.byteLength / 8);
  const rec = createRecording(Math.max(1, blob.length));
  rec.flags.set(flags.subarray(0, blob.length));
  rec.steer.set(steer.subarray(0, blob.length));
  rec.written = blob.length;
  return rec;
}

function toBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function fromBase64(text) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(text, 'base64'));
  const s = atob(text);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}
