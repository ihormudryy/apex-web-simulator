/**
 * Shared glTF prep for drop-in cars and scenery.
 * Pure Three helpers — used by the drop zone and the car catalog loader.
 */

import * as THREE from 'three';

/**
 * Centre on XZ, plant on Y=0, and rescale tiny/huge exports into metres.
 * @param {THREE.Object3D} root
 */
export function normalizeToGround(root) {
  const box = new THREE.Box3().setFromObject(root);
  if (box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3());
  root.position.x -= center.x;
  root.position.z -= center.z;
  root.position.y -= box.min.y;
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  // Authoring tools often export centimetres or millimetres.
  if (maxDim > 0.01 && maxDim < 0.5) root.scale.setScalar(4 / maxDim);
  if (maxDim > 400) root.scale.setScalar(200 / maxDim);
}

/**
 * Enable shadows on every mesh in a loaded glTF subtree.
 * @param {THREE.Object3D} root
 */
export function enableGltfShadows(root) {
  root.traverse(o => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
}
