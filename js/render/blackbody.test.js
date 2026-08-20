import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  kelvinToRgb, celsiusToKelvin, glowIntensity, brakeGlow,
  GLOW_THRESHOLD_C, GLOW_FULL_C, KELVIN_OFFSET,
} from './blackbody.js';

test('celsius converts to kelvin', () => {
  assert.ok(Math.abs(celsiusToKelvin(0) - KELVIN_OFFSET) < 1e-9);
  assert.ok(Math.abs(celsiusToKelvin(-KELVIN_OFFSET)) < 1e-9);
});

test('a cool blackbody is red, a hot one is white or bluer', () => {
  const cool = kelvinToRgb(1200);
  assert.ok(cool.r > cool.g && cool.g >= cool.b, `1200 K came out ${JSON.stringify(cool)}`);
  assert.ok(cool.b < 0.05, 'there is no blue in a 1200 K glow');

  const daylight = kelvinToRgb(6500);
  assert.ok(Math.abs(daylight.r - daylight.b) < 0.2, `6500 K should be near white: ${JSON.stringify(daylight)}`);

  const hot = kelvinToRgb(12000);
  assert.ok(hot.b >= hot.r, '12000 K must be blue-biased');
});

test('the colour warms monotonically with temperature', () => {
  let prev = 0;
  for (let k = 1000; k <= 6000; k += 250) {
    const c = kelvinToRgb(k);
    const ratio = c.g / Math.max(c.r, 1e-6);
    assert.ok(ratio >= prev - 1e-6, `green/red fell at ${k} K`);
    prev = ratio;
  }
});

test('every channel stays in range, at any temperature', () => {
  for (const k of [-100, 0, 500, 1000, 3000, 6500, 20000, 1e9]) {
    const c = kelvinToRgb(k);
    for (const key of ['r', 'g', 'b']) {
      assert.ok(c[key] >= 0 && c[key] <= 1, `${key} = ${c[key]} at ${k} K`);
    }
  }
});

test('kelvinToRgb writes into the object it is given', () => {
  const out = { r: 0, g: 0, b: 0 };
  assert.equal(kelvinToRgb(3000, out), out);
});

test('a warm brake disc does not glow, a hot one does', () => {
  assert.equal(glowIntensity(200), 0, 'cold brakes must not glow');
  assert.equal(glowIntensity(GLOW_THRESHOLD_C), 0);
  assert.ok(glowIntensity(700) > 0.1, 'a 700C disc is visibly red');
  assert.ok(glowIntensity(GLOW_FULL_C) >= 1 - 1e-9);
});

test('the glow follows T^4, not a straight line', () => {
  // The disc looks unlit at 400 C and fierce at 900: the temperature does not
  // quite double and the emission goes up fivefold. A linear ramp is badly wrong
  // in the middle of the range, which is where the disc spends its time.
  const mid = (GLOW_THRESHOLD_C + GLOW_FULL_C) / 2;
  const linear = 0.5;
  assert.ok(
    glowIntensity(mid) < linear * 0.8,
    `halfway up the range should be well under half brightness, got ${glowIntensity(mid)}`,
  );
});

test('the glow is monotonic and bounded', () => {
  let prev = -1;
  for (let c = 0; c < 1600; c += 20) {
    const g = glowIntensity(c);
    assert.ok(g >= prev, `glow fell at ${c}C`);
    assert.ok(g <= 1, `glow ${g} exceeds 1 at ${c}C`);
    prev = g;
  }
});

test('brakeGlow is dark and colourless below the threshold', () => {
  const g = brakeGlow(300);
  assert.equal(g.intensity, 0);
  assert.equal(g.r, 0);
  assert.equal(g.g, 0);
  assert.equal(g.b, 0);
});

test('a glowing disc is deep orange-red, which is what 1200 K looks like', () => {
  const g = brakeGlow(900);
  assert.ok(g.intensity > 0.5);
  assert.ok(g.r > g.g * 2, `a 900C disc must be red-dominant: ${JSON.stringify(g)}`);
  assert.ok(g.b < 0.1, 'and must have essentially no blue');
});

test('brakeGlow writes into the object it is given', () => {
  const out = { r: 0, g: 0, b: 0, intensity: 0 };
  assert.equal(brakeGlow(800, out), out);
});
