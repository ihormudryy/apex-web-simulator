import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SILVERSTONE_ELEVATION, SILVERSTONE_BANKING, SILVERSTONE_ROUGHNESS,
  elevationAt, elevationGradient, bankingAt, roughnessAt,
  CROWN_SLOPE, crossSlopeHeight,
  bumpHeight, kerbHeight, KERB_WIDTH, KERB_HEIGHT, KERB_RIB_PITCH, KERB_RIB_DEPTH,
  surfaceHeight, surfaceRoughness,
} from './elevation.js';
import {
  createSurfaceSamples, sampleWheelSurfaces, fitGroundPlane, createGroundPlane,
  WHEEL_X, WHEEL_Y, meanMu, isSplitSurface,
} from '../physics/surface.js';
import { LF, LR, TRACK_HALF, MU } from '../physics/constants.js';
import {
  createCar, step, warmUp, launch, forwardSpeed, rebaseToGround,
} from '../physics/kernel.js';

const LAP = 5891;

// ---------------------------------------------------------------------------
// Elevation
// ---------------------------------------------------------------------------

test('the lap has the elevation change Silverstone has', () => {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < 4000; i++) {
    const y = elevationAt(i / 4000);
    lo = Math.min(lo, y);
    hi = Math.max(hi, y);
  }
  assert.ok(hi - lo > 8 && hi - lo < 18, `${(hi - lo).toFixed(1)} m of elevation change`);
});

test('elevation is periodic — the lap joins up', () => {
  assert.ok(Math.abs(elevationAt(0) - elevationAt(1)) < 1e-9);
  assert.ok(Math.abs(elevationAt(0.5) - elevationAt(1.5)) < 1e-9);
  assert.ok(Math.abs(elevationAt(-0.25) - elevationAt(0.75)) < 1e-9);
});

test('elevation is C1 — no gradient step at a control point', () => {
  // Linear interpolation would put a gradient discontinuity at every control
  // point, and a gradient step is a kerb strike: seventeen invisible ones a lap,
  // at exactly the places the profile was meant to be smooth.
  for (const p of SILVERSTONE_ELEVATION) {
    const d = 4 / LAP;             // four metres either side
    const before = (elevationAt(p.t) - elevationAt(p.t - d)) / d;
    const after = (elevationAt(p.t + d) - elevationAt(p.t)) / d;
    assert.ok(
      Math.abs(after - before) < Math.abs(before) + 40,
      `gradient jumps from ${before.toFixed(1)} to ${after.toFixed(1)} at t=${p.t}`,
    );
  }
});

test('no single metre of track steps more than a real gradient', () => {
  let worst = 0;
  let at = 0;
  for (let i = 0; i < LAP; i++) {
    const step = Math.abs(elevationAt((i + 1) / LAP) - elevationAt(i / LAP));
    if (step > worst) { worst = step; at = i / LAP; }
  }
  assert.ok(worst < 0.06, `${(worst * 100).toFixed(2)}% gradient at t=${at.toFixed(3)}`);
  assert.ok(worst > 0.005, 'a circuit with no gradient anywhere is still a flat ribbon');
});

test('the gradient is signed and matches the profile', () => {
  // Abbey down to Village is a descent.
  assert.ok(elevationGradient(0.06, LAP) < 0, 'the drop into Village must be a drop');
  // Aintree up to Wellington is a climb.
  assert.ok(elevationGradient(0.28, LAP) > 0, 'the climb to Wellington must be a climb');
});

// ---------------------------------------------------------------------------
// Cross-slope
// ---------------------------------------------------------------------------

