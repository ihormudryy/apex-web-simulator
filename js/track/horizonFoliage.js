import * as THREE from 'three';
import { planHorizonBillboards } from './horizonPlan.js';

export { planHorizonBillboards } from './horizonPlan.js';

/**
 * Distant billboard silhouettes beyond the catch fence — trees in two rings
 * plus grandstand / hospitality blocks. Fills the horizon without full geometry.
 *
 * Placement is pure (`planHorizonBillboards`); canvas drawing and InstancedMesh
 * wiring happen here.
 */

function drawSpruce(ctx, w, h) {
  const trunkGrad = ctx.createLinearGradient(w * 0.44, h * 0.68, w * 0.56, h);
  trunkGrad.addColorStop(0, '#4a3528');
  trunkGrad.addColorStop(1, '#2a1e16');
  ctx.fillStyle = trunkGrad;
  ctx.fillRect(w * 0.41, h * 0.61, w * 0.18, h * 0.39);
  ctx.fillStyle = '#1f6b2e';
  ctx.beginPath();
  ctx.moveTo(w * 0.5, h * 0.06);
  ctx.lineTo(w * 0.9, h * 0.56);
  ctx.lineTo(w * 0.1, h * 0.56);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#2d8a3f';
  ctx.beginPath();
  ctx.moveTo(w * 0.5, h * 0.14);
  ctx.lineTo(w * 0.81, h * 0.45);
  ctx.lineTo(w * 0.19, h * 0.45);
  ctx.closePath();
  ctx.fill();
}

function drawDeciduous(ctx, w, h) {
  const trunkGrad = ctx.createLinearGradient(w * 0.44, h * 0.55, w * 0.56, h);
  trunkGrad.addColorStop(0, '#5a4030');
  trunkGrad.addColorStop(1, '#2c2018');
  ctx.fillStyle = trunkGrad;
  ctx.fillRect(w * 0.43, h * 0.48, w * 0.14, h * 0.52);
  ctx.fillStyle = '#2a5c28';
  ctx.beginPath();
  ctx.ellipse(w * 0.5, h * 0.32, w * 0.38, h * 0.28, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#3a7a38';
  ctx.beginPath();
  ctx.ellipse(w * 0.42, h * 0.28, w * 0.22, h * 0.18, -0.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#1e4a1c';
  ctx.beginPath();
  ctx.ellipse(w * 0.6, h * 0.34, w * 0.2, h * 0.16, 0.2, 0, Math.PI * 2);
  ctx.fill();
}

function drawGrandstand(ctx, w, h) {
  // Dark mass with terrace steps — reads as a grandstand silhouette at distance.
  ctx.fillStyle = '#1a1e24';
  ctx.fillRect(w * 0.05, h * 0.35, w * 0.9, h * 0.55);
  ctx.fillStyle = '#2a3038';
  ctx.fillRect(w * 0.08, h * 0.22, w * 0.84, h * 0.16);
  ctx.fillStyle = '#12151a';
  for (let i = 0; i < 5; i++) {
    const y = h * (0.4 + i * 0.08);
    ctx.fillRect(w * 0.1, y, w * 0.8, h * 0.035);
  }
  // Roof lip
  ctx.fillStyle = '#3a4048';
  ctx.fillRect(w * 0.02, h * 0.18, w * 0.96, h * 0.06);
  // Pillars
  ctx.fillStyle = '#0e1014';
  for (let i = 0; i < 4; i++) {
    ctx.fillRect(w * (0.18 + i * 0.2), h * 0.55, w * 0.04, h * 0.35);
  }
}

function billboardTexture(draw, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.clearRect(0, 0, width, height);
    draw(ctx, width, height);
  }
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.minFilter = THREE.LinearMipmapLinearFilter;
  map.magFilter = THREE.LinearFilter;
  return map;
}

function billboardMaterial(map) {
  return new THREE.MeshStandardMaterial({
    map,
    alphaMap: map,
    transparent: true,
    alphaTest: 0.35,
    roughness: 0.92,
    metalness: 0,
    side: THREE.DoubleSide,
    depthWrite: true,
  });
}

function addInstances(group, name, placements, geo, mat, baseY, yLift) {
  if (!placements.length) return;
  const mesh = new THREE.InstancedMesh(geo, mat, placements.length);
  mesh.name = name;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  const dummy = new THREE.Object3D();
  for (let i = 0; i < placements.length; i++) {
    const t = placements[i];
    const y = (typeof baseY === 'function' ? baseY(t.x, t.z) : baseY) + 0.02;
    dummy.position.set(t.x, y + t.scale * yLift, t.z);
    dummy.rotation.set(0, t.rot, 0);
    dummy.scale.setScalar(t.scale);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  group.add(mesh);
}

/**
 * @param {{ samples: object[], length: number }} centerline
 * @param {(x:number,z:number)=>number} baseY
 */
export function createHorizonFoliage(centerline, baseY, opts = {}) {
  const group = new THREE.Group();
  group.name = 'horizonFoliage';

  const placements = planHorizonBillboards(centerline, opts);
  if (!placements.length) return group;

  const near = placements.filter(p => p.kind === 'treeNear');
  const far = placements.filter(p => p.kind === 'treeFar');
  const stands = placements.filter(p => p.kind === 'stand');

  const spruceMap = billboardTexture(drawSpruce, 64, 128);
  const decidMap = billboardTexture(drawDeciduous, 64, 128);
  const standMap = billboardTexture(drawGrandstand, 128, 96);

  // Split near trees across two silhouettes so the ring does not read as clones.
  const nearA = near.filter((_, i) => i % 2 === 0);
  const nearB = near.filter((_, i) => i % 2 === 1);

  addInstances(group, 'horizonTreesNearA', nearA,
    new THREE.PlaneGeometry(5.5, 9.5), billboardMaterial(spruceMap), baseY, 4.5);
  addInstances(group, 'horizonTreesNearB', nearB,
    new THREE.PlaneGeometry(6.2, 8.2), billboardMaterial(decidMap), baseY, 3.9);
  addInstances(group, 'horizonTreesFar', far,
    new THREE.PlaneGeometry(7.5, 12), billboardMaterial(spruceMap), baseY, 5.5);
  addInstances(group, 'horizonStands', stands,
    new THREE.PlaneGeometry(28, 12), billboardMaterial(standMap), baseY, 5.5);

  return group;
}
