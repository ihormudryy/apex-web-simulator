import * as THREE from 'three';
import { hash01 } from './tracksidePlacements.js';

/**
 * Distant mountain / ridge silhouette ring — fills the far horizon with aerial
 * perspective (cool, desaturated) so the world does not end at the tree line.
 *
 * @param {{ samples: object[], length: number }} centerline
 * @param {(x:number,z:number)=>number} [baseY]
 */
/**
 * Where the peaks go — pure, so it can be tested without a canvas.
 *
 * A ring around the whole site, not an offset from each station. Offsetting
 * laterally from one station is what the trees did, and on a circuit that folds
 * back inside a ~1.2 km site it puts the backdrop *inside* the track: measured
 * on the surveyed Silverstone, a peak intended to sit 420-780 m away was
 * raycast at 271 m from the camera. These silhouettes are 80-220 m tall before a
 * scale of up to 2.3, so at that range one fills the sky — the pale hard-edged
 * wedges hanging over the circuit. A backdrop has no business being addressed
 * per-station anyway; it belongs on a ring outside everything.
 *
 * @param {{ samples: object[], length: number }} centerline
 */
export function planMountainRing(centerline, {
  spacing = 180,
  minOutward = 420,
  maxOutward = 780,
  seed = 41,
  maxPeaks = 48,
} = {}) {
  const { samples, length: lapLength } = centerline;
  if (!samples?.length || !(lapLength > 0)) return [];

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const s of samples) {
    if (s.x < minX) minX = s.x;
    if (s.x > maxX) maxX = s.x;
    if (s.z < minZ) minZ = s.z;
    if (s.z > maxZ) maxZ = s.z;
  }
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  // Far enough out that the ring clears the furthest corner of the circuit, so
  // `minOutward` is a clearance from the *track* rather than from one station.
  let siteRadius = 0;
  for (const s of samples) {
    const d = Math.hypot(s.x - cx, s.z - cz);
    if (d > siteRadius) siteRadius = d;
  }

  const count = Math.min(maxPeaks, Math.ceil(lapLength / spacing));
  const out = [];
  for (let p = 0; p < count; p++) {
    // Spread around the ring, jittered so the spacing does not read as regular.
    const angle = ((p + (hash01(p, 0, 2, seed) - 0.5) * 0.6) / count) * Math.PI * 2;
    const radius = siteRadius + minOutward
      + hash01(p, 1, 3, seed) * (maxOutward - minOutward);
    const x = cx + Math.cos(angle) * radius;
    const z = cz + Math.sin(angle) * radius;
    out.push({
      x,
      z,
      scale: 0.9 + hash01(p, 2, 4, seed) * 0.8,
      // A PlaneGeometry faces +Z, and after `rotation.y = t` its normal is
      // (sin t, 0, cos t) — so this turns each peak to face the circuit.
      rot: Math.atan2(cx - x, cz - z),
      // Low and wide, because Silverstone is a flat airfield in Northamptonshire
      // and this is a skyline, not an alpine stage. At the old 80-220 m and up
      // to 2.3x scale these reached 432 m — 44 degrees of wall at the ring's
      // closest approach. Cutting the height alone just left the tips poking
      // through the distance haze as separate floating pyramids, so the width
      // goes up as far as the height comes down: neighbours now overlap into one
      // continuous ridge a few degrees tall, which is what a horizon looks like.
      h: 25 + hash01(p, 3, 5, seed) * 35,
      w: 600 + hash01(p, 4, 6, seed) * 700,
    });
  }
  return out;
}

/**
 * @param {{ samples: object[], length: number }} centerline
 * @param {(x:number,z:number)=>number} [baseY]
 */
export function createMountainBackdrop(centerline, baseY = () => 0, opts = {}) {
  const group = new THREE.Group();
  group.name = 'mountainBackdrop';
  const positions = planMountainRing(centerline, opts);
  if (!positions.length) return group;

  const map = mountainTexture();
  const mat = new THREE.MeshBasicMaterial({
    map,
    alphaMap: map,
    transparent: true,
    alphaTest: 0.2,
    depthWrite: false,
    fog: true,
    side: THREE.DoubleSide,
    // Cool aerial tint — BasicMaterial colour multiplies the map.
    color: 0x8fa4b8,
  });

  const mesh = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(1, 1),
    mat,
    positions.length,
  );
  mesh.name = 'mountainPeaks';
  mesh.frustumCulled = true;
  const dummy = new THREE.Object3D();
  for (let i = 0; i < positions.length; i++) {
    const t = positions[i];
    const y = (typeof baseY === 'function' ? baseY(t.x, t.z) : baseY) + t.h * 0.42;
    dummy.position.set(t.x, y, t.z);
    dummy.rotation.set(0, t.rot, 0);
    dummy.scale.set(t.w * t.scale, t.h * t.scale, 1);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  group.add(mesh);
  return group;
}

function mountainTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.clearRect(0, 0, 256, 128);
    ctx.fillStyle = '#4a5560';
    ctx.beginPath();
    ctx.moveTo(0, 128);
    ctx.lineTo(20, 90);
    ctx.lineTo(55, 40);
    ctx.lineTo(90, 70);
    ctx.lineTo(130, 18);
    ctx.lineTo(170, 55);
    ctx.lineTo(210, 30);
    ctx.lineTo(246, 75);
    ctx.lineTo(256, 128);
    ctx.closePath();
    ctx.fill();
    // Snow tips
    ctx.fillStyle = '#d8e0e8';
    ctx.beginPath();
    ctx.moveTo(130, 18);
    ctx.lineTo(145, 38);
    ctx.lineTo(118, 38);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(210, 30);
    ctx.lineTo(222, 48);
    ctx.lineTo(200, 48);
    ctx.closePath();
    ctx.fill();
  }
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  return map;
}
