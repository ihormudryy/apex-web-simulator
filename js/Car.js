import * as THREE from 'three';
import { BinLoader } from './BinLoader.js';
import {
  createVehicle, setPose, advance, updateSteering,
  speed, forwardSpeed, travelYaw,
} from './physics/vehicle.js';

const DEG90 = Math.PI / 2;

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

    this.lfw = this._makeWheel( 1.3928, 0.34, -0.69);
    this.rfw = this._makeWheel( 1.4,    0.34,  0.69);
    this.lrw = this._makeWheel(-2,      0.34, -0.69);
    this.rrw = this._makeWheel(-2,      0.34,  0.69);

    this.vehicle = createVehicle();
    this._braking = false;

    this.brakeMat     = null;
    this.bodyPaintMat = null;

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

    // Car paint: a clearcoat over a coloured base, so it responds to the
    // environment like the rest of the car instead of being flat-shaded.
    this.bodyPaintMat = new THREE.MeshPhysicalMaterial({
      map: tex('obj/textures/BodyPaint.jpg'),
      envMap, envMapIntensity: 1.0,
      roughness: 0.35, metalness: 0.0,
      clearcoat: 0.85, clearcoatRoughness: 0.06,
      reflectivity: 0.6,
    });
    this.brakeMat = new THREE.MeshStandardMaterial({
      color: 0x800000, map: tex('obj/textures/RearLights.jpg'),
      roughness: 0.5, metalness: 0, emissive: 0x330000, emissiveIntensity: 0.4,
    });

    const bodyParts = {
      BodyPaint:     { x:0,       y:0.5859,  z:0,       mat: this.bodyPaintMat },
      Suspension:    { x:0,       y:0.4044,  z:-0.3071, mat: new THREE.MeshStandardMaterial({ color:0x333333, envMap, roughness:0.7, metalness:0.4 }) },
      InsideBlack:   { x:0,       y:0.5773,  z:0.729,   mat: blackMat },
      GlossyBlack:   { x:0,       y:0.4115,  z:-0.7112, mat: new THREE.MeshStandardMaterial({ color:0x111111, envMap, envMapIntensity:0.8, roughness:0.1, metalness:0.5 }) },
      Chrome:        { x:0,       y:0.5867,  z:0.3202,  mat: new THREE.MeshStandardMaterial({ color:0xcccccc, envMap, envMapIntensity:1.0, roughness:0.05, metalness:1.0 }) },
      Bolts:         { x:0,       y:0.5694,  z:0.8672,  mat: new THREE.MeshStandardMaterial({ color:0x666666, envMap, roughness:0.5, metalness:0.6 }) },
      Windshield:    { x:0,       y:0.6777,  z:0.5647,  mat: new THREE.MeshPhysicalMaterial({ color:0xaaccff, envMap, envMapIntensity:0.7, roughness:0.05, metalness:0.1, transparent:true, opacity:0.35, side:THREE.DoubleSide }) },
      RearLight:     { x:0,       y:0.4652,  z:-2.34,   mat: this.brakeMat },
      RearLightGlass:{ x:0,       y:0.4652,  z:-2.34,   mat: new THREE.MeshPhysicalMaterial({ color:0xff2200, envMap, envMapIntensity:0.4, roughness:0.05, metalness:0.1, transparent:true, opacity:0.7, side:THREE.DoubleSide }) },
      SteeringWheel: { x:0,       y:0.5933,  z:0.5054,  mat: new THREE.MeshStandardMaterial({ map:tex('obj/textures/SteeringWheel.jpg'), envMap, roughness:0.45, metalness:0.1 }) },
      DriverBody:    { x:-0.0113, y:0.4063,  z:0.5277,  mat: new THREE.MeshStandardMaterial({ map:tex('obj/textures/Driver.jpg'), envMap, roughness:0.7, metalness:0 }) },
      Helmet:        { x:0.0016,  y:0.7287,  z:-0.0175, mat: new THREE.MeshStandardMaterial({ map:tex('obj/textures/Helmet.jpg'), envMap, envMapIntensity:0.4, roughness:0.2, metalness:0.3 }) },
      Visor:         { x:0.0016,  y:0.6993,  z:0.052,   mat: new THREE.MeshPhysicalMaterial({ map:tex('obj/textures/Visor.jpg'),  envMap, envMapIntensity:0.7, roughness:0.05, metalness:0.1, transparent:true, opacity:0.8, side:THREE.DoubleSide }) },
    };

    const wheelParts = {
      Tyre:      new THREE.MeshStandardMaterial({ map:tex('obj/textures/Tyre.jpg'), envMap, envMapIntensity:0.3, roughness:0.65, metalness:0 }),
      Rim:       new THREE.MeshStandardMaterial({ map:tex('obj/textures/Rim.jpg'), envMap, envMapIntensity:0.7, roughness:0.15, metalness:0.9 }),
      WheelBase: blackMat,
    };

    for (const [name, p] of Object.entries(bodyParts)) {
      BinLoader.load(`obj/js/${name}.bin`, geo => {
        const mesh = new THREE.Mesh(geo, p.mat);
        mesh.position.set(p.x, p.y, p.z);
        this.body.add(mesh);
      });
    }

    const rotLeft  = new THREE.Matrix4().makeRotationY(-DEG90);
    const rotRight = new THREE.Matrix4().makeRotationY( DEG90);

    for (const [name, mat] of Object.entries(wheelParts)) {
      BinLoader.load(`obj/js/${name}.bin`, geo => {
        const leftGeo  = geo.clone().applyMatrix4(rotLeft);
        const rightGeo = geo.clone().applyMatrix4(rotRight);
        this.lfw._spinPivot.add(new THREE.Mesh(leftGeo,  mat));
        this.lrw._spinPivot.add(new THREE.Mesh(leftGeo,  mat));
        this.rfw._spinPivot.add(new THREE.Mesh(rightGeo, mat));
        this.rrw._spinPivot.add(new THREE.Mesh(rightGeo, mat));
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
   * Sits at y = 0.03 to clear the painted lines at 0.018–0.025 m; below them the
   * lines are opaque and z-occlude the shadow instead of being darkened by it.
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
        transparent: true,
        depthWrite: false,
        blending: THREE.MultiplyBlending,
        // The only blend path three offers for MultiplyBlending; without it the
        // renderer logs "MultiplyBlending requires material.premultipliedAlpha".
        premultipliedAlpha: true,
        toneMapped: false,
      })
    );
    // Child of root, so +X is the car's right and -Z is forward.
    shadow.rotation.x = -DEG90;
    shadow.position.set(0.08, 0.03, 0.35);
    shadow.renderOrder = 1;
    this.root.add(shadow);
  }

  updateSteering(dt) {
    updateSteering(this.vehicle, this.input, dt);
  }

  updatePhysics(dt, track) {
    const v = this.vehicle;
    advance(v, this.input, track, dt);

    this.root.position.set(v.x, this.root.position.y, v.z);
    this.root.rotation.y = v.yaw;

    if (this.brakeMat && v.braking !== this._braking) {
      this._braking = v.braking;
      this.brakeMat.emissive.setHex(v.braking ? 0xff1100 : 0x330000);
      this.brakeMat.emissiveIntensity = v.braking ? 1.5 : 0.4;
    }

    this.lfw.rotation.y = v.steerAngle;
    this.rfw.rotation.y = v.steerAngle;
    for (const w of [this.lfw, this.rfw, this.lrw, this.rrw]) {
      w._spinPivot.rotation.z -= v.wheelSpin;
    }
  }
}
