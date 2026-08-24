import * as THREE from 'three';

/**
 * Start/finish gantry: twin uprights + crossbeam + FINISH board.
 * Procedural geometry — no external assets.
 *
 * @param {{ x:number, z:number, tx:number, tz:number, nx:number, nz:number, halfWidth:number }} sample
 * @param {(x:number,z:number)=>number} [baseY]
 */
export function createFinishGantry(sample, baseY = () => 0, {
  clearance = 5.2,
  postWidth = 0.35,
  beamDepth = 0.55,
  boardHeight = 1.4,
} = {}) {
  const group = new THREE.Group();
  group.name = 'finishGantry';

  const span = sample.halfWidth * 2 + 4.5;
  const half = span * 0.5;
  const y0 = typeof baseY === 'function'
    ? baseY(sample.x, sample.z)
    : baseY;

  const steel = new THREE.MeshStandardMaterial({
    color: 0x3a3f48,
    roughness: 0.55,
    metalness: 0.7,
  });
  const accent = new THREE.MeshStandardMaterial({
    color: 0xc4ccd6,
    roughness: 0.4,
    metalness: 0.5,
  });

  const postGeo = new THREE.BoxGeometry(postWidth, clearance + 0.8, postWidth);
  for (const side of [-1, 1]) {
    const post = new THREE.Mesh(postGeo, steel);
    const px = sample.x + sample.nx * side * half;
    const pz = sample.z + sample.nz * side * half;
    post.position.set(px, y0 + (clearance + 0.8) * 0.5, pz);
    post.castShadow = true;
    post.receiveShadow = true;
    group.add(post);
  }

  // Crossbeam
  const beam = new THREE.Mesh(
    new THREE.BoxGeometry(span + postWidth, beamDepth, beamDepth),
    accent,
  );
  beam.position.set(sample.x, y0 + clearance + beamDepth * 0.5, sample.z);
  // Align beam along the track-normal (across the road).
  beam.rotation.y = Math.atan2(sample.nx, sample.nz);
  beam.castShadow = true;
  group.add(beam);

  // Lattice struts on the beam (cheap visual density).
  const strutGeo = new THREE.BoxGeometry(0.08, beamDepth * 0.85, beamDepth * 0.85);
  for (let i = -4; i <= 4; i++) {
    if (i === 0) continue;
    const strut = new THREE.Mesh(strutGeo, steel);
    const along = (i / 5) * half;
    strut.position.set(
      sample.x + sample.nx * along,
      y0 + clearance + beamDepth * 0.5,
      sample.z + sample.nz * along,
    );
    strut.rotation.y = Math.atan2(sample.nx, sample.nz);
    group.add(strut);
  }

  // FINISH board hanging under the beam.
  const board = new THREE.Mesh(
    new THREE.PlaneGeometry(span * 0.72, boardHeight),
    new THREE.MeshStandardMaterial({
      map: finishBoardTexture(),
      roughness: 0.65,
      metalness: 0.1,
      side: THREE.DoubleSide,
    }),
  );
  board.position.set(
    sample.x,
    y0 + clearance - boardHeight * 0.35,
    sample.z,
  );
  // Face oncoming traffic (−tangent).
  board.rotation.y = Math.atan2(-sample.tx, -sample.tz);
  group.add(board);

  return group;
}

/** Black board with white FINISH lettering. */
export function finishBoardTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#0a0a0c';
    ctx.fillRect(0, 0, 512, 128);
    ctx.fillStyle = '#e8ecf0';
    ctx.font = 'bold 72px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('FINISH', 256, 64);
    // LED-ish underline
    ctx.fillStyle = '#5ad0ff';
    ctx.fillRect(80, 100, 352, 6);
  }
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  return map;
}

/**
 * Checkered finish stripe albedo (tiling across the road).
 * @returns {Uint8ClampedArray} RGBA 128×32
 */
export function checkeredFinishAlbedo(width = 128, height = 32) {
  const data = new Uint8ClampedArray(width * height * 4);
  const cellsX = 16;
  const cellsY = 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cx = Math.floor((x / width) * cellsX);
      const cy = Math.floor((y / height) * cellsY);
      const on = (cx + cy) % 2 === 0;
      const v = on ? 240 : 18;
      const o = (y * width + x) * 4;
      data[o] = v;
      data[o + 1] = v;
      data[o + 2] = v;
      data[o + 3] = 255;
    }
  }
  return data;
}
