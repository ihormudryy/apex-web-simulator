import { Track } from './Track.js';
import { SILVERSTONE_WAYPOINTS, SILVERSTONE_SPAWN_T } from './silverstoneWaypoints.js';

/**
 * @param {object} [options] forwarded to `Track` — notably `groundMargin`, which
 *   the caller sets from its own `fog.far`.
 */
export function createSilverstone(options = {}) {
  return new Track(SILVERSTONE_WAYPOINTS, { spawnT: SILVERSTONE_SPAWN_T, ...options });
}
