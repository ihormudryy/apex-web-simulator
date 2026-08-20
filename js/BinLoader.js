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

  static load(url, callback) {
    fetch(url)
      .then(async r => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        let buf = await r.arrayBuffer();
        const bytes = new Uint8Array(buf);
        if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
          buf = await BinLoader._inflateGzip(buf);
        }
        return buf;
      })
      .then(buf => callback(BinLoader.parse(buf)))
      .catch(e => console.error('Failed to load', url, e));
  }
}