test('the drainage crown falls away from the centreline on both sides', () => {
  // At a station with no banking, so the crown is on its own. Where the road IS
  // banked, one edge is genuinely higher than the centre — that is what banking is,
  // and asserting otherwise was the test being wrong rather than the road.
  const t = 0;
  assert.ok(Math.abs(bankingAt(t)) < 1e-9, 'this station must be unbanked');
  const centre = crossSlopeHeight(t, 0);
  assert.ok(crossSlopeHeight(t, 5) < centre, 'the left edge must be lower');
  assert.ok(crossSlopeHeight(t, -5) < centre, 'and so must the right');
  assert.ok(CROWN_SLOPE > 0.005 && CROWN_SLOPE < 0.03, `${CROWN_SLOPE * 100}% crown`);
});

test('banking tilts the road, so the two edges are not symmetric', () => {
  // Luffield is the most banked corner on the lap.
  const t = 0.44;
  assert.ok(Math.abs(bankingAt(t)) > 0.005, 'Luffield must actually be banked');
  const left = crossSlopeHeight(t, 5);
  const right = crossSlopeHeight(t, -5);
  assert.ok(Math.abs(left - right) > 0.02, 'banking must break the crown symmetry');
});

test('banking is periodic and small, as Silverstone is', () => {
  assert.ok(Math.abs(bankingAt(0) - bankingAt(1)) < 1e-9);
  for (let i = 0; i < 500; i++) {
    const a = Math.abs(bankingAt(i / 500));
    assert.ok(a < 0.06, `${(a * 180 / Math.PI).toFixed(1)} degrees of banking`);
  }
});

// ---------------------------------------------------------------------------
// Bumps
// ---------------------------------------------------------------------------

test('bumps are of a size the suspension can actually work with', () => {
  let lo = Infinity;
  let hi = -Infinity;
  for (let s = 0; s < 600; s += 0.02) {
    const h = bumpHeight(s, 0, 1);
    lo = Math.min(lo, h);
    hi = Math.max(hi, h);
  }
  const pp = (hi - lo) * 1000;
  // The front bump-stop gap is 12 mm. Bumps of 56 mm, where this started, swamp
  // the whole working range of the suspension.
  assert.ok(pp > 12 && pp < 40, `${pp.toFixed(1)} mm peak-to-peak at full severity`);
});

test('bumps differ across the width of the car, so they roll it as well as pitch it', () => {
  let worst = 0;
  for (let s = 0; s < 600; s += 0.02) {
    worst = Math.max(worst, Math.abs(bumpHeight(s, -TRACK_HALF, 1) - bumpHeight(s, TRACK_HALF, 1)));
  }
  assert.ok(worst * 1000 > 1, `only ${(worst * 1000).toFixed(2)} mm of left-right difference`);
});

test('bumps are repeatable — the same place is bumpy every lap', () => {
  // Learning where the bumps are is most of what knowing a circuit means, so a
  // noise field reseeded per run would be the wrong model.
  assert.equal(bumpHeight(1234.5, 0.4, 0.8), bumpHeight(1234.5, 0.4, 0.8));
});

test('bump amplitude scales with severity, and vanishes at zero', () => {
  const at = sev => bumpHeight(123.4, 0.2, sev);
  assert.equal(at(0), 0);
  assert.ok(Math.abs(at(0.5) - at(1) * 0.5) < 1e-12);
});

test('roughness varies round the lap, and Village is the rough bit', () => {
  assert.ok(roughnessAt(0.13) > roughnessAt(0.33), 'Village must be rougher than Wellington');
  for (let i = 0; i < 500; i++) {
    const r = roughnessAt(i / 500);
    assert.ok(r >= 0 && r <= 1, `roughness ${r}`);
  }
});

// ---------------------------------------------------------------------------
// Kerbs
// ---------------------------------------------------------------------------

test('a kerb is real geometry with a real height', () => {
  const hw = 10;
  assert.equal(kerbHeight(hw - 0.1, hw, 0), 0, 'nothing on the asphalt');
  assert.ok(kerbHeight(hw + 0.5, hw, 0) >= KERB_HEIGHT * 0.95, 'full height in the middle');
  assert.equal(kerbHeight(hw + KERB_WIDTH + 0.1, hw, 0), 0, 'nothing past the far edge');
});

