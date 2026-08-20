import * as THREE from 'three';
import {
  planMarshalPosts, planDistanceBoards, planTyreStacks,
} from './tracksidePlacements.js';

function tyreStackGeometry(tiers) {
  const g = new THREE.BufferGeometry();
  const positions = [];
  const normals = [];
  const indices = [];
  let vBase = 0;
  const tyreR = 0.34;
  const tyreTube = 0.11;

  for (let t = 0; t < tiers; t++) {
    const torus = new THREE.TorusGeometry(tyreR, tyreTube, 8, 16);
    torus.translate(0, t * (tyreTube * 2.1 + 0.02), 0);
    const pos = torus.getAttribute('position');
    const nor = torus.getAttribute('normal');
    const idx = torus.getIndex();
    for (let i = 0; i < pos.count; i++) {
      positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      normals.push(nor.getX(i), nor.getY(i), nor.getZ(i));
    }
    for (let i = 0; i < idx.count; i++) indices.push(idx.getX(i) + vBase);
    vBase += pos.count;
    torus.dispose();
  }

  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  g.setIndex(indices);
  g.computeBoundingSphere();
  return g;
}

/**
 * Marshal posts, distance boards, and corner tyre stacks along the lap.
 *
 * @param {{ samples: object[], length: number }} centerline
 */
export function createTracksideProps(centerline) {
  const group = new THREE.Group();
  group.name = 'tracksideProps';

  const posts = planMarshalPosts(centerline.samples, centerline.length);
  const boards = planDistanceBoards(centerline.samples, centerline.length);
  const stacks = planTyreStacks(centerline.samples, centerline.length);

  if (posts.length) {
    const postGeo = new THREE.CylinderGeometry(0.06, 0.07, 1.85, 8);

    const postMat = new THREE.MeshStandardMaterial({
      color: 0xd8dce0,
      metalness: 0.35,
      roughness: 0.55,
    });
    const postMesh = new THREE.InstancedMesh(postGeo, postMat, posts.length);
    postMesh.name = 'marshalPosts';
    postMesh.castShadow = postMesh.receiveShadow = true;

    const dummy = new THREE.Object3D();
    for (let i = 0; i < posts.length; i++) {
      const p = posts[i];
      dummy.position.set(p.x, 0, p.z);
      dummy.rotation.set(0, p.yaw, 0);
      dummy.updateMatrix();
      postMesh.setMatrixAt(i, dummy.matrix);
    }
    postMesh.instanceMatrix.needsUpdate = true;
    group.add(postMesh);
  }

  if (boards.length) {
    const boardGeo = new THREE.PlaneGeometry(1.4, 0.72);
    const boardMat = new THREE.MeshStandardMaterial({
      color: 0xf4f0e8,
      roughness: 0.72,
      metalness: 0,
      side: THREE.DoubleSide,
    });
    const boardMesh = new THREE.InstancedMesh(boardGeo, boardMat, boards.length);
    boardMesh.name = 'distanceBoards';
    boardMesh.castShadow = boardMesh.receiveShadow = true;

    const dummy = new THREE.Object3D();
    for (let i = 0; i < boards.length; i++) {
      const b = boards[i];
      dummy.position.set(b.x, 1.05, b.z);
      dummy.lookAt(b.lookX, 1.05, b.lookZ);
      dummy.updateMatrix();
      boardMesh.setMatrixAt(i, dummy.matrix);
    }
    boardMesh.instanceMatrix.needsUpdate = true;
    group.add(boardMesh);
  }

  if (stacks.length) {
    const tyreMat = new THREE.MeshStandardMaterial({
      color: 0x1a1a1a,
      roughness: 0.92,
      metalness: 0.02,
    });

    const byTiers = new Map();
    for (const s of stacks) {
      if (!byTiers.has(s.tiers)) byTiers.set(s.tiers, []);
      byTiers.get(s.tiers).push(s);
    }

    for (const [tiers, list] of byTiers) {
      const geo = tyreStackGeometry(tiers);
      const mesh = new THREE.InstancedMesh(geo, tyreMat, list.length);
      mesh.name = `tyreStacks${tiers}`;
      mesh.castShadow = mesh.receiveShadow = true;

      const dummy = new THREE.Object3D();
      for (let i = 0; i < list.length; i++) {
        const s = list[i];
        dummy.position.set(s.x, 0.12, s.z);
        dummy.rotation.set(0, s.yaw, 0);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
      group.add(mesh);
    }
  }

  return group;
}
