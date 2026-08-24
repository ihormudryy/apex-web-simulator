import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planShellFit, NOMINAL_CAR_LENGTH, MIN_FIT_SCALE, MAX_FIT_SCALE,
  isWheelName, partNameFromNode, outermostWheelNodes, planShellYaw,
  nearestHubCorner, partitionIndexedTriangles,
  allWheelsExtractable, WHEEL_CORNER_NAMES, MIN_WHEEL_TRIANGLES,
  remapIndexedSubset, wheelScaleFromBox,
} from './fitCarShell.js';

const WB = 3.3928;
const RIG = {
  wheelbase: WB,
  wheelRadius: 0.334,
  frontHubX: WB * 0.54,
  rearHubX: -WB * 0.46,
};

/** visualRoot position of a local-space point after the fit's yaw/scale/shift. */
function seated(fit, x, z) {
  const c = Math.cos(fit.yaw), s = Math.sin(fit.yaw);
  return {
    x: (c * x + s * z) * fit.scale + fit.shiftX,
    z: (-s * x + c * z) * fit.scale + fit.shiftZ,
  };
}

/**
 * A shell authored along Z, wheels at +/-halfWb, hubs at `hubY`, at `k` times
 * the size the rig wants.
 */
function shell(k = 1, { hubY = 0.35, axis = 'z', named = true } = {}) {
  const halfWb = (RIG.wheelbase / 2) * k;
  const track = 0.72 * k;
  const parts = [];
  for (const [fz, side] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const along = fz * halfWb;
    const across = side * track;
    parts.push({
      name: named ? `Wheel_${fz > 0 ? 'F' : 'R'}${side > 0 ? 'L' : 'R'}` : 'mesh_0',
      cx: axis === 'z' ? across : along,
      cy: hubY * k,
      cz: axis === 'z' ? along : across,
      sx: 0.4 * k, sy: 0.67 * k, sz: 0.67 * k,
    });
  }
  parts.push({
    name: 'Body', cx: 0, cy: 0.5 * k, cz: 0,
    sx: 1.8 * k, sy: 1.0 * k, sz: 5.0 * k,
  });
  return parts;
}

test('scale comes from the wheelbase, so an undersized shell is grown to the rig', () => {
  const fit = planShellFit(shell(0.7), RIG);
  assert.equal(fit.method, 'wheelbase');
  // The fixture is 0.7x, so it needs 1/0.7 to match.
  assert.ok(Math.abs(fit.scale - 1 / 0.7) < 1e-6, `scale ${fit.scale}`);
  assert.ok(Math.abs(fit.shellWheelbase - RIG.wheelbase * 0.7) < 1e-6);
});

test('a shell already the right size is left alone', () => {
  const fit = planShellFit(shell(1), RIG);
  assert.ok(Math.abs(fit.scale - 1) < 1e-9, `scale ${fit.scale}`);
});

test('the lift puts the hubs exactly one wheel radius off the road', () => {
  for (const k of [0.5, 1, 2.5]) {
    const fit = planShellFit(shell(k, { hubY: 0.4 }), RIG);
    // hub height after scaling, plus the lift, must equal the wheel radius —
    // that is where the rig's contact patches are.
    const hubAfter = 0.4 * k * fit.scale + fit.lift;
    assert.ok(Math.abs(hubAfter - RIG.wheelRadius) < 1e-9,
      `k=${k}: hubs land at ${hubAfter}, want ${RIG.wheelRadius}`);
  }
});

test('the longitudinal axis is found whichever way the shell was authored', () => {
  const alongZ = planShellFit(shell(0.8, { axis: 'z' }), RIG);
  const alongX = planShellFit(shell(0.8, { axis: 'x' }), RIG);
  assert.equal(alongZ.method, 'wheelbase');
  assert.equal(alongX.method, 'wheelbase');
  assert.ok(Math.abs(alongZ.scale - alongX.scale) < 1e-9,
    'the same car rotated 90 degrees must fit identically');
});

test('wheels are reported by name so the caller can reparent them', () => {
  const fit = planShellFit(shell(1), RIG);
  assert.equal(fit.wheelNames.length, 4);
  assert.ok(fit.wheelNames.every(n => /Wheel_/.test(n)));
});

test('an unnamed shell falls back to overall length', () => {
  // No wheel names at all: the wheelbase is unknowable, so length is all we
  // have. The fixture body is 5.0 * k long.
  const fit = planShellFit(shell(0.5, { named: false }), RIG);
  assert.equal(fit.method, 'length');
  assert.ok(Math.abs(fit.scale - NOMINAL_CAR_LENGTH / (5.0 * 0.5)) < 1e-6,
    `scale ${fit.scale}`);
  assert.equal(fit.wheelNames.length, 0);
});

