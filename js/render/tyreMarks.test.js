import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMarkBuffer, clearMarks, layMark, markTotal, markAt,
  MARK_ALONG, MARK_ACROSS, MARK_CEILING,
} from './tyreMarks.js';

test('a fresh buffer has no rubber on it', () => {
  const marks = createMarkBuffer();
  assert.equal(markTotal(marks), 0);
  assert.equal(marks.data.length, MARK_ALONG * MARK_ACROSS);
});

test('laying a mark darkens the road where the tyre was', () => {
  const marks = createMarkBuffer();
  assert.equal(layMark(marks, 0.25, 0, 0.5), true);
  assert.ok(markAt(marks, 0.25, 0) > 0);
  assert.equal(markAt(marks, 0.75, 0), 0, 'and nowhere else');
  assert.equal(marks.dirty, true);
});

test('rubber accumulates over a session', () => {
  const marks = createMarkBuffer();
  layMark(marks, 0.4, 0.2, 0.1);
  const once = markAt(marks, 0.4, 0.2);
  layMark(marks, 0.4, 0.2, 0.1);
  assert.ok(markAt(marks, 0.4, 0.2) > once, 'a second pass must deepen the line');
});

test('rubber does not build up forever', () => {
  const marks = createMarkBuffer();
  for (let i = 0; i < 500; i++) layMark(marks, 0.4, 0, 1);
  assert.ok(markAt(marks, 0.4, 0) <= MARK_CEILING);
});

test('the lap wraps, because a lap does', () => {
  const marks = createMarkBuffer();
  layMark(marks, 1.25, 0, 0.5);
  assert.ok(markAt(marks, 0.25, 0) > 0, 't = 1.25 is t = 0.25');
  layMark(marks, -0.25, 0, 0.5);
  assert.ok(markAt(marks, 0.75, 0) > 0, 'and t = -0.25 is t = 0.75');
});

test('a mark is a line across three texels, not a single dot', () => {
  // One texel is 2.9 m long and 19 cm wide, so a single-texel mark reads as a dash.
  const marks = createMarkBuffer();
  layMark(marks, 0.5, 0, 0.4);
  const centre = markAt(marks, 0.5, 0);
  const beside = marks.data[(Math.round((MARK_ACROSS - 1) / 2) + 1) * MARK_ALONG
    + Math.floor(0.5 * MARK_ALONG)];
  assert.ok(centre > 0 && beside > 0, 'the neighbour texel must catch some of it');
  assert.ok(beside < centre, 'but less than the centre');
});

test('marks off the edge of the surface are dropped, not wrapped', () => {
  const marks = createMarkBuffer();
  assert.equal(layMark(marks, 0.5, 1.4, 0.5), false);
  assert.equal(layMark(marks, 0.5, -1.4, 0.5), false);
  assert.equal(markTotal(marks), 0, 'a car in the gravel must not mark the road');
});

test('zero intensity lays nothing', () => {
  const marks = createMarkBuffer();
  assert.equal(layMark(marks, 0.5, 0, 0), false);
  assert.equal(markTotal(marks), 0);
});

test('both edges of the surface can be marked', () => {
  const marks = createMarkBuffer();
  assert.equal(layMark(marks, 0.3, -1, 0.5), true);
  assert.equal(layMark(marks, 0.3, 1, 0.5), true);
  assert.ok(markAt(marks, 0.3, -1) > 0);
  assert.ok(markAt(marks, 0.3, 1) > 0);
});

test('the along-lap axis is the generous one', () => {
  // A circuit is 5.9 km long and 12 m wide, so the resolution that matters is
  // along the lap: 2048 over 5891 m is one sample every 2.9 m.
  assert.ok(MARK_ALONG >= MARK_ACROSS * 8);
  assert.ok(5891 / MARK_ALONG < 4, 'along-lap resolution must be finer than 4 m');
});

test('clearing removes everything', () => {
  const marks = createMarkBuffer();
  layMark(marks, 0.5, 0, 1);
  clearMarks(marks);
  assert.equal(markTotal(marks), 0);
});

test('two nearby lines stay distinguishable — that is what a racing line is', () => {
  const marks = createMarkBuffer();
  // Two wheels 1.6 m apart on a 24 m surface: 0.13 of the normalised half-width.
  layMark(marks, 0.5, -0.067, 0.8);
  layMark(marks, 0.5, 0.067, 0.8);
  const between = markAt(marks, 0.5, 0);
  const onLine = markAt(marks, 0.5, -0.067);
  assert.ok(onLine > 0);
  assert.ok(between < onLine, `the gap between the wheels should be lighter: ${between} vs ${onLine}`);
});
