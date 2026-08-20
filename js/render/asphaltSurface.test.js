import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  asphaltSurfacePoint, asphaltSurfaceMap,
  decodeAlbedoMul, decodeRoughMul,
  ALBEDO_MUL_MIN, ALBEDO_MUL_MAX, ROUGH_MUL_MIN, ROUGH_MUL_MAX,
} from './asphaltSurface.js';

/** Mean of `pick` over a lateral band, sampled right round the lap. */
function bandMean(latFrom, latTo, pick, lapLength = 5900, steps = 400) {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < steps; i++) {
    const along = (i / steps) * lapLength;
    for (let j = 0; j <= 8; j++) {
      sum += pick(asphaltSurfacePoint(latFrom + (latTo - latFrom) * (j / 8), along));
      n++;
    }
  }
  return sum / n;
}

test('the racing line is darker than the rest of the track', () => {
  // Rubber laid down over a season is the strongest single cue that a circuit
  // is used rather than freshly modelled.
  const online = bandMean(-0.2, 0.2, p => p.albedo);
  const offline = bandMean(0.75, 1.0, p => p.albedo);
  assert.ok(online < offline * 0.85,
    `line not dark enough: ${online.toFixed(3)} on-line vs ${offline.toFixed(3)} off-line`);
});

test('the racing line is polished and the marbles are rough', () => {
  const online = bandMean(-0.2, 0.2, p => p.roughness);
  const offline = bandMean(0.75, 1.0, p => p.roughness);
  assert.ok(online < offline * 0.9,
    `line should be smoother: ${online.toFixed(3)} vs ${offline.toFixed(3)}`);
  assert.ok(offline > 1, 'off-line asphalt should be rougher than nominal');
});

test('rubber sits on the line and not at the edges', () => {
  assert.ok(bandMean(-0.15, 0.15, p => p.rubber) > 0.6, 'no rubber on the line');
  assert.ok(bandMean(0.85, 1.0, p => p.rubber) < 0.1, 'rubber should not reach the edges');
});

test('the surface varies along the lap, not just across it', () => {
  // A map that only varies with lateral position turns the whole circuit into
  // one extruded cross-section — every corner identical to every straight.
  const at = along => asphaltSurfacePoint(0.35, along).albedo;
  const samples = [];
  for (let i = 0; i < 300; i++) samples.push(at((i / 300) * 5900));
  const spread = Math.max(...samples) - Math.min(...samples);
  assert.ok(spread > 0.12, `almost no variation around the lap: spread ${spread.toFixed(3)}`);
});

test('there is a paving seam, local and dark', () => {
  const along = 900;
  const onSeam = asphaltSurfacePoint(0.5, along).albedo;
  const beside = asphaltSurfacePoint(0.62, along).albedo;
  assert.ok(onSeam < beside * 0.92, `seam not visible: ${onSeam.toFixed(3)} vs ${beside.toFixed(3)}`);
});

test('encoded bytes round-trip and use most of the range', () => {
  const { data, width, height } = asphaltSurfaceMap({ width: 256, height: 32, lapLength: 5900 });
  assert.equal(data.length, 256 * 32 * 4);
  let aLo = 255, aHi = 0, rLo = 255, rHi = 0;
  for (let i = 0; i < data.length; i += 4) {
    aLo = Math.min(aLo, data[i]); aHi = Math.max(aHi, data[i]);
    rLo = Math.min(rLo, data[i + 1]); rHi = Math.max(rHi, data[i + 1]);
    assert.equal(data[i + 3], 255);
  }
  // Clipped hard against either end would mean the encode range is wrong and
  // real variation is being flattened.
  assert.ok(aHi - aLo > 140, `albedo channel uses only ${aHi - aLo} of 255`);
  assert.ok(rHi - rLo > 90, `roughness channel uses only ${rHi - rLo} of 255`);
  assert.ok(aLo > 0 && aHi < 255, `albedo clipped at ${aLo}..${aHi}`);
  assert.ok(rLo > 0 && rHi < 255, `roughness clipped at ${rLo}..${rHi}`);

  // A decoded midpoint must land where the profile says it should.
  const lat = ((16 + 0.5) / 32) * 2 - 1;
  const along = ((128 + 0.5) / 256) * 5900;
  const p = asphaltSurfacePoint(lat, along);
  const o = (16 * 256 + 128) * 4;
  assert.ok(Math.abs(decodeAlbedoMul(data[o]) - p.albedo) < 0.01,
    `albedo round-trip off: ${decodeAlbedoMul(data[o])} vs ${p.albedo}`);
  assert.ok(Math.abs(decodeRoughMul(data[o + 1]) - p.roughness) < 0.01);
});

test('multipliers stay inside the encodable range everywhere', () => {
  for (let i = 0; i <= 120; i++) {
    const along = (i / 120) * 5900;
    for (let j = -10; j <= 10; j++) {
      const p = asphaltSurfacePoint(j / 10, along);
      assert.ok(p.albedo >= ALBEDO_MUL_MIN && p.albedo <= ALBEDO_MUL_MAX,
        `albedo ${p.albedo.toFixed(3)} outside [${ALBEDO_MUL_MIN}, ${ALBEDO_MUL_MAX}] at lat ${j / 10}`);
      assert.ok(p.roughness >= ROUGH_MUL_MIN && p.roughness <= ROUGH_MUL_MAX,
        `roughness ${p.roughness.toFixed(3)} outside range at lat ${j / 10}`);
    }
  }
});