test('the fallback rests the lowest point on the road', () => {
  const parts = shell(0.5, { named: false });
  const fit = planShellFit(parts, RIG);
  const minY = Math.min(...parts.map(p => p.cy - p.sy / 2));
  assert.ok(Math.abs(minY * fit.scale + fit.lift) < 1e-9,
    'the bottom of the shell must land on y=0');
});

test('an absurd scale is refused rather than flung across the map', () => {
  // A shell authored in millimetres: a 3.4 m wheelbase reads as 3392 units, so
  // the "fix" would be a scale of ~0.001 — outside what we will apply blind.
  const tiny = shell(1).map(p => ({
    ...p, cx: p.cx * 1e5, cy: p.cy * 1e5, cz: p.cz * 1e5,
  }));
  const fit = planShellFit(tiny, RIG);
  assert.equal(fit.method, 'none');
  assert.equal(fit.scale, 1, 'a refused fit must be a no-op, not a guess');
  assert.ok(MIN_FIT_SCALE < 1 && MAX_FIT_SCALE > 1);
});

test('W14-style FL / rear-left groups count as wheels', () => {
  const halfWb = RIG.wheelbase / 2;
  const parts = [
    { name: 'FL_6', cx: 0.8, cy: 0.35, cz: halfWb, sx: 0.4, sy: 0.67, sz: 0.67 },
    { name: 'FR_74', cx: -0.8, cy: 0.35, cz: halfWb, sx: 0.4, sy: 0.67, sz: 0.67 },
    { name: 'rear left_18', cx: 0.8, cy: 0.35, cz: -halfWb, sx: 0.4, sy: 0.67, sz: 0.67 },
    { name: 'rear right_77', cx: -0.8, cy: 0.35, cz: -halfWb, sx: 0.4, sy: 0.67, sz: 0.67 },
    { name: 'Body', cx: 0, cy: 0.5, cz: 0, sx: 1.8, sy: 1, sz: 5 },
  ];
  const fit = planShellFit(parts, RIG);
  assert.equal(fit.method, 'wheelbase');
  assert.equal(fit.wheelNames.length, 4);
  assert.ok(Math.abs(fit.scale - 1) < 1e-6);
});

test('a shell whose origin is not the CoG is shifted onto the rig hubs', () => {
  // Measured W14: +Z-forward, origin ~0.79 m behind the axle midpoint. Scale
  // and lift alone leave the wheels 0.79 m ahead of the physics hubs; adopting
  // the groups onto the hubs then leaves the body behind (front tyres in the
  // sidepods, rears hanging off the wing).
  const parts = [
    { name: 'FL_6', cx: 0.8674, cy: 0.3169, cz: 2.4165, sx: 0.4, sy: 0.67, sz: 0.67 },
    { name: 'FR_74', cx: -0.8317, cy: 0.3164, cz: 2.4216, sx: 0.4, sy: 0.67, sz: 0.67 },
    { name: 'rear left_18', cx: 0.8595, cy: 0.3245, cz: -0.713, sx: 0.4, sy: 0.67, sz: 0.67 },
    { name: 'rear right_77', cx: -0.8272, cy: 0.3211, cz: -0.7238, sx: 0.4, sy: 0.67, sz: 0.67 },
    { name: 'Body', cx: 0, cy: 0.5, cz: 0.85, sx: 1.8, sy: 1, sz: 5 },
  ];
  const fit = planShellFit(parts, RIG);
  assert.equal(fit.method, 'wheelbase');
  const fl = seated(fit, 0.8674, 2.4165);
  const fr = seated(fit, -0.8317, 2.4216);
  const rl = seated(fit, 0.8595, -0.713);
  const rr = seated(fit, -0.8272, -0.7238);
  assert.ok(Math.abs(fl.x - RIG.frontHubX) < 0.02, `FL x ${fl.x} want ${RIG.frontHubX}`);
  assert.ok(Math.abs(fr.x - RIG.frontHubX) < 0.02, `FR x ${fr.x}`);
  assert.ok(Math.abs(rl.x - RIG.rearHubX) < 0.02, `RL x ${rl.x} want ${RIG.rearHubX}`);
  assert.ok(Math.abs(rr.x - RIG.rearHubX) < 0.02, `RR x ${rr.x}`);
  const trackMid = (fl.z + fr.z + rl.z + rr.z) / 4;
  assert.ok(Math.abs(trackMid) < 0.02, `track centre ${trackMid}`);
});

test('a wheelbase-symmetric shell still sits on the physics CoG, not the axle midpoint', () => {
  const fit = planShellFit(shell(1), RIG);
  const half = RIG.wheelbase / 2;
  const fl = seated(fit, 0.72, half);
  assert.ok(Math.abs(fl.x - RIG.frontHubX) < 1e-6, `FL x ${fl.x} want ${RIG.frontHubX}`);
});

