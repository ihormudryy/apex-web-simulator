import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  beamProfile, reliefAt, armcoAlbedo, armcoNormal, armcoRoughness,
  BOLT_V, SEAM_FRACTION, PANEL_METRES,
} from './barrierMaps.js';

test('the beam profile is a W: two crests and a valley between', () => {
  const crest1 = beamProfile(0.30);
  const valley = beamProfile(0.51);
  const crest2 = beamProfile(0.72);
  assert.ok(crest1 > valley && crest2 > valley, 'crests must stand above the valley');
  assert.ok(crest1 > 0.03 && crest2 > 0.03, 'and be real relief, not noise');
  assert.ok(beamProfile(0) < crest1 * 0.3, 'the edges are rolled away');
  assert.ok(beamProfile(1) < crest2 * 0.3);
});

test('bolts stand proud at the panel seams and nowhere else', () => {
  const atSeam = reliefAt(0.01, BOLT_V[0]);
  const midPanel = reliefAt(0.5, BOLT_V[0]);
  assert.ok(atSeam > midPanel + 0.005, `bolt relief ${(atSeam - midPanel).toFixed(4)} m`);
});

test('the seam lap sits proud of the panel face', () => {
  const seam = reliefAt(SEAM_FRACTION * 0.5, 0.51);
  const face = reliefAt(0.5, 0.51);
  assert.ok(seam > face, 'the overlapping panel end must catch the light');
});

test('the maps are the right shape and deterministic', () => {
  for (const fn of [armcoAlbedo, armcoNormal, armcoRoughness]) {
    const a = fn(64, 32);
    assert.equal(a.length, 64 * 32 * 4);
    assert.deepEqual([...a.slice(0, 64)], [...fn(64, 32).slice(0, 64)]);
  }
});

test('the normal map actually carries the corrugation', () => {
  const w = 64;
  const h = 64;
  const n = armcoNormal(w, h);
  // The green channel must swing through the profile: rising into a crest,
  // falling out of it. Sample a column mid-panel.
  let min = 255;
  let max = 0;
  for (let y = 0; y < h; y++) {
    const g = n[(y * w + 32) * 4 + 1];
    min = Math.min(min, g);
    max = Math.max(max, g);
  }
  assert.ok(max - min > 60, `normal green swings only ${max - min} — the beam is flat`);
});

test('weathering knows which way is down', () => {
  const w = 64;
  const h = 64;
  const a = armcoAlbedo(w, h);
  // The bottom rows carry grime: darker than the upper crest rows.
  const rowMean = y => {
    let s = 0;
    for (let x = 0; x < w; x++) s += a[(y * w + x) * 4 + 1];
    return s / w;
  };
  const top = rowMean(Math.round(h * 0.28));       // upper crest region
  const bottom = rowMean(h - 2);                    // bottom edge
  assert.ok(bottom < top - 12, `bottom ${bottom.toFixed(0)} vs crest ${top.toFixed(0)} — no grime gradient`);
});

test('rust lives below the bolts, not above them', () => {
  const w = 128;
  const h = 128;
  const a = armcoAlbedo(w, h);
  // Compare red-vs-blue bias just below and just above the upper bolt at a seam.
  const sample = v => {
    const y = Math.round((1 - v) * (h - 1));
    const i = (y * w + 2) * 4;      // near the seam at u ~ 0.016
    return a[i] - a[i + 2];         // rust is red-shifted
  };
  const below = sample(BOLT_V[1] - 0.12);
  const above = sample(BOLT_V[1] + 0.12);
  assert.ok(below > above, `rust bias below ${below} vs above ${above}`);
});

test('roughness is polished on the crests and matte in the grime', () => {
  const w = 64;
  const h = 64;
  const r = armcoRoughness(w, h);
  const at = v => r[(Math.round((1 - v) * (h - 1)) * w + 32) * 4 + 1];
  assert.ok(at(0.30) < at(0.51), 'a crest is shinier than the valley');
  assert.ok(at(0.05) > at(0.30), 'and the grimy bottom is the most matte of all');
});

test('one tile is one panel, at a size the wall can tile', () => {
  assert.ok(PANEL_METRES >= 3 && PANEL_METRES <= 5);
});
