import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAR_CATALOG, DEFAULT_CAR_ID, carById, readStoredCarId, writeStoredCarId,
} from './carCatalog.js';

// Node has no reliable global `localStorage` (see the tolerant no-arg test
// below), so the legacy-id tests inject a fake one — the same shape
// `RivalPanel.test.js` and `physicsMode.js` use — to actually exercise the
// mapping instead of just falling through to DEFAULT_CAR_ID by accident.
function fakeStorage(seed = {}) {
  const m = { ...seed };
  return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = v; } };
}

test('catalog is the bundled Apex GT1 plus the two downloaded 2023 shells', () => {
  assert.equal(DEFAULT_CAR_ID, 'apex');
  assert.equal(carById('apex').url, null);
  assert.match(carById('apex').label, /apex/i);
  assert.equal(CAR_CATALOG[0].id, 'apex', 'the bundled car stays first and selected');
  assert.equal(carById('rb8'), undefined, 'RB8 is not in the Downloads set');
  assert.equal(carById('ferrari'), undefined, 'the trademarked id was renamed away, not aliased');

  const amr = carById('amr23');
  const w14 = carById('w14');
  assert.equal(amr.url, 'obj/cars/amr23/scene.gltf');
  assert.equal(w14.url, 'obj/cars/w14/scene.gltf');
  assert.equal(amr.hasOwnWheels, true);
  assert.equal(w14.hasOwnWheels, false);
  for (const e of [amr, w14]) {
    assert.ok(e.sourceUrl.includes('sketchfab.com'));
    assert.ok(e.attribution.length > 4);
  }
});

test('unknown id returns undefined', () => {
  assert.equal(carById('nope'), undefined);
});

test('legacy stored id "default" maps to the bundled car', () => {
  const storage = fakeStorage({ 'helloracer.carId': 'default' });
  assert.equal(readStoredCarId(storage), DEFAULT_CAR_ID);
});

test('legacy stored id "ferrari" (pre-rename) maps to the bundled car', () => {
  // The bundled catalog id was renamed away from a real trademarked marque
  // (Finding 2: "No trademarked branding in user-facing strings"). A saved
  // "ferrari" pick from before the rename must still resolve to the same
  // bundled car via an explicit mapping — the same shape as the "default"
  // shim above — not silently orphan into whatever DEFAULT_CAR_ID happens
  // to be today.
  const storage = fakeStorage({ 'helloracer.carId': 'ferrari' });
  assert.equal(readStoredCarId(storage), DEFAULT_CAR_ID);
  assert.equal(readStoredCarId(storage), 'apex');
});

test('an unrecognised stored id falls back to the default, not through', () => {
  const storage = fakeStorage({ 'helloracer.carId': 'mclaren' });
  assert.equal(readStoredCarId(storage), DEFAULT_CAR_ID);
});

test('a fresh pick round-trips through an injected storage', () => {
  const storage = fakeStorage();
  writeStoredCarId('w14', storage);
  assert.equal(readStoredCarId(storage), 'w14');
});

test('stored car id round-trips when localStorage exists', () => {
  // Node test env may lack localStorage — read falls back to default.
  const before = readStoredCarId();
  assert.ok(typeof before === 'string');
  writeStoredCarId('w14');
  const after = readStoredCarId();
  // In browsers this would be w14; in Node without storage it stays default.
  assert.ok(after === 'w14' || after === DEFAULT_CAR_ID);
});
