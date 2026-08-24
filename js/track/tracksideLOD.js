import * as THREE from 'three';
import { TRACKSIDE_BANDS, distanceToSphere, instanceCountFor } from './lodBands.js';

/** Kept as the old export name; the bands themselves live in `lodBands.js`. */
export const TRACKSIDE_LOD = TRACKSIDE_BANDS;

/**
 * Distance-based detail for trackside content.
 *
 * Everything out here is an `InstancedMesh`, and all of it except the grass is a
 * single mesh spanning the whole lap: one `catchFencePanels`, one `marshalPosts`,
 * one `distanceBoards`. That rules out `THREE.LOD`, which swaps whole objects by
 * the distance from its own origin to the camera. Wrapping lap-length geometry in
 * one of those measured ~1011 m — the gap between the world origin and a circuit
 * that sits a kilometre away — so every band read "too far" and the entire
 * trackside, grass and fence and props alike, was never drawn anywhere on the lap.
 *
 * So detail is per mesh and by instance count instead:
 *
 * - Distance is measured to the nearest point of the mesh's bounding sphere, so a
 *   lap-spanning mesh reports ~0 and stays at full detail. Correct, and the
 *   reason the fence and boards simply always draw: they are one call each, and
 *   thinning their instances would delete panels next to the car. Chunking them
 *   the way the grass is chunked is the prerequisite for giving them real LOD.
 * - The grass arrives as 96 spatial chunks, so each one gets a real distance and
 *   scales its own instance count. No clones, no duplicated instance matrices,
 *   and frustum culling still works off the full-extent bounding sphere.
 */
function collectUnits(root, bands, out, kind) {
  if (!root) return out;
  root.traverse(object => {
    if (!object.isInstancedMesh || object.count === 0) return;
    // At full count, and cached: this sphere drives both the distance metric and
    // frustum culling, and recomputing it after thinning would shrink it to the
    // instances that survived, which then feeds back into the next frame.
    object.computeBoundingSphere();
    const sphere = object.boundingSphere;
    out.push({
      mesh: object,
      fullCount: object.count,
      bands,
      kind,
      cx: sphere.center.x,
      cy: sphere.center.y,
      cz: sphere.center.z,
      radius: sphere.radius,
    });
  });
  return out;
}

/**
 * @param {{ grass: THREE.Object3D, fence: THREE.Object3D, props: THREE.Object3D,
 *           distances?: object }} parts
 */
export function createTracksideLOD({
  grass, fence, props, distances = TRACKSIDE_BANDS,
}) {
  const root = new THREE.Group();
  root.name = 'tracksideLOD';
  for (const part of [grass, fence, props]) if (part) root.add(part);

  const units = [];
  collectUnits(grass, distances.grass, units, 'grass');
  collectUnits(fence, distances.fence, units, 'fence');
  collectUnits(props, distances.props, units, 'props');

  const lod = {
    root,
    /** Exposed so a probe can assert what the bands actually decided. */
    units,
    grassDensity: 1,
    update(camera) {
      const p = camera.position;
      for (const u of units) {
        const d = distanceToSphere(p.x, p.y, p.z, u.cx, u.cy, u.cz, u.radius);
        const scale = u.kind === 'grass' ? lod.grassDensity : 1;
        u.mesh.count = instanceCountFor(u.fullCount, d, u.bands, { densityScale: scale });
      }
    },
  };
  return lod;
}
