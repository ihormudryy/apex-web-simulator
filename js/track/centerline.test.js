// js/track/centerline.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCenterline } from './centerline.js';
import { SILVERSTONE_WAYPOINTS } from './silverstoneWaypoints.js';

const box = [
  { x: 0, z: 0, halfWidth: 6, runoff: 8 },
  { x: 100, z: 0, halfWidth: 6, runoff: 8 },
  { x: 100, z: 50, halfWidth: 6, runoff: 8 },
  { x: 0, z: 50, halfWidth: 6, runoff: 8 },
];

test('closed loop length is perimeter', () => {
  const c = buildCenterline(box, 400);
  assert.ok(Math.abs(c.length - 300) / 300 < 0.08);
});

test('on-center is tarmac, 7m off is kerb, 20m off is grass', () => {
  const c = buildCenterline(box, 400);
  const mid = c.query(50, 0);
  assert.equal(mid.surface, 'tarmac');
  const kerb = c.query(50, 6.5);
  assert.equal(kerb.surface, 'kerb');
  const grass = c.query(50, 20);
  assert.equal(grass.surface, 'grass');
  assert.ok(grass.wallLimit > 10);
});

test('lateral positive is right of +X travel on bottom edge', () => {
  const c = buildCenterline(box, 400);
  const left = c.query(50, 6.5);
  assert.ok(left.lateral < 0, 'left of travel should be negative lateral');
  const right = c.query(50, -6.5);
  assert.ok(right.lateral > 0, 'right of travel should be positive lateral');
});

test('Silverstone GP length is 5.891 km ± 5%', () => {
  const c = buildCenterline(SILVERSTONE_WAYPOINTS, 4000);
  assert.ok(c.length > 5596 && c.length < 6186, `length ${c.length}`);
});

test('Silverstone Hamilton Straight has continuous spawn tangents', () => {
  const n = SILVERSTONE_WAYPOINTS.length;
  const last = SILVERSTONE_WAYPOINTS[n - 1];
  const ham = SILVERSTONE_WAYPOINTS[0];
  const abb = SILVERSTONE_WAYPOINTS[1];
  const unit = (a, b) => {
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    return { x: dx / len, z: dz / len };
  };
  const tIn = unit(last, ham);
  const tOut = unit(ham, abb);
  const dot = tIn.x * tOut.x + tIn.z * tOut.z;
  assert.ok(dot > 0.99, `spawn tangent dot ${dot}`);
});

test('Silverstone ring has no tangent reversals', () => {
  const c = buildCenterline(SILVERSTONE_WAYPOINTS, 4000);
  for (let i = 0; i < c.samples.length; i++) {
    const a = c.samples[i];
    const b = c.samples[(i + 1) % c.samples.length];
    const dot = a.tx * b.tx + a.tz * b.tz;
    // The parked 21-waypoint, piecewise-linear design has intentional corner
    // kinks below 0.9. Until I2 adds curve vertices, reject every reversal.
    assert.ok(dot > 0, `tangent reversal at sample ${i}: dot=${dot}`);
  }
});

test('Silverstone distant sections stay more than a track width apart', () => {
  const c = buildCenterline(SILVERSTONE_WAYPOINTS, 2000);
  const spacing = c.length / c.samples.length;
  const maxHalfWidth = Math.max(...c.samples.map(s => s.halfWidth));
  const neighborhood = Math.ceil(60 / spacing);
  let minDistance = Infinity;

  for (let i = 0; i < c.samples.length; i++) {
    for (let j = i + 1; j < c.samples.length; j++) {
      const ringGap = Math.min(j - i, c.samples.length - (j - i));
      if (ringGap <= neighborhood) continue;
      const a = c.samples[i];
      const b = c.samples[j];
      minDistance = Math.min(minDistance, Math.hypot(a.x - b.x, a.z - b.z));
    }
  }

  assert.ok(minDistance > 2 * maxHalfWidth,
    `minimum self-approach ${minDistance} <= ${2 * maxHalfWidth}`);
});