test('the kerb height is more than half the front bump-stop gap', () => {
  // Which is the reason kerbs matter on these cars: a wheel climbing 50 mm eats
  // most of the 12 mm of spring travel plus the tyre's, and lands on the packers.
  assert.ok(KERB_HEIGHT >= 0.04 && KERB_HEIGHT <= 0.07, `${KERB_HEIGHT * 1000} mm kerb`);
});

test('a kerb ramps in rather than being a wall', () => {
  const hw = 10;
  const edge = kerbHeight(hw + 0.02, hw, 0);
  assert.ok(edge > 0 && edge < KERB_HEIGHT * 0.5, `${edge * 1000} mm at the leading edge`);
});

test('the serrations are what make a kerb loud', () => {
  const hw = 10;
  let lo = Infinity;
  let hi = -Infinity;
  for (let a = 0; a < 4; a += 0.005) {
    const h = kerbHeight(hw + 0.5, hw, a);
    lo = Math.min(lo, h);
    hi = Math.max(hi, h);
  }
  assert.ok(hi - lo > KERB_RIB_DEPTH * 0.8, `only ${((hi - lo) * 1000).toFixed(1)} mm of rib`);
  assert.ok(KERB_RIB_PITCH > 0.2 && KERB_RIB_PITCH < 1.0);
});

test('kerbs are symmetric — both sides of the track have them', () => {
  // Compared against the same lateral offset without a kerb, not against the
  // centreline: the crown and the banking already make the two edges different
  // heights, and that is the road rather than the kerb.
  const at = (lateral, halfWidth) => surfaceHeight({ t: 0.3, lateral, halfWidth }, LAP);
  for (const side of [1, -1]) {
    const onKerb = at(side * 10.5, 10);
    const noKerb = at(side * 10.5, 20);      // widen the asphalt past the sample
    assert.ok(
      onKerb - noKerb > KERB_HEIGHT * 0.8,
      `the ${side > 0 ? 'left' : 'right'} kerb only raised the surface by `
      + `${((onKerb - noKerb) * 1000).toFixed(1)} mm`,
    );
  }
});

// ---------------------------------------------------------------------------
// The whole surface
// ---------------------------------------------------------------------------

test('surface height combines everything and stays finite everywhere', () => {
  for (let i = 0; i < 400; i++) {
    for (const lateral of [-12, -10.2, -5, 0, 5, 10.2, 12]) {
      const h = surfaceHeight({ t: i / 400, lateral, halfWidth: 10 }, LAP);
      assert.ok(Number.isFinite(h) && Math.abs(h) < 100, `h=${h} at t=${i / 400}, y=${lateral}`);
    }
  }
});

test('surfaceRoughness reports the local severity', () => {
  assert.ok(surfaceRoughness({ t: 0.13 }) > surfaceRoughness({ t: 0.83 }));
});

// ---------------------------------------------------------------------------
// The ground plane fit — the part that decides whether a hill works
// ---------------------------------------------------------------------------

/** A track whose surface is a plane of a given height and gradient. */
function planeTrack(height, gradeLong, gradeLat) {
  return {
    queryWheel(x, z, out) {
      // Yaw 0 faces -Z, so body-forward is -Z and body-right is +X.
      out.surface = 'tarmac';
      out.mu = MU.tarmac;
      out.height = height + gradeLong * -z + gradeLat * x;
      out.roughness = 0;
      out.nx = 0;
      out.nz = 0;
      return out;
    },
  };
}

test('a flat plane gives zero residual at any height', () => {
  const samples = createSurfaceSamples();
  const plane = createGroundPlane();
  for (const h of [0, 5, -3, 120]) {
    sampleWheelSurfaces(planeTrack(h, 0, 0), 0, 0, 0, samples);
    fitGroundPlane(samples, plane);
    assert.ok(Math.abs(plane.height - h) < 1e-9, `height ${plane.height} for a plane at ${h}`);
    for (let i = 0; i < 4; i++) {
      assert.ok(Math.abs(plane.residual[i]) < 1e-9, `residual ${plane.residual[i]} on flat ground`);
    }
  }
});

