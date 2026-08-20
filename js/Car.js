import * as THREE from 'three';
import { BinLoader } from './BinLoader.js';
import {
  createVehicle, setPose, advance, updateSteering, renderPose,
  speed, forwardSpeed, lateralSpeed, travelYaw,
} from './physics/vehicle.js';
import {
  normalFromHeight, roughnessFromNoise, metallicFromNoise, specularIntensityFromNoise,
  carbonWeaveNormal, tyreMicroNormalAndRoughness,
} from './render/carProceduralMaps.js';
import {
  MASS, G, WB, LR, LF, RHO, CLA, H_CG,
} from './physics/bicycle.js';
import { cockpitSteerAngle, followSteerAngle } from './render/cockpitSteer.js';

const DEG90 = Math.PI / 2;
const STEER_HUB = { x: 0, y: 0.5933, z: 0.5054 };

export class Car {
  constructor(scene) {
    this.root = new THREE.Object3D();
    scene.add(this.root);

    this.visualRoot = new THREE.Object3D();
    this.visualRoot.rotation.y = DEG90;
    this.root.add(this.visualRoot);

    this.body = new THREE.Object3D();
    this.body.rotation.y = DEG90;
    this.visualRoot.add(this.body);

    // Only the rim lives here. DriverBody is one unrigged mesh (suit + legs +
    // gloves); parenting it to the hub swung the whole driver onto the nose.
    this._steerPivot = new THREE.Object3D();
    this._steerPivot.position.set(STEER_HUB.x, STEER_HUB.y, STEER_HUB.z);
    this.body.add(this._steerPivot);
    this._steerVisual = 0;

    this.lfw = this._makeWheel( 1.3928, 0.34, -0.69);
    this.rfw = this._makeWheel( 1.4,    0.34,  0.69);
    this.lrw = this._makeWheel(-2,      0.34, -0.69);
    this.rrw = this._makeWheel(-2,      0.34,  0.69);

    this.vehicle = createVehicle();
    this._braking = false;
    // Reused every frame: the render pose is interpolated between the last two
    // sim states, and the inner loop is not allowed to allocate.
    this._pose = { x: 0, z: 0, yaw: 0 };

    this.brakeMat     = null;
    this.bodyPaintMat = null;
    this._tyreMatFront = null;
    this._tyreMatRear = null;
    this._tyreMeshesFront = [];
    this._tyreMeshesRear = [];
    this._tyreTempFront = 0;
    this._tyreTempRear = 0;

    this.input = { forward: false, reverse: false, left: false, right: false, brake: false };
  }

  // Physics state, read by the camera. The car mesh faces -Z at yaw 0.
  get av() { return this.vehicle.av; }
  get steerAngle() { return this.vehicle.steerAngle; }
  speed() { return speed(this.vehicle); }
  forwardSpeed() { return forwardSpeed(this.vehicle); }
  travelYaw() { return travelYaw(this.vehicle); }

  headingForward(out) {
    return this.headingForwardAt(this.root.rotation.y, out);
  }

  headingForwardAt(yaw, out) {
    return out.set(-Math.sin(yaw), 0, -Math.cos(yaw));
  }

  setHeadingFromTangent(tx, tz) {
    this.root.rotation.y = Math.atan2(-tx, -tz);
  }

  setSpawn(x, z, yaw) {
    setPose(this.vehicle, x, z, yaw);
  }

