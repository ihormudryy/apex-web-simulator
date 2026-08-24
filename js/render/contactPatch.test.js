import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  contactPatchOpacity, softContactDiscRGBA,
  CONTACT_PATCH_OPACITY_CSM, CONTACT_PATCH_OPACITY_FULL,
  CONTACT_PATCH_SIZE, CONTACT_PATCH_Y,
} from './contactPatch.js';

test('full static load is near peak opacity', () => {
  const full = contactPatchOpacity(2000, 2000, false);
  assert.ok(full > CONTACT_PATCH_OPACITY_FULL * 0.95);
  const csm = contactPatchOpacity(2000, 2000, true);
  assert.ok(csm < full);
  assert.ok(Math.abs(csm - CONTACT_PATCH_OPACITY_CSM) < 0.05);
});

test('an unloaded wheel leaves no contact disc', () => {
  assert.equal(contactPatchOpacity(0, 2000, false), 0);
  assert.equal(contactPatchOpacity(-10, 2000, false), 0);
});

test('light load still shows a faint contact', () => {
  const light = contactPatchOpacity(400, 2000, false);
  assert.ok(light > 0.15 && light < CONTACT_PATCH_OPACITY_FULL * 0.5);
});

test('the soft disc is dark in the centre and white at the edge', () => {
  const { data, size } = softContactDiscRGBA(32);
  assert.equal(data.length, 32 * 32 * 4);
  const mid = ((size >> 1) * size + (size >> 1)) * 4;
  const corner = 0;
  assert.ok(data[mid] < 80, `centre too bright: ${data[mid]}`);
  assert.ok(data[corner] > 240, `corner not white: ${data[corner]}`);
  assert.ok(CONTACT_PATCH_SIZE > 0.4 && CONTACT_PATCH_SIZE < 0.8);
  assert.ok(CONTACT_PATCH_Y > 0.02 && CONTACT_PATCH_Y < 0.03);
});