test('a SLOPE gives zero residual — the suspension must not see a hill as a bump', () => {
  // This is the whole point of the plane fit. Handing the suspension absolute
  // height would compress every spring by the hill; handing it height minus the
  // mean would permanently pitch the car on any gradient.
  const samples = createSurfaceSamples();
  const plane = createGroundPlane();
  for (const [gl, gt] of [[0.03, 0], [-0.05, 0], [0, 0.02], [0.03, -0.02]]) {
    sampleWheelSurfaces(planeTrack(7, gl, gt), 0, 0, 0, samples);
    fitGroundPlane(samples, plane);
    for (let i = 0; i < 4; i++) {
      assert.ok(
        Math.abs(plane.residual[i]) < 1e-9,
        `gradient (${gl}, ${gt}) left ${(plane.residual[i] * 1000).toFixed(3)} mm of residual`,
      );
    }
    assert.ok(Math.abs(plane.gradeLong - gl) < 1e-9, `gradeLong ${plane.gradeLong} vs ${gl}`);
    assert.ok(Math.abs(plane.gradeLat - gt) < 1e-9, `gradeLat ${plane.gradeLat} vs ${gt}`);
  }
});

test('a one-sided step reads as a lateral gradient, which is why it is not the springs input', () => {
  // Two wheels 50 mm up, across a 1.6 m track, IS a 3% lateral gradient. The plane
  // fit cannot tell a kerb from banking and never could — which is precisely why
  // the suspension is fed raw wheel heights instead of the plane residual. Feeding
  // it the residual made every kerb on the circuit a static tilt with no impact.
  const samples = createSurfaceSamples();
  const plane = createGroundPlane();
  const kerbed = {
    queryWheel(x, z, out) {
      out.surface = 'tarmac';
      out.mu = MU.tarmac;
      out.height = x < -0.1 ? 0.05 : 0;      // left-hand wheels up
      out.roughness = 0;
      out.nx = 0;
      out.nz = 0;
      out.curvature = 0;
      return out;
    },
  };
  sampleWheelSurfaces(kerbed, 0, 0, 0, samples);
  fitGroundPlane(samples, plane);
  assert.ok(Math.abs(plane.gradeLat) > 1e-6, 'it must read as a lateral gradient');
  for (const r of plane.residual) {
    assert.ok(Math.abs(r) < 1e-9, `the fit absorbed it, leaving ${r} — as expected`);
  }
});

test('a crest is INVISIBLE to the plane fit, which is why curvature is separate', () => {
  // Four contact points at two distinct longitudinal positions always fit a plane
  // exactly, so a crest between the axles leaves no residual whatsoever. The fit
  // is structurally blind to it. That is not a bug to fix in the fit — it is the
  // reason the surface query reports vertical curvature as its own channel.
  const samples = createSurfaceSamples();
  const plane = createGroundPlane();
  const crest = {
    queryWheel(x, z, out) {
      out.surface = 'tarmac';
      out.mu = MU.tarmac;
      out.height = -0.01 * z * z;      // curvature, not gradient
      out.roughness = 0;
      out.nx = 0;
      out.nz = 0;
      out.curvature = -0.02;
      return out;
    },
  };
  sampleWheelSurfaces(crest, 0, 0, 0, samples);
  fitGroundPlane(samples, plane);
  for (const r of plane.residual) {
    assert.ok(Math.abs(r) < 1e-9, `the fit found ${r} of residual in pure curvature`);
  }
  assert.ok(plane.curvature < 0, 'and the curvature channel must carry the crest');
});

