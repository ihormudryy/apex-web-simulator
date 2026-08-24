import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createQualityScaler, stepQualityScaler, setQualityManual, QUALITY_SCALER,
} from './qualityScaler.js';

/** Drive `seconds` of identical `frameMs` samples through the scaler. */
function feed(scaler, frameMs, seconds) {
  const dt = frameMs / 1000;
  let last = { preset: scaler.preset, changed: false, reason: 'none' };
  let lastChange = last;
  for (let t = 0; t < seconds - 1e-9; t += dt) {
    last = stepQualityScaler(scaler, frameMs);
    if (last.changed) lastChange = last;
  }
  return { ...last, lastChange };
}

test('starts at Ultra and stays there when the frame is comfortably under budget', () => {
  const s = createQualityScaler({ warmupS: 0 });
  assert.equal(s.preset, 'ultra');
  const out = feed(s, 12, QUALITY_SCALER.upHoldS + 1);
  assert.equal(out.preset, 'ultra');
  assert.equal(out.changed, false);
});

test('sustained over-budget frames step Ultra down to High', () => {
  const s = createQualityScaler({ warmupS: 0, cooldownS: 8 });
  const out = feed(s, QUALITY_SCALER.downMs + 6, QUALITY_SCALER.downHoldS + 0.4);
  assert.equal(out.preset, 'high');
  assert.equal(out.lastChange.changed, true);
  assert.equal(out.lastChange.reason, 'down');
});

test('a single hitch does not drop quality', () => {
  const s = createQualityScaler({ warmupS: 0 });
  feed(s, 12, 0.4);
  const hitch = stepQualityScaler(s, QUALITY_SCALER.downMs + 10);
  assert.equal(hitch.preset, 'ultra');
  assert.equal(hitch.changed, false);
});

test('tab-switch stalls are ignored', () => {
  const s = createQualityScaler({ warmupS: 0, cooldownS: 0 });
  feed(s, 12, 0.3);
  for (let i = 0; i < 20; i++) stepQualityScaler(s, QUALITY_SCALER.stallMs + 40);
  assert.equal(s.preset, 'ultra');
});

test('cooldown blocks an immediate reverse step', () => {
  const s = createQualityScaler({ warmupS: 0, cooldownS: 2 });
  feed(s, QUALITY_SCALER.downMs + 8, QUALITY_SCALER.downHoldS + 1.5);
  assert.equal(s.preset, 'high');
  // Fast frames during cooldown must not climb back to Ultra.
  const during = feed(s, 10, 1.2);
  assert.equal(during.preset, 'high');
});

test('recovers High to Ultra after sustained headroom past cooldown', () => {
  const s = createQualityScaler({ warmupS: 0, cooldownS: 0.25 });
  feed(s, QUALITY_SCALER.downMs + 8, QUALITY_SCALER.downHoldS + 0.12);
  assert.equal(s.preset, 'high');
  const up = feed(s, QUALITY_SCALER.upMs - 2, QUALITY_SCALER.cooldownS + QUALITY_SCALER.upHoldS + 1);
  assert.equal(up.preset, 'ultra');
  assert.equal(up.lastChange.reason, 'up');
});

test('will not drop below Balanced', () => {
  const s = createQualityScaler({ preset: 'balanced', warmupS: 0, cooldownS: 0 });
  feed(s, 40, QUALITY_SCALER.downHoldS + 1);
  assert.equal(s.preset, 'balanced');
});

test('warmup ignores expensive shader-compile frames', () => {
  const s = createQualityScaler({ warmupS: 2, cooldownS: 0 });
  feed(s, 40, 1.5);
  assert.equal(s.preset, 'ultra');
});

test('manual Q sets the preset and pauses auto long enough to stick', () => {
  const s = createQualityScaler({ warmupS: 0, cooldownS: 0 });
  setQualityManual(s, 'balanced');
  assert.equal(s.preset, 'balanced');
  const held = feed(s, 10, QUALITY_SCALER.manualHoldS * 0.5);
  assert.equal(held.preset, 'balanced');
});

test('auto stays off when created with auto:false', () => {
  const s = createQualityScaler({ auto: false, warmupS: 0 });
  feed(s, 40, 3);
  assert.equal(s.preset, 'ultra');
});

test('a hitch during manual hold does not burn the remaining pause', () => {
  const s = createQualityScaler({ warmupS: 0 });
  setQualityManual(s, 'ultra');
  const before = s.cooldownS;
  stepQualityScaler(s, 5000);
  assert.equal(s.preset, 'ultra');
  assert.ok(s.cooldownS >= before - 0.05, `cooldown burned to ${s.cooldownS}`);
});
