/**
 * Scene-graph regression tests: the composed three.js transforms, measured.
 *
 * Every wheel-placement bug this project has had lived in transform
 * composition — double-applied yaw, a mesh origin that is not the CoG,
 * axle rotations copied from a differently-oriented frame, an Euler gimbal
 * lock that ate roll. None of it was reachable by the pure-math tests, so it
 * all shipped. These tests build the REAL Car (vendored three via
 * scripts/test-setup.mjs), drive the REAL physics on the real Silverstone
 * centerline, and assert world-space facts — several of them against the
 * authored .bin meshes, which are the ground truth the eye compares against.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { Car } from './Car.js';
import { unpackBinMesh } from './binMesh.js';
import { buildCenterline } from './track/centerline.js';
import { SILVERSTONE_WAYPOINTS } from './track/silverstoneWaypoints.js';
import { LF, LR, MASS, G, WB } from './physics/constants.js';
import { WHEEL_RADIUS } from './physics/wheel.js';
import {
  TYRE_CONTACT_RADIUS, AUTHORED_TRACK_HALF, MESH_FORWARD_OFFSET,
  chassisAttitudeRotation, staticRakePitch, WHEEL_MESH_YAW,
  suspensionHubOffset, tyreSquash, tyreSquashDrop,
} from './render/wheelVisual.js';

const here = dirname(fileURLToPath(import.meta.url));

function loadBin(name) {
  const raw = readFileSync(join(here, '../obj/js', name));
  const inflated = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw;
  return unpackBinMesh(inflated.buffer.slice(inflated.byteOffset, inflated.byteOffset + inflated.byteLength));
}

function bbox(position) {
  const mn = [Infinity, Infinity, Infinity];
  const mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < position.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      mn[k] = Math.min(mn[k], position[i + k]);
      mx[k] = Math.max(mx[k], position[i + k]);
    }
  }
  return { mn, mx };
}

/** The circuit as the physics sees it — flat, so rest heights are exact. */
function flatSilverstone() {
  const centerline = buildCenterline(SILVERSTONE_WAYPOINTS, 4000);
  let hint = 0;
  return {
    centerline,
    query(x, z) {
      const r = centerline.query(x, z, hint);
      hint = r.index;
      return r;
    },
  };
}

/**
 * A real Car at the real grid, settled. The spawn yaw at Silverstone is
 * ~159° — the pose that exposed the double-applied yaw, which a yaw-0 test
 * cannot see.
 */
function carOnTheGrid() {
  const scene = new THREE.Scene();
  const car = new Car(scene, { backend: 'webgl' });
  const track = flatSilverstone();
  const s = track.centerline.samples[0];
  const yaw = Math.atan2(-s.tx, -s.tz);
  car.resetRace(s.x, s.z, yaw);
  for (let i = 0; i < 120; i++) {
    car.updateSteering(1 / 120);
    car.updatePhysics(1 / 120, track);
  }
  scene.updateMatrixWorld(true);
  return { car, yaw };
}

/** World position of a node, expressed in the car frame (fwd, right, y). */
function carFrame(car, yaw, node) {
  const p = new THREE.Vector3();
  node.getWorldPosition(p);
  const dx = p.x - car.root.position.x;
  const dz = p.z - car.root.position.z;
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  const rx = Math.cos(yaw), rz = -Math.sin(yaw);
  return { fwd: dx * fx + dz * fz, right: dx * rx + dz * rz, y: p.y };
}

const grid = carOnTheGrid();

test('vendored three matches the version index.html pins', () => {
  const html = readFileSync(join(here, '../index.html'), 'utf8');
  const pinned = html.match(/three@0\.(\d+)\.\d+/);
  assert.ok(pinned, 'index.html pins a three version');
  assert.equal(THREE.REVISION, pinned[1],
    'test/vendor/three must be the same build the page loads');
});

test('at the grid, each wheel sits at its own corner of the car', () => {
  const { car, yaw } = grid;
  const corners = [
    { node: car.lfw, fwd: LF, right: -AUTHORED_TRACK_HALF, name: 'FL' },
    { node: car.rfw, fwd: LF, right: AUTHORED_TRACK_HALF, name: 'FR' },
    { node: car.lrw, fwd: -LR, right: -AUTHORED_TRACK_HALF, name: 'RL' },
    { node: car.rrw, fwd: -LR, right: AUTHORED_TRACK_HALF, name: 'RR' },
  ];
  for (const c of corners) {
    const p = carFrame(car, yaw, c.node);
    assert.ok(Math.abs(p.fwd - c.fwd) < 0.01,
      `${c.name} forward ${p.fwd.toFixed(3)} vs ${c.fwd.toFixed(3)} — a miss here is the double-yaw swap`);
    assert.ok(Math.abs(p.right - c.right) < 0.01,
      `${c.name} lateral ${p.right.toFixed(3)} vs ${c.right.toFixed(3)}`);
  }
});