  /** Grid reset: spawn pose, zero speed, clear pedals and steering visuals. */
  resetRace(x, z, yaw) {
    this.input.forward = false;
    this.input.reverse = false;
    this.input.left = false;
    this.input.right = false;
    this.input.brake = false;
    setPose(this.vehicle, x, z, yaw);
    const v = this.vehicle;
    v.vx = 0;
    v.vz = 0;
    v.av = 0;
    v.axPrev = 0;
    v.ayPrev = 0;
    v.omega = [0, 0, 0, 0];
    v.steerAngle = 0;
    v.steerSmooth = 0;
    v.braking = false;
    v.wheelSpin = 0;
    v.x = x;
    v.z = z;
    v.yaw = yaw;
    this.root.position.set(x, this.root.position.y, z);
    this.root.rotation.y = yaw;
    this._braking = false;
    this._steerVisual = 0;
    this._steerPivot.rotation.z = 0;
    this.lfw.rotation.y = 0;
    this.rfw.rotation.y = 0;
    for (const w of [this.lfw, this.rfw, this.lrw, this.rrw]) {
      w._spinPivot.rotation.z = 0;
    }
    this._tyreTempFront = 0;
    this._tyreTempRear = 0;
    if (this.brakeMat) {
      this.brakeMat.emissive.setHex(0x330000);
      this.brakeMat.emissiveIntensity = 0.4;
    }
  }

  _makeWheel(x, y, z) {
    const w = new THREE.Object3D();
    w.position.set(x, y, z);
    w._spinPivot = new THREE.Object3D();
    w.add(w._spinPivot);
    this.visualRoot.add(w);
    return w;
  }

