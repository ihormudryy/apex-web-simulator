// js/dash/creditsData.test.js
//
// The circuit is a derivative of OpenStreetMap survey traces by way of the
// TUMFTM racetrack-database. Crediting them is a licence obligation, not a
// courtesy, and it is the kind of obligation that quietly disappears in a
// refactor of a UI panel. These tests are the thing that notices.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CREDITS, REQUIRED_SOURCES, SHORT_ATTRIBUTION, creditLines,
} from './creditsData.js';

test('the always-visible line names OpenStreetMap and its licence', () => {
  // ODbL asks that a Produced Work credit the source and make the licence
  // clear. A credit that says only "OpenStreetMap" does not do the second half.
  assert.match(SHORT_ATTRIBUTION, /OpenStreetMap/);
  assert.match(SHORT_ATTRIBUTION, /ODbL/);
});

test('every licence-obligated source is credited', () => {
  const named = CREDITS.map(c => c.source);
  for (const required of REQUIRED_SOURCES) {
    assert.ok(named.includes(required),
      `${required} is a licence obligation and is no longer in CREDITS`);
  }
});

test('OpenStreetMap is credited with ODbL and points at the copyright page', () => {
  const osm = CREDITS.find(c => c.source === 'OpenStreetMap contributors');
  assert.ok(osm, 'no OpenStreetMap credit');
  assert.equal(osm.licence, 'ODbL');
  assert.equal(osm.url, 'https://www.openstreetmap.org/copyright');
});

test('the survey database is credited under the licence it ships under', () => {
  const tum = CREDITS.find(c => c.source === 'TUMFTM racetrack-database');
  assert.ok(tum, 'no TUMFTM credit');
  assert.equal(tum.licence, 'LGPL-3.0');
});

test('every credit is complete and links somewhere reachable', () => {
  for (const c of CREDITS) {
    for (const field of ['what', 'source', 'licence', 'url']) {
      assert.ok(typeof c[field] === 'string' && c[field].length > 0,
        `credit for ${c.source ?? '(unnamed)'} has an empty ${field}`);
    }
    assert.ok(c.url.startsWith('https://'), `${c.source} url is not https: ${c.url}`);
  }
});

test('creditLines renders one line per credit, naming source and licence', () => {
  const lines = creditLines();
  assert.equal(lines.length, CREDITS.length);
  const osmLine = lines.find(l => l.includes('OpenStreetMap contributors'));
  assert.ok(osmLine, 'OpenStreetMap missing from the rendered lines');
  assert.match(osmLine, /ODbL/);
});
