import * as THREE from 'three';
import { planCatchFence } from './tracksidePlacements.js';

function fenceAlphaTexture() {
  const w = 128;
  const h = 64;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  const rows = 6;
  const cols = 12;
  for (let r = 0; r <= rows; r++) {
    const y = (r / rows) * h;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  for (let c = 0; c <= cols; c++) {
    const x = (c / cols) * w;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/**
 * Transparent catch fence panels (+ posts) outside the Armco on both sides.
 *
 * @param {{ samples: object[], length: number }} centerline
 */
export function createCatchFence(centerline) {
  const panels = planCatchFence(centerline.samples, centerline.length);
  if (!panels.length) return new THREE.Group();

  const panelW = 5;
  const panelH = 1.35;
  const alphaMap = fenceAlphaTexture();

  const panelMat = new THREE.MeshStandardMaterial({
    color: 0xc8ccd0,
    metalness: 0.55,
    roughness: 0.35,
    transparent: true,
    alphaMap,
    alphaTest: 0.25,
    side: THREE.DoubleSide,
    depthWrite: true,
  });

  const postMat = new THREE.MeshStandardMaterial({
    color: 0x909498,
    metalness: 0.6,
    roughness: 0.4,
  });

  const panelMesh = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(panelW, panelH),
    panelMat,
    panels.length,
  );
  panelMesh.name = 'catchFencePanels';
  const postMesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.07, panelH, 0.07),
    postMat,
    panels.length,
  );
  postMesh.name = 'catchFencePosts';

  panelMesh.castShadow = postMesh.castShadow = true;
  panelMesh.receiveShadow = postMesh.receiveShadow = true;

  const dummy = new THREE.Object3D();
  for (let i = 0; i < panels.length; i++) {
    const p = panels[i];
    dummy.position.set(p.x, panelH * 0.5, p.z);
    dummy.lookAt(p.lookX, panelH * 0.5, p.lookZ);
    dummy.updateMatrix();
    panelMesh.setMatrixAt(i, dummy.matrix);
    postMesh.setMatrixAt(i, dummy.matrix);
  }
  panelMesh.instanceMatrix.needsUpdate = true;
  postMesh.instanceMatrix.needsUpdate = true;

  const group = new THREE.Group();
  group.name = 'catchFence';
  group.add(panelMesh);
  group.add(postMesh);
  return group;
}
