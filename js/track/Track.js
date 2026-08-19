import * as THREE from 'three';
import { buildCenterline } from './centerline.js';
import { ribbonTileUV } from '../render/ribbonUV.js';
import {
  tileableHeight, albedoFromHeight, normalFromHeight, roughnessFromHeight,
} from '../render/asphaltMaps.js';

const DEG90 = Math.PI / 2;

// Marking geometry, in metres. Everything derives from these rather than from a
// texture-repeat count, so a stripe is the same length whatever the lap length is.
const KERB_STRIPE = 0.75;      // one red or one white block
const KERB_WIDTH = 1.0;
const DASH_LENGTH = 3.0;
const DASH_GAP = 6.0;
const DASH_WIDTH = 0.14;       // half-width of the centre line
const EDGE_LINE_WIDTH = 0.1;   // half-width of the white edge line
const START_LINE_WIDTH = 0.5;
// One wrap of the asphalt PBR tile. 4 m is a slight stretch so Hamilton
// Straight does not read as a stamped pattern from the chase cam.
const ASPHALT_TILE_M = 4;

// Heights, in metres. Ordered so a marking is never below the surface it is
// painted on.
const Y_GRASS = -0.25;
const Y_RUNOFF = -0.04;
const Y_ASPHALT = 0;
const Y_KERB = 0.03;
const Y_DASH = 0.012;
const Y_EDGE = 0.016;
const Y_START = 0.02;

// The track is a stack of near-coplanar strips a few centimetres apart, viewed
// down a kilometre of straight. No depth range resolves centimetres at that
// distance — at 600 m a 24-bit buffer resolves about 90 mm, so the asphalt lost
// to the runoff underneath it and the road rendered as grass. Depth bias is
// measured in depth-buffer units rather than metres, so it holds at any distance;
// lower number means "wins".
const DEPTH_LAYER = {
  ground: 0,
  runoff: -1,
  asphalt: -2,
  kerb: -3,
  marking: -5,
};

function layered(material, layer) {
  material.polygonOffset = true;
  material.polygonOffsetFactor = DEPTH_LAYER[layer];
  material.polygonOffsetUnits = DEPTH_LAYER[layer];
  return material;
}

export class Track extends THREE.Group {
  /**
   * @param {Array<{x:number,z:number,halfWidth:number,runoff:number}>} waypoints
   *   dense centerline ring — see `fillet.js`, which bounds its curvature.
   * @param {object} [options]
   * @param {number} [options.sampleCount=4000] stations round the lap.
   * @param {number} [options.spawnT=0] start/finish, as a fraction of the lap.
   * @param {number} [options.groundMargin=1600] how far the ground reaches past
   *   the circuit. Must exceed the scene's `fog.far`, or the edge of the world is
   *   visible from the far side of the track.
   */
  constructor(waypoints, { sampleCount = 4000, spawnT = 0, groundMargin = 1600 } = {}) {
    super();

    this.centerline = buildCenterline(waypoints, sampleCount);
    this.samples = this.centerline.samples;
    this.spawnT = spawnT;
    this.groundMargin = groundMargin;
    this._hint = 0;

    this._build();
  }

  query(x, z) {
    const result = this.centerline.query(x, z, this._hint);
    this._hint = result.index;
    return result;
  }

  spawn() {
    const s = this.samples[this._spawnIndex()];
    return { x: s.x, z: s.z, tx: s.tx, tz: s.tz };
  }

  _spawnIndex() {
    return Math.floor(this.spawnT * this.samples.length) % this.samples.length;
  }

