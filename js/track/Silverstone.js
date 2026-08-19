import { Track } from './Track.js';
import { SILVERSTONE_WAYPOINTS, SILVERSTONE_SPAWN_T } from './silverstoneWaypoints.js';

export function createSilverstone() {
  return new Track(SILVERSTONE_WAYPOINTS, { spawnT: SILVERSTONE_SPAWN_T });
}