test('at the grid, every tyre touches the road', () => {
  const { car, yaw } = grid;
  const tyre = bbox(loadBin('Tyre.bin').position);
  const authoredRadius = tyre.mx[1];
  assert.ok(Math.abs(authoredRadius - WHEEL_RADIUS) < 0.001,
    'authored tyre radius is the physics radius');
  assert.equal(TYRE_CONTACT_RADIUS, WHEEL_RADIUS);
  for (const w of [car.lfw, car.rfw, car.lrw, car.rrw]) {
    const p = carFrame(car, yaw, w);
    const gap = p.y - TYRE_CONTACT_RADIUS;
    assert.ok(Math.abs(gap) < 0.015,
      `tyre bottom ${(gap * 1000).toFixed(1)} mm off a flat road at rest`);
  }
});

test('wheel-mesh yaw keeps every axle lateral', () => {
  // The tyre is authored with the axle along X (its X extent is the tread
  // width, smaller than the radius); the per-corner mesh yaw must map that
  // axle onto ±X, never fore-aft — the perpendicular-wheels bug.
  const tyre = bbox(loadBin('Tyre.bin').position);
  assert.ok(tyre.mx[0] < tyre.mx[1] && tyre.mx[0] < tyre.mx[2],
    'authored axle runs along X');
  for (let i = 0; i < 4; i++) {
    const axle = new THREE.Vector3(1, 0, 0)
      .applyMatrix4(new THREE.Matrix4().makeRotationY(WHEEL_MESH_YAW[i]));
    assert.ok(Math.abs(axle.z) < 1e-12 && Math.abs(Math.abs(axle.x) - 1) < 1e-12,
      `corner ${i}: axle must stay lateral, got (${axle.x.toFixed(3)}, ${axle.z.toFixed(3)})`);
  }
});

test('the suspension mesh reaches the wheels it is drawn with', () => {
  // Outboard wishbone vertices from the authored Suspension.bin, pushed
  // through the REAL body transform (part offset from Car.js's bodyParts
  // table), then compared per corner against the rendered wheel hubs. This is
  // the check that catches both the CoG/mesh-origin offset and the
  // physics-vs-authored track split regressing.
  const { car, yaw } = grid;
  const mesh = loadBin('Suspension.bin');
  const part = new THREE.Vector3(0, 0.4044, -0.3071); // Car.js bodyParts.Suspension
  const clusters = { FL: [], FR: [], RL: [], RR: [] };
  const v = new THREE.Vector3();
  for (let i = 0; i < mesh.position.length; i += 3) {
    v.set(mesh.position[i], mesh.position[i + 1], mesh.position[i + 2]).add(part);
    car.body.localToWorld(v);
    const dx = v.x - car.root.position.x;
    const dz = v.z - car.root.position.z;
    const fwd = dx * -Math.sin(yaw) + dz * -Math.cos(yaw);
    const right = dx * Math.cos(yaw) + dz * -Math.sin(yaw);
    if (Math.abs(right) < 0.55) continue; // keep only the outboard ends
    clusters[(fwd > 0 ? 'F' : 'R') + (right < 0 ? 'L' : 'R')].push({ fwd, right });
  }
  const rim = bbox(loadBin('Rim.bin').position);
  const rimHalfWidth = rim.mx[0];
  const wheels = { FL: car.lfw, FR: car.rfw, RL: car.lrw, RR: car.rrw };
  for (const [name, pts] of Object.entries(clusters)) {
    assert.ok(pts.length > 50, `${name}: found the outboard wishbone cluster`);
    const hub = carFrame(car, yaw, wheels[name]);
    const cFwd = pts.reduce((s, p) => s + p.fwd, 0) / pts.length;
    const tip = Math.max(...pts.map(p => Math.abs(p.right)));
    // The centroid moves a few cm with the outboard cutoff (uprights, arms and
    // ducts all live out here), so the tolerance is loose — the regressions it
    // guards against are the 0.44 m CoG offset and a front/rear swap.
    assert.ok(Math.abs(cFwd - hub.fwd) < 0.12,
      `${name}: wishbones at fwd ${cFwd.toFixed(3)}, wheel at ${hub.fwd.toFixed(3)}`);
    assert.ok(tip > Math.abs(hub.right) - rimHalfWidth,
      `${name}: wishbone tip |${tip.toFixed(3)}| must reach inside the rim `
      + `(inner face at ${(Math.abs(hub.right) - rimHalfWidth).toFixed(3)})`);
  }
});

