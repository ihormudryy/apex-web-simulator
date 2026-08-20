import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  radicalInverse, jitterAt, JITTER_PERIOD, HISTORY_WEIGHT,
  clipHistory, expandBox, CLIP_EXPAND,
} from './haltonJitter.js';

test('the radical inverse reflects the digits about the radix point', () => {
  assert.equal(radicalInverse(1, 2), 0.5);
  assert.equal(radicalInverse(2, 2), 0.25);
  assert.equal(radicalInverse(3, 2), 0.75);
  assert.ok(Math.abs(radicalInverse(1, 3) - 1 / 3) < 1e-12);
  assert.ok(Math.abs(radicalInverse(2, 3) - 2 / 3) < 1e-12);
  assert.equal(radicalInverse(0, 2), 0);
});

test('every term lands inside the unit interval', () => {
  for (let i = 0; i < 200; i++) {
    for (const base of [2, 3, 5]) {
      const v = radicalInverse(i, base);
      assert.ok(v >= 0 && v < 1, `H(${i}, ${base}) = ${v}`);
    }
  }
});

test('the jitter is centred, so accumulating does not shift the image', () => {
  let sx = 0;
  let sy = 0;
  const out = { x: 0, y: 0 };
  for (let f = 0; f < JITTER_PERIOD; f++) {
    jitterAt(f, out);
    sx += out.x;
    sy += out.y;
  }
  assert.ok(Math.abs(sx / JITTER_PERIOD) < 0.06, `mean x offset ${sx / JITTER_PERIOD}`);
  assert.ok(Math.abs(sy / JITTER_PERIOD) < 0.06, `mean y offset ${sy / JITTER_PERIOD}`);
});

test('the jitter stays inside one pixel', () => {
  const out = { x: 0, y: 0 };
  for (let f = 0; f < 100; f++) {
    jitterAt(f, out);
    assert.ok(Math.abs(out.x) <= 0.5 && Math.abs(out.y) <= 0.5, `frame ${f}: ${out.x}, ${out.y}`);
  }
});

test('no frame takes a zero sample — the sequence is 1-based', () => {
  // Halton's zeroth term is 0 in every base, so a 0-based index would spend one
  // frame in sixteen jittering to the pixel centre and wasting a slot.
  const out = { x: 0, y: 0 };
  for (let f = 0; f < JITTER_PERIOD; f++) {
    jitterAt(f, out);
    assert.ok(Math.hypot(out.x, out.y) > 1e-6, `frame ${f} took no sample`);
  }
});

test('the sequence covers the pixel evenly — no quadrant is starved', () => {
  // This is the property Halton is chosen for, and the reason random offsets are
  // worse: with 16 random samples a quadrant is often empty, and the aliasing
  // survives exactly there.
  const out = { x: 0, y: 0 };
  const quadrants = [0, 0, 0, 0];
  for (let f = 0; f < JITTER_PERIOD; f++) {
    jitterAt(f, out);
    quadrants[(out.x > 0 ? 1 : 0) + (out.y > 0 ? 2 : 0)]++;
  }
  for (const [i, count] of quadrants.entries()) {
    assert.ok(count >= 3, `quadrant ${i} got only ${count} of ${JITTER_PERIOD} samples`);
  }
});

test('the sequence repeats with its stated period', () => {
  const a = jitterAt(3, {});
  const b = jitterAt(3 + JITTER_PERIOD, {});
  assert.deepEqual(a, b);
});

test('successive samples are never nearly on top of each other', () => {
  // The failure mode of random jitter: two samples in almost the same place is a
  // wasted frame, and a gap somewhere else that keeps its aliasing.
  const out = { x: 0, y: 0 };
  const points = [];
  for (let f = 0; f < JITTER_PERIOD; f++) points.push({ ...jitterAt(f, out) });
  let closest = Infinity;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      closest = Math.min(closest, Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y));
    }
  }
  assert.ok(closest > 0.04, `two samples only ${closest.toFixed(4)} px apart`);
});

test('history weight converges in a fraction of a second but forgets a mistake fast', () => {
  assert.ok(HISTORY_WEIGHT > 0.8 && HISTORY_WEIGHT < 0.97, `${HISTORY_WEIGHT}`);
  // Frames for an error to decay to 10% of itself.
  const frames = Math.log(0.1) / Math.log(HISTORY_WEIGHT);
  assert.ok(frames < 80, `a wrong pixel would linger ${frames.toFixed(0)} frames`);
  assert.ok(frames > 8, 'and it must accumulate long enough to be worth doing');
});

test('history clipping rejects a value outside the neighbourhood', () => {
  assert.equal(clipHistory(5, 0, 1), 1);
  assert.equal(clipHistory(-5, 0, 1), 0);
  assert.equal(clipHistory(0.4, 0, 1), 0.4);
});

test('the clip box is widened, so thin edges are not clamped away', () => {
  const { min, max } = expandBox(0.2, 0.8);
  assert.ok(min < 0.2 && max > 0.8, 'the box must grow');
  const grown = (max - min) / 0.6;
  assert.ok(Math.abs(grown - (1 + CLIP_EXPAND)) < 1e-9);
  assert.ok(CLIP_EXPAND > 0.05 && CLIP_EXPAND < 0.4, 'and not by so much it stops clipping');
});

test('a degenerate box stays degenerate', () => {
  const { min, max } = expandBox(0.5, 0.5);
  assert.equal(min, 0.5);
  assert.equal(max, 0.5);
});
