/**
 * Where the world came from, and under what licence.
 *
 * Not decoration: the circuit geometry is a derivative of OpenStreetMap survey
 * traces, and ODbL requires that a Produced Work — which is what the rendered
 * scene is — credits OpenStreetMap and makes the licence clear. The OSMF
 * Attribution Guidelines accept a corner of the view, a credits screen, or a
 * menu for an interactive work, which is what `CreditsPanel` renders.
 *
 * Pure data with no DOM, so `creditsData.test.js` can assert the obligations
 * are still met without a browser. Adding a source here is what puts it on the
 * screen; removing one is what should fail a test.
 */

/** The one line that must be visible without opening anything. ODbL, §4.3. */
export const SHORT_ATTRIBUTION = 'Map data © OpenStreetMap contributors, ODbL';

/**
 * @typedef {object} Credit
 * @property {string} what which part of the build this is
 * @property {string} source who made it
 * @property {string} licence SPDX-ish identifier, as the source states it
 * @property {string} url where the licence and the original live
 */

/** @type {Credit[]} */
export const CREDITS = [
  {
    what: 'Circuit centerline and track widths',
    source: 'TUMFTM racetrack-database',
    licence: 'LGPL-3.0',
    url: 'https://github.com/TUMFTM/racetrack-database',
  },
  {
    what: 'Survey traces underlying that centerline',
    source: 'OpenStreetMap contributors',
    licence: 'ODbL',
    url: 'https://www.openstreetmap.org/copyright',
  },
  {
    what: 'Georeferencing cross-check for the grid',
    source: 'bacinger/f1-circuits',
    licence: 'MIT',
    url: 'https://github.com/bacinger/f1-circuits',
  },
  {
    what: 'Sky HDRI, grass normal and roughness maps',
    source: 'Poly Haven',
    licence: 'CC0',
    url: 'https://polyhaven.com',
  },
  {
    what: 'Placeholder car and driver meshes',
    source: 'HelloRacer WebGL demo',
    licence: 'Demo art — replace before shipping publicly',
    url: 'https://helloracer.com/webgl/',
  },
  {
    what: 'Renderer',
    source: 'three.js',
    licence: 'MIT',
    url: 'https://threejs.org',
  },
];

/**
 * Attributions that are a licence obligation rather than a courtesy. CC0 and
 * MIT sources are listed above because it is good manners; these two are listed
 * because the licence says so, and the test asserts they survive an edit.
 */
export const REQUIRED_SOURCES = ['OpenStreetMap contributors', 'TUMFTM racetrack-database'];

/** One flat line per credit, for a text-only surface. */
export function creditLines(credits = CREDITS) {
  return credits.map(c => `${c.what}: ${c.source} (${c.licence})`);
}
