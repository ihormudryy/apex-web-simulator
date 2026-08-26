import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRaceField, stepField, standings, gridPose, RACE_LAPS, resetField,
  rivalGapDisplay,
} from './raceField.js';
import { buildCenterline } from '../track/centerline.js';
import { SILVERSTONE_WAYPOINTS } from '../track/silverstoneWaypoints.js';
import { MU } from '../physics/constants.js';
import { surfaceHeight, surfaceRoughness, verticalCurvature } from '../track/elevation.js';
import { setPose } from '../physics/vehicle.js';

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

// C2: `e.elapsed` used to accrue while `field.locked`, and `prevT` started at 0
// while the grid slots sit near t=1 — so the idle-plus-lights hold (unbounded:
// the player may sit on the grid as long as they like) satisfied both the
// wrap check and the MIN_LAP_TIME guard before a wheel ever turned. Sweeping
// a spread of lock durations across the ~20 s MIN_LAP_TIME boundary is what
// caught it — a single duration either side would not have.
test('no lap is credited from time spent locked on the grid, across the MIN_LAP_TIME boundary', () => {
  for (const lock of [0, 12, 19, 19.5, 20, 20.5, 25]) {
    const track = circuit();
    const field = createRaceField(track, { rivals: 1, level: 'ace' });
    const input = noInput();
    field.locked = true;
    for (let f = 0; f < Math.round(lock / DT); f++) stepField(field, input, track, DT);
    field.locked = false;
    input.forward = true;
    for (let f = 0; f < Math.round(10 / DT); f++) stepField(field, input, track, DT);
    for (const e of field.entries) {
      assert.equal(e.laps, 0,
        `lock ${lock}s: entry credited ${e.laps} lap(s) after only 10 s of racing`);
    }
  }
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

// C1b: `driveAi` never sets `reverse`, so a rival beached off-road is stuck
// forever without help — the field has to notice and return it to the grid.
// The player is deliberately exempt (see `returnToGrid`'s caller in
// `stepField`), so only the rival entry is checked here.
//
// `stallTime` is preset to one `dt` short of the threshold rather than
// letting the AI actually drive itself off-road and stay there for several
// seconds: a car freshly placed off-road at rest is exactly the "beached"
// case the reviewer measured (v=0, and one frame is nowhere near enough
// acceleration to clear STALL_SPEED), but with a normal `mu`, `driveAi`
// steering back toward the line will usually claw its way back onto the
// track before three real seconds pass — that's a property of this
// particular off-road spot's grip, not of the recovery mechanism under test.
// Presetting the timer isolates the trigger itself: given the off-road and
// stopped conditions hold for the one frame that crosses the threshold, does
// the field return the car to its grid slot without touching its race
// progress.
test('a rival stuck off-road and stopped is returned to its grid slot, race progress kept', () => {
  const track = circuit();
  const field = createRaceField(track, { rivals: 1, level: 'pro' });
  const rival = field.entries[1];

  // Off the track entirely: far along the local normal from the centerline.
  const s = track.centerline.samples[500];
  setPose(rival.vehicle, s.x + s.nx * 30, s.z + s.nz * 30, 0, rival.view);
  rival.laps = 1;
  rival.elapsed = 45;
  rival.lapStart = 20;
  rival.stallTime = 2.99; // one frame from crossing the 3 s threshold

  const beforeQ = track.query(rival.vehicle.x, rival.vehicle.z);
  assert.ok(Math.abs(beforeQ.lateral) > beforeQ.halfWidth + 1, 'test setup: rival must start off-road');
  // Match `prevT` to this synthetic placement, or the jump from the grid's
  // t (~1) to this off-road spot's t reads as a lap-boundary wrap in its own
  // right — an artefact of teleporting the test's car directly rather than
  // driving it here, not something `stepField` needs to guard against.
  rival.prevT = beforeQ.t;

  stepField(field, noInput(), track, DT);

  const grid = gridPose(track, rival.slot);
  const dist = Math.hypot(rival.vehicle.x - grid.x, rival.vehicle.z - grid.z);
  assert.ok(dist < 1, `rival was not returned to its grid slot (${dist.toFixed(2)} m away)`);
  assert.equal(rival.stallTime, 0, 'stall timer must reset once recovered');
  // Race progress is untouched: this is a recovery, not a reset.
  assert.equal(rival.laps, 1, 'stall recovery must not touch lap count');
  assert.ok(Math.abs(rival.elapsed - (45 + DT)) < 1e-9,
    'stall recovery must not touch elapsed race time');
  assert.equal(rival.lapStart, 20, 'stall recovery must not touch lapStart');
});

// The five tests above never isolate the contact count: they'd still pass if
// every pair were resolved twice, or a car were paired against itself. This
// pins the loop's actual shape — N(N-1)/2 calls, each an unordered pair
// exactly once — by counting and identifying real resolutions through an
// injected stub, so a later "helpful" rewrite to a symmetric i/j loop (or a
// duplicate call) fails loudly here instead of quietly doubling contact
// response for the whole field.
test('contact resolves exactly once per unordered pair, for 2 and for 3 cars', () => {
  const track = circuit();
  const input = noInput();

  const countPairs = rivals => {
    // `resolveContact` is a plain property on the returned field, not baked
    // into a closure, so it can be swapped for a counting stub after the
    // field (and its vehicles' identity) exists.
    const field = createRaceField(track, { rivals, level: 'pro' });
    const indexOf = new Map(field.entries.map((e, i) => [e.vehicle.S, i]));
    const seen = new Set();
    let calls = 0;
    field.resolveContact = (SA, SB, out) => {
      calls++;
      assert.notEqual(SA, SB, 'a car must never be paired against itself');
      const a = indexOf.get(SA), b = indexOf.get(SB);
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      assert.ok(!seen.has(key), `pair ${key} resolved more than once in one step`);
      seen.add(key);
      return out;
    };
    stepField(field, input, track, DT);
    return calls;
  };

  assert.equal(countPairs(1), 1); // 2 cars -> C(2,2) = 1 pair
  assert.equal(countPairs(2), 3); // 3 cars -> C(3,2) = 3 pairs
});

// `rivalGapDisplay` decides *what kind* of gap is truthful to show, not just
// its magnitude. Same lap is the only case a live seconds figure means
// anything; the other two are the exact failures the reviewer measured:
// a lap apart reporting ~1.3 s, and a finished (frozen) car reporting an
// arbitrary distance-based number.
function placeAt(entry, sample, { vz = -30 } = {}) {
  entry.vehicle.x = sample.x;
  entry.vehicle.z = sample.z;
  entry.vehicle.yaw = 0;
  entry.vehicle.vx = 0;
  entry.vehicle.vz = vz; // forwardSpeed = -vz*cos(0) = -vz, so vz<0 is "moving forward"
}

test('rivalGapDisplay: same lap is a live, signed seconds figure', () => {
  const track = circuit();
  const field = createRaceField(track, { rivals: 1, level: 'pro' });
  const [a, b] = field.entries;
  const lapLength = track.centerline.length;
  const samples = track.centerline.samples;

  placeAt(a, samples[0]);
  placeAt(b, samples[Math.round((50 / lapLength) * samples.length)]);
  a.laps = 0; a.finished = false;
  b.laps = 0; b.finished = false;

  const display = rivalGapDisplay(a, b, lapLength);
  assert.equal(display.kind, 'seconds');
  assert.ok(Number.isFinite(display.seconds));
  // b sits ~50 m ahead of a on the same lap: a trails, so the sign is positive.
  assert.ok(display.seconds > 0, `expected a positive (trailing) gap, got ${display.seconds}`);
  assert.ok(display.seconds < 10, `50 m at ~20+ m/s should be a few seconds, got ${display.seconds}`);
});

test('rivalGapDisplay: a lap apart at the same track position is a lap count, not ~1.3 s', () => {
  const track = circuit();
  const field = createRaceField(track, { rivals: 1, level: 'pro' });
  const [a, b] = field.entries;
  const lapLength = track.centerline.length;
  const s = track.centerline.samples[100];

  // Same point on the ring — the scenario that used to report ~1.3 s.
  placeAt(a, s);
  placeAt(b, s);
  a.laps = 0; a.finished = false;
  b.laps = 1; b.finished = false;

  const display = rivalGapDisplay(a, b, lapLength);
  assert.equal(display.kind, 'laps');
  assert.equal(display.delta, 1, 'a is exactly one lap behind b');
});

// The "behind" direction above was the only one covered — the untested
// "ahead" direction is exactly the blind spot pattern that hid C1's off-road
// state, so pin it too: `delta` must flip sign, not just magnitude.
test('rivalGapDisplay: a lap ahead at the same track position is a negative lap count', () => {
  const track = circuit();
  const field = createRaceField(track, { rivals: 1, level: 'pro' });
  const [a, b] = field.entries;
  const lapLength = track.centerline.length;
  const s = track.centerline.samples[100];

  placeAt(a, s);
  placeAt(b, s);
  a.laps = 1; a.finished = false;
  b.laps = 0; b.finished = false;

  const display = rivalGapDisplay(a, b, lapLength);
  assert.equal(display.kind, 'laps');
  assert.equal(display.delta, -1, 'a is exactly one lap ahead of b');
});

test('rivalGapDisplay: a finished car reports its finish time, not a live position gap', () => {
  const track = circuit();
  const field = createRaceField(track, { rivals: 1, level: 'pro' });
  const [a, b] = field.entries;
  const lapLength = track.centerline.length;
  const samples = track.centerline.samples;

  // Wildly different track positions on purpose: a finished car's parked
  // position must not leak into the readout at all.
  placeAt(a, samples[0]);
  placeAt(b, samples[2000]);
  a.laps = RACE_LAPS - 1; a.finished = false;
  b.laps = RACE_LAPS; b.finished = true; b.finishTime = 123.456;

  const display = rivalGapDisplay(a, b, lapLength);
  assert.equal(display.kind, 'finished');
  assert.equal(display.finishTime, 123.456);
});
