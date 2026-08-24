/**
 * Simulator vs arcade presets. Modes adjust driver aids, warm start, and grip —
 * not a second integrator.
 */

export const PHYSICS_PREF_KEY = 'apex-web-simulator.physics';

/** @typedef {'sim' | 'arcade'} PhysicsModeId */

export const PHYSICS_MODES = {
  sim: {
    id: 'sim',
    label: 'Simulator',
    short: 'Sim',
    blurb: 'No aids. Cold tyres at start.',
    aids: false,
    warm: false,
    warmOnReset: false,
    gripScale: 1.0,
  },
  arcade: {
    id: 'arcade',
    label: 'Arcade',
    short: 'Arcade',
    blurb: 'Traction & brake aids. Warm tyres.',
    aids: true,
    warm: true,
    warmOnReset: true,
    gripScale: 1.12,
  },
};

/**
 * @param {PhysicsModeId | string | null | undefined} mode
 * @returns {typeof PHYSICS_MODES.sim}
 */
export function physicsPreset(mode) {
  return PHYSICS_MODES[mode] ?? PHYSICS_MODES.arcade;
}

/**
 * @param {string} [search]
 * @param {PhysicsModeId | null} [stored]
 * @returns {PhysicsModeId}
 */
export function resolvePhysicsMode(search = '', stored = null) {
  const param = new URLSearchParams(search).get('physics');
  if (param === 'sim' || param === 'arcade') return param;
  if (stored === 'sim' || stored === 'arcade') return stored;
  return 'arcade';
}

/**
 * @param {Pick<Storage, 'getItem'> | null | undefined} [storage]
 * @returns {PhysicsModeId | null}
 */
export function readStoredPhysicsMode(storage = globalThis.localStorage) {
  try {
    const value = storage?.getItem?.(PHYSICS_PREF_KEY);
    if (value === 'sim' || value === 'arcade') return value;
  } catch {
    /* private mode / denied */
  }
  return null;
}

/**
 * @param {PhysicsModeId} mode
 * @param {Pick<Storage, 'setItem'> | null | undefined} [storage]
 */
export function writeStoredPhysicsMode(mode, storage = globalThis.localStorage) {
  if (mode !== 'sim' && mode !== 'arcade') return;
  try {
    storage?.setItem?.(PHYSICS_PREF_KEY, mode);
  } catch {
    /* private mode / denied */
  }
}

/**
 * Scale peak grip on an `applySetup()` tune object.
 * @param {object} tune
 * @param {PhysicsModeId | string} mode
 */
export function applyGripScale(tune, mode) {
  const { gripScale } = physicsPreset(mode);
  tune.muScaleFront *= gripScale;
  tune.muScaleRear *= gripScale;
  return tune;
}
