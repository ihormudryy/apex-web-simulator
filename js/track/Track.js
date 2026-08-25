import * as THREE from 'three';
import { buildCenterline } from './centerline.js';
import { ribbonTileUV } from '../render/ribbonUV.js';
import {
  normalFromHeight, roughnessFromHeight,
} from '../render/asphaltMaps.js';
import { tileableGrassHeight, grassAlbedoFromHeight, grassFieldTint } from '../render/grassMaps.js';
import { tileableGravelHeight, gravelAlbedoFromHeight } from '../render/gravelMaps.js';
import { lineWearAlbedo, lineWearRoughness } from '../render/lineWearMaps.js';
import {
  asphaltSurfaceMap,
  ALBEDO_MUL_MIN, ALBEDO_MUL_MAX, ROUGH_MUL_MIN, ROUGH_MUL_MAX,
} from '../render/asphaltSurface.js';
import { composeOnBeforeCompile } from '../render/composeOnBeforeCompile.js';
import { createGrassTufts } from './grassTufts.js';
import { createCatchFence } from './catchFence.js';
import { createTracksideProps } from './tracksideProps.js';
import { createTracksideLOD } from './tracksideLOD.js';
import { createHorizonFoliage } from './horizonFoliage.js';
import { createMountainBackdrop } from './mountainBackdrop.js';
import { tracksideBandsFor } from './lodBands.js';
import {
  surfaceHeight, surfaceRoughness, verticalCurvature,
  meanElevation, KERB_WIDTH, FIELD_BLEND, blendedGroundHeight,
} from './elevation.js';
import { armcoAlbedo, armcoNormal, armcoRoughness, PANEL_METRES } from '../render/barrierMaps.js';
import {
  jerseyAlbedo, jerseyNormal, jerseyRoughness,
  jerseyHalfThickness, JERSEY_HEIGHT, JERSEY_PANEL_METRES,
} from '../render/jerseyMaps.js';
import { createFinishGantry, checkeredFinishAlbedo } from './finishGantry.js';
import { MU } from '../physics/constants.js';

const DEG90 = Math.PI / 2;

// Marking geometry, in metres. Everything derives from these rather than from a
// texture-repeat count, so a stripe is the same length whatever the lap length is.
const KERB_STRIPE = 0.75;      // one red or one white block
// KERB_WIDTH comes from elevation.js — the geometry and the physics must agree on
const EDGE_LINE_WIDTH = 0.1;   // half-width of the white edge line
const START_LINE_WIDTH = 0.5;
/** Gravel/dirt strip between kerb and lawn, metres. */
const GRAVEL_WIDTH = 1.5;
/** Thin grass strip against the concrete wall, metres. */
const VERGE_WIDTH = 1.1;
// One wrap of the asphalt PBR tile. The Poly Haven `asphalt_track` set is
// authored at 2 m x 2 m physical scale; wrapping it at its true size keeps
// the aggregate grain the size real race asphalt has, and the lap-scale
// variation multiply (racing line, marbles, patches) is what breaks up the
// repetition the old 4 m stretch used to hide.
const ASPHALT_TILE_M = 2;

/**
 * Central-difference step for the surface normal, metres. A compromise: smaller
 * and float64 cancellation shows in the normal, larger and a kerb edge is smeared
 * into a ramp.
 */
const NORMAL_EPS = 0.05;

/**
 * Lateral subdivision, per strip. Enough to carry the shape and no more: the
 * asphalt is the one that matters, and at 4000 stations a value of 8 is 36 000
 * vertices, which is nothing next to the grass.
 */
const ASPHALT_SEGMENTS = 8;
const RUNOFF_SEGMENTS = 4;
const KERB_SEGMENTS = 5;
/** Ground grid resolution. Fine enough that a 12 m elevation change does not facet. */
const GROUND_SEGMENTS = 240;

/**
 * Spread leftover 20 m tessellation spikes so a smooth infield does not still
 * read as a rectangular pit. Interior verts only — the skirt stays put.
 */
function relaxGridHeights(pos, segments, passes = 6) {
  const n = segments + 1;
  const tmp = new Float32Array(n * n);
  for (let p = 0; p < passes; p++) {
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const i = r * n + c;
        const z = pos.getZ(i);
        if (r === 0 || c === 0 || r === n - 1 || c === n - 1) {
          tmp[i] = z;
          continue;
        }
        tmp[i] = 0.5 * z + 0.125 * (
          pos.getZ((r - 1) * n + c)
          + pos.getZ((r + 1) * n + c)
          + pos.getZ(r * n + c - 1)
          + pos.getZ(r * n + c + 1));
      }
    }
    for (let i = 0; i < n * n; i++) pos.setZ(i, tmp[i]);
  }
}

// Close runoff: one wrap of the lawn PBR tile. Distant infield uses a longer// Close runoff: one wrap of the lawn PBR tile. Distant infield uses a longer
// period so the 1k map does not strobe from the chase cam.
const GRASS_RUNOFF_TILE_M = 3.5;
const GRAVEL_TILE_M = 2.5;
const GRASS_GROUND_TILE_M = 24;

// Heights, in metres. Ordered so a marking is never below the surface it is
// painted on.
//
// A few centimetres of separation is what stops WebGPU painting lawn through
// the tarmac: polygonOffset alone loses at kilometre sightlines, and inside
// corners the asphalt/runoff ribbons still overlap in XZ even when their
// lateral offsets do not share an edge. The old −4 / −25 cm grass drops made a
// visible cliff; lifting the road a hair instead keeps the verge flush.
//
// These are NOT visual-only. `Y_ASPHALT` lifts the surface the car drives on,
// so the physics applies the same lift through `roadLiftAt` — otherwise the
// tyres stand 4 cm below the road that is drawn under them and the car races
// permanently sunk into its own track.
const Y_GRASS = 0;
const Y_RUNOFF = 0;
const Y_ASPHALT = 0.04;
const Y_EDGE = 0.056;
const Y_START = 0.06;
/** Metres past the barriers over which the runoff offset fades to the lawn's. */
const LAWN_BLEND = 4;

// The track is a stack of near-coplanar strips a few centimetres apart, viewed
// down a kilometre of straight. No depth range resolves centimetres at that
// distance — at 600 m a 24-bit buffer resolves about 90 mm, so the asphalt lost
// to the runoff underneath it and the road rendered as grass. Depth bias is
// measured in depth-buffer units rather than metres, so it holds at any distance;
// lower (more negative) number means "wins"; positive pushes the fragment away.
const DEPTH_LAYER = {
  ground: 8,
  runoff: 1,
  asphalt: -3,
  kerb: -4,
  marking: -6,
};

