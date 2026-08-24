import { test } from 'node:test';
import assert from 'node:assert/strict';
import { smokeAlpha, smokeSizeScale, smokePuff, softParticleFade } from './smokeLook.js';

test('smoke alpha fades in and out softly', () => {
  assert.ok(smokeAlpha(0) < 0.05);
  assert.ok(smokeAlpha(0.08) > smokeAlpha(0.02));
  assert.ok(smokeAlpha(0.35) > 0.7);
  assert.ok(smokeAlpha(0.85) < smokeAlpha(0.5));
  assert.ok(smokeAlpha(1) < 0.05);
});

test('smoke size grows over life', () => {
  assert.equal(smokeSizeScale(0, 2.4), 1);
  assert.ok(smokeSizeScale(0.5, 2.4) > 1.5);
  assert.ok(Math.abs(smokeSizeScale(1, 2.4) - 2.4) < 1e-9);
});

test('soft particle fade is 1 far from a surface and 0 on it', () => {
  assert.equal(softParticleFade(10, 2, 0.5), 1);
  assert.equal(softParticleFade(2, 2, 0.5), 0);
  assert.ok(softParticleFade(2.25, 2, 0.5) > 0.4);
  assert.ok(softParticleFade(2.25, 2, 0.5) < 0.6);
  assert.equal(softParticleFade(1.5, 2, 0.5), 0);
});

test('soft particle fade stays visible when scene depth is missing', () => {
  assert.equal(softParticleFade(NaN, 4, 0.5), 1);
  assert.equal(softParticleFade(0, 4, 0.5), 1);
  assert.equal(softParticleFade(8, 4, 0), 1);
});

test('smoke puff recipes stay finite and positive', () => {
  let n = 0;
  const rand = () => {
    n = (n * 1664525 + 1013904223) >>> 0;
    return (n >>> 0) / 0xffffffff;
  };
  for (let k = 0; k < 40; k++) {
    const p = smokePuff(k / 40, rand);
    assert.ok(p.life > 0.5 && p.size > 0.1);
    assert.ok(p.rise > 0 && p.scatter > 0);
  }
});
