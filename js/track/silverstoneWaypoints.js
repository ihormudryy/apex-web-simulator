import { densifyRing } from './densify.js';
import { SILVERSTONE_SURVEYED_RING } from './silverstoneSurvey.js';

// The GP loop used to be a hand-tuned 21-corner control polygon filleted to
// the lap length — an approximation with the right character but ~134 m RMS
// from the real geometry. It is now the surveyed centerline with per-point
// real track widths (see silverstoneSurvey.js for the provenance and the
// repairs), densified from 5 m survey spacing to sub-metre segments so the
// heading the physics reads is continuous. The old control polygon lives on
// only inside scripts/import-silverstone-centerline.mjs, as the frame the
// survey was aligned to.

/** FIA Grand Prix layout length, which the survey is normalized to. */
export const SILVERSTONE_LENGTH = 5891;

/** Dense centerline ring: the surveyed line, spline-densified. */
export const SILVERSTONE_WAYPOINTS = densifyRing(SILVERSTONE_SURVEYED_RING, 0.75);

/** Start/finish sits on Hamilton Straight, where the survey ring opens. */
export const SILVERSTONE_SPAWN_T = 0;