/**
 * How far the drawn surface sits above the elevation model at a lateral offset.
 *
 * The road is deliberately lifted (see the `Y_*` block) so the lawn cannot
 * punch through it at kilometre sightlines. That lift is not "visual only": the
 * asphalt is the surface the car drives on, so anything that does not apply the
 * same lift to the physics puts the tyres `Y_ASPHALT` **below** the road they
 * are supposed to be standing on — 4 cm of a 334 mm tyre, on every lap.
 *
 * Ramped rather than stepped. A 4 cm cliff at the white line is a kerb strike
 * as far as the suspension is concerned, so the lift fades out across the kerb
 * and then across a couple of metres of runoff, which is also where the real
 * kerb profile already lives.
 *
 * @param {{lateral:number, halfWidth:number, wallLimit?:number}} q
 */
export function roadLiftAt(q) {
  const ad = Math.abs(q.lateral ?? 0);
  const hw = q.halfWidth ?? 0;
  if (ad <= hw) return Y_ASPHALT;
  // Asphalt lift → runoff over the kerb band.
  const overKerb = (ad - hw) / KERB_WIDTH;
  if (overKerb < 1) return Y_ASPHALT + (Y_RUNOFF - Y_ASPHALT) * overKerb;
  // Runoff → lawn over the next few metres. A no-op while the two are equal,
  // but it keeps the surface continuous if they are ever separated again.
  const wall = q.wallLimit ?? (hw + KERB_WIDTH);
  const past = Math.min(1, Math.max(0, (ad - wall) / LAWN_BLEND));
  return Y_RUNOFF + (Y_GRASS - Y_RUNOFF) * past;
}

