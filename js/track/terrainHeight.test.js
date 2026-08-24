/**
 * The car has to stand on the surface that is drawn under it.
 *
 * The track is a stack of near-coplanar ribbons at slightly different heights,
 * and the road is deliberately the highest of them so the lawn cannot punch
 * through it at distance. That lift is part of the surface, not a decoration:
 * these tests pin the two places it has to agree — the drawn mesh and the
 * height the tyre is placed at.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roadLiftAt } from './Track.js';
import {
  surfaceHeight, groundFieldHeight, meanElevation, KERB_WIDTH, elevationAt,
  groundMeshBias, blendedGroundHeight,
} from './elevation.js';
import { buildCenterline } from './centerline.js';
import { SILVERSTONE_WAYPOINTS } from './silverstoneWaypoints.js';

const cl = buildCenterline(SILVERSTONE_WAYPOINTS, 4000);
const lap = cl.length;
const mean = meanElevation();

/** What `Track._terrainHeight` computes — the height the physics stands on. */
const terrain = q => groundFieldHeight(q, lap, {}, mean) + roadLiftAt(q);

const stationAt = t => {
  const s = cl.samples[Math.round(t * 4000) % 4000];
  return { t: s.t, halfWidth: s.halfWidth, wallLimit: s.halfWidth + s.runoff };
};

test('on the asphalt the tyre stands on the drawn road, not under it', () => {
  // The whole bug: the road mesh is drawn at surfaceHeight + Y_ASPHALT, so the
  // physics has to include that same lift or the car sits inside the tarmac.
  for (const t of [0, 0.13, 0.39, 0.6, 0.915]) {
    const s = stationAt(t);
    for (const lat of [0, 1, 3, s.halfWidth - 0.1]) {
      const q = { ...s, lateral: lat };
      const drawn = surfaceHeight(q, lap, {}) + roadLiftAt(q);
      assert.ok(Math.abs(terrain(q) - drawn) < 1e-9,
        `t=${t} lat=${lat}: physics ${terrain(q)} vs drawn road ${drawn}`);
    }
  }
});

test('the road lift is the same everywhere on the asphalt', () => {
  const s = stationAt(0.3);
  const lift = roadLiftAt({ ...s, lateral: 0 });
  assert.ok(lift >= 0, 'the road is lifted, never sunk');
  for (const lat of [0, 0.5, 2, s.halfWidth]) {
    assert.equal(roadLiftAt({ ...s, lateral: lat }), lift,
      'a lift that varied across the road would tilt the surface');
  }
});

test('the lift ramps out rather than stepping — no phantom kerb strike', () => {
  // A 4 cm step at the white line is a kerb as far as the suspension is
  // concerned. Walk across the transition in 2 cm increments and demand the
  // height never jumps.
  const s = stationAt(0.5);
  let prev = null, worst = 0;
  for (let lat = 0; lat < s.wallLimit + 8; lat += 0.02) {
    const y = roadLiftAt({ ...s, lateral: lat });
    if (prev !== null) worst = Math.max(worst, Math.abs(y - prev));
    prev = y;
  }
  // 2 cm of lateral travel may not move the surface by even a millimetre.
  assert.ok(worst < 0.001, `lift jumps ${(worst * 1000).toFixed(1)} mm in one 2 cm step`);
});

test('past the kerb the lift is gone, so the verge stays flush', () => {
  const s = stationAt(0.2);
  const far = roadLiftAt({ ...s, lateral: s.halfWidth + KERB_WIDTH + 0.001 });
  assert.ok(Math.abs(far) < 1e-9, `runoff carries a ${far} m lift`);
  assert.ok(Math.abs(roadLiftAt({ ...s, lateral: s.wallLimit + 50 })) < 1e-9);
});

