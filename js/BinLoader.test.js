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
