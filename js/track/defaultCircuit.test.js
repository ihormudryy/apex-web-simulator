import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CIRCUIT_NAME, createDefaultCircuit } from './defaultCircuit.js';
import { createSilverstone } from './Silverstone.js';

test('default circuit uses a generic public name', () => {
  assert.equal(DEFAULT_CIRCUIT_NAME, 'Northamptonshire Circuit');
  assert.notEqual(DEFAULT_CIRCUIT_NAME.toLowerCase(), 'silverstone');
});

test('legacy Silverstone export aliases the default circuit factory', () => {
  assert.equal(createSilverstone, createDefaultCircuit);
});
