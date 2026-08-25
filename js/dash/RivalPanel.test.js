import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RIVAL_PREF_KEY, LEGACY_RIVAL_PREF_KEY,
  readStoredRivalLevel, writeStoredRivalLevel, resolveRivalLevel,
} from './RivalPanel.js';
import { DIFFICULTY_ORDER } from '../race/aiDriver.js';

function fakeStorage(seed = {}) {
  const m = { ...seed };
  return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = v; } };
}

test('resolveRivalLevel defaults to pro for anything invalid', () => {
  assert.equal(resolveRivalLevel(null), 'pro');
  assert.equal(resolveRivalLevel(undefined), 'pro');
  assert.equal(resolveRivalLevel('nonsense'), 'pro');
  for (const id of DIFFICULTY_ORDER) assert.equal(resolveRivalLevel(id), id);
});

test('stored rival level round-trips through the apex-web-simulator key', () => {
  const storage = fakeStorage();
  writeStoredRivalLevel('ace', storage);
  assert.equal(storage.getItem(RIVAL_PREF_KEY), 'ace');
  assert.equal(readStoredRivalLevel(storage), 'ace');
});

test('an invalid level is never written or read back', () => {
  const storage = fakeStorage();
  writeStoredRivalLevel('legendary', storage);
  assert.equal(storage.getItem(RIVAL_PREF_KEY), null);
  assert.equal(readStoredRivalLevel(storage), null);
});

test('a legacy helloracer.* key is read as a fallback, not preferred over the new key', () => {
  const legacyOnly = fakeStorage({ [LEGACY_RIVAL_PREF_KEY]: 'club' });
  assert.equal(readStoredRivalLevel(legacyOnly), 'club');

  const both = fakeStorage({ [RIVAL_PREF_KEY]: 'ace', [LEGACY_RIVAL_PREF_KEY]: 'club' });
  assert.equal(readStoredRivalLevel(both), 'ace');
});

test('readStoredRivalLevel tolerates a denying storage (private mode)', () => {
  const angry = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('denied'); },
  };
  assert.equal(readStoredRivalLevel(angry), null);
  assert.doesNotThrow(() => writeStoredRivalLevel('pro', angry));
});
