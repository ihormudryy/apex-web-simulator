import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyImpact, applyScrape, totalDamage, isTerminal,
  damageEffects, createDamageEffects,
  IMPACT_FREE, TERMINAL_TOTAL, WING_CLA_LOSS, WHEEL_GRIP_LOSS, TOE_PULL,
} from './damage.js';
import {
  createState, S_DMG_WING, S_DMG_FLOOR, S_DMG_WHEEL,
} from './state.js';

test('a touch below the free threshold costs nothing', () => {
  const S = createState();
  assert.equal(applyImpact(S, IMPACT_FREE * 0.9, 0), 0);
  assert.equal(totalDamage(S), 0);
});

test('a nose hit takes the wing, a tail hit takes the floor', () => {
  const nose = createState();
  applyImpact(nose, 12, 1);
  assert.ok(nose[S_DMG_WING] > 0, 'nose corner must damage the wing');
  assert.equal(nose[S_DMG_FLOOR], 0);

  const tail = createState();
  applyImpact(tail, 12, 3);
  assert.ok(tail[S_DMG_FLOOR] > 0, 'tail corner must damage the floor');
  assert.equal(tail[S_DMG_WING], 0);
});

test('the impacted corner damages its own suspension', () => {
  const S = createState();
  applyImpact(S, 15, 2);      // tail-left
  assert.ok(S[S_DMG_WHEEL + 2] > 0, 'rear-left suspension');
  assert.equal(S[S_DMG_WHEEL + 1], 0, 'and no other corner');
});

test('damage grows with the square of closing speed — energy, not speed', () => {
  const soft = createState();
  const hard = createState();
  applyImpact(soft, 8, 0);
  applyImpact(hard, 14.5, 0);   // twice the over-threshold speed
  assert.ok(
    hard[S_DMG_WING] > soft[S_DMG_WING] * 3,
    `${hard[S_DMG_WING].toFixed(3)} vs ${soft[S_DMG_WING].toFixed(3)}: doubling the hit must far more than double the bill`,
  );
});

test('a 90 km/h square hit is a wreck, taps accumulate', () => {
  const wreck = createState();
  applyImpact(wreck, 25, 1);
  assert.ok(wreck[S_DMG_WHEEL + 1] >= 1, 'the corner must break outright');
  assert.ok(isTerminal(wreck), 'and the car is finished');

  const taps = createState();
  for (let i = 0; i < 12; i++) applyImpact(taps, 7, 0);
  assert.ok(taps[S_DMG_WING] > 0.2, 'repeated taps must add up');
  assert.ok(!isTerminal(taps) || totalDamage(taps) >= TERMINAL_TOTAL);
});

test('damage saturates at 1 per system', () => {
  const S = createState();
  for (let i = 0; i < 20; i++) applyImpact(S, 30, 0);
  assert.equal(S[S_DMG_WING], 1);
  assert.equal(S[S_DMG_WHEEL], 1);
});

test('scraping sands the floor down slowly', () => {
  const S = createState();
  for (let i = 0; i < 600 * 5; i++) applyScrape(S, 40, 1 / 600);
  assert.ok(S[S_DMG_FLOOR] > 0.1, `five seconds on the wall at 144 km/h: ${S[S_DMG_FLOOR]}`);
  assert.ok(S[S_DMG_FLOOR] < 0.5, 'but a scrape is not a crash');
  assert.equal(applyScrape(S, 0.2, 1 / 600), 0, 'and a parked touch does nothing');
});

test('terminal comes from a broken corner OR the total', () => {
  const corner = createState();
  corner[S_DMG_WHEEL + 3] = 1;
  assert.ok(isTerminal(corner));

  const spread = createState();
  spread[S_DMG_WING] = 1;
  spread[S_DMG_FLOOR] = 1;
  spread[S_DMG_WHEEL] = 0.5;
  assert.equal(isTerminal(spread), totalDamage(spread) >= TERMINAL_TOTAL);

  const healthy = createState();
  assert.equal(isTerminal(healthy), false);
});

test('effects arrive through channels the physics already has', () => {
  const S = createState();
  S[S_DMG_WING] = 1;
  S[S_DMG_FLOOR] = 0.5;
  S[S_DMG_WHEEL + 2] = 0.6;
  const fx = damageEffects(S, createDamageEffects());
  assert.ok(Math.abs(fx.wingScale - (1 - WING_CLA_LOSS)) < 1e-9, 'a dead wing keeps some end-plate load');
  assert.ok(fx.wingScale > 0, 'but never negative lift');
  assert.ok(fx.floorScale < 1 && fx.cdaExtra > 0, 'a broken floor costs load and adds drag');
  assert.ok(Math.abs(fx.gripScale[2] - (1 - WHEEL_GRIP_LOSS * 0.6)) < 1e-9);
  assert.ok(fx.toe[2] > 0, 'a bent left corner pulls');
  assert.ok(fx.toe[3] <= 0 || S[S_DMG_WHEEL + 3] === 0, 'and a right one pulls the other way');
  assert.equal(fx.locked[2], false);
  S[S_DMG_WHEEL + 2] = 1;
  damageEffects(S, fx);
  assert.equal(fx.locked[2], true, 'a broken corner jams its wheel');
});

test('a healthy car has identity effects', () => {
  const fx = damageEffects(createState(), createDamageEffects());
  assert.equal(fx.wingScale, 1);
  assert.equal(fx.floorScale, 1);
  assert.equal(fx.cdaExtra, 0);
  assert.deepEqual(fx.gripScale, [1, 1, 1, 1]);
  assert.equal(fx.terminal, false);
});

test('toe error is a few degrees at worst, not a joke', () => {
  assert.ok(TOE_PULL > 0.01 && TOE_PULL < 0.12, `${TOE_PULL} rad`);
});
