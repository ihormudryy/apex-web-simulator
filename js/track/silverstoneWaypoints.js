import { buildCenterline } from './centerline.js';

// Approximate GP loop, metres, clockwise from Hamilton Straight toward Abbey.
// Arena (Village/Loop) is +X; Hangar Straight is the long +Z run.
export const SILVERSTONE_WAYPOINTS_UNSCALED = [
  { x:  820, z:-326.6667, halfWidth: 8.5, runoff: 14 }, // Hamilton Straight
  { x:  780, z: -220, halfWidth: 7.5, runoff: 16 }, // Abbey
  { x:  650, z: -180, halfWidth: 7.0, runoff: 14 }, // Farm
  { x:  520, z: -470, halfWidth: 7.0, runoff: 12 }, // Village
  { x:  310, z: -430, halfWidth: 6.5, runoff: 6  }, // The Loop
  { x:  280, z: -280, halfWidth: 7.0, runoff: 12 }, // Aintree
  { x:  120, z:  -40, halfWidth: 7.5, runoff: 14 }, // Wellington Straight
  { x: -180, z:  220, halfWidth: 7.5, runoff: 14 },
  { x: -420, z:  280, halfWidth: 7.0, runoff: 12 }, // Brooklands
  { x: -620, z:  180, halfWidth: 7.0, runoff: 12 }, // Luffield
  { x: -680, z:  -40, halfWidth: 7.5, runoff: 16 }, // Woodcote
  { x: -600, z: -280, halfWidth: 7.5, runoff: 22 }, // Copse
  { x: -420, z: -420, halfWidth: 7.0, runoff: 16 }, // Maggotts
  { x: -220, z: -500, halfWidth: 7.0, runoff: 16 }, // Becketts
  { x:  -40, z: -620, halfWidth: 7.0, runoff: 14 }, // Chapel
  { x:  180, z: -900, halfWidth: 7.5, runoff: 18 }, // Hangar Straight
  { x:  420, z:-1180, halfWidth: 7.5, runoff: 18 },
  { x:  640, z:-1280, halfWidth: 7.5, runoff: 24 }, // Stowe
  { x:  820, z:-1120, halfWidth: 7.0, runoff: 16 }, // Vale
  { x:  880, z: -820, halfWidth: 7.5, runoff: 20 }, // Club
  { x:  840, z: -380, halfWidth: 8.5, runoff: 14 }, // Hamilton Straight approach from Club
];

const TARGET = 5891;
const raw = SILVERSTONE_WAYPOINTS_UNSCALED;
const len = buildCenterline(raw, 800).length;
const k = TARGET / len;
export const SILVERSTONE_WAYPOINTS = raw.map(p => ({
  x: p.x * k, z: p.z * k, halfWidth: p.halfWidth, runoff: p.runoff,
}));
export const SILVERSTONE_SPAWN_T = 0;
