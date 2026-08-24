import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkeredFinishAlbedo } from './finishGantry.js';

test('checkered finish alternates black and white cells', () => {
  const data = checkeredFinishAlbedo(128, 32);
  assert.equal(data.length, 128 * 32 * 4);
  const a = data[0];
  const cellW = 128 / 16;
  const b = data[Math.floor(cellW) * 4];
  assert.ok(Math.abs(a - b) > 100, `adjacent cells should contrast: ${a} vs ${b}`);
  assert.equal(data[3], 255);
});
