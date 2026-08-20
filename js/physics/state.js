/**
 * The sim state vector.
 *
 * One flat `Float64Array` holding everything needed to reconstruct the car
 * exactly. That is not tidiness for its own sake — it is what makes two things
 * possible that a graph of objects cannot:
 *
 *   - **Zero-copy to a Web Worker.** With cross-origin isolation (COOP/COEP) the
 *     buffer can be a `SharedArrayBuffer` and the worker writes physics straight
 *     into memory the renderer reads. Without those headers it falls back to
 *     `postMessage`, which for one flat array is a single cheap structured clone
 *     rather than a deep walk of nested objects.
 *
 *   - **An allocation-free inner loop.** The previous kernel returned a fresh
 *     object literal from every `step()`, with a four-element array inside it. At
 *     600 Hz that is 600 objects and 600 arrays a second straight into the
 *     nursery, and the resulting GC pauses read as exactly the micro-stutter that
 *     makes a platform feel unstable.
 *
 * Float64 throughout, not Float32. The world is a circuit a kilometre across and
 * the integrator runs at 600 Hz; single precision loses about 7 significant
 * digits, which shows up as position jitter and as replays that stop matching.
 * Rendering can have float32 — physics cannot.
 */

/** Wheel order, used consistently everywhere: front-left, front-right, rear-*. */
export const FL = 0;
export const FR = 1;
export const RL = 2;
export const RR = 3;
export const WHEELS = 4;

// --- rigid body, world frame -----------------------------------------------
export const S_X = 0;
export const S_Z = 1;
export const S_YAW = 2;
export const S_VX = 3;
export const S_VZ = 4;
export const S_AV = 5;

/**
 * Body-frame accelerations from the previous step. Load transfer needs the
 * acceleration that produced the current attitude, and using this step's would be
 * an implicit equation.
 */
export const S_A_LONG = 6;
export const S_A_LAT = 7;

// --- per wheel --------------------------------------------------------------
/** Angular velocity, rad/s. The DOF the old model did not have. */
export const S_OMEGA = 8;              // 8..11
/** Lagged slip angle and slip ratio — the relaxation-length state. */
export const S_ALPHA_LAG = 12;         // 12..15
export const S_KAPPA_LAG = 16;         // 16..19
export const S_TYRE_SURFACE_T = 20;    // 20..23
export const S_TYRE_CARCASS_T = 24;    // 24..27
export const S_TYRE_WEAR = 28;         // 28..31
export const S_BRAKE_T = 32;           // 32..35

// --- vertical system --------------------------------------------------------
export const S_ZC = 36;
export const S_PITCH = 37;
export const S_ROLL = 38;
export const S_VC = 39;
export const S_V_PITCH = 40;
export const S_V_ROLL = 41;
export const S_ZW = 42;                // 42..45
export const S_VW = 46;                // 46..49

// --- powertrain -------------------------------------------------------------
export const S_GEAR = 50;
export const S_SHIFT_TIMER = 51;
export const S_BOOST = 52;
export const S_SOC = 53;

// --- aero -------------------------------------------------------------------
export const S_FLOOR_LAG_FRONT = 54;
export const S_FLOOR_LAG_REAR = 55;

// --- driver and session -----------------------------------------------------
export const S_STEER = 56;
export const S_DRS = 57;
export const S_FUEL = 58;
export const S_TIME = 59;

// --- damage -------------------------------------------------------------------
/**
 * Accumulated damage, 0..1 per system. In the state vector rather than a side
 * object for the same reason everything else is: the vector is a complete
 * snapshot, and a replay that reproduced the trajectory but forgot the car was
 * dragging a broken corner would diverge from the recording at the first corner.
 */
export const S_DMG_WING = 60;
export const S_DMG_FLOOR = 61;
export const S_DMG_WHEEL = 62;          // 62..65

export const STATE_LENGTH = 66;

/** Human-readable names, for telemetry headers and for debugging a snapshot. */
export const STATE_NAMES = (() => {
  const names = new Array(STATE_LENGTH).fill('');
  const scalars = {
    [S_X]: 'x', [S_Z]: 'z', [S_YAW]: 'yaw', [S_VX]: 'vx', [S_VZ]: 'vz',
    [S_AV]: 'av', [S_A_LONG]: 'aLong', [S_A_LAT]: 'aLat',
    [S_ZC]: 'zc', [S_PITCH]: 'pitch', [S_ROLL]: 'roll',
    [S_VC]: 'vc', [S_V_PITCH]: 'vPitch', [S_V_ROLL]: 'vRoll',
    [S_GEAR]: 'gear', [S_SHIFT_TIMER]: 'shiftTimer', [S_BOOST]: 'boost',
    [S_SOC]: 'soc', [S_FLOOR_LAG_FRONT]: 'floorLagFront',
    [S_FLOOR_LAG_REAR]: 'floorLagRear', [S_STEER]: 'steer', [S_DRS]: 'drs',
    [S_FUEL]: 'fuel', [S_TIME]: 'time',
  };
  const perWheel = {
    [S_OMEGA]: 'omega', [S_ALPHA_LAG]: 'alphaLag', [S_KAPPA_LAG]: 'kappaLag',
    [S_TYRE_SURFACE_T]: 'tyreSurfaceT', [S_TYRE_CARCASS_T]: 'tyreCarcassT',
    [S_TYRE_WEAR]: 'tyreWear', [S_BRAKE_T]: 'brakeT',
    [S_ZW]: 'zw', [S_VW]: 'vw',
    [S_DMG_WHEEL]: 'dmgWheel',
  };
  const corner = ['FL', 'FR', 'RL', 'RR'];
  for (const [base, name] of Object.entries(scalars)) names[base] = name;
  for (const [base, name] of Object.entries(perWheel)) {
    for (let i = 0; i < WHEELS; i++) names[Number(base) + i] = `${name}${corner[i]}`;
  }
  return names;
})();

/**
 * Allocate a state vector.
 *
 * `shared` asks for a `SharedArrayBuffer`, which needs cross-origin isolation and
 * is therefore not always available. It falls back silently rather than throwing,
 * because a car that runs on the main thread is far better than one that does not
 * run at all.
 */
export function createState({ shared = false } = {}) {
  const bytes = STATE_LENGTH * 8;
  if (shared && typeof SharedArrayBuffer === 'function' && globalThis.crossOriginIsolated) {
    return new Float64Array(new SharedArrayBuffer(bytes));
  }
  return new Float64Array(STATE_LENGTH);
}

export const isShared = S =>
  typeof SharedArrayBuffer === 'function' && S.buffer instanceof SharedArrayBuffer;

/** Copy a state vector. For a replay ghost, or a snapshot to diff against. */
export function copyState(S, into = new Float64Array(STATE_LENGTH)) {
  into.set(S);
  return into;
}

/** Read a snapshot as a named object. Debugging and telemetry only — allocates. */
export function describeState(S) {
  const out = {};
  for (let i = 0; i < STATE_LENGTH; i++) {
    if (STATE_NAMES[i]) out[STATE_NAMES[i]] = S[i];
  }
  return out;
}

export function stateIsFinite(S) {
  for (let i = 0; i < STATE_LENGTH; i++) {
    if (!Number.isFinite(S[i])) return false;
  }
  return true;
}
