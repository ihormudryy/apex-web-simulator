import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TUFT_W, TUFT_H, TUFT_PLANES, tuftPlaneGeometryData, tuftClumpTexture,
} from './tuftGeometry.js';

/** The four vertices of plane `p`, as {x,y,z,u,v}. */
function plane(data, p) {
  const out = [];
  for (let i = p * 4; i < p * 4 + 4; i++) {
    out.push({
      x: data.positions[i * 3], y: data.positions[i * 3 + 1], z: data.positions[i * 3 + 2],
      nx: data.normals[i * 3], ny: data.normals[i * 3 + 1], nz: data.normals[i * 3 + 2],
      u: data.uvs[i * 2], v: data.uvs[i * 2 + 1],
    });
  }
  return out;
}

test('every crossed plane samples the full width of the blade texture', () => {
  // The bug this pins: U was derived from world `x`, which is identically 0 for
  // every plane except the x-aligned one. Those planes collapsed to a single
  // texel column — the blade's opaque centre — and rendered as solid slabs.
  const data = tuftPlaneGeometryData();
  for (let p = 0; p < TUFT_PLANES; p++) {
    const us = plane(data, p).map(v => v.u);
    const span = Math.max(...us) - Math.min(...us);
    assert.equal(span, 1, `plane ${p} spans only ${span} of U — it samples one column`);
    assert.deepEqual([...new Set(us)].sort(), [0, 1], `plane ${p} U values: ${us}`);
  }
});

test('planes really are crossed, not stacked', () => {
  const data = tuftPlaneGeometryData();
  const dirs = [];
  for (let p = 0; p < TUFT_PLANES; p++) {
    const vs = plane(data, p);
    // Horizontal axis of the plane, from the two root vertices.
    const dx = vs[1].x - vs[0].x;
    const dz = vs[1].z - vs[0].z;
    const len = Math.hypot(dx, dz);
    assert.ok(len > TUFT_W, `plane ${p} has no horizontal extent`);
    dirs.push([dx / len, dz / len]);
  }
  for (let a = 0; a < dirs.length; a++) {
    for (let b = a + 1; b < dirs.length; b++) {
      const dot = Math.abs(dirs[a][0] * dirs[b][0] + dirs[a][1] * dirs[b][1]);
      assert.ok(dot < 0.9, `planes ${a} and ${b} are nearly parallel (|dot| ${dot.toFixed(2)})`);
    }
  }
});

test('no normal points downward, so tufts are never lit from below', () => {
  // Cards with horizontal normals go black under an overhead sun, and DoubleSide
  // would flip them to face down on the far side. Every normal leans upward.
  const data = tuftPlaneGeometryData();
  for (let i = 0; i < data.normals.length; i += 3) {
    const ny = data.normals[i + 1];
    assert.ok(ny > 0.5, `normal ${i / 3} has ny=${ny.toFixed(3)} — not upward`);
    const len = Math.hypot(data.normals[i], ny, data.normals[i + 2]);
    assert.ok(Math.abs(len - 1) < 1e-5, `normal ${i / 3} not unit length (${len})`);
  }
});

test('each plane carries both windings so FrontSide shows it from either side', () => {
  const data = tuftPlaneGeometryData();
  assert.equal(data.indices.length, TUFT_PLANES * 12, 'expected 4 triangles per plane');
  for (let p = 0; p < TUFT_PLANES; p++) {
    const b = p * 4;
    const tris = [];
    for (let i = 0; i < data.indices.length; i += 3) {
      const t = data.indices.slice(i, i + 3);
      if (t.every(v => v >= b && v < b + 4)) tris.push(t.join(','));
    }
    assert.ok(tris.includes(`${b},${b + 2},${b + 1}`), `plane ${p} missing winding A`);
    assert.ok(tris.includes(`${b},${b + 1},${b + 2}`), `plane ${p} missing winding B`);
  }
});

test('cards stand on the ground and reach the card height', () => {
  const data = tuftPlaneGeometryData();
  const ys = [];
  for (let i = 1; i < data.positions.length; i += 3) ys.push(data.positions[i]);
  assert.equal(Math.min(...ys), 0, 'roots must sit exactly on the runoff plane');
  assert.equal(Math.max(...ys), TUFT_H);
});

test('the clump is several blades, not one triangle', () => {
  const { data, size } = tuftClumpTexture();
  const alphaAt = (x, y) => data[(y * size + x) * 4 + 3];
  // Count separated opaque runs across a row a third of the way up.
  const row = Math.floor(size * 0.33);
  let runs = 0;
  let inRun = false;
  for (let x = 0; x < size; x++) {
    const on = alphaAt(x, row) > 128;
    if (on && !inRun) runs++;
    inRun = on;
  }
  assert.ok(runs >= 3, `expected several distinct blades across the clump, found ${runs}`);
});

test('the clump tapers upward and darkens at the root', () => {
  const { data, size } = tuftClumpTexture();
  const coverage = y => {
    let n = 0;
    for (let x = 0; x < size; x++) if (data[(y * size + x) * 4 + 3] > 128) n++;
    return n;
  };
  const low = coverage(Math.floor(size * 0.1));
  const high = coverage(Math.floor(size * 0.9));
  assert.ok(low > high * 1.5, `no taper: ${low} covered low vs ${high} high`);

  // Green channel, averaged over covered pixels, must rise from root to tip.
  const meanGreen = y => {
    let sum = 0; let n = 0;
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      if (data[o + 3] > 128) { sum += data[o + 1]; n++; }
    }
    return n ? sum / n : 0;
  };
  const root = meanGreen(Math.floor(size * 0.04));
  const mid = meanGreen(Math.floor(size * 0.45));
  assert.ok(mid > root, `root (${root.toFixed(1)}) should be darker than mid (${mid.toFixed(1)})`);
});

test('transparent texels still carry blade colour, so mips never blend to black', () => {
  // Leaving RGB at 0 where alpha is 0 is invisible in the texture and ruinous
  // once minified: linear filtering averages blade colour with black and the
  // tufts render as charcoal spikes at any real distance.
  const { data, size } = tuftClumpTexture();
  let clear = 0;
  let blackClear = 0;
  for (let i = 0; i < size * size; i++) {
    const o = i * 4;
    if (data[o + 3] > 8) continue;
    clear++;
    if (data[o] + data[o + 1] + data[o + 2] === 0) blackClear++;
  }
  assert.ok(clear > 0, 'expected transparent regions to exist at all');
  assert.equal(blackClear, 0, `${blackClear} of ${clear} transparent texels are pure black`);
});