function layered(material, layer) {
  material.polygonOffset = true;
  material.polygonOffsetFactor = DEPTH_LAYER[layer];
  material.polygonOffsetUnits = DEPTH_LAYER[layer];
  // Road must occlude the lawn behind/under it. WebGPU can drop depth writes
  // on some node-material paths if left implicit.
  material.depthWrite = true;
  material.depthTest = true;
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
  constructor(waypoints, {
    sampleCount = 4000, spawnT = 0, groundMargin = 1600, surfaceNodes = null,
    profile = {},
  } = {}) {
    super();

    this.centerline = buildCenterline(waypoints, sampleCount);
    this.samples = this.centerline.samples;
    this.spawnT = spawnT;
    this.groundMargin = groundMargin;
    // `tslSurfaceNodes` on the WebGPU path, null on WebGL. Present means build
    // node materials, because NodeMaterial never runs `onBeforeCompile`.
    this._surfaceNodes = surfaceNodes;
    this._hint = 0;
    this._wheelHint = 0;
    this._propHint = 0;
    this._profile = profile;
    // Cached: `_terrainHeight` runs four times a physics step, and the ground
    // grid and the trackside props all reference the same field datum.
    this._groundMean = meanElevation(profile.elevation);
    /** Reused by `_terrainHeight`, which must not allocate. */
    this._qScratch = { t: 0, lateral: 0, halfWidth: 0, wallLimit: 0 };
    this._tyreMarkTexture = null;
    this._asphaltUniforms = [];
    this._asphaltNodeMaterials = [];

    this._build();
  }

  query(x, z) {
    const result = this.centerline.query(x, z, this._hint);
    this._hint = result.index;
    return result;
  }

  /**
   * Per-wheel surface query: height, normal, friction and roughness at a world
   * point, written into `out`.
   *
   * This is the interface the kernel samples four times a step, so it allocates
   * nothing and keeps its own hint cursor separate from `query`'s — the four
   * wheels are within two metres of each other, and sharing a cursor with the
   * chassis query made every wheel walk the ring from wherever the chassis last
   * looked.
   *
   * The normal comes from central differences of the same height function, so the
   * surface the tyre feels and the surface it is standing on are the same surface
   * by construction rather than by agreement.
   *
   * `hint` defaults to the instance cursor, so every existing three-argument call
   * site is untouched. A caller keeping several cars on the same track passes its
   * own cursor instead — sharing this one cursor between cars spread round the lap
   * measured ~15% slower per car, dragged back and forth between them, and is the
   * aliasing failure `centerline.query` warns about in its own comments. The
   * station this settles on is published on `out.index`, so such a caller can
   * advance its own cursor without paying for a second ring search.
   */
  queryWheel(x, z, out, hint = this._wheelHint) {
    const q = this.centerline.query(x, z, hint);
    this._wheelHint = q.index;
    out.index = q.index;
    out.surface = q.surface;
    out.mu = MU[q.surface] ?? MU.grass;
    out.height = this._terrainHeight(q);
    out.roughness = surfaceRoughness(q, this._profile);
    out.curvature = verticalCurvature(
      q.t, this.centerline.length, this._profile.elevation);

    // Gradient by central difference along the tangent and the normal. `EPS` is a
    // compromise: too small and float64 cancellation shows up in the normal, too
    // large and a kerb edge is smeared into a ramp.
    const t = q.tangent;
    const n = q.normal;
    const hAlong = this._heightAt(x + t.x * NORMAL_EPS, z + t.z * NORMAL_EPS)
      - this._heightAt(x - t.x * NORMAL_EPS, z - t.z * NORMAL_EPS);
    const hAcross = this._heightAt(x + n.x * NORMAL_EPS, z + n.z * NORMAL_EPS)
      - this._heightAt(x - n.x * NORMAL_EPS, z - n.z * NORMAL_EPS);
    const gAlong = hAlong / (2 * NORMAL_EPS);
    const gAcross = hAcross / (2 * NORMAL_EPS);
    // Horizontal components of the upward normal, in world XZ.
    out.nx = -(gAlong * t.x + gAcross * n.x);
    out.nz = -(gAlong * t.z + gAcross * n.z);
    return out;
  }

  /** Surface height at a world point. The one function everything agrees on. */
  _heightAt(x, z) {
    const q = this.centerline.query(x, z, this._wheelHint);
    return this._terrainHeight(q);
  }

  /**
   * The height the terrain is **drawn** at — which is the height the tyre has
   * to stand on, or the car is not on the surface the driver can see.
   *
   * Two corrections over raw `surfaceHeight`:
   *
   *  - `roadLiftAt` adds the offset the meshes are drawn with, so the car sits
   *    on the asphalt rather than 4 cm inside it.
   *  - `groundFieldHeight` is what physics stands on beyond the ribbons. The
   *    drawn grid uses `blendedGroundHeight` so two nearby parts of the lap
   *    cannot punch a rectangular pit in the lawn; on the racing line the
   *    nearest station dominates the blend, so the two still agree.
   */
  _terrainHeight(q) {
    // `groundFieldHeight` inlined against a scratch object rather than called:
    // it spreads `{...q}` to clamp the lateral, and this runs four times a
    // wheel plus four more for each central-difference normal — twelve thousand
    // objects a second in a loop that is documented as allocating nothing.
    const lap = this.centerline.length;
    const edge = q.wallLimit ?? (q.halfWidth * 2);
    const ad = Math.abs(q.lateral);
    const sc = this._qScratch;
    sc.t = q.t;
    sc.halfWidth = q.halfWidth;
    sc.wallLimit = edge;
    sc.lateral = ad > edge ? Math.sign(q.lateral || 1) * edge : q.lateral;
    const local = surfaceHeight(sc, lap, this._profile);
    const beyond = ad > edge ? ad - edge : 0;
    const h = beyond === 0
      ? local
      : this._groundMean + (local - this._groundMean)
        / (1 + (beyond / FIELD_BLEND) ** 2);
    return h + roadLiftAt(q);
  }

  /** Surface height at a world point, for the renderer and for tests. */
  heightAt(x, z) {
    return this._heightAt(x, z);
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

    // Gravel strip then lawn runoff — never under asphalt.
    for (const side of [-1, 1]) {
      this.add(this._ribbon(
        s => side * (s.halfWidth + KERB_WIDTH + GRAVEL_WIDTH),
        s => side * (s.halfWidth + KERB_WIDTH),
        layered(this._gravelMaterial(), 'runoff'),
        Y_RUNOFF,
        {
          uvMode: 'metres', tileMetres: GRAVEL_TILE_M, receiveShadow: true,
          lateralSegments: RUNOFF_SEGMENTS,
        }
      ));
      this.add(this._ribbon(
        s => side * (s.halfWidth + s.runoff),
        s => side * (s.halfWidth + KERB_WIDTH + GRAVEL_WIDTH),
        layered(this._grassMaterial(), 'runoff'),
        Y_RUNOFF,
        {
          uvMode: 'metres', tileMetres: GRASS_RUNOFF_TILE_M, receiveShadow: true,
          lateralSegments: RUNOFF_SEGMENTS,
        }
      ));
    }
    this.add(this._ribbon(
      // Tuck asphalt under the kerbs so the lawn never shares a coplanar edge
      // with the racing surface. Corner ribbon overlap used to leave grass
      // triangles winning the depth test on the tarmac.
      s => s.halfWidth + KERB_WIDTH,
      s => -(s.halfWidth + KERB_WIDTH),
      layered(this._asphaltMaterial(), 'asphalt'),
      Y_ASPHALT,
      {
        uvMode: 'metres', tileMetres: ASPHALT_TILE_M, receiveShadow: true,
        surfaceUv: true, lateralSegments: ASPHALT_SEGMENTS,
      }
    ));

    const curbMaterial = layered(new THREE.MeshStandardMaterial({
      map: this._makeCurbTexture(),
      normalMap: this._makeKerbNormalTexture(),
      normalScale: new THREE.Vector2(1.4, 1.8),
      roughness: 0.52,
      metalness: 0.06,
      envMapIntensity: 0.35,
    }), 'kerb');
    const edgeMaterial = layered(this._lineWearMaterial(), 'marking');
    // Galvanised Armco kept as a low outer rail beyond the Jersey wall for
    // runoff containment; the permanent-circuit look comes from concrete.
    const armcoMaterial = new THREE.MeshStandardMaterial({
      map: this._barrierDataTexture(armcoAlbedo(512, 128), 512, 128, THREE.SRGBColorSpace),
      normalMap: this._barrierDataTexture(armcoNormal(512, 128), 512, 128, THREE.NoColorSpace),
      normalScale: new THREE.Vector2(1, 1),
      roughnessMap: this._barrierDataTexture(armcoRoughness(512, 128), 512, 128, THREE.NoColorSpace),
      color: 0xffffff,
      roughness: 1,
      metalness: 0.55,
      side: THREE.DoubleSide,
    });
    const jerseyMaterial = new THREE.MeshStandardMaterial({
      map: this._barrierDataTexture(jerseyAlbedo(512, 256), 512, 256, THREE.SRGBColorSpace),
      normalMap: this._barrierDataTexture(jerseyNormal(512, 256), 512, 256, THREE.NoColorSpace),
      normalScale: new THREE.Vector2(1.1, 1.1),
      roughnessMap: this._barrierDataTexture(jerseyRoughness(512, 256), 512, 256, THREE.NoColorSpace),
      color: 0xffffff,
      roughness: 1,
      metalness: 0.02,
      side: THREE.DoubleSide,
    });

    for (const side of [-1, 1]) {
      this.add(this._ribbon(
        s => side * (s.halfWidth + (side > 0 ? KERB_WIDTH : 0)),
        s => side * (s.halfWidth + (side > 0 ? 0 : KERB_WIDTH)),
        curbMaterial,
        Y_ASPHALT,
        { receiveShadow: true, lateralSegments: KERB_SEGMENTS }
      ));
      this.add(this._ribbon(
        s => side * (s.halfWidth - EDGE_LINE_WIDTH) + EDGE_LINE_WIDTH,
        s => side * (s.halfWidth - EDGE_LINE_WIDTH) - EDGE_LINE_WIDTH,
        edgeMaterial,
        Y_EDGE,
        { receiveShadow: true }
      ));
      // Grass verge against the wall — the transition the reference shot relies on.
      this.add(this._ribbon(
        s => side * (s.halfWidth + s.runoff),
        s => side * (s.halfWidth + s.runoff - VERGE_WIDTH),
        layered(this._grassMaterial({ repeatU: 2.2, repeatV: 0.4 }), 'runoff'),
        Y_RUNOFF,
        {
          uvMode: 'metres', tileMetres: 2.5, receiveShadow: true,
          lateralSegments: 2,
        }
      ));
      this.add(this._jerseyBarrier(side, jerseyMaterial));
      this.add(this._barrier(side, armcoMaterial, {
        wallExtra: 2.8,
        height: 0.55,
        halfThickness: 0.05,
        panelMetres: PANEL_METRES,
      }));
    }

    this.add(this._startLine(
      this.samples[this._spawnIndex()],
      layered(this._checkeredFinishMaterial(), 'marking'),
    ));

    // Everything trackside stands on ground that now moves, so each of these gets
    // the surface height at its own position rather than a single plane.
    const groundAt = (x, z) => this._sampleGroundY(x, z);
    const grass = createGrassTufts(this.centerline, (x, z) => groundAt(x, z) + Y_RUNOFF, {
      plan: {
        edgeInset: KERB_WIDTH + GRAVEL_WIDTH + 0.65,
        perStation: 14,
        alongSpacing: 0.95,
      },
      surfaceNodes: this._surfaceNodes,
    });
    grass.name = 'grassTufts';
    const fence = createCatchFence(this.centerline, groundAt);
    const props = createTracksideProps(this.centerline, groundAt);
    this._tracksideLOD = createTracksideLOD({
      grass, fence, props,
      distances: tracksideBandsFor(this._surfaceNodes ? 'webgpu' : 'webgl'),
    });
    this.add(this._tracksideLOD.root);
    this.add(createHorizonFoliage(this.centerline, groundAt, {
      nearSpacing: 26,
      farSpacing: 42,
      maxNear: 560,
      maxFar: 360,
      maxStands: 42,
    }));
    this.add(createMountainBackdrop(this.centerline, groundAt));
    this.add(createFinishGantry(this.samples[this._spawnIndex()], groundAt));
  }

  /** Swap grass / fence / props detail by chase-cam distance. */
  updateTracksideLOD(camera) {
    this._tracksideLOD?.update(camera);
  }

  /** Quality scaler: 1 keeps authored tuft density, 0.55 is Balanced. */
  setGrassDensity(scale) {
    if (this._tracksideLOD) {
      this._tracksideLOD.grassDensity = Math.max(0, Math.min(1, scale));
    }
  }

  /**
   * Ground under everything, centred on the circuit rather than on the origin.
   * A plane centred at (0,0) left its edge only ~1 km from the east side of the
   * track — inside fog range, so the world visibly stopped.
   */
  /**
   * The ground beyond the circuit.
   *
   * A subdivided grid rather than a plane, because with the circuit spanning 12 m
   * of elevation a flat ground plane is not an option — the track passes several
   * metres under it at the low points and several metres over it at the high ones,
   * and both read as the world being broken.
   */
  _ground() {
    const b = this.bounds();
    const m = this.groundMargin;
    const width = (b.maxX - b.minX) + 2 * m;
    const depth = (b.maxZ - b.minZ) + 2 * m;
    const material = layered(this._grassMaterial({
      repeatU: width / GRASS_GROUND_TILE_M,
      repeatV: depth / GRASS_GROUND_TILE_M,
      vertexColors: true,
    }), 'ground');
    const geometry = new THREE.PlaneGeometry(
      width, depth, GROUND_SEGMENTS, GROUND_SEGMENTS);
    // Built in the XY plane then rotated, so displace Z before the rotation.
    const cx = (b.minX + b.maxX) / 2;
    const cz = (b.minZ + b.maxZ) / 2;
    const pos = geometry.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const lap = this.centerline.length;
    const mean = this._groundMean;
    const samples = this.centerline.samples;
    for (let i = 0; i < pos.count; i++) {
      // The plane's local +y becomes world −z after the −90° X rotation.
      const wx = cx + pos.getX(i);
      const wz = cz - pos.getY(i);
      const y = blendedGroundHeight(samples, wx, wz, lap, this._profile, mean) + Y_GRASS;
      pos.setZ(i, y);
      const tint = grassFieldTint(wx, wz);
      colors[i * 3] = tint.r;
      colors[i * 3 + 1] = tint.g;
      colors[i * 3 + 2] = tint.b;
    }
    relaxGridHeights(pos, GROUND_SEGMENTS);
    pos.needsUpdate = true;
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.computeVertexNormals();
    if (material.normalMap) geometry.computeTangents();
    const ground = new THREE.Mesh(geometry, material);
    ground.rotation.x = -DEG90;
    ground.position.set(cx, 0, cz);
    ground.receiveShadow = true;
    if (material.polygonOffset) {
      ground.renderOrder = -material.polygonOffsetFactor;
    }
    this._groundSampler = {
      position: geometry.attributes.position,
      cx, cz, width, depth, segments: GROUND_SEGMENTS,
    };
    return ground;
  }

  /**
   * Height of the drawn lawn at a world point, bilinear on the ground grid.
   * Trackside props stand on this so a fence cannot float over a cell the mesh
   * already filled.
   */
  _sampleGroundY(x, z) {
    const g = this._groundSampler;
    if (!g) return 0;
    const pos = g.position;
    const n = g.segments + 1;
    const fx = ((x - g.cx) / g.width + 0.5) * g.segments;
    const fz = ((z - g.cz) / g.depth + 0.5) * g.segments;
    const ix = Math.max(0, Math.min(g.segments - 1, Math.floor(fx)));
    const iz = Math.max(0, Math.min(g.segments - 1, Math.floor(fz)));
    const tx = Math.min(1, Math.max(0, fx - ix));
    const tz = Math.min(1, Math.max(0, fz - iz));
    const y00 = pos.getZ(iz * n + ix);
    const y10 = pos.getZ(iz * n + ix + 1);
    const y01 = pos.getZ((iz + 1) * n + ix);
    const y11 = pos.getZ((iz + 1) * n + ix + 1);
    return y00 * (1 - tx) * (1 - tz)
      + y10 * tx * (1 - tz)
      + y01 * (1 - tx) * tz
      + y11 * tx * tz;
  }

  _lineWearMaterial() {
    const width = 512;
    const height = 32;
    const mat = new THREE.MeshStandardMaterial({
      map: this._markingDataTexture(lineWearAlbedo(width, height), width, height, THREE.SRGBColorSpace),
      roughnessMap: this._markingDataTexture(lineWearRoughness(width, height), width, height, THREE.NoColorSpace),
      color: 0xffffff,
      roughness: 0.72,
      metalness: 0,
    });
    return mat;
  }

  /**
   * A wall texture: repeats along the rail (u), clamps up it (v), and carries a
   * full mip chain — the wall is seen down a kilometre of straight, which is the
   * exact geometry that made the unmipped asphalt shimmer.
   */
  _barrierDataTexture(data, width, height, colorSpace) {
    const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = 8;
    texture.colorSpace = colorSpace;
    texture.needsUpdate = true;
    return texture;
  }

  _markingDataTexture(data, width, height, colorSpace) {
    const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(1, 1);
    // 16 was tried, since the visual dashboard puts the worst instability in the
    // far-track band where the texture footprint is most anisotropic. No
    // measurable change (3.79 -> 3.82 instability), so 8 stands.
    texture.anisotropy = 8;
    texture.colorSpace = colorSpace;
    // Painted lines are thin and viewed down a kilometre of straight, so they
    // alias worse than anything else on the track without a mip chain.
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;
    return texture;
  }

  /**
   * Detail maps: the Poly Haven `asphalt_track` PBR set (CC0, Dimitrios
   * Savva, polyhaven.com/a/asphalt_track) — photoscanned race-track tarmac,
   * 2K, authored at 2 m physical scale. It replaces the 512 px procedural
   * noise maps, which read as texture rather than as asphalt up close. The
   * lap-scale variation multiply and the tyre marks are unchanged — they
   * address the road by position, not by this tiling UV.
   */
  _asphaltDetailTexture(url, colorSpace) {
    const texture = new THREE.TextureLoader().load(url);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.colorSpace = colorSpace;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.anisotropy = 16;
    return texture;
  }

  _asphaltMaterial() {
    const params = {
      map: this._asphaltDetailTexture('obj/textures/track/asphalt_track_diff_2k.jpg', THREE.SRGBColorSpace),
      normalMap: this._asphaltDetailTexture('obj/textures/track/asphalt_track_nor_gl_2k.jpg', THREE.NoColorSpace),
      roughnessMap: this._asphaltDetailTexture('obj/textures/track/asphalt_track_rough_2k.jpg', THREE.NoColorSpace),
      color: 0xffffff,
      // The photoscanned roughness map is authored absolute — pass it through
      // rather than scaling it down.
      roughness: 1.0,
      metalness: 0,
      envMapIntensity: 1.0,
      // Real relief, so far less normal gain than the procedural noise needed;
      // above ~0.8 the aggregate sparkles at distance.
      normalScale: new THREE.Vector2(0.7, 0.7),
    };
    const texture = this._asphaltSurfaceVariationTexture();
    const range = {
      albedoMin: ALBEDO_MUL_MIN,
      albedoSpan: ALBEDO_MUL_MAX - ALBEDO_MUL_MIN,
      roughMin: ROUGH_MUL_MIN,
      roughSpan: ROUGH_MUL_MAX - ROUGH_MUL_MIN,
    };
    if (this._surfaceNodes) {
      const mat = this._surfaceNodes.createAsphaltNodeMaterial(
        params, texture, range, { tyreMarks: this._tyreMarkTexture ?? null },
      );
      this._asphaltNodeMaterials.push(mat);
      return mat;
    }
    const material = new THREE.MeshStandardMaterial(params);
    this._applyAsphaltSurfaceVariation(material, texture, range);
    return material;
  }

  /**
   * The lap-scale variation map: racing line, marbles, resurfacing patches,
   * paving seam. Addressed by position on the track, not by the tiling detail
   * UV, because those features span the circuit and never repeat.
   */
  _asphaltSurfaceVariationTexture() {
    const map = asphaltSurfaceMap({ lapLength: this.centerline.length });
    const texture = new THREE.DataTexture(
      map.data, map.width, map.height, THREE.RGBAFormat, THREE.UnsignedByteType,
    );
    // Round the lap it wraps; across the track it must not, or the far kerb
    // would bleed rubber onto the near one.
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.colorSpace = THREE.NoColorSpace;   // multipliers, not colour
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;
    // 16 was tried, since the visual dashboard puts the worst instability in the
    // far-track band where the texture footprint is most anisotropic. No
    // measurable change (3.79 -> 3.82 instability), so 8 stands.
    texture.anisotropy = 8;
    texture.needsUpdate = true;
    this._asphaltSurfaceTexture = texture;
    return texture;
  }

  /**
   * Multiply lap-scale variation into the asphalt: racing line, marbles,
   * resurfacing patches, paving seam.
   *
   * The detail maps tile every 4 m, which is right for aggregate and useless for
   * anything that spans the circuit, so this comes from a separate map addressed
   * by position on the track — `aSurfaceUv`, emitted by `_ribbon`. All the
   * profile maths lives in `asphaltSurface.js` where it is unit-tested; the
   * shader only samples and multiplies, so there is no second copy in GLSL.
   *
   * The WebGL path only — `tslSurfaceNodes.createAsphaltNodeMaterial` builds the
   * same effect as a node graph for WebGPU, from the same map and ranges.
   */
  /**
   * Hand the asphalt the dynamic tyre-mark texture.
   *
   * Kept as a setter rather than a constructor argument: the marks belong to the
   * car's effect set and the car is built after the track, and inverting that so
   * the track owns them would put a rendering buffer inside the circuit.
   */
  setTyreMarkTexture(texture) {
    this._tyreMarkTexture = texture;
    for (const uniforms of this._asphaltUniforms) {
      uniforms.uTyreMarks.value = texture;
      if (uniforms.uHasTyreMarks) uniforms.uHasTyreMarks.value = texture ? 1 : 0;
    }
    for (const mat of this._asphaltNodeMaterials) {
      const u = mat.userData?.asphaltMarkUniforms;
      if (!u) continue;
      u.uTyreMarks.value = texture ?? u.emptyMarks;
      u.uHasTyreMarks.value = texture ? 1 : 0;
    }
  }

  _applyAsphaltSurfaceVariation(material, texture, range) {
    const albedoMin = range.albedoMin.toFixed(5);
    const albedoSpan = range.albedoSpan.toFixed(5);
    const roughMin = range.roughMin.toFixed(5);
    const roughSpan = range.roughSpan.toFixed(5);

    const inject = shader => {
      shader.uniforms.uAsphaltSurface = { value: texture };
      // Dynamic rubber, laid down by the car. The baked racing line in
      // `uAsphaltSurface` is where a *session* of cars has been; this is where
      // *this* car has been, and it deepens as the driver uses the same line.
      shader.uniforms.uTyreMarks = { value: this._tyreMarkTexture ?? null };
      shader.uniforms.uHasTyreMarks = { value: this._tyreMarkTexture ? 1 : 0 };
      this._asphaltUniforms.push(shader.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
        attribute vec2 aSurfaceUv;
        varying vec2 vSurfaceUv;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
        vSurfaceUv = aSurfaceUv;`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
        uniform sampler2D uAsphaltSurface;
        uniform sampler2D uTyreMarks;
        uniform float uHasTyreMarks;
        varying vec2 vSurfaceUv;`)
        .replace('#include <map_fragment>', `#include <map_fragment>
        vec4 surf = texture2D( uAsphaltSurface, vSurfaceUv );
        diffuseColor.rgb *= ${albedoMin} + surf.r * ${albedoSpan};
        // Rubber is cool-neutral, so where it has built up it takes the warm cast
        // off the aggregate rather than only darkening it. This replaces a
        // desaturation toward the albedo's own luminance, which was a no-op here:
        // asphalt albedo is already near-neutral. The TSL path had the same term
        // and it was actively wrong there — see tslSurfaceNodes.js.
        diffuseColor.rgb *= mix( vec3( 1.0 ), vec3( 0.93, 0.97, 1.05 ), surf.b );
        // Laid rubber: darker, cooler and smoother than the aggregate under it,
        // which is the same direction the baked line goes and for the same reason.
        float marks = uHasTyreMarks * texture2D( uTyreMarks, vSurfaceUv ).r;
        diffuseColor.rgb *= mix( vec3( 1.0 ), vec3( 0.28, 0.29, 0.32 ), marks );
        // Macro octave: a second read of the SAME detail map, nine times
        // larger. The photoscanned tile is pristine tarmac — featureless above
        // ~0.3 m — so its own low-frequency unevenness, gained up, supplies
        // the worked-in patchiness a used circuit has and breaks the 2 m
        // tiling. 0.0136 is the map's measured mean linear luminance; the
        // deviation is amplified because the source is authored near-uniform.
        float macroLum = dot( texture2D( map, vMapUv * 0.111 ).rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
        float macroDev = macroLum / 0.0136 - 1.0;
        diffuseColor.rgb *= clamp( 1.0 + macroDev * 3.5, 0.72, 1.35 );`)
        // `surf` is still in scope here: both chunks expand inside main(), and
        // roughnessmap_fragment follows map_fragment. Re-fetching the same texel
        // cost a second dependent read per fragment across the whole track.
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor *= ${roughMin} + surf.g * ${roughSpan};
        roughnessFactor *= mix( 1.0, 0.72, marks );
        // Brighter macro patches are worn, polished asphalt: lighter AND
        // smoother, so the sun response varies with the mottling.
        roughnessFactor *= clamp( 1.0 - macroDev * 1.8, 0.85, 1.12 );`);
    };

    // CSM assigns its own onBeforeCompile to every standard material in the
    // scene, so this must compose rather than assign — see the helper.
    composeOnBeforeCompile(material, inject, 'asphaltSurface');
  }

  _asphaltDataTexture(data, size, colorSpace) {
    const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    // 16 was tried, since the visual dashboard puts the worst instability in the
    // far-track band where the texture footprint is most anisotropic. No
    // measurable change (3.79 -> 3.82 instability), so 8 stands.
    texture.anisotropy = 8;
    texture.colorSpace = colorSpace;
    // `DataTexture` defaults to NearestFilter with no mip chain, which point
    // samples the surface that occupies most of the screen and recedes to the
    // horizon — the single largest source of aliasing in the scene. Measured at
    // 6.01/255 sub-pixel instability with 23% of pixels at single-pixel scale;
    // MSAA cannot touch it, because this is texture aliasing, not edge coverage.
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;
    return texture;
  }

  _grassMaterial({ repeatU = 1, repeatV = 1, vertexColors = false } = {}) {
    const size = 1024;
    const height = tileableGrassHeight(size, 11);
    const mat = new THREE.MeshStandardMaterial({
      map: this._asphaltDataTexture(grassAlbedoFromHeight(height, size), size, THREE.SRGBColorSpace),
      normalMap: this._asphaltDataTexture(normalFromHeight(height, size, 1.85), size, THREE.NoColorSpace),
      roughnessMap: this._asphaltDataTexture(roughnessFromHeight(height, size), size, THREE.NoColorSpace),
      // Neutral: grassAlbedoFromHeight already returns finished lawn colour.
      // A green tint here multiplied the greens and crushed red/blue to emerald.
      color: 0xffffff,
      roughness: 0.92,
      metalness: 0,
      envMapIntensity: 0.85,
      normalScale: new THREE.Vector2(0.55, 0.55),
      vertexColors,
    });
    for (const t of [mat.map, mat.normalMap, mat.roughnessMap]) {
      t.repeat.set(repeatU, repeatV);
      t.anisotropy = 16;
    }
    this._tryBindGrassFiles(mat, repeatU, repeatV);
    return mat;
  }

  _tryBindGrassFiles(mat, repeatU, repeatV) {
    const loader = new THREE.TextureLoader();
    const bind = (url, colorSpace, key) => {
      loader.load(url, tex => {
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.anisotropy = 16;
        tex.colorSpace = colorSpace;
        tex.repeat.set(repeatU, repeatV);
        mat[key] = tex;
        if (key === 'normalMap') mat.normalScale.set(0.7, 0.7);
        mat.needsUpdate = true;
      }, undefined, () => {
        // Fall back to 1k Polyhaven maps if 2k is missing after a fresh clone.
        if (url.includes('_2k.')) bind(url.replace('_2k.', '_1k.'), colorSpace, key);
      });
    };
    // Albedo stays the generated cool green. leafy_grass_diff is brown leaf
    // litter; under ACES it reads as sand. Keep only its micro-normal/roughness.
    bind('obj/textures/grass/leafy_grass_nor_gl_2k.jpg', THREE.NoColorSpace, 'normalMap');
    bind('obj/textures/grass/leafy_grass_rough_2k.jpg', THREE.NoColorSpace, 'roughnessMap');
  }

  _gravelMaterial({ repeatU = 1, repeatV = 1 } = {}) {
    const size = 512;
    const height = tileableGravelHeight(size, 29);
    const mat = new THREE.MeshStandardMaterial({
      map: this._asphaltDataTexture(gravelAlbedoFromHeight(height, size), size, THREE.SRGBColorSpace),
      normalMap: this._asphaltDataTexture(normalFromHeight(height, size, 2.4), size, THREE.NoColorSpace),
      roughnessMap: this._asphaltDataTexture(roughnessFromHeight(height, size), size, THREE.NoColorSpace),
      color: 0xffffff,
      roughness: 0.96,
      metalness: 0.02,
      envMapIntensity: 0.25,
      normalScale: new THREE.Vector2(0.85, 0.85),
    });
    for (const t of [mat.map, mat.normalMap, mat.roughnessMap]) {
      t.repeat.set(repeatU, repeatV);
      t.anisotropy = 12;
    }
    return mat;
  }

  /**
   * Sweep a strip between two per-station lateral offsets.
   *
   * `u` runs 0→1 once round the lap and stations are evenly spaced by arc length,
   * so `u * lapLength` is distance in metres — which is what lets the marking
   * textures be sized in metres.
   */
  /**
   * A strip along the centreline between two lateral offsets.
   *
   * `lateralSegments` subdivides across the width. It used to be fixed at one — two
   * vertices per station, left edge and right edge — which is exactly enough for a
   * flat ribbon and not enough for a surface: a 1.5% drainage crown needs a vertex
   * in the middle to exist at all, and so does a bump. One is still the default,
   * because the thin marking strips are only centimetres wide and gain nothing.
   *
   * Vertex Y comes from `elevation.surfaceHeight`, the same function the tyre is
   * standing on. That is deliberate and it is the whole point: a visual bump the
   * car cannot feel is worse than no bump, and a kerb the car drives through is
   * worse than a flat one.
   */
  _ribbon(leftOffset, rightOffset, material, y, {
    uvMode = 'normalized',
    tileMetres = 1,
    receiveShadow = false,
    castShadow = false,
    surfaceUv = false,
    lateralSegments = 1,
    followSurface = true,
  } = {}) {
    const n = this.samples.length;
    const lap = this.centerline.length;
    const cols = lateralSegments + 1;
    const rows = n + 1;
    const vertices = new Float32Array(rows * cols * 3);
    const normals = new Float32Array(rows * cols * 3);
    const uvs = new Float32Array(rows * cols * 2);
    // Un-tiled position on the surface: x round the lap, y across the width.
    // The regular `uv` tiles every few metres to carry aggregate, so it cannot
    // also address a feature that spans the whole circuit.
    const surface = surfaceUv ? new Float32Array(rows * cols * 2) : null;
    const indices = new Uint32Array(n * lateralSegments * 6);

    const heightAtStation = (s, lateral) => (followSurface
      ? surfaceHeight(
        {
          t: s.t, lateral, halfWidth: s.halfWidth,
          wallLimit: s.halfWidth + s.runoff,
        },
        lap, this._profile)
      : 0);

    for (let i = 0; i < rows; i++) {
      const s = this.samples[i % n];
      const left = leftOffset(s);
      const right = rightOffset(s);
      const uv = ribbonTileUV({
        mode: uvMode,
        alongMetres: (i / n) * lap,
        left,
        right,
        tileMetres,
        station: i,
        stationCount: n,
      });
      for (let c = 0; c < cols; c++) {
        const f = c / lateralSegments;         // 0 at `left`, 1 at `right`
        const lateral = left + (right - left) * f;
        const base = (i * cols + c) * 3;
        vertices[base] = s.x + s.nx * lateral;
        vertices[base + 1] = heightAtStation(s, lateral);
        vertices[base + 2] = s.z + s.nz * lateral;

        // Normals analytically from the height field rather than from
        // computeVertexNormals, which seams at the lap join and at every strip
        // edge. Gradient along the tangent and across the normal, then the upward
        // normal is (-g_along·t - g_across·n, 1).
        if (followSurface) {
          const dAlong = 0.75;
          const dLat = 0.25;
          const tNext = (s.t + dAlong / lap + 1) % 1;
          const tPrev = (s.t - dAlong / lap + 1) % 1;
          const wall = s.halfWidth + s.runoff;
          const at = (t, lat) => surfaceHeight(
            { t, lateral: lat, halfWidth: s.halfWidth, wallLimit: wall },
            lap, this._profile);
          const gAlong = (at(tNext, lateral) - at(tPrev, lateral)) / (2 * dAlong);
          const gAcross = (at(s.t, lateral + dLat) - at(s.t, lateral - dLat)) / (2 * dLat);
          const nxv = -(gAlong * s.tx + gAcross * s.nx);
          const nzv = -(gAlong * s.tz + gAcross * s.nz);
          const len = Math.hypot(nxv, 1, nzv) || 1;
          normals[base] = nxv / len;
          normals[base + 1] = 1 / len;
          normals[base + 2] = nzv / len;
        } else {
          normals[base + 1] = 1;
        }

        uvs[(i * cols + c) * 2] = uv.u0 + (uv.u1 - uv.u0) * f;
        uvs[(i * cols + c) * 2 + 1] = uv.v0 + (uv.v1 - uv.v0) * f;
        if (surface) {
          // v = 1 at the `left` edge, 0 at the `right` one, matching the map's
          // lateral axis which runs -1 .. +1 across the racing surface.
          surface[(i * cols + c) * 2] = i / n;
          surface[(i * cols + c) * 2 + 1] = 1 - f;
        }
      }
    }

    let index = 0;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < lateralSegments; c++) {
        const a = i * cols + c;
        const b = a + 1;
        const d = (i + 1) * cols + c;
        const e = d + 1;
        indices[index++] = a;
        indices[index++] = d;
        indices[index++] = b;
        indices[index++] = b;
        indices[index++] = d;
        indices[index++] = e;
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    if (surface) {
      geometry.setAttribute('aSurfaceUv', new THREE.BufferAttribute(surface, 2));
    }
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeBoundingSphere();

    if (material.normalMap) geometry.computeTangents();

    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.y = y;
    mesh.receiveShadow = receiveShadow;
    mesh.castShadow = castShadow;
    // Draw order mirrors DEPTH_LAYER: positive bias (ground/runoff) first,
    // negative bias (asphalt/kerb/markings) later so coplanar wins stay stable.
    if (material.polygonOffset) {
      mesh.renderOrder = -material.polygonOffsetFactor;
    }
    return mesh;
  }

  /**
   * Armco run along the outside of the runoff (or further out when `wallExtra`
   * is set — used as a secondary rail behind Jersey walls).
   *
   * Each of the three visible faces gets its own vertices and its own flat
   * normal. Sharing vertices around the profile and calling
   * `computeVertexNormals()` averaged the inner wall with the cap it meets,
   * giving every vertex a 45° normal — half of them tilted downward into the dark
   * half of the environment, which is what made the barriers read as dark navy on
   * one side and washed tan on the other.
   */
  _barrier(side, material, {
    wallExtra = 0,
    height = 1.1,
    halfThickness = 0.06,
    panelMetres = PANEL_METRES,
  } = {}) {
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
    // UVs: u runs along the wall in panel lengths, v up the rail — so the Armco
    // maps tile one panel per PANEL_METRES and the corrugation lies horizontal,
    // the way a real W-beam does.
    const uvs = new Float32Array(rings * faces.length * 2 * 2);
    const indices = new Uint32Array(n * faces.length * 6);
    let vi = 0;
    let ti = 0;
    let along = 0;
    let prevCx = null;
    let prevCz = null;

    const lap = this.centerline.length;
    for (let i = 0; i < rings; i++) {
      const s = this.samples[i % n];
      const wallLimit = s.halfWidth + s.runoff + wallExtra;
      const cx = s.x + s.nx * side * wallLimit;
      const cz = s.z + s.nz * side * wallLimit;
      // Accumulated distance along the wall itself, not the centreline — the wall
      // is offset, so its corners are longer or shorter than the lap's.
      if (prevCx !== null) along += Math.hypot(cx - prevCx, cz - prevCz);
      prevCx = cx;
      prevCz = cz;
      const u = along / panelMetres;
      // "Inward" is back toward the centerline, whichever side this run is on.
      const inX = -side * s.nx, inZ = -side * s.nz;
      // Barriers stand on the ground, and the ground now moves. Left at a fixed
      // y = 0 they float several metres clear at Abbey and are buried at Village.
      const base = surfaceHeight(
        {
          t: s.t, lateral: side * wallLimit, halfWidth: s.halfWidth,
          wallLimit: s.halfWidth + s.runoff,
        },
        lap, this._profile);

      for (const face of faces) {
        for (const [offset, y] of [face.a, face.b]) {
          vertices[vi] = cx + inX * offset;
          vertices[vi + 1] = base + y;
          vertices[vi + 2] = cz + inZ * offset;
          if (face.normal === 'up') {
            normals[vi + 1] = 1;
          } else {
            const sign = face.normal === 'in' ? 1 : -1;
            normals[vi] = inX * sign;
            normals[vi + 2] = inZ * sign;
          }
          uvs[ti] = u;
          // Side faces map v to height up the rail; the narrow cap reads the very
          // top of the texture, which the profile rolls away to nothing.
          uvs[ti + 1] = face.normal === 'up' ? 0.99 : y / height;
          vi += 3;
          ti += 2;
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
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeBoundingSphere();
    if (material.normalMap) geometry.computeTangents();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  /**
   * Concrete Jersey wall on the runoff edge — trapezoid profile with a slope
   * facing the track (the permanent-circuit look from the reference still).
   */
  _jerseyBarrier(side, material) {
    const height = JERSEY_HEIGHT;
    const n = this.samples.length;
    const rings = n + 1;
    const profile = [
      { t: 0, half: jerseyHalfThickness(0) },
      { t: 1, half: jerseyHalfThickness(1) },
    ];

    const vertsPerRing = 4; // track-base, track-top, field-top, field-base
    const vertices = new Float32Array(rings * vertsPerRing * 3);
    const normals = new Float32Array(rings * vertsPerRing * 3);
    const uvs = new Float32Array(rings * vertsPerRing * 2);
    const indices = new Uint32Array(n * 3 * 6);
    let vi = 0;
    let ti = 0;
    let along = 0;
    let prevCx = null;
    let prevCz = null;
    const lap = this.centerline.length;

    for (let i = 0; i < rings; i++) {
      const s = this.samples[i % n];
      const wallLimit = s.halfWidth + s.runoff;
      const cx = s.x + s.nx * side * wallLimit;
      const cz = s.z + s.nz * side * wallLimit;
      if (prevCx !== null) along += Math.hypot(cx - prevCx, cz - prevCz);
      prevCx = cx;
      prevCz = cz;
      const u = along / JERSEY_PANEL_METRES;
      const inX = -side * s.nx;
      const inZ = -side * s.nz;
      const base = surfaceHeight(
        {
          t: s.t, lateral: side * wallLimit, halfWidth: s.halfWidth,
          wallLimit,
        },
        lap, this._profile);

      const halfB = profile[0].half;
      const halfT = profile[1].half;
      const slope = Math.atan2(halfB - halfT, height);
      const snx = inX * Math.cos(slope);
      const sny = Math.sin(slope);
      const snz = inZ * Math.cos(slope);
      // Order: track-base, track-top, field-top, field-base
      const pts = [
        { ox: halfB, y: 0, nx: snx, ny: sny, nz: snz, v: 0 },
        { ox: halfT, y: height, nx: snx, ny: sny, nz: snz, v: 1 },
        { ox: -halfT, y: height, nx: 0, ny: 1, nz: 0, v: 0.99 },
        { ox: -halfB, y: 0, nx: -inX, ny: 0, nz: -inZ, v: 0 },
      ];

      for (const p of pts) {
        vertices[vi] = cx + inX * p.ox;
        vertices[vi + 1] = base + p.y;
        vertices[vi + 2] = cz + inZ * p.ox;
        normals[vi] = p.nx;
        normals[vi + 1] = p.ny;
        normals[vi + 2] = p.nz;
        uvs[ti] = u;
        uvs[ti + 1] = p.v;
        vi += 3;
        ti += 2;
      }
    }

    let ii = 0;
    for (let i = 0; i < n; i++) {
      const a0 = i * vertsPerRing;
      const b0 = (i + 1) * vertsPerRing;
      // Track face: 0-1
      indices[ii++] = a0; indices[ii++] = a0 + 1; indices[ii++] = b0;
      indices[ii++] = a0 + 1; indices[ii++] = b0 + 1; indices[ii++] = b0;
      // Top: 1-2
      indices[ii++] = a0 + 1; indices[ii++] = a0 + 2; indices[ii++] = b0 + 1;
      indices[ii++] = a0 + 2; indices[ii++] = b0 + 2; indices[ii++] = b0 + 1;
      // Field: 2-3
      indices[ii++] = a0 + 2; indices[ii++] = a0 + 3; indices[ii++] = b0 + 2;
      indices[ii++] = a0 + 3; indices[ii++] = b0 + 3; indices[ii++] = b0 + 2;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeBoundingSphere();
    if (material.normalMap) geometry.computeTangents();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'jerseyBarrier';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  _checkeredFinishMaterial() {
    const data = checkeredFinishAlbedo(128, 32);
    const map = new THREE.DataTexture(data, 128, 32, THREE.RGBAFormat);
    map.colorSpace = THREE.SRGBColorSpace;
    map.wrapS = THREE.RepeatWrapping;
    map.wrapT = THREE.ClampToEdgeWrapping;
    map.magFilter = THREE.NearestFilter;
    map.minFilter = THREE.NearestFilter;
    map.needsUpdate = true;
    return new THREE.MeshStandardMaterial({
      map,
      roughness: 0.85,
      metalness: 0,
      // Slightly translucent feel so asphalt grain can still read if AO darkens.
      envMapIntensity: 0.2,
    });
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
    geometry.setAttribute('uv', new THREE.BufferAttribute(
      new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), 2));
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
    // 16 was tried, since the visual dashboard puts the worst instability in the
    // far-track band where the texture footprint is most anisotropic. No
    // measurable change (3.79 -> 3.82 instability), so 8 stands.
    texture.anisotropy = 8;
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  _makeKerbNormalTexture() {
    const stripes = 16;
    const px = 512 / stripes;
    const data = new Uint8ClampedArray(512 * 64 * 4);
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 512; x++) {
        const stripe = Math.floor(x / px);
        const u = (x % px) / px;
        const ridge = Math.sin(u * Math.PI * 2) * 0.5 + 0.5;
        const edge = stripe % 2 === 0 ? ridge : 1 - ridge;
        const dx = (Math.sin((u + 0.02) * Math.PI * 2) - Math.sin((u - 0.02) * Math.PI * 2)) * 0.5;
        const nx = -dx * 1.8;
        const ny = 0;
        const nz = Math.sqrt(Math.max(0.01, 1 - nx * nx));
        const o = (y * 512 + x) * 4;
        data[o] = Math.round((nx * 0.5 + 0.5) * 255);
        data[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
        data[o + 2] = Math.round((nz * 0.5 + 0.5) * 255);
        data[o + 3] = 255;
      }
    }
    const texture = new THREE.DataTexture(data, 512, 64, THREE.RGBAFormat, THREE.UnsignedByteType);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(this.centerline.length / (stripes * KERB_STRIPE), 1);
    texture.colorSpace = THREE.NoColorSpace;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.anisotropy = 8;
    texture.needsUpdate = true;
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
}
