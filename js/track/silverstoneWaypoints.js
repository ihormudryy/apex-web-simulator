import { filletToLength } from './fillet.js';

// Approximate GP loop, metres, clockwise from Hamilton Straight toward Abbey.
// Arena (Village/Loop) is +X; Hangar Straight is the long +Z run.
//
// `radius` is the corner radius in true metres and it is what sets the corner's
// speed: a car with `latG` of grip can hold `sqrt(latG * 9.81 * radius)`. The
// values below aim at the real circuit's character — The Loop slowest, Copse and
// Abbey flat-out — and are honoured exactly, because the control polygon is
// scaled to hit the 5.891 km lap while the radii stay fixed.
export const SILVERSTONE_CORNERS = [
  { x:  820, z:-326.6667, halfWidth: 8.5, runoff: 14, radius: 600 }, // Hamilton Straight (grid)
  { x:  780, z: -220, halfWidth: 7.5, runoff: 16, radius: 170 }, // Abbey
  { x:  650, z: -180, halfWidth: 7.0, runoff: 14, radius: 110 }, // Farm
  { x:  520, z: -470, halfWidth: 7.0, runoff: 12, radius:  55 }, // Village
  { x:  310, z: -430, halfWidth: 6.5, runoff:  6, radius:  30 }, // The Loop
  { x:  280, z: -280, halfWidth: 7.0, runoff: 12, radius:  90 }, // Aintree
  { x:  120, z:  -40, halfWidth: 7.5, runoff: 14, radius: 260 }, // Wellington Straight
  { x: -180, z:  220, halfWidth: 7.5, runoff: 14, radius: 220 },
  { x: -420, z:  280, halfWidth: 7.0, runoff: 12, radius:  75 }, // Brooklands
  { x: -620, z:  180, halfWidth: 7.0, runoff: 12, radius:  55 }, // Luffield
  { x: -680, z:  -40, halfWidth: 7.5, runoff: 16, radius: 190 }, // Woodcote
  { x: -600, z: -280, halfWidth: 7.5, runoff: 22, radius: 200 }, // Copse
  { x: -420, z: -420, halfWidth: 7.0, runoff: 16, radius: 170 }, // Maggotts
  { x: -220, z: -500, halfWidth: 7.0, runoff: 16, radius: 130 }, // Becketts
  { x:  -40, z: -620, halfWidth: 7.0, runoff: 14, radius: 150 }, // Chapel
  { x:  180, z: -900, halfWidth: 7.5, runoff: 18, radius: 500 }, // Hangar Straight
  { x:  420, z:-1180, halfWidth: 7.5, runoff: 18, radius: 240 },
  { x:  640, z:-1280, halfWidth: 7.5, runoff: 24, radius: 115 }, // Stowe
  { x:  820, z:-1120, halfWidth: 7.0, runoff: 16, radius:  60 }, // Vale
  { x:  880, z: -820, halfWidth: 7.5, runoff: 20, radius: 130 }, // Club
  { x:  840, z: -380, halfWidth: 8.5, runoff: 14, radius: 260 }, // Hamilton Straight approach
];

/** FIA Grand Prix layout length. */
export const SILVERSTONE_LENGTH = 5891;

const filleted = filletToLength(SILVERSTONE_CORNERS, SILVERSTONE_LENGTH);

/** Dense centerline ring: straights plus a tangent arc at every corner. */
export const SILVERSTONE_WAYPOINTS = filleted.ring;

/** Start/finish sits on Hamilton Straight, which is where the ring opens. */
export const SILVERSTONE_SPAWN_T = 0;
