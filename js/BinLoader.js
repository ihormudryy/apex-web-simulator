import * as THREE from 'three';
import { unpackBinMesh } from './binMesh.js';

// Parser for the legacy Three.js .bin mesh format (optionally gzip-compressed).
export class BinLoader {
  static parse(buf) {
    const mesh = unpackBinMesh(buf);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(mesh.position, 3));
    if (mesh.normal) geo.setAttribute('normal', new THREE.BufferAttribute(mesh.normal, 3));
    else geo.computeVertexNormals();
    if (mesh.uv) geo.setAttribute('uv', new THREE.BufferAttribute(mesh.uv, 2));
    return geo;
  }

  static async _inflateGzip(buffer) {
    const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).arrayBuffer();
  }

  /**
   * Parsed geometry, keyed by url.
   *
   * Two cars on track load the same body and the same four tyres. Without this
   * the second car refetches, re-inflates and re-uploads every one of them, for
   * an identical result and a doubled GPU footprint.
   */
  static _cache = new Map();
  static _pending = new Map();

  static clearCache() {
    BinLoader._cache.clear();
    BinLoader._pending.clear();
  }

  static load(url, callback) {
    const cached = BinLoader._cache.get(url);
    if (cached) { callback(cached); return; }
    const inflight = BinLoader._pending.get(url);
    if (inflight) { inflight.then(callback); return; }

    const job = fetch(url)
      .then(async r => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        let buf = await r.arrayBuffer();
        const bytes = new Uint8Array(buf);
        if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
          buf = await BinLoader._inflateGzip(buf);
        }
        return buf;
      })
      .then(buf => {
        const geo = BinLoader.parse(buf);
        BinLoader._cache.set(url, geo);
        BinLoader._pending.delete(url);
        return geo;
      })
      .catch(e => {
        BinLoader._pending.delete(url);
        console.error('Failed to load', url, e);
        throw e;
      });

    BinLoader._pending.set(url, job);
    job.then(callback).catch(() => {});
  }
}
