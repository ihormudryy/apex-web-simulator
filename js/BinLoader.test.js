import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BinLoader } from './BinLoader.js';

test('the same url is parsed once and handed out again', async () => {
  BinLoader.clearCache();
  let fetches = 0;
  const original = globalThis.fetch;
  const fake = new Uint8Array([1, 2, 3]);
  globalThis.fetch = async () => {
    fetches++;
    return { ok: true, arrayBuffer: async () => fake.buffer };
  };
  const originalParse = BinLoader.parse;
  BinLoader.parse = () => ({ marker: 'geometry' });
  try {
    const a = await new Promise(res => BinLoader.load('obj/js/Body.bin', res));
    const b = await new Promise(res => BinLoader.load('obj/js/Body.bin', res));
    assert.equal(fetches, 1, 'second load refetched instead of using the cache');
    assert.equal(a, b, 'second load returned a different geometry instance');
  } finally {
    globalThis.fetch = original;
    BinLoader.parse = originalParse;
  }
});

test('two loads issued before the first fetch resolves still coalesce into one fetch', async () => {
  // The sequential test above only exercises the warm-cache path: by the time
  // its second `load()` runs, the first has already resolved and `_cache`
  // satisfies it before `_pending` is ever consulted. A cache with no
  // in-flight coalescing at all would pass that test identically. This one
  // holds the fetch open with a deferred promise so both `load()` calls are
  // guaranteed to land while the first request is still outstanding — the
  // case two cars built in the same frame actually hit.
  BinLoader.clearCache();
  let fetches = 0;
  const original = globalThis.fetch;
  const fake = new Uint8Array([4, 5, 6]);
  let releaseFetch;
  const gate = new Promise(res => { releaseFetch = res; });
  globalThis.fetch = async () => {
    fetches++;
    await gate;
    return { ok: true, arrayBuffer: async () => fake.buffer };
  };
  const originalParse = BinLoader.parse;
  BinLoader.parse = () => ({ marker: 'geometry' });
  try {
    const pendingA = new Promise(res => BinLoader.load('obj/js/Concurrent.bin', res));
    const pendingB = new Promise(res => BinLoader.load('obj/js/Concurrent.bin', res));
    assert.equal(fetches, 1, 'the second load issued its own fetch instead of joining the first');
    releaseFetch();
    const [a, b] = await Promise.all([pendingA, pendingB]);
    assert.equal(fetches, 1, 'two in-flight loads issued more than one fetch');
    assert.equal(a, b, 'two in-flight loads returned different geometry instances');
  } finally {
    globalThis.fetch = original;
    BinLoader.parse = originalParse;
  }
});