test('the wheel positions straddle the car', () => {
  assert.ok(WHEEL_X[0] > 0 && WHEEL_X[2] < 0, 'front ahead, rear behind');
  assert.ok(Math.abs(WHEEL_X[0] - LF) < 1e-9);
  assert.ok(Math.abs(WHEEL_X[2] + LR) < 1e-9);
  assert.ok(WHEEL_Y[0] < 0 && WHEEL_Y[1] > 0, 'left and right');
  assert.ok(Math.abs(WHEEL_Y[1] - TRACK_HALF) < 1e-9);
});

// ---------------------------------------------------------------------------
// Per-wheel surface — the bug the interface exists to fix
// ---------------------------------------------------------------------------

test('two wheels on the grass leaves the other two on tarmac', () => {
  // The old model sampled one surface for the whole car, so putting two wheels on
  // the grass dropped the ENTIRE car to mu = 0.35. A wheel on the grass should
  // pull the car, not teleport it onto ice.
  const samples = createSurfaceSamples();
  const splitTrack = {
    query: x => ({
      surface: x > 0 ? 'grass' : 'tarmac',
      lateral: 0, wallLimit: 1e9, normal: { x: 0, z: 0 },
    }),
  };
  sampleWheelSurfaces(splitTrack, 0, 0, 0, samples);
  assert.ok(isSplitSurface(samples), 'the wheels must not all report the same surface');
  const grassy = samples.filter(s => s.surface === 'grass');
  assert.equal(grassy.length, 2);
  assert.ok(grassy.every(s => s.mu === MU.grass));
  assert.ok(samples.filter(s => s.surface === 'tarmac').every(s => s.mu === MU.tarmac));
  assert.ok(meanMu(samples) > MU.grass && meanMu(samples) < MU.tarmac);
});

test('a track with only the old query interface still works, treated as flat', () => {
  const samples = createSurfaceSamples();
  const flat = { query: () => ({ surface: 'tarmac', lateral: 0, wallLimit: 1e9, normal: { x: 0, z: 0 } }) };
  sampleWheelSurfaces(flat, 0, 0, 0, samples);
  assert.ok(samples.every(s => s.height === 0 && s.mu === MU.tarmac));
  assert.equal(isSplitSurface(samples), false);
});

test('wheel sample positions rotate with the car', () => {
  const samples = createSurfaceSamples();
  const recording = { query: () => ({ surface: 'tarmac', lateral: 0, wallLimit: 1e9, normal: { x: 0, z: 0 } }) };
  sampleWheelSurfaces(recording, 0, 0, 0, samples);
  // Yaw 0 faces -Z, so the front wheels are at negative Z.
  assert.ok(samples[0].z < 0 && samples[2].z > 0, 'front ahead of rear along -Z');
  sampleWheelSurfaces(recording, 0, 0, Math.PI / 2, samples);
  // Yawed 90 degrees left, forward is -X.
  assert.ok(samples[0].x < 0, `front wheel at x=${samples[0].x} after a quarter turn`);
});

// ---------------------------------------------------------------------------
// The behaviour that matters: does the road actually reach the car?
// ---------------------------------------------------------------------------

/** A circuit-shaped track with an elevation profile and optional kerbs. */
function surfaceTrack({ grade = 0, kerbSide = 0, crest = 0, bank = 0 } = {}) {
  return {
    query: () => ({
      surface: 'tarmac', lateral: 0, wallLimit: 1e9, normal: { x: 0, z: 0 },
    }),
    queryWheel(x, z, out) {
      out.surface = 'tarmac';
      out.mu = MU.tarmac;
      // Body forward is -Z at yaw 0, so distance travelled forward is -z.
      const along = -z;
      out.height = grade * along - crest * along * along + bank * x
        + (kerbSide !== 0 && Math.sign(x) === kerbSide ? KERB_HEIGHT : 0);
      out.roughness = 0;
      out.nx = 0;
      out.nz = 0;
      out.curvature = -2 * crest;
      return out;
    },
  };
}

