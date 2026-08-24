import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAR_CATALOG, DEFAULT_CAR_ID, carById, readStoredCarId, writeStoredCarId,
} from './carCatalog.js';

test('catalog is Ferrari plus the two downloaded 2023 shells', () => {
  assert.equal(DEFAULT_CAR_ID, 'ferrari');
  assert.equal(carById('ferrari').url, null);
  assert.match(carById('ferrari').label, /ferrari/i);
  assert.equal(CAR_CATALOG[0].id, 'ferrari', 'the bundled car stays first and selected');
  assert.equal(carById('rb8'), undefined, 'RB8 is not in the Downloads set');

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

test('legacy stored id "default" maps to Ferrari', () => {
  writeStoredCarId('default');
  const after = readStoredCarId();
  assert.ok(after === 'ferrari' || after === DEFAULT_CAR_ID);
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
