import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  wingWeights, deformBody, wheelCollapse, paintWear, damageSignature,
  crumpleHash, WING_Z_FROM, WING_Y_FULL, Y_FLOOR, DROOP_FULL, NO_MESH_DAMAGE,
} from './meshDamage.js';

/** A toy body: one wing vertex, one nose vertex, one cockpit vertex. */
function toyBody() {
  const positions = new Float32Array([
    0.4, -0.50, 2.4,     // wing slab, right side
    -0.4, -0.50, 2.4,    // wing slab, left side
    0.0, -0.20, 2.5,     // nose tip, above the wing
    0.0, 0.30, -0.5,     // cockpit
  ]);
  return { positions, count: 4 };
}

test('the wing region is the low front slab, not the cockpit', () => {
  const { positions, count } = toyBody();
  const r = wingWeights(positions, count);
  assert.ok(r.weight[0] > 0.9, `wing vertex weighted ${r.weight[0]}`);
  assert.ok(r.weight[2] > 0 && r.weight[2] < 0.5, 'the nose gets a partial weight');
  assert.equal(r.weight[3], 0, 'the cockpit must not deform');
});

test('leftness tells the two sides apart', () => {
  const { positions, count } = toyBody();
  const r = wingWeights(positions, count);
  assert.ok(r.leftness[1] > 0.8, 'negative x is the left side');
  assert.ok(r.leftness[0] < 0.2);
});

test('no damage is a bit-exact copy of the base', () => {
  const { positions, count } = toyBody();
  const r = wingWeights(positions, count);
  const out = new Float32Array(positions.length);
  deformBody(positions, out, r, { wing: 0, left: 0, right: 0 });
  assert.deepEqual([...out], [...positions]);
});

test('wing damage droops the wing and leaves the cockpit alone', () => {
  const { positions, count } = toyBody();
  const r = wingWeights(positions, count);
  const out = new Float32Array(positions.length);
  deformBody(positions, out, r, { wing: 1, left: 0, right: 0 });
  assert.ok(out[1] < positions[1] - 0.02, `wing y ${positions[1]} -> ${out[1]}`);
  assert.equal(out[10], positions[10], 'cockpit y untouched');
  assert.equal(out[9], positions[9]);
});

test('the side that took the hits hangs lower', () => {
  const { positions, count } = toyBody();
  const r = wingWeights(positions, count);
  const out = new Float32Array(positions.length);
  deformBody(positions, out, r, { wing: 0.8, left: 1, right: 0 });
  const leftDrop = positions[4] - out[4];     // vertex 1 y
  const rightDrop = positions[1] - out[1];    // vertex 0 y
  assert.ok(leftDrop > rightDrop * 1.3, `left ${leftDrop.toFixed(3)} vs right ${rightDrop.toFixed(3)}`);
});

test('nothing deforms below the floor', () => {
  const { positions, count } = toyBody();
  const r = wingWeights(positions, count);
  const out = new Float32Array(positions.length);
  deformBody(positions, out, r, { wing: 1, left: 1, right: 1 });
  for (let i = 0; i < count; i++) {
    // Math.fround: the clamp is exact in float64 but the output array is
    // float32, which rounds -0.62 a hair below the constant.
    assert.ok(out[i * 3 + 1] >= Math.fround(Y_FLOOR), `vertex ${i} at y ${out[i * 3 + 1]}`);
  }
});

test('a crumple is the same crumple every time', () => {
  assert.equal(crumpleHash(42, 3), crumpleHash(42, 3));
  assert.notEqual(crumpleHash(42, 3), crumpleHash(43, 3));
  for (let i = 0; i < 200; i++) {
    const h = crumpleHash(i, 7);
    assert.ok(h >= -1 && h <= 1);
  }
});

test('a broken wheel is obviously broken, a nicked one barely leans', () => {
  const nicked = wheelCollapse(0.15);
  const broken = wheelCollapse(1);
  assert.ok(nicked.camber < 0.03, `${nicked.camber} rad at 15%`);
  assert.ok(broken.camber > 0.25, `${broken.camber} rad broken`);
  assert.ok(broken.lift > 0.03);
  assert.equal(wheelCollapse(0).camber, 0);
});

test('paint wear is a multiplier pair that reset can undo exactly', () => {
  const clean = paintWear(0);
  assert.equal(clean.roughnessScale, 1);
  assert.equal(clean.clearcoatScale, 1);
  const wrecked = paintWear(2.4);
  assert.ok(wrecked.roughnessScale > 1.5);
  assert.ok(wrecked.clearcoatScale < 0.5 && wrecked.clearcoatScale > 0);
});

test('the signature only changes when the damage meaningfully does', () => {
  const a = damageSignature({ wing: 0.5, floor: 0, wheels: [0, 0, 0, 0] });
  const same = damageSignature({ wing: 0.5001, floor: 0, wheels: [0, 0, 0, 0] });
  const different = damageSignature({ wing: 0.55, floor: 0, wheels: [0, 0, 0, 0] });
  assert.equal(a, same);
  assert.notEqual(a, different);
});

test('NO_MESH_DAMAGE is the zero signature', () => {
  assert.equal(damageSignature(NO_MESH_DAMAGE), '0|0|0,0,0,0');
  assert.equal(paintWear(NO_MESH_DAMAGE.total).roughnessScale, 1);
  assert.equal(wheelCollapse(0).camber, 0);
});