test('a constant gradient does NOT keep compressing the springs as the car climbs', () => {
  // The failure mode this guards against is unbounded: hand the suspension
  // absolute height and every metre climbed is another metre into the springs.
  // What it must do instead is settle, and stay settled however far the car goes.
  //
  // Note it does not settle at the *level* compression, and should not: gravity
  // along a 3% climb is a longitudinal force like any other, so it transfers load
  // rearward exactly as a throttle input does. That is 6.5 mm at the rear, and it
  // is the road being uphill rather than the model losing track of it.
  const car = createCar({});
  warmUp(car);
  const track = surfaceTrack({ grade: 0.03 });
  rebaseToGround(car, track);
  launch(car, 40);

  const sampleAt = seconds => {
    for (let i = 0; i < 600 * seconds; i++) {
      step(car, { throttle: 0.35, brake: 0, steer: 0 }, track, 1 / 600);
    }
    return [...car.suspension.compression];
  };
  const early = sampleAt(4);
  const late = sampleAt(6);       // another 6 s, some 300 m further up the hill
  for (let i = 0; i < 4; i++) {
    const drift = Math.abs(late[i] - early[i]);
    assert.ok(
      drift < 0.002,
      `corner ${i} drifted another ${(drift * 1000).toFixed(2)} mm over 300 m of climb`,
    );
  }
  assert.ok(car.out.gradeLong > 0.02, `the slope must be reported: ${car.out.gradeLong}`);
});

test('a climb costs speed and a descent gives it back', () => {
  // Twelve seconds, not five: the speed converges with the drag time constant,
  // m / (rho * v * CdA) ~ 7 s at these speeds, so a 5 s snapshot only expressed
  // part of the slope's effect — and shrank below the 1 m/s gate the moment the
  // front wing change added induced drag. The property is about terminal speeds.
  const run = grade => {
    const car = createCar({});
    warmUp(car);
    const track = surfaceTrack({ grade });
    rebaseToGround(car, track);
    launch(car, 60);
    for (let i = 0; i < 600 * 12; i++) {
      step(car, { throttle: 0.4, brake: 0, steer: 0 }, track, 1 / 600);
    }
    return forwardSpeed(car);
  };
  const uphill = run(0.06);
  const level = run(0);
  const downhill = run(-0.06);
  assert.ok(uphill < level - 1, `uphill ${uphill.toFixed(1)} vs level ${level.toFixed(1)} m/s`);
  assert.ok(downhill > level + 1, `downhill ${downhill.toFixed(1)} vs level ${level.toFixed(1)}`);
});

test('a one-sided kerb DOES upset the platform — it rolls the car', () => {
  const car = createCar({});
  warmUp(car);
  const flat = surfaceTrack({});
  rebaseToGround(car, flat);
  launch(car, 40);
  for (let i = 0; i < 600; i++) step(car, { throttle: 0.3, brake: 0, steer: 0 }, flat, 1 / 600);
  const settledRoll = car.suspension.roll;

  const kerb = surfaceTrack({ kerbSide: -1 });
  let peakRoll = 0;
  let peakLoad = 0;
  for (let i = 0; i < 600; i++) {
    step(car, { throttle: 0.3, brake: 0, steer: 0 }, kerb, 1 / 600);
    peakRoll = Math.max(peakRoll, Math.abs(car.suspension.roll - settledRoll));
    peakLoad = Math.max(peakLoad, car.out.fz[0]);
  }
  assert.ok(
    peakRoll > 0.005,
    `a 50 mm kerb only rolled the car by ${(peakRoll * 180 / Math.PI).toFixed(3)} degrees`,
  );
  assert.ok(peakLoad > 3000, `and the tyre load only reached ${peakLoad.toFixed(0)} N`);
});

