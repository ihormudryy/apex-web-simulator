import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRaceField, stepField, standings, gridPose, RACE_LAPS, resetField,
} from './raceField.js';
import { buildCenterline } from '../track/centerline.js';
import { SILVERSTONE_WAYPOINTS } from '../track/silverstoneWaypoints.js';
import { MU } from '../physics/constants.js';
import { surfaceHeight, surfaceRoughness, verticalCurvature } from '../track/elevation.js';

const DT = 1 / 60;

function circuit() {
  const centerline = buildCenterline(SILVERSTONE_WAYPOINTS, 4000);
  let hint = 0, wheelHint = 0;
  return {
    centerline,
    // Track's real accessor, same shape: { x, z, tx, tz }.
    spawn() {
      const s = centerline.samples[0];
      return { x: s.x, z: s.z, tx: s.tx, tz: s.tz };
    },
    query(x, z) { const r = centerline.query(x, z, hint); hint = r.index; return r; },
    queryWheel(x, z, out) {
      const q = centerline.query(x, z, wheelHint);
      wheelHint = q.index;
      out.surface = q.surface;
      out.mu = MU[q.surface] ?? MU.grass;
      out.height = surfaceHeight(q, centerline.length);
      out.roughness = surfaceRoughness(q);
      out.curvature = verticalCurvature(q.t, centerline.length);
      out.nx = 0; out.nz = 0;
      return out;
    },
  };
}
const noInput = () =>
  ({ forward: false, reverse: false, left: false, right: false, brake: false });

test('the two grid slots are apart, and both on the road', () => {
  const track = circuit();
  const a = gridPose(track, 0);
  const b = gridPose(track, 1);
  const gap = Math.hypot(a.x - b.x, a.z - b.z);
  assert.ok(gap > 2.5, `grid slots only ${gap.toFixed(2)} m apart`);
  for (const p of [a, b]) {
    const q = track.query(p.x, p.z);
    assert.ok(Math.abs(q.lateral) < q.halfWidth,
      `grid slot is ${Math.abs(q.lateral).toFixed(2)} m off centre, past the ${q.halfWidth.toFixed(2)} m edge`);
  }
});

test('the field is deterministic', () => {
  const run = () => {
    const track = circuit();
    const field = createRaceField(track, { rivals: 1, level: 'pro' });
    const input = noInput();
    input.forward = true;
    for (let f = 0; f < 1200; f++) stepField(field, input, track, DT);
    return field.entries.map(e => [e.vehicle.x, e.vehicle.z, e.vehicle.yaw]);
  };
  assert.deepEqual(run(), run());
});

test('standings put the car further round the lap first', () => {
  const track = circuit();
  const field = createRaceField(track, { rivals: 1, level: 'pro' });
  field.entries[0].laps = 1; field.entries[0].t = 0.10;
  field.entries[1].laps = 1; field.entries[1].t = 0.60;
  assert.equal(standings(field)[0], field.entries[1]);
  // Across the lap boundary: more laps beats a higher t.
  field.entries[0].laps = 2; field.entries[0].t = 0.01;
  assert.equal(standings(field)[0], field.entries[0]);
});

test('a finished car stops being classified as racing', () => {
  const track = circuit();
  const field = createRaceField(track, { rivals: 1, level: 'pro' });
  const e = field.entries[0];
  e.laps = RACE_LAPS;
  const input = noInput();
  stepField(field, input, track, DT);
  assert.equal(e.finished, true);
  assert.ok(e.finishTime > 0, 'a finished car has no finish time');
});

test('resetField puts both cars back on the grid', () => {
  const track = circuit();
  const field = createRaceField(track, { rivals: 1, level: 'pro' });
  const input = noInput();
  input.forward = true;
  for (let f = 0; f < 600; f++) stepField(field, input, track, DT);
  resetField(field, track);
  for (let i = 0; i < field.entries.length; i++) {
    const p = gridPose(track, i);
    assert.ok(Math.hypot(field.entries[i].vehicle.x - p.x,
      field.entries[i].vehicle.z - p.z) < 0.5, `entry ${i} was not returned to its slot`);
    assert.equal(field.entries[i].laps, 0);
    assert.equal(field.entries[i].finished, false);
  }
});
