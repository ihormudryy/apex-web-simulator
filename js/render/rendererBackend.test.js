import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRendererMode,
  readStoredRendererPreference,
  RENDERER_PREF_KEY,
  resolveRendererMode,
  setRendererPreferenceAndReload,
  writeStoredRendererPreference,
} from './rendererBackend.js';

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      map.set(k, String(v));
    },
  };
}

test('parseRendererMode defaults to webgpu when unset', () => {
  assert.equal(parseRendererMode(''), 'webgpu');
  assert.equal(parseRendererMode('?foo=bar'), 'webgpu');
});

test('parseRendererMode selects mode from the URL flag', () => {
  assert.equal(parseRendererMode('?renderer=webgpu'), 'webgpu');
  assert.equal(parseRendererMode('?renderer=webgl'), 'webgl');
});

test('parseRendererMode uses stored preference when URL has no renderer', () => {
  assert.equal(parseRendererMode('', 'webgl'), 'webgl');
  assert.equal(parseRendererMode('?foo=1', 'webgpu'), 'webgpu');
});

test('parseRendererMode URL overrides stored preference', () => {
  assert.equal(parseRendererMode('?renderer=webgl', 'webgpu'), 'webgl');
  assert.equal(parseRendererMode('?renderer=webgpu', 'webgl'), 'webgpu');
});

test('read/writeStoredRendererPreference round-trip webgl and webgpu', () => {
  const storage = memoryStorage();
  assert.equal(readStoredRendererPreference(storage), null);

  writeStoredRendererPreference('webgl', storage);
  assert.equal(storage.getItem(RENDERER_PREF_KEY), 'webgl');
  assert.equal(readStoredRendererPreference(storage), 'webgl');

  writeStoredRendererPreference('webgpu', storage);
  assert.equal(readStoredRendererPreference(storage), 'webgpu');
});

test('writeStoredRendererPreference ignores invalid modes', () => {
  const storage = memoryStorage({ [RENDERER_PREF_KEY]: 'webgpu' });
  writeStoredRendererPreference('metal', storage);
  assert.equal(readStoredRendererPreference(storage), 'webgpu');
});

test('resolveRendererMode: default webgpu, localStorage, URL override', () => {
  assert.equal(resolveRendererMode({ search: '', storage: null }), 'webgpu');
  assert.equal(
    resolveRendererMode({ search: '', storage: memoryStorage({ [RENDERER_PREF_KEY]: 'webgl' }) }),
    'webgl',
  );
  assert.equal(
    resolveRendererMode({
      search: '?renderer=webgpu',
      storage: memoryStorage({ [RENDERER_PREF_KEY]: 'webgl' }),
    }),
    'webgpu',
  );
  assert.equal(
    resolveRendererMode({
      search: '?renderer=webgl',
      storage: memoryStorage({ [RENDERER_PREF_KEY]: 'webgpu' }),
    }),
    'webgl',
  );
});

test('setRendererPreferenceAndReload persists and navigates with renderer param', () => {
  const storage = memoryStorage();
  let assigned = null;
  setRendererPreferenceAndReload('webgl', {
    storage,
    href: 'http://example.test/app/?foo=1',
    assign: (url) => {
      assigned = url;
    },
  });
  assert.equal(readStoredRendererPreference(storage), 'webgl');
  assert.equal(assigned, '/app/?foo=1&renderer=webgl');
});
