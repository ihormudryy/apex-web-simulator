import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NDC_TO_UV, MAX_STREAK_UV, MOTION_BLUR_SAMPLES, BLOOM_INPUT_CLAMP,
  CINEMATIC_DEFAULTS, CINEMATIC_SLIDERS, CINEMATIC_TOGGLES,
  FOCUS_MIN, FOCUS_MAX,
  ndcVelocityToUv, clampStreak, focusDistanceFor,
  cinematicFeatures, featuresEqual,
} from './cinematicState.js';

test('velocity conversion halves the scale and flips Y', () => {
  // three's velocity MRT is an NDC delta (screen spans 2, +Y up); motionBlur
  // offsets UVs (screen spans 1, +Y down). TRAANode does mul(vec2(0.5,-0.5))
  // with the same buffer — this is that constant, pinned so it cannot drift.
  assert.equal(NDC_TO_UV, 0.5);
  const v = ndcVelocityToUv(0.2, 0.2);
  assert.ok(Math.abs(v.x - 0.1) < 1e-12, 'x is halved');
  assert.ok(Math.abs(v.y + 0.1) < 1e-12, 'y is halved AND negated');
  // A pan of the full screen width in one frame is a streak of one full UV.
  const full = ndcVelocityToUv(2, 0);
  assert.ok(Math.abs(full.x - 1) < 1e-12);
});

test('velocity strength scales the streak linearly', () => {
  const a = ndcVelocityToUv(0.1, -0.04, 1);
  const b = ndcVelocityToUv(0.1, -0.04, 2.5);
  assert.ok(Math.abs(b.x - a.x * 2.5) < 1e-12);
  assert.ok(Math.abs(b.y - a.y * 2.5) < 1e-12);
  const off = ndcVelocityToUv(0.1, -0.04, 0);
  assert.equal(off.x, 0);
  assert.equal(off.y, 0);
});

test('streaks clamp in length but never change direction', () => {
  // The reset frame: previous-frame matrices describe somewhere else, so the
  // raw velocity is enormous. Without the clamp the whole frame smears once.
  const huge = clampStreak(3, 4);                       // length 5
  const len = Math.hypot(huge.x, huge.y);
  assert.ok(Math.abs(len - MAX_STREAK_UV) < 1e-12, `clamped to ${len}`);
  assert.ok(Math.abs(huge.x / huge.y - 3 / 4) < 1e-12, 'direction preserved');

  const small = clampStreak(0.001, 0.002);
  assert.equal(small.x, 0.001, 'short streaks pass through untouched');
  assert.equal(small.y, 0.002);

  const zero = clampStreak(0, 0);
  assert.equal(zero.x, 0);
  assert.equal(zero.y, 0);
});

test('focus distance is the camera-to-car distance, clamped', () => {
  const d = focusDistanceFor({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0 });
  assert.equal(d, 5);
  // Chase camera sits ~5.2 m back: a plausible focus plane, not clamped.
  assert.ok(focusDistanceFor({ x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 5.2 }) === 5.2);
  assert.equal(focusDistanceFor({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }), FOCUS_MIN);
  assert.equal(focusDistanceFor({ x: 0, y: 0, z: 0 }, { x: 1e6, y: 0, z: 0 }), FOCUS_MAX);
  assert.equal(focusDistanceFor({ x: NaN, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }), FOCUS_MIN);
});

test('defaults sit inside their own slider ranges', () => {
  for (const [key, range] of Object.entries(CINEMATIC_SLIDERS)) {
    const v = CINEMATIC_DEFAULTS[key];
    assert.equal(typeof v, 'number', `${key} has a numeric default`);
    assert.ok(v >= range.min && v <= range.max, `${key}=${v} outside ${range.min}..${range.max}`);
  }
  for (const key of CINEMATIC_TOGGLES) {
    assert.equal(typeof CINEMATIC_DEFAULTS[key], 'boolean', `${key} default is a bool`);
  }
});

test('bloom threshold is an HDR threshold, above diffuse white', () => {
  // Upstream of ACES, so 1.0 is a fully lit white surface. Below that the
  // whole sky blooms and the image turns to soup.
  assert.ok(CINEMATIC_DEFAULTS.bloomThreshold >= 1,
    `threshold ${CINEMATIC_DEFAULTS.bloomThreshold} would bloom ordinary diffuse white`);
});

test('the bloom input is clamped above the threshold but far below the sun', () => {
  // The shipped HDRI: sky median 0.35, p99 2.1, sun disc 72559. Bloom's
  // high-pass passes the whole value, so without a clamp the sun washes the
  // frame white — measured, even at a threshold of 3. The clamp has to sit
  // above the threshold (or nothing blooms at all) and far below the sun.
  assert.ok(BLOOM_INPUT_CLAMP > CINEMATIC_DEFAULTS.bloomThreshold,
    'a clamp at or below the threshold would admit no bloom at all');
  assert.ok(BLOOM_INPUT_CLAMP < 100, `${BLOOM_INPUT_CLAMP} is close enough to the sun to wash the frame`);
  // Must also stay above the sky's 99th percentile, or ordinary sky clips.
  assert.ok(BLOOM_INPUT_CLAMP > 2.1, 'clamping below the sky p99 would flatten the sky');
});

test('depth of field is off by default — it is a replay effect', () => {
  assert.equal(CINEMATIC_DEFAULTS.dof, false);
  assert.equal(CINEMATIC_DEFAULTS.motionBlur, true);
  assert.equal(CINEMATIC_DEFAULTS.bloom, true);
});

test('motion blur uses enough taps to blur rather than ghost', () => {
  assert.ok(MOTION_BLUR_SAMPLES >= 8, `${MOTION_BLUR_SAMPLES} taps ghosts on a fast pan`);
});

test('a lens flare cannot outlive the bloom it is generated from', () => {
  // LensflareNode takes the bloom texture as its input, so flare-without-bloom
  // is not a state the graph can represent.
  const f = cinematicFeatures({ bloom: false, flare: true });
  assert.equal(f.flare, false);
  assert.equal(cinematicFeatures({ bloom: true, flare: true }).flare, true);
});

test('features fall back to defaults and compare by graph shape', () => {
  const d = cinematicFeatures({});
  assert.equal(d.motionBlur, CINEMATIC_DEFAULTS.motionBlur);
  assert.equal(d.dof, CINEMATIC_DEFAULTS.dof);

  assert.ok(featuresEqual(cinematicFeatures({}), cinematicFeatures({})));
  assert.ok(!featuresEqual(cinematicFeatures({}), cinematicFeatures({ dof: true })));
  // Sliders are uniforms, not graph shape — they must not force a rebuild.
  assert.ok(featuresEqual(
    cinematicFeatures({ bloomStrength: 0.1 }),
    cinematicFeatures({ bloomStrength: 1.9 }),
  ));
});