test('cresting a rise unloads the car, with nothing added to make it happen', () => {
  const measure = crest => {
    const car = createCar({});
    warmUp(car);
    const track = surfaceTrack({ crest });
    rebaseToGround(car, track);
    launch(car, 70);
    let minLoad = Infinity;
    for (let i = 0; i < 600 * 3; i++) {
      step(car, { throttle: 0.45, brake: 0, steer: 0 }, track, 1 / 600);
      if (i > 600) {
        minLoad = Math.min(minLoad, car.out.fz.reduce((a, b) => a + b, 0));
      }
    }
    return minLoad;
  };
  const level = measure(0);
  const overCrest = measure(0.0012);
  // The wheels have to stop rising, and the force to do that comes out of the
  // springs. Nothing in the kernel adds a "crest" term; this is the springs.
  assert.ok(
    overCrest < level * 0.9,
    `a crest only took the load from ${level.toFixed(0)} N to ${overCrest.toFixed(0)} N`,
  );
});

// ---------------------------------------------------------------------------
// The chassis attitude already contains the road
// ---------------------------------------------------------------------------

test('on a steady gradient the chassis sits PARALLEL to the road', () => {
  // The suspension is fed raw wheel heights, so it settles onto whatever plane it
  // is on — which means its pitch already *is* the road gradient. Anything that
  // adds `gradeLong` to `pitch` doubles the slope.
  //
  // This is the property that makes that a bug rather than a style choice, and it
  // is worth pinning: the chassis-height double-count buried the car four metres
  // under the road, and the same mistake in the rotation drew it pitching twice as
  // hard as it was, with the plane fit's per-frame noise on top.
  const car = createCar({});
  warmUp(car);
  const grade = 0.03;
  const track = surfaceTrack({ grade });
  rebaseToGround(car, track);
  launch(car, 40);
  for (let i = 0; i < 600 * 8; i++) {
    step(car, { throttle: 0.35, brake: 0, steer: 0 }, track, 1 / 600);
  }
  const roadPitch = car.out.gradeLong;
  const chassisPitch = car.suspension.pitch;
  assert.ok(
    Math.abs(roadPitch - grade) < 0.004,
    `the road gradient should be reported as ${grade}, got ${roadPitch.toFixed(4)}`,
  );
  // Parallel: the chassis attitude matches the road, so the DIFFERENCE is what a
  // suspension is doing and it is small.
  assert.ok(
    Math.abs(chassisPitch - roadPitch) < 0.012,
    `chassis at ${(chassisPitch * 180 / Math.PI).toFixed(2)} deg on a road at `
    + `${(roadPitch * 180 / Math.PI).toFixed(2)} deg — it should be parallel`,
  );
  // And the sign matches, so adding them would double rather than cancel.
  assert.ok(chassisPitch * roadPitch > 0, 'the two must have the same sign');
});

test('and PARALLEL across a banked road too — but in the OPPOSITE sign convention', () => {
  // The chassis lies parallel to a banked road as well, but `suspension.roll` is
  // positive with the right side DOWN while `gradeLat` is dh/dy with y positive
  // right — so the two are equal and opposite.
  //
  // Which makes `gradeLat + roll` cancel rather than double: a second bug in the
  // same line as the pitch double-count, with the opposite symptom. A car drawn
  // dead level through a banked corner.
  const car = createCar({});
  warmUp(car);
  const track = surfaceTrack({ grade: 0, bank: 0.025 });
  rebaseToGround(car, track);
  launch(car, 40);
  for (let i = 0; i < 600 * 8; i++) {
    step(car, { throttle: 0.3, brake: 0, steer: 0 }, track, 1 / 600);
  }
  const roadRoll = car.out.gradeLat;
  const chassisRoll = car.suspension.roll;
  assert.ok(Math.abs(roadRoll) > 0.01, `the bank must be reported: ${roadRoll}`);
  assert.ok(
    Math.abs(chassisRoll + roadRoll) < 0.012,
    `chassis roll ${chassisRoll.toFixed(4)} should be the negation of the road's `
    + `${roadRoll.toFixed(4)}`,
  );
  assert.ok(chassisRoll * roadRoll < 0, 'the conventions are opposite, so adding them cancels');
});