test('the body sits nose-down at rest and rolls right-side-down on positive roll', () => {
  const { car, yaw } = grid;
  assert.ok(Math.abs(car.attitude.rotation.x - staticRakePitch()) < 0.005,
    'settled attitude is the static rake');
  assert.ok(Math.abs(car.attitude.rotation.z) < 0.005, 'no roll at rest');

  // Probe points in mesh space: nose +Z, tail -Z, right side -X.
  const probe = (x, y, z) => {
    const o = new THREE.Object3D();
    o.position.set(x, y, z);
    car.body.add(o);
    return o;
  };
  const nose = probe(0, 0.3, 2.4), tail = probe(0, 0.3, -2.4);
  const right = probe(-0.8, 0.3, 0), left = probe(0.8, 0.3, 0);
  const y = o => { const p = new THREE.Vector3(); o.getWorldPosition(p); return p.y; };

  car.root.updateMatrixWorld(true);
  assert.ok(y(nose) < y(tail), 'static rake is nose-DOWN');

  const att = chassisAttitudeRotation(0, 0.05); // physics: right side down
  car.attitude.rotation.x = att.x;
  car.attitude.rotation.z = att.z;
  car.root.updateMatrixWorld(true);
  assert.ok(y(right) < y(left), 'positive physics roll drops the RIGHT side');

  const dive = chassisAttitudeRotation(-0.02, 0); // braking pitch
  car.attitude.rotation.x = dive.x;
  car.attitude.rotation.z = dive.z;
  car.root.updateMatrixWorld(true);
  const rakeOnly = chassisAttitudeRotation(0, 0);
  assert.ok(dive.x < rakeOnly.x && y(nose) < y(tail), 'braking dives the nose further');
});

test('under aero load the hubs drop by the tyre squash, keeping contact', () => {
  // At speed the downforce loads the tyres past their static Fz; the squash
  // flattens the mesh about the wheel centre, so the centre must sink by the
  // radius the bottom loses. Full throttle down the Hamilton straight builds
  // real aero load; the hub height is then checked against the same kernel
  // loads and helpers the renderer uses.
  const scene = new THREE.Scene();
  const car = new Car(scene, { backend: 'webgl' });
  const track = flatSilverstone();
  const s = track.centerline.samples[0];
  car.resetRace(s.x, s.z, Math.atan2(-s.tx, -s.tz));
  car.input.forward = true;
  for (let i = 0; i < 360; i++) { // 3 s flat out
    car.updateSteering(1 / 120);
    car.updatePhysics(1 / 120, track);
  }
  assert.ok(car.speed() > 20, 'the car got up to speed');

  const sim = car.simState();
  const susp = car.vehicle.car.suspension;
  const baseFzF = MASS * G * LR / WB;
  const squashF = tyreSquash((sim.fz[0] + sim.fz[1] - baseFzF) / baseFzF);
  assert.ok(squashF > 0.001, 'aero load squashes the front tyres');

  // Wheel local y is ground-anchored: contact radius above the (flat, 0-high)
  // road minus the chassis height the root already carries, plus the live
  // suspension offset — and now minus the squash drop.
  const wheels = [car.lfw, car.rfw];
  for (let i = 0; i < 2; i++) {
    const expected = TYRE_CONTACT_RADIUS - sim.chassisY
      + suspensionHubOffset(susp, i) - tyreSquashDrop(squashF);
    assert.ok(Math.abs(wheels[i].position.y - expected) < 1e-9,
      `front hub ${wheels[i].position.y.toFixed(4)} vs ${expected.toFixed(4)} — `
      + 'a loaded tyre must sink, not shrink in place');
  }
});

test('the front wheels steer and the rears do not', () => {
  const { car, yaw } = grid;
  car.input.left = true;
  for (let i = 0; i < 60; i++) {
    car.updateSteering(1 / 120);
    car.updatePhysics(1 / 120, flatSilverstone());
  }
  car.input.left = false;
  assert.ok(Math.abs(car.lfw.rotation.y) > 0.05, 'front wheels turned');
  assert.equal(car.lrw.rotation.y, 0, 'rear wheels did not');
  assert.equal(car.rrw.rotation.y, 0, 'rear wheels did not');
});
