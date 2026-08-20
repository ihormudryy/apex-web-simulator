import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeOnBeforeCompile } from './composeOnBeforeCompile.js';

test('the injection runs even when something assigns onBeforeCompile later', () => {
  const order = [];
  const material = {};
  composeOnBeforeCompile(material, () => order.push('inject'), 'tag');
  // This is what CSM.setupMaterial does, and it used to win outright.
  material.onBeforeCompile = () => order.push('csm');
  material.onBeforeCompile({}, {});
  assert.deepEqual(order, ['inject', 'csm']);
});

test('the injection still runs when nothing else is assigned', () => {
  const order = [];
  const material = {};
  composeOnBeforeCompile(material, () => order.push('inject'), 'tag');
  material.onBeforeCompile({}, {});
  assert.deepEqual(order, ['inject']);
});

test('the late function receives the shader and the material as `this`', () => {
  const material = { marker: 'mine' };
  let seen = null;
  composeOnBeforeCompile(material, () => {}, 'tag');
  material.onBeforeCompile = function (shader) { seen = { shader, self: this.marker }; };
  const shader = { uniforms: {} };
  material.onBeforeCompile(shader, {});
  assert.equal(seen.shader, shader);
  assert.equal(seen.self, 'mine', 'CSM reads closure state but other code may use `this`');
});

test('the cache key records whether a late function is present', () => {
  const material = {};
  composeOnBeforeCompile(material, () => {}, 'grassWind');
  assert.equal(material.customProgramCacheKey(), 'grassWind|plain');
  material.onBeforeCompile = () => {};
  assert.equal(material.customProgramCacheKey(), 'grassWind|late');
});

test('the wrapper source is stable across reads', () => {
  // The renderer keys compiled programs partly on this function's text; a new
  // source string per read would recompile the shader every frame.
  const material = {};
  composeOnBeforeCompile(material, () => {}, 'tag');
  assert.equal(String(material.onBeforeCompile), String(material.onBeforeCompile));
});

test('a second assignment replaces the first, and the injection survives both', () => {
  const order = [];
  const material = {};
  composeOnBeforeCompile(material, () => order.push('inject'), 'tag');
  material.onBeforeCompile = () => order.push('first');
  material.onBeforeCompile = () => order.push('second');
  material.onBeforeCompile({}, {});
  assert.deepEqual(order, ['inject', 'second']);
});
