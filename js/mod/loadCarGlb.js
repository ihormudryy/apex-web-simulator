/**
 * Load a catalog car glTF from a relative or absolute URL.
 */

import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { normalizeToGround, enableGltfShadows } from './normalizeGltf.js';

/**
 * @param {string} url
 * @param {{ loader?: import('three/addons/loaders/GLTFLoader.js').GLTFLoader }} [opts]
 * @returns {Promise<import('three').Object3D>}
 */
export async function loadCarGlb(url, { loader = new GLTFLoader() } = {}) {
  if (!url) throw new Error('loadCarGlb: url required');
  const gltf = await loader.loadAsync(url);
  const root = gltf.scene;
  normalizeToGround(root);
  enableGltfShadows(root);
  root.name = root.name || 'catalogCar';
  return root;
}

/**
 * Probe whether a catalog file is present (HEAD or GET fallback).
 * @param {string} url
 * @returns {Promise<boolean>}
 */
export async function carAssetExists(url) {
  if (!url) return false;
  try {
    const head = await fetch(url, { method: 'HEAD' });
    if (head.ok) return true;
    // Some static servers reject HEAD; try a range GET.
    const get = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' } });
    return get.ok || get.status === 206;
  } catch {
    return false;
  }
}
