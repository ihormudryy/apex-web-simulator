import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toneCurve, applyGrade, TOE_LIFT, TOE_RANGE, SHOULDER, SHOULDER_FROM,
  SATURATION, TONE_CURVE_GLSL,
  crushedFraction, clippedFraction, histogramContrast, gradeHistogram,
} from './grading.js';

/** A histogram shaped like the frame the dashboard actually measures. */
function measuredFrame() {
  const h = new Float64Array(256);
  for (let i = 0; i < 256; i++) h[i] = 200 * Math.exp(-((i - 125) ** 2) / (2 * 60 * 60));
  // The fault: a spike of dead black in the shadows.
  for (let i = 0; i <= 5; i++) h[i] += 700;
  return h;
}

test('the curve lifts the toe off the floor', () => {
  assert.ok(toneCurve(0) > 5 / 255, `black came out at ${toneCurve(0) * 255}/255`);
  assert.ok(toneCurve(0) < 16 / 255, 'but must not become grey');
});

test('the midtones are left alone', () => {
  // The mean luminance and the saturation both measure inside target already, and
  // a curve that moves them to fix the shadows has traded one fault for two.
  for (const v of [0.25, 0.4, 0.5, 0.6, 0.7]) {
    assert.ok(Math.abs(toneCurve(v) - v) < 1e-9, `${v} moved to ${toneCurve(v)}`);
  }
});

test('the toe lift fades out smoothly, with no visible join', () => {
  // A linear decay leaves a kink at the join, and a kink in a tone curve is a
  // visible band in a gradient — which a sky is.
  const slope = v => (toneCurve(v + 1e-4) - toneCurve(v - 1e-4)) / 2e-4;
  const before = slope(TOE_RANGE - 0.01);
  const after = slope(TOE_RANGE + 0.01);
  assert.ok(Math.abs(before - after) < 0.25, `slope jumps ${before} -> ${after} at the join`);
});

test('the curve is monotonic — no tone is mapped below a darker one', () => {
  let prev = -1;
  for (let i = 0; i <= 255; i++) {
    const v = toneCurve(i / 255);
    assert.ok(v >= prev - 1e-12, `curve fell at ${i}`);
    prev = v;
  }
});

test('the curve stays in range, including outside it', () => {
  for (const v of [-1, -0.001, 0, 0.5, 1, 1.001, 100]) {
    const out = toneCurve(v);
    assert.ok(out >= 0 && out <= 1, `${v} -> ${out}`);
  }
});

test('the shoulder pulls the very top down a little', () => {
  assert.ok(toneCurve(1) < 1, 'pure white must come down slightly');
  assert.ok(toneCurve(1) > 0.9, 'but not far');
  assert.ok(toneCurve(SHOULDER_FROM - 0.01) > SHOULDER_FROM - 0.011, 'and not below the knee');
});

test('it fixes the fault it was written for', () => {
  const before = measuredFrame();
  const after = gradeHistogram(before);
  const crushedBefore = crushedFraction(before);
  const crushedAfter = crushedFraction(after);
  assert.ok(crushedBefore > 4, `the test frame must have the fault: ${crushedBefore}%`);
  assert.ok(crushedAfter < 2, `still ${crushedAfter.toFixed(2)}% crushed after grading`);
});

test('and does not break what was already correct', () => {
  const before = measuredFrame();
  const after = gradeHistogram(before);
  // The dashboard's other tonal targets: contrast >= 90, clipped <= 1.5%.
  assert.ok(histogramContrast(after) >= 90, `contrast fell to ${histogramContrast(after)}`);
  assert.ok(
    histogramContrast(after) > histogramContrast(before) * 0.9,
    'and must not flatten the frame to fix the shadows',
  );
  assert.ok(clippedFraction(after) <= 1.5, `clipped ${clippedFraction(after)}%`);
});

test('saturation is a nudge, not a push', () => {
  assert.ok(SATURATION > 1 && SATURATION < 1.2, `${SATURATION}`);
  const grey = applyGrade(0.4, 0.4, 0.4);
  assert.ok(Math.abs(grey.r - grey.g) < 1e-9, 'grey must stay grey');
  const red = applyGrade(0.6, 0.2, 0.2);
  assert.ok(red.r > red.g, 'and colour must stay coloured');
});

test('grading preserves neutrality across the range', () => {
  for (const v of [0, 0.1, 0.5, 0.9, 1]) {
    const out = applyGrade(v, v, v);
    assert.ok(Math.abs(out.r - out.b) < 1e-9, `neutral ${v} took a tint`);
  }
});

test('applyGrade writes into the object it is given', () => {
  const out = { r: 0, g: 0, b: 0 };
  assert.equal(applyGrade(0.3, 0.4, 0.5, out), out);
});

test('the GLSL is generated from the same constants as the JS', () => {
  // One definition, so the shader and the measurement cannot disagree — which is
  // the whole reason the curve is chosen by measurement rather than by eye.
  assert.ok(TONE_CURVE_GLSL.includes(String(TOE_LIFT)));
  assert.ok(TONE_CURVE_GLSL.includes(String(TOE_RANGE)));
  assert.ok(TONE_CURVE_GLSL.includes(String(SHOULDER)));
  assert.ok(TONE_CURVE_GLSL.includes(String(SHOULDER_FROM)));
  assert.ok(!TONE_CURVE_GLSL.includes('`'), 'a backtick here would end the literal');
});

test('the histogram helpers agree with the dashboard definitions', () => {
  const h = new Float64Array(256);
  h[0] = 10;
  h[255] = 10;
  h[128] = 80;
  assert.ok(Math.abs(crushedFraction(h) - 10) < 1e-9);
  assert.ok(Math.abs(clippedFraction(h) - 10) < 1e-9);
  assert.equal(histogramContrast(new Float64Array(256)), 0, 'an empty histogram is not a crash');
});