  /**
   * @param {THREE.Texture} [environment] PMREM environment for the metallic and
   *   glossy parts. Without one, `metalness` has nothing to reflect and reads black.
   */
  loadAssets(environment = null) {
    const tl  = new THREE.TextureLoader();
    const tex = url => {
      const t = tl.load(url);
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 8;
      return t;
    };

    const envMap = environment;
    const blackMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9, metalness: 0 });

    const makeDataTex = (gen, colorSpace, { wrap = false, repeat = [1, 1] } = {}) => {
      const { data, size } = gen();
      const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
      t.type = THREE.UnsignedByteType;
      t.colorSpace = colorSpace;
      t.minFilter = THREE.LinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.generateMipmaps = false;
      t.wrapS = t.wrapT = wrap ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
      t.repeat.set(repeat[0], repeat[1]);
      t.anisotropy = 8;
      t.needsUpdate = true;
      return t;
    };

    // Body paint: micro orange-peel + clearcoat response breakup.
    const bodyNormalTex = makeDataTex(
      () => normalFromHeight({ size: 512, strength: 0.85, seed: 11, angle: 0.33 }),
      THREE.NoColorSpace,
      { wrap: true, repeat: [2, 2] }
    );
    const bodyRoughTex = makeDataTex(
      () => roughnessFromNoise({ size: 512, base: 0.30, variance: 0.09, seed: 12 }),
      THREE.NoColorSpace,
      { wrap: true, repeat: [2, 2] }
    );
    const bodyMetalTex = makeDataTex(
      () => metallicFromNoise({ size: 512, base: 0.0, variance: 0.015, seed: 13 }),
      THREE.NoColorSpace,
      { wrap: true, repeat: [2, 2] }
    );
    const clearcoatRoughTex = makeDataTex(
      () => roughnessFromNoise({ size: 512, base: 0.045, variance: 0.012, seed: 14 }),
      THREE.NoColorSpace,
      { wrap: true, repeat: [2, 2] }
    );
    const clearcoatNormalTex = makeDataTex(
      () => normalFromHeight({ size: 512, strength: 0.65, seed: 15, angle: 0.12 }),
      THREE.NoColorSpace,
      { wrap: true, repeat: [2, 2] }
    );
    const bodySpecTex = makeDataTex(
      () => specularIntensityFromNoise({ size: 512, base: 0.55, variance: 0.1, seed: 16 }),
      THREE.NoColorSpace,
      { wrap: true, repeat: [2, 2] }
    );

    this.bodyPaintMat = new THREE.MeshPhysicalMaterial({
      map: tex('obj/textures/BodyPaint.jpg'),
      envMap, envMapIntensity: 0.55,
      roughness: 0.42, roughnessMap: bodyRoughTex,
      metalness: 0.0, metalnessMap: bodyMetalTex,
      normalMap: bodyNormalTex,
      normalScale: new THREE.Vector2(0.45, 0.45),
      specularIntensity: 0.55,
      specularIntensityMap: bodySpecTex,

      clearcoat: 0.4,
      clearcoatRoughness: 0.14,
      clearcoatRoughnessMap: clearcoatRoughTex,
      clearcoatNormalMap: clearcoatNormalTex,
      clearcoatNormalScale: new THREE.Vector2(0.25, 0.25),

      anisotropy: 0.08,
      reflectivity: 0.45,
    });
    this.brakeMat = new THREE.MeshStandardMaterial({
      color: 0x800000, map: tex('obj/textures/RearLights.jpg'),
      roughness: 0.5, metalness: 0, emissive: 0x330000, emissiveIntensity: 0.4,
    });

    // Carbon fiber / high-spec parts: dielectric with sharp anisotropic spec
    // and a woven micro-normal field.
    const carbonNormalTex = makeDataTex(
      () => carbonWeaveNormal({ size: 512, strength: 1.25, seed: 21, weaveFreq: 26 }),
      THREE.NoColorSpace,
      { wrap: true, repeat: [2, 2] }
    );
    const carbonMat = new THREE.MeshPhysicalMaterial({
      color: 0x111111,
      envMap,
      envMapIntensity: 0.35,
      roughness: 0.38,
      metalness: 0.0,
      normalMap: carbonNormalTex,
      normalScale: new THREE.Vector2(0.7, 0.7),

      clearcoat: 0.12,
      clearcoatRoughness: 0.18,
      clearcoatNormalMap: carbonNormalTex,
      clearcoatNormalScale: new THREE.Vector2(0.3, 0.3),
      anisotropy: 0.2,
      reflectivity: 0.35,
    });

    // Tyre micro-detail: grooves + grain. Sidewall heat/wear is applied at
    // runtime by adjusting roughness and a slight color tint.
    const tyreMaps = tyreMicroNormalAndRoughness({ size: 512, seed: 33 });
    const tyreNormalTex = new THREE.DataTexture(
      tyreMaps.normal.data,
      tyreMaps.normal.size,
      tyreMaps.normal.size,
      THREE.RGBAFormat,
    );
    tyreNormalTex.type = THREE.UnsignedByteType;
    tyreNormalTex.colorSpace = THREE.NoColorSpace;
    tyreNormalTex.minFilter = THREE.LinearFilter;
    tyreNormalTex.magFilter = THREE.LinearFilter;
    tyreNormalTex.generateMipmaps = false;
    tyreNormalTex.wrapS = tyreNormalTex.wrapT = THREE.RepeatWrapping;
    tyreNormalTex.repeat.set(2, 2);
    tyreNormalTex.anisotropy = 8;
    tyreNormalTex.needsUpdate = true;

    const tyreRoughTex = new THREE.DataTexture(
      tyreMaps.roughness.data,
      tyreMaps.roughness.size,
      tyreMaps.roughness.size,
      THREE.RGBAFormat,
    );
    tyreRoughTex.type = THREE.UnsignedByteType;
    tyreRoughTex.colorSpace = THREE.NoColorSpace;
    tyreRoughTex.minFilter = THREE.LinearFilter;
    tyreRoughTex.magFilter = THREE.LinearFilter;
    tyreRoughTex.generateMipmaps = false;
    tyreRoughTex.wrapS = tyreRoughTex.wrapT = THREE.RepeatWrapping;
    tyreRoughTex.repeat.set(2, 2);
    tyreRoughTex.anisotropy = 8;
    tyreRoughTex.needsUpdate = true;

    const tyreBaseColor = new THREE.Color(0xffffff);
    const makeTyreMat = (baseRoughness) => {
      const m = new THREE.MeshStandardMaterial({
        map: tex('obj/textures/Tyre.jpg'),
        envMap,
        envMapIntensity: 0.04,
        roughness: baseRoughness,
        roughnessMap: tyreRoughTex,
        metalness: 0.0,
        normalMap: tyreNormalTex,
        normalScale: new THREE.Vector2(0.25, 0.25),
      });
      m.userData.baseRoughness = baseRoughness;
      m.userData.baseColor = tyreBaseColor.clone();
      return m;
    };
    this._tyreMatFront = makeTyreMat(0.94);
    this._tyreMatRear = makeTyreMat(0.96);

    const bodyParts = {
      BodyPaint:     { x:0,       y:0.5859,  z:0,       mat: this.bodyPaintMat },
      Suspension:    { x:0,       y:0.4044,  z:-0.3071, mat: new THREE.MeshStandardMaterial({ color:0x333333, envMap, roughness:0.7, metalness:0.4 }) },
      InsideBlack:   { x:0,       y:0.5773,  z:0.729,   mat: blackMat },
      GlossyBlack:   { x:0,       y:0.4115,  z:-0.7112, mat: carbonMat },
      Chrome:        { x:0,       y:0.5867,  z:0.3202,  mat: new THREE.MeshStandardMaterial({ color:0xcccccc, envMap, envMapIntensity:0.35, roughness:0.22, metalness:0.9 }) },
      Bolts:         { x:0,       y:0.5694,  z:0.8672,  mat: new THREE.MeshStandardMaterial({ color:0x666666, envMap, roughness:0.5, metalness:0.6 }) },
      Windshield:    { x:0,       y:0.6777,  z:0.5647,  mat: new THREE.MeshPhysicalMaterial({ color:0xaaccff, envMap, envMapIntensity:0.7, roughness:0.05, metalness:0.1, transparent:true, opacity:0.35, side:THREE.DoubleSide }) },
      RearLight:     { x:0,       y:0.4652,  z:-2.34,   mat: this.brakeMat },
      RearLightGlass:{ x:0,       y:0.4652,  z:-2.34,   mat: new THREE.MeshPhysicalMaterial({ color:0xff2200, envMap, envMapIntensity:0.4, roughness:0.05, metalness:0.1, transparent:true, opacity:0.7, side:THREE.DoubleSide }) },
      SteeringWheel: { x:0, y:0, z:0, mat: new THREE.MeshStandardMaterial({ map:tex('obj/textures/SteeringWheel.jpg'), envMap, roughness:0.45, metalness:0.1 }), parent: this._steerPivot },
      DriverBody:    { x:-0.0113, y:0.4063,  z:0.5277,  mat: new THREE.MeshStandardMaterial({ map:tex('obj/textures/Driver.jpg'), envMap, roughness:0.7, metalness:0 }) },
      Helmet:        { x:0.0016,  y:0.7287,  z:-0.0175, mat: new THREE.MeshStandardMaterial({ map:tex('obj/textures/Helmet.jpg'), envMap, envMapIntensity:0.4, roughness:0.2, metalness:0.3 }) },
      Visor:         { x:0.0016,  y:0.6993,  z:0.052,   mat: new THREE.MeshPhysicalMaterial({ map:tex('obj/textures/Visor.jpg'),  envMap, envMapIntensity:0.7, roughness:0.05, metalness:0.1, transparent:true, opacity:0.8, side:THREE.DoubleSide }) },
    };

    const wheelParts = {
      Tyre:      null, // handled with front/rear mats stored on this._tyreMatFront/_tyreMatRear
      Rim:       new THREE.MeshStandardMaterial({ map:tex('obj/textures/Rim.jpg'), envMap, envMapIntensity:0.2, roughness:0.55, metalness:0.55 }),
      WheelBase: blackMat,
    };

    for (const [name, p] of Object.entries(bodyParts)) {
      BinLoader.load(`obj/js/${name}.bin`, geo => {
        const mesh = new THREE.Mesh(geo, p.mat);
        mesh.position.set(p.x, p.y, p.z);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        (p.parent || this.body).add(mesh);
      });
    }

    const rotLeft  = new THREE.Matrix4().makeRotationY(-DEG90);
    const rotRight = new THREE.Matrix4().makeRotationY( DEG90);

    for (const [name, mat] of Object.entries(wheelParts)) {
      BinLoader.load(`obj/js/${name}.bin`, geo => {
        const leftGeo  = geo.clone().applyMatrix4(rotLeft);
        const rightGeo = geo.clone().applyMatrix4(rotRight);
        const addWheel = (pivot, geo, chosenMat, storeList) => {
          const mesh = new THREE.Mesh(geo, chosenMat);
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          mesh.userData.baseScale = mesh.scale.clone();
          if (storeList) storeList.push(mesh);
          pivot.add(mesh);
        };

        if (name === 'Tyre') {
          addWheel(this.lfw._spinPivot, leftGeo, this._tyreMatFront, this._tyreMeshesFront);
          addWheel(this.lrw._spinPivot, leftGeo, this._tyreMatRear, this._tyreMeshesRear);
          addWheel(this.rfw._spinPivot, rightGeo, this._tyreMatFront, this._tyreMeshesFront);
          addWheel(this.rrw._spinPivot, rightGeo, this._tyreMatRear, this._tyreMeshesRear);
        } else {
          addWheel(this.lfw._spinPivot, leftGeo, mat, null);
          addWheel(this.lrw._spinPivot, leftGeo, mat, null);
          addWheel(this.rfw._spinPivot, rightGeo, mat, null);
          addWheel(this.rrw._spinPivot, rightGeo, mat, null);
        }
      });
    }

    this._addContactShadow(tl);
  }

  /**
   * Baked blob shadow under the car.
   *
   * `MultiplyBlending` makes the fragment colour the blend factor, so the
   * texture's white surround has to stay white. Tone mapping does not leave it
   * white: ACES maps 1.0 to ~0.8, which turned the whole 7.2 m quad into a 10%
   * grey wash with a hard rectangular edge. `toneMapped: false` keeps the
   * surround neutral so only the baked blob darkens anything.
   *
   * Must sit above the painted lines (0.012–0.020 m) and below the kerb
   * (0.030 m). Coplanar with either, or with depthTest off / DoubleSide, the
   * white JPEG canvas z-fights as bright rectangles under the chassis.
   */
  _addContactShadow(loader) {
    const map = loader.load('obj/textures/Shadow.jpg');
    map.colorSpace = THREE.SRGBColorSpace;
    map.anisotropy = 8;
    const shadow = new THREE.Mesh(
      // The blob's proportions are baked for a square quad — keep the aspect.
      new THREE.PlaneGeometry(7.2, 7.2),
      new THREE.MeshBasicMaterial({
        map,
        side: THREE.FrontSide,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        blending: THREE.MultiplyBlending,
        // The only blend path three offers for MultiplyBlending; without it the
        // renderer logs "MultiplyBlending requires material.premultipliedAlpha".
        premultipliedAlpha: true,
        toneMapped: false,
        polygonOffset: true,
        polygonOffsetFactor: -6,
        polygonOffsetUnits: -6,
      })
    );
    // Child of root, so +X is the car's right and -Z is forward.
    shadow.rotation.x = -DEG90;
    shadow.position.set(0.08, 0.026, 0.35);
    shadow.renderOrder = 1;
    shadow.castShadow = false;
    shadow.receiveShadow = false;
    this.root.add(shadow);
  }

  updateSteering(dt) {
    updateSteering(this.vehicle, this.input, dt);
  }

  updatePhysics(dt, track) {
    const v = this.vehicle;
    advance(v, this.input, track, dt);

    // Interpolated, not raw: the sim runs at a fixed 600 Hz and the display does
    // not, so drawing the latest state directly shows a step pattern of 10, 10,
    // 11 states per frame that reads as micro-stutter.
    const pose = renderPose(v, this._pose);
    this.root.position.set(pose.x, this.root.position.y, pose.z);
    this.root.rotation.y = pose.yaw;

    if (this.brakeMat && v.braking !== this._braking) {
      this._braking = v.braking;
      this.brakeMat.emissive.setHex(v.braking ? 0xff1100 : 0x330000);
      this.brakeMat.emissiveIntensity = v.braking ? 1.5 : 0.4;
    }

    this.lfw.rotation.y = v.steerAngle;
    this.rfw.rotation.y = v.steerAngle;
    this._steerVisual = followSteerAngle(
      this._steerVisual, cockpitSteerAngle(v.steerSmooth), dt);
    this._steerPivot.rotation.z = this._steerVisual;
    for (const w of [this.lfw, this.rfw, this.lrw, this.rrw]) {
      w._spinPivot.rotation.z -= v.wheelSpin;
    }

    // Tyre micro “life”: heat/wear roughness + a subtle squash based on axle
    // normal load (same longitudinal load-transfer model as the bicycle physics).
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    if (this._tyreMatFront && this._tyreMatRear) {
      const speedMps = Math.hypot(v.vx, v.vz);
      const q = 0.5 * RHO * speedMps * speedMps;
      const FL = q * CLA;

      const baseFzF = MASS * G * LR / WB;
      const baseFzR = MASS * G * LF / WB;
      const FzF = Math.max(200, MASS * G * LR / WB + 0.4 * FL - MASS * v.axPrev * H_CG / WB);
      const FzR = Math.max(200, MASS * G * LF / WB + 0.6 * FL + MASS * v.axPrev * H_CG / WB);

      const defF = clamp((FzF - baseFzF) / baseFzF, -0.3, 0.8);
      const defR = clamp((FzR - baseFzR) / baseFzR, -0.3, 0.8);

      const setTyreSquash = (meshes, def) => {
        const squash = clamp(def * 0.035, -0.02, 0.05);
        const yScale = 1 - squash;
        const xzScale = 1 + squash * 0.35;
        for (const m of meshes) {
          const b = m.userData.baseScale;
          m.scale.set(b.x * xzScale, b.y * yScale, b.z * xzScale);
        }
      };
      setTyreSquash(this._tyreMeshesFront, defF);
      setTyreSquash(this._tyreMeshesRear, defR);

      // Heat target: braking and sideslip create more surface temperature.
      const lat = Math.abs(lateralSpeed(v));
      const brakingHeat = v.braking ? 1 : 0;
      const throttleHeat = this.input.forward ? 0.6 : 0;
      const slipHeat = clamp(lat / 35, 0, 1);
      const targetHeatF = clamp(brakingHeat * 0.9 + throttleHeat * 0.25 + slipHeat * 0.35, 0, 1);
      const targetHeatR = clamp(brakingHeat * 0.95 + throttleHeat * 0.35 + slipHeat * 0.30, 0, 1);

      const k = 1 - Math.exp(-dt * 2.2);
      this._tyreTempFront += (targetHeatF - this._tyreTempFront) * k;
      this._tyreTempRear += (targetHeatR - this._tyreTempRear) * k;

      const updateTyreMat = (mat, temp) => {
        const base = mat.userData.baseRoughness ?? mat.roughness;
        mat.roughness = clamp(base + temp * 0.04, 0.85, 0.98);
        const baseColor = mat.userData.baseColor ?? new THREE.Color(0xffffff);
        const tint = 1 - temp * 0.06;
        mat.color.copy(baseColor).multiplyScalar(tint);
      };
      updateTyreMat(this._tyreMatFront, this._tyreTempFront);
      updateTyreMat(this._tyreMatRear, this._tyreTempRear);
    }
  }
}