  /** Axis-aligned bounds of the drivable world, barriers included. */
  bounds() {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const s of this.samples) {
      const reach = s.halfWidth + s.runoff;
      minX = Math.min(minX, s.x - reach); maxX = Math.max(maxX, s.x + reach);
      minZ = Math.min(minZ, s.z - reach); maxZ = Math.max(maxZ, s.z + reach);
    }
    return { minX, maxX, minZ, maxZ };
  }

  _build() {
    this.add(this._ground());

    this.add(this._ribbon(
      s => s.halfWidth + s.runoff,
      s => -(s.halfWidth + s.runoff),
      layered(new THREE.MeshStandardMaterial({ color: 0x4a7a3c, roughness: 1, metalness: 0 }), 'runoff'),
      Y_RUNOFF,
      { receiveShadow: true }
    ));
    this.add(this._ribbon(
      s => s.halfWidth,
      s => -s.halfWidth,
      layered(this._asphaltMaterial(), 'asphalt'),
      Y_ASPHALT,
      { uvMode: 'metres', tileMetres: ASPHALT_TILE_M, receiveShadow: true }
    ));

    const curbMaterial = layered(new THREE.MeshStandardMaterial({
      map: this._makeCurbTexture(),
      roughness: 0.6,
      metalness: 0.04,
    }), 'kerb');
    const edgeMaterial = layered(new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.65,
      metalness: 0,
    }), 'marking');
    // Galvanised Armco. Needs `scene.environment` to have anything to reflect —
    // bare metalness with only direct lights renders navy on the shaded side.
    const barrierMaterial = new THREE.MeshStandardMaterial({
      color: 0xb8bcc0,
      roughness: 0.45,
      metalness: 0.35,
      // Face winding flips with the side the run is on, so don't cull.
      side: THREE.DoubleSide,
    });

    for (const side of [-1, 1]) {
      this.add(this._ribbon(
        s => side * (s.halfWidth + (side > 0 ? KERB_WIDTH : 0)),
        s => side * (s.halfWidth + (side > 0 ? 0 : KERB_WIDTH)),
        curbMaterial,
        Y_KERB,
        { receiveShadow: true }
      ));
      this.add(this._ribbon(
        s => side * (s.halfWidth - EDGE_LINE_WIDTH) + EDGE_LINE_WIDTH,
        s => side * (s.halfWidth - EDGE_LINE_WIDTH) - EDGE_LINE_WIDTH,
        edgeMaterial,
        Y_EDGE,
        { receiveShadow: true }
      ));
      this.add(this._barrier(side, barrierMaterial));
    }

    this.add(this._ribbon(
      () => DASH_WIDTH,
      () => -DASH_WIDTH,
      layered(new THREE.MeshStandardMaterial({
        map: this._makeDashedTexture(),
        transparent: true,
        roughness: 0.7,
        metalness: 0,
      }), 'marking'),
      Y_DASH,
      { receiveShadow: true }
    ));

    this.add(this._startLine(this.samples[this._spawnIndex()], layered(new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.65,
      metalness: 0,
    }), 'marking')));
  }

  /**
   * Ground under everything, centred on the circuit rather than on the origin.
   * A plane centred at (0,0) left its edge only ~1 km from the east side of the
   * track — inside fog range, so the world visibly stopped.
   */
  _ground() {
    const b = this.bounds();
    const m = this.groundMargin;
    const width = (b.maxX - b.minX) + 2 * m;
    const depth = (b.maxZ - b.minZ) + 2 * m;
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(width, depth),
      layered(new THREE.MeshStandardMaterial({ color: 0x3d6b32, roughness: 1, metalness: 0 }), 'ground')
    );
    ground.rotation.x = -DEG90;
    ground.position.set((b.minX + b.maxX) / 2, Y_GRASS, (b.minZ + b.maxZ) / 2);
    ground.receiveShadow = true;
    return ground;
  }

  _asphaltMaterial() {
    const size = 512;
    const height = tileableHeight(size, 3);
    return new THREE.MeshStandardMaterial({
      map: this._asphaltDataTexture(albedoFromHeight(height, size), size, THREE.SRGBColorSpace),
      // Normal strength was too high (appeared like rippling mud/water).
      normalMap: this._asphaltDataTexture(normalFromHeight(height, size, 3), size, THREE.NoColorSpace),
      roughnessMap: this._asphaltDataTexture(roughnessFromHeight(height, size), size, THREE.NoColorSpace),
      color: 0xffffff,
      roughness: 0.72,
      metalness: 0,
      envMapIntensity: 0.55,
    });
  }

  _asphaltDataTexture(data, size, colorSpace) {
    const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = 8;
    texture.colorSpace = colorSpace;
    texture.needsUpdate = true;
    return texture;
  }

  /**
   * Sweep a strip between two per-station lateral offsets.
   *
   * `u` runs 0→1 once round the lap and stations are evenly spaced by arc length,
   * so `u * lapLength` is distance in metres — which is what lets the marking
   * textures be sized in metres.
   */
  _ribbon(leftOffset, rightOffset, material, y, {
    uvMode = 'normalized',
    tileMetres = 1,
    receiveShadow = false,
    castShadow = false,
  } = {}) {
    const n = this.samples.length;
    const lap = this.centerline.length;
    const vertices = new Float32Array((n + 1) * 6);
    const normals = new Float32Array((n + 1) * 6);
    const uvs = new Float32Array((n + 1) * 4);
    const indices = new Uint32Array(n * 6);

    for (let i = 0; i <= n; i++) {
      const s = this.samples[i % n];
      const left = leftOffset(s);
      const right = rightOffset(s);
      const vertex = i * 6;
      vertices[vertex] = s.x + s.nx * left;
      vertices[vertex + 1] = 0;
      vertices[vertex + 2] = s.z + s.nz * left;
      vertices[vertex + 3] = s.x + s.nx * right;
      vertices[vertex + 4] = 0;
      vertices[vertex + 5] = s.z + s.nz * right;
      // The strip is flat, so skip computeVertexNormals and its seam artefacts.
      normals[vertex + 1] = 1;
      normals[vertex + 4] = 1;
      const uv = ribbonTileUV({
        mode: uvMode,
        alongMetres: (i / n) * lap,
        left,
        right,
        tileMetres,
        station: i,
        stationCount: n,
      });
      uvs[i * 4] = uv.u0;
      uvs[i * 4 + 1] = uv.v0;
      uvs[i * 4 + 2] = uv.u1;
      uvs[i * 4 + 3] = uv.v1;
    }

    for (let i = 0; i < n; i++) {
      const a = i * 2;
      const index = i * 6;
      indices[index] = a;
      indices[index + 1] = a + 2;
      indices[index + 2] = a + 1;
      indices[index + 3] = a + 1;
      indices[index + 4] = a + 2;
      indices[index + 5] = a + 3;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeBoundingSphere();

    if (material.normalMap) geometry.computeTangents();

    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.y = y;
    mesh.receiveShadow = receiveShadow;
    mesh.castShadow = castShadow;
    return mesh;
  }

  /**
   * Armco run along the outside of the runoff.
   *
   * Each of the three visible faces gets its own vertices and its own flat
   * normal. Sharing vertices around the profile and calling
   * `computeVertexNormals()` averaged the inner wall with the cap it meets,
   * giving every vertex a 45° normal — half of them tilted downward into the dark
   * half of the environment, which is what made the barriers read as dark navy on
   * one side and washed tan on the other.
   */
  _barrier(side, material) {
    const height = 1.1;
    const halfThickness = 0.06;
    const n = this.samples.length;
    const rings = n + 1;

    // (lateral offset from the wall centre, height) pairs per face edge.
    const faces = [
      { a: [ halfThickness, 0], b: [ halfThickness, height], normal: 'in' },   // track side
      { a: [ halfThickness, height], b: [-halfThickness, height], normal: 'up' }, // cap
      { a: [-halfThickness, height], b: [-halfThickness, 0], normal: 'out' },  // field side
    ];

    const vertices = new Float32Array(rings * faces.length * 2 * 3);
    const normals = new Float32Array(rings * faces.length * 2 * 3);
    const indices = new Uint32Array(n * faces.length * 6);
    let vi = 0;

    for (let i = 0; i < rings; i++) {
      const s = this.samples[i % n];
      const wallLimit = s.halfWidth + s.runoff;
      const cx = s.x + s.nx * side * wallLimit;
      const cz = s.z + s.nz * side * wallLimit;
      // "Inward" is back toward the centerline, whichever side this run is on.
      const inX = -side * s.nx, inZ = -side * s.nz;

      for (const face of faces) {
        for (const [offset, y] of [face.a, face.b]) {
          vertices[vi] = cx + inX * offset;
          vertices[vi + 1] = y;
          vertices[vi + 2] = cz + inZ * offset;
          if (face.normal === 'up') {
            normals[vi + 1] = 1;
          } else {
            const sign = face.normal === 'in' ? 1 : -1;
            normals[vi] = inX * sign;
            normals[vi + 2] = inZ * sign;
          }
          vi += 3;
        }
      }
    }

    let ii = 0;
    const stride = faces.length * 2;
    for (let i = 0; i < n; i++) {
      for (let f = 0; f < faces.length; f++) {
        const a = i * stride + f * 2;
        const b = a + 1;
        const c = (i + 1) * stride + f * 2;
        const d = c + 1;
        indices[ii++] = a; indices[ii++] = b; indices[ii++] = c;
        indices[ii++] = b; indices[ii++] = d; indices[ii++] = c;
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  /** Start/finish stripe, spanning the road it is painted on. */
  _startLine(sample, material) {
    const halfLength = sample.halfWidth;
    const halfWidth = START_LINE_WIDTH / 2;
    const vertices = new Float32Array([
      sample.x + sample.nx * halfLength - sample.tx * halfWidth, 0, sample.z + sample.nz * halfLength - sample.tz * halfWidth,
      sample.x - sample.nx * halfLength - sample.tx * halfWidth, 0, sample.z - sample.nz * halfLength - sample.tz * halfWidth,
      sample.x + sample.nx * halfLength + sample.tx * halfWidth, 0, sample.z + sample.nz * halfLength + sample.tz * halfWidth,
      sample.x - sample.nx * halfLength + sample.tx * halfWidth, 0, sample.z - sample.nz * halfLength + sample.tz * halfWidth,
    ]);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(
      new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]), 3));
    geometry.setIndex([0, 2, 1, 1, 2, 3]);
    geometry.computeBoundingSphere();
    const line = new THREE.Mesh(geometry, material);
    line.position.y = Y_START;
    line.receiveShadow = true;
    return line;
  }

  /**
   * @param {number} tileMetres how much road one wrap of the texture covers. The
   *   repeat count follows from the lap length, so stripe sizes stay physical.
   */
  _canvasTexture(draw, width, height, tileMetres) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    draw(canvas.getContext('2d'));
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(this.centerline.length / tileMetres, 1);
    texture.anisotropy = 8;
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  _makeCurbTexture() {
    const stripes = 8;                     // per wrap
    const px = 512 / stripes;
    return this._canvasTexture(ctx => {
      for (let i = 0; i < stripes; i++) {
        ctx.fillStyle = i % 2 === 0 ? '#c8180f' : '#efefef';
        ctx.fillRect(i * px, 0, px, 64);
      }
      ctx.fillStyle = 'rgba(0,0,0,0.10)';
      ctx.fillRect(0, 0, 512, 6);
      ctx.fillRect(0, 58, 512, 6);
    }, 512, 64, stripes * KERB_STRIPE);
  }

  _makeDashedTexture() {
    const cycle = DASH_LENGTH + DASH_GAP;
    const dashPx = Math.round(512 * DASH_LENGTH / cycle);
    return this._canvasTexture(ctx => {
      ctx.clearRect(0, 0, 512, 32);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, dashPx, 32);
    }, 512, 32, cycle);
  }
}
