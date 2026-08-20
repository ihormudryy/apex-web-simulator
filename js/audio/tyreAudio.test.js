import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scrubVoice, loudestScrub, SCRUB_ONSET, SCRUB_SQUEAL_PEAK, SCRUB_FULL_SLIDE,
  SCRUB_HZ_LOW, SCRUB_HZ_PEAK, SCRUB_HZ_SLIDE,
  kerbVoice, KERB_RIB_PITCH, plankVoice, rumble, MZ_REFERENCE,
} from './tyreAudio.js';

// ---------------------------------------------------------------------------
// Scrub
// ---------------------------------------------------------------------------

test('a rolling tyre is silent', () => {
  assert.equal(scrubVoice(0, 5000).gain, 0);
  assert.equal(scrubVoice(SCRUB_ONSET, 5000).gain, 0);
});

test('loudness follows slip POWER, so load matters as much as speed', () => {
  const fastLight = scrubVoice(10, 800).gain;
  const slowHeavy = scrubVoice(2, 7000).gain;
  assert.ok(slowHeavy > fastLight, `${slowHeavy} vs ${fastLight}`);
});

test('pitch RISES toward the limit and FALLS past it', () => {
  // This is the information the channel exists to carry. A squeal that only gets
  // louder tells you there is slip; one that rises and then drops tells you which
  // side of the limit you are on.
  const approaching = scrubVoice(2, 5000).hz;
  const atPeak = scrubVoice(SCRUB_SQUEAL_PEAK, 5000).hz;
  const gone = scrubVoice(SCRUB_FULL_SLIDE, 5000).hz;
  assert.ok(atPeak > approaching, 'pitch must rise as the tyre loads up');
  assert.ok(gone < atPeak, 'and must drop once the whole patch is sliding');
  assert.ok(Math.abs(atPeak - SCRUB_HZ_PEAK) < 1);
});

test('the tonal squeal gives way to a broadband roar in a big slide', () => {
  const edge = scrubVoice(SCRUB_SQUEAL_PEAK, 6000);
  const slide = scrubVoice(SCRUB_FULL_SLIDE, 6000);
  assert.ok(edge.squeal > slide.squeal, 'the squeal must fade as the slide grows');
  assert.ok(slide.noise > slide.squeal, 'and the noise must take over');
});

test('a low-grip surface roars rather than squeals', () => {
  // Grass and gravel have no stick-slip to speak of, and stick-slip is the squeal.
  const tarmac = scrubVoice(3, 5000, 1.85);
  const grass = scrubVoice(3, 5000, 0.40);
  assert.ok(grass.squeal < tarmac.squeal * 0.4, `${grass.squeal} vs ${tarmac.squeal}`);
  assert.ok(grass.noise > tarmac.noise * 0.9, 'the noise floor must stay');
});

test('scrub is bounded whatever it is given', () => {
  for (const [slip, load, mu] of [[1e6, 1e6, 5], [-40, 6000, 1.85], [5, -100, 1.85]]) {
    const v = scrubVoice(slip, load, mu);
    assert.ok(v.gain >= 0 && v.gain <= 1, `gain ${v.gain}`);
    assert.ok(v.hz >= SCRUB_HZ_SLIDE * 0.5 && v.hz <= SCRUB_HZ_PEAK * 1.5, `hz ${v.hz}`);
  }
});

test('the loudest corner is what the driver hears', () => {
  const out = loudestScrub([0, 0, 8, 0.2], [5000, 5000, 6000, 5000], [1.85, 1.85, 1.85, 1.85]);
  assert.ok(out.gain > 0.5, `a sliding rear must be audible: ${out.gain}`);
  const quiet = loudestScrub([0, 0, 0, 0], [5000, 5000, 5000, 5000], [1.85, 1.85, 1.85, 1.85]);
  assert.equal(quiet.gain, 0);
});

test('loudestScrub writes into the object it is given', () => {
  const out = {};
  assert.equal(loudestScrub([3], [5000], [1.85], out), out);
});

// ---------------------------------------------------------------------------
// Kerbs
// ---------------------------------------------------------------------------

test('kerb rattle frequency is the ribs passing under the wheel', () => {
  // Which is a real frequency: riding a kerb slowly is a series of thuds, and
  // riding it fast is a buzz.
  const slow = kerbVoice(true, 10, 4000);
  const fast = kerbVoice(true, 60, 4000);
  assert.ok(Math.abs(slow.rate - 10 / KERB_RIB_PITCH) < 1e-9);
  assert.ok(fast.hz > slow.hz * 3, `${slow.hz} -> ${fast.hz}`);
});

test('a kerb is silent when the car is not on it, or not moving', () => {
  assert.equal(kerbVoice(false, 60, 4000).gain, 0);
  assert.equal(kerbVoice(true, 0, 4000).gain, 0);
});

test('a harder kerb strike is louder', () => {
  assert.ok(kerbVoice(true, 40, 8000).gain > kerbVoice(true, 40, 2000).gain);
  assert.ok(kerbVoice(true, 40, 1e6).gain <= 1);
});

// ---------------------------------------------------------------------------
// Plank
// ---------------------------------------------------------------------------

test('the plank grinds only when it is down and the car is moving', () => {
  assert.equal(plankVoice(0, 80).gain, 0);
  assert.equal(plankVoice(5000, 0).gain, 0);
  assert.ok(plankVoice(5000, 80).gain > 0.3);
});

test('the grind brightens with speed', () => {
  assert.ok(plankVoice(5000, 90).hz > plankVoice(5000, 20).hz);
  assert.ok(plankVoice(1e9, 1e9).gain <= 1);
});

// ---------------------------------------------------------------------------
// Rumble
// ---------------------------------------------------------------------------

test('rumble goes LIGHT as the front axle approaches its limit', () => {
  // Because Mz collapses before Fy does, via pneumatic trail. This is the one
  // channel that can tell a driver the front is about to let go, and dual-rumble
  // is the ceiling the browser offers.
  const working = rumble(MZ_REFERENCE * 0.9, 0, 60);
  const saturated = rumble(MZ_REFERENCE * 0.1, 0, 60);
  assert.ok(working.weak > saturated.weak, 'a loaded front must weigh more');
});

test('surface and impact go to the strong motor, steering load to the weak one', () => {
  const smooth = rumble(100, 0, 80);
  const rough = rumble(100, 1, 80);
  assert.ok(rough.strong > smooth.strong, 'roughness must reach the strong motor');
  assert.ok(Math.abs(rough.weak - smooth.weak) < 1e-9, 'and must not touch the weak one');
});

test('a parked car does not rumble from the surface', () => {
  assert.ok(rumble(0, 1, 0).strong < 0.05);
});

test('both channels are bounded', () => {
  const r = rumble(1e6, 5, 500, 5);
  assert.ok(r.strong <= 1 && r.weak <= 1);
  assert.ok(r.strong >= 0 && r.weak >= 0);
});