test('isWheelName accepts Sketchfab corner groups, not body cubes', () => {
  assert.equal(isWheelName('FL_6'), true);
  assert.equal(isWheelName('rear left_18'), true);
  assert.equal(isWheelName('Wheel_FL'), true);
  assert.equal(isWheelName('Object_7'), false);
  assert.equal(isWheelName('floatBufferViews'), false);
  assert.equal(isWheelName('Cube_3'), false);
});

test('partNameFromNode walks up to the FL group over Object_7 meshes', () => {
  const root = { name: 'root', parent: null };
  const fl = { name: 'FL_6', parent: root };
  const mesh = { name: 'Object_7', parent: fl };
  root.parent = null;
  assert.equal(partNameFromNode(mesh, root), 'FL_6');
  assert.equal(partNameFromNode({ name: 'Body', parent: root }, root), 'Body');
});

test('outermostWheelNodes attaches the group, not every pirelli child', () => {
  const mesh = { name: 'Object_7', children: [] };
  const pirelli = { name: 'pirelli.001_4', children: [] };
  const fl = { name: 'FL_6', children: [mesh, pirelli] };
  const body = { name: 'Cube_3', children: [] };
  const root = { name: 'root', children: [fl, body] };
  const found = outermostWheelNodes(root, ['FL_6', 'pirelli.001_4']);
  assert.equal(found.length, 1);
  assert.equal(found[0].name, 'FL_6');
});

test('shell yaw maps +Z-forward Sketchfab onto visualRoot +X-forward', () => {
  const halfWb = 1.7;
  const track = 0.72;
  const parts = [
    { name: 'FL_6', cx: track, cy: 0.35, cz: halfWb, sx: 0.4, sy: 0.67, sz: 0.67 },
    { name: 'FR_74', cx: -track, cy: 0.35, cz: halfWb, sx: 0.4, sy: 0.67, sz: 0.67 },
    { name: 'rear left_18', cx: track, cy: 0.35, cz: -halfWb, sx: 0.4, sy: 0.67, sz: 0.67 },
    { name: 'rear right_77', cx: -track, cy: 0.35, cz: -halfWb, sx: 0.4, sy: 0.67, sz: 0.67 },
  ];
  // Three.js Y+90 sends (0,0,1) to (1,0,0) = visualRoot forward.
  assert.ok(Math.abs(planShellYaw(parts) - Math.PI / 2) < 1e-9);
});

test('a shell already facing visualRoot +X is not yawed', () => {
  const halfWb = 1.7;
  const parts = [
    { name: 'Wheel_FL', cx: halfWb, cy: 0.35, cz: 0.7, sx: 0.4, sy: 0.67, sz: 0.67 },
    { name: 'Wheel_FR', cx: halfWb, cy: 0.35, cz: -0.7, sx: 0.4, sy: 0.67, sz: 0.67 },
    { name: 'Wheel_RL', cx: -halfWb, cy: 0.35, cz: 0.7, sx: 0.4, sy: 0.67, sz: 0.67 },
    { name: 'Wheel_RR', cx: -halfWb, cy: 0.35, cz: -0.7, sx: 0.4, sy: 0.67, sz: 0.67 },
  ];
  assert.ok(Math.abs(planShellYaw(parts)) < 1e-9);
});

test('a nameless long-Z shell is yawed onto visualRoot +X', () => {
  const parts = [
    { name: 'Object_4', cx: 0, cy: 0.5, cz: 0, sx: 1.8, sy: 1.0, sz: 5.0 },
  ];
  assert.ok(Math.abs(planShellYaw(parts) - Math.PI / 2) < 1e-9);
});

test('nearestHubCorner maps tyre points onto the four hubs and ignores the tub', () => {
  const hubs = [
    { x: 1.7, y: 0.33, z: -0.8 },
    { x: 1.7, y: 0.33, z: 0.8 },
    { x: -1.7, y: 0.33, z: -0.8 },
    { x: -1.7, y: 0.33, z: 0.8 },
  ];
  const r = 0.42;
  assert.equal(nearestHubCorner(1.7, 0.33, -0.8, hubs, r), 0, 'FL hub');
  assert.equal(nearestHubCorner(1.7, 0.65, -0.8, hubs, r), 0, 'FL tyre top');
  assert.equal(nearestHubCorner(1.7, 0.33, 0.8, hubs, r), 1, 'FR');
  assert.equal(nearestHubCorner(-1.7, 0.33, -0.8, hubs, r), 2, 'RL');
  assert.equal(nearestHubCorner(-1.7, 0.33, 0.8, hubs, r), 3, 'RR');
  assert.equal(nearestHubCorner(0, 0.5, 0, hubs, r), -1, 'tub');
  assert.equal(nearestHubCorner(0, 0.9, 0, hubs, r), -1, 'halo');
});

