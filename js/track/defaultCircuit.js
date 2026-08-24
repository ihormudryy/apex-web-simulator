import { Track } from './Track.js';
import { SILVERSTONE_WAYPOINTS, SILVERSTONE_SPAWN_T } from './silverstoneWaypoints.js';

/** User-facing circuit name — no trademarked venue branding. */
export const DEFAULT_CIRCUIT_NAME = 'Northamptonshire Circuit';

/**
 * Procedural open-wheel circuit shipped with the simulator.
 * Geometry is inspired by a British GP-style layout; not an official track map.
 *
 * @param {object} [options] forwarded to `Track` — notably `groundMargin`.
 */
export function createDefaultCircuit(options = {}) {
  return new Track(SILVERSTONE_WAYPOINTS, { spawnT: SILVERSTONE_SPAWN_T, ...options });
}
