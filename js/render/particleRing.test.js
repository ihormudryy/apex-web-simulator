import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRing, emit, advance, liveCount, PARKED,
  createBudget, takeBudget, MAX_PER_FRAME,
} from './particleRing.js';

test('a fresh ring is empty and parked out of sight', () => {
  const ring = createRing({ count: 8 });
  assert.equal(liveCount(ring), 0);
  for (let i = 0; i < 8; i++) assert.equal(ring.positions[i * 3], PARKED);
});

test('emitting makes a particle live at the position given', () => {
  const ring = createRing({ count: 8 });
  emit(ring, 1, 2, 3, 0, 0, 0, 1, 1);
  assert.equal(liveCount(ring), 1);
  assert.deepEqual([ring.positions[0], ring.positions[1], ring.positions[2]], [1, 2, 3]);
  assert.equal(ring.alphas[0], 1);
});

test('particles move by their velocity', () => {
  const ring = createRing({ count: 4 });
  emit(ring, 0, 0, 0, 10, 0, -5, 10, 1);
  advance(ring, 0.1);
  assert.ok(Math.abs(ring.positions[0] - 1) < 1e-5, `x ${ring.positions[0]}`);
  assert.ok(Math.abs(ring.positions[2] + 0.5) < 1e-5, `z ${ring.positions[2]}`);
});

test('gravity is signed — sparks fall, smoke rises', () => {
  const rising = createRing({ count: 2, gravity: 2 });
  const falling = createRing({ count: 2, gravity: -14 });
  emit(rising, 0, 0, 0, 0, 0, 0, 5, 1);
  emit(falling, 0, 0, 0, 0, 0, 0, 5, 1);
  advance(rising, 0.2);
  advance(falling, 0.2);
  assert.ok(rising.positions[1] > 0, 'positive gravity must rise');
  assert.ok(falling.positions[1] < 0, 'negative gravity must fall');
});

test('drag is an exact exponential, so a long frame cannot invert a velocity', () => {
  // The explicit form `v -= drag*v*dt` goes unstable once drag*dt > 2, and a smoke
  // plume that reverses because somebody dropped a frame is a memorable bug.
  const ring = createRing({ count: 2, drag: 20 });
  emit(ring, 0, 0, 0, 10, 0, 0, 100, 1);
  advance(ring, 0.5);            // drag*dt = 10
  assert.ok(ring.velocities[0] > 0, `velocity inverted to ${ring.velocities[0]}`);
  assert.ok(ring.velocities[0] < 10, 'and must have decayed');
});

test('particles fade over their lifetime and die at the end of it', () => {
  const ring = createRing({ count: 2 });
  emit(ring, 0, 0, 0, 0, 0, 0, 1, 1);
  advance(ring, 0.5);
  assert.ok(Math.abs(ring.alphas[0] - 0.5) < 1e-6, `alpha ${ring.alphas[0]}`);
  advance(ring, 0.6);
  assert.equal(liveCount(ring), 0);
  assert.equal(ring.alphas[0], 0);
  assert.equal(ring.sizes[0], 0, 'a dead particle must cost no fill');
  assert.equal(ring.positions[1], PARKED);
});

test('the ring recycles oldest-first and never grows', () => {
  const ring = createRing({ count: 4 });
  for (let i = 0; i < 10; i++) emit(ring, i, 0, 0, 0, 0, 0, 10, 1);
  assert.equal(liveCount(ring), 4);
  // The last four emitted are what survives: 6, 7, 8, 9.
  const xs = [...Array(4)].map((_, i) => ring.positions[i * 3]).sort((a, b) => a - b);
  assert.deepEqual(xs, [6, 7, 8, 9]);
});

test('advancing a zero or negative dt does nothing', () => {
  const ring = createRing({ count: 2 });
  emit(ring, 0, 0, 0, 5, 0, 0, 1, 1);
  advance(ring, 0);
  advance(ring, -1);
  assert.equal(ring.positions[0], 0);
});

test('a fractional emission rate still emits, eventually', () => {
  // Without carrying the remainder, any rate under one particle a frame rounds to
  // zero — and that is most of the time, and exactly where a subtle effect earns
  // its keep. A wisp from a tyre just starting to slide is the useful part.
  const budget = createBudget();
  let total = 0;
  for (let f = 0; f < 60; f++) total += takeBudget(budget, 0.2);
  assert.ok(total >= 11 && total <= 12, `0.2 per frame over 60 frames gave ${total}`);
});

test('the budget is capped, so a long frame cannot empty the ring', () => {
  const budget = createBudget();
  assert.equal(takeBudget(budget, 10000), MAX_PER_FRAME);
});

test('a zero rate emits nothing and accrues nothing', () => {
  const budget = createBudget();
  assert.equal(takeBudget(budget, 0), 0);
  assert.equal(takeBudget(budget, -5), 0);
  assert.equal(budget.debt, 0);
});