test('a wheel volume keeps the outer tread and drops the bargeboard', () => {
  const hubs = [
    { x: 1.7, y: 0.33, z: -0.8 },
    { x: 1.7, y: 0.33, z: 0.8 },
    { x: -1.7, y: 0.33, z: -0.8 },
    { x: -1.7, y: 0.33, z: 0.8 },
  ];
  const radius = 0.52, halfWidth = 0.28;
  assert.equal(nearestHubCorner(1.7 + 0.5, 0.33, -0.8, hubs, radius, halfWidth), 0, 'outer tread');
  assert.equal(nearestHubCorner(1.7, 0.33, -0.8 + 0.45, hubs, radius, halfWidth), -1, 'bargeboard');
  assert.equal(nearestHubCorner(1.7, 0.02, -0.8, hubs, radius, halfWidth), -1, 'road under hub');
});

test('partitionIndexedTriangles peels corner triangles off the body', () => {
  const positions = [];
  const indices = [];
  const tri = (ax, ay, az, bx, by, bz, cx, cy, cz) => {
    const i = positions.length / 3;
    positions.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    indices.push(i, i + 1, i + 2);
  };
  tri(1.6, 0.15, -0.7, 1.5, 0.15, -0.7, 1.55, 0.4, -0.7); // FL
  tri(1.6, 0.15, 0.7, 1.5, 0.15, 0.7, 1.55, 0.4, 0.7);   // FR
  tri(-1.6, 0.15, -0.7, -1.5, 0.15, -0.7, -1.55, 0.4, -0.7); // RL
  tri(-1.6, 0.15, 0.7, -1.5, 0.15, 0.7, -1.55, 0.4, 0.7);   // RR
  tri(0, 0.8, 0, 0.2, 0.8, 0, 0, 0.9, 0.1); // body
  const hubs = [
    { x: 1.55, y: 0.25, z: -0.7 },
    { x: 1.55, y: 0.25, z: 0.7 },
    { x: -1.55, y: 0.25, z: -0.7 },
    { x: -1.55, y: 0.25, z: 0.7 },
  ];
  const { body, wheels } = partitionIndexedTriangles(positions, indices, hubs, 0.45);
  assert.equal(wheels[0].length, 3);
  assert.equal(wheels[1].length, 3);
  assert.equal(wheels[2].length, 3);
  assert.equal(wheels[3].length, 3);
  assert.equal(body.length, 3);
  assert.equal(WHEEL_CORNER_NAMES.length, 4);
  assert.equal(allWheelsExtractable(wheels, 1), true);
  assert.equal(allWheelsExtractable(wheels, MIN_WHEEL_TRIANGLES), false);
});

test('remapIndexedSubset drops unused vertices so a tyre bbox is not the whole car', () => {
  // 8 vertices in a 5 m span, but the wheel only uses the last four clustered
  // in 0.2 m. Without remapping, computeBoundingBox would still see all 8.
  const { count, indices } = remapIndexedSubset(8, [4, 5, 6, 4, 6, 7]);
  assert.equal(count, 4);
  assert.equal(indices.length, 6);
  assert.equal(Math.max(...indices), 3);
  assert.equal(Math.min(...indices), 0);
});

test('wheelScaleFromBox maps a tyre AABB onto the physics radius', () => {
  const R = 0.334;
  // Width, diameter, diameter — median is the diameter.
  assert.equal(wheelScaleFromBox(0.4, 0.8, 0.8, R), R / 0.4);
  // Already the right size is a no-op.
  assert.ok(Math.abs(wheelScaleFromBox(0.3, 2 * R, 2 * R, R) - 1) < 1e-9);
});

test('W14-sized front and rear tyres both scale onto the same radius', () => {
  // Measured after wheelbase fit: front 0.561×0.694×0.746, rear a bit larger.
  // Diameter is the median side, so both land on 0.334 m and keep their width.
  const R = 0.334;
  const front = wheelScaleFromBox(0.561, 0.694, 0.746, R);
  const rear = wheelScaleFromBox(0.587, 0.715, 0.771, R);
  const frontR = (0.694 / 2) * front;
  const rearR = (0.715 / 2) * rear;
  assert.ok(Math.abs(frontR - R) < 1e-9, `front ${frontR}`);
  assert.ok(Math.abs(rearR - R) < 1e-9, `rear ${rearR}`);
});

test('empty and malformed input are a no-op', () => {
  for (const bad of [[], null, undefined]) {
    const fit = planShellFit(bad, RIG);
    assert.equal(fit.scale, 1);
    assert.equal(fit.lift, 0);
    assert.equal(fit.method, 'none');
  }
});