test('off the track the car follows the ground that is drawn, not the track edge', () => {
  // `surfaceHeight` extends the track edge outwards forever; the ground grid
  // relaxes toward the profile mean. Where the track is below the mean the old
  // physics sank the car into a rising field, and above it floated the car.
  const low = stationAt(0.915);            // Vale, ~3.2 m — below the 6.25 m mean
  const high = stationAt(0.39);            // Copse, ~12 m — above it
  assert.ok(elevationAt(low.t) < mean && elevationAt(high.t) > mean, 'test picks a dip and a crest');

  for (const s of [low, high]) {
    for (const beyond of [100, 200, 400]) {
      const q = { ...s, lateral: s.wallLimit + beyond };
      const drawnGround = groundFieldHeight(q, lap, {}, mean);
      assert.ok(Math.abs(terrain(q) - drawnGround) < 1e-9,
        `${beyond} m off track: physics ${terrain(q).toFixed(2)} vs ground ${drawnGround.toFixed(2)}`);
      // And it must actually differ from the old behaviour, or this proves nothing.
      const oldWay = surfaceHeight(q, lap, {});
      assert.ok(Math.abs(oldWay - drawnGround) > 0.1,
        `${beyond} m off track the old and new heights agree — no divergence to fix`);
    }
  }
});

test('inside the barriers the change is a no-op beyond the road lift', () => {
  // The guarantee that on-track physics is untouched: within the corridor
  // groundFieldHeight returns surfaceHeight verbatim, so the only difference
  // from the old behaviour is the lift itself.
  for (const t of [0.05, 0.25, 0.45, 0.7, 0.95]) {
    const s = stationAt(t);
    for (const lat of [0, 2, s.halfWidth, s.wallLimit - 0.5]) {
      const q = { ...s, lateral: lat };
      const delta = terrain(q) - surfaceHeight(q, lap, {});
      assert.ok(Math.abs(delta - roadLiftAt(q)) < 1e-9,
        `t=${t} lat=${lat}: unexpected change of ${delta} m`);
    }
  }
});

test('infield lawn blends competing ribbons instead of a rectangular pit', () => {
  // Luffield (~5.9 m) sits ~80 m from Copse (~11.6 m). Nearest-station Voronoi
  // cuts a several-metre cliff through that infield — the leftover rectangular
  // pits. Blend has to walk the same line without the jump.
  const a = cl.samples[1264];
  const b = cl.samples[1530];
  const d = Math.hypot(a.x - b.x, a.z - b.z);
  const dh = Math.abs(elevationAt(a.t) - elevationAt(b.t));
  assert.ok(d > 40 && d < 120 && dh > 4,
    `fixture drifted: ${d.toFixed(1)} m apart, ${dh.toFixed(1)} m elevation`);
  const nearestH = (x, z) => {
    const q = cl.query(x, z, cl.nearestStationIndex(x, z));
    return groundFieldHeight(q, lap, {}, mean);
  };
  let nearestJump = 0, blendJump = 0, prevN = null, prevB = null;
  const steps = 24;
  for (let k = 0; k <= steps; k++) {
    const u = k / steps;
    const x = a.x + (b.x - a.x) * u;
    const z = a.z + (b.z - a.z) * u;
    const n = nearestH(x, z);
    const bl = blendedGroundHeight(cl.samples, x, z, lap, {}, mean);
    if (prevN !== null) nearestJump = Math.max(nearestJump, Math.abs(n - prevN));
    if (prevB !== null) blendJump = Math.max(blendJump, Math.abs(bl - prevB));
    prevN = n;
    prevB = bl;
  }
  assert.ok(nearestJump > 2,
    `fixture should cliff under nearest-station (jumped ${nearestJump.toFixed(2)} m)`);
  assert.ok(blendJump < 1.2,
    `blended infield still jumps ${blendJump.toFixed(2)} m across ${d.toFixed(0)} m`);
});

test('on the asphalt the blended lawn still matches the nearest-station field', () => {
  const s = cl.samples[100];
  const q = cl.query(s.x, s.z, cl.nearestStationIndex(s.x, s.z));
  const nearest = groundFieldHeight(q, lap, {}, mean);
  const blended = blendedGroundHeight(cl.samples, s.x, s.z, lap, {}, mean);
  assert.ok(Math.abs(blended - nearest) < 0.08,
    `on-track blend ${blended.toFixed(3)} vs nearest ${nearest.toFixed(3)}`);
});

test('ground-mesh sink is under the ribbons, not a cliff at the white line', () => {
  const s = stationAt(0.4);
  const wall = s.wallLimit;
  // A non-zero sink keyed on nearest-station lateral is a rectangular pit
  // wherever a 20 m ground cell straddles the wall on a corner — the leftover
  // holes. Ribbons win by polygonOffset, not by dropping the lawn.
  for (const lat of [0, wall * 0.4, wall, wall + 12]) {
    assert.equal(groundMeshBias(lat, wall), 0, `lat ${lat} vs wall ${wall}`);
  }
});
