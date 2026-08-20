// js/audio/engineTone.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CYLINDERS, MAX_ORDER, firingHz, waveFundamentalHz, orderIndex,
  engineOrderSpectrum, engineVoice, rpmNorm,
  SLEW_UP_RPM_S, SLEW_DOWN_RPM_S, SLEW_SHIFT_RPM_S, SHIFT_WINDOW_S,
} from './engineTone.js';

test('the modelled engine is the 1.6 V6 turbo hybrid the physics is', () => {
  // Was the 2010 mesh's V8. The plan's recommendation is explicit: keep the mesh,
  // adopt modern physics wholesale, switch the voice. Firing order is
  // cylinders/2, so this moves the dominant component from 4th order to 3rd — at
  // 12 000 rpm, 600 Hz rather than 800 — and every exhaust harmonic with it.
  assert.equal(CYLINDERS, 6);
  const firing = CYLINDERS / 2;
  assert.equal(firingHz(15000), (15000 / 60) * firing);
  assert.equal(firingHz(12000), 600);
});

test('the wave fundamental gives half-order resolution', () => {
  // The oscillator runs at rpm/120 so every half engine order is an integer
  // harmonic, which is what lets one PeriodicWave carry the whole spectrum.
  assert.equal(waveFundamentalHz(12000), 100);
  assert.equal(orderIndex(1), 2);
  assert.equal(orderIndex(CYLINDERS / 2), CYLINDERS);   // firing order → integer bin
});

test('the firing order dominates the spectrum', () => {
  const spectrum = engineOrderSpectrum();
  assert.equal(spectrum.length, 2 * MAX_ORDER + 1);
  const firing = orderIndex(CYLINDERS / 2);
  assert.equal(spectrum[firing], 1, 'firing order should be the normalised peak');
  // Its harmonics must each rise above the broadband floor beside them.
  for (let h = 2; h <= 5; h++) {
    const k = orderIndex((CYLINDERS / 2) * h);
    assert.ok(spectrum[k] > spectrum[k - 1] * 3,
      `firing harmonic ${h} (${spectrum[k].toFixed(3)}) buried in floor (${spectrum[k - 1].toFixed(3)})`);
  }
  for (const v of spectrum) assert.ok(Number.isFinite(v) && v >= 0 && v <= 1);
});

test('the spectrum has content between the firing harmonics, not just at them', () => {
  // Pure firing harmonics is an organ; the floor and half orders are the growl.
  //
  // Expressed in firing orders rather than in numbers: 2 and 6 were the half and
  // 1.5x orders of a V8, and stating them as literals meant the test asserted the
  // V8 rather than the engine.
  const spectrum = engineOrderSpectrum();
  const firing = CYLINDERS / 2;
  const between = spectrum[orderIndex(firing * 1.25 + 0.25)];
  assert.ok(between > 0.005, `no inter-order content: ${between}`);
  assert.ok(spectrum[orderIndex(firing / 2)] > 0.1, 'half-firing growl missing');
  assert.ok(spectrum[orderIndex(firing * 1.5)] > 0.1, '1.5x firing content missing');
});

test('load makes it louder and brighter at the same revs', () => {
  const lift = engineVoice({ rpm: 12000, throttle: 0 });
  const full = engineVoice({ rpm: 12000, throttle: 1 });
  assert.ok(full.master > lift.master * 1.3, `${full.master} vs ${lift.master}`);
  assert.ok(full.lowpassHz > lift.lowpassHz + 1500, 'no brightness change with load');
  assert.ok(full.noiseExhaust > lift.noiseExhaust * 1.8, 'exhaust roar should follow load');
});

test('the exhaust-roar band tracks the firing frequency', () => {
  const slow = engineVoice({ rpm: 6000, throttle: 1 });
  const fast = engineVoice({ rpm: 14000, throttle: 1 });
  assert.ok(fast.bandHz > slow.bandHz, 'roar band should rise with revs');
  assert.ok(slow.bandHz >= 500 && fast.bandHz <= 4200, `band out of range: ${slow.bandHz}..${fast.bandHz}`);
});

test('overrun crackle: off-throttle at revs, including under braking, never on power', () => {
  assert.equal(engineVoice({ rpm: 4000, throttle: 0 }).crackleRate, 0, 'no crackle at idle');
  assert.ok(engineVoice({ rpm: 13000, throttle: 0 }).crackleRate > 8, 'lift-off must crackle');
  // Braking lift-off is prime crackle time; the old voice suppressed it.
  assert.ok(engineVoice({ rpm: 13000, throttle: 0, brake: 1 }).crackleRate > 8,
    'crackle must survive braking');
  assert.equal(engineVoice({ rpm: 13000, throttle: 1 }).crackleRate, 0, 'no crackle on power');
});

test('idle is lumpy and smooths out with revs', () => {
  const idle = engineVoice({ rpm: 4000, throttle: 0 });
  const revs = engineVoice({ rpm: 12000, throttle: 0 });
  assert.ok(idle.wobbleRpm > 40, `idle wobble ${idle.wobbleRpm}`);
  assert.ok(revs.wobbleRpm < idle.wobbleRpm * 0.2, 'wobble should vanish at speed');
});

test('a shift transition is an order of magnitude faster than a coasting decay', () => {
  assert.ok(SLEW_SHIFT_RPM_S >= 5 * SLEW_DOWN_RPM_S,
    `shift slew ${SLEW_SHIFT_RPM_S} vs coast ${SLEW_DOWN_RPM_S}`);
  // 3200 rpm of shift drop must complete inside the shift window.
  assert.ok(SLEW_SHIFT_RPM_S * SHIFT_WINDOW_S >= 3200,
    'shift window cannot cover a full inter-gear rpm drop');
  assert.ok(SLEW_UP_RPM_S > 0 && SHIFT_WINDOW_S < 0.2);
});

test('every parameter stays finite and bounded at the extremes', () => {
  for (const rpm of [0, 100, 4000, 15000, 30000]) {
    for (const throttle of [0, 1]) {
      const v = engineVoice({ rpm, throttle, brake: 1 });
      for (const [key, value] of Object.entries(v)) {
        if (typeof value !== 'number') continue;   // `overrun` is a boolean
        assert.ok(Number.isFinite(value), `${key} is ${value} at rpm=${rpm}`);
      }
      assert.ok(v.master >= 0 && v.master <= 0.3, `master ${v.master} at rpm=${rpm}`);
      assert.ok(v.waveHz >= 0 && v.waveHz <= 300, `waveHz ${v.waveHz} at rpm=${rpm}`);
    }
  }
  assert.equal(rpmNorm(4000, 4000, 15000), 0);
  assert.equal(rpmNorm(15000, 4000, 15000), 1);
});
