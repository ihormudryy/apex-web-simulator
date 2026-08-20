import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unpackBinMesh } from './binMesh.js';

const objJs = join(dirname(fileURLToPath(import.meta.url)), '../obj/js');

function load(name) {
  const raw = readFileSync(join(objJs, name));
  const inflated = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw;
  return unpackBinMesh(inflated.buffer.slice(inflated.byteOffset, inflated.byteOffset + inflated.byteLength));
}

function vertexCount(mesh) {
  return mesh.position.length / 3;
}

test('GlossyBlack mixed UV/non-UV faces still emit one uv per vertex', () => {
  const mesh = load('GlossyBlack.bin');
  const n = vertexCount(mesh);
  assert.ok(n > 0);
  assert.equal(mesh.normal.length / 3, n);
  assert.ok(mesh.uv, 'carbon parts need UVs for the normal map');
  assert.equal(mesh.uv.length / 2, n);
});

test('Chrome mixed UV/non-UV faces still emit one uv per vertex', () => {
  const mesh = load('Chrome.bin');
  const n = vertexCount(mesh);
  assert.equal(mesh.uv.length / 2, n);
  assert.equal(mesh.normal.length / 3, n);
});

test('all-UV meshes keep matching attribute counts', () => {
  const mesh = load('Tyre.bin');
  const n = vertexCount(mesh);
  assert.equal(mesh.uv.length / 2, n);
  assert.equal(mesh.normal.length / 3, n);
});

test('meshes with no UVs omit the uv buffer', () => {
  const mesh = load('Suspension.bin');
  assert.equal(mesh.uv, null);
  assert.equal(mesh.normal.length / 3, vertexCount(mesh));
});
